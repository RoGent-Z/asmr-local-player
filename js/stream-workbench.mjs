import { availableRemoteFormats, createRemoteDownloadSelection, selectRemoteEntries } from './stream-library.mjs';
import { downloadRemoteWork } from './stream-download.mjs';

const bytesLabel = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export function createStreamWorkbench({ registry, onChange, onReveal = () => {}, onOpenChange = () => {}, downloadWork = downloadRemoteWork }) {
  const ids = ['streamDialog','streamButton','chooseStreamButton','streamClose','streamForm','streamUrl','streamAdd','streamCancel',
    'streamStatus','streamProgress','streamWork','streamDetails','streamFormat','streamRefresh','streamDownload','streamRemove','streamReveal',
    'streamFilesControls','streamFileList','streamSelectionCount','streamSelectAll','streamSelectNone'];
  const el = Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
  let controller = null;
  let generation = 0;
  let busy = false;
  let activeKind = null;
  let selectedId = null;
  let returnFocus = null;
  const selection = createRemoteDownloadSelection();
  const fileCheckboxes = new Map();
  const current = () => registry.works().find(work=>work.id === selectedId);
  function status(message,error = false) { el.streamStatus.textContent = message; el.streamStatus.dataset.error = String(error); }
  function setBusy(value) {
    busy = value;
    for (const name of ['streamWork','streamFormat','streamRefresh','streamRemove','streamReveal','streamSelectAll','streamSelectNone','streamFilesControls']) el[name].disabled = value || !current();
    el.streamCancel.disabled = !value;
    el.streamAdd.textContent = value ? '添加另一作品' : '添加作品';
    updateSelectionUi();
  }
  function updateSelectionUi() {
    const work = current();
    const items = work ? selection.entries(work) : [];
    const checked = items.filter(item=>item.checked).length;
    for (const {entry,checked} of items) {
      const checkbox = fileCheckboxes.get(entry.path); if (checkbox) checkbox.checked = checked;
    }
    el.streamSelectionCount.textContent = `${checked}/${items.length} 已选`;
    el.streamDownload.disabled = busy || checked === 0;
  }
  function renderFiles(work) {
    el.streamFileList.replaceChildren(); fileCheckboxes.clear();
    if (!work) { const empty=document.createElement('p');empty.className='field-help';empty.textContent='添加作品后可按文件选择下载。';el.streamFileList.append(empty);return; }
    for (const {entry,checked} of selection.entries(work)) {
      const row=document.createElement('label');row.className='stream-file-choice';row.title=entry.path;
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=checked;checkbox.dataset.path=entry.path;
      checkbox.addEventListener('change',()=>{selection.set(work,entry.path,checkbox.checked);updateSelectionUi();});
      const description=document.createElement('span');description.className='stream-file-description';
      const path=document.createElement('span');path.className='stream-file-path';path.textContent=entry.path;
      const meta=document.createElement('small');meta.className='stream-file-meta';
      meta.textContent = `${entry.official ? '官方封面' : entry.type === 'audio' ? '音频' : entry.type === 'subtitle' ? '字幕' : '图片'}${entry.size ? ` · ${bytesLabel(entry.size)}` : ''}`;
      description.append(path,meta);row.append(checkbox,description);el.streamFileList.append(row);fileCheckboxes.set(entry.path,checkbox);
    }
  }
  function render() {
    const works = registry.works();
    if (!works.some(work=>work.id === selectedId)) selectedId = works[0]?.id ?? null;
    el.streamWork.replaceChildren();
    if (!works.length) { const option = document.createElement('option'); option.textContent = '尚未添加在线作品'; el.streamWork.append(option); }
    for (const work of works) {
      const option = document.createElement('option'); option.value = work.id; option.textContent = work.code ? `${work.code} · ${work.title}` : work.title;
      option.title = work.title; option.selected = work.id === selectedId; el.streamWork.append(option);
    }
    const work = current();
    el.streamFormat.replaceChildren();
    for (const format of availableRemoteFormats(work?.rawEntries ?? [])) {
      const option=document.createElement('option');option.value=format;
      option.textContent=format === 'all' ? '全部音频格式' : format.toUpperCase();
      option.selected=format === work?.format;el.streamFormat.append(option);
    }
    el.streamFormat.value = work?.format ?? 'all';
    const entries = work ? selectRemoteEntries(work.rawEntries,work.format) : [];
    const total = entries.reduce((sum,entry)=>sum + (entry.size || 0),0);
    el.streamDetails.textContent = work ? `${work.tracks.length} 条音轨 · ${entries.filter(e=>e.type === 'image').length} 张目录图片${total ? ` · 已知文件大小 ${bytesLabel(total)}` : ''}` : '添加后自动读取封面、图片和音轨目录。';
    renderFiles(work);
    setBusy(busy);
  }
  function cancel() {
    const download = activeKind === 'download';
    generation += 1; controller?.abort(); controller = null; setBusy(false);
    activeKind = null; el.streamProgress.value = 0;
    status(download ? '已取消下载。已经交给浏览器的下载需在浏览器中管理。' : '已取消读取作品。');
  }
  async function resolve(value) {
    controller?.abort(); const request = ++generation; controller = new AbortController(); const signal = controller.signal;
    activeKind = 'resolve'; setBusy(true); el.streamProgress.removeAttribute('value'); status('正在读取作品信息与目录…');
    try {
      const work = await registry.resolve(value,{signal});
      if (request !== generation || signal.aborted) return;
      selectedId = work.id; await onChange(work); if (request !== generation) return;
      render(); el.streamProgress.value = 1;
      status(registry.persistenceFailed() ? '已添加，可立即播放。浏览器未能保存目录，刷新后需重新添加。' : '已添加到作品库。可直接播放，刷新后保留目录与播放进度。');
    } catch (error) {
      if (request !== generation) return;
      el.streamProgress.value = 0;
      status(signal.aborted ? '已取消读取作品。' : error.message || '读取失败，请稍后重试。', !signal.aborted);
    } finally { if (request === generation) { controller = null; activeKind = null; setBusy(false); } }
  }
  async function download() {
    const work = current(); if (!work || busy) return;
    const entries = selection.selectedEntries(work);
    if (!entries.length) { status('请至少选择一个下载文件。'); return; }
    const request = ++generation; controller = new AbortController(); const signal = controller.signal;
    activeKind = 'download'; setBusy(true); el.streamProgress.value = 0; status('正在准备下载…');
    try {
      // Call within the click event, before awaiting anything, to retain the picker gesture.
      const result = await downloadWork({ code:work.code,title:work.title,entries,signal,onProgress(progress) {
        if (request !== generation) return;
        el.streamProgress.value = progress.total ? progress.completed / progress.total : 0;
        status(`下载中 · ${progress.completed || 0}/${progress.total || entries.length} 个文件 · ${bytesLabel(progress.bytes || 0)}`);
      } });
      if (request !== generation) return;
      el.streamProgress.value = 1;
      status(result.status === 'saved' ? `已保存 ${result.files} 个文件 · ${bytesLabel(result.bytes)}。`
        : `已将 ${result.files} 个文件的下载交给浏览器。请在浏览器下载列表确认完成，手机也可在“文件”或下载目录查看。`);
    } catch (error) {
      if (request !== generation) return;
      el.streamProgress.value = 0;
      status(signal.aborted || error.name === 'AbortError' ? '已取消下载。已交给浏览器的文件需在浏览器中管理。' : error.message || '下载失败，请重试。', !signal.aborted);
    } finally { if (request === generation) { controller = null; activeKind = null; setBusy(false); } }
  }
  function open(work, trigger) {
    if (work) selectedId = work.id;
    returnFocus = trigger ?? document.activeElement;
    render(); if (!el.streamDialog.open) el.streamDialog.showModal(); onOpenChange(true);
    if (!work) el.streamUrl.focus();
  }
  el.streamButton.addEventListener('click',()=>open(null,el.streamButton));
  el.chooseStreamButton.addEventListener('click',()=>open(null,el.chooseStreamButton));
  el.streamClose.addEventListener('click',()=>el.streamDialog.close());
  el.streamDialog.addEventListener('keydown',event=>{
    if (event.key !== 'Tab') return;
    const focusable=[...el.streamDialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
      .filter(node=>node.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  el.streamDialog.addEventListener('close',()=>{
    onOpenChange(false);
    const focusKey = returnFocus?.dataset?.focusKey;
    const keyed = focusKey ? [...document.querySelectorAll('[data-focus-key]')].find(node=>node.dataset.focusKey === focusKey) : null;
    const target = [returnFocus?.isConnected ? returnFocus : null,keyed,
      document.querySelector?.('#drawer.open #closeDrawerButton'),el.streamButton,document.getElementById('actionsButton'),document.getElementById('menuButton')]
      .find(node=>node && (!node.getClientRects || node.getClientRects().length) && !node.closest?.('[inert]'));
    target?.focus({preventScroll:true});
  });
  el.streamForm.addEventListener('submit',event=>{event.preventDefault(); resolve(el.streamUrl.value);});
  el.streamCancel.addEventListener('click',cancel);
  el.streamWork.addEventListener('change',()=>{selectedId = el.streamWork.value;render();});
  el.streamFormat.addEventListener('change',async()=>{
    try { const work = registry.setFormat(selectedId,el.streamFormat.value); if (work) await onChange(work); render(); status('已切换播放与下载格式。'); }
    catch (error) { render();status(error.message,true); }
  });
  el.streamRefresh.addEventListener('click',()=>{if (current()) resolve(current().sourceUrl);});
  el.streamRemove.addEventListener('click',async()=>{if (busy || !current()) return; selection.forget(selectedId);registry.remove(selectedId); await onChange(); render();status('已从在线作品库移除。');});
  for (const [name,checked] of [['streamSelectAll',true],['streamSelectNone',false]]) el[name].addEventListener('click',()=>{
    const work=current();if(!work || busy)return;selection.setAll(work,checked);updateSelectionUi();
  });
  el.streamDownload.addEventListener('click',download);
  el.streamReveal.addEventListener('click',()=>{const work=current();if(work){returnFocus=null;el.streamDialog.close();onReveal(work);}});
  render();
  return { open, cancel, isOpen:()=>el.streamDialog.open };
}
