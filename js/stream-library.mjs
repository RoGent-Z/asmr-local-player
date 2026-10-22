// Persist manifests only. Audio and images stay on the provider's HTTPS CDN.
export const DEFAULT_RESOLVER = 'https://asmr-player-resolver.navyelf7.chatgpt.site';
export const REMOTE_STORAGE_KEY = 'asmr-player:remote-library:v1';
const CATEGORY = 'remote:asmr-one';
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const ext = path => /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase() ?? '';
const base = path => path.split('/').at(-1);
const dir = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const stem = path => path.replace(/\.[^.\/]+$/, '');
const subtitleFormats = ['vtt', 'srt', 'ass', 'ssa', 'lrc'];
const abortError = () => new DOMException('已取消', 'AbortError');

export function parseWorkUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请输入完整的 ASMR.one 作品网址。'); }
  const match = /^\/work\/(RJ\d{5,12})\/?$/i.exec(url.pathname);
  if (url.protocol !== 'https:' || !['asmr.one', 'www.asmr.one'].includes(url.hostname)
    || url.port || url.username || url.password || !match) throw new Error('请输入 https://asmr.one/work/RJ… 形式的作品网址。');
  const code = match[1].toUpperCase();
  const workId = code.slice(2).replace(/^0+(?=\d)/, '');
  return { code, workId, sourceUrl: `https://asmr.one/work/${code}` };
}

export function isTrustedRemoteAudio(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'kiko-play-niptan.one' || url.hostname.endsWith('.kiko-play-niptan.one'));
  } catch { return false; }
}

function safeAssetUrl(value, resolverBase, audio = false) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('作品返回了无效的资源链接。');
  if (isTrustedRemoteAudio(value)) return value;
  let url, resolver;
  try { url = new URL(value); resolver = new URL(resolverBase); } catch { throw new Error('作品返回了无效的资源链接。'); }
  if (!audio && url.protocol === 'https:' && !url.username && !url.password
    && url.origin === resolver.origin && url.pathname === '/api/asset') return value;
  throw new Error('作品包含尚未支持的媒体来源，请稍后刷新重试。');
}

