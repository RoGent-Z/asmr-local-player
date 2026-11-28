import {
  analyzeSpectrumTimbre,
  DEFAULT_SPECTRUM_PALETTE,
  displayPaletteColorAt,
  extractRepresentativeColors,
  getPlaybackRoutingPlan,
  getSpectrumChannelPlan,
  hasSpectrumEnergy,
  mergeSpectrumData,
} from './spectrum-data.mjs?v=0.1.8';

const IDLE_LEVEL = 0.08;
const ACTIVE_FLOOR = 0.12;
const BAR_COUNT = 30;
const RADIAL_BAR_COUNT = 108;
const HARMONIC_RING_POINTS = 72;
const ORBIT_DUST_COUNT = 20;
const ORBIT_STAR_COUNT = 6;
const DEFAULT_LEFT_PALETTE = Object.freeze(['#ff4d84', '#ff87b2']);
const DEFAULT_RIGHT_PALETTE = Object.freeze(['#c94be0', '#9682ff']);
const PEARL_SPECULAR = Object.freeze([250, 246, 252]);
const VELVET_SHADOW = Object.freeze([12, 9, 18]);

const QUIET_SEMANTIC_FRAME = Object.freeze({
  scene: 'ambient',
  side: 'center',
  intensity: 0.08,
  intimacy: 0,
  breath: 0.12,
  motion: 0.05,
  tension: 0,
  tenderness: 0.12,
  dominance: 0,
  climax: 0,
});

export function spectrumLevel(value, active) {
  if (!active) return IDLE_LEVEL;
  const normalized = Math.min(255, Math.max(0, Number(value) || 0)) / 255;
  return ACTIVE_FLOOR + normalized * (1 - ACTIVE_FLOOR);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function parseColorChannels(color) {
  const text = String(color ?? '');
  if (/^#[0-9a-f]{6}$/i.test(text)) {
    return [
      Number.parseInt(text.slice(1, 3), 16),
      Number.parseInt(text.slice(3, 5), 16),
      Number.parseInt(text.slice(5, 7), 16),
    ];
  }
  const channels = text.match(/\d+/g)?.slice(0, 3).map(Number);
  return channels?.length === 3 ? channels : [255, 77, 132];
}

function mixChannels(first, second, amount) {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(lerp(first[0], second[0], t)),
    Math.round(lerp(first[1], second[1], t)),
    Math.round(lerp(first[2], second[2], t)),
  ];
}

function rgbaFromChannels(channels, alpha) {
  return `rgba(${channels[0]},${channels[1]},${channels[2]},${clamp(alpha, 0, 1).toFixed(4)})`;
}

function colorWithAlpha(color, alpha) {
  return rgbaFromChannels(parseColorChannels(color), alpha);
}

function liftToSpecular(color, amount = 0.62) {
  const mixed = mixChannels(parseColorChannels(color), PEARL_SPECULAR, amount);
  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}

function deepenToVelvet(color, amount = 0.48) {
  const source = parseColorChannels(color);
  const chromaticDeep = [
    Math.round(source[0] * 0.28 + VELVET_SHADOW[0] * 0.72),
    Math.round(source[1] * 0.28 + VELVET_SHADOW[1] * 0.72),
    Math.round(source[2] * 0.28 + VELVET_SHADOW[2] * 0.72),
  ];
  const mixed = mixChannels(source, chromaticDeep, amount);
  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}

function samplePerceptualBin(values, foldRatio) {
  const length = values?.length ?? 0;
  if (length === 0) return 0;
  const maxBin = Math.max(1, Math.floor(length * 0.55) - 1);
  const clampedFold = clamp(foldRatio, 0, 1);
  const position = Math.pow(clampedFold, 1.4) * maxBin;
  const lowIndex = Math.min(maxBin, Math.floor(position));
  const highIndex = Math.min(maxBin, lowIndex + 1);
  const fraction = position - lowIndex;
  const primary = lerp(values[lowIndex] ?? 0, values[highIndex] ?? 0, fraction);
  const neighbor = values[Math.max(0, lowIndex - 1)] ?? primary;
  return (primary * 0.76 + neighbor * 0.24) / 255;
}

function blendColors(first, second, amount = 0.5) {
  const mixed = mixChannels(
    parseColorChannels(first),
    parseColorChannels(second),
    amount,
  );
  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}

function hasRichCanvas(context) {
  return Boolean(
    context
    && typeof context.save === 'function'
    && typeof context.restore === 'function'
    && typeof context.createRadialGradient === 'function'
    && typeof context.createLinearGradient === 'function'
    && typeof context.fill === 'function'
    && typeof context.fillRect === 'function'
    && typeof context.ellipse === 'function'
    && typeof context.quadraticCurveTo === 'function'
    && typeof context.closePath === 'function',
  );
}

function prepareCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (
    !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) {
    return null;
  }
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function glow(context, x, y, radius, color, alpha) {
  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(radius)
    || radius <= 0.5
    || alpha <= 0.001
  ) {
    return;
  }
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, colorWithAlpha(color, alpha));
  gradient.addColorStop(0.38, colorWithAlpha(color, alpha * 0.46));
  gradient.addColorStop(0.72, colorWithAlpha(color, alpha * 0.14));
  gradient.addColorStop(1, colorWithAlpha(color, 0));
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function drawVelvetBloom(
  context,
  x,
  y,
  radius,
  primaryColor,
  secondaryColor,
  intensity,
  specularAmount = 0.55,
) {
  if (!Number.isFinite(radius) || radius <= 1 || intensity <= 0.002) return;
  const velvet = deepenToVelvet(secondaryColor || primaryColor, 0.34);
  const pearl = liftToSpecular(primaryColor, specularAmount);

  // Outer velvet wash
  glow(context, x, y, radius * 1.45, velvet, intensity * 0.62);
  // Molten chromatic body
  glow(context, x, y, radius * 0.92, primaryColor, intensity * 0.95);
  // Intimate incandescent core kiss
  glow(context, x, y, radius * 0.36, pearl, intensity * 0.48);
}

function drawDiamondGlint(context, x, y, radius, color, alpha, rotation = 0) {
  if (!Number.isFinite(radius) || radius <= 0.3 || alpha <= 0.005) return;
  const inner = radius * 0.24;
  context.save();
  context.translate(x, y);
  if (rotation) context.rotate(rotation);
  context.fillStyle = colorWithAlpha(color, alpha);
  context.beginPath();
  context.moveTo(0, -radius);
  context.quadraticCurveTo(inner * 0.35, -inner * 0.35, radius, 0);
  context.quadraticCurveTo(inner * 0.35, inner * 0.35, 0, radius);
  context.quadraticCurveTo(-inner * 0.35, inner * 0.35, -radius, 0);
  context.quadraticCurveTo(-inner * 0.35, -inner * 0.35, 0, -radius);
  context.closePath();
  context.fill();
  context.restore();
}

function heartbeatPulse(time, rateMs, reducedMotion) {
  if (reducedMotion) {
    return 0.35 + Math.sin(time / Math.max(2400, rateMs * 2.4)) * 0.12;
  }
  const phase = (time / rateMs) * Math.PI * 2;
  const primary = Math.pow(Math.max(0, Math.sin(phase)), 6);
  const echo = Math.pow(Math.max(0, Math.sin(phase - 0.68)), 8) * 0.52;
  return Math.min(1, primary + echo);
}

