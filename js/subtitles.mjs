function parseTimestamp(value) {
  const normalized = value.replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error('Invalid VTT timing');
  }

  const secondsPart = parts.pop();
  const [secondsText, millisecondsText] = secondsPart.split('.');
  const minutesText = parts.pop();
  const hoursText = parts.pop() ?? '0';
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);

  if (
    ![hours, minutes, seconds, milliseconds].every(Number.isFinite)
    || minutes < 0
    || minutes > 59
    || seconds < 0
    || seconds > 59
    || milliseconds < 0
    || milliseconds > 999
  ) {
    throw new Error('Invalid VTT timing');
  }

  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseSegments(text, speakerSides) {
  const labelPattern = /【([^】]+)】/g;
  const matches = [...text.matchAll(labelPattern)];
  if (matches.length === 0) {
    const centered = text.trim();
    return centered
      ? [{ label: null, side: 'center', text: centered }]
      : [];
  }

  const segments = [];
  const prefix = text.slice(0, matches[0].index).trim();
  if (prefix) {
    segments.push({ label: null, side: 'center', text: prefix });
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextIndex = matches[index + 1]?.index ?? text.length;
    const segmentText = text.slice(match.index, nextIndex).trim();
    const label = match[1];
    if (!speakerSides.has(label)) {
      speakerSides.set(label, speakerSides.size % 2 === 0 ? 'left' : 'right');
    }
    if (segmentText) {
      segments.push({
        label,
        side: speakerSides.get(label),
        text: segmentText,
      });
    }
  }

  return segments;
}

export function parseVtt(source, options = {}) {
  const normalized = String(source)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('WEBVTT')) {
    throw new Error('Invalid WEBVTT file');
  }

  const blocks = normalized.split(/\n{2,}/);
  const speakerSides = new Map(
    Object.entries(options.speakerSides ?? {}),
  );
  const cues = [];

  for (const block of blocks.slice(1)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const timingMatch = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex].trim());
    if (!timingMatch) {
      throw new Error('Invalid VTT timing');
    }

    const start = parseTimestamp(timingMatch[1]);
    const end = parseTimestamp(timingMatch[2]);
    if (end < start) {
      throw new Error('Invalid VTT timing');
    }

    const text = lines.slice(timingIndex + 1).join('\n');
    cues.push({
      start,
      end,
      text: text.trim(),
      segments: parseSegments(text, speakerSides),
    });
  }

  return {
    cues,
    speakerSides: Object.fromEntries(speakerSides),
  };
}

export function decodeSubtitleBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return new TextDecoder('shift_jis', { fatal: true }).decode(bytes); }
}

export function assignSourceIdentity(cues, source) {
  if (!source?.label || !['left', 'right'].includes(source.side)) return cues;
  return cues.map(cue => ({ ...cue, segments: cue.segments.map(segment => (
    !segment.label && segment.side === 'center'
      ? { ...segment, label: source.label, side: source.side }
      : segment
  )) }));
}

function normalizedCue(start, end, text, sides, speaker = '') {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 864000) {
    throw new Error('字幕时间无效');
  }
  const plain = String(text).trim();
  if (!plain || plain.length > 24000) throw new Error('字幕文字格式无效');
  const display = speaker && !plain.startsWith(`【${speaker}】`) ? `【${speaker}】${plain}` : plain;
  return { start, end, text: display, segments: parseSegments(display, sides), ...(speaker ? { speaker } : {}) };
}

function parseSrt(source, sides) {
  const cues = [];
  for (const block of source.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index].trim());
    if (!match) throw new Error('字幕时间格式无效');
    const text = lines.slice(index + 1).join('\n').replace(/<\/?(?:b|i|u|font)(?:\s[^>]*)?>/gi, '').trim();
    if (text) cues.push(normalizedCue(parseTimestamp(match[1]), parseTimestamp(match[2]), text, sides));
  }
  return cues;
}

function assTimestamp(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('字幕时间格式无效');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
}

function parseAss(source, sides) {
  let inEvents = false;
  let fields = null;
  const cues = [];
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) { inEvents = /^\[Events\]$/i.test(trimmed); continue; }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed.replace(/^Format\s*:/i, '').split(',').map((part) => part.trim().toLowerCase());
      if (!fields.includes('start') || !fields.includes('end') || fields.at(-1) !== 'text') {
        throw new Error('ASS/SSA 字幕格式缺少 Start、End 或末列 Text');
      }
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue;
    if (!fields) throw new Error('ASS/SSA 字幕格式缺少 Events Format');
    const values = trimmed.replace(/^Dialogue\s*:/i, '').split(',');
    if (values.length < fields.length) throw new Error('ASS/SSA 字幕格式无效');
    const cell = (name) => values[fields.indexOf(name)]?.trim() ?? '';
    const speaker = (cell('name') || cell('actor')).slice(0, 160);
    const text = values.slice(fields.length - 1).join(',')
      .replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').trim();
    if (text) cues.push(normalizedCue(assTimestamp(cell('start')), assTimestamp(cell('end')), text, sides, speaker));
  }
  return cues;
}

function parseLrc(source, sides, duration) {
  const rows = [];
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const matches = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const text = line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
      .replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const match of matches) {
      if (Number(match[2]) > 59) throw new Error('字幕时间格式无效');
      const fraction = match[3] ? Number(match[3]) / 10 ** match[3].length : 0;
      rows.push({ start: Number(match[1]) * 60 + Number(match[2]) + fraction, text });
    }
  }
  rows.sort((a, b) => a.start - b.start);
  const nextTimes = new Map();
  let next = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const start = rows[index].start;
    if (!nextTimes.has(start)) { nextTimes.set(start, next ?? start + 5); next = start; }
  }
  return rows.flatMap((row, index) => {
    if (!row.text) return [];
    if (Number.isFinite(duration) && duration > 0 && row.start >= duration) return [];
    const next = nextTimes.get(row.start);
    const end = Number.isFinite(duration) && duration > 0 ? Math.min(next, duration) : next;
    return [normalizedCue(row.start, end, row.text, sides)];
  });
}

export function parseSubtitle(source, { format = 'vtt', speakerSides = {}, duration = 0 } = {}) {
  if (typeof source !== 'string' || source.length > 20 * 1024 * 1024) throw new Error('字幕文件过大或格式无效');
  const kind = String(format).replace(/^\./, '').toLowerCase();
  if (kind === 'vtt') return parseVtt(source, { speakerSides });
  const sides = new Map(Object.entries(speakerSides));
  const cues = kind === 'srt' ? parseSrt(source, sides)
    : kind === 'ass' || kind === 'ssa' ? parseAss(source, sides)
      : kind === 'lrc' ? parseLrc(source, sides, duration)
        : null;
  if (!cues) throw new Error('不支持此字幕格式');
  if (!cues.length) throw new Error('没有找到带时间轴的字幕');
  if (cues.length > 100000) throw new Error('字幕条目过多');
  return { cues: cues.sort((a, b) => a.start - b.start || a.end - b.end), speakerSides: Object.fromEntries(sides) };
}
