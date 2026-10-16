import { runSpeechJob } from './speech-job.mjs';
import { decodeSubtitleBytes } from './subtitles.mjs';
import { displaySourceCues, exportTimedText, makeTranscriptDocument, parseTimedText, readTranscriptDocument } from './transcript.mjs';

const SETTINGS_KEY = 'asmr-player:ai-settings:v1';
const settingIds = ['asrEndpoint', 'asrModel', 'asrFormat', 'translationEndpoint', 'translationModel', 'aiSourceLanguage', 'aiTargetLanguage'];

export function safeAiSettings(values) {
  return Object.fromEntries(settingIds.flatMap((id) => {
    const value = values?.[id];
    if (typeof value !== 'string' || value.length > 2000) return [];
    if (id.endsWith('Endpoint')) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(value)) return [];
      } catch { return []; }
    }
    return [[id, value]];
  }));
}

export function createAiWorkbench({ getContext, onApply, onRestore, onOpenChange }) {
  const ids = ['aiDialog', 'aiButton', 'aiClose', 'aiForm', 'aiTaskMode', 'aiSourceLanguage', 'aiTargetLanguage', 'asrSettings', 'asrEndpoint', 'asrModel', 'asrKey', 'asrFormat', 'translationEndpoint', 'translationModel', 'translationKey', 'aiReuseConfig', 'aiGlossary', 'aiRemember', 'aiForgetKeys', 'aiDestination', 'aiStart', 'aiCancel', 'aiStatus', 'aiProgress', 'aiDisplayMode', 'aiExportFormat', 'aiExport', 'aiImport', 'aiOriginal', 'aiImportSource', 'aiImportFile', 'aiPreview', 'aiTrackInfo'];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const tasks = new Map();
  let controller = null;
  let generation = 0;
  let busy = false;

  function stateFor(key) {
    if (!tasks.has(key)) {
      if (tasks.size >= 12) tasks.delete(tasks.keys().next().value);
      tasks.set(key, { checkpoint: null, document: null });
    }
    return tasks.get(key);
  }

  function setStatus(text, error = false) {
    el.aiStatus.textContent = text;
    el.aiStatus.dataset.error = String(error);
  }

  function modeUi() {
    const audio = el.aiTaskMode.value === 'audio';
    el.asrSettings.disabled = busy || !audio;
    for (const id of ['asrEndpoint', 'asrModel', 'asrKey']) el[id].required = audio;
    el.aiStart.textContent = audio ? '开始／续做识别与翻译' : '开始／续做台本翻译';
    const host = (value) => { try { return new URL(value).host; } catch { return '尚未填写的接口'; } };
    el.aiDestination.textContent = audio
      ? `开始后，当前音轨的音频分片发送到 ${host(el.asrEndpoint.value)}，台本发送到 ${host(el.translationEndpoint.value)}。服务商可能计费；取消不会撤销已经发送的请求。`
      : `开始后，当前音轨的台本发送到 ${host(el.translationEndpoint.value)}，不发送音频。服务商可能计费。`;
  }

  function setBusy(value) {
    busy = value;
    for (const input of el.aiForm.querySelectorAll('input, select, textarea, button')) input.disabled = value;
    el.aiCancel.disabled = !value;
    el.aiForgetKeys.disabled = false;
    el.aiImport.disabled = value;
    el.aiOriginal.disabled = value;
    el.aiImportSource.disabled = value;
    el.aiStart.disabled = value || !getContext();
    modeUi();
  }

  function documentForCurrent() {
    const context = getContext();
    return context ? tasks.get(context.trackKey)?.document ?? null : null;
  }

  function renderResult(doc, apply = true) {
    const rows = (doc?.sources ?? []).flatMap((source) => displaySourceCues(source, el.aiDisplayMode.value))
      .sort((a, b) => a.start - b.start);
    el.aiExport.disabled = rows.length === 0;
    el.aiPreview.replaceChildren();
    for (const cue of rows.slice(0, 12)) {
      const p = document.createElement('p');
      const time = document.createElement('time');
      time.textContent = `${cue.start.toFixed(2)} — ${cue.end.toFixed(2)} s`;
      p.append(time, document.createTextNode(cue.text));
      el.aiPreview.append(p);
    }
    if (apply && doc) onApply(doc, el.aiDisplayMode.value);
  }

  function saveSettings() {
    try {
      if (el.aiRemember.checked) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(safeAiSettings(Object.fromEntries(settingIds.map((id) => [id, el[id].value])))));
      } else localStorage.removeItem(SETTINGS_KEY);
    } catch { /* Private browsing may disable local storage. */ }
  }

  function cancel() {
    controller?.abort();
  }

  function clearKeys() {
    cancel();
    el.asrKey.value = '';
    el.translationKey.value = '';
  }

  async function sourceBlobs(context, signal) {
    return Promise.all(context.sources.map(async (source) => {
      const input = { id: source.id, label: source.label, side: source.side, name: source.name || source.id, cues: source.cues ?? [] };
      if (el.aiTaskMode.value !== 'audio') return input;
      if (source.blob) return { ...input, blob: source.blob };
      const url = new URL(source.audioUrl, location.href);
      if (url.protocol !== 'blob:' && url.origin !== location.origin) throw new Error('音源必须来自本机选择的文件或本站本地服务');
      const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('无法读取本机音频，请重新选择曲库');
      return { ...input, blob: await response.blob() };
    }));
  }

  async function run(event) {
    event.preventDefault();
    if (busy) return;
    const context = getContext();
    if (!context) { setStatus('先在播放器选择一条音轨。', true); return; }
    const request = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    const state = stateFor(context.trackKey);
    const config = (prefix) => ({ endpoint: el[`${prefix}Endpoint`].value.trim(), model: el[`${prefix}Model`].value.trim(), apiKey: el[`${prefix}Key`].value.trim() });
    const asrConfig = config('asr');
    const translationConfig = config('translation');
    const mode = el.aiTaskMode.value;
    const canShow = () => request === generation && getContext()?.trackKey === context.trackKey;
    saveSettings();
    setBusy(true);
    el.aiProgress.removeAttribute('value');
    setStatus(mode === 'audio' ? '正在准备当前音轨的音频分片…' : '正在准备台本…');
    try {
      const sources = await sourceBlobs(context, signal);
      if (mode === 'subtitles' && state.document) {
        for (const source of sources) source.cues = state.document.sources.find((item) => item.id === source.id)?.cues ?? source.cues;
      }
      const result = await runSpeechJob({
        sources, asrConfig, translationConfig, mode,
        sourceLanguage: el.aiSourceLanguage.value, targetLanguage: el.aiTargetLanguage.value.trim(),
        responseFormat: el.asrFormat.value, glossary: el.aiGlossary.value,
        checkpoint: state.checkpoint, signal,
        onCheckpoint: (checkpoint) => {
          state.checkpoint = checkpoint;
          state.document = makeTranscriptDocument({ trackKey: context.trackKey, sources: checkpoint.sources });
          if (canShow()) renderResult(state.document);
        },
        onProgress: (progress) => {
          if (!canShow()) return;
          const stage = progress.stage === 'translation' || progress.stage === 'translating' ? '翻译台本' : '识别音频';
          setStatus(`${stage} · 音源 ${Number(progress.sourceIndex ?? 0) + 1}/${progress.sourceCount || sources.length}\n已完成 ${progress.chunksCompleted || 0} 个识别片段、${progress.batchesCompleted || 0} 批译文。可取消后在本页续做。`);
        },
      });
      state.checkpoint = result;
      state.document = makeTranscriptDocument({ trackKey: context.trackKey, sources: result.sources });
      if (canShow()) {
        renderResult(state.document);
        const count = state.document.sources.reduce((n, source) => n + source.cues.length, 0);
        el.aiProgress.value = 1;
        setStatus(count ? `完成：${count} 条字幕已应用到播放器。请试听校对，并下载 JSON 留存。` : '处理完成，模型未识别出语音；未生成空白字幕。');
      }
    } catch (error) {
      if (canShow()) {
        el.aiProgress.value = 0;
        if (signal.aborted || error.code === 'ABORTED' || error.name === 'AbortError') setStatus('已取消。已完成片段保留在本页；点击开始可续做。');
        else if (error.code === 'CHECKPOINT_MISMATCH') {
          state.checkpoint = null;
          setStatus('输入或模型设置已变化，旧任务不能续做。现有字幕仍保留；再次点击开始将按新设置重新处理并产生调用。', true);
        } else setStatus(`${error.message || '处理失败，请检查接口设置'}\n已完成片段保留；修正设置后可点击开始续做。`, true);
      }
    } finally {
      // API credentials are confined to this request closure and the user's fields.
      asrConfig.apiKey = ''; translationConfig.apiKey = '';
      if (request === generation) { controller = null; setBusy(false); }
    }
  }

  function trackChanged() {
    cancel(); ++generation; controller = null;
    setBusy(false);
    const context = getContext();
    el.aiTrackInfo.textContent = context ? `${context.title} · ${context.sources.length} 个音源` : '先选择一条音轨';
    el.aiImportSource.replaceChildren();
    for (const [index, source] of (context?.sources ?? []).entries()) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.label || (context.sources.length > 1 ? `音源 ${index + 1}` : '当前音轨');
      el.aiImportSource.append(option);
    }
    const doc = documentForCurrent();
    renderResult(doc);
    el.aiProgress.value = 0;
    setStatus(doc ? '已恢复本页面中的字幕结果。可调整显示方式、导出或续做。' : '准备就绪。成功片段保留在本页面，失败后可续做。');
  }

  el.aiButton.addEventListener('click', () => {
    el.aiDialog.showModal(); onOpenChange?.(true); modeUi();
  });
  el.aiClose.addEventListener('click', () => el.aiDialog.close());
  el.aiDialog.addEventListener('close', () => onOpenChange?.(false));
  el.aiForm.addEventListener('submit', run);
  el.aiCancel.addEventListener('click', cancel);
  el.aiForgetKeys.addEventListener('click', () => { clearKeys(); setStatus('Key 已从输入框清空；进行中的任务已请求取消。'); });
  el.aiTaskMode.addEventListener('change', modeUi);
  for (const id of ['asrEndpoint', 'translationEndpoint']) el[id].addEventListener('input', modeUi);
  el.aiRemember.addEventListener('change', saveSettings);
  el.aiReuseConfig.addEventListener('click', () => {
    try {
      const url = new URL(el.asrEndpoint.value);
      url.pathname = url.pathname.replace(/\/audio\/transcriptions\/?$/, '/chat/completions');
      el.translationEndpoint.value = url.href;
      el.translationKey.value = el.asrKey.value;
      modeUi();
    } catch { setStatus('请先填写完整的语音识别接口地址。', true); }
  });
  el.aiDisplayMode.addEventListener('change', () => renderResult(documentForCurrent()));
  el.aiOriginal.addEventListener('click', () => { onRestore(); setStatus('已还原曲库字幕；AI 结果仍可导出，或切换显示方式重新应用。'); });
  el.aiExport.addEventListener('click', () => {
    const doc = documentForCurrent();
    if (!doc) return;
    const format = el.aiExportFormat.value;
    const selected = doc.sources.find((source) => source.id === el.aiImportSource.value) ?? doc.sources[0];
    const text = format === 'json' ? JSON.stringify(makeTranscriptDocument(doc), null, 2) : exportTimedText(displaySourceCues(selected, el.aiDisplayMode.value), format);
    const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    const sourceNumber = Math.max(0, doc.sources.indexOf(selected)) + 1;
    link.download = `asmr-v0.0.4-${format === 'json' ? 'all' : `source${sourceNumber}`}-${el.aiDisplayMode.value}.${format}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  el.aiImport.addEventListener('click', () => el.aiImportFile.click());
  el.aiImportFile.addEventListener('change', async () => {
    const file = el.aiImportFile.files[0]; el.aiImportFile.value = '';
    const context = getContext();
    if (!file || !context || busy) return;
    const key = context.trackKey;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('字幕文件请控制在 20 MB 以内');
      const text = decodeSubtitleBytes(await file.arrayBuffer());
      if (getContext()?.trackKey !== key) return;
      const state = stateFor(key);
      let doc;
      if (/\.json$/i.test(file.name)) {
        doc = readTranscriptDocument(text, key);
        if (doc.sources.some((source) => !context.sources.some((current) => current.id === source.id))) throw new Error('结果中的音源与当前音轨不匹配');
      } else {
        const sourceId = el.aiImportSource.value;
        const format = file.name.split('.').at(-1).toLowerCase();
        const imported = parseTimedText(text, { sourceId, format,
          duration: context.sources.find((source) => source.id === sourceId)?.duration ?? 0 });
        const previous = state.document?.sources ?? context.sources;
        doc = makeTranscriptDocument({ trackKey: key, sources: context.sources.map((source) => ({
          ...source, cues: source.id === sourceId ? imported : previous.find((item) => item.id === source.id)?.cues ?? [],
        })) });
      }
      state.document = doc; state.checkpoint = null;
      renderResult(doc); el.aiTaskMode.value = 'subtitles'; modeUi();
      setStatus('台本已导入并应用。可直接播放，或填写文字模型后翻译。');
    } catch (error) { setStatus(error.message || '台本导入失败', true); }
  });

  try {
    const settings = safeAiSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
    if (settings && typeof settings === 'object') {
      for (const id of settingIds) if (typeof settings[id] === 'string' && settings[id].length < 2000) el[id].value = settings[id];
      el.aiRemember.checked = Object.keys(settings).length > 0;
    }
  } catch { /* An invalid saved preference never blocks playback. */ }
  modeUi();
  return { trackChanged, cancel, clearKeys, isOpen: () => el.aiDialog.open };
}