function drawSide(
  canvas,
  side,
  color,
  values,
  active,
  time = 0,
  smoothedLevels = null,
  reducedMotion = false,
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);

  const gap = Math.min(8, Math.max(4, height / (BAR_COUNT * 3.1)));
  const barHeight = Math.max(2.2, (height - gap * (BAR_COUNT - 1)) / BAR_COUNT);
  const maxLength = Math.max(12, width * 0.88);
  const rich = hasRichCanvas(context);

  if (!rich) {
    context.fillStyle = color;
    context.shadowColor = color;
    context.shadowBlur = active ? 15 : 5;
    context.globalAlpha = active ? 0.88 : 0.2;
    for (let index = 0; index < BAR_COUNT; index += 1) {
      const sourceIndex = Math.min(
        Math.max(0, values.length - 1),
        Math.floor((index / BAR_COUNT) * values.length),
      );
      const level = spectrumLevel(values[sourceIndex] ?? 0, active);
      const length = maxLength * level;
      const y = index * (barHeight + gap);
      const x = side === 'left' ? 0 : width - length;
      context.beginPath();
      if (typeof context.roundRect === 'function') {
        context.roundRect(x, y, length, barHeight, barHeight / 2);
      } else {
        context.rect(x, y, length, barHeight);
      }
      context.fill();
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    return;
  }

  const velvetColor = deepenToVelvet(color, 0.36);
  const blushColor = liftToSpecular(color, 0.56);
  const pearlColor = liftToSpecular(color, 0.88);
  const motionScale = reducedMotion ? 0.2 : 1;

  // Compute smoothed liquid-silk bar levels and overall side energy
  let sideEnergy = 0;
  const levels = new Float32Array(BAR_COUNT);
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const ratio = index / Math.max(1, BAR_COUNT - 1);
    const verticalFold = Math.abs(ratio * 2 - 1);
    // Gentle center-weighted perceptual envelope so vocal midrange blooms luxuriously
    const vocalCurve = 0.74 + Math.sin(ratio * Math.PI) * 0.26;
    const perceptualValue = samplePerceptualBin(values, verticalFold) * 255;
    const baseLevel = spectrumLevel(perceptualValue, active);
    const idleRipple = active
      ? 0
      : Math.sin(time / 1600 * motionScale + index * 0.42) * 0.025;
    const target = active
      ? clamp(baseLevel * vocalCurve + 0.04, ACTIVE_FLOOR, 1)
      : clamp(baseLevel + idleRipple, 0.05, 0.14);

    if (smoothedLevels) {
      const prev = smoothedLevels[index] || target;
      const response = target > prev ? 0.36 : 0.18;
      smoothedLevels[index] = lerp(prev, target, response);
      levels[index] = smoothedLevels[index];
    } else {
      levels[index] = target;
    }
    sideEnergy += levels[index];
  }
  sideEnergy /= BAR_COUNT;

  context.save();

  // Soft vertical velvet edge wash behind the bars
  const edgeWashWidth = Math.max(8, width * (0.42 + sideEnergy * 0.48));
  const washGradient = side === 'left'
    ? context.createLinearGradient(0, 0, edgeWashWidth, 0)
    : context.createLinearGradient(width, 0, width - edgeWashWidth, 0);
  const washAlpha = active ? 0.14 + sideEnergy * 0.24 : 0.05;
  washGradient.addColorStop(0, colorWithAlpha(color, washAlpha));
  washGradient.addColorStop(0.55, colorWithAlpha(velvetColor, washAlpha * 0.45));
  washGradient.addColorStop(1, colorWithAlpha(velvetColor, 0));
  context.fillStyle = washGradient;
  context.fillRect(
    side === 'left' ? 0 : width - edgeWashWidth,
    0,
    edgeWashWidth,
    height,
  );

  // Sculpted liquid-silk tapered light bars
  const rootX = side === 'left' ? 0 : width;
  const dir = side === 'left' ? 1 : -1;

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const level = levels[index];
    const length = Math.max(5, maxLength * level);
    const centerY = index * (barHeight + gap) + barHeight / 2;
    const tipX = rootX + dir * length;
    const rootHalf = Math.max(1.2, barHeight * (0.46 + level * 0.2));
    const tipHalf = Math.max(0.85, barHeight * (0.22 + level * 0.12));
    const ctrlX = rootX + dir * (length * 0.54);

    const barGradient = context.createLinearGradient(rootX, centerY, tipX, centerY);
    const alphaScale = active ? 0.52 + level * 0.46 : 0.24 + level * 0.55;
    barGradient.addColorStop(0, colorWithAlpha(velvetColor, alphaScale * 0.52));
    barGradient.addColorStop(0.45, colorWithAlpha(color, alphaScale * 0.92));
    barGradient.addColorStop(0.84, colorWithAlpha(blushColor, alphaScale));
    barGradient.addColorStop(1, colorWithAlpha(pearlColor, Math.min(1, alphaScale * 1.08)));

    context.save();
    context.fillStyle = barGradient;
    context.shadowColor = colorWithAlpha(color, active ? 0.72 : 0.35);
    context.shadowBlur = active ? 8 + level * 14 : 4;

    // Tapered silk petal path
    context.beginPath();
    context.moveTo(rootX, centerY - rootHalf);
    context.quadraticCurveTo(ctrlX, centerY - rootHalf * 0.68, tipX - dir * tipHalf, centerY - tipHalf);
    context.quadraticCurveTo(tipX + dir * (tipHalf * 0.55), centerY, tipX - dir * tipHalf, centerY + tipHalf);
    context.quadraticCurveTo(ctrlX, centerY + rootHalf * 0.68, rootX, centerY + rootHalf);
    context.closePath();
    context.fill();
    context.restore();

    // Soft inner bloom filament along bar centerline
    const innerLength = length * 0.86;
    if (innerLength > 3) {
      const innerTipX = rootX + dir * innerLength;
      const coreGradient = context.createLinearGradient(rootX, centerY, innerTipX, centerY);
      const coreAlpha = active ? 0.16 + level * 0.52 : 0.08;
      coreGradient.addColorStop(0, colorWithAlpha(pearlColor, 0));
      coreGradient.addColorStop(0.48, colorWithAlpha(blushColor, coreAlpha * 0.55));
      coreGradient.addColorStop(1, colorWithAlpha(pearlColor, coreAlpha));
      context.strokeStyle = coreGradient;
      context.lineCap = 'round';
      context.lineWidth = Math.max(0.8, tipHalf * 0.72);
      context.beginPath();
      context.moveTo(rootX + dir * (length * 0.16), centerY);
      context.lineTo(innerTipX, centerY);
      context.stroke();
    }

    // Jewel-like specular tip halo + diamond highlight
    const tipGlowRadius = active ? 3.2 + level * 7.2 : 2.2;
    const tipGlowAlpha = active ? 0.16 + level * 0.44 : 0.08;
    context.save();
    context.globalCompositeOperation = 'lighter';
    glow(context, tipX, centerY, tipGlowRadius, blushColor, tipGlowAlpha);
    if (active || level > 0.095) {
      drawDiamondGlint(
        context,
        tipX,
        centerY,
        active ? 1.6 + level * 2.8 : 1.15,
        pearlColor,
        active ? 0.48 + level * 0.5 : 0.22,
      );
    }
    context.restore();
  }

  context.restore();
}

function drawHarmonicLoop(context, points) {
  const count = points.length;
  if (count < 3) return;
  const last = points[count - 1];
  const first = points[0];
  context.beginPath();
  context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let index = 0; index < count; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % count];
    context.quadraticCurveTo(
      current.x,
      current.y,
      (current.x + next.x) / 2,
      (current.y + next.y) / 2,
    );
  }
  context.closePath();
}

