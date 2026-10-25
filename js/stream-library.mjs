// Persist online manifests only. Generic media uses the validated resolver asset route.
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
const audioFormats = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'oga'];
const abortError = () => new DOMException('已取消', 'AbortError');

export function parseWorkUrl(value) {
  let candidate = String(value).trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate) && /^[^\s/]+\.[^\s/]+(?:[/?#]|$)/u.test(candidate)) candidate = `https://${candidate}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('请输入有效的网页、音频或播放列表网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('请输入不含账号或密码的 HTTP(S) 网址。');
  url.hash = '';
  const match = /^\/work\/(RJ\d{5,12})\/?$/i.exec(url.pathname);
  if (!['asmr.one', 'www.asmr.one'].includes(url.hostname) || url.port || !match) return { sourceUrl: url.href };
  const workId = match[1].slice(2).replace(/^0+(?=\d)/, '');
  const code = `RJ${workId.padStart(Number(workId) >= 1000000 ? 8 : 6,'0')}`;
  return { code, workId, sourceUrl: `https://asmr.one/work/${code}` };
}

export const isOnlineWork = work => ['asmr-one', 'web'].includes(work?.provider);

export function isTrustedResolverAsset(value, {resolverBase = DEFAULT_RESOLVER, sourceUrl, id} = {}) {
  try {
    const url = new URL(value), resolver = new URL(resolverBase);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && url.origin === resolver.origin && url.pathname === '/api/asset' && !url.hash
      && url.searchParams.get('source') === sourceUrl && Boolean(url.searchParams.get('id'))
      && (id === undefined || url.searchParams.get('id') === id)
      && [...url.searchParams.keys()].length === 2;
  } catch { return false; }
}

export function isTrustedRemoteAudio(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'kiko-play-niptan.one' || url.hostname.endsWith('.kiko-play-niptan.one'));
  } catch { return false; }
}

function safeAssetUrl(value, resolverBase, audio = false, webSource = null, id) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('作品返回了无效的资源链接。');
  if (webSource) {
    if (isTrustedResolverAsset(value, {resolverBase,sourceUrl:webSource,id})) return value;
    throw new Error('作品包含未经验证的资源链接，请刷新目录后重试。');
  }
  if (isTrustedRemoteAudio(value)) return value;
  let url, resolver;
  try { url = new URL(value); resolver = new URL(resolverBase); } catch { throw new Error('作品返回了无效的资源链接。'); }
  if (!audio && url.protocol === 'https:' && !url.username && !url.password
    && url.origin === resolver.origin && url.pathname === '/api/asset') return value;
  throw new Error('作品包含尚未支持的媒体来源，请稍后刷新重试。');
}