function cleanManifest(input, resolverBase) {
  if (!input || input.version !== 1 || input.provider !== 'asmr-one') throw new Error('解析服务返回的作品格式无效。');
  const source = parseWorkUrl(input.sourceUrl);
  if (String(input.workId) !== source.workId || input.code !== source.code) throw new Error('解析结果与作品编号不一致。');
  if (!Array.isArray(input.entries) || input.entries.length > 20000) throw new Error('作品目录过大或格式无效。');
  const seen = new Set();
  const entries = input.entries.map((entry, index) => {
    const path = String(entry.path ?? '');
    if (!path || path.length > 2000 || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(path)
      || seen.has(path)) throw new Error('作品目录中包含无效或重复的文件路径。');
    seen.add(path);
    const type = ['audio','image','subtitle','other'].includes(entry.type) ? entry.type : 'other';
    const url = safeAssetUrl(entry.url, resolverBase, type === 'audio');
    return {
      id: String(entry.id ?? index).slice(0, 2000), path, type, url,
      downloadUrl: safeAssetUrl(entry.downloadUrl || url, resolverBase, type === 'audio'),
      ...(Number.isFinite(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
      ...(Number.isFinite(entry.duration) && entry.duration > 0 ? { duration: entry.duration } : {}),
      ...(type === 'subtitle' ? { subtitleFormat: subtitleFormats.includes(entry.subtitleFormat) ? entry.subtitleFormat : ext(path) } : {}),
    };
  });
  return { version: 1, provider: 'asmr-one', ...source,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, 2000) : source.code,
    coverUrl: input.coverUrl ? safeAssetUrl(input.coverUrl, resolverBase) : null,
    entries, resolvedAt: typeof input.resolvedAt === 'string' ? input.resolvedAt.slice(0, 100) : new Date().toISOString() };
}

function defaultFormat(entries) {
  return entries.some(e => e.type === 'audio' && ext(e.path) === 'mp3') ? 'mp3' : 'wav';
}

function subtitleFor(entry, entries) {
  const names = [entry.path, stem(entry.path)];
  for (const name of names) for (const format of subtitleFormats) {
    const found = entries.find(e => e.type === 'subtitle' && e.path.toLowerCase() === `${name}.${format}`.toLowerCase());
    if (found) return found;
  }
  return null;
}

export function selectRemoteEntries(entries, format = defaultFormat(entries)) {
  const audio = entries.filter(e => e.type === 'audio' && ['mp3','wav'].includes(ext(e.path)) && (format === 'all' || ext(e.path) === format));
  const subtitles = new Set(audio.map(e => subtitleFor(e, entries)?.path).filter(Boolean));
  return entries.filter(e => audio.includes(e) || e.type === 'image' || subtitles.has(e.path));
}

export function remoteWorkDownloadEntries(work, format = work.format) {
  const entries = selectRemoteEntries(work.rawEntries,format);
  const coverUrl = work.manifest?.coverUrl;
  if (coverUrl && !entries.some(entry=>entry.url === coverUrl)) {
    const used = new Set(entries.map(entry=>entry.path));
    let path = 'official-cover.jpg';
    for (let index=2; used.has(path); index++) path = `official-cover (${index}).jpg`;
    entries.push({id:'official-cover',path,type:'image',official:true,url:coverUrl,downloadUrl:coverUrl});
  }
  return entries;
}

/** Choices belong to a work and path; a format change only masks that work's choices. */
export function createRemoteDownloadSelection() {
  const states = new Map();
  function reconcile(work) {
    const universe = remoteWorkDownloadEntries(work,'all');
    let state = states.get(work.id);
    if (!state) { state = {known:new Set(),selected:new Set()}; states.set(work.id,state); }
    const present = new Set(universe.map(entry=>entry.path));
    for (const path of present) if (!state.known.has(path)) state.selected.add(path);
    for (const path of state.selected) if (!present.has(path)) state.selected.delete(path);
    state.known = present;
    return state;
  }
  return {
    entries(work) {
      const state = reconcile(work);
      return remoteWorkDownloadEntries(work).map(entry=>({entry,checked:state.selected.has(entry.path)}));
    },
    selectedEntries(work) {
      const state = reconcile(work);
      return remoteWorkDownloadEntries(work).filter(entry=>state.selected.has(entry.path));
    },
    set(work,path,checked) {
      const state = reconcile(work);
      if (state.known.has(path)) { if (checked) state.selected.add(path); else state.selected.delete(path); }
    },
    setAll(work,checked) {
      const state = reconcile(work);
      for (const entry of remoteWorkDownloadEntries(work)) {
        if (checked) state.selected.add(entry.path); else state.selected.delete(entry.path);
      }
    },
    forget(id) { states.delete(id); },
  };
}

export function buildRemoteFolderTree(tracks) {
  const root = { path: '', name: '', trackIds: [], children: [] };
  const nodes = new Map([['',root]]);
  function ensure(path) {
    if (nodes.has(path)) return nodes.get(path);
    const node = { path, name: base(path), trackIds: [], children: [] };
    ensure(dir(path)).children.push(node); nodes.set(path,node); return node;
  }
  for (const track of tracks) ensure(track.folderPath).trackIds.push(track.id);
  for (const node of nodes.values()) node.children.sort((a,b)=>collator.compare(a.name,b.name));
  return root;
}

export function remoteWorkFromManifest(input, { resolverBase = DEFAULT_RESOLVER, format } = {}) {
  const manifest = cleanManifest(input, resolverBase);
  format = ['mp3','wav','all'].includes(format) ? format : defaultFormat(manifest.entries);
  const tracks = selectRemoteEntries(manifest.entries,format).filter(e=>e.type === 'audio').map(entry => {
    const subtitle = subtitleFor(entry,manifest.entries);
    const source = { id: entry.path, side: 'center', label: null, hairPalette: [], colorVersion: null,
      audioUrl: entry.url, subtitleUrl: subtitle?.url ?? null, subtitleFormat: subtitle?.subtitleFormat ?? null,
      remoteProvider: 'asmr-one' };
    return { id: entry.path, title: base(stem(entry.path)), trackNumber: Number(/Track\s*(\d+)/i.exec(base(entry.path))?.[1]) || null,
      folderPath: dir(entry.path), mode: 'single', sources: [source], audioUrl: source.audioUrl, subtitleUrl: source.subtitleUrl };
  }).sort((a,b)=>collator.compare(a.folderPath,b.folderPath) || collator.compare(a.id,b.id));
  if (!tracks.length) throw new Error('该作品没有所选格式的 MP3 或 WAV 音轨。');
  const backgroundCandidates = manifest.entries.filter(e=>e.type === 'image').map(e=>({path:e.path,label:e.path,url:e.url}));
  if (manifest.coverUrl) backgroundCandidates.unshift({ path: '@official-cover', label: '官方封面', url: manifest.coverUrl, official: true });
  return { id: `asmronline:${manifest.workId}`, title: manifest.title, code: manifest.code, provider: manifest.provider,
    categoryPath: CATEGORY, relativePath: `remote/asmr-one/${manifest.workId}`, sourceUrl: manifest.sourceUrl,
    backgroundUrl: null, thumbnailUrl: manifest.coverUrl, backgroundCandidates, visualReferenceUrls: [],
    tracks, folderTree: buildRemoteFolderTree(tracks), rawEntries: manifest.entries, manifest, format, resolvedAt: manifest.resolvedAt };
}

export function combineLibraries(local = {}, remoteWorks = []) {
  const works = [...(local.works ?? []), ...remoteWorks];
  const localCategories = local.categories?.length ? local.categories : (local.works?.length ? [{id:'',title:'',workIds:local.works.map(w=>w.id)}] : []);
  return { works, categories: [...localCategories, ...(remoteWorks.length ? [{ id: CATEGORY, title: '在线作品 · ASMR.one', workIds: remoteWorks.map(w=>w.id) }] : [])], profiles: local.profiles ?? {} };
}

export function canKeepCurrentTrack(previousWork, previousTrack, nextWork) {
  if (!previousWork || !previousTrack || previousWork.id !== nextWork?.id) return false;
  const nextTrack = nextWork.tracks.find(track=>track.id === previousTrack.id);
  return Boolean(nextTrack && nextTrack.mode === previousTrack.mode && nextTrack.sources.length === previousTrack.sources.length
    && nextTrack.sources.every((source,index)=>source.id === previousTrack.sources[index].id
      && source.audioUrl === previousTrack.sources[index].audioUrl && source.subtitleUrl === previousTrack.sources[index].subtitleUrl));
}

export function createRemoteLibrary({ storage, resolverBase = DEFAULT_RESOLVER, fetch: fetchImpl = globalThis.fetch } = {}) {
  const registry = new Map();
  let persistenceFailed = false;
  function save() {
    try {
      const json = JSON.stringify([...registry.values()].map(work=>({manifest:work.manifest,format:work.format})));
      if (json.length > MAX_STORE_BYTES) throw new Error('storage-limit');
      storage?.setItem(REMOTE_STORAGE_KEY,json); persistenceFailed = !storage;
    } catch { persistenceFailed = true; }
  }
  try {
    const raw = storage?.getItem(REMOTE_STORAGE_KEY);
    if (raw && raw.length <= MAX_STORE_BYTES) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) for (const item of saved.slice(0, 100)) {
        try { const work = remoteWorkFromManifest(item.manifest, {resolverBase,format:item.format}); registry.set(work.id,work); } catch { /* Ignore stale/untrusted cached manifests. */ }
      }
    }
  } catch { /* Storage is optional; this page still works. */ }
  return {
    works: () => [...registry.values()],
    persistenceFailed: () => persistenceFailed,
    async resolve(value, { signal } = {}) {
      const source = parseWorkUrl(value);
      if (signal?.aborted) throw abortError();
      const endpoint = new URL('/api/resolve', resolverBase); endpoint.searchParams.set('url',source.sourceUrl);
      let response;
      try { response = await fetchImpl(endpoint.href, {signal,credentials:'omit',redirect:'error'}); }
      catch (error) { if (signal?.aborted || error.name === 'AbortError') throw abortError(); throw new Error('暂时无法连接作品解析服务，请检查网络后重试。'); }
      if (!response.ok) throw new Error(response.status === 404 ? '未找到这部作品，请检查网址。' : response.status === 429 ? '解析服务繁忙，请稍后重试。' : '作品暂时无法解析，请稍后重试。');
      let input;
      try { input = await response.json(); } catch { if (signal?.aborted) throw abortError(); throw new Error('作品解析服务返回的目录无法读取，请稍后重试。'); }
      if (signal?.aborted) throw abortError();
      const id = `asmronline:${source.workId}`;
      let format = registry.get(id)?.format;
      if (format && format !== 'all' && !input.entries?.some(entry=>entry.type === 'audio' && ext(entry.path) === format)) format = undefined;
      const work = remoteWorkFromManifest(input,{resolverBase,format});
      if (work.id !== id) throw new Error('解析结果与输入的作品编号不一致。');
      registry.set(id,work); save(); return work;
    },
    setFormat(id,format) {
      const previous = registry.get(id); if (!previous) return null;
      const work = remoteWorkFromManifest(previous.manifest,{resolverBase,format}); registry.set(id,work); save(); return work;
    },
    remove(id) { registry.delete(id); save(); },
  };
}