function drawRadial(
  canvas,
  values,
  active,
  color,
  time,
  semantic,
  timbre,
  options = {},
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);

  const size = Math.min(width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const scene = semantic?.scene ?? 'ambient';
  const motion = semantic?.motion ?? 0;
  const intensity = semantic?.intensity ?? 0;
  const intimacy = semantic?.intimacy ?? 0;
  const climax = semantic?.climax ?? 0;
  const low = timbre?.low ?? 0;
  const mid = timbre?.mid ?? 0;
  const high = timbre?.high ?? 0;
  const air = timbre?.air ?? 0;
  const energy = timbre?.energy ?? 0;
  const flux = timbre?.flux ?? 0;

  const secondaryColor = options.secondaryColor ?? color;
  const stereoBalance = clamp(Number(options.stereoBalance) || 0, -1, 1);
  const reducedMotion = Boolean(options.reducedMotion);
  const motionScale = reducedMotion ? 0.16 : 1;

  const breathSpeed = scene === 'whisper' || scene === 'afterglow'
    ? 2350
    : scene === 'rhythm' || scene === 'surge' ? 920 : 1800;
  const breath = 0.5 + Math.sin((time / breathSpeed) * motionScale) * 0.5;
  const pulse = heartbeatPulse(time, scene === 'surge' ? 880 : 1480, reducedMotion);

  const baseRadius = size * (
    0.255
    + intimacy * 0.018
    + low * 0.02
    + (active ? pulse * 0.008 * (0.4 + intimacy + climax) : breath * 0.004)
  );
  const maxLength = size * (
    0.125
    + intensity * 0.048
    + high * 0.03
    + climax * 0.025
  );
  const idleLength = size * (0.019 + breath * 0.009);
  const rotation = ((time / 28000) * (0.25 + motion * 1.5)) * motionScale;

  const rich = hasRichCanvas(context) && size >= 24;

  if (rich) {
    const pearlColor = liftToSpecular(color, 0.78);
    const blushColor = liftToSpecular(color, 0.48);
    const velvetColor = deepenToVelvet(secondaryColor, 0.38);
    const vocalSwell = active ? clamp(0.28 + energy * 0.85 + intensity * 0.35 + climax * 0.35, 0.25, 1.35) : 0.16 + breath * 0.08;

    context.save();
    context.globalCompositeOperation = 'lighter';

    // 1. Luxury radial velvet halo ring (keeps center clean for subtitle contrast)
    const haloInner = Math.max(0.5, baseRadius * 0.52);
    const haloOuter = Math.max(haloInner + 1, baseRadius * (1.42 + vocalSwell * 0.12));
    const haloGradient = context.createRadialGradient(
      centerX,
      centerY,
      haloInner,
      centerX,
      centerY,
      haloOuter,
    );
    const haloPeakAlpha = active
      ? clamp(0.14 + energy * 0.22 + intimacy * 0.1 + climax * 0.12, 0.12, 0.42)
      : 0.06 + breath * 0.04;
    haloGradient.addColorStop(0, colorWithAlpha(velvetColor, 0));
    haloGradient.addColorStop(0.36, colorWithAlpha(velvetColor, haloPeakAlpha * 0.65));
    haloGradient.addColorStop(0.54, colorWithAlpha(color, haloPeakAlpha));
    haloGradient.addColorStop(0.76, colorWithAlpha(secondaryColor, haloPeakAlpha * 0.38));
    haloGradient.addColorStop(1, colorWithAlpha(secondaryColor, 0));
    context.fillStyle = haloGradient;
    context.fillRect(
      centerX - haloOuter,
      centerY - haloOuter,
      haloOuter * 2,
      haloOuter * 2,
    );

    // 2. Inner velvet crescent bloom hugging the rim & leaning toward active ear
    const crescentAngle = rotation * 2.2
      + (stereoBalance * 0.95)
      - Math.PI * 0.58;
    const crescentOffsetR = baseRadius * 0.88;
    const crescentX = centerX + Math.cos(crescentAngle) * crescentOffsetR;
    const crescentY = centerY + Math.sin(crescentAngle) * crescentOffsetR;
    const crescentRadius = Math.max(2, baseRadius * (0.48 + vocalSwell * 0.14));
    glow(
      context,
      crescentX,
      crescentY,
      crescentRadius,
      blushColor,
      active ? 0.16 + energy * 0.22 + intimacy * 0.1 : 0.065 + breath * 0.035,
    );
    // Secondary opposite orchid velvet counterweight
    const counterAngle = crescentAngle + Math.PI * 0.92;
    const counterX = centerX + Math.cos(counterAngle) * (baseRadius * 0.9);
    const counterY = centerY + Math.sin(counterAngle) * (baseRadius * 0.9);
    glow(
      context,
      counterX,
      counterY,
      Math.max(2, baseRadius * 0.36),
      secondaryColor,
      active ? 0.1 + energy * 0.14 : 0.04 + breath * 0.02,
    );

    // Sculpted glowing crescent arc ribbon via ellipse (no context.arc call)
    const crescentRimR = Math.max(1, baseRadius - 1.5);
    context.save();
    context.translate(centerX, centerY);
    context.rotate(crescentAngle);
    const crescentGrad = context.createLinearGradient(
      crescentRimR,
      -crescentRimR * 0.7,
      -crescentRimR * 0.3,
      crescentRimR * 0.7,
    );
    const crescentAlpha = active ? 0.42 + energy * 0.44 : 0.18 + breath * 0.1;
    crescentGrad.addColorStop(0, colorWithAlpha(pearlColor, crescentAlpha));
    crescentGrad.addColorStop(0.45, colorWithAlpha(color, crescentAlpha * 0.65));
    crescentGrad.addColorStop(1, colorWithAlpha(secondaryColor, 0));
    context.strokeStyle = crescentGrad;
    context.lineCap = 'round';
    context.lineWidth = Math.max(1.8, size * (active ? 0.011 + energy * 0.008 : 0.007));
    context.shadowColor = colorWithAlpha(blushColor, 0.7);
    context.shadowBlur = active ? 14 : 7;
    context.beginPath();
    context.ellipse(0, 0, crescentRimR, crescentRimR, 0, -Math.PI * 0.42, Math.PI * 0.42);
    context.stroke();
    context.restore();

    // 3. Silky Harmonic Wave Ring (outer velvet wave + inner specular silk thread)
    const outerWavePoints = [];
    const innerSilkPoints = [];
    const wavePhase = (time / 1900) * motionScale;
    const counterPhase = -(time / 2700) * motionScale;

    for (let index = 0; index < HARMONIC_RING_POINTS; index += 1) {
      const ratio = index / HARMONIC_RING_POINTS;
      const angle = ratio * Math.PI * 2 - Math.PI / 2 + rotation * 0.85;
      // 2-fold bilateral symmetry mapped perceptually across vocal-active lower 55% of FFT bins
      const fold = Math.abs(((ratio * 4) % 2) - 1);
      const rawSample = active ? samplePerceptualBin(values, fold) : 0;
      const vocalFloor = active
        ? (energy * 0.45 + low * 0.25 + mid * 0.3) * (0.58 + 0.42 * Math.cos(angle * 4 - wavePhase * 0.9))
        : 0;
      const sample = active ? clamp(Math.pow(rawSample, 0.86) * 0.74 + vocalFloor * 0.36, 0, 1) : 0;
      const harmonicA = Math.sin(angle * 3 + wavePhase) * 0.55
        + Math.cos(angle * 5 - wavePhase * 1.3) * 0.45;
      const harmonicB = Math.sin(angle * 4 + counterPhase) * 0.6
        + Math.cos(angle * 7 + wavePhase * 0.8) * 0.4;

      const outerR = baseRadius
        + (active
          ? maxLength * (0.14 + sample * 0.48 + mid * 0.14) + size * 0.011 * harmonicA
          : size * (0.014 + breath * 0.008) + size * 0.006 * harmonicA);
      const innerR = Math.max(
        2,
        baseRadius
          - size * 0.012
          + (active
            ? size * (0.009 + sample * 0.024) * harmonicB
            : size * 0.0045 * harmonicB),
      );

      outerWavePoints.push({
        x: centerX + Math.cos(angle) * outerR,
        y: centerY + Math.sin(angle) * outerR,
      });
      innerSilkPoints.push({
        x: centerX + Math.cos(angle) * innerR,
        y: centerY + Math.sin(angle) * innerR,
      });
    }

    // Sheer glowing harmonic silk fill + luminous stroke
    drawHarmonicLoop(context, outerWavePoints);
    const silkGradient = context.createRadialGradient(
      centerX,
      centerY,
      Math.max(0.5, baseRadius * 0.82),
      centerX,
      centerY,
      Math.max(2, baseRadius + maxLength * 0.68),
    );
    silkGradient.addColorStop(0, colorWithAlpha(secondaryColor, 0));
    silkGradient.addColorStop(0.55, colorWithAlpha(color, active ? 0.08 + energy * 0.12 : 0.03));
    silkGradient.addColorStop(1, colorWithAlpha(blushColor, active ? 0.14 + energy * 0.14 : 0.05));
    context.fillStyle = silkGradient;
    context.fill();

    context.strokeStyle = colorWithAlpha(
      blendColors(color, secondaryColor, 0.32),
      active ? 0.44 + energy * 0.36 : 0.18 + breath * 0.08,
    );
    context.lineWidth = Math.max(1.2, size / 195);
    context.shadowColor = colorWithAlpha(color, 0.72);
    context.shadowBlur = active ? 12 : 6;
    context.stroke();

    // Fine champagne-pearl harmonic silk thread
    drawHarmonicLoop(context, innerSilkPoints);
    context.strokeStyle = colorWithAlpha(
      pearlColor,
      active ? 0.36 + air * 0.36 + energy * 0.2 : 0.13 + breath * 0.07,
    );
    context.lineWidth = Math.max(0.85, size / 310);
    context.shadowColor = colorWithAlpha(pearlColor, 0.55);
    context.shadowBlur = active ? 8 : 4;
    context.stroke();

    // 4. Luminous Tapered Specular Filament Rays
    const rayGradient = context.createRadialGradient(
      centerX,
      centerY,
      Math.max(0.5, baseRadius * 0.96),
      centerX,
      centerY,
      Math.max(2, baseRadius + maxLength * 1.15),
    );
    rayGradient.addColorStop(0, colorWithAlpha(secondaryColor, active ? 0.58 : 0.24));
    rayGradient.addColorStop(0.45, colorWithAlpha(color, active ? 0.92 : 0.42));
    rayGradient.addColorStop(0.82, colorWithAlpha(blushColor, active ? 0.96 : 0.52));
    rayGradient.addColorStop(1, colorWithAlpha(pearlColor, active ? 1 : 0.6));

    const rootHalfWidth = Math.max(0.85, size / 245);
    context.fillStyle = rayGradient;
    context.shadowColor = colorWithAlpha(color, active ? 0.78 : 0.38);
    context.shadowBlur = active ? 14 : 6;
    context.globalAlpha = active ? 0.9 : 0.22 + breath * 0.1;

    for (let index = 0; index < RADIAL_BAR_COUNT; index += 1) {
      const ratio = index / RADIAL_BAR_COUNT;
      const angle = ratio * Math.PI * 2
        - Math.PI / 2
        + rotation;
      // 2-fold symmetrical perceptual mapping so vocal energy blooms evenly around 360°
      const fold = Math.abs(((ratio * 4) % 2) - 1);
      const perceptual = active ? samplePerceptualBin(values, fold) : 0;
      const harmonicSwell = active
        ? (energy * 0.42 + low * 0.24 + mid * 0.28)
          * (0.55 + 0.45 * Math.sin(angle * 6 + wavePhase * 1.1))
        : 0;
      const normalized = active
        ? clamp(Math.pow(perceptual, 0.86) * 0.76 + harmonicSwell * 0.34, 0, 1)
        : 0;
      const accentHarmonic = index % 6 === 0 ? 1.14 : index % 3 === 0 ? 1.05 : 0.96;
      const length = active
        ? maxLength * (
          0.18
          + normalized * 0.72
          + flux * 0.22
          + (scene === 'surge' ? 0.14 : 0)
        ) * accentHarmonic
        : idleLength * (
          0.84
          + Math.sin(index * 0.47 + (time / 1200) * motionScale) * 0.16
        ) * accentHarmonic;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const perpX = -sin;
      const perpY = cos;
      const halfRoot = rootHalfWidth * (active ? 0.85 + normalized * 0.65 : 0.75);
      const rootX = centerX + cos * baseRadius;
      const rootY = centerY + sin * baseRadius;
      const tipX = centerX + cos * (baseRadius + length);
      const tipY = centerY + sin * (baseRadius + length);

      // Sculpted tapered needle filament
      context.beginPath();
      context.moveTo(rootX + perpX * halfRoot, rootY + perpY * halfRoot);
      context.lineTo(tipX, tipY);
      context.lineTo(rootX - perpX * halfRoot, rootY - perpY * halfRoot);
      context.closePath();
      context.fill();

      // Jewel-like specular tip glints on prominent filaments
      if ((active && normalized > 0.24 && index % 2 === 0) || (!active && index % 18 === 0)) {
        drawDiamondGlint(
          context,
          tipX,
          tipY,
          active ? 1.4 + normalized * 2.4 : 1.3,
          pearlColor,
          active ? 0.45 + normalized * 0.52 : 0.22 + breath * 0.12,
          angle,
        );
      }
    }

    // 5. Subtle Orbiting Glint Dust & 4-Point Diamond Starlight
    context.shadowBlur = 0;
    context.globalAlpha = 1;
    const dustSwell = active ? 1 + energy * 0.24 + air * 0.16 : 1 + breath * 0.04;
    for (let index = 0; index < ORBIT_DUST_COUNT; index += 1) {
      const orbitSpeed = (0.00014 + (index % 5) * 0.000045) * (index % 2 === 0 ? 1 : -1) * motionScale;
      const angle = time * orbitSpeed + index * 1.91;
      const radialTrack = baseRadius * (1.07 + ((index * 17) % 10) * 0.034) * dustSwell;
      const wobble = Math.sin(time * 0.0012 * motionScale + index * 1.3) * size * 0.012;
      const px = centerX + Math.cos(angle) * (radialTrack + wobble);
      const py = centerY + Math.sin(angle) * (radialTrack * 0.94 - wobble * 0.6);
      const twinkle = 0.45 + 0.55 * Math.sin(time * 0.0028 * motionScale + index * 2.13);
      const moteColor = index % 3 === 0 ? pearlColor : index % 3 === 1 ? blushColor : secondaryColor;
      const moteRadius = Math.max(1.4, (size / 145) * (1.1 + (index % 3) * 0.55) * (active ? 1 + energy * 0.5 : 0.85));
      const moteAlpha = (active ? 0.16 + energy * 0.34 + air * 0.2 : 0.09 + breath * 0.06) * twinkle;
      glow(context, px, py, moteRadius * 2.8, moteColor, moteAlpha);
    }

    for (let index = 0; index < ORBIT_STAR_COUNT; index += 1) {
      const starSpeed = (0.00009 + index * 0.000022) * (index % 2 === 0 ? 1 : -1) * motionScale;
      const angle = time * starSpeed + index * (Math.PI * 2 / ORBIT_STAR_COUNT) + 0.4;
      const orbitR = baseRadius * (1.18 + (index % 3) * 0.085) * dustSwell;
      const sx = centerX + Math.cos(angle) * orbitR;
      const sy = centerY + Math.sin(angle) * orbitR * 0.96;
      const twinkle = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(time * 0.0022 * motionScale + index * 1.7), 2);
      const starSize = Math.max(2.2, (size / 88) * (0.85 + (index % 2) * 0.45) * (active ? 1 + high * 0.55 : 0.82));
      const starAlpha = (active ? 0.34 + energy * 0.45 + air * 0.22 : 0.16 + breath * 0.1) * twinkle;
      glow(context, sx, sy, starSize * 2.3, blushColor, starAlpha * 0.48);
      drawDiamondGlint(context, sx, sy, starSize, pearlColor, starAlpha, angle * 0.35);
    }

    context.restore();
  } else {
    // Minimal canvas fallback (preserves exact compatibility with minimal mock contexts)
    context.strokeStyle = color;
    context.lineCap = 'round';
    context.lineWidth = Math.max(1.4, size / 145);
    context.shadowColor = color;
    context.shadowBlur = active ? 15 : 7;
    context.globalAlpha = active ? 0.82 : 0.13 + breath * 0.07;

    for (let index = 0; index < RADIAL_BAR_COUNT; index += 1) {
      const angle = (index / RADIAL_BAR_COUNT) * Math.PI * 2
        - Math.PI / 2
        + rotation;
      const sourceIndex = Math.min(
        Math.max(0, values.length - 1),
        Math.floor((index / RADIAL_BAR_COUNT) * values.length),
      );
      const normalized = (values[sourceIndex] ?? 0) / 255;
      const length = active
        ? maxLength * (
          0.18
          + normalized * 0.68
          + flux * 0.22
          + (scene === 'surge' ? 0.12 : 0)
        )
        : idleLength * (0.9 + Math.sin(index * 0.47 + time / 1200) * 0.1);
      const startX = centerX + Math.cos(angle) * baseRadius;
      const startY = centerY + Math.sin(angle) * baseRadius;
      const endX = centerX + Math.cos(angle) * (baseRadius + length);
      const endY = centerY + Math.sin(angle) * (baseRadius + length);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
    }
  }

  // Single positive-radius inner precision ring (sole context.arc call in drawRadial)
  context.shadowBlur = 0;
  const innerRadius = baseRadius - 4;
  if (innerRadius > 0) {
    context.strokeStyle = rich ? liftToSpecular(color, 0.52) : color;
    context.globalAlpha = active ? 0.3 : 0.12 + breath * 0.06;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
}

