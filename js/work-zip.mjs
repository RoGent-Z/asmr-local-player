import { makeZip } from './vendor/client-zip-2.5.0.mjs';

// Only ZIP directory metadata is retained by client-zip. Media are read lazily,
// one response at a time, with consumer backpressure all the way to fetch().
export const FALLBACK_LIMIT = 128 * 1024 * 1024;
const encoder = new TextEncoder();
export const abortError = () => new DOMException('下载已取消', 'AbortError');
export function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || abortError(); }

export function safeSegment(value) {
  let result = String(value || '').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!result || result === '.' || result === '..') result = '_';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) result = `_${result}`;
  while (encoder.encode(result).length > 200) result = Array.from(result).slice(0, -1).join('');
  return result || '_';
}
function numbered(name, count, file = true) {
  const dot = file ? name.lastIndexOf('.') : -1;
  return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
}
export function prepareDownloadEntries({ code, title, entries }) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('没有可下载的文件');
  if (entries.length > 50000) throw new Error('文件数量超过单次下载上限');
  const root = safeSegment([code, title].filter(Boolean).join(' ') || '作品');
  const tree = { children: new Map() }, directoryNames = new Map();
  return entries.map((entry, index) => {
    const url = String(entry.downloadUrl || entry.url || '');
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('下载地址必须为匿名 HTTPS 地址');
    const original = String(entry.path || `file-${index + 1}`).replace(/\\/g, '/').split('/').filter(Boolean);
    if (original.length > 40) throw new Error('目录层级超过下载上限');
    const parts = original.length ? original.map(safeSegment) : [`file-${index + 1}`];
    let node = tree, prefix = '', resolved = [];
    for (let depth = 0; depth < parts.length; depth++) {
      const file = depth === parts.length - 1;
      prefix += `/${original[depth]}`;
      const existing = !file && directoryNames.get(prefix);
      let name = existing || parts[depth], count = 1;
      if (!existing) {
        while (node.children.has(name.toLowerCase())) name = numbered(parts[depth], ++count, file);
        node.children.set(name.toLowerCase(), { children: new Map() });
        if (!file) directoryNames.set(prefix, name);
      }
      resolved.push(name); node = node.children.get(name.toLowerCase());
    }
    return { ...entry, url, name: [root, ...resolved].join('/'), size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null };
  });
}

