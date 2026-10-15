import {
  buildAlignment,
  findCommonAnchors,
  mapAndMergeCues,
} from './alignment.mjs';

function namedCueSignature(cue) {
  if (!cue.segments?.length || cue.segments.some((segment) => !segment.label)) return null;
  return JSON.stringify([cue.start, cue.end, cue.text, cue.segments.map(({ label, side, text }) => [label, side, text])]);
}

export function buildTrackPlayback({
  leftDuration,
  rightDuration,
  leftCues = [],
  rightCues = [],
  paired = false,
  syncMode = 'original',
}) {
  const subtitleSync = paired && syncMode === 'subtitle';
  const alignment = buildAlignment({
    leftDuration,
    rightDuration: paired ? rightDuration : 0,
    anchors: subtitleSync ? findCommonAnchors(leftCues, rightCues) : [],
  });
  // Some paired files carry two copies of the complete, explicitly labeled
  // script. Remove only exact same-person/time copies across those VTTs.
  const leftSignatures = new Set(leftCues.map(namedCueSignature).filter(Boolean));
  const distinctRight = rightCues.filter((cue) => !leftSignatures.has(namedCueSignature(cue)));
  const cues = subtitleSync
    ? mapAndMergeCues(leftCues, rightCues, alignment)
    : [...leftCues, ...(paired ? distinctRight : [])]
      .sort((first, second) => first.start - second.start || first.end - second.end);
  return { alignment, cues };
}