function drawSpecularSilkVeils(context, metrics, frame, reducedMotion) {
  const {
    width,
    height,
    x,
    y,
    color,
    secondaryColor,
    time,
    energy,
    timbre,
    stereoBalance,
  } = metrics;
  const motionScale = reducedMotion ? 0.18 : 1;
  const pearlColor = liftToSpecular(color, 0.72);
  const veilCount = 4;

  context.lineCap = 'round';
  for (let index = 0; index < veilCount; index += 1) {
    const ratio = (index + 0.5) / veilCount;
    const phase = (time / (4200 + index * 950)) * motionScale + index * 1.48;
    const anchorY = height * (0.24 + ratio * 0.52)
      + Math.sin(phase * 0.9) * height * 0.035;
    const sway = height * (0.045 + frame.breath * 0.055 + timbre.mid * 0.065 + energy * 0.04);
    const pullX = x + stereoBalance * width * 0.08;
    const cp1X = width * 0.28 + Math.cos(phase) * width * 0.05;
    const cp1Y = anchorY - sway * Math.sin(phase + index);
    const cp2X = clamp(pullX + Math.sin(phase * 0.7) * width * 0.12, width * 0.25, width * 0.82);
    const cp2Y = anchorY + sway * Math.cos(phase * 0.85 - index);
    const endY = anchorY + Math.sin(phase * 0.6 + index * 0.7) * height * 0.07;

    const ribbonColor = index % 2 === 0 ? color : secondaryColor;
    const ribbonGrad = context.createLinearGradient(0, anchorY, width, endY);
    const chiffonAlpha = clamp(
      0.028 + frame.intimacy * 0.038 + frame.breath * 0.032 + energy * 0.055,
      0.025,
      0.14,
    );
    ribbonGrad.addColorStop(0, colorWithAlpha(ribbonColor, chiffonAlpha * (stereoBalance < 0 ? 1.25 : 0.45)));
    ribbonGrad.addColorStop(clamp(x / Math.max(1, width), 0.15, 0.85), colorWithAlpha(ribbonColor, chiffonAlpha * 1.35));
    ribbonGrad.addColorStop(1, colorWithAlpha(ribbonColor, chiffonAlpha * (stereoBalance > 0 ? 1.25 : 0.45)));

    // Pass 1: Sheer velvet chiffon volume
    context.strokeStyle = ribbonGrad;
    context.lineWidth = Math.max(8, Math.min(width, height) * (0.018 + index * 0.005 + timbre.low * 0.014));
    context.beginPath();
    context.moveTo(-width * 0.04, anchorY);
    context.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, width * 1.04, endY);
    context.stroke();

    // Pass 2: Razor-fine specular silk crest thread
    const threadAlpha = clamp(
      0.065 + frame.breath * 0.11 + timbre.air * 0.15 + energy * 0.12,
      0.05,
      0.34,
    );
    const threadGrad = context.createLinearGradient(0, anchorY, width, endY);
    threadGrad.addColorStop(0, colorWithAlpha(pearlColor, 0));
    threadGrad.addColorStop(clamp(x / Math.max(1, width), 0.18, 0.82), colorWithAlpha(pearlColor, threadAlpha));
    threadGrad.addColorStop(1, colorWithAlpha(pearlColor, 0));
    context.strokeStyle = threadGrad;
    context.lineWidth = 0.85 + timbre.air * 1.15;
    context.beginPath();
    context.moveTo(-width * 0.04, anchorY);
    context.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, width * 1.04, endY);
    context.stroke();
  }
}

