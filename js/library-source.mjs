const scenes = new Set(['ambient', 'whisper', 'tease', 'contact', 'rhythm', 'surge', 'afterglow']);
const sides = new Set(['left', 'right', 'center']);
const dimensions = ['intensity', 'intimacy', 'breath', 'motion', 'tension', 'tenderness', 'dominance', 'climax'];
const forbidden = new Set(['text', 'rawText', 'subtitle', 'quote', 'excerpt', 'transcript', 'summary']);

function bounded(value, maximum = 1) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

// Project only the numeric visual timeline; imported JSON never becomes HTML or code.
export function sanitizeCloudProfiles(data) {
  const result = {};
  if (data?.version !== 2 || !data.profiles || Array.isArray(data.profiles)) return result;
  for (const [key, profile] of Object.entries(data.profiles).slice(0, 10000)) {
    if (!/^[a-f0-9]{8}$/.test(key) || profile?.key !== key || profile.version !== 2
      || !bounded(profile.duration, 86400) || !Array.isArray(profile.timeline)
      || profile.timeline.length > 20000 || Object.keys(profile).some((name) => forbidden.has(name))) continue;
    const timeline = [];
    let valid = true;
    for (const entry of profile.timeline) {
      if (!entry || Object.keys(entry).some((name) => forbidden.has(name))
        || !bounded(entry.start, profile.duration) || !bounded(entry.end, profile.duration)
        || entry.end <= entry.start || !scenes.has(entry.scene) || !sides.has(entry.side)
        || dimensions.some((dimension) => !bounded(entry[dimension]))) {
        valid = false;
        break;
      }
      timeline.push({ start: entry.start, end: entry.end, scene: entry.scene, side: entry.side,
        ...Object.fromEntries(dimensions.map((dimension) => [dimension, entry[dimension]])) });
    }
    if (valid) result[key] = { key, version: 2, duration: profile.duration, timeline };
  }
  return result;
}

export async function loadInitialLibrary({ mode = 'local-files', baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (mode !== 'server') return { works: [], categories: [], profiles: {} };
  const [libraryResponse, cloudResponse] = await Promise.all([
    fetchImpl(new URL('api/library', baseUrl), { cache: 'no-store' }),
    fetchImpl(new URL('api/analysis/cloud-profiles', baseUrl), { cache: 'no-store' }).catch(() => null),
  ]);
  if (!libraryResponse.ok) throw new Error('无法读取本地作品库');
  const data = await libraryResponse.json();
  if (!Array.isArray(data.works)) throw new Error('作品库格式无效');
  let profiles = {};
  if (cloudResponse?.ok) {
    try { profiles = sanitizeCloudProfiles(await cloudResponse.json()); } catch { /* Optional local cache. */ }
  }
  return { works: data.works, categories: data.categories ?? [], profiles };
}
