// Independent, media-time-only geometry. No wall clock, random state, or cue cache.
import { normalizeFoliaPalette } from './folia-theme.mjs';
const DEG = Math.PI / 180;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const unit = (value) => value - Math.floor(value);
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const viewport = (value) => clamp(finite(value, 1), 1, 32768);
const hash = (index) => unit(Math.sin(index * 127.1 + 311.7) * 43758.5453123);
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (text) => graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment) : Array.from(text);

function cueDirection(item) {
  const key = String(item?.id ?? item?.start ?? '').slice(0, 96);
  let value = 2166136261;
  for (const character of key) value = Math.imul(value ^ character.codePointAt(0), 16777619) >>> 0;
  return value / 0xffffffff * 2 - 1;
}

function currentItems(value, limit = 3) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (let index = 0; index < value.length && items.length < limit; index += 1) {
    const item = value[index];
    if (item && typeof item.text === 'string' && item.text.trim()) items.push(item);
  }
  return items;
}

function fragment(text) {
  // Decorative copies omit speaker labels; the real DOM sentence is untouched.
  const body = text.slice(0, 512).replace(/^\s*【[^】]{0,80}】\s*/u, '').replace(/\s+/gu, ' ').trim();
  return Array.from(body).slice(0, 18).join('');
}

function makeGrid(width, height, time) {
  const tiles = [];
  const angle = -22 * DEG;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const origin = { x: width * 0.46, y: -height * 0.15 };
  const travel = unit(time * 0.085);
  const project = (column, row) => {
    // Keep the near plane away from the lens: a shallow projected ribbon gives
    // 20–60px center tiles, rather than enormous panels around a tight horizon.
    const depth = 2.8 + (row + travel) * 0.16;
    const x = width * 0.11 * column / depth;
    const y = height * 3.5 / depth;
    return { x: origin.x + x * cosine - y * sine, y: origin.y + x * sine + y * cosine };
  };
  // Thirty columns × twenty rows, alternating cells: 300 filled tiles.
  for (let row = 0; row < 20; row += 1) {
    for (let column = -15; column < 15; column += 1) {
      if ((row + column) % 2 !== 0) continue;
      tiles.push({
        points: [project(column, row), project(column + 1, row), project(column + 1, row + 1), project(column, row + 1)],
        alpha: 0.02 + 0.075 * Math.pow(1 - row / 21, 1.2),
      });
    }
  }
  return tiles;
}

function makeEchoes(active, before, time, motionTime, width, height, reducedMotion) {
  const sources = active.map((item) => ({ item, strength: 1 }));
  // Reduced motion keeps the composition still for the current cue set.
  // Previous-line afterimages belong only to the animated fade treatment.
  for (const item of (reducedMotion ? [] : currentItems(before, 2).reverse())) {
    const age = time - finite(item.end, -100);
    if (age >= 0 && age < 3 && !sources.some((source) => source.item.id === item.id)) {
      sources.push({ item, strength: (1 - age / 3) * 0.65 });
    }
  }
  const echoes = [];
  for (let index = 0; index < sources.length && echoes.length < 6; index += 1) {
    const { item, strength } = sources[index];
    const fragmentText = fragment(item.text);
    const vertical = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(fragmentText);
    const glyphs = vertical ? graphemes(fragmentText).slice(0, 6) : [];
    const text = vertical ? glyphs.join('') : fragmentText;
    if (!text) continue;
    const side = item.side === 'left' ? -1 : item.side === 'right' ? 1 : 0;
    const sway = reducedMotion ? 0 : Math.sin(motionTime * 0.075 + index * 1.7);
    const size = clamp(Math.min(width * 0.21, height * 0.175), 100, 210);
    echoes.push({
      text,
      layout: vertical ? 'vertical' : 'horizontal',
      ...(vertical ? { glyphs } : {}),
      x: vertical ? width * (index % 2 === 0 ? 0.14 : 0.86) + sway * width * 0.009 : width * 0.53 + side * width * 0.07 + sway * width * 0.025,
      y: vertical ? height * (0.12 - index * 0.02) : height * (index % 2 === 0 ? 0.20 : 0.83),
      rotate: vertical ? -7 + index * 3 : -11 + index * 3.5,
      fontSize: size,
      alpha: (vertical ? 0.17 : 0.1) * strength,
      lineWidth: Math.max(0.7, size / 130),
    });
    if (index < active.length && echoes.length < 6) {
      echoes.push({
        text: fragmentText,
        layout: 'horizontal',
        x: width * (0.6 - side * 0.05) - sway * width * 0.02,
        y: height * (index % 2 === 0 ? 0.85 : 0.13),
        rotate: -11 + index * 3.5,
        fontSize: size * 1.25,
        alpha: 0.05 * strength,
        lineWidth: Math.max(0.6, size / 180),
      });
    }
  }
  return echoes;
}