function drawWhisper(context, frame, metrics, reducedMotion) {
  const {
    width,
    height,
    x,
    y,
    color,
    time,
    energy,
    timbre,
  } = metrics;
  const motionScale = reducedMotion ? 0.18 : 1;
  const pearlColor = liftToSpecular(color, 0.72);
  context.lineCap = 'round';
  for (let index = 0; index < 10; index += 1) {
    const phase = (time / 2300) * motionScale + index * 0.72;
    const spread = width * (0.09 + frame.intimacy * 0.09);
    const startX = x + Math.sin(phase) * spread * 0.25;
    const startY = y + (index - 4.5) * height * 0.025;
    context.lineWidth = 1.1 + timbre.air * 2.2;
    context.strokeStyle = colorWithAlpha(
      index % 2 === 0 ? color : pearlColor,
      0.08 + frame.breath * 0.2 + energy * 0.1,
    );
    context.beginPath();
    context.moveTo(startX, startY);
    context.bezierCurveTo(
      startX + Math.cos(phase) * spread,
      startY - height * 0.05,
      startX - Math.sin(phase * 0.7) * spread,
      startY + height * 0.08,
      startX + Math.cos(phase * 0.5) * spread * 1.45,
      startY + height * 0.01,
    );
    context.stroke();
  }
  for (let index = 0; index < 24; index += 1) {
    const phase = (time / 3100) * motionScale + index * 1.73;
    const radius = 1.2 + ((index * 7) % 5) * 0.45 + energy * 2.2;
    const px = x + Math.cos(phase) * width * (0.05 + (index % 6) * 0.018);
    const py = y + Math.sin(phase * 0.63) * height * 0.18;
    glow(
      context,
      px,
      py,
      radius * 3.2,
      index % 3 === 0 ? pearlColor : color,
      0.1 + timbre.air * 0.2 + energy * 0.12,
    );
  }
}

function drawTease(context, frame, metrics, reducedMotion) {
  const { width, height, x, y, color, secondaryColor, time, energy, timbre } = metrics;
  const motionScale = reducedMotion ? 0.18 : 1;
  const pearlColor = liftToSpecular(color, 0.78);
  context.lineWidth = 1.15 + timbre.centroid * 1.6;
  for (let index = 0; index < 4; index += 1) {
    const radiusX = Math.max(2, width * (0.085 + index * 0.038));
    const radiusY = Math.max(2, height * (0.052 + index * 0.024));
    const tilt = Math.sin((time / 3200) * motionScale + index) * 0.36;
    context.save();
    context.translate(x, y);
    context.rotate(tilt);
    context.strokeStyle = colorWithAlpha(
      index % 2 === 0 ? color : secondaryColor,
      0.12 + frame.tension * 0.18 + energy * 0.1,
    );
    context.beginPath();
    context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
    context.stroke();

    const phase = (time / (900 - Math.min(400, frame.dominance * 350))) * motionScale
      + index * 1.55;
    const sparkX = Math.cos(phase) * radiusX;
    const sparkY = Math.sin(phase) * radiusY;
    glow(context, sparkX, sparkY, 7 + index * 2.4, color, 0.22 + energy * 0.28);
    drawDiamondGlint(context, sparkX, sparkY, 2.8 + index * 0.65, pearlColor, 0.55 + energy * 0.35, phase);
    context.restore();
  }
}

function drawContact(context, frame, metrics, reducedMotion) {
  const { width, height, x, y, color, secondaryColor, time, energy, timbre } = metrics;
  const motionScale = reducedMotion ? 0.22 : 1;
  const pearlColor = liftToSpecular(color, 0.68);
  const cycle = ((time / 2100) * motionScale) % 1;
  const minDim = Math.min(width, height);
  for (let index = 0; index < 5; index += 1) {
    const progress = (cycle + index / 5) % 1;
    const radius = Math.max(2, minDim * (0.04 + progress * (0.19 + frame.intimacy * 0.09)));
    const fade = 1 - progress;
    const rx = Math.max(1, radius * 1.2);
    const ry = Math.max(1, radius * (0.72 + timbre.low * 0.24));
    const rot = Math.sin((time / 4600) * motionScale) * 0.18;

    context.strokeStyle = colorWithAlpha(
      index % 2 === 0 ? color : secondaryColor,
      fade * (0.09 + frame.intimacy * 0.18 + energy * 0.14),
    );
    context.lineWidth = 1 + timbre.mid * 3.1;
    context.beginPath();
    context.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    context.stroke();

    context.strokeStyle = colorWithAlpha(pearlColor, fade * (0.05 + frame.intimacy * 0.12));
    context.lineWidth = 0.8;
    context.beginPath();
    context.ellipse(x, y, rx * 0.96, ry * 0.96, rot, 0, Math.PI * 2);
    context.stroke();
  }
}

