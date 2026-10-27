// Audio is never decoded here. Local payloads remain Blob slices; remote payloads
// are fetched one bounded chunk at a time.
const READ_BYTES = 64 * 1024;
const PREROLL_SECONDS = 0.75;
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const WAVE_GUID_TAIL = [0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('音频分片已取消。', 'AbortError');
}
function textAt(bytes, offset, count) {
  return String.fromCharCode(...bytes.subarray(offset, offset + count));
}
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function putText(bytes, offset, value) {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}
function chunkResult(blob, extension, index, start, end, ownedStart = start) {
  return { blob, filename: `audio-${String(index + 1).padStart(4, '0')}.${extension}`, start, duration: end - start, index, ownedStart, ownedEnd: end };
}

async function audioSlice(blob, start, end, type, signal) {
  checkAbort(signal);
  const part = blob.slice(start, end, type);
  if (part instanceof Blob) return part;
  // Remote Range sources expose a lazy slice, not a BlobPart. Read only this
  // bounded chunk before wrapping it; Blob([part]) would stringify the object.
  const bytes = await part.arrayBuffer();
  checkAbort(signal);
  if (bytes.byteLength !== end - start) throw new Error('音频分段不完整。');
  return new Blob([bytes], { type });
}

function makeReader(blob, signal, onScanProgress) {
  let lastBytes = 0;
  let lastSeconds = 0;
  return {
    async read(offset, length) {
      checkAbort(signal);
      if (length > READ_BYTES || offset < 0 || length < 0 || offset + length > blob.size) {
        throw new Error('音频数据损坏：文件边界或数据长度无效。');
      }
      let buffer;
      try { buffer = await blob.slice(offset, offset + length).arrayBuffer(); }
      catch { checkAbort(signal); throw new Error('无法读取本地音频，请重新选择文件后重试。'); }
      checkAbort(signal);
      if (buffer.byteLength !== length) throw new Error('音频文件损坏或读取不完整。');
      return new Uint8Array(buffer);
    },
    progress(bytesRead, seconds) {
      checkAbort(signal);
      lastBytes = Math.max(lastBytes, Math.min(blob.size, bytesRead));
      lastSeconds = Math.max(lastSeconds, seconds);
      onScanProgress?.({ bytesRead: lastBytes, totalBytes: blob.size, seconds: lastSeconds });
      checkAbort(signal);
    },
  };
}

function parseWaveFormat(fmt) {
  if (fmt.length < 16) throw new Error('WAV 格式块损坏。');
  const v = viewOf(fmt);
  let format = v.getUint16(0, true);
  const channels = v.getUint16(2, true);
  const sampleRate = v.getUint32(4, true);
  const byteRate = v.getUint32(8, true);
  const blockAlign = v.getUint16(12, true);
  const bits = v.getUint16(14, true);
  if (format === 0xfffe) {
    if (fmt.length < 40 || v.getUint16(16, true) < 22 || v.getUint16(16, true) + 18 > fmt.length
      || !WAVE_GUID_TAIL.every((value, i) => fmt[25 + i] === value)
      || v.getUint16(18, true) > bits) throw new Error('WAV 扩展格式不受支持或格式块损坏。');
    format = fmt[24];
  }
  if (![1, 3].includes(format)) throw new Error('WAV 只支持未压缩 PCM 或 IEEE 浮点音频，请先转换格式。');
  if (!channels || !sampleRate || !blockAlign || ![8, 16, 24, 32, 64].includes(bits)
    || (format === 3 && ![32, 64].includes(bits)) || (format === 1 && bits === 64)
    || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) {
    throw new Error('WAV 采样参数或采样块长度损坏。');
  }
  return { format, sampleRate, blockAlign };
}

