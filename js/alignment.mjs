function selectSyncAnchors(anchors, tolerance) {
  const selected = [];
  let previousLeft = 0;
  let previousRight = 0;
  let previousOffset = null;
  let previousAnchor = null;

  function pushUnique(anchor) {
    if (selected[selected.length - 1] !== anchor) selected.push(anchor);
  }

  for (const anchor of anchors) {
    if (
      anchor.leftTime < previousLeft
      || anchor.rightTime < previousRight
      || anchor.leftTime < 0
      || anchor.rightTime < 0
    ) {
      continue;
    }
    const offset = anchor.rightTime - anchor.leftTime;
    if (previousOffset === null) {
      pushUnique(anchor);
      previousOffset = offset;
    } else if (Math.abs(offset - previousOffset) > tolerance) {
      if (previousAnchor) pushUnique(previousAnchor);
      pushUnique(anchor);
      previousOffset = offset;
    }
    previousAnchor = anchor;
    previousLeft = anchor.leftTime;
    previousRight = anchor.rightTime;
  }
  return selected;
}

function findCommonCueMatches(leftCues, rightCues) {
  const rows = leftCues.length + 1;
  const columns = rightCues.length + 1;
  const lengths = Array.from(
    { length: rows },
    () => new Uint16Array(columns),
  );

  for (let leftIndex = leftCues.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (
      let rightIndex = rightCues.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      lengths[leftIndex][rightIndex] = leftCues[leftIndex].text
        && leftCues[leftIndex].text === rightCues[rightIndex].text
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(
          lengths[leftIndex + 1][rightIndex],
          lengths[leftIndex][rightIndex + 1],
        );
    }
  }

  const matches = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftCues.length && rightIndex < rightCues.length) {
    const leftCue = leftCues[leftIndex];
    const rightCue = rightCues[rightIndex];
    if (leftCue.text && leftCue.text === rightCue.text) {
      matches.push({ leftIndex, rightIndex });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      lengths[leftIndex + 1][rightIndex]
      >= lengths[leftIndex][rightIndex + 1]
    ) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
}

export function findCommonAnchors(leftCues, rightCues) {
  return findCommonCueMatches(leftCues, rightCues).map(
    ({ leftIndex, rightIndex }) => ({
      leftTime: leftCues[leftIndex].start,
      rightTime: rightCues[rightIndex].start,
      text: leftCues[leftIndex].text,
    }),
  );
}

function appendSegment(target, {
  presentationStart,
  presentationEnd,
  sourceStart,
  sourceEnd,
}) {
  const sourceDuration = Math.max(0, sourceEnd - sourceStart);
  target.push({
    presentationStart,
    presentationEnd,
    sourceStart,
    sourceEnd,
    activeStart: presentationStart,
    activeEnd: presentationStart + sourceDuration,
  });
}

export function buildAlignment({
  leftDuration,
  rightDuration,
  anchors,
  offsetTolerance = 0.25,
}) {
  const safeLeftDuration = Math.max(0, Number(leftDuration) || 0);
  const safeRightDuration = Math.max(0, Number(rightDuration) || 0);
  const usableAnchors = selectSyncAnchors(
    anchors.filter(
      (anchor) => anchor.leftTime <= safeLeftDuration
        && anchor.rightTime <= safeRightDuration,
    ),
    offsetTolerance,
  );

  const sides = { left: [], right: [] };
  let presentationTime = 0;
  let leftTime = 0;
  let rightTime = 0;

  for (const anchor of usableAnchors) {
    const leftDelta = anchor.leftTime - leftTime;
    const rightDelta = anchor.rightTime - rightTime;
    if (leftDelta < 0 || rightDelta < 0) continue;
    const duration = Math.max(leftDelta, rightDelta);
    const presentationEnd = presentationTime + duration;
    appendSegment(sides.left, {
      presentationStart: presentationTime,
      presentationEnd,
      sourceStart: leftTime,
      sourceEnd: anchor.leftTime,
    });
    appendSegment(sides.right, {
      presentationStart: presentationTime,
      presentationEnd,
      sourceStart: rightTime,
      sourceEnd: anchor.rightTime,
    });
    presentationTime = presentationEnd;
    leftTime = anchor.leftTime;
    rightTime = anchor.rightTime;
  }

  const leftRemaining = safeLeftDuration - leftTime;
  const rightRemaining = safeRightDuration - rightTime;
  const tailDuration = Math.max(leftRemaining, rightRemaining);
  const presentationEnd = presentationTime + tailDuration;
  appendSegment(sides.left, {
    presentationStart: presentationTime,
    presentationEnd,
    sourceStart: leftTime,
    sourceEnd: safeLeftDuration,
  });
  appendSegment(sides.right, {
    presentationStart: presentationTime,
    presentationEnd,
    sourceStart: rightTime,
    sourceEnd: safeRightDuration,
  });

  return {
    duration: presentationEnd,
    anchors: usableAnchors,
    sides,
  };
}