function drawRhythm(context, frame, metrics, reducedMotion) {
  const { width, height, x, y, color, secondaryColor, time, energy, timbre } = metrics;
  const motionScale = reducedMotion ? 0.2 : 1;
  const pearlColor = liftToSpecular(color, 0.72);
  const speed = 760 - frame.motion * 320;
  context.lineCap = 'round';
  for (let layer = 0; layer < 4; layer += 1) {
    context.strokeStyle = colorWithAlpha(
      layer % 2 === 0 ? color : secondaryColor,
      0.09 + frame.motion * 0.1 + energy * 0.14,
    );
    context.lineWidth = 1.1 + layer * 0.45 + timbre.low * 1.8;
    context.beginPath();
    for (let step = 0; step <= 42; step += 1) {
      const progress = step / 42;
      const pointX = width * progress;
      const envelope = Math.sin(progress * Math.PI);
      const pointY = y
        + Math.sin(
          progress * Math.PI * (4 + layer)
          + (time / speed) * motionScale
          + layer,
        ) * height * (0.026 + frame.motion * 0.038) * envelope;
      if (step === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    }
    context.stroke();
  }
  const pulse = ((time / speed) * motionScale) % 1;
  const pulseRadius = Math.max(2, Math.min(width, height) * (0.055 + pulse * 0.21));
  context.strokeStyle = colorWithAlpha(pearlColor, (1 - pulse) * (0.28 + energy * 0.16));
  context.lineWidth = 1.4 + energy * 3.2;
  context.beginPath();
  context.ellipse(x, y, pulseRadius, pulseRadius, 0, 0, Math.PI * 2);
  context.stroke();
}

function drawSurge(context, frame, metrics, reducedMotion) {
  const { width, height, x, y, color, secondaryColor, time, energy, timbre } = metrics;
  const motionScale = reducedMotion ? 0.18 : 1;
  const pearlColor = liftToSpecular(color, 0.8);
  const minDim = Math.min(width, height);
  const radius = Math.max(4, minDim * (0.14 + frame.climax * 0.17));
  context.lineCap = 'round';
  for (let index = 0; index < 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2 + (time / 2100) * motionScale;
    const jitter = 0.72 + Math.sin((time / 180) * motionScale + index * 2.31) * 0.2;
    const inner = radius * (0.48 + timbre.low * 0.18);
    const outer = radius * (0.94 + jitter * (0.38 + frame.intensity * 0.58));
    context.strokeStyle = colorWithAlpha(
      index % 4 === 0 ? pearlColor : index % 2 === 0 ? color : secondaryColor,
      0.14 + frame.climax * 0.22 + energy * 0.18,
    );
    context.lineWidth = (index % 4 === 0 ? 1.4 : 0.95) + timbre.high * 2.2;
    context.beginPath();
    context.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    context.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    context.stroke();
  }
  drawVelvetBloom(
    context,
    x,
    y,
    minDim * (0.2 + frame.climax * 0.14),
    color,
    secondaryColor,
    0.12 + frame.climax * 0.18 + energy * 0.1,
    0.75,
  );
}

function drawAfterglow(context, frame, metrics, reducedMotion) {
  const { width, height, x, y, color, secondaryColor, time, timbre } = metrics;
  const motionScale = reducedMotion ? 0.2 : 1;
  const pearlColor = liftToSpecular(color, 0.7);
  drawVelvetBloom(
    context,
    x,
    y + height * 0.05,
    Math.min(width, height) * (0.24 + frame.tenderness * 0.09),
    color,
    secondaryColor,
    0.1 + frame.tenderness * 0.1,
    0.65,
  );
  for (let index = 0; index < 28; index += 1) {
    const phase = ((time / 9000) * motionScale + index * 0.071) % 1;
    const drift = Math.sin((time / 2800) * motionScale + index) * width * 0.02;
    const px = x + drift + ((index % 7) - 3) * width * 0.022;
    const py = y - height * 0.04 + phase * height * 0.24;
    glow(
      context,
      px,
      py,
      3.5 + timbre.air * 5.2,
      index % 3 === 0 ? pearlColor : color,
      (1 - phase) * (0.06 + frame.tenderness * 0.12),
    );
  }
}

function drawSemanticAtmosphere(
  canvas,
  frame,
  leftTimbre,
  rightTimbre,
  paired,
  colors,
  time,
  active,
  visualReferenceImages = [],
  focus = { side: 'center', pan: 0, dominance: 0 },
  motionState = null,
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);
  if (!hasRichCanvas(context)) return;

  const minDim = Math.min(width, height);
  if (minDim < 8) return;

  const mergedTimbre = {
    low: Math.max(leftTimbre.low, rightTimbre.low),
    mid: Math.max(leftTimbre.mid, rightTimbre.mid),
    high: Math.max(leftTimbre.high, rightTimbre.high),
    air: Math.max(leftTimbre.air, rightTimbre.air),
    energy: Math.max(leftTimbre.energy, rightTimbre.energy),
    centroid: Math.max(leftTimbre.centroid, rightTimbre.centroid),
    flux: Math.max(leftTimbre.flux, rightTimbre.flux),
  };

  const reducedMotion = Boolean(motionState?.reducedMotion);
  const motionScale = reducedMotion ? 0.18 : 1;
  const rawEnergy = active ? mergedTimbre.energy : 0;
  const energy = motionState ? motionState.energy : rawEnergy;
  const leftEnergy = motionState ? motionState.leftEnergy : (active ? leftTimbre.energy : 0);
  const rightEnergy = motionState ? motionState.rightEnergy : (active ? rightTimbre.energy : 0);
  const stereoBalance = motionState ? motionState.stereoBalance : 0;

  const semantic = frame ?? QUIET_SEMANTIC_FRAME;
  const semanticSide = semantic?.side ?? 'center';
  const focusSide = focus?.side ?? 'center';
  const side = focusSide !== 'center' ? focusSide : semanticSide;
  const focusPan = Number(focus?.pan) || 0;
  const sideBias = side === 'left'
    ? -0.17
    : side === 'right' ? 0.17 : 0;

  const x = width * clamp(
    0.5 + sideBias + focusPan * 0.14 + stereoBalance * 0.18,
    0.2,
    0.8,
  );
  const y = height * (0.46 + Math.sin((time / 5400) * motionScale) * 0.018);
  const secondaryColor = colors.secondary ?? colors.center;
  const hasImagePalette = Boolean(motionState?.hasImagePalette);
  const leftEarColor = paired
    ? colors.left
    : hasImagePalette
      ? colors.center
      : blendColors(colors.center, colors.left, 0.25);
  const rightEarColor = paired
    ? colors.right
    : hasImagePalette
      ? secondaryColor
      : blendColors(colors.center, secondaryColor, 0.55);
  const primaryColor = side === 'left'
    ? leftEarColor
    : side === 'right' ? rightEarColor : colors.center;
  const breath = 0.5 + Math.sin((time / 3200) * motionScale) * 0.5;
  const beatRate = semantic.scene === 'surge' || semantic.climax > 0.45
    ? 860
    : semantic.intimacy > 0.35 ? 1180 : 1560;
  const beat = heartbeatPulse(time, beatRate, reducedMotion);
  const intimacyDrive = clamp(
    semantic.intimacy * 0.72 + semantic.breath * 0.36 + semantic.climax * 0.65 + energy * 0.55,
    0,
    1.35,
  );

  context.save();
  context.globalCompositeOperation = 'lighter';

  // 1. Binaural Left & Right Ear Layered Velvet Glows (active on both single stereo & paired tracks)
  const leftFocusBoost = side === 'left' ? 0.32 : focusPan < -0.1 ? Math.abs(focusPan) * 0.35 : 0;
  const rightFocusBoost = side === 'right' ? 0.32 : focusPan > 0.1 ? Math.abs(focusPan) * 0.35 : 0;
  const leftPanBoost = Math.max(0, -stereoBalance) * 0.42;
  const rightPanBoost = Math.max(0, stereoBalance) * 0.42;

  const leftEarRadius = minDim * (
    0.25
    + leftTimbre.low * 0.14
    + leftEnergy * 0.16
    + (leftFocusBoost + leftPanBoost) * 0.12
    + breath * 0.03
  );
  const rightEarRadius = minDim * (
    0.25
    + rightTimbre.low * 0.14
    + rightEnergy * 0.16
    + (rightFocusBoost + rightPanBoost) * 0.12
    + (1 - breath) * 0.03
  );

  const leftEarIntensity = clamp(
    0.055
    + breath * 0.025
    + leftEnergy * 0.24
    + leftFocusBoost * 0.14
    + leftPanBoost * 0.16
    + semantic.intimacy * 0.06,
    0.04,
    0.42,
  );
  const rightEarIntensity = clamp(
    0.055
    + (1 - breath) * 0.025
    + rightEnergy * 0.24
    + rightFocusBoost * 0.14
    + rightPanBoost * 0.16
    + semantic.intimacy * 0.06,
    0.04,
    0.42,
  );

  drawVelvetBloom(
    context,
    width * (paired ? 0.11 : 0.08),
    height * (0.48 - Math.sin((time / 4800) * motionScale) * 0.04),
    leftEarRadius,
    leftEarColor,
    secondaryColor,
    leftEarIntensity,
    0.52 + leftTimbre.air * 0.32,
  );
  drawVelvetBloom(
    context,
    width * (paired ? 0.89 : 0.92),
    height * (0.48 + Math.sin((time / 4800) * motionScale) * 0.04),
    rightEarRadius,
    rightEarColor,
    colors.center,
    rightEarIntensity,
    0.52 + rightTimbre.air * 0.32,
  );

  // 2. Central Breathing Heartbeat Bloom (driven by intimacy, breath, climax & vocal warmth)
  const heartbeatRadius = minDim * (
    0.26
    + semantic.intimacy * 0.11
    + semantic.climax * 0.12
    + mergedTimbre.low * 0.08
    + beat * (0.045 + intimacyDrive * 0.055)
  );
  const heartbeatIntensity = clamp(
    0.048
    + semantic.intensity * 0.085
    + energy * 0.14
    + beat * (0.038 + intimacyDrive * 0.095),
    0.04,
    0.34,
  );
  drawVelvetBloom(
    context,
    x,
    y,
    heartbeatRadius,
    primaryColor,
    secondaryColor,
    heartbeatIntensity,
    0.58 + semantic.breath * 0.25,
  );

  // 3. Silky Drifting Specular Veil Curves
  const metrics = {
    width,
    height,
    x,
    y,
    color: primaryColor,
    secondaryColor,
    time,
    energy,
    timbre: mergedTimbre,
    stereoBalance,
  };
  drawSpecularSilkVeils(context, metrics, semantic, reducedMotion);

  // 4. Semantic Scene Choreography
  if (semantic.scene === 'whisper') drawWhisper(context, semantic, metrics, reducedMotion);
  else if (semantic.scene === 'tease') drawTease(context, semantic, metrics, reducedMotion);
  else if (semantic.scene === 'contact') drawContact(context, semantic, metrics, reducedMotion);
  else if (semantic.scene === 'rhythm') drawRhythm(context, semantic, metrics, reducedMotion);
  else if (semantic.scene === 'surge') drawSurge(context, semantic, metrics, reducedMotion);
  else if (semantic.scene === 'afterglow') {
    drawAfterglow(context, semantic, metrics, reducedMotion);
  } else {
    // Seductive ambient breath shimmer + floating velvet embers
    const pearlColor = liftToSpecular(primaryColor, 0.72);
    const emberCount = 14;
    for (let index = 0; index < emberCount; index += 1) {
      const phase = ((time / (7600 + (index % 4) * 1400)) * motionScale + index * 0.19) % 1;
      const horizontalDrift = stereoBalance * width * 0.12 * Math.sin(phase * Math.PI);
      const px = width * (0.14 + ((index * 37) % 72) / 100) + horizontalDrift;
      const py = height * (0.76 - phase * 0.56) + Math.sin(phase * Math.PI * 2 + index) * height * 0.03;
      const fade = Math.sin(phase * Math.PI);
      const radius = 2.4 + (index % 3) * 1.4 + energy * 3.8;
      glow(
        context,
        px,
        py,
        radius * 2.6,
        index % 3 === 0 ? pearlColor : primaryColor,
        fade * (0.045 + breath * 0.035 + energy * 0.14),
      );
    }
  }
  context.restore();
}