function waveHeader(fmt, format, dataBytes, frameCount) {
  const fmtPadding = fmt.length % 2;
  const factSize = format === 3 ? 12 : 0;
  const bytes = new Uint8Array(12 + 8 + fmt.length + fmtPadding + factSize + 8);
  const v = viewOf(bytes);
  putText(bytes, 0, 'RIFF'); v.setUint32(4, bytes.length + dataBytes + dataBytes % 2 - 8, true);
  putText(bytes, 8, 'WAVE'); putText(bytes, 12, 'fmt '); v.setUint32(16, fmt.length, true); bytes.set(fmt, 20);
  let at = 20 + fmt.length + fmtPadding;
  if (factSize) {
    putText(bytes, at, 'fact'); v.setUint32(at + 4, 4, true); v.setUint32(at + 8, frameCount, true); at += 12;
  }
  putText(bytes, at, 'data'); v.setUint32(at + 4, dataBytes, true);
  return bytes;
}

async function* chunkWave(blob, reader, options, first) {
  const { chunkSeconds, maxBytes, signal } = options;
  const riffEnd = viewOf(first).getUint32(4, true) + 8;
  if (riffEnd < 12 || riffEnd > blob.size) throw new Error('WAV 文件损坏：RIFF 长度超出文件。');
  let at = 12;
  let fmt;
  let data;
  while (at + 8 <= riffEnd) {
    const header = await reader.read(at, 8);
    const id = textAt(header, 0, 4);
    const size = viewOf(header).getUint32(4, true);
    const next = at + 8 + size + size % 2;
    if (next > riffEnd) throw new Error('WAV 文件损坏：数据块不完整。');
    if (id === 'fmt ') {
      if (fmt || size > READ_BYTES) throw new Error('WAV 格式块损坏或过大。');
      fmt = await reader.read(at + 8, size);
    } else if (id === 'data') {
      if (data) throw new Error('暂不支持包含多个 data 块的 WAV 音频。');
      data = { start: at + 8, size };
    }
    at = next;
  }
  if (!fmt || !data || !data.size || at !== riffEnd) throw new Error('WAV 文件损坏：缺少有效格式或音频数据。');
  const { format, sampleRate, blockAlign } = parseWaveFormat(fmt);
  if (data.size % blockAlign) throw new Error('WAV 文件损坏：音频数据未对齐完整采样块。');
  const overhead = waveHeader(fmt, format, 0, 0).length;
  let framesPerChunk = Math.min(Math.floor(chunkSeconds * sampleRate), Math.floor((maxBytes - overhead) / blockAlign));
  if (overhead + framesPerChunk * blockAlign + (framesPerChunk * blockAlign) % 2 > maxBytes) framesPerChunk--;
  if (framesPerChunk < 1) throw new Error('分片上限太小，无法容纳 WAV 文件头和一个完整采样块。');
  const totalFrames = data.size / blockAlign;
  let index = 0;
  for (let sample = 0; sample < totalFrames;) {
    checkAbort(signal);
    const count = Math.min(framesPerChunk, totalFrames - sample);
    const size = count * blockAlign;
    const offset = data.start + sample * blockAlign;
    const header = waveHeader(fmt, format, size, count);
    const part = await audioSlice(blob, offset, offset + size, 'audio/wav', signal);
    const payload = new Blob([header, part, new Uint8Array(size % 2)], { type: 'audio/wav' });
    const end = (sample + count) / sampleRate;
    reader.progress(offset + size, end);
    yield chunkResult(payload, 'wav', index++, sample / sampleRate, end);
    sample += count;
  }
  reader.progress(blob.size, totalFrames / sampleRate);
}

function parseMp3Header(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[1] >>> 3) & 3;
  const layer = (bytes[1] >>> 1) & 3;
  const bitrateIndex = bytes[2] >>> 4;
  const rateIndex = (bytes[2] >>> 2) & 3;
  if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3 || (bytes[3] & 3) === 2) return null;
  const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex] * 1000;
  return {
    version, sampleRate, samples: version === 3 ? 1152 : 576,
    size: Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((bytes[2] >>> 1) & 1),
  };
}

