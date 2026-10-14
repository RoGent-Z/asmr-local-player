function trackMap(tracks) {
  return new Map(tracks.map((track) => [track.id, track]));
}

export function resolveCategoryWorks(works, category) {
  const byId = new Map(works.map((work) => [work.id, work]));
  return (category?.workIds ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean);
}

export function resolveFolderTracks(tracks, node) {
  const byId = trackMap(tracks);
  return (node?.trackIds ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean);
}

export function countFolderTracks(tracks, node) {
  if (!node) return 0;
  return resolveFolderTracks(tracks, node).length
    + (node.children ?? []).reduce(
      (total, child) => total + countFolderTracks(tracks, child),
      0,
    );
}
