import { presentationToSource } from './alignment.mjs';

export function needsDriftCorrection(actual, target, tolerance = 0.08) {
  return Math.abs(actual - target) > tolerance + 1e-9;
}

export function createPresentationClock({
  now = () => performance.now(),
} = {}) {
  let duration = 0;
  let frozenTime = 0;
  let rate = 1;
  let playing = false;
  let startedAt = 0;
  let startedTime = 0;

  function currentTime() {
    if (!playing) return frozenTime;
    const elapsed = ((now() - startedAt) / 1000) * rate;
    return Math.min(duration, startedTime + elapsed);
  }

  function freeze() {
    frozenTime = currentTime();
    playing = false;
  }

  return {
    load(next) {
      duration = Math.max(0, Number(next.duration) || 0);
      frozenTime = Math.min(
        duration,
        Math.max(0, Number(next.currentTime) || 0),
      );
      rate = Math.max(0.25, Number(next.rate) || 1);
      playing = false;
    },
    play() {
      if (playing || frozenTime >= duration) return;
      startedAt = now();
      startedTime = frozenTime;
      playing = true;
    },
    pause: freeze,
    seek(time) {
      const wasPlaying = playing;
      frozenTime = Math.min(duration, Math.max(0, Number(time) || 0));
      playing = false;
      if (wasPlaying && frozenTime < duration) {
        startedAt = now();
        startedTime = frozenTime;
        playing = true;
      }
    },
    setRate(nextRate) {
      const wasPlaying = playing;
      freeze();
      rate = Math.max(0.25, Number(nextRate) || 1);
      if (wasPlaying && frozenTime < duration) {
        startedAt = now();
        startedTime = frozenTime;
        playing = true;
      }
    },
    currentTime,
    duration: () => duration,
    rate: () => rate,
    paused: () => !playing,
    ended: () => currentTime() >= duration,
  };
}

export function createPairedPlayer({
  leftAudio,
  rightAudio,
  onTime = () => {},
  onPlayState = () => {},
  onEnded = () => {},
  onError = () => {},
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  now,
  driftTolerance = 0.08,
}) {
  const clock = createPresentationClock({ now });
  let alignment = null;
  let hasRight = false;
  let frame = 0;
  let endedNotified = false;
  const playPending = new WeakMap();

  function pauseAudio(audio) {
    if (audio && !audio.paused) audio.pause();
  }

  function seekAudio(audio, target) {
    if (
      audio
      && Number.isFinite(audio.duration)
      && needsDriftCorrection(audio.currentTime, target, driftTolerance)
    ) {
      audio.currentTime = Math.min(audio.duration, Math.max(0, target));
    }
  }

  function startAudio(audio) {
    if (!audio || !audio.paused || playPending.get(audio)) return;
    const pending = audio.play()
      .catch((error) => onError(error))
      .finally(() => playPending.delete(audio));
    playPending.set(audio, pending);
  }

  function syncSide(audio, segments, presentationTime) {
    if (!audio || !segments?.length || !audio.getAttribute('src')) {
      pauseAudio(audio);
      return { sourceTime: 0, active: false, ended: true };
    }
    const desired = presentationToSource(segments, presentationTime);
    seekAudio(audio, desired.sourceTime);
    audio.playbackRate = clock.rate();
    if (!clock.paused() && desired.active && !desired.ended) {
      startAudio(audio);
    } else {
      pauseAudio(audio);
    }
    return desired;
  }

  function sync() {
    const presentationTime = clock.currentTime();
    const left = syncSide(
      leftAudio,
      alignment?.sides.left,
      presentationTime,
    );
    const right = hasRight
      ? syncSide(rightAudio, alignment?.sides.right, presentationTime)
      : { sourceTime: 0, active: false, ended: true };
    if (!hasRight) pauseAudio(rightAudio);
    onTime({
      currentTime: presentationTime,
      duration: clock.duration(),
      sources: { left, right },
    });
  }

  function tick() {
    sync();
    if (clock.ended()) {
      clock.pause();
      pauseAudio(leftAudio);
      pauseAudio(rightAudio);
      onPlayState(false);
      if (!endedNotified) {
        endedNotified = true;
        onEnded();
      }
      return;
    }
    if (!clock.paused()) frame = requestFrame(tick);
  }

  return {
    load({
      nextAlignment,
      currentTime = 0,
      rate = 1,
      volume = 1,
      rightEnabled = false,
    }) {
      cancelFrame(frame);
      pauseAudio(leftAudio);
      pauseAudio(rightAudio);
      alignment = nextAlignment;
      hasRight = rightEnabled;
      endedNotified = false;
      clock.load({
        duration: alignment?.duration ?? 0,
        currentTime,
        rate,
      });
      leftAudio.volume = volume;
      rightAudio.volume = volume;
      leftAudio.playbackRate = rate;
      rightAudio.playbackRate = rate;
      sync();
    },
    play() {
      if (!alignment || clock.ended()) return;
      clock.play();
      endedNotified = false;
      onPlayState(true);
      sync();
      cancelFrame(frame);
      frame = requestFrame(tick);
    },
    pause() {
      clock.pause();
      cancelFrame(frame);
      sync();
      onPlayState(false);
    },
    seek(time) {
      clock.seek(time);
      sync();
    },
    setRate(rate) {
      clock.setRate(rate);
      leftAudio.playbackRate = clock.rate();
      rightAudio.playbackRate = clock.rate();
      sync();
    },
    setVolume(volume) {
      const normalized = Math.min(1, Math.max(0, Number(volume) || 0));
      leftAudio.volume = normalized;
      rightAudio.volume = normalized;
    },
    currentTime: clock.currentTime,
    duration: clock.duration,
    paused: clock.paused,
    sync,
    destroy() {
      cancelFrame(frame);
      pauseAudio(leftAudio);
      pauseAudio(rightAudio);
    },
  };
}
