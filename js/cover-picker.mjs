import { coverPriority, selectWorkCover } from './cover-policy.mjs';

export function createCoverPicker({ onChange = () => {}, onOpenChange = () => {}, onError = () => {} } = {}) {
  const dialog = document.querySelector('#coverDialog');
  const gallery = document.querySelector('#coverGallery');
  const failed = new Map();
  const sessionChoices = new Map();
  const keyFor = work => `asmr-player:cover:v1:${work.relativePath || work.id}`;
  let currentWork = null;
  let returnFocus = null;
  let generation = 0;
  function savedPath(work) {
    const key = keyFor(work);
    if (sessionChoices.has(key)) return sessionChoices.get(key);
    try { return JSON.parse(localStorage.getItem(key))?.path; } catch { return undefined; }
  }
  function resolve(work) {
    return selectWorkCover(work.backgroundCandidates ?? [], savedPath(work), failed.get(keyFor(work)));
  }
  function save(path) {
    if (!currentWork) return;
    const key = keyFor(currentWork);
    sessionChoices.set(key, path);
    try {
      if (path === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ path }));
    } catch { onError('当前浏览器无法保存设置，本次选择仍有效'); }
    onChange(currentWork);
    dialog.close();
  }
  function markFailed(work, path) {
    const key = keyFor(work);
    if (!failed.has(key)) failed.set(key, new Set());
    if (failed.get(key).has(path)) return;
    failed.get(key).add(path);
    onChange(work);
  }
  function open(work, trigger) {
    const requestGeneration = ++generation;
    currentWork = work;
    returnFocus = trigger?.dataset.focusKey;
    document.querySelector('#coverWorkName').textContent = work.title;
    const state = resolve(work);
    const preferred = new Set(state.choices.map(item => item.path));
    document.querySelector('#coverHelp').textContent = state.needsChoice
      ? `有 ${state.choices.length} 张同优先级图片，请选择一张作为曲库封面。`
      : '优先封面名称，其次作品根目录，再其次子目录。你也可以选择其他图片。';
    gallery.replaceChildren();
    const candidates = [...(work.backgroundCandidates ?? [])].sort((a,b) => coverPriority(a.path)-coverPriority(b.path) || a.path.localeCompare(b.path, 'zh-CN', {numeric:true}));
    for (const candidate of candidates) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `background-choice${preferred.has(candidate.path) ? ' recommended' : ''}`;
      button.dataset.path = candidate.path;
      button.setAttribute('aria-pressed', String(candidate.path === state.image?.path));
      button.disabled = failed.get(keyFor(work))?.has(candidate.path) ?? false;
      const image = document.createElement('img');
      image.src = candidate.url; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      const label = document.createElement('span'); label.textContent = candidate.path;
      if (preferred.has(candidate.path)) {
        const badge = document.createElement('small'); badge.className = 'cover-priority'; badge.textContent = '优先候选'; button.append(badge);
      }
      image.addEventListener('error', () => {
        if (requestGeneration !== generation) return;
        button.disabled = true; label.textContent = `${candidate.path} · 无法读取`; markFailed(work, candidate.path);
      });
      button.append(image, label); button.addEventListener('click', () => save(candidate.path));
      gallery.append(button);
    }
    if (!candidates.length) {
      const empty = document.createElement('p'); empty.className = 'field-help';
      empty.textContent = '当前作品中没有图片。加入图片后重新选择曲库即可。'; gallery.append(empty);
    }
    dialog.showModal(); onOpenChange(true);
  }
  document.querySelector('#coverClose').addEventListener('click', () => dialog.close());
  document.querySelector('#coverLater').addEventListener('click', () => dialog.close());
  document.querySelector('#coverAutomatic').addEventListener('click', () => save(undefined));
  dialog.addEventListener('close', () => {
    onOpenChange(false);
    [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === returnFocus)?.focus({ preventScroll:true });
  });
  return { resolve, open, markFailed, isOpen: () => dialog.open,
    reset() { generation += 1; returnFocus = null; if (dialog.open) dialog.close(); currentWork = null; gallery.replaceChildren(); failed.clear(); } };
}