export function presentationToSource(segments, presentationTime) {
  if (!segments.length) {
    return { sourceTime: 0, active: false, ended: true };
  }
  const safeTime = Math.max(0, Number(presentationTime) || 0);
  const last = segments[segments.length - 1];
  if (safeTime >= last.presentationEnd) {
    return {
      sourceTime: last.sourceEnd,
      active: false,
      ended: true,
    };
  }
  const segment = segments.find(
    (candidate) => safeTime < candidate.presentationEnd,
  ) ?? last;
  if (safeTime < segment.activeStart) {
    return {
      sourceTime: segment.sourceStart,
      active: false,
      ended: false,
    };
  }
  if (safeTime >= segment.activeEnd) {
    return {
      sourceTime: segment.sourceEnd,
      active: false,
      ended: false,
    };
  }
  return {
    sourceTime: segment.sourceStart + safeTime - segment.activeStart,
    active: true,
    ended: false,
  };
}

export function sourceToPresentation(
  segments,
  sourceTime,
  boundary = 'previous',
) {
  if (!segments.length) return 0;
  const safeTime = Math.max(0, Number(sourceTime) || 0);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      safeTime >= segment.sourceStart
      && safeTime <= segment.sourceEnd
    ) {
      const next = segments[index + 1];
      if (
        boundary === 'next'
        && next
        && Math.abs(safeTime - segment.sourceEnd) < 1e-6
        && Math.abs(safeTime - next.sourceStart) < 1e-6
      ) {
        return next.activeStart;
      }
      return segment.activeStart + safeTime - segment.sourceStart;
    }
  }
  return segments[segments.length - 1].presentationEnd;
}

function mapCue(cue, segments) {
  return {
    ...cue,
    start: sourceToPresentation(segments, cue.start, 'next'),
    end: sourceToPresentation(segments, cue.end, 'previous'),
  };
}

function intervalsOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

export function mapAndMergeCues(leftCues, rightCues, alignment) {
  const mappedLeft = leftCues.map(
    (cue) => mapCue(cue, alignment.sides.left),
  );
  const mappedRight = rightCues.map(
    (cue) => mapCue(cue, alignment.sides.right),
  );
  const matchedRight = new Set();
  for (const { leftIndex, rightIndex } of findCommonCueMatches(
    leftCues,
    rightCues,
  )) {
    matchedRight.add(rightIndex);
  }

  const priorityBySide = new Map();
  for (const cue of mappedLeft) {
    for (const segment of cue.segments) {
      const intervals = priorityBySide.get(segment.side) ?? [];
      intervals.push({ start: cue.start, end: cue.end });
      priorityBySide.set(segment.side, intervals);
    }
  }

  const filteredRight = mappedRight.flatMap((cue, index) => {
    if (matchedRight.has(index)) return [];
    const segments = cue.segments.filter((segment) => {
      const priorityIntervals = priorityBySide.get(segment.side) ?? [];
      return !priorityIntervals.some(
        (interval) => intervalsOverlap(cue, interval),
      );
    });
    if (segments.length === 0) return [];
    return [{ ...cue, segments }];
  });

  const mapped = [
    ...mappedLeft,
    ...filteredRight,
  ].sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left.text.localeCompare(right.text)
  ));
  return mapped;
}
