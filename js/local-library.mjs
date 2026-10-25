import { sanitizeCloudProfiles } from './library-source.mjs';
import { decodeSubtitleBytes, parseSubtitle } from './subtitles.mjs';
import { selectWorkCover } from './cover-policy.mjs';

const naturalCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const pinyinCollator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base' });
const audioExtensions = new Set(['.mp3', '.wav']);
const subtitleFormats = ['vtt', 'srt', 'ass', 'ssa', 'lrc'];
const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'];
const profileFileName = 'cloud-semantic-profiles-v2.json';
const excludedDirectories = new Set([
  'tmp', 'temp', 'archive', 'archives', 'node_modules', 'site', 'docs',
  'screenshots', 'reports', 'dist', 'output', 'tools', 'private-analysis',
  '__macosx', '$recycle.bin', 'system volume information',
]);
const decoder = new TextDecoder();
const baseName = (value) => value.slice(value.lastIndexOf('/') + 1);
const directoryName = (value) => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const extension = (value) => /\.[^./]+$/.exec(value)?.[0].toLowerCase() ?? '';
const stem = (value) => baseName(value).slice(0, -extension(value).length);
const trackNumber = (value) => {
  const match = /Track\s*(\d+)/i.exec(baseName(value));
  return match ? Number(match[1]) : null;
};

function normalizePath(file) {
  const value = String(file.webkitRelativePath || file.name || '').replaceAll('\\', '/');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  return parts.join('/');
}

function allowedPath(value) {
  const parts = value.split('/');
  const isProfile = parts.at(-1) === profileFileName;
  if (parts.slice(0, -1).some((part) => excludedDirectories.has(part.toLowerCase())
    && !(isProfile && part.toLowerCase() === 'private-analysis'))) return false;
  return !/(?:api[-_]?key|credentials?|secrets?|password|token)(?:[._-]|$)/i.test(parts.at(-1));
}

function prepareFiles(files) {
  const unique = new Map();
  for (const file of files ?? []) {
    const path = normalizePath(file);
    if (path && allowedPath(path) && !unique.has(path)) unique.set(path, { file, path, cachePath: path });
  }
  const entries = [...unique.values()];
  const firstRoot = entries[0]?.path.split('/')[0];
  const selectedRoot = firstRoot && entries.every(({ path }) => path.startsWith(`${firstRoot}/`))
    ? firstRoot : null;
  if (selectedRoot && !/^RJ/i.test(selectedRoot)) {
    for (const entry of entries) entry.path = entry.path.slice(selectedRoot.length + 1);
  }
  return { entries, selectedRoot };
}

function discoverWorks(entries, selectedRoot) {
  const found = new Map();
  for (const { path } of entries) {
    const parts = path.split('/');
    const index = parts.slice(0, -1).findIndex((part) => /^RJ/i.test(part));
    if (index < 0 || index > 1) continue;
    const relativePath = parts.slice(0, index + 1).join('/');
    if (!found.has(relativePath)) found.set(relativePath, {
      id: parts[index], title: parts[index],
      categoryPath: parts.slice(0, index).join('/'), relativePath,
    });
  }
  if (!found.size && entries.some(({ path }) => audioExtensions.has(extension(path)))) {
    const title = selectedRoot || '本机文件';
    found.set('', { id: title, title, categoryPath: '', relativePath: '' });
  }
  return [...found.values()].sort((left, right) => {
    if (!left.categoryPath && right.categoryPath) return -1;
    if (left.categoryPath && !right.categoryPath) return 1;
    return naturalCollator.compare(left.categoryPath, right.categoryPath)
      || naturalCollator.compare(left.title, right.title);
  });
}

