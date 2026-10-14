export function buildDialogueItems(cues) {
  return cues.flatMap((cue, cueIndex) => cue.segments.map(
    (segment, segmentIndex) => ({
      id: `${cueIndex}:${segmentIndex}`,
      cueIndex,
      segmentIndex,
      start: cue.start,
      end: cue.end,
      side: segment.side,
      text: segment.text,
    }),
  )).sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left.cueIndex - right.cueIndex
    || left.segmentIndex - right.segmentIndex
  ));
}

export function activeDialogueIds(items, time) {
  return items
    .filter((item) => time >= item.start && time < item.end)
    .map((item) => item.id);
}
