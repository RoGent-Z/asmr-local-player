import { FALLBACK_LIMIT, abortError, throwIfAborted, prepareDownloadEntries, validateFullFileResponse, verifyFileSize, openRemoteStream, partitionDownloadEntries, makeBufferedZip } from './work-zip.mjs';

const WORKER_URL = new URL('../download-worker.mjs', import.meta.url);
const ROOT_URL = new URL('../', import.meta.url);
function emit(callback, phase, completed, total, bytes, extra = {}) { callback?.({ phase, completed, total, bytes, ...extra }); }
function nativeLink(env, url, filename, external = false) {
  const anchor = env.document.createElement('a'); anchor.href = url; anchor.download = filename;
  if (external) anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer'; anchor.style.display = 'none';
  env.document.body.append(anchor); anchor.click(); anchor.remove();
}
function isMobile(navigator) { return navigator?.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator?.userAgent || '') || (/Macintosh/.test(navigator?.userAgent || '') && navigator?.maxTouchPoints > 1); }

async function directoryDownload(root, entries, { signal, onProgress }, env) {
  const originalRootName = entries[0].name.split('/')[0];
  let workDirectory;
  for (let number = 1; number <= 10000; number++) {
    throwIfAborted(signal);
    const name = number === 1 ? originalRootName : `${originalRootName} (${number})`;
    try { await root.getDirectoryHandle(name); }
    catch (error) {
      if (error.name !== 'NotFoundError' && error.name !== 'TypeMismatchError') throw error;
      if (error.name === 'TypeMismatchError') continue;
      workDirectory = await root.getDirectoryHandle(name, { create: true }); break;
    }
  }
  if (!workDirectory) throw new Error('目标目录重名过多，请更换目录');
  let bytes = 0, completed = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    let directory = workDirectory;
    const parts = entry.name.split('/').slice(1);
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
    const file = await directory.getFileHandle(parts.at(-1), { create: true });
    const writable = await file.createWritable();
    try {
      const stream = await openRemoteStream(entry, { fetchImpl: env.fetch.bind(env), signal, onBytes: (length) => { bytes += length; emit(onProgress, 'downloading', completed, entries.length, bytes); } });
      await stream.pipeTo(writable, { signal });
    } catch (error) { try { await writable.abort(error); } catch {} throw error; }
    completed++; emit(onProgress, 'downloading', completed, entries.length, bytes);
  }
  emit(onProgress, 'complete', completed, entries.length, bytes);
  return { status: 'saved', files: completed, bytes, mode: 'directory' };
}

function timeoutPromise(promise, ms, message, signal) {
  let timer, aborted;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    aborted = () => reject(signal.reason || abortError());
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
  return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); });
}
async function downloadWorker(env, signal) {
  const serviceWorker = env.navigator?.serviceWorker;
  if (!serviceWorker || !env.isSecureContext || typeof env.ReadableStream !== 'function' || typeof env.MessageChannel !== 'function') throw new Error('此浏览器不支持流式下载');
  throwIfAborted(signal);
  const registration = await timeoutPromise(serviceWorker.register(WORKER_URL.href, { type: 'module', scope: ROOT_URL.href, updateViaCache: 'none' }), 10000, '下载服务注册超时', signal);
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) throw new Error('下载服务未启动');
  if (worker.state !== 'activated') await timeoutPromise(new Promise((resolve, reject) => {
    const changed = () => { if (worker.state === 'activated') { worker.removeEventListener('statechange', changed); resolve(); } else if (worker.state === 'redundant') { worker.removeEventListener('statechange', changed); reject(new Error('下载服务无法安装')); } };
    worker.addEventListener('statechange', changed); changed();
  }), 10000, '下载服务启动超时', signal);
  if (serviceWorker.controller?.scriptURL !== WORKER_URL.href) await timeoutPromise(new Promise((resolve) => {
    const changed = () => { if (serviceWorker.controller?.scriptURL === WORKER_URL.href) { serviceWorker.removeEventListener('controllerchange', changed); resolve(); } };
    serviceWorker.addEventListener('controllerchange', changed); changed();
  }), 8000, '下载服务无法接管当前页面', signal);
  throwIfAborted(signal);
  return registration.active || worker;
}

async function serviceWorkerDownload(worker, entries, { signal, onProgress }, env) {
  throwIfAborted(signal);
  const channel = new env.MessageChannel();
  return new Promise((resolve, reject) => {
    let started = false, launched = false, settled = false, bytes = 0, completed = 0;
    let readyTimer, idleTimer;
    const ping = setInterval(() => channel.port1.postMessage({ type: 'ping' }), 15000);
    const cleanup = () => { clearInterval(ping); clearTimeout(readyTimer); clearTimeout(idleTimer); signal?.removeEventListener('abort', cancel); channel.port1.close(); };
    const fail = (error) => { if (settled) return; settled = true; channel.port1.postMessage({ type: 'cancel' }); cleanup(); reject(error); };
    const cancel = () => fail(signal.reason || abortError());
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail(new Error('下载服务无响应，请重新下载')), 90000); };
    signal?.addEventListener('abort', cancel, { once: true });
    readyTimer = setTimeout(() => fail(new Error('浏览器未开始下载，请重试并允许下载')), 30000);
    channel.port1.onmessage = ({ data }) => {
      if (settled) return;
      resetIdle();
      if (data?.type === 'ready') {
        if (launched) return;
        const url = new URL(data.url);
        if (url.origin !== ROOT_URL.origin || !url.pathname.startsWith(`${ROOT_URL.pathname}__work_download__/`)) { fail(new Error('下载服务返回了无效地址')); return; }
        launched = true;
        const anchor = env.document.createElement('a');
        anchor.href = url.href; anchor.style.display = 'none';
        env.document.body.append(anchor); anchor.click(); anchor.remove();
      } else if (data?.type === 'started') { started = true; clearTimeout(readyTimer); }
      else if (data?.type === 'progress') { bytes = data.bytes; completed = data.completed; onProgress?.({ phase: 'downloading', completed, total: entries.length, bytes }); }
      else if (data?.type === 'complete' && started) {
        settled = true; bytes = data.bytes; completed = data.completed; cleanup();
        emit(onProgress, 'handed-off', completed, entries.length, bytes);
        resolve({ status: 'handed-off', files: completed, bytes, mode: 'streaming-zip' });
      } else if (data?.type === 'error') fail(new Error(data.message || '下载失败'));
    };
    worker.postMessage({ type: 'asmr-download/start', entries, filename: `${entries[0].name.split('/')[0]}.zip` }, [channel.port2]);
    if (signal?.aborted) cancel();
  });
}