export function createSpectrumRenderer({
  audio,
  leftAudio = audio,
  rightAudio = null,
  leftCanvas,
  atmosphereCanvas,
  centerCanvas,
  rightCanvas,
  onCharacterColors = () => {},
}) {
  let audioContext = null;
  let leftAnalyser = null;
  let rightAnalyser = null;
  let leftSecondaryAnalyser = null;
  let rightSecondaryAnalyser = null;
  let secondaryFrequencyData = new Uint8Array(128);
  let leftFrequencyData = new Uint8Array(128);
  let rightFrequencyData = new Uint8Array(128);
  let leftRoute = null;
  let rightRoute = null;
  let analysisSink = null;
  let animationFrame = 0;
  let sourcePlaying = { left: false, right: false };
  let paired = false;
  let listeningMode = 'binaural';
  let supported = true;
  let palette = [...DEFAULT_SPECTRUM_PALETTE];
  let leftPalette = [...DEFAULT_LEFT_PALETTE];
  let rightPalette = [...DEFAULT_RIGHT_PALETTE];
  let paletteRequest = 0;
  let visualReferenceImages = [];
  let visualReferenceRequestId = 0;
  let lastCharacterColorUpdate = 0;
  let semanticFrame = QUIET_SEMANTIC_FRAME;
  let dialogueFocus = { side: 'center', pan: 0, dominance: 0 };
  let previousLeftFrequencyData = new Uint8Array(128);
  let previousRightFrequencyData = new Uint8Array(128);

  // Smooth temporal state for liquid-silk audio reactivity
  const smoothedLeftBars = new Float32Array(BAR_COUNT);
  const smoothedRightBars = new Float32Array(BAR_COUNT);
  const motionState = {
    energy: 0,
    leftEnergy: 0,
    rightEnergy: 0,
    stereoBalance: 0,
    hasImagePalette: false,
    reducedMotion: false,
  };

  let reducedMotionQuery = null;
  const handleReducedMotionChange = (event) => {
    motionState.reducedMotion = Boolean(event?.matches);
  };
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      motionState.reducedMotion = Boolean(reducedMotionQuery?.matches);
      if (typeof reducedMotionQuery?.addEventListener === 'function') {
        reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
      }
    } catch {
      reducedMotionQuery = null;
    }
  }

  leftCanvas.hidden = true;
  rightCanvas.hidden = true;

  function makeAnalyser() {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.74;
    return analyser;
  }

  function createSourceRoute(mediaElement, pan) {
    const mediaSource = audioContext.createMediaElementSource(mediaElement);
    const splitter = audioContext.createChannelSplitter(2);
    const leftGain = audioContext.createGain();
    const rightGain = audioContext.createGain();
    const monoBus = audioContext.createGain();
    const monoOutput = audioContext.createGain();
    const directOutput = audioContext.createGain();
    const panner = audioContext.createStereoPanner();

    leftGain.gain.value = 0.5;
    rightGain.gain.value = 0.5;
    monoBus.channelCount = 1;
    monoBus.channelCountMode = 'explicit';
    monoOutput.channelCount = 1;
    monoOutput.channelCountMode = 'explicit';
    panner.pan.value = pan;

    mediaSource.connect(splitter);
    splitter.connect(leftGain, 0);
    splitter.connect(rightGain, 1);
    leftGain.connect(monoBus);
    rightGain.connect(monoBus);
    monoBus.connect(monoOutput);
    monoOutput.connect(panner);
    panner.connect(audioContext.destination);
    mediaSource.connect(directOutput);
    directOutput.connect(audioContext.destination);

    return {
      mediaSource,
      splitter,
      leftGain,
      rightGain,
      monoBus,
      monoOutput,
      directOutput,
      panner,
    };
  }

  function disconnectRoute(route) {
    if (!route) return;
    for (const node of Object.values(route)) {
      try {
        node.disconnect();
      } catch {
        // A node may already be disconnected during page shutdown.
      }
    }
  }

  function disconnectAnalysisInputs() {
    const inputs = [
      leftRoute?.splitter,
      rightRoute?.splitter,
      leftRoute?.monoBus,
      rightRoute?.monoBus,
    ];
    for (const input of inputs) {
      if (!input) continue;
      for (const analyser of [leftAnalyser, rightAnalyser, leftSecondaryAnalyser, rightSecondaryAnalyser]) {
        if (!analyser) continue;
        try {
          input.disconnect(analyser);
        } catch {
          // The requested connection may not exist yet.
        }
      }
    }
  }

  function connectAnalysisChannels() {
    if (!leftRoute || !leftAnalyser || !rightAnalyser) return;
    disconnectAnalysisInputs();
    const plan = getSpectrumChannelPlan(paired, listeningMode);
    const sourceNodes = {
      left: leftRoute.splitter,
      right: rightRoute?.splitter ?? leftRoute.splitter,
      leftMono: leftRoute.monoBus,
      rightMono: rightRoute?.monoBus ?? leftRoute.monoBus,
    };
    for (const [side, analysers] of [
      ['left', [leftAnalyser, leftSecondaryAnalyser]],
      ['right', [rightAnalyser, rightSecondaryAnalyser]],
    ]) {
      const channels = plan[side].channels ?? [plan[side].channel];
      channels.forEach((channel, index) => {
        sourceNodes[plan[side].source].connect(analysers[index], channel, 0);
      });
    }
  }

  function applyRoutingMode() {
    if (!leftRoute) return;
    const plan = getPlaybackRoutingPlan(paired, listeningMode);
    leftRoute.directOutput.gain.value = plan.left.mode === 'stereo' ? plan.left.gain : 0;
    leftRoute.monoOutput.gain.value = plan.left.mode === 'mono-downmix' ? 1 : 0;
    leftRoute.panner.pan.value = plan.left.pan;
    if (rightRoute) {
      rightRoute.directOutput.gain.value = plan.right?.mode === 'stereo' ? plan.right.gain : 0;
      rightRoute.monoOutput.gain.value = plan.right?.mode === 'mono-downmix' ? 1 : 0;
      rightRoute.panner.pan.value = plan.right?.pan ?? 1;
    }
  }

  async function ensureAudioGraph() {
    if (!supported) return false;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        supported = false;
        return false;
      }
      if (!audioContext) {
        audioContext = new AudioContextClass();
        leftAnalyser = makeAnalyser();
        rightAnalyser = makeAnalyser();
        leftSecondaryAnalyser = makeAnalyser();
        rightSecondaryAnalyser = makeAnalyser();
        leftFrequencyData = new Uint8Array(leftAnalyser.frequencyBinCount);
        rightFrequencyData = new Uint8Array(rightAnalyser.frequencyBinCount);
        secondaryFrequencyData = new Uint8Array(leftAnalyser.frequencyBinCount);
        analysisSink = audioContext.createGain();
        analysisSink.gain.value = 0;
        analysisSink.connect(audioContext.destination);
        leftAnalyser.connect(analysisSink);
        rightAnalyser.connect(analysisSink);
        leftSecondaryAnalyser.connect(analysisSink);
        rightSecondaryAnalyser.connect(analysisSink);

        leftRoute = createSourceRoute(leftAudio, -1);
        if (rightAudio) {
          rightRoute = createSourceRoute(rightAudio, 1);
        }
        applyRoutingMode();
        connectAnalysisChannels();
      }
      applyRoutingMode();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      return audioContext.state === 'running';
    } catch {
      supported = false;
      return false;
    }
  }

  function readFrequencyData(analyser, values, playing) {
    if (playing && analyser && audioContext?.state === 'running') {
      analyser.getByteFrequencyData(values);
    } else {
      values.fill(0);
    }
  }

  function draw(time = performance.now()) {
    const leftPlaying = sourcePlaying.left && !(paired && listeningMode === 'right-only');
    const rightPlaying = paired
      ? sourcePlaying.right && listeningMode !== 'left-only'
      : sourcePlaying.left;
    readFrequencyData(leftAnalyser, leftFrequencyData, leftPlaying);
    readFrequencyData(rightAnalyser, rightFrequencyData, rightPlaying);
    if (paired && listeningMode !== 'split') {
      // Merge frequency magnitudes, never audio samples: antiphase content stays visible.
      readFrequencyData(leftSecondaryAnalyser, secondaryFrequencyData, leftPlaying);
      leftFrequencyData.set(mergeSpectrumData(leftFrequencyData, secondaryFrequencyData));
      readFrequencyData(rightSecondaryAnalyser, secondaryFrequencyData, rightPlaying);
      rightFrequencyData.set(mergeSpectrumData(rightFrequencyData, secondaryFrequencyData));
    }

    const leftActive = leftPlaying && hasSpectrumEnergy(leftFrequencyData);
    const rightActive = rightPlaying && hasSpectrumEnergy(rightFrequencyData);
    const merged = mergeSpectrumData(leftFrequencyData, rightFrequencyData);
    const centerActive = (leftPlaying || rightPlaying)
      && hasSpectrumEnergy(merged);
    const centerColor = displayPaletteColorAt(palette, time, 10000);
    const secondaryColor = displayPaletteColorAt(palette, time + 3600, 10000);
    const leftColor = displayPaletteColorAt(leftPalette, time, 9000);
    const rightColor = displayPaletteColorAt(rightPalette, time, 9000);
    const leftTimbre = analyzeSpectrumTimbre(
      leftFrequencyData,
      previousLeftFrequencyData,
    );
    const rightTimbre = analyzeSpectrumTimbre(
      rightFrequencyData,
      previousRightFrequencyData,
    );

    const targetLeftEnergy = leftActive ? leftTimbre.energy : 0;
    const targetRightEnergy = rightActive ? rightTimbre.energy : 0;
    const targetEnergy = centerActive
      ? Math.max(leftTimbre.energy, rightTimbre.energy)
      : 0;
    const totalLR = targetLeftEnergy + targetRightEnergy;
    const targetBalance = totalLR > 0.015
      ? clamp((targetRightEnergy - targetLeftEnergy) / totalLR, -1, 1)
      : 0;

    motionState.leftEnergy = lerp(
      motionState.leftEnergy,
      targetLeftEnergy,
      targetLeftEnergy > motionState.leftEnergy ? 0.28 : 0.12,
    );
    motionState.rightEnergy = lerp(
      motionState.rightEnergy,
      targetRightEnergy,
      targetRightEnergy > motionState.rightEnergy ? 0.28 : 0.12,
    );
    motionState.energy = lerp(
      motionState.energy,
      targetEnergy,
      targetEnergy > motionState.energy ? 0.26 : 0.1,
    );
    motionState.stereoBalance = lerp(
      motionState.stereoBalance,
      targetBalance,
      0.14,
    );

    if (paired) {
      drawSide(
        leftCanvas,
        'left',
        leftColor,
        leftFrequencyData,
        leftActive,
        time,
        smoothedLeftBars,
        motionState.reducedMotion,
      );
      drawSide(
        rightCanvas,
        'right',
        rightColor,
        rightFrequencyData,
        rightActive,
        time,
        smoothedRightBars,
        motionState.reducedMotion,
      );
      if (time - lastCharacterColorUpdate >= 100) {
        lastCharacterColorUpdate = time;
        onCharacterColors({ left: leftColor, right: rightColor });
      }
    } else {
      const preparedLeft = prepareCanvas(leftCanvas);
      if (preparedLeft) {
        preparedLeft.context.clearRect(0, 0, preparedLeft.width, preparedLeft.height);
      }
      const preparedRight = prepareCanvas(rightCanvas);
      if (preparedRight) {
        preparedRight.context.clearRect(0, 0, preparedRight.width, preparedRight.height);
      }
    }
    drawSemanticAtmosphere(
      atmosphereCanvas,
      semanticFrame,
      leftTimbre,
      rightTimbre,
      paired,
      {
        center: centerColor,
        secondary: secondaryColor,
        left: leftColor,
        right: rightColor,
      },
      time,
      centerActive,
      visualReferenceImages,
      dialogueFocus,
      motionState,
    );
    drawRadial(
      centerCanvas,
      merged,
      centerActive,
      centerColor,
      time,
      semanticFrame,
      {
        low: Math.max(leftTimbre.low, rightTimbre.low),
        mid: Math.max(leftTimbre.mid, rightTimbre.mid),
        high: Math.max(leftTimbre.high, rightTimbre.high),
        air: Math.max(leftTimbre.air, rightTimbre.air),
        energy: motionState.energy,
        flux: Math.max(leftTimbre.flux, rightTimbre.flux),
      },
      {
        secondaryColor,
        stereoBalance: motionState.stereoBalance,
        reducedMotion: motionState.reducedMotion,
      },
    );
    previousLeftFrequencyData.set(leftFrequencyData);
    previousRightFrequencyData.set(rightFrequencyData);
    animationFrame = window.requestAnimationFrame(draw);
  }

  function setPlaying(nextPlaying) {
    sourcePlaying = {
      left: Boolean(nextPlaying),
      right: paired && Boolean(nextPlaying),
    };
  }

  function setSourcePlaying(nextPlaying) {
    sourcePlaying = {
      left: Boolean(nextPlaying.left),
      right: Boolean(nextPlaying.right),
    };
  }

  function setSemanticFrame(nextFrame) {
    semanticFrame = nextFrame && typeof nextFrame === 'object'
      ? nextFrame
      : QUIET_SEMANTIC_FRAME;
  }

  function setDialogueFocus(nextFocus) {
    dialogueFocus = nextFocus && typeof nextFocus === 'object'
      ? {
        side: nextFocus.side ?? 'center',
        pan: Math.max(-1, Math.min(1, Number(nextFocus.pan) || 0)),
        dominance: Math.max(-1, Math.min(1, Number(nextFocus.dominance) || 0)),
      }
      : { side: 'center', pan: 0, dominance: 0 };
  }

  function configure(options = {}) {
    paired = Boolean(options.paired);
    listeningMode = ['binaural', 'split', 'left-only', 'right-only'].includes(options.listeningMode)
      ? options.listeningMode
      : 'binaural';
    leftPalette = Array.isArray(options.leftPalette) && options.leftPalette.length
      ? options.leftPalette
      : [...DEFAULT_LEFT_PALETTE];
    rightPalette = Array.isArray(options.rightPalette) && options.rightPalette.length
      ? options.rightPalette
      : [...DEFAULT_RIGHT_PALETTE];
    leftCanvas.hidden = !paired;
    rightCanvas.hidden = !paired;
    applyRoutingMode();
    connectAnalysisChannels();
  }

  async function setPaletteFromImage(url) {
    const requestId = ++paletteRequest;
    if (!url) {
      palette = [...DEFAULT_SPECTRUM_PALETTE];
      motionState.hasImagePalette = false;
      return palette;
    }
    try {
      const image = new Image();
      if (/^https:/i.test(url)) image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.src = url;
      await image.decode();
      if (requestId !== paletteRequest) return palette;
      const sample = document.createElement('canvas');
      sample.width = 64;
      sample.height = 64;
      const context = sample.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, sample.width, sample.height);
      const imageData = context.getImageData(0, 0, sample.width, sample.height);
      palette = extractRepresentativeColors(imageData, 5);
      motionState.hasImagePalette = true;
    } catch {
      if (requestId === paletteRequest) {
        palette = [...DEFAULT_SPECTRUM_PALETTE];
        motionState.hasImagePalette = false;
      }
    }
    return palette;
  }

  async function setVisualReferences(urls) {
    const requestId = ++visualReferenceRequestId;
    if (!urls || urls.length === 0) {
      visualReferenceImages = [];
      return;
    }
    try {
      const loaded = await Promise.all(
        urls.map((url) => {
          const img = new Image();
          if (/^https:/i.test(url)) img.crossOrigin = 'anonymous';
          if ('decoding' in img) img.decoding = 'async';
          img.src = url;
          if (typeof img.decode === 'function') {
            return img.decode().then(() => img).catch(() => null);
          }
          return new Promise((resolve) => {
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
          });
        }),
      );
      if (requestId !== visualReferenceRequestId) return;
      visualReferenceImages = loaded.filter((img) => img !== null);
    } catch {
      if (requestId === visualReferenceRequestId) {
        visualReferenceImages = [];
      }
    }
  }

  function reset() {
    sourcePlaying = { left: false, right: false };
    leftFrequencyData.fill(0);
    rightFrequencyData.fill(0);
    previousLeftFrequencyData.fill(0);
    previousRightFrequencyData.fill(0);
    smoothedLeftBars.fill(0);
    smoothedRightBars.fill(0);
    motionState.energy = 0;
    motionState.leftEnergy = 0;
    motionState.rightEnergy = 0;
    motionState.stereoBalance = 0;
    semanticFrame = QUIET_SEMANTIC_FRAME;
    dialogueFocus = { side: 'center', pan: 0, dominance: 0 };
  }

  function destroy() {
    window.cancelAnimationFrame(animationFrame);
    if (reducedMotionQuery && typeof reducedMotionQuery.removeEventListener === 'function') {
      reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
    }
    disconnectAnalysisInputs();
    disconnectRoute(leftRoute);
    disconnectRoute(rightRoute);
    leftAnalyser?.disconnect();
    rightAnalyser?.disconnect();
    leftSecondaryAnalyser?.disconnect();
    rightSecondaryAnalyser?.disconnect();
    analysisSink?.disconnect();
    audioContext?.close();
  }

  draw();

  return {
    configure,
    destroy,
    ensureAudioGraph,
    reset,
    setDialogueFocus,
    setPaletteFromImage,
    setPlaying,
    setSemanticFrame,
    setSourcePlaying,
    setVisualReferences,
  };
}
