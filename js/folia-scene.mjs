import { buildFoliaSceneFrame } from './folia-scene-model.mjs';

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

function drawScene(context, frame, width, height, ratioX, ratioY) {
  const { palette, camera } = frame;
  context.setTransform(ratioX, 0, 0, ratioY, 0, 0);
  context.clearRect(0, 0, width, height);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  const background = context.createLinearGradient(0, 0, width * 0.8, height);
  background.addColorStop(0, rgb(palette.deep));
  background.addColorStop(0.62, rgb(palette.background));
  background.addColorStop(1, 'rgb(1, 11, 13)');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const haze = context.createRadialGradient(width * 0.24, height * 0.16, 0, width * 0.32, height * 0.28, Math.hypot(width, height) * 0.72);
  haze.addColorStop(0, rgb(palette.accent, 0.21));
  haze.addColorStop(0.38, rgb(palette.accent, 0.06));
  haze.addColorStop(1, rgb(palette.accent, 0));
  context.fillStyle = haze;
  context.fillRect(0, 0, width, height);

  context.save();
  context.translate(width / 2 + camera.x, height / 2 + camera.y);
  context.rotate(camera.rotate * DEG);
  context.scale(camera.scale, camera.scale);
  context.translate(-width / 2, -height / 2);

  for (const tile of frame.grid) {
    polygon(context, tile.points);
    context.fillStyle = rgb(palette.grid, tile.alpha);
    context.fill();
    context.strokeStyle = rgb(palette.light, tile.alpha * 0.32);
    context.lineWidth = 0.65;
    context.stroke();
  }

  context.globalCompositeOperation = 'screen';
  for (const shaft of frame.shafts) {
    const angle = shaft.angle * DEG;
    const endX = shaft.x + Math.cos(angle) * shaft.length;
    const endY = shaft.y + Math.sin(angle) * shaft.length;
    const normalX = -Math.sin(angle) * shaft.width / 2;
    const normalY = Math.cos(angle) * shaft.width / 2;
    const gradient = context.createLinearGradient(shaft.x, shaft.y, endX, endY);
    gradient.addColorStop(0, rgb(palette.light, 0));
    gradient.addColorStop(0.16, rgb(palette.light, shaft.alpha));
    gradient.addColorStop(0.58, rgb(palette.accent, shaft.alpha * 0.45));
    gradient.addColorStop(1, rgb(palette.accent, 0));
    polygon(context, [
      { x: shaft.x, y: shaft.y },
      { x: endX + normalX, y: endY + normalY },
      { x: endX - normalX, y: endY - normalY },
    ]);
    context.fillStyle = gradient;
    context.fill();
  }

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  for (const echo of frame.echoes) {
    context.save();
    context.translate(echo.x, echo.y);
    context.rotate(echo.rotate * DEG);
    context.font = `500 ${echo.fontSize}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif CJK JP", "Songti SC", serif`;
    context.strokeStyle = rgb(palette.echo, echo.alpha);
    context.lineWidth = echo.lineWidth;
    if (echo.layout === 'vertical') {
      for (let index = 0; index < echo.glyphs.length; index += 1) context.strokeText(echo.glyphs[index], 0, index * echo.fontSize * 0.94);
    } else {
      context.strokeText(echo.text, 0, 0);
    }
    context.restore();
  }

  for (const mote of frame.motes) {
    context.beginPath();
    context.arc(mote.x, mote.y, mote.radius, 0, Math.PI * 2);
    context.fillStyle = rgb(palette.dust, mote.alpha);
    context.fill();
  }
  for (const star of frame.stars) {
    context.save();
    context.translate(star.x, star.y);
    context.rotate(star.rotate * DEG);
    context.strokeStyle = rgb(palette.star, star.alpha);
    context.lineWidth = 0.8;
    context.beginPath();
    context.moveTo(-star.radius, 0);
    context.lineTo(star.radius, 0);
    context.moveTo(0, -star.radius * 1.45);
    context.lineTo(0, star.radius * 1.45);
    context.stroke();
    context.strokeStyle = rgb(palette.star, star.alpha * 0.42);
    context.beginPath();
    context.moveTo(-star.radius * 0.45, -star.radius * 0.45);
    context.lineTo(star.radius * 0.45, star.radius * 0.45);
    context.moveTo(star.radius * 0.45, -star.radius * 0.45);
    context.lineTo(-star.radius * 0.45, star.radius * 0.45);
    context.stroke();
    context.restore();
  }
  context.restore();
  context.globalCompositeOperation = 'source-over';

  const vignette = context.createRadialGradient(width * 0.49, height * 0.45, Math.min(width, height) * 0.12, width * 0.5, height * 0.5, Math.hypot(width, height) * 0.64);
  vignette.addColorStop(0, 'rgba(0, 5, 7, 0)');
  vignette.addColorStop(0.55, 'rgba(0, 5, 7, 0.06)');
  vignette.addColorStop(1, 'rgba(0, 5, 7, 0.72)');
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
          && sameRefs(current.active, lastInput.active)
          && sameRefs(current.before, lastInput.before)
          && sameRefs(current.after, lastInput.after)) return lastFrame;
        const frame = buildFoliaSceneFrame({ ...input, width: logicalWidth, height: logicalHeight });
        drawScene(context, frame, logicalWidth, logicalHeight, ratioX, ratioY);
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
