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
