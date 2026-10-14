export const DEFAULT_SPECTRUM_PALETTE = Object.freeze([
  '#ff78a8',
  '#a77bff',
  '#78d7ff',
]);

export function getSpectrumChannelPlan(paired) {
  if (paired) {
    return {
      left: { source: 'leftMono', channel: 0 },
      right: { source: 'rightMono', channel: 0 },
    };
  }
  return {
    left: { source: 'left', channel: 0 },
    right: { source: 'left', channel: 1 },
  };
}

export function getPlaybackRoutingPlan(paired, dialoguePan = 0) {
  if (!paired) {
    return {
      left: {
        source: 'left',
        mode: 'stereo',
        pan: Math.max(-1, Math.min(1, Number(dialoguePan) || 0)),
        analyser: ['leftChannel', 'rightChannel'],
      },
      right: null,
    };
  }
  return {
    left: {
      source: 'left',
      mode: 'mono-downmix',
      inputGains: [0.5, 0.5],
      pan: -1,
      analyser: 'leftMono',
    },
    right: {
      source: 'right',
      mode: 'mono-downmix',
      inputGains: [0.5, 0.5],
      pan: 1,
      analyser: 'rightMono',
    },
  };
}

export function mergeSpectrumData(left, right) {
  const length = Math.max(left?.length ?? 0, right?.length ?? 0);
  const merged = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    merged[index] = Math.max(left?.[index] ?? 0, right?.[index] ?? 0);
  }
  return merged;
}

export function hasSpectrumEnergy(values, threshold = 4) {
  for (const value of values ?? []) {
    if (value > threshold) return true;
  }
  return false;
}

function bandEnergy(values, startRatio, endRatio) {
  const length = values?.length ?? 0;
  if (length === 0) return 0;
  const start = Math.min(length - 1, Math.floor(length * startRatio));
  const end = Math.max(start + 1, Math.min(length, Math.ceil(length * endRatio)));
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += values[index] ?? 0;
  }
  return total / (end - start) / 255;
}

function roundedFeature(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

export function analyzeSpectrumTimbre(values, previousValues = null) {
  const length = values?.length ?? 0;
  if (length === 0) {
    return {
      low: 0,
      mid: 0,
      high: 0,
      air: 0,
      energy: 0,
      centroid: 0,
      flux: 0,
    };
  }
  let total = 0;
  let weighted = 0;
  let flux = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index] ?? 0;
    total += value;
    weighted += value * index;
    flux += Math.abs(value - (previousValues?.[index] ?? value));
  }
  return {
    low: roundedFeature(bandEnergy(values, 0, 0.2)),
    mid: roundedFeature(bandEnergy(values, 0.2, 0.58)),
    high: roundedFeature(bandEnergy(values, 0.58, 0.82)),
    air: roundedFeature(bandEnergy(values, 0.82, 1)),
    energy: roundedFeature(total / length / 255),
    centroid: roundedFeature(
      total > 0 && length > 1 ? weighted / total / (length - 1) : 0,
    ),
    flux: roundedFeature(flux / length / 255),
  };
}

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = ((hue * 60) + 360) % 360;
  }
  const saturation = delta === 0
    ? 0
    : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, lightness, saturation };
}

function quantize(value) {
  return Math.min(255, Math.max(0, Math.round(value / 8) * 8));
}

function toHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function colorDistance(first, second) {
  return Math.hypot(
    first.r - second.r,
    first.g - second.g,
    first.b - second.b,
  );
}