async function readApeTags(file) {
  if (file.size < 32) return {};
  let trailingEnd = file.size;
  if (file.size >= 128) {
    const marker = new Uint8Array(await file.slice(file.size - 128, file.size - 125).arrayBuffer());
    if (decoder.decode(marker) === 'TAG') trailingEnd -= 128;
  }
  if (trailingEnd < 32) return {};
  const footerBytes = new Uint8Array(await file.slice(trailingEnd - 32, trailingEnd).arrayBuffer());
  if (footerBytes.length !== 32 || decoder.decode(footerBytes.subarray(0, 8)) !== 'APETAGEX') return {};
  const footer = new DataView(footerBytes.buffer, footerBytes.byteOffset, footerBytes.byteLength);
  const tagSize = footer.getUint32(12, true);
  const itemCount = footer.getUint32(16, true);
  if (footer.getUint32(8, true) < 2000 || tagSize < 32 || tagSize > trailingEnd
    || tagSize > 16 * 1024 * 1024 || itemCount > 10000) return {};
  const bytes = new Uint8Array(await file.slice(trailingEnd - tagSize, trailingEnd - 32).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = Object.create(null);
  let offset = 0;
  for (let index = 0; index < itemCount && offset + 8 <= bytes.length; index += 1) {
    const size = view.getUint32(offset, true);
    const flags = view.getUint32(offset + 4, true);
    offset += 8;
    const keyEnd = bytes.indexOf(0, offset);
    if (keyEnd < offset || keyEnd - offset > 255) break;
    const key = decoder.decode(bytes.subarray(offset, keyEnd));
    offset = keyEnd + 1;
    if (offset + size > bytes.length) break;
    if (((flags >> 1) & 3) === 0 && ['ASMR_CHARACTER', 'ASMR_HAIR_PALETTE', 'ASMR_COLOR_VERSION'].includes(key)) {
      result[key] = decoder.decode(bytes.subarray(offset, offset + size));
    }
    offset += size;
  }
  return result;
}

function sortTracks(left, right) {
  if (left.trackNumber !== null && right.trackNumber !== null) {
    const difference = left.trackNumber - right.trackNumber;
    if (difference) return difference;
  } else if (left.trackNumber !== null) return -1;
  else if (right.trackNumber !== null) return 1;
  return naturalCollator.compare(left.title, right.title)
    || naturalCollator.compare(left.folderPath, right.folderPath)
    || naturalCollator.compare(left.id, right.id);
}

function buildFolderTree(tracks) {
  const root = { path: '', name: '', trackIds: [], children: [] };
  const nodes = new Map([['', root]]);
  function ensureNode(path) {
    if (nodes.has(path)) return nodes.get(path);
    const node = { path, name: baseName(path), trackIds: [], children: [] };
    ensureNode(directoryName(path)).children.push(node);
    nodes.set(path, node);
    return node;
  }
  for (const track of tracks) ensureNode(track.folderPath).trackIds.push(track.id);
  for (const node of nodes.values()) node.children.sort((left, right) => naturalCollator.compare(left.name, right.name));
  return root;
}

/** Build the API library shape from browser-selected Files. No file is uploaded. */
export async function scanLocalFiles(files, {
  createObjectURL = URL.createObjectURL.bind(URL),
  revokeObjectURL = URL.revokeObjectURL.bind(URL),
  onProgress = () => {},
} = {}) {
  const { entries, selectedRoot } = prepareFiles(files);
  const byPathLower = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]));
  const resourceUrls = new Map();
  const filesByUrl = new Map();
  const counts = { files: entries.length, audio: 0, tracks: 0, works: 0 };
  const works = [];
  const categories = [];
  const profiles = {};
  const cacheFiles = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of resourceUrls.values()) revokeObjectURL(url);
    resourceUrls.clear();
    filesByUrl.clear();
  };
  const urlFor = (entry) => {
    if (!entry) return null;
    if (!resourceUrls.has(entry.path)) {
      const url = createObjectURL(entry.file);
      resourceUrls.set(entry.path, url);
      filesByUrl.set(url, entry.file);
    }
    return resourceUrls.get(entry.path);
  };
  const report = (phase) => onProgress({ phase, ...counts });
  report('scan');

  function subtitleFor(entry) {
    const bases = [entry.path, entry.path.slice(0, -extension(entry.path).length)];
    for (const base of bases) {
      for (const format of subtitleFormats) {
        const found = byPathLower.get(`${base}.${format}`.toLowerCase());
        if (found) return { entry: found, format };
      }
    }
    return null;
  }

  async function sourceRecord(entry, relativeId, side = 'center', label = null) {
    const subtitle = subtitleFor(entry);
    let hairPalette = [];
    let colorVersion = null;
    if (label && extension(entry.path) === '.mp3') {
      try {
        const tags = await readApeTags(entry.file);
        const palette = String(tags.ASMR_HAIR_PALETTE ?? '').split(',')
          .map((color) => color.trim().toUpperCase()).filter((color) => /^#[0-9A-F]{6}$/.test(color));
        if (tags.ASMR_CHARACTER === label && palette.length >= 3 && palette.length <= 5) {
          hairPalette = palette;
          colorVersion = tags.ASMR_COLOR_VERSION ?? null;
        }
      } catch { /* Damaged or unreadable optional metadata leaves a neutral palette. */ }
    }
    return {
      id: relativeId, side, label, hairPalette, colorVersion,
      audioUrl: urlFor(entry),
      subtitleUrl: urlFor(subtitle?.entry),
      subtitleFormat: subtitle?.format ?? null,
    };
  }

  async function pairedTrack(group, relativeId) {
    if (group.number === null || group.entries.length !== 2) return null;
    const subtitles = group.entries.map(subtitleFor);
    if (subtitles.some((entry) => !entry)) return null;
    const labels = new Set();
    try {
      for (const subtitle of subtitles) {
        if (subtitle.entry.file.size > 20 * 1024 * 1024) return null;
        const parsed = parseSubtitle(decodeSubtitleBytes(await subtitle.entry.file.arrayBuffer()), { format: subtitle.format });
        for (const cue of parsed.cues) {
          if (cue.speaker) labels.add(cue.speaker);
          for (const match of cue.text.matchAll(/【([^】]+)】/g)) labels.add(match[1]);
        }
      }
    } catch { return null; }
    if (labels.size !== 2 && labels.size !== 0) return null;
    const matched = group.entries.map((entry) => {
      const matches = [...labels].filter((label) => stem(entry.path).includes(label));
      const label = labels.size ? (matches.length === 1 ? matches[0] : null)
        : stem(entry.path).replace(/^Track\s*\d+\s*/i, '').trim();
      return label ? { entry, label } : null;
    });
    if (matched.some((entry) => !entry) || new Set(matched.map((entry) => entry.label)).size !== 2) return null;
    matched.sort((left, right) => pinyinCollator.compare(left.label, right.label));
    const sources = [];
    for (const [index, { entry, label }] of matched.entries()) {
      sources.push(await sourceRecord(entry, relativeId(entry), index === 0 ? 'left' : 'right', label));
    }
    const titles = matched.map(({ entry, label }) => stem(entry.path).replace(label, '').replace(/\s+/g, ' ').trim());
    return {
      id: `paired:${group.number}:${sources.map((source) => source.id).join('|')}`,
      title: titles[0] === titles[1] ? titles[0] : `Track${group.number}`,
      trackNumber: group.number, folderPath: directoryName(relativeId(group.entries[0])),
      mode: 'paired', labelSides: { [sources[0].label]: 'left', [sources[1].label]: 'right' }, sources,
    };
  }

  try {
    for (const entry of entries.filter(({ path }) => baseName(path) === profileFileName)
      .sort((left, right) => naturalCollator.compare(left.path, right.path))) {
      try {
        const safeProfiles = sanitizeCloudProfiles(JSON.parse(await entry.file.text()));
        Object.assign(profiles, safeProfiles);
        if (Object.keys(safeProfiles).length) cacheFiles.push({ path: entry.cachePath,
          file: new File([JSON.stringify({ version: 2, profiles: safeProfiles })], profileFileName,
            { type: 'application/json', lastModified: entry.file.lastModified }),
        });
      } catch { /* Optional structured cache cannot block local audio playback. */ }
    }
    for (const work of discoverWorks(entries, selectedRoot)) {
      const prefix = work.relativePath ? `${work.relativePath}/` : '';
      const workEntries = entries.filter((entry) => entry.path.startsWith(prefix));
      const relativeId = (entry) => entry.path.slice(prefix.length);
      const groups = new Map();
      for (const entry of workEntries) {
        if (!audioExtensions.has(extension(entry.path))) continue;
        const id = relativeId(entry);
        const number = trackNumber(id);
        const key = number === null ? `file:${id}` : `track:${directoryName(id)}:${number}`;
        if (!groups.has(key)) groups.set(key, { number, entries: [] });
        groups.get(key).entries.push(entry);
        counts.audio += 1;
      }
      const tracks = [];
      for (const group of groups.values()) {
        const paired = await pairedTrack(group, relativeId);
        if (paired) tracks.push(paired);
        else for (const entry of group.entries) {
          const source = await sourceRecord(entry, relativeId(entry));
          tracks.push({
            id: source.id, title: stem(entry.path), trackNumber: trackNumber(entry.path),
            folderPath: directoryName(source.id), mode: 'single', sources: [source],
            audioUrl: source.audioUrl, subtitleUrl: source.subtitleUrl,
          });
        }
      }
      tracks.sort(sortTracks);
      const pictures = workEntries.filter((entry) => (
        /^p\/[^/]+$/i.test(relativeId(entry)) && imageExtensions.includes(extension(entry.path))
      )).sort((left, right) => naturalCollator.compare(baseName(left.path), baseName(right.path)));
      const backgroundCandidates = workEntries.filter((entry) => imageExtensions.includes(extension(entry.path)))
        .sort((left, right) => naturalCollator.compare(relativeId(left), relativeId(right)))
        .map((entry) => ({ path: relativeId(entry), label: relativeId(entry), url: urlFor(entry) }));
      works.push({
        ...work, backgroundUrl: null, thumbnailUrl: selectWorkCover(backgroundCandidates).image?.url ?? null,
        backgroundCandidates, visualReferenceUrls: pictures.map(urlFor), tracks, folderTree: buildFolderTree(tracks),
      });
      let category = categories.find((entry) => entry.id === work.categoryPath);
      if (!category) {
        category = { id: work.categoryPath, title: work.categoryPath, workIds: [] };
        categories.push(category);
      }
      category.workIds.push(work.id);
      counts.works += 1;
      counts.tracks += tracks.length;
      report('scan');
    }
    report('complete');
    for (const entry of entries) {
      if (resourceUrls.has(entry.path)) cacheFiles.push({ file: entry.file, path: entry.cachePath });
    }
    return { works, categories, profiles, counts, cacheFiles, dispose, getFile: (url) => filesByUrl.get(url) ?? null };
  } catch (error) {
    dispose();
    throw error;
  }
}
