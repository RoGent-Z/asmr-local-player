export function selectWorkBackground(candidates, savedPath) {
  if (savedPath === null) return { image: null, needsChoice: false };
  const remembered = candidates.find((image) => image.path === savedPath);
  if (remembered) return { image: remembered, needsChoice: false };
  return { image: candidates.length === 1 ? candidates[0] : null, needsChoice: candidates.length > 1 };
}

export function createBackgroundPicker({ onOpenChange = () => {}, onError = () => {} } = {}) {
  const dialog = document.querySelector('#backgroundDialog');
  const gallery = document.querySelector('#backgroundGallery');
  const heading = document.querySelector('#backgroundWorkName');
  const image = document.querySelector('#workBackground');
  const app = document.querySelector('#app');
  const button = document.querySelector('#backgroundButton');
  const prompted = new Set();
  let currentWork = null;
  let currentPath;
  const keyFor = (work) => `asmr-player:background:v1:${work.relativePath || work.id}`;

  function apply(candidate) {
    currentPath = candidate?.path ?? null;
    app.classList.toggle('has-background', Boolean(candidate));
    if (candidate) image.src = candidate.url;
    else image.removeAttribute('src');
  }
  function select(path) {
    if (!currentWork) return;
    const selected = currentWork.backgroundCandidates?.find((item) => item.path === path) ?? null;
    apply(selected);
    try { localStorage.setItem(keyFor(currentWork), JSON.stringify({ path: selected?.path ?? null })); } catch { /* Session selection remains usable. */ }
    dialog.close();
  }
  function open() {
    if (!currentWork) return;
    heading.textContent = currentWork.title;
    gallery.replaceChildren();
    const candidates = currentWork.backgroundCandidates ?? [];
    for (const candidate of candidates) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'background-choice';
      item.dataset.path = candidate.path;
      item.setAttribute('aria-pressed', String(candidate.path === currentPath));
      const thumb = document.createElement('img');
      thumb.src = candidate.url; thumb.alt = ''; thumb.loading = 'lazy'; thumb.decoding = 'async';
      thumb.addEventListener('error', () => { item.disabled = true; item.classList.add('unavailable'); });
      const label = document.createElement('span'); label.textContent = candidate.label;
      item.append(thumb, label); item.addEventListener('click', () => select(candidate.path));
      gallery.append(item);
    }
    if (!candidates.length) {
      const empty = document.createElement('p'); empty.className = 'field-help';
      empty.textContent = '这部作品中没有可用图片。将图片放入作品文件夹，再重新选择曲库即可。'; gallery.append(empty);
    }
    if (!dialog.open) { dialog.showModal(); onOpenChange(true); }
  }
  function workChanged(work) {
    const previousKey = currentWork ? keyFor(currentWork) : null;
    currentWork = work;
    button.disabled = !work;
    if (!work) { apply(null); if (dialog.open) dialog.close(); return; }
    const key = keyFor(work);
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key))?.path; } catch { /* Invalid saved choice is ignored. */ }
    const choice = selectWorkBackground(work.backgroundCandidates ?? [], saved);
    apply(choice.image);
    if (dialog.open && key !== previousKey) dialog.close();
    if (choice.needsChoice && !prompted.has(key) && !document.querySelector('dialog[open]')) {
      prompted.add(key); open();
    }
  }
  button.addEventListener('click', open);
  document.querySelector('#backgroundClose').addEventListener('click', () => dialog.close());
  document.querySelector('#backgroundNone').addEventListener('click', () => select(null));
  dialog.addEventListener('close', () => onOpenChange(false));
  image.addEventListener('error', () => {
    if (!image.hasAttribute('src')) return;
    apply(null); onError('背景图片无法解码，可在“作品背景”中重新选择');
  });
  return { workChanged, isOpen: () => dialog.open };
}