export function extractRepresentativeColors(imageData, limit = 5) {
  const buckets = new Map();
  const data = imageData?.data ?? [];
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 160) continue;
    const sourceR = data[index];
    const sourceG = data[index + 1];
    const sourceB = data[index + 2];
    const { lightness, saturation } = rgbToHsl(sourceR, sourceG, sourceB);
    if (lightness <= 0.08 || lightness >= 0.94 || saturation < 0.18) continue;

    const r = quantize(sourceR);
    const g = quantize(sourceG);
    const b = quantize(sourceB);
    const key = `${r},${g},${b}`;
    const bucket = buckets.get(key) ?? {
      r,
      g,
      b,
      count: 0,
      score: 0,
    };
    bucket.count += 1;
    bucket.score += 0.65 + saturation * 0.35;
    buckets.set(key, bucket);
  }

  const selected = [];
  const candidates = [...buckets.values()]
    .sort((first, second) => (
      second.count - first.count
      || second.score - first.score
      || first.r - second.r
      || first.g - second.g
      || first.b - second.b
    ));
  for (const candidate of candidates) {
    if (selected.every((color) => colorDistance(color, candidate) >= 48)) {
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
  }

  if (selected.length === 0) return [...DEFAULT_SPECTRUM_PALETTE];

  const colors = selected.map(({ r, g, b }) => toHex(r, g, b));
  for (const fallback of DEFAULT_SPECTRUM_PALETTE) {
    if (colors.length >= Math.min(3, limit)) break;
    const [r, g, b] = hexToRgb(fallback);
    if (selected.every((color) => colorDistance(color, { r, g, b }) >= 48)) {
      colors.push(fallback);
    }
  }
  return colors.slice(0, limit);
}

function hexToRgb(color) {
  const normalized = /^#[0-9a-f]{6}$/i.test(color)
    ? color.slice(1)
    : DEFAULT_SPECTRUM_PALETTE[0].slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let [red, green, blue] = [0, 0, 0];
  if (section < 1) [red, green] = [chroma, x];
  else if (section < 2) [red, green] = [x, chroma];
  else if (section < 3) [green, blue] = [chroma, x];
  else if (section < 4) [green, blue] = [x, chroma];
  else if (section < 5) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];
  const match = lightness - chroma / 2;
  return [red, green, blue].map((value) => Math.round((value + match) * 255));
}

function rgbString(values) {
  return `rgb(${values[0]} ${values[1]} ${values[2]})`;
}

function parseRgbString(color) {
  const values = String(color).match(/\d+/g)?.map(Number) ?? [];
  return values.length >= 3 ? values.slice(0, 3) : hexToRgb('#ff78a8');
}

export function normalizeDisplayColor(color) {
  const [red, green, blue] = hexToRgb(color);
  const { hue, saturation, lightness } = rgbToHsl(red, green, blue);
  const displaySaturation = lightness > 0.8
    ? saturation * 0.6
    : saturation;
  const displayLightness = Math.min(0.72, Math.max(0.38, lightness));
  return rgbString(hslToRgb(hue, displaySaturation, displayLightness));
}

export function displayPaletteColorAt(
  palette,
  time,
  transitionDuration = 9000,
) {
  const colors = Array.isArray(palette) && palette.length > 0
    ? palette
    : DEFAULT_SPECTRUM_PALETTE;
  const normalized = colors.map((color) => (
    parseRgbString(normalizeDisplayColor(color))
  ));
  if (normalized.length === 1) return rgbString(normalized[0]);

  const duration = Math.max(1, Number(transitionDuration) || 9000);
  const pathLength = normalized.length - 1;
  const cycleLength = pathLength * 2;
  const rawPosition = (Math.max(0, Number(time) || 0) / duration) % cycleLength;
  const position = rawPosition <= pathLength
    ? rawPosition
    : cycleLength - rawPosition;
  const firstIndex = Math.min(pathLength - 1, Math.floor(position));
  const secondIndex = Math.min(pathLength, firstIndex + 1);
  const amount = position - Math.floor(position);
  return rgbString(normalized[firstIndex].map((value, index) => (
    Math.round(value + (normalized[secondIndex][index] - value) * amount)
  )));
}

export function paletteColorAt(
  palette,
  time,
  transitionDuration = 10000,
) {
  const colors = Array.isArray(palette) && palette.length > 0
    ? palette
    : DEFAULT_SPECTRUM_PALETTE;
  if (colors.length === 1) {
    const [r, g, b] = hexToRgb(colors[0]);
    return `rgb(${r} ${g} ${b})`;
  }
  const duration = Math.max(1, Number(transitionDuration) || 10000);
  const position = Math.max(0, Number(time) || 0) / duration;
  const firstIndex = Math.floor(position) % colors.length;
  const secondIndex = (firstIndex + 1) % colors.length;
  const amount = position - Math.floor(position);
  const first = hexToRgb(colors[firstIndex]);
  const second = hexToRgb(colors[secondIndex]);
  const mixed = first.map((value, index) => (
    Math.round(value + (second[index] - value) * amount)
  ));
  return rgbString(mixed);
}
