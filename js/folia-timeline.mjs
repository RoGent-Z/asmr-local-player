// Snapshot and index subtitle sentences once; playback queries never read cues.
const indexes = new WeakMap();
const MAX_CONTEXT = 3;

/**
 * Build a stable, independent snapshot with one item per nonblank segment.
 * Text and cue timings stay verbatim: no word timings are inferred.
 * The returned items are read-only; private indexes support random seeking.
 */
export function buildFoliaTimeline(cues) {
  const items = [];
  if (Array.isArray(cues)) {
    for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
      const cue = cues[cueIndex];
      if (!cue || typeof cue !== 'object') continue;
      const { start, end, segments } = cue;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !Array.isArray(segments)) continue;
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        if (!segment || typeof segment !== 'object') continue;
        const { text, side, label } = segment;
        if (typeof text !== 'string' || text.trim().length === 0) continue;
        items.push(Object.freeze({
          id: `folia-${cueIndex}-${segmentIndex}`,
          start,
          end,
          side: side === 'left' || side === 'right' ? side : 'center',
          label: typeof label === 'string' ? label : null,
          text,
        }));
      }
    }
  }
  // Array.sort is stable: equal starts retain cue and segment input order.
  items.sort((a, b) => a.start - b.start);

  const byEnd = items.map((_, index) => index)
    .sort((a, b) => items[a].end - items[b].end || a - b);
  let leafOffset = 1;
  while (leafOffset < items.length) leafOffset *= 2;
  const maximumEnds = new Float64Array(leafOffset * 2);
  for (let index = 0; index < items.length; index += 1) {
    maximumEnds[leafOffset + index] = items[index].end;
  }
  for (let node = leafOffset - 1; node > 0; node -= 1) {
    maximumEnds[node] = Math.max(maximumEnds[node * 2], maximumEnds[node * 2 + 1]);
  }

  const timeline = Object.freeze({ items: Object.freeze(items) });
  indexes.set(timeline, { byEnd, leafOffset, maximumEnds });
  return timeline;
}

function startedCountAt(items, time) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function endedCountAt(items, byEnd, time) {
  let low = 0;
  let high = byEnd.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[byEnd[middle]].end <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function collectActive(items, maximumEnds, startedCount, time, active, node, left, right) {
  // A whole interval can be skipped if it has not started or has fully ended.
  // In particular, one long cue cannot force scanning every expired short cue.
  if (left >= startedCount || maximumEnds[node] <= time) return;
  if (right - left === 1) {
    active.push(items[left]);
    return;
  }
  const middle = left + (right - left) / 2;
  collectActive(items, maximumEnds, startedCount, time, active, node * 2, left, middle);
  collectActive(items, maximumEnds, startedCount, time, active, node * 2 + 1, middle, right);
}

function contextSize(value) {
  return typeof value === 'number' && !Number.isNaN(value)
    ? Math.min(MAX_CONTEXT, Math.max(0, Math.floor(value)))
    : 1;
}

/**
 * Query [start, end) intervals. All active items are retained in start order.
 * Previous context selects the most recently ended items, then returns them in
 * start order; next context selects the earliest strictly unstarted items.
 * Progress describes the combined active sentence span, never individual words.
 * Invalid/negative times query zero; context defaults to one and caps at three.
 * Cost: O(log n + (active.length + 1) log n), with at most three context items.
 */
export function foliaFrameAt(timeline, time, options = {}) {
  const frame = { active: [], before: [], after: [], progress: 0, gap: true };
  const index = indexes.get(timeline);
  if (!index || timeline.items.length === 0) return frame;

  const items = timeline.items;
  const safeTime = Number.isFinite(time) && time >= 0 ? time : 0;
  const context = contextSize(options?.context);
  const startedCount = startedCountAt(items, safeTime);
  collectActive(items, index.maximumEnds, startedCount, safeTime, frame.active, 1, 0, index.leafOffset);

  if (context > 0) {
    const endedCount = endedCountAt(items, index.byEnd, safeTime);
    const previous = index.byEnd.slice(Math.max(0, endedCount - context), endedCount);
    previous.sort((a, b) => a - b);
    for (const itemIndex of previous) frame.before.push(items[itemIndex]);
    frame.after = items.slice(startedCount, startedCount + context);
  }

  if (frame.active.length > 0) {
    const start = frame.active[0].start;
    let end = frame.active[0].end;
    for (let activeIndex = 1; activeIndex < frame.active.length; activeIndex += 1) {
      end = Math.max(end, frame.active[activeIndex].end);
    }
    frame.progress = Math.min(1, Math.max(0, (safeTime - start) / (end - start)));
    frame.gap = false;
  }
  return frame;
}
