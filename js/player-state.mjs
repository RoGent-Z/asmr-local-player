const DEFAULT_STATE = Object.freeze({
  trackId: null,
  currentTime: 0,
  volume: 1,
  rate: 1,
});

function storageKey(workId) {
  return `asmr-player:v1:${workId}`;
}

function finiteOr(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeState(value = {}) {
  return {
    trackId: typeof value.trackId === 'string' ? value.trackId : null,
    currentTime: Math.max(0, finiteOr(value.currentTime, 0)),
    volume: Math.min(1, Math.max(0, finiteOr(value.volume, 1))),
    rate: Math.min(2, Math.max(0.5, finiteOr(value.rate, 1))),
  };
}

export function loadWorkState(storage, workId) {
  try {
    const raw = storage.getItem(storageKey(workId));
    return raw ? normalizeState(JSON.parse(raw)) : { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveWorkState(storage, workId, state) {
  storage.setItem(storageKey(workId), JSON.stringify(normalizeState(state)));
}

export function resumeTime(duration, savedTime) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const time = Math.max(0, finiteOr(savedTime, 0));
  return duration - time <= 15 ? 0 : Math.min(time, duration);
}

export function findAdjacentTrack(works, workIndex, trackIndex, direction) {
  const positions = [];
  works.forEach((work, currentWorkIndex) => {
    work.tracks.forEach((track, currentTrackIndex) => {
      positions.push({
        workIndex: currentWorkIndex,
        trackIndex: currentTrackIndex,
      });
    });
  });

  const current = positions.findIndex(
    (position) => position.workIndex === workIndex && position.trackIndex === trackIndex,
  );
  if (current === -1) return null;
  return positions[current + Math.sign(direction)] ?? null;
}
