import { createWorkZipStream, safeSegment, abortError } from './js/work-zip.mjs';

// This worker owns only random, expiring, single-use download responses. It
// neither caches requests nor intercepts application or media URLs.
export function createDownloadWorker(env) {
  const scope = new URL(env.registration.scope), prefix = `${scope.pathname}__work_download__/`;
  const jobs = new Map();
  const send = (job, data) => { try { job.port.postMessage(data); } catch {} };
  function end(job, error, stats) {
    if (job.finished) return;
    job.finished = true; clearTimeout(job.timer); jobs.delete(job.url);
    if (error) { job.abortController.abort(error); send(job, { type: 'error', message: error.name === 'AbortError' ? '下载已取消' : String(error.message || '下载失败') }); }
    else send(job, { type: 'complete', ...stats });
    job.resolveDone(); job.port.close();
  }
  function onMessage(event) {
    if (event.data?.type !== 'asmr-download/start' || !event.ports?.[0]) return;
    const port = event.ports[0];
    try {
      const source = new URL(event.source?.url || '');
      if (!event.source?.id || source.origin !== scope.origin || !source.pathname.startsWith(scope.pathname)) throw new Error('下载请求来源无效');
      const entries = event.data.entries;
      if (!Array.isArray(entries) || !entries.length || entries.length > 50000) throw new Error('下载清单无效');
      const seen = new Set();
      for (const entry of entries) {
        const parts = String(entry.name || '').split('/');
        if (parts.length < 2 || parts.length > 41 || parts.some((part) => safeSegment(part) !== part) || seen.has(entry.name.toLowerCase())) throw new Error('下载文件路径无效');
        seen.add(entry.name.toLowerCase());
        const url = new URL(entry.url);
        if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('下载地址无效');
      }
      const url = new URL(`${prefix}${env.crypto.randomUUID()}`, scope.origin).href;
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const job = { url, port, entries, filename: `${safeSegment(String(event.data.filename || '作品.zip').replace(/\.zip$/i, ''))}.zip`, clientId: event.source.id, abortController: new AbortController(), done, resolveDone, finished: false, stats: { bytes: 0, completed: 0 }, lastProgress: 0 };
      jobs.set(url, job);
      job.timer = setTimeout(() => end(job, new Error('下载请求已过期，请重试')), 60000);
      port.onmessage = ({ data }) => {
        if (data?.type === 'cancel') end(job, abortError());
        else if (data?.type === 'ping') send(job, { type: 'pong' });
      };
      port.start?.(); send(job, { type: 'ready', url });
      event.waitUntil?.(done);
    } catch (error) { port.postMessage({ type: 'error', message: error.message || '下载服务初始化失败' }); port.close(); }
  }
  function onFetch(event) {
    const url = new URL(event.request.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return;
    const job = jobs.get(url.href);
    // WebKit omits clientId for a navigation served by a ServiceWorker. The
    // unguessable route is still restricted to a valid same-origin start
    // message, expires in 60 seconds, and can be consumed only once.
    const anonymousNavigation = !event.clientId && event.request.mode === 'navigate';
    if (event.request.method !== 'GET' || !job || (job.clientId !== event.clientId && !anonymousNavigation)) { event.respondWith(new Response('Download not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })); return; }
    // Delete before exposing bytes, making the route strictly one-use.
    jobs.delete(url.href); clearTimeout(job.timer);
    send(job, { type: 'started' });
    const stream = createWorkZipStream(job.entries, {
      signal: job.abortController.signal, fetchImpl: env.fetch.bind(env),
      onProgress(stats) {
        job.stats = stats;
        if (Date.now() - job.lastProgress >= 100 || stats.completed === stats.total) { job.lastProgress = Date.now(); send(job, { type: 'progress', ...stats }); }
      },
    });
    const reader = stream.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { controller.close(); end(job, null, job.stats); }
          else controller.enqueue(value);
        } catch (error) { controller.error(error); end(job, error); }
      },
      async cancel(reason) { end(job, abortError()); await reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    const encoded = encodeURIComponent(job.filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    event.respondWith(new Response(body, { headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="work.zip"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } }));
    event.waitUntil?.(job.done);
  }
  return { onMessage, onFetch };
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && self.registration) {
  const handlers = createDownloadWorker(self);
  self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('message', handlers.onMessage);
  self.addEventListener('fetch', handlers.onFetch);
}