export async function validateFullFileResponse(response) {
  let error;
  // A whole-file downloader never sends Range. Even a nominally successful
  // response must not turn a partial representation into a completed file.
  if (response.status === 206 || response.headers.has('content-range')) error = new Error('下载服务返回了部分文件区间，无法保存完整文件');
  else if (!response.ok) error = new Error(`下载请求失败（HTTP ${response.status}）`);
  if (error) { try { await response.body?.cancel(); } catch {} throw error; }
}
export function verifyFileSize(entry, actual, complete = false) {
  // size is the expected body length of downloadUrl || url, after HTTP content
  // decoding. Callers must supply null if this representation's size is truly
  // unknown; a known mismatch is an error and is never silently downgraded.
  if (Number.isSafeInteger(entry.size) && entry.size >= 0 && (actual > entry.size || (complete && actual !== entry.size))) throw new Error(`下载文件大小不符（预期 ${entry.size} 字节，实际 ${actual} 字节）`);
}
export async function openRemoteStream(entry, { fetchImpl = globalThis.fetch, signal, onBytes = () => {} } = {}) {
  throwIfAborted(signal);
  const response = await fetchImpl(entry.url, { signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', cache: 'no-store' });
  await validateFullFileResponse(response);
  if (!response.body) throw new Error('浏览器未提供文件数据流');
  const reader = response.body.getReader();
  let controller, finished = false, received = 0;
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const abort = () => {
    if (finished) return;
    finished = true; cleanup();
    const reason = signal.reason || abortError();
    reader.cancel(reason).catch(() => {}); controller?.error(reason);
  };
  return new ReadableStream({
    start(c) { controller = c; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); },
    async pull(c) {
      try {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) { verifyFileSize(entry, received, true); finished = true; cleanup(); reader.releaseLock(); c.close(); }
        else { received += value.byteLength; verifyFileSize(entry, received); onBytes(value.byteLength); c.enqueue(value); }
      } catch (error) { if (!finished) { finished = true; cleanup(); reader.cancel(error).catch(() => {}); c.error(error); } }
    },
    async cancel(reason) { finished = true; cleanup(); await reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

export function createWorkZipStream(entries, { signal, fetchImpl, onProgress = () => {} } = {}) {
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal?.reason || abortError());
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0, completed = 0, activeBody;
  const emit = () => onProgress({ phase: 'downloading', completed, total: entries.length, bytes });
  async function* inputs() {
    for (const entry of entries) {
      throwIfAborted(abortController.signal);
      activeBody = await openRemoteStream(entry, { signal: abortController.signal, fetchImpl, onBytes: (length) => { bytes += length; emit(); } });
      yield { name: entry.name, input: activeBody, lastModified: new Date('2026-01-01T00:00:00Z') };
      completed++; emit(); activeBody = null;
    }
  }
  const zip = makeZip(inputs(), { buffersAreUTF8: true }).getReader();
  const cleanup = () => signal?.removeEventListener('abort', abort);
  return new ReadableStream({
    async pull(controller) {
      try {
        throwIfAborted(abortController.signal);
        const { value, done } = await zip.read();
        if (done) { cleanup(); controller.close(); } else controller.enqueue(value);
      } catch (error) { abortController.abort(error); cleanup(); controller.error(error); }
    },
    async cancel(reason) {
      abortController.abort(reason || abortError()); cleanup();
      // The vendored ZIP iterator has no body-reader cancellation hook. Aborting
      // our tracked response errors its pending read. Calling vendor cancel()
      // would also throw into an async iterator without awaiting its rejection.
      // Let the ZIP pull observe the aborted response instead.
      zip.closed.catch(() => {});
      if (activeBody && !activeBody.locked) await activeBody.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
}

function zipOverhead(entry) { return 76 + 2 * encoder.encode(entry.name).length; }
export function partitionDownloadEntries(entries, limit = FALLBACK_LIMIT) {
  const result = []; let current;
  for (const entry of entries) {
    const required = entry.size == null ? Infinity : entry.size + zipOverhead(entry);
    if (required + 22 > limit) { current = null; result.push({ mode: 'native', entries: [entry], estimatedBytes: entry.size }); continue; }
    if (!current || current.estimatedBytes + required > limit) { current = { mode: 'zip', entries: [], estimatedBytes: 22 }; result.push(current); }
    current.entries.push(entry); current.estimatedBytes += required;
  }
  return result;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); crcTable[n] = c; }
function checksum(bytes) { let crc = -1; for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255]; return (crc ^ -1) >>> 0; }
function header(length) { const bytes = new Uint8Array(length); return { bytes, view: new DataView(bytes.buffer) }; }
// The compatibility path uses ZIP32 and retains only one <=128 MiB batch.
// Blob parts avoid a second giant concatenated Uint8Array.
export function makeBufferedZip(entries, limit = FALLBACK_LIMIT) {
  const chunks = [], central = []; let offset = 0, centralLength = 0;
  if (entries.length > 65535) throw new Error('分卷文件数量超过 ZIP32 上限');
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = entry.data;
    if (!(data instanceof Uint8Array)) throw new TypeError('ZIP 数据必须为字节数组');
    if (offset + data.byteLength + 22 + centralLength + 76 + 2 * name.length > limit) throw new Error('分卷超过内存上限');
    const crc = checksum(data), local = header(30), directory = header(46);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true);
    local.view.setUint32(14, crc, true); local.view.setUint32(18, data.byteLength, true); local.view.setUint32(22, data.byteLength, true); local.view.setUint16(26, name.length, true);
    directory.view.setUint32(0, 0x02014b50, true); directory.view.setUint16(4, 20, true); directory.view.setUint16(6, 20, true); directory.view.setUint16(8, 0x800, true);
    directory.view.setUint32(16, crc, true); directory.view.setUint32(20, data.byteLength, true); directory.view.setUint32(24, data.byteLength, true); directory.view.setUint16(28, name.length, true); directory.view.setUint32(42, offset, true);
    chunks.push(local.bytes, name, data); central.push(directory.bytes, name);
    offset += 30 + name.length + data.byteLength; centralLength += 46 + name.length;
  }
  const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, entries.length, true); end.view.setUint16(10, entries.length, true); end.view.setUint32(12, centralLength, true); end.view.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.bytes], { type: 'application/zip' });
}