function cleanManifest(input, resolverBase) {
  if (!input || input.version !== 1 || !isOnlineWork(input)) throw new Error('解析服务返回的作品格式无效。');
  let source = parseWorkUrl(input.sourceUrl);
  const webSource = input.provider === 'web' ? source.sourceUrl : null;
  if (webSource) {
    if (!/^[a-f0-9]{24}$/.test(input.workId)) throw new Error('解析结果的作品标识无效。');
    source = {sourceUrl:webSource,workId:input.workId,code:typeof input.code === 'string' ? input.code.slice(0,100) : ''};
  } else if (!source.workId || String(input.workId) !== source.workId || !/^RJ\d{5,12}$/i.test(input.code || '')
    || input.code.slice(2).replace(/^0+(?=\d)/,'') !== source.workId) throw new Error('解析结果与作品编号不一致。');
  if (!Array.isArray(input.entries) || input.entries.length > 20000) throw new Error('作品目录过大或格式无效。');
  const seen = new Set(), seenIds = new Set();
  const entries = input.entries.map((entry, index) => {
    const path = String(entry.path ?? '');
    if (!path || path.length > 2000 || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(path)
      || seen.has(path)) throw new Error('作品目录中包含无效或重复的文件路径。');
    seen.add(path);
    const id = String(entry.id ?? index).slice(0,2000);
    if (!id || seenIds.has(id)) throw new Error('作品目录中包含无效或重复的资源标识。');
    seenIds.add(id);
    const type = ['audio','image','subtitle','other'].includes(entry.type) ? entry.type : 'other';
    const url = safeAssetUrl(entry.url, resolverBase, type === 'audio',webSource,webSource ? id : undefined);
    return {
      id, path, type, url,
      downloadUrl: safeAssetUrl(entry.downloadUrl || url, resolverBase, type === 'audio',webSource,webSource ? id : undefined),
      ...(type === 'audio' && typeof entry.subtitleId === 'string' ? {subtitleId:entry.subtitleId.slice(0,2000)} : {}),
      ...(Number.isFinite(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
      ...(Number.isFinite(entry.duration) && entry.duration > 0 ? { duration: entry.duration } : {}),
      ...(type === 'subtitle' ? { subtitleFormat: subtitleFormats.includes(entry.subtitleFormat) ? entry.subtitleFormat : ext(path) } : {}),
    };
  });
  return { version: 1, provider: input.provider, ...source,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.slice(0, 2000) : source.code || new URL(source.sourceUrl).hostname,
    coverUrl: input.coverUrl ? safeAssetUrl(input.coverUrl, resolverBase,false,webSource) : null,
    entries, resolvedAt: typeof input.resolvedAt === 'string' ? input.resolvedAt.slice(0, 100) : new Date().toISOString() };
}

function defaultFormat(entries) {
  return entries.some(e => e.type === 'audio' && ext(e.path) === 'mp3') ? 'mp3' : entries.some(e => e.type === 'audio' && ext(e.path) === 'wav') ? 'wav' : 'all';
}

export function availableRemoteFormats(entries) {
  const formats = [...new Set(entries.filter(entry=>entry.type === 'audio' && audioFormats.includes(ext(entry.path))).map(entry=>ext(entry.path)))];
  formats.sort((a,b)=>audioFormats.indexOf(a)-audioFormats.indexOf(b));
  return [...formats,'all'];
}

function subtitleFor(entry, entries) {
  if (entry.subtitleId) {
    const linked = entries.find(candidate=>candidate.type === 'subtitle' && candidate.id === entry.subtitleId);
    if (linked) return linked;
  }
  const names = [entry.path, stem(entry.path)];
  for (const name of names) for (const format of subtitleFormats) {
    const found = entries.find(e => e.type === 'subtitle' && e.path.toLowerCase() === `${name}.${format}`.toLowerCase());
    if (found) return found;
  }
  return null;
}

export function selectRemoteEntries(entries, format = defaultFormat(entries)) {
  const audio = entries.filter(e => e.type === 'audio' && audioFormats.includes(ext(e.path)) && (format === 'all' || ext(e.path) === format));
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
  format = availableRemoteFormats(manifest.entries).includes(format) ? format : defaultFormat(manifest.entries);
  const tracks = selectRemoteEntries(manifest.entries,format).filter(e=>e.type === 'audio').map(entry => {
    const subtitle = subtitleFor(entry,manifest.entries);
    const source = { id: entry.path, side: 'center', label: null, hairPalette: [], colorVersion: null,
      audioUrl: entry.url, subtitleUrl: subtitle?.url ?? null, subtitleFormat: subtitle?.subtitleFormat ?? null,
      remoteProvider: manifest.provider, audioFormat:ext(entry.path),
      ...(manifest.provider === 'web' ? {resolverBase,sourceUrl:manifest.sourceUrl} : {}) };
    return { id: entry.path, title: base(stem(entry.path)), trackNumber: Number(/Track\s*(\d+)/i.exec(base(entry.path))?.[1]) || null,
      folderPath: dir(entry.path), mode: 'single', sources: [source], audioUrl: source.audioUrl, subtitleUrl: source.subtitleUrl };
  }).sort((a,b)=>collator.compare(a.folderPath,b.folderPath) || collator.compare(a.id,b.id));
  if (!tracks.length) throw new Error('该作品没有所选格式的可播放音轨。请切换格式或刷新目录。');
  const backgroundCandidates = manifest.entries.filter(e=>e.type === 'image').map(e=>({path:e.path,label:e.path,url:e.url}));
  if (manifest.coverUrl) backgroundCandidates.unshift({ path: '@official-cover', label: '官方封面', url: manifest.coverUrl, official: true });
  return { id: `${manifest.provider === 'web' ? 'url' : 'asmronline'}:${manifest.workId}`, title: manifest.title, code: manifest.code, provider: manifest.provider,
    categoryPath: manifest.provider === 'web' ? 'remote:web' : CATEGORY, relativePath: `remote/${manifest.provider}/${manifest.workId}`, sourceUrl: manifest.sourceUrl,
    backgroundUrl: null, thumbnailUrl: manifest.coverUrl, backgroundCandidates, visualReferenceUrls: [],
    tracks, folderTree: buildRemoteFolderTree(tracks), rawEntries: manifest.entries, manifest, format, resolvedAt: manifest.resolvedAt };
}

export function combineLibraries(local = {}, remoteWorks = []) {
  const works = [...(local.works ?? []), ...remoteWorks].sort((a,b)=>collator.compare(a.title ?? a.id,b.title ?? b.id) || collator.compare(a.id,b.id));
  const localCategories = local.categories?.length ? local.categories : (local.works?.length ? [{id:'',title:'',workIds:local.works.map(w=>w.id)}] : []);
  return { works, categories: localCategories, profiles: local.profiles ?? {} };
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
      if (!response.ok) {
        let code;
        try { code=(await response.json())?.error?.code; } catch { /* Show only known neutral capability messages. */ }
        if (signal?.aborted) throw abortError();
        const messages={
          NO_PUBLIC_MEDIA:'该页面没有可提取的公开音频。动态脚本、登录或 DRM 媒体需要公开直链或普通播放列表。',
          UNSUPPORTED_STREAM:'该网址使用 HLS 分段流；当前支持普通音频文件与播放列表，暂不支持分段流或 DRM。',
          LOGIN_REQUIRED:'来源需要登录或授权，当前只能读取公开媒体。请提供可公开访问的音频网址。',
          UNSAFE_ADDRESS:'网址指向本机、内网或保留地址，无法导入。请使用公开音频来源。',
          UNSAFE_URL:'请使用不含账号凭据、使用默认网页端口的公开 HTTP(S) 网址。',
          TOO_LARGE:'来源目录超过当前解析大小限制。请提供更小的播放列表或音频直链。',
          TOO_MANY_ENTRIES:'作品或播放列表的文件数超过当前解析上限。请分成更小的列表。',
          PLAYLIST_DEPTH:'播放列表嵌套过深。请提供直接包含音频文件的播放列表。',
          DNS_UNAVAILABLE:'暂时无法验证来源的公开地址，请检查网址后重试。',
          INCOMPLETE_SOURCE:'来源返回的目录内容不完整，请稍后重试。',
        };
        throw new Error(messages[code] || (response.status === 404 ? '未找到这部作品，请检查网址。' : response.status === 429 ? '解析服务繁忙，请稍后重试。' : '作品暂时无法解析，请稍后重试。'));
      }
      let input;
      try { input = await response.json(); } catch { if (signal?.aborted) throw abortError(); throw new Error('作品解析服务返回的目录无法读取，请稍后重试。'); }
      if (signal?.aborted) throw abortError();
      const previous = [...registry.values()].find(work=>work.sourceUrl === source.sourceUrl);
      let format = previous?.format;
      if (format && format !== 'all' && !input.entries?.some(entry=>entry.type === 'audio' && ext(entry.path) === format)) format = undefined;
      const work = remoteWorkFromManifest(input,{resolverBase,format});
      if (work.sourceUrl !== source.sourceUrl) throw new Error('解析结果与输入的作品网址不一致。');
      if (previous && previous.id !== work.id) registry.delete(previous.id);
      registry.set(work.id,work); save(); return work;
    },
    setFormat(id,format) {
      const previous = registry.get(id); if (!previous) return null;
      const work = remoteWorkFromManifest(previous.manifest,{resolverBase,format}); registry.set(id,work); save(); return work;
    },
    remove(id) { registry.delete(id); save(); },
  };
}
