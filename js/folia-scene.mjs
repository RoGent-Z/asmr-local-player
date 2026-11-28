import { buildFoliaSceneFrame } from './folia-scene-model.mjs?v=0.1.8-velvet';

const MAX_PIXELS = 2500000;
const MAX_DPR = 1.5;
const DEG = Math.PI / 180;
const rgb = (channels, alpha = 1) => `rgba(${channels}, ${alpha})`;
const dimension = (value) => Number.isFinite(value) ? Math.min(32768, Math.max(1, value)) : 1;

function cueRefs(value, limit) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (let index = 0; index < value.length && refs.length < limit; index += 1) {
    const item = value[index];
    if (item && typeof item.text === 'string' && item.text.trim()) refs.push(item);
  }
  return refs;
}

const sameRefs = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

function polygon(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.closePath();
}

function drawAuroraOrb(context, cx, cy, rx, ry, angle, stops) {
  context.save();
  context.translate(cx, cy);
  context.rotate(angle);
  context.scale(rx, ry);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.fillRect(-1, -1, 2, 2);
  context.restore();
}

function drawScene(context, frame, width, height, ratioX, ratioY, motionTime = 0) {
  const { palette, camera } = frame;
  const glow = palette.glow || palette.accent;
  const diag = Math.hypot(width, height);
  const t = Number.isFinite(motionTime) ? motionTime : 0;
  context.setTransform(ratioX, 0, 0, ratioY, 0, 0);
  context.clearRect(0, 0, width, height);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  if (frame.hasBackground) {
    context.fillStyle = rgb(palette.background, 0.24);
    context.fillRect(0, 0, width, height);
  } else {
    const background = context.createLinearGradient(0, 0, width * 0.85, height);
    background.addColorStop(0, rgb(palette.deep));
    background.addColorStop(0.42, rgb(palette.background));
    background.addColorStop(0.78, 'rgb(7, 3, 12)');
    background.addColorStop(1, 'rgb(4, 2, 8)');
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }

  context.save();
  context.translate(width / 2 + camera.x, height / 2 + camera.y);
  context.rotate(camera.rotate * DEG);
  context.scale(camera.scale, camera.scale);
  context.translate(-width / 2, -height / 2);

  // Deterministic 5-orb anisotropic Velvet Fluid Aurora (AMLL / BetterLyrics inspired, zero checkerboard).
  context.globalCompositeOperation = 'screen';
  const k = frame.hasBackground ? 0.54 : 1;
  const breath = Math.max(0, Math.min(1, (camera.scale - 1.018) / 0.022));

  // 1. Upper-Left Accent Silk Cloud
  drawAuroraOrb(
    context,
    width * (0.24 + 0.11 * Math.sin(t * 0.043)),
    height * (0.22 + 0.09 * Math.cos(t * 0.031)),
    diag * 0.52,
    diag * 0.33,
    0.35 + 0.2 * Math.sin(t * 0.025),
    [
      [0, rgb(glow, 0.26 * k)],
      [0.35, rgb(palette.accent, 0.14 * k)],
      [0.68, rgb(palette.deep, 0.05 * k)],
      [1, rgb(palette.accent, 0)],
    ],
  );

  // 2. Lower-Right Crimson/Echo Counter-Bloom
  drawAuroraOrb(
    context,
    width * (0.78 + 0.10 * Math.cos(t * 0.037)),
    height * (0.78 + 0.08 * Math.sin(t * 0.041)),
    diag * 0.48,
    diag * 0.32,
    -0.42 + 0.18 * Math.cos(t * 0.022),
    [
      [0, rgb(palette.accent, 0.22 * k)],
      [0.35, rgb(palette.echo, 0.11 * k)],
      [0.68, rgb(palette.deep, 0.04 * k)],
      [1, rgb(palette.accent, 0)],
    ],
  );

  // 3. Sweeping Horizon Silk Ribbon
  drawAuroraOrb(
    context,
    width * (0.52 + 0.16 * Math.sin(t * 0.029 + 1.2)),
    height * (0.44 + 0.10 * Math.cos(t * 0.023)),
    diag * 0.58,
    diag * 0.20,
    -0.18 + 0.14 * Math.sin(t * 0.019 + 0.6),
    [
      [0, rgb(palette.echo, 0.13 * k)],
      [0.35, rgb(palette.light, 0.06 * k)],
      [0.68, rgb(palette.accent, 0.025 * k)],
      [1, rgb(palette.accent, 0)],
    ],
  );

  // 4. Deep Velvet Plum/Abyssal Cloud
  drawAuroraOrb(
    context,
    width * (0.18 + 0.12 * Math.cos(t * 0.021 + 2.4)),
    height * (0.76 + 0.09 * Math.sin(t * 0.033)),
    diag * 0.44,
    diag * 0.30,
    0.28 + 0.16 * Math.sin(t * 0.027),
    [
      [0, rgb(palette.deep, 0.38 * k)],
      [0.35, rgb(palette.accent, 0.09 * k)],
      [0.68, rgb(palette.deep, 0.03 * k)],
      [1, rgb(palette.deep, 0)],
    ],
  );

  // 5. Subtle Center Candlelight Breath responding gently to cue focus
  drawAuroraOrb(
    context,
    width * 0.50 + camera.x * 0.35,
    height * 0.48 + camera.y * 0.35,
    diag * (0.36 + breath * 0.03),
    diag * (0.24 + breath * 0.02),
    0.08 * Math.sin(t * 0.03),
    [
      [0, rgb(glow, (0.11 + breath * 0.04) * k)],
      [0.35, rgb(palette.accent, (0.045 + breath * 0.02) * k)],
      [0.68, rgb(palette.deep, 0.015 * k)],
      [1, rgb(palette.accent, 0)],
    ],
  );

  // Soft velvet light curtains (gossamer, non-geometric).
  for (const shaft of frame.shafts) {
    const angle = shaft.angle * DEG;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const endX = shaft.x + cos * shaft.length;
    const endY = shaft.y + sin * shaft.length;
    const normalX = -sin * shaft.width * 0.61;
    const normalY = cos * shaft.width * 0.61;
    const softAlpha = shaft.alpha * 0.55;

    const veil = context.createLinearGradient(shaft.x, shaft.y, endX, endY);
    veil.addColorStop(0, rgb(glow, 0));
    veil.addColorStop(0.16, rgb(palette.light, softAlpha * 1.05));
    veil.addColorStop(0.48, rgb(glow, softAlpha * 0.55));
    veil.addColorStop(0.78, rgb(palette.accent, softAlpha * 0.22));
    veil.addColorStop(1, rgb(palette.accent, 0));
    polygon(context, [
      { x: shaft.x, y: shaft.y },
      { x: endX + normalX, y: endY + normalY },
      { x: endX - normalX, y: endY - normalY },
    ]);
    context.fillStyle = veil;
    context.fill();

    const coreEndX = shaft.x + cos * shaft.length * 0.86;
    const coreEndY = shaft.y + sin * shaft.length * 0.86;
    const coreNormalX = normalX * 0.38;
    const coreNormalY = normalY * 0.38;
    const coreAlpha = shaft.alpha * 0.45;
    const core = context.createLinearGradient(shaft.x, shaft.y, coreEndX, coreEndY);
    core.addColorStop(0, rgb(palette.star, 0));
    core.addColorStop(0.18, rgb(palette.star, coreAlpha * 0.78));
    core.addColorStop(0.54, rgb(palette.light, coreAlpha * 0.3));
    core.addColorStop(1, rgb(glow, 0));
    polygon(context, [
      { x: shaft.x, y: shaft.y },
      { x: coreEndX + coreNormalX, y: coreEndY + coreNormalY },
      { x: coreEndX - coreNormalX, y: coreEndY - coreNormalY },
    ]);
    context.fillStyle = core;
    context.fill();
  }

  // Whispered poetic echoes behind lyrics.
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  for (const echo of frame.echoes) {
    context.save();
    context.translate(echo.x, echo.y);
    context.rotate(echo.rotate * DEG);
    context.font = `500 ${echo.fontSize}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif CJK JP", "Songti SC", serif`;
    context.strokeStyle = rgb(palette.accent, echo.alpha * 0.18);
    context.lineWidth = echo.lineWidth * 2.2;
    if (echo.layout === 'vertical') {
      for (let index = 0; index < echo.glyphs.length; index += 1) context.strokeText(echo.glyphs[index], 0, index * echo.fontSize * 0.94);
    } else {
      context.strokeText(echo.text, 0, 0);
    }
    context.strokeStyle = rgb(palette.echo, echo.alpha * 0.52);
    context.lineWidth = echo.lineWidth;
    if (echo.layout === 'vertical') {
      for (let index = 0; index < echo.glyphs.length; index += 1) context.strokeText(echo.glyphs[index], 0, index * echo.fontSize * 0.94);
    } else {
      context.strokeText(echo.text, 0, 0);
    }
    context.restore();
  }

  // Soft layered bokeh embers + warm dust motes.
  for (const mote of frame.motes) {
    context.beginPath();
    context.arc(mote.x, mote.y, mote.radius * 3.8, 0, Math.PI * 2);
    context.fillStyle = rgb(glow, mote.alpha * 0.13);
    context.fill();

    context.beginPath();
    context.arc(mote.x, mote.y, mote.radius * 2.1, 0, Math.PI * 2);
    context.fillStyle = rgb(palette.dust, mote.alpha * 0.24);
    context.fill();

    context.beginPath();
    context.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
    context.fillStyle = rgb(palette.dust, Math.min(1, mote.alpha * 0.92));
    context.fill();
  }

  // Understated burnished foil 4-point diamond starlight glints.
  for (const star of frame.stars) {
    const starAlpha = star.alpha * 0.78;
    context.save();
    context.translate(star.x, star.y);
    context.rotate(star.rotate * DEG);

    context.beginPath();
    context.arc(0, 0, star.radius * 2.4, 0, Math.PI * 2);
    context.fillStyle = rgb(glow, starAlpha * 0.13);
    context.fill();

    context.beginPath();
    context.arc(0, 0, star.radius * 1.2, 0, Math.PI * 2);
    context.fillStyle = rgb(palette.star, starAlpha * 0.22);
    context.fill();

    const rx = star.radius * 1.12;
    const ry = star.radius * 1.68;
    const pinch = star.radius * 0.15;
    polygon(context, [
      { x: 0, y: -ry },
      { x: pinch, y: -pinch },
      { x: rx, y: 0 },
      { x: pinch, y: pinch },
      { x: 0, y: ry },
      { x: -pinch, y: pinch },
      { x: -rx, y: 0 },
      { x: -pinch, y: -pinch },
    ]);
    context.fillStyle = rgb(palette.star, starAlpha * 0.84);
    context.fill();

    context.strokeStyle = rgb(palette.star, Math.min(1, starAlpha * 1.02));
    context.lineWidth = 0.72;
    context.beginPath();
    context.moveTo(-rx * 1.05, 0);
    context.lineTo(rx * 1.05, 0);
    context.moveTo(0, -ry * 1.05);
    context.lineTo(0, ry * 1.05);
    context.stroke();

    context.strokeStyle = rgb(glow, starAlpha * 0.44);
    context.lineWidth = 0.55;
    context.beginPath();
    context.moveTo(-star.radius * 0.44, -star.radius * 0.44);
    context.lineTo(star.radius * 0.44, star.radius * 0.44);
    context.moveTo(star.radius * 0.44, -star.radius * 0.44);
    context.lineTo(-star.radius * 0.44, star.radius * 0.44);
    context.stroke();

    context.beginPath();
    context.arc(0, 0, Math.max(0.85, star.radius * 0.22), 0, Math.PI * 2);
    context.fillStyle = rgb(palette.star, Math.min(1, starAlpha * 1.2));
    context.fill();

    context.restore();
  }
  context.restore();
  context.globalCompositeOperation = 'source-over';

  const vignette = context.createRadialGradient(
    width * 0.5, height * 0.46, Math.min(width, height) * 0.14,
    width * 0.5, height * 0.5, diag * 0.64,
  );
  vignette.addColorStop(0, 'rgba(5, 2, 9, 0)');
  vignette.addColorStop(0.46, 'rgba(5, 2, 9, 0.07)');
  vignette.addColorStop(0.78, rgb(palette.background, frame.hasBackground ? 0.38 : 0.46));
  vignette.addColorStop(1, 'rgba(5, 2, 9, 0.84)');
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

/**
 * Caller-driven Canvas layer. It creates no animation loop, media or requests.
 * A context failure disables only decoration; callers retain the DOM subtitle.
 * render returns the frame it drew so DOM motion can share camera values.
 */
export function createFoliaScene({ canvas, getPixelRatio = () => 1 } = {}) {
  let context = null;
  // Explicit false keeps Chromium from changing raster backends after diagnostic
  // getImageData calls; an omitted hint can switch GPU gradients to CPU mid-scene.
  try { context = canvas?.getContext?.('2d', { alpha: true, willReadFrequently: false }) || null; } catch { /* CSS fallback */ }
  let alive = Boolean(context);
  let logicalWidth = 1;
  let logicalHeight = 1;
  let ratioX = 1;
  let ratioY = 1;
  let lastFrame = null;
  let lastInput = null;
  const invalidate = () => { lastFrame = null; lastInput = null; };

  const clear = () => {
    invalidate();
    if (!alive) return;
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    } catch { alive = false; }
  };

  return {
    get available() { return alive; },
    resize(width, height) {
      invalidate();
      if (!alive) return;
      logicalWidth = dimension(width);
      logicalHeight = dimension(height);
      let requestedRatio = 1;
      try { requestedRatio = getPixelRatio(); } catch { /* use one CSS pixel */ }
      if (!Number.isFinite(requestedRatio) || requestedRatio <= 0) requestedRatio = 1;
      const ratio = Math.min(MAX_DPR, requestedRatio, Math.sqrt(MAX_PIXELS / (logicalWidth * logicalHeight)));
      const backingWidth = Math.max(1, Math.floor(logicalWidth * ratio));
      const backingHeight = Math.max(1, Math.floor(logicalHeight * ratio));
      try {
        if (canvas.width !== backingWidth) canvas.width = backingWidth;
        if (canvas.height !== backingHeight) canvas.height = backingHeight;
        ratioX = backingWidth / logicalWidth;
        ratioY = backingHeight / logicalHeight;
      } catch { alive = false; }
    },
    render(input = {}) {
      if (!alive) return null;
      try {
        const current = {
          time: Number.isFinite(input?.time) && input.time >= 0 ? input.time : 0,
          reducedMotion: input?.reducedMotion === true,
          palette: input?.palette,
          hasBackground: input?.hasBackground === true,
          playbackRate: Number.isFinite(input?.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1,
          active: cueRefs(input?.active, 3),
          before: cueRefs(input?.before, 2),
          after: cueRefs(input?.after, 3),
        };
        const delta = current.time - (lastInput?.time ?? -Infinity);
        // Convert the 30 Hz wall-time budget to media seconds at the current
        // playback rate, without adding a scheduler or an animation clock.
        // Explicit/paused/backwards seeks always reconstruct their exact time.
        if (input?.playing === true && input?.force !== true && lastFrame && delta >= 0 && delta < current.playbackRate / 30
          && current.playbackRate === lastInput.playbackRate
          && current.reducedMotion === lastInput.reducedMotion
          && current.palette === lastInput.palette && current.hasBackground === lastInput.hasBackground
          && sameRefs(current.active, lastInput.active)
          && sameRefs(current.before, lastInput.before)
          && sameRefs(current.after, lastInput.after)) return lastFrame;
        const motionTime = current.reducedMotion ? 0 : current.time % 3600;
        const frame = buildFoliaSceneFrame({ ...input, width: logicalWidth, height: logicalHeight });
        drawScene(context, frame, logicalWidth, logicalHeight, ratioX, ratioY, motionTime);
        lastFrame = frame;
        lastInput = current;
        return frame;
      } catch {
        // A lost/rejected context must never become a playback error.
        clear();
        alive = false;
        return null;
      }
    },
    clear,
    destroy() {
      clear();
      alive = false;
      context = null;
    },
  };
}