function isMp3IndexFrame(frame, info) {
  const mono = (frame[3] >>> 6) === 3;
  const xingOffset = 4 + (info.version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
  const marker = textAt(frame, xingOffset, 4);
  const v = viewOf(frame);
  if (['Xing', 'Info'].includes(marker) && frame.length >= xingOffset + 12) {
    const flags = v.getUint32(xingOffset + 4, false);
    return !(flags & ~15) && !!(flags & 3);
  }
  return frame.length >= 54 && textAt(frame, 36, 4) === 'VBRI' && v.getUint16(40, false) === 1;
}

async function mp3Bounds(blob, reader) {
  let start = 0;
  let end = blob.size;
  // Skip complete ID3v2 tags, including the optional v2.4 footer. Never load tag payloads.
  while (start + 10 <= end) {
    const header = await reader.read(start, 10);
    if (textAt(header, 0, 3) !== 'ID3') break;
    if (![2, 3, 4].includes(header[3]) || header.subarray(6, 10).some((b) => b & 0x80)) throw new Error('MP3 的 ID3 标签损坏。');
    const size = header[6] * 0x200000 + header[7] * 0x4000 + header[8] * 0x80 + header[9];
    start += 10 + size + (header[3] === 4 && (header[5] & 0x10) ? 10 : 0);
    if (start > end) throw new Error('MP3 的 ID3 标签长度超出文件。');
  }
  // Both common tail orders are accepted. APE size excludes its optional header.
  while (end > start) {
    if (end - start >= 128 && textAt(await reader.read(end - 128, 3), 0, 3) === 'TAG') { end -= 128; continue; }
    if (end - start >= 32) {
      const footer = await reader.read(end - 32, 32);
      if (textAt(footer, 0, 8) === 'APETAGEX') {
        const v = viewOf(footer);
        const version = v.getUint32(8, true);
        const size = v.getUint32(12, true);
        const flags = v.getUint32(20, true);
        if (![1000, 2000].includes(version) || size < 32 || size > end - start || (flags & 0x20000000)) throw new Error('MP3 的 APE 标签损坏。');
        end -= size;
        if (flags & 0x80000000) {
          if (end - start < 32 || textAt(await reader.read(end - 32, 8), 0, 8) !== 'APETAGEX') throw new Error('MP3 的 APE 标签头不完整。');
          end -= 32;
        }
        continue;
      }
    }
    break;
  }
  if (end - start < 4) throw new Error('MP3 文件中没有完整音频帧。');
  return { start, end };
}

async function* chunkMp3(blob, reader, { chunkSeconds, maxBytes, signal }) {
  const bounds = await mp3Bounds(blob, reader);
  let cache = new Uint8Array(0);
  let cacheStart = -1;
  let at = bounds.start;
  let totalSamples = 0;
  let streamFormat;
  let chunkStart;
  let chunkEnd;
  let ownedStart = 0;
  let index = 0;
  let recent = [];
  const preroll = Math.min(PREROLL_SECONDS, chunkSeconds / 2);
  async function output() {
    const payload = await audioSlice(blob, chunkStart.offset, chunkEnd.endOffset, 'audio/mpeg', signal);
    return chunkResult(payload, 'mp3', index++, chunkStart.time, chunkEnd.endTime, ownedStart);
  }
  while (at < bounds.end) {
    checkAbort(signal);
    if (at + 4 > bounds.end) throw new Error('MP3 文件损坏：尾部音频帧不完整。');
    if (at < cacheStart || at + 4 > cacheStart + cache.length) {
      cache = await reader.read(at, Math.min(READ_BYTES, bounds.end - at)); cacheStart = at;
      reader.progress(at, streamFormat ? totalSamples / streamFormat.sampleRate : 0);
      // Yield the event loop even when Blob reads are immediately fulfilled, so Cancel stays usable.
      await new Promise((resolve) => setTimeout(resolve, 0)); checkAbort(signal);
    }
    const info = parseMp3Header(cache.subarray(at - cacheStart, at - cacheStart + 4));
    if (!info || at + info.size > bounds.end) throw new Error('MP3 文件损坏或不受支持：需要完整的 MPEG Layer III 音频帧。');
    if (at === bounds.start && isMp3IndexFrame(await reader.read(at, info.size), info)) {
      // Xing/Info/VBRI describe the whole file; their silent header frame is not audio.
      // Removing it also keeps decoders from applying an original-file duration to a chunk.
      at += info.size;
      continue;
    }
    if (streamFormat && (streamFormat.version !== info.version || streamFormat.sampleRate !== info.sampleRate)) throw new Error('暂不支持采样率或 MPEG 版本中途变化的 MP3 音频。');
    streamFormat ??= info;
    const frame = { offset: at, endOffset: at + info.size, time: totalSamples / info.sampleRate, endTime: (totalSamples + info.samples) / info.sampleRate };
    if (info.size > maxBytes || info.samples / info.sampleRate > chunkSeconds + 1e-10) throw new Error('分片上限太小，无法容纳一个完整 MP3 音频帧。');
    if (chunkStart && (frame.endOffset - chunkStart.offset > maxBytes || frame.endTime - chunkStart.time > chunkSeconds + 1e-10)) {
      reader.progress(chunkEnd.endOffset, chunkEnd.endTime);
      yield output(); checkAbort(signal);
      ownedStart = chunkEnd.endTime;
      // Retain only a short predecessor tail. Tight limits take precedence over preroll.
      while (recent.length && (frame.endOffset - recent[0].offset > maxBytes || frame.endTime - recent[0].time > chunkSeconds + 1e-10)) recent.shift();
      chunkStart = recent[0];
    }
    chunkStart ??= frame;
    chunkEnd = frame;
    recent.push(frame);
    while (recent.length && frame.endTime - recent[0].time > preroll + 1e-10) recent.shift();
    totalSamples += info.samples;
    at = frame.endOffset;
  }
  if (chunkStart && chunkEnd.endTime > ownedStart) {
    reader.progress(bounds.end, chunkEnd.endTime);
    yield output(); checkAbort(signal);
  }
  if (!streamFormat) throw new Error('MP3 文件中没有完整音频帧。');
  reader.progress(blob.size, totalSamples / streamFormat.sampleRate);
}

/**
 * Produce independently wrapped WAV / frame-aligned MP3 chunks without re-encoding.
 * start/duration cover the uploaded audio, including MP3 preroll. ownedStart/ownedEnd
 * identify the new source interval; use them when merging timestamped recognition.
 * bytesRead is the logical scan position (metadata/payload skipped by slicing included).
 * name is accepted for caller compatibility; upload filenames intentionally stay neutral.
 */
export async function* chunkAudio(blob, { name = '', chunkSeconds = 180, maxBytes = 8 * 1024 * 1024, signal, onScanProgress } = {}) {
  checkAbort(signal);
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 4 || typeof blob.slice !== 'function') throw new Error('请选择有效的 MP3 或 WAV 音频文件。');
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('分片参数无效：时间和字节上限必须为正数。');
  const reader = makeReader(blob, signal, onScanProgress);
  reader.progress(0, 0);
  const first = await reader.read(0, Math.min(12, blob.size));
  const magic = textAt(first, 0, 4);
  const options = { chunkSeconds, maxBytes, signal };
  if (magic === 'RIFF' && first.length >= 12 && textAt(first, 8, 4) === 'WAVE') {
    yield* chunkWave(blob, reader, options, first);
  } else if (textAt(first, 0, 3) === 'ID3' || parseMp3Header(first)) {
    yield* chunkMp3(blob, reader, options);
  } else {
    throw new Error('暂不支持此音频格式；请选择 MPEG Layer III MP3 或 PCM/IEEE 浮点 WAV。');
  }
}