/**
 * Build a bounded visual scene from the caller's media time and timeline frame.
 * All positions use logical CSS pixels; all angles, including camera.rotate,
 * use degrees. Palette values are comma-separated RGB channels for CSS/Canvas.
 * Echoes are decorative fragments; this model never replaces the real sentence.
 */
export function buildFoliaSceneFrame(options = {}) {
  const width = viewport(options?.width);
  const height = viewport(options?.height);
  const time = Math.max(0, finite(options?.time, 0));
  const reducedMotion = options?.reducedMotion === true;
  const motionTime = reducedMotion ? 0 : time % 3600;
  const active = currentItems(options?.active);
  const first = active[0];
  const focusSide = first?.side === 'left' ? -1 : first?.side === 'right' ? 1 : 0;
  const elapsed = Math.max(0, time - finite(first?.start, time));
  const remaining = Math.max(0, finite(first?.end, time) - time);
  const duration = Math.max(0.001, finite(first?.end, time) - finite(first?.start, time));
  const progress = clamp(elapsed / duration, 0, 1);
  const focus = Math.pow(Math.sin(Math.PI * progress), 2) * Math.min(1, elapsed / 0.75, remaining / 0.75);
  const direction = cueDirection(first);
  const camera = reducedMotion ? { x: 0, y: 0, rotate: 0, scale: 1 } : {
    x: width * (Math.sin(motionTime * 0.13) * 0.0075 + (focusSide * 0.0065 + direction * 0.004) * focus),
    y: height * (Math.cos(motionTime * 0.1) * 0.006 + direction * focus * 0.003),
    rotate: Math.sin(motionTime * 0.09) * 0.45 + (focusSide * 0.15 + direction * 0.2) * focus,
    scale: 1.018 + Math.sin(motionTime * 0.07) * 0.004 + focus * 0.018,
  };
  const shorter = Math.min(width, height);
  const shafts = Array.from({ length: 5 }, (_, index) => ({
    x: width * (0.16 + Math.sin(motionTime * 0.035) * 0.045),
    y: -height * 0.22,
    angle: 48 + index * 10 + Math.sin(motionTime * 0.045 + index) * 2,
    length: Math.hypot(width, height) * 1.5,
    width: shorter * (0.12 + index * 0.032),
    alpha: 0.025 + 0.025 * (0.5 + 0.5 * Math.sin(motionTime * 0.12 + index * 0.8)),
  }));
  const motes = Array.from({ length: 48 }, (_, index) => {
    const depth = 0.3 + hash(index + 7) * 0.7;
    return {
      x: width * unit(hash(index + 1) + motionTime * 0.0025 * depth),
      y: height * unit(hash(index + 82) - motionTime * 0.004 * depth),
      radius: (0.55 + depth * 1.3) * clamp(shorter / 720, 0.65, 1.5),
      alpha: (0.18 + depth * 0.32) * (0.85 + 0.15 * Math.sin(motionTime * 0.25 + index)),
    };
  });
  const stars = Array.from({ length: 7 }, (_, index) => ({
    x: width * (0.08 + hash(index + 302) * 0.84 + Math.sin(motionTime * 0.05 + index) * 0.009),
    y: height * (0.1 + hash(index + 412) * 0.8 + Math.cos(motionTime * 0.04 + index) * 0.008),
    radius: (3 + hash(index + 20) * 5) * clamp(shorter / 720, 0.75, 1.5),
    rotate: 12 + Math.sin(motionTime * 0.04 + index) * 8,
    alpha: 0.2 + 0.22 * (0.5 + 0.5 * Math.sin(motionTime * 0.22 + index * 1.3)),
  }));
  return {
    camera,
    palette: normalizeFoliaPalette(options?.palette),
    hasBackground: options?.hasBackground === true,
    grid: makeGrid(width, height, motionTime),
    shafts,
    motes,
    echoes: makeEchoes(active, options?.before, time, motionTime, width, height, reducedMotion),
    stars,
  };
}
