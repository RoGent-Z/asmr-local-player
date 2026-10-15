import { chunkAudio } from './audio-chunks.mjs';
import { SafeApiError, validateApiConfig, transcribeChunk, translateCues } from './ai-client.mjs';

const MAX_BATCH_CUES = 25;
const MAX_BATCH_CHARACTERS = 8000;
const FINGERPRINT_BLOCK_BYTES = 1024 * 1024;
const blobFingerprints = new WeakMap();
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const fail = (code, message) => { throw new SafeApiError(code, message); };
function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED', '任务已取消；已经发送的请求仍可能产生服务商费用。');
}

async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprintBlob(blob, signal) {
  if (blobFingerprints.has(blob)) return blobFingerprints.get(blob);
  // Read every byte with bounded memory. Sampling just the file ends can reuse
  // transcripts for a different recording with identical name, size and tags.
  let chain = new Uint8Array(32);
  for (let offset = 0; offset < blob.size; offset += FINGERPRINT_BLOCK_BYTES) {
    checkAbort(signal);
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + FINGERPRINT_BLOCK_BYTES)).arrayBuffer());
    const input = new Uint8Array(chain.length + bytes.length);
    input.set(chain);
    input.set(bytes, chain.length);
    chain = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  }
  checkAbort(signal);
  const result = `${blob.size}:${Array.from(chain, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  blobFingerprints.set(blob, result);
  return result;
}

function cleanCue(cue, fallbackId, code) {
  if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start ||
      typeof cue.text !== 'string' || !cue.text.trim() ||
      (cue.speaker !== undefined && typeof cue.speaker !== 'string') ||
      (cue.translation !== undefined && (typeof cue.translation !== 'string' || !cue.translation.trim()))) {
    fail(code, '字幕数据或任务状态无效，请检查逐段原文和起止时间。');
  }
  return { id: String(cue.id ?? fallbackId), start: cue.start, end: cue.end, text: cue.text,
    ...(cue.speaker ? { speaker: cue.speaker } : {}),
    ...(cue.translation !== undefined ? { translation: cue.translation } : {}) };
}

function validateSources(sources, mode) {
  if (!Array.isArray(sources) || !sources.length || !['audio', 'subtitles'].includes(mode)) fail('INVALID_JOB_INPUT', '请选择有效的音频或字幕来源。');
  const ids = new Set();
  return sources.map((source, index) => {
    if (!source || typeof source.id !== 'string' || !source.id || ids.has(source.id)) fail('INVALID_JOB_INPUT', '音频来源 ID 无效或重复。');
    ids.add(source.id);
    if (mode === 'audio' && (!source.blob || typeof source.blob.slice !== 'function' || !Number.isFinite(source.blob.size) || source.blob.size <= 0)) fail('INVALID_JOB_INPUT', '没有可读取的音频文件。');
    if (mode === 'subtitles' && !Array.isArray(source.cues)) fail('INVALID_JOB_INPUT', '当前来源没有有效字幕。');
    const cues = mode === 'subtitles' ? source.cues.map((cue, cueIndex) => {
      const clean = cleanCue(cue, `s${index}-q${cueIndex}`, 'INVALID_JOB_INPUT');
      // A new job always translates its input under the current settings.
      delete clean.translation;
      return clean;
    }) : [];
    if (new Set(cues.map((cue) => cue.id)).size !== cues.length) fail('INVALID_JOB_INPUT', '同一来源内的字幕 ID 不能重复。');
    return { id: source.id, label: typeof source.label === 'string' ? source.label : '',
      side: ['left', 'right', 'center'].includes(source.side) ? source.side : 'center',
      name: typeof source.name === 'string' ? source.name : '', blob: source.blob, cues };
  });
}

function loadCheckpoint(checkpoint, fingerprint, inputs, settings) {
  if (checkpoint.version !== 1 || checkpoint.fingerprint !== fingerprint) fail('CHECKPOINT_MISMATCH', '输入或生成设置已经改变，不能复用旧任务。请开始新任务；更换 Key 后可以继续原任务。');
  if (!Array.isArray(checkpoint.sources) || checkpoint.sources.length !== inputs.length) fail('INVALID_CHECKPOINT', '恢复数据缺少音频来源，请重新开始任务。');
  const sources = checkpoint.sources.map((source, index) => {
    const input = inputs[index];
    if (!source || source.id !== input.id || !Array.isArray(source.cues) || !Array.isArray(source.chunks) || !Array.isArray(source.translationBatches) ||
        typeof source.asrComplete !== 'boolean' || typeof source.translationComplete !== 'boolean') fail('INVALID_CHECKPOINT', '恢复数据结构无效，请重新开始任务。');
    const cues = source.cues.map((cue, cueIndex) => cleanCue(cue, `s${index}-q${cueIndex}`, 'INVALID_CHECKPOINT'));
    const cueById = new Map(cues.map((cue) => [cue.id, cue]));
    if (cueById.size !== cues.length) fail('INVALID_CHECKPOINT', '恢复数据包含重复字幕 ID。');
    const chunks = source.chunks.map((chunk, chunkIndex) => {
      if (!chunk || chunk.index !== chunkIndex || !Number.isFinite(chunk.start) || chunk.start < 0 ||
          !Number.isFinite(chunk.duration) || chunk.duration <= 0 || !Number.isFinite(chunk.ownedStart) ||
          chunk.ownedStart < chunk.start || chunk.ownedStart >= chunk.start + chunk.duration ||
          !Array.isArray(chunk.cueIds) || chunk.cueIds.some((id) => !cueById.has(id))) fail('INVALID_CHECKPOINT', '恢复数据中的音频分片记录无效。');
      return { index: chunk.index, start: chunk.start, duration: chunk.duration, ownedStart: chunk.ownedStart, cueIds: [...chunk.cueIds] };
    });
    const translated = new Set();
    const translationBatches = source.translationBatches.map((batch) => {
      if (!batch || !Array.isArray(batch.ids) || !batch.ids.length || batch.ids.length > MAX_BATCH_CUES ||
          new Set(batch.ids).size !== batch.ids.length ||
          batch.ids.some((id) => !cueById.get(id)?.translation || translated.has(id))) fail('INVALID_CHECKPOINT', '恢复数据中的翻译批次无效。');
      for (const id of batch.ids) translated.add(id);
      return { ids: [...batch.ids] };
    });
    if (cues.some((cue) => Boolean(cue.translation) !== translated.has(cue.id)) ||
        (source.translationComplete && (!source.asrComplete || translated.size !== cues.length)) ||
        (settings.mode === 'audio' && ((source.asrComplete && !chunks.length) ||
          cues.some((cue) => !chunks.some((chunk) => chunk.cueIds.includes(cue.id))))) ||
        (settings.mode === 'subtitles' && (!source.asrComplete || chunks.length ||
          JSON.stringify(cues.map(({ translation, ...cue }) => cue)) !== JSON.stringify(input.cues)))) fail('INVALID_CHECKPOINT', '恢复数据中的完成状态不一致。');
    return { id: input.id, label: input.label, side: input.side, name: input.name, cues, chunks,
      asrComplete: source.asrComplete, translationBatches, translationComplete: source.translationComplete };
  });
  // Select allowed fields rather than copying unknown properties from imports.
  return { version: 1, fingerprint, status: 'running', ...settings,
    createdAt: typeof checkpoint.createdAt === 'string' ? checkpoint.createdAt : now(), updatedAt: now(), sources };
}

function batchesFor(cues) {
  const batches = [];
  let current = [];
  let count = 0;
  for (const cue of cues) {
    if (cue.text.length > MAX_BATCH_CHARACTERS) fail('CUE_TOO_LONG', '单条字幕超过 8000 字符，请先拆分该条字幕再翻译。');
    if (current.length && (current.length === MAX_BATCH_CUES || count + cue.text.length > MAX_BATCH_CHARACTERS)) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(cue);
    count += cue.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function appendChunkCues(source, cues, chunk, sourceIndex) {
  const ids = [];
  const end = chunk.start + chunk.duration;
  const boundary = chunk.ownedStart ?? chunk.start;
  // Validate the entire response before mutating saved cues. A rejected chunk
  // must leave previously acknowledged chunks intact for safe resumption.
  if (cues.some((cue) => chunk.start + cue.start >= end + 0.5 || chunk.start + cue.end > end + 2)) {
    fail('INVALID_ASR_RESPONSE', '识别时间戳超出当前音频分片，请检查语音模型的时间戳能力。');
  }
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const startTime = chunk.start + cue.start;
    const endTime = Math.min(end, chunk.start + cue.end);
    if (endTime <= startTime) continue;
    // Merge only a repeated cue touching the leading overlap of this source.
    // Equal text elsewhere, from another speaker or another file stays intact.
    const duplicate = startTime < boundary ? source.cues.findLast((existing) =>
      existing.text === cue.text && existing.speaker === cue.speaker && existing.end >= startTime && existing.start < endTime) : undefined;
    if (duplicate) {
      duplicate.end = Math.max(duplicate.end, endTime);
      ids.push(duplicate.id);
      continue;
    }
    const id = `s${sourceIndex}-c${chunk.index}-q${index}`;
    // A distinct cue heard only in the context overlap can repair an omission
    // in the previous request. Preserve its true time instead of dropping it.
    source.cues.push({ id, start: startTime, end: endTime, text: cue.text,
      ...(cue.speaker ? { speaker: cue.speaker } : {}) });
    ids.push(id);
  }
  return ids;
}

/** Run or resume only the explicitly selected sources. No keys or blobs enter state. */
export async function runSpeechJob({ sources, asrConfig, translationConfig, sourceLanguage = 'auto', targetLanguage = '简体中文', glossary = '',
  mode = 'audio', responseFormat = 'verbose_json', signal, checkpoint, onProgress = () => {}, onCheckpoint = () => {},
  chunkAudioImpl = chunkAudio, fetchImpl = globalThis.fetch } = {}) {
  checkAbort(signal);
  const inputs = validateSources(sources, mode);
  const translation = validateApiConfig(translationConfig);
  const asr = mode === 'audio' ? validateApiConfig(asrConfig) : null;
  if (typeof targetLanguage !== 'string' || !targetLanguage.trim() || typeof sourceLanguage !== 'string' || typeof glossary !== 'string') fail('INVALID_JOB_INPUT', '语言或术语设置无效。');
  if (!['verbose_json', 'diarized_json'].includes(responseFormat)) fail('INVALID_JOB_INPUT', '请选择支持时间戳的识别响应格式。');
  const settings = { mode, sourceLanguage, targetLanguage: targetLanguage.trim() };
  onProgress({ stage: 'preparing', sourceCount: inputs.length, sourceIndex: 0, chunksCompleted: 0, batchesCompleted: 0, cuesCompleted: 0 });
  const identity = [];
  for (const input of inputs) {
    identity.push({ id: input.id, label: input.label, side: input.side, name: input.name,
      content: mode === 'audio' ? await fingerprintBlob(input.blob, signal) : input.cues });
  }
  checkAbort(signal);
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify({ version: 1, ...settings, glossary, responseFormat,
    asr: asr && { endpoint: asr.endpoint, model: asr.model }, translation: { endpoint: translation.endpoint, model: translation.model }, sources: identity })));
  const state = checkpoint ? loadCheckpoint(checkpoint, fingerprint, inputs, settings) : {
    version: 1, fingerprint, status: 'running', ...settings, createdAt: now(), updatedAt: now(),
    sources: inputs.map(({ id, label, side, name, cues }) => ({ id, label, side, name, cues: clone(cues), chunks: [],
      asrComplete: mode === 'subtitles', translationBatches: [], translationComplete: false })),
  };
  let stage = 'preparing';
  let sourceIndex = 0;
  function report(persist = false) {
    state.updatedAt = now();
    state.progress = { stage, sourceId: state.sources[sourceIndex]?.id ?? '', sourceIndex, sourceCount: state.sources.length,
      chunksCompleted: state.sources.reduce((sum, source) => sum + source.chunks.length, 0),
      batchesCompleted: state.sources.reduce((sum, source) => sum + source.translationBatches.length, 0),
      cuesCompleted: state.sources.reduce((sum, source) => sum + source.cues.filter((cue) => cue.translation !== undefined).length, 0) };
    onProgress(clone(state.progress));
    if (persist) onCheckpoint(clone(state));
  }
  try {
    report(true);
    for (sourceIndex = 0; sourceIndex < inputs.length; sourceIndex += 1) {
      checkAbort(signal);
      const input = inputs[sourceIndex];
      const source = state.sources[sourceIndex];
      if (!source.asrComplete) {
        stage = 'transcribing';
        report();
        let seen = 0;
        for await (const chunk of chunkAudioImpl(input.blob, { name: input.name, signal })) {
          checkAbort(signal);
          const ownedStart = chunk.ownedStart ?? chunk.start;
          if (chunk.index !== seen || !Number.isFinite(chunk.start) || chunk.start < 0 || !Number.isFinite(chunk.duration) || chunk.duration <= 0 ||
              !Number.isFinite(ownedStart) || ownedStart < chunk.start || ownedStart >= chunk.start + chunk.duration) fail('INVALID_AUDIO_CHUNK', '音频分片时间或顺序无效。');
          seen += 1;
          const saved = source.chunks[chunk.index];
          if (saved) {
            if (saved.start !== chunk.start || saved.duration !== chunk.duration || saved.ownedStart !== ownedStart) fail('CHECKPOINT_MISMATCH', '音频分片规则已经改变，请开始新任务。');
            continue;
          }
          const cues = await transcribeChunk({ config: asr, chunk, language: sourceLanguage, responseFormat, signal, fetchImpl });
          const cueIds = appendChunkCues(source, cues, chunk, sourceIndex);
          source.chunks.push({ index: chunk.index, start: chunk.start, duration: chunk.duration, ownedStart, cueIds });
          report(true);
        }
        if (!seen || seen < source.chunks.length) fail('INVALID_AUDIO_CHUNK', '音频未生成有效分片，或分片数量与已保存任务不一致。');
        source.cues.sort((left, right) => left.start - right.start || left.end - right.end);
        source.asrComplete = true;
        report(true);
      }
    }
    // Finish recognition for every selected source before starting translation.
    for (sourceIndex = 0; sourceIndex < inputs.length; sourceIndex += 1) {
      const source = state.sources[sourceIndex];
      checkAbort(signal);
      stage = 'translating';
      report();
      for (const batch of batchesFor(source.cues)) {
        const remaining = batch.filter((cue) => cue.translation === undefined);
        if (!remaining.length) continue;
        checkAbort(signal);
        const firstIndex = source.cues.indexOf(remaining[0]);
        const lastIndex = source.cues.indexOf(remaining.at(-1));
        const contextCue = ({ text, speaker, translation }) => ({ text: text.slice(0, 1000),
          ...(speaker ? { speaker } : {}), ...(translation ? { translation: translation.slice(0, 1000) } : {}) });
        const context = { source: { label: source.label, side: source.side },
          before: source.cues.slice(Math.max(0, firstIndex - 2), firstIndex).map(contextCue),
          after: source.cues.slice(lastIndex + 1, lastIndex + 3).map(contextCue) };
        const translated = await translateCues({ config: translation, cues: remaining, targetLanguage, glossary, context, signal, fetchImpl });
        const mapping = new Map(translated.map((item) => [item.id, item.text]));
        for (const cue of remaining) cue.translation = mapping.get(cue.id);
        source.translationBatches.push({ ids: remaining.map((cue) => cue.id) });
        report(true);
      }
      source.translationComplete = true;
      report(true);
    }
    checkAbort(signal);
    sourceIndex = Math.max(0, inputs.length - 1);
    state.status = 'complete';
    stage = 'complete';
    report(true);
    return clone(state);
  } catch (error) {
    const safe = error instanceof SafeApiError ? error : error?.name === 'AbortError' || signal?.aborted ?
      new SafeApiError('ABORTED', '任务已取消；已经发送的请求仍可能产生服务商费用。') :
      new SafeApiError('AUDIO_PROCESSING_ERROR', '本机音频或任务处理失败，请检查文件是否为有效 MP3 或 PCM WAV，再尝试续做。');
    state.status = safe.code === 'ABORTED' ? 'cancelled' : 'failed';
    state.error = { code: safe.code, message: safe.message };
    stage = state.status;
    report(true);
    throw safe;
  }
}