async function boundedFallback(entries, { signal, onProgress }, env) {
  const batches = partitionDownloadEntries(entries);
  let bytes = 0, completed = 0, nativeFiles = 0, part = 0;
  for (const batch of batches) {
    throwIfAborted(signal);
    if (batch.mode === 'native') {
      const entry = batch.entries[0];
      nativeLink(env, entry.url, entry.name.split('/').at(-1), true);
      nativeFiles++;
      // A cross-origin server may open this URL or ask for confirmation. No
      // byte count or completion is fabricated for a browser-owned transfer.
      emit(onProgress, 'native-handoff', completed, entries.length, bytes, { handedOff: nativeFiles });
      continue;
    }
    let buffered = [], retained = 22;
    for (const entry of batch.entries) {
      throwIfAborted(signal);
      const response = await env.fetch(entry.url, { signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', cache: 'no-store' });
      await validateFullFileResponse(response);
      const overhead = 76 + 2 * new TextEncoder().encode(entry.name).length;
      const cap = FALLBACK_LIMIT - retained - overhead;
      const chunks = []; let fileBytes = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const cancel = () => { reader.cancel(signal.reason || abortError()).catch(() => {}); };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            throwIfAborted(signal);
            const { value, done } = await reader.read();
            throwIfAborted(signal); if (done) break;
            fileBytes += value.byteLength;
            if (fileBytes > cap) { await reader.cancel(); throw new Error('文件大小超过兼容模式上限，请使用支持流式下载的浏览器'); }
            verifyFileSize(entry, fileBytes);
            chunks.push(value); bytes += value.byteLength; emit(onProgress, 'downloading', completed, entries.length, bytes);
          }
        } catch (error) { await reader.cancel(error).catch(() => {}); throw error;
        } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
      } else {
        // Without streams the browser controls allocation. Only a response with
        // an explicit bounded Content-Length is allowed into the Blob fallback.
        const length = Number(response.headers.get('content-length'));
        if (!response.headers.has('content-length') || !Number.isSafeInteger(length) || length < 0 || length > cap || length !== entry.size) throw new Error('浏览器无法安全读取此文件，请使用支持流式下载的浏览器');
        const buffer = new Uint8Array(await response.arrayBuffer()); throwIfAborted(signal);
        if (buffer.length > cap) throw new Error('文件大小超过兼容模式上限');
        chunks.push(buffer); fileBytes = buffer.length; bytes += fileBytes;
      }
      verifyFileSize(entry, fileBytes, true);
      const data = new Uint8Array(fileBytes); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      chunks.length = 0;
      buffered.push({ name: entry.name, data }); retained += fileBytes + overhead;
      completed++; emit(onProgress, 'downloading', completed, entries.length, bytes);
    }
    throwIfAborted(signal);
    const blob = makeBufferedZip(buffered); buffered = [];
    const url = env.URL.createObjectURL(blob);
    const suffix = batches.length > 1 ? `-part-${String(++part).padStart(3, '0')}` : '';
    try { nativeLink(env, url, `${entries[0].name.split('/')[0]}${suffix}.zip`); }
    finally { (env.setTimeout || setTimeout)(() => env.URL.revokeObjectURL(url), 60000); }
  }
  emit(onProgress, 'handed-off', completed, entries.length, bytes, { handedOff: nativeFiles });
  return { status: 'handed-off', files: completed + nativeFiles, bytes, mode: nativeFiles ? 'bounded-zip+native' : 'bounded-zip' };
}

export function createRemoteDownloader(env = globalThis) {
  return async function downloadRemoteWork(options) {
    const { signal, onProgress } = options;
    throwIfAborted(signal);
    const entries = prepareDownloadEntries(options);
    emit(onProgress, 'preparing', 0, entries.length, 0);
    if (typeof env.showDirectoryPicker === 'function' && !isMobile(env.navigator)) {
      // Invoke before any await so the original click retains user activation.
      const root = await env.showDirectoryPicker({ mode: 'readwrite', id: 'asmr-work-download' });
      return directoryDownload(root, entries, options, env);
    }
    let worker;
    try { worker = await downloadWorker(env, signal); }
    catch (error) { throwIfAborted(signal); emit(onProgress, 'compatibility', 0, entries.length, 0); }
    if (worker) return serviceWorkerDownload(worker, entries, options, env);
    return boundedFallback(entries, options, env);
  };
}

/** Resolves after directory writes, or after handing the archive to the browser.
 * Keep this page open for streaming downloads. A browser-owned save is never
 * claimed as persisted; callers should display the returned status verbatim. */
export const downloadRemoteWork = createRemoteDownloader();
