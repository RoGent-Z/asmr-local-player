/** Naming, then directory; image format never breaks a tie. */
export function coverPriority(path) {
  const name = path.split('/').at(-1).replace(/\.[^.]+$/, '').normalize('NFKC');
  const named = /封面|表紙|ジャケット|(?:^|[^\p{L}])(?:cover|front|top|jacket)(?=$|[^\p{L}])/iu.test(name);
  return named ? 0 : path.includes('/') ? 2 : 1;
}

export function selectWorkCover(candidates, savedPath, failedPaths = new Set()) {
  const available = candidates.filter(item => !failedPaths.has(item.path));
  const saved = available.find(item => item.path === savedPath);
  const priority = Math.min(...available.map(item => coverPriority(item.path)));
  const choices = available.filter(item => coverPriority(item.path) === priority);
  return { image: saved ?? (choices.length === 1 ? choices[0] : null), choices, needsChoice: !saved && choices.length > 1 };
}
