export function subtitleSideBalance(cues, time) {
  const target = Math.max(0, Number(time) || 0);
  const totals = { left: 0, right: 0, center: 0 };

  for (const cue of cues ?? []) {
    if (target < Number(cue.start) || target >= Number(cue.end)) continue;
    for (const segment of cue.segments ?? []) {
      if (segment.side === 'left') totals.left += 1;
      else if (segment.side === 'right') totals.right += 1;
      else totals.center += 1;
    }
  }

  const sideTotal = totals.left + totals.right;
  const dominance = sideTotal > 0
    ? (totals.right - totals.left) / sideTotal
    : 0;
  const side = dominance < -0.1
    ? 'left'
    : dominance > 0.1
      ? 'right'
      : 'center';

  return { ...totals, side, dominance };
}

export function dialoguePanTarget(cues, time, {
  paired = false,
  strength = 0.62,
} = {}) {
  if (paired) return { side: 'center', pan: 0, dominance: 0 };
  const balance = subtitleSideBalance(cues, time);
  return {
    side: balance.side,
    dominance: balance.dominance,
    pan: Math.max(-1, Math.min(1, balance.dominance * strength)),
  };
}
