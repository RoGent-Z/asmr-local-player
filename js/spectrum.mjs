import {
  analyzeSpectrumTimbre,
  DEFAULT_SPECTRUM_PALETTE,
  displayPaletteColorAt,
  extractRepresentativeColors,
  getPlaybackRoutingPlan,
  getSpectrumChannelPlan,
  hasSpectrumEnergy,
  mergeSpectrumData,
} from './spectrum-data.mjs';

const IDLE_LEVEL = 0.08;
const ACTIVE_FLOOR = 0.12;
const BAR_COUNT = 30;
const RADIAL_BAR_COUNT = 108;
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

function prepareCanvas(canvas) {
  if (!canvas) return null;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawSide(canvas, side, color, values, active) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);

  const gap = 7;
  const barHeight = Math.max(2, (height - gap * (BAR_COUNT - 1)) / BAR_COUNT);
  const maxLength = Math.max(12, width * 0.84);
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
    context.roundRect(x, y, length, barHeight, barHeight / 2);
    context.fill();
  }

  context.globalAlpha = 1;
  context.shadowBlur = 0;
}

function drawRadial(canvas, values, active, color, time, semantic, timbre) {
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
  const baseRadius = size * (
    0.255
    + (semantic?.intimacy ?? 0) * 0.018
    + (timbre?.low ?? 0) * 0.018
  );
  const maxLength = size * (
    0.115
    + intensity * 0.045
    + (timbre?.high ?? 0) * 0.025
  );
  const breathSpeed = scene === 'whisper' || scene === 'afterglow'
    ? 2350
    : scene === 'rhythm' || scene === 'surge' ? 920 : 1800;
  const breath = 0.5 + Math.sin(time / breathSpeed) * 0.5;
  const idleLength = size * (0.018 + breath * 0.008);
  const rotation = (time / 28000) * (0.25 + motion * 1.5);

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
        + (timbre?.flux ?? 0) * 0.22
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

  context.shadowBlur = 0;
  context.globalAlpha = active ? 0.18 : 0.09 + breath * 0.04;
  context.lineWidth = 1;
  context.beginPath();
  context.arc(centerX, centerY, baseRadius - 4, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = 1;
}

function colorWithAlpha(color, alpha) {
  const channels = String(color).match(/\d+/g)?.slice(0, 3) ?? [255, 120, 168];
  return `rgba(${channels.join(',')},${Math.min(1, Math.max(0, alpha))})`;
}

function glow(
  context,
  x,
  y,
  radius,
  color,
  alpha,
) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, colorWithAlpha(color, alpha));
  gradient.addColorStop(0.46, colorWithAlpha(color, alpha * 0.38));
  gradient.addColorStop(1, colorWithAlpha(color, 0));
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function drawWhisper(context, frame, metrics) {
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
  context.lineCap = 'round';
  context.lineWidth = 1 + timbre.air * 2;
  context.strokeStyle = colorWithAlpha(color, 0.08 + frame.breath * 0.2);
  for (let index = 0; index < 9; index += 1) {
    const phase = time / 2300 + index * 0.72;
    const spread = width * (0.08 + frame.intimacy * 0.08);
    const startX = x + Math.sin(phase) * spread * 0.25;
    const startY = y + (index - 4) * height * 0.026;
    context.beginPath();
    context.moveTo(startX, startY);
    context.bezierCurveTo(
      startX + Math.cos(phase) * spread,
      startY - height * 0.05,
      startX - Math.sin(phase * 0.7) * spread,
      startY + height * 0.08,
      startX + Math.cos(phase * 0.5) * spread * 1.4,
      startY + height * 0.01,
    );
    context.stroke();
  }
  for (let index = 0; index < 22; index += 1) {
    const phase = time / 3100 + index * 1.73;
    const radius = 0.8 + ((index * 7) % 5) * 0.34 + energy * 1.8;
    context.fillStyle = colorWithAlpha(color, 0.08 + timbre.air * 0.18);
    context.beginPath();
    context.arc(
      x + Math.cos(phase) * width * (0.04 + (index % 6) * 0.014),
      y + Math.sin(phase * 0.63) * height * 0.16,
      radius,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

function drawTease(context, frame, metrics) {
  const { width, height, x, y, color, time, energy, timbre } = metrics;
  context.strokeStyle = colorWithAlpha(color, 0.12 + frame.tension * 0.16);
  context.lineWidth = 1.1 + timbre.centroid * 1.5;
  for (let index = 0; index < 4; index += 1) {
    const radiusX = width * (0.08 + index * 0.035);
    const radiusY = height * (0.05 + index * 0.022);
    context.save();
    context.translate(x, y);
    context.rotate(Math.sin(time / 3200 + index) * 0.36);
    context.beginPath();
    context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    const phase = time / (900 - Math.min(400, frame.dominance * 350))
      + index * 1.55;
    context.fillStyle = colorWithAlpha(color, 0.24 + energy * 0.28);
    context.beginPath();
    context.arc(
      x + Math.cos(phase) * radiusX,
      y + Math.sin(phase) * radiusY,
      2.1 + index * 0.55,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

function drawContact(context, frame, metrics) {
  const { width, height, x, y, color, time, energy, timbre } = metrics;
  const cycle = (time / 2100) % 1;
  for (let index = 0; index < 5; index += 1) {
    const progress = (cycle + index / 5) % 1;
    const radius = Math.min(width, height) * (
      0.035 + progress * (0.17 + frame.intimacy * 0.08)
    );
    context.strokeStyle = colorWithAlpha(
      color,
      (1 - progress) * (0.06 + frame.intimacy * 0.16 + energy * 0.12),
    );
    context.lineWidth = 0.8 + timbre.mid * 2.8;
    context.beginPath();
    context.ellipse(
      x,
      y,
      radius * 1.18,
      radius * (0.72 + timbre.low * 0.24),
      Math.sin(time / 4600) * 0.18,
      0,
      Math.PI * 2,
    );
    context.stroke();
  }
}

function drawRhythm(context, frame, metrics) {
  const { width, height, x, y, color, time, energy, timbre } = metrics;
  const speed = 760 - frame.motion * 320;
  context.lineCap = 'round';
  for (let layer = 0; layer < 4; layer += 1) {
    context.strokeStyle = colorWithAlpha(
      color,
      0.07 + frame.motion * 0.08 + energy * 0.11,
    );
    context.lineWidth = 1 + layer * 0.42 + timbre.low * 1.6;
    context.beginPath();
    for (let step = 0; step <= 42; step += 1) {
      const progress = step / 42;
      const pointX = width * progress;
      const envelope = Math.sin(progress * Math.PI);
      const pointY = y
        + Math.sin(
          progress * Math.PI * (4 + layer)
          + time / speed
          + layer,
        ) * height * (0.025 + frame.motion * 0.035) * envelope;
      if (step === 0) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
    }
    context.stroke();
  }
  const pulse = (time / speed) % 1;
  context.strokeStyle = colorWithAlpha(color, (1 - pulse) * 0.28);
  context.lineWidth = 1.4 + energy * 3;
  context.beginPath();
  context.arc(
    x,
    y,
    Math.min(width, height) * (0.05 + pulse * 0.19),
    0,
    Math.PI * 2,
  );
  context.stroke();
}

function drawSurge(context, frame, metrics) {
  const { width, height, x, y, color, time, energy, timbre } = metrics;
  const radius = Math.min(width, height) * (0.13 + frame.climax * 0.16);
  context.lineCap = 'round';
  context.strokeStyle = colorWithAlpha(
    color,
    0.12 + frame.climax * 0.18 + energy * 0.16,
  );
  context.lineWidth = 1 + timbre.high * 2.4;
  for (let index = 0; index < 44; index += 1) {
    const angle = index / 44 * Math.PI * 2 + time / 2100;
    const jitter = 0.72 + Math.sin(time / 180 + index * 2.31) * 0.18;
    const inner = radius * (0.5 + timbre.low * 0.18);
    const outer = radius * (
      0.9 + jitter * (0.35 + frame.intensity * 0.55)
    );
    context.beginPath();
    context.moveTo(
      x + Math.cos(angle) * inner,
      y + Math.sin(angle) * inner,
    );
    context.lineTo(
      x + Math.cos(angle) * outer,
      y + Math.sin(angle) * outer,
    );
    context.stroke();
  }
  glow(
    context,
    x,
    y,
    Math.min(width, height) * (0.16 + frame.climax * 0.12),
    color,
    0.08 + frame.climax * 0.1,
  );
}

function drawAfterglow(context, frame, metrics) {
  const { width, height, x, y, color, time, timbre } = metrics;
  glow(
    context,
    x,
    y + height * 0.06,
    Math.min(width, height) * (0.22 + frame.tenderness * 0.08),
    color,
    0.08 + frame.tenderness * 0.08,
  );
  for (let index = 0; index < 26; index += 1) {
    const phase = (time / 9000 + index * 0.071) % 1;
    const drift = Math.sin(time / 2800 + index) * width * 0.018;
    context.fillStyle = colorWithAlpha(
      color,
      (1 - phase) * (0.03 + frame.tenderness * 0.08),
    );
    context.beginPath();
    context.arc(
      x + drift + ((index % 7) - 3) * width * 0.018,
      y - height * 0.04 + phase * height * 0.22,
      1 + timbre.air * 2.1,
      0,
      Math.PI * 2,
    );
    context.fill();
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
) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);

  const mergedTimbre = {
    low: Math.max(leftTimbre.low, rightTimbre.low),
    mid: Math.max(leftTimbre.mid, rightTimbre.mid),
    high: Math.max(leftTimbre.high, rightTimbre.high),
    air: Math.max(leftTimbre.air, rightTimbre.air),
    energy: Math.max(leftTimbre.energy, rightTimbre.energy),
    centroid: Math.max(leftTimbre.centroid, rightTimbre.centroid),
    flux: Math.max(leftTimbre.flux, rightTimbre.flux),
  };
  const energy = active ? mergedTimbre.energy : 0;
  const semanticSide = frame?.side ?? 'center';
  const focusSide = focus?.side ?? 'center';
  const side = focusSide !== 'center' ? focusSide : semanticSide;
  const focusPan = Number(focus?.pan) || 0;
  const sideBias = side === 'left'
    ? -0.16
    : side === 'right' ? 0.16 : 0;
  const x = width * Math.min(
    0.72,
    Math.max(0.28, 0.5 + sideBias + focusPan * 0.14),
  );
  const y = height * 0.47;
  const color = side === 'left'
    ? colors.left
    : side === 'right' ? colors.right : colors.center;
  const semantic = frame ?? QUIET_SEMANTIC_FRAME;
  const baseAlpha = 0.025
    + semantic.intensity * 0.045
    + energy * 0.055;

  context.save();
  context.globalCompositeOperation = 'lighter';
  glow(
    context,
    x,
    y,
    Math.min(width, height) * (
      0.24 + semantic.intimacy * 0.08 + mergedTimbre.low * 0.05
    ),
    color,
    baseAlpha,
  );
  if (!paired && side !== 'center') {
    const edgeX = side === 'left' ? width * 0.13 : width * 0.87;
    glow(
      context,
      edgeX,
      height * 0.5,
      Math.min(width, height) * (
        0.18 + Math.abs(focusPan) * 0.16 + semantic.breath * 0.05
      ),
      color,
      0.025 + Math.abs(focusPan) * 0.055 + energy * 0.035,
    );
  }
  if (paired) {
    glow(
      context,
      width * 0.18,
      height * 0.48,
      Math.min(width, height) * (0.2 + leftTimbre.low * 0.08),
      colors.left,
      0.025 + leftTimbre.energy * 0.06,
    );
    glow(
      context,
      width * 0.82,
      height * 0.48,
      Math.min(width, height) * (0.2 + rightTimbre.low * 0.08),
      colors.right,
      0.025 + rightTimbre.energy * 0.06,
    );
  }

  const metrics = {
    width,
    height,
    x,
    y,
    color,
    time,
    energy,
    timbre: mergedTimbre,
  };
  if (semantic.scene === 'whisper') drawWhisper(context, semantic, metrics);
  else if (semantic.scene === 'tease') drawTease(context, semantic, metrics);
  else if (semantic.scene === 'contact') drawContact(context, semantic, metrics);
  else if (semantic.scene === 'rhythm') drawRhythm(context, semantic, metrics);
  else if (semantic.scene === 'surge') drawSurge(context, semantic, metrics);
  else if (semantic.scene === 'afterglow') {
    drawAfterglow(context, semantic, metrics);
  } else {
    const breath = 0.5 + Math.sin(time / 3400) * 0.5;
    glow(
      context,
      x,
      y,
      Math.min(width, height) * (0.14 + breath * 0.055),
      color,
      0.025 + breath * 0.025 + energy * 0.035,
    );
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
  let leftPalette = ['#ff78a8'];
  let rightPalette = ['#78d7ff'];
  let paletteRequest = 0;
  let visualReferenceImages = [];
  let visualReferenceRequestId = 0;
  let lastCharacterColorUpdate = 0;
  let semanticFrame = QUIET_SEMANTIC_FRAME;
  let dialogueFocus = { side: 'center', pan: 0, dominance: 0 };
  let previousLeftFrequencyData = new Uint8Array(128);
  let previousRightFrequencyData = new Uint8Array(128);

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

    if (paired) {
      drawSide(leftCanvas, 'left', leftColor, leftFrequencyData, leftActive);
      drawSide(rightCanvas, 'right', rightColor, rightFrequencyData, rightActive);
      if (time - lastCharacterColorUpdate >= 100) {
        lastCharacterColorUpdate = time;
        onCharacterColors({ left: leftColor, right: rightColor });
      }
    } else {
      prepareCanvas(leftCanvas)?.context.clearRect(
        0,
        0,
        leftCanvas.getBoundingClientRect().width,
        leftCanvas.getBoundingClientRect().height,
      );
      prepareCanvas(rightCanvas)?.context.clearRect(
        0,
        0,
        rightCanvas.getBoundingClientRect().width,
        rightCanvas.getBoundingClientRect().height,
      );
    }
    drawSemanticAtmosphere(
      atmosphereCanvas,
      semanticFrame,
      leftTimbre,
      rightTimbre,
      paired,
      { center: centerColor, left: leftColor, right: rightColor },
      time,
      centerActive,
      visualReferenceImages,
      dialogueFocus,
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
        high: Math.max(leftTimbre.high, rightTimbre.high),
        flux: Math.max(leftTimbre.flux, rightTimbre.flux),
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
      : ['#ff78a8'];
    rightPalette = Array.isArray(options.rightPalette) && options.rightPalette.length
      ? options.rightPalette
      : ['#78d7ff'];
    leftCanvas.hidden = !paired;
    rightCanvas.hidden = !paired;
    applyRoutingMode();
    connectAnalysisChannels();
  }

  async function setPaletteFromImage(url) {
    const requestId = ++paletteRequest;
    if (!url) {
      palette = [...DEFAULT_SPECTRUM_PALETTE];
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
    } catch {
      if (requestId === paletteRequest) {
        palette = [...DEFAULT_SPECTRUM_PALETTE];
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
    semanticFrame = QUIET_SEMANTIC_FRAME;
    dialogueFocus = { side: 'center', pan: 0, dominance: 0 };
  }

  function destroy() {
    window.cancelAnimationFrame(animationFrame);
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
