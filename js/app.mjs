import { sourceToPresentation } from './alignment.mjs';
import { buildTrackPlayback } from './playback-mode.mjs';
import { createAiWorkbench } from './ai-workbench.mjs';
import { createBackgroundPicker } from './background.mjs';
import { displaySourceCues } from './transcript.mjs';
import {
  activeDialogueIds,
  buildDialogueItems,
} from './dialogue-list.mjs';
import { dialoguePanTarget } from './dialogue-focus.mjs';
import {
  findAdjacentTrack,
  loadWorkState,
  resumeTime,
  saveWorkState,
} from './player-state.mjs';
import {
  countFolderTracks,
  resolveCategoryWorks,
  resolveFolderTracks,
} from './library-tree.mjs';
import { createPairedPlayer } from './paired-player.mjs';
import { loadInitialLibrary } from './library-source.mjs';
import { scanLocalFiles } from './local-library.mjs';
import {
  heuristicFallback,
  selectVisualReference,
  semanticFrameAt,
  trackProfileKey,
} from './semantic-visuals.mjs';
import { createSpectrumRenderer } from './spectrum.mjs';
import { assignSourceIdentity, decodeSubtitleBytes, parseSubtitle } from './subtitles.mjs';

const elements = {
  app: document.querySelector('#app'),
  actionsButton: document.querySelector('#actionsButton'),
  topbarActions: document.querySelector('#topbarActions'),
  audioLeft: document.querySelector('#audioLeft'),
  audioRight: document.querySelector('#audioRight'),
  centerSpectrum: document.querySelector('#centerSpectrum'),
  centerSubtitles: document.querySelector('#centerSubtitles'),
  closeDialogueButton: document.querySelector('#closeDialogueButton'),
  closeDrawerButton: document.querySelector('#closeDrawerButton'),
  chooseFolderButton: document.querySelector('#chooseFolderButton'),
  chooseFilesButton: document.querySelector('#chooseFilesButton'),
  currentTime: document.querySelector('#currentTime'),
  dialogueButton: document.querySelector('#dialogueButton'),
  dialogueDrawer: document.querySelector('#dialogueDrawer'),
  dialogueList: document.querySelector('#dialogueList'),
  drawer: document.querySelector('#drawer'),
  drawerScrim: document.querySelector('#drawerScrim'),
  duration: document.querySelector('#duration'),
  fullscreenButton: document.querySelector('#fullscreenButton'),
  folderInput: document.querySelector('#folderInput'),
  filesInput: document.querySelector('#filesInput'),
  importStatus: document.querySelector('#importStatus'),
  leftSpectrum: document.querySelector('#leftSpectrum'),
  leftSubtitles: document.querySelector('#leftSubtitles'),
  library: document.querySelector('#library'),
  libraryWelcome: document.querySelector('#libraryWelcome'),
  listeningMode: document.querySelector('#listeningMode'),
  syncMode: document.querySelector('#syncMode'),
  menuButton: document.querySelector('#menuButton'),
  mobileSubtitles: document.querySelector('#mobileSubtitles'),
  nextButton: document.querySelector('#nextButton'),
  openFolderButton: document.querySelector('#openFolderButton'),
  openFilesButton: document.querySelector('#openFilesButton'),
  playButton: document.querySelector('#playButton'),
  previousButton: document.querySelector('#previousButton'),
  progress: document.querySelector('#progress'),
  rate: document.querySelector('#rate'),
  rightSpectrum: document.querySelector('#rightSpectrum'),
  rightSubtitles: document.querySelector('#rightSubtitles'),
  subtitleStatus: document.querySelector('#subtitleStatus'),
  toast: document.querySelector('#toast'),
  trackTitle: document.querySelector('#trackTitle'),
  volume: document.querySelector('#volume'),
  voiceAtmosphere: document.querySelector('#voiceAtmosphere'),
  workTitle: document.querySelector('#workTitle'),
};

let works = [];
let categories = [];
let workIndex = 0;
let trackIndex = 0;
let cues = [];
let semanticTimeline = [];
let semanticProfiles = {};
let dialogueItems = [];
let activeDrawer = null;
let hideTimer = null;
let toastTimer = null;
let loadRequest = 0;
let lastSubtitleSignature = '';
let lastDialogueSignature = '';
let lastDialogueAutoScrollId = null;
let dialogueManualScrollUntil = 0;
let lastPersistAt = 0;
let localLibrary = null;
let importRequest = 0;
let trackReady = false;
let preparedTrack = null;
let aiDocument = null;
let aiDisplayMode = 'bilingual';
let aiWorkbench = null;
let backgroundPicker = null;
const libraryMode = document.querySelector('meta[name="library-source"]')?.content ?? 'local-files';
let activeDialogueItemIds = new Set();
const dialogueNodes = new Map();
let currentSourceStates = {
  left: { active: false },
  right: { active: false },
};
const expandedWorks = new Set();
const expandedFolders = new Set();
const expandedCollections = new Set();

const spectrum = createSpectrumRenderer({
  leftAudio: elements.audioLeft,
  rightAudio: elements.audioRight,
  atmosphereCanvas: elements.voiceAtmosphere,
  leftCanvas: elements.leftSpectrum,
  centerCanvas: elements.centerSpectrum,
  rightCanvas: elements.rightSpectrum,
  onCharacterColors: ({ left, right }) => {
    elements.app.style.setProperty('--dialogue-left-color', left);
    elements.app.style.setProperty('--dialogue-right-color', right);
  },
});

let player = null;
player = createPairedPlayer({
  leftAudio: elements.audioLeft,
  rightAudio: elements.audioRight,
  onTime: ({ currentTime, duration, sources }) => {
    currentSourceStates = sources;
    updateProgress(currentTime, duration);
    renderActiveSubtitles(currentTime);
    updateActiveDialogue(currentTime);
    spectrum.setSemanticFrame(semanticFrameAt(semanticTimeline, currentTime));
    spectrum.setDialogueFocus(dialoguePanTarget(cues, currentTime, {
      paired: currentTrack()?.mode === 'paired',
    }));
    spectrum.setSourcePlaying({
      left: !player.paused() && sources.left.active,
      right: !player.paused() && sources.right.active,
    });
    if (performance.now() - lastPersistAt > 1000) {
      lastPersistAt = performance.now();
      persistCurrent();
    }
  },
  onPlayState: (playing) => {
    elements.playButton.textContent = playing ? 'Ⅱ' : '▶';
    elements.playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
    if (playing) {
      scheduleHide();
    } else {
      spectrum.setSourcePlaying({ left: false, right: false });
      persistCurrent();
      showUi();
    }
  },
  onEnded: () => {
    spectrum.reset();
    persistCurrent();
    if (!moveTrack(1, true)) showUi();
  },
  onError: () => {
    showToast('浏览器阻止了音频播放，请再次点击播放');
  },
});

function currentWork() {
  return works[workIndex] ?? null;
}

function currentTrack() {
  return currentWork()?.tracks[trackIndex] ?? null;
}

function getAiContext() {
  if (!trackReady || !preparedTrack) return null;
  const track = currentTrack();
  const work = currentWork();
  const sources = track.sources.map((source) => ({
    ...source, name: source.id, blob: localLibrary?.getFile(source.audioUrl) ?? null,
    duration: source.side === 'right' ? preparedTrack.rightDuration : preparedTrack.leftDuration,
    cues: (preparedTrack.sourceCues[source.id] ?? []).map((cue, index) => ({
      id: `${source.id}:${index}`, start: cue.start, end: cue.end, text: cue.text,
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
    })),
  }));
  const trackKey = JSON.stringify([work.id, track.id, ...sources.map((source) => [source.id, source.blob?.size ?? 0, source.blob?.lastModified ?? 0])]);
  return { trackKey, title: `${work.title} · ${track.title}`, sources };
}

function aiPresentationCues(doc, mode) {
  if (!preparedTrack) return [];
  return doc.sources.flatMap((source) => {
      const side = currentTrack().mode === 'paired' && source.side === 'right' ? 'right' : 'left';
      return displaySourceCues(source, mode).map((cue) => ({
        ...cue,
        start: sourceToPresentation(preparedTrack.alignment.sides[side], cue.start, 'next'),
        end: sourceToPresentation(preparedTrack.alignment.sides[side], cue.end, 'previous'),
      })).filter((cue) => cue.end > cue.start);
    }).sort((a, b) => a.start - b.start);
}

function refreshTrackCues() {
  if (!preparedTrack) return;
  if (aiDocument) {
    cues = aiPresentationCues(aiDocument, aiDisplayMode);
    elements.subtitleStatus.textContent = cues.length ? 'AI 字幕已应用' : 'AI 处理中';
  } else {
    cues = preparedTrack.cues;
    elements.subtitleStatus.textContent = cues.length
      ? preparedTrack.paired ? elements.syncMode.value === 'subtitle' ? '双轨字幕已对齐' : '原声 · 双轨字幕' : '字幕已同步'
      : preparedTrack.subtitleErrors?.length ? '字幕读取失败' : '无字幕';
    elements.subtitleStatus.title = preparedTrack.subtitleErrors?.join('\n') ?? '';
  }
  dialogueItems = buildDialogueItems(cues);
  renderDialogueList(); clearSubtitles();
  renderActiveSubtitles(player.currentTime()); updateActiveDialogue(player.currentTime(), true);
}

function configureListening() {
  const track = currentTrack();
  if (!track) return;
  const paired = track.mode === 'paired';
  const left = track.sources.find((source) => source.side === 'left') ?? track.sources[0];
  const right = track.sources.find((source) => source.side === 'right');
  spectrum.configure({ paired, listeningMode: paired ? elements.listeningMode.value : 'binaural', leftPalette: left?.hairPalette, rightPalette: right?.hairPalette });
  elements.syncMode.disabled = !paired;
  for (const option of elements.listeningMode.options) option.disabled = !paired && option.value !== 'binaural';
  if (!paired) elements.listeningMode.value = 'binaural';
}

aiWorkbench = createAiWorkbench({
  getContext: getAiContext,
  onApply: (doc, mode) => { aiDocument = doc; aiDisplayMode = mode; refreshTrackCues(); },
  onRestore: () => { aiDocument = null; refreshTrackCues(); },
  onOpenChange: (open) => { if (open) { setActiveDrawer(null); window.clearTimeout(hideTimer); } showUi(); },
});
backgroundPicker = createBackgroundPicker({
  onOpenChange: (open) => { if (open) setActiveDrawer(null); showUi(); },
  onError: showToast,
});

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = window.setTimeout(
    () => elements.toast.classList.remove('visible'),
    2600,
  );
}

function setActiveDrawer(nextDrawer) {
  activeDrawer = nextDrawer;
  const libraryOpen = nextDrawer === 'library';
  const dialogueOpen = nextDrawer === 'dialogue';
  elements.drawer.classList.toggle('open', libraryOpen);
  elements.dialogueDrawer.classList.toggle('open', dialogueOpen);
  elements.drawerScrim.classList.toggle('visible', Boolean(nextDrawer));
  elements.menuButton.setAttribute('aria-expanded', String(libraryOpen));
  elements.dialogueButton.setAttribute('aria-expanded', String(dialogueOpen));
  if (dialogueOpen) updateActiveDialogue(player.currentTime(), true);
  showUi();
}

function scheduleHide() {
  window.clearTimeout(hideTimer);
  if (!player.paused() && activeDrawer === null && !aiWorkbench?.isOpen()
    && !backgroundPicker?.isOpen() && !matchMedia('(pointer: coarse)').matches) {
    hideTimer = window.setTimeout(() => {
      elements.app.classList.add('ui-hidden');
    }, 3000);
  }
}

function showUi() {
  elements.app.classList.remove('ui-hidden');
  scheduleHide();
}

function renderSubtitleColumn(element, lines) {
  element.replaceChildren();
  for (const line of lines) {
    const node = document.createElement('div');
    node.className = 'subtitle-line';
    node.textContent = line;
    element.append(node);
  }
}

function clearSubtitles() {
  lastSubtitleSignature = '';
  renderSubtitleColumn(elements.leftSubtitles, []);
  renderSubtitleColumn(elements.rightSubtitles, []);
  renderSubtitleColumn(elements.centerSubtitles, []);
  elements.mobileSubtitles.replaceChildren();
}

async function saveSemanticProfile(profile) {
  if (!profile?.key || profile.cueCount === 0) return;
  // Legacy write disabled. Cloud v2 profiles are only written by
  // the import tool, not by the browser during playback.
  semanticProfiles[profile.key] = profile;
}

function renderActiveSubtitles(time) {
  if (cues.length === 0) {
    clearSubtitles();
    return;
  }
  const active = cues.filter((cue) => time >= cue.start && time < cue.end);
  const groups = { left: [], right: [], center: [] };
  for (const cue of active) {
    for (const segment of cue.segments) {
      groups[segment.side].push(segment.text);
    }
  }

  const signature = JSON.stringify(groups);
  if (signature === lastSubtitleSignature) return;
  lastSubtitleSignature = signature;
  renderSubtitleColumn(elements.leftSubtitles, groups.left);
  renderSubtitleColumn(elements.rightSubtitles, groups.right);
  renderSubtitleColumn(elements.centerSubtitles, groups.center);
  elements.mobileSubtitles.replaceChildren();
  for (const cue of active) {
    for (const segment of cue.segments) {
      const node = document.createElement('div'); node.className = 'subtitle-line mobile-subtitle';
      node.dataset.side = segment.side;
      const side = document.createElement('span'); side.className = 'mobile-subtitle-side';
      side.textContent = segment.side === 'left' ? '左' : segment.side === 'right' ? '右' : '声';
      node.append(side, document.createTextNode(segment.text));
      elements.mobileSubtitles.append(node);
    }
  }
}

function renderDialogueList() {
  elements.dialogueList.replaceChildren();
  dialogueNodes.clear();
  activeDialogueItemIds = new Set();
  lastDialogueSignature = '';
  lastDialogueAutoScrollId = null;

  if (dialogueItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前音轨没有可用台词。';
    elements.dialogueList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of dialogueItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dialogue-item';
    button.dataset.dialogueId = item.id;
    button.dataset.side = item.side;
    button.dataset.start = String(item.start);
    button.dataset.end = String(item.end);
    button.setAttribute('aria-label', `${formatTime(item.start)} 跳转到台词`);

    const time = document.createElement('span');
    time.className = 'dialogue-time';
    time.textContent = formatTime(item.start);
    const side = document.createElement('span');
    side.className = 'dialogue-side';
    side.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'dialogue-text';
    text.textContent = item.text;
    button.append(time, side, text);
    button.addEventListener('click', () => {
      player.seek(item.start);
      updateActiveDialogue(item.start, true);
    });
    dialogueNodes.set(item.id, button);
    fragment.append(button);
  }
  elements.dialogueList.append(fragment);
}

function updateActiveDialogue(time, forceScroll = false) {
  const nextIds = activeDialogueIds(dialogueItems, time);
  const signature = nextIds.join('|');
  const changed = signature !== lastDialogueSignature;
  if (changed) {
    for (const id of activeDialogueItemIds) {
      if (!nextIds.includes(id)) dialogueNodes.get(id)?.classList.remove('active');
    }
    for (const id of nextIds) {
      if (!activeDialogueItemIds.has(id)) {
        dialogueNodes.get(id)?.classList.add('active');
      }
    }
    activeDialogueItemIds = new Set(nextIds);
    lastDialogueSignature = signature;
  }

  const firstId = nextIds[0] ?? null;
  const canAutoScroll = activeDrawer === 'dialogue'
    && firstId
    && (forceScroll || performance.now() >= dialogueManualScrollUntil)
    && (forceScroll || (changed && firstId !== lastDialogueAutoScrollId));
  if (canAutoScroll) {
    dialogueNodes.get(firstId)?.scrollIntoView({
      block: 'center',
      behavior: forceScroll ? 'auto' : 'smooth',
    });
    lastDialogueAutoScrollId = firstId;
  }
}

function updateProgress(time, duration) {
  elements.currentTime.textContent = formatTime(time);
  elements.duration.textContent = formatTime(duration);
  elements.progress.value = duration > 0
    ? String(Math.round((time / duration) * 1000))
    : '0';
}

function persistCurrent() {
  const work = currentWork();
  const track = currentTrack();
  if (!trackReady || !work || !track || player.duration() <= 0) return;
  saveWorkState(localStorage, work.id, {
    trackId: track.id,
    currentTime: player.currentTime(),
    volume: Number(elements.volume.value),
    rate: Number(elements.rate.value),
  });
  localStorage.setItem('asmr-player:last-work', work.id);
}

function folderKey(workId, folderPath) {
  return `${workId}\u0000${folderPath}`;
}

function expandTrackFolders(work, folderPath) {
  if (!folderPath) return;
  const parts = folderPath.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    expandedFolders.add(folderKey(work.id, parts.slice(0, index).join('/')));
  }
}

function createTrackButton(work, track, candidateWorkIndex) {
  const candidateTrackIndex = work.tracks.findIndex(
    (candidate) => candidate.id === track.id,
  );
  if (candidateTrackIndex === -1) return null;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `track-button${
    candidateWorkIndex === workIndex && candidateTrackIndex === trackIndex
      ? ' active'
      : ''
  }`;
  const number = document.createElement('span');
  number.className = 'track-number';
  number.textContent = track.trackNumber === null
    ? String(candidateTrackIndex + 1).padStart(2, '0')
    : String(track.trackNumber).padStart(2, '0');
  const title = document.createElement('span');
  title.className = 'track-name';
  title.textContent = track.title;
  const badge = document.createElement('span');
  badge.className = 'track-badge';
  badge.textContent = track.mode === 'paired'
    ? '双音轨'
    : track.sources[0].subtitleUrl ? (track.sources[0].subtitleFormat || 'vtt').toUpperCase() : '无字幕';
  button.append(number, title, badge);
  button.addEventListener('click', () => {
    selectTrack(candidateWorkIndex, candidateTrackIndex, true);
    setActiveDrawer(null);
  });
  return button;
}

function renderFolderTracks(container, work, node, candidateWorkIndex, depth) {
  const tracks = resolveFolderTracks(work.tracks, node);
  if (tracks.length === 0) return;
  const list = document.createElement('div');
  list.className = 'folder-track-list';
  list.style.setProperty('--folder-depth', String(depth));
  for (const track of tracks) {
    const button = createTrackButton(work, track, candidateWorkIndex);
    if (button) list.append(button);
  }
  if (list.childElementCount > 0) container.append(list);
}

function renderFolderNode(work, node, candidateWorkIndex, depth) {
  const key = folderKey(work.id, node.path);
  const expanded = expandedFolders.has(key);
  const folder = document.createElement('section');
  folder.className = `folder-node${expanded ? ' expanded' : ''}`;
  folder.style.setProperty('--folder-depth', String(depth));

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'folder-header';
  header.setAttribute('aria-expanded', String(expanded));
  const chevron = document.createElement('span');
  chevron.className = 'folder-chevron';
  chevron.textContent = '⌄';
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = node.name;
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(countFolderTracks(work.tracks, node));
  header.append(chevron, name, count);
  header.addEventListener('click', () => {
    if (expandedFolders.has(key)) expandedFolders.delete(key);
    else expandedFolders.add(key);
    renderLibrary();
  });

  const children = document.createElement('div');
  children.className = 'folder-children';
  renderFolderTracks(
    children,
    work,
    node,
    candidateWorkIndex,
    depth + 1,
  );
  for (const child of node.children ?? []) {
    children.append(renderFolderNode(
      work,
      child,
      candidateWorkIndex,
      depth + 1,
    ));
  }
  folder.append(header, children);
  return folder;
}

function createWorkCard(work, candidateWorkIndex) {
  const card = document.createElement('section');
  const expanded = expandedWorks.has(work.id);
  card.className = `work-card${candidateWorkIndex === workIndex ? ' active' : ''}${expanded ? ' expanded' : ''}`;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'work-header';
  header.setAttribute('aria-expanded', String(expanded));
  const heading = document.createElement('div');
  heading.style.minWidth = '0';
  const name = document.createElement('div');
  name.className = 'work-name';
  name.textContent = work.title;
  const meta = document.createElement('div');
  meta.className = 'work-meta';
  meta.textContent = `${work.tracks.length} 条音轨`;
  heading.append(name, meta);
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '⌄';
  header.append(heading, chevron);
  header.addEventListener('click', () => {
    if (expandedWorks.has(work.id)) expandedWorks.delete(work.id);
    else expandedWorks.add(work.id);
    renderLibrary();
  });

  const list = document.createElement('div');
  list.className = 'track-list';
  if (work.folderTree) {
    renderFolderTracks(list, work, work.folderTree, candidateWorkIndex, 0);
    for (const child of work.folderTree.children ?? []) {
      list.append(renderFolderNode(work, child, candidateWorkIndex, 0));
    }
  } else {
    for (const track of work.tracks) {
      const button = createTrackButton(work, track, candidateWorkIndex);
      if (button) list.append(button);
    }
  }

  const thumbnail = document.createElement('div');
  thumbnail.className = 'work-thumbnail';
  if (work.thumbnailUrl) {
    const image = document.createElement('img');
    image.src = work.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      thumbnail.classList.add('missing');
      image.remove();
    });
    thumbnail.append(image);
  } else {
    thumbnail.classList.add('missing');
  }

  card.append(header, list, thumbnail);
  return card;
}

function renderCategoryNode(category) {
  const categoryWorks = resolveCategoryWorks(works, category);
  const expanded = expandedCollections.has(category.id);
  const collection = document.createElement('section');
  collection.className = `collection-node${expanded ? ' expanded' : ''}`;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'collection-header';
  header.setAttribute('aria-expanded', String(expanded));
  const chevron = document.createElement('span');
  chevron.className = 'collection-chevron';
  chevron.textContent = '⌄';
  const name = document.createElement('span');
  name.className = 'collection-name';
  name.textContent = category.title;
  const count = document.createElement('span');
  count.className = 'collection-count';
  count.textContent = `${categoryWorks.length} 部`;
  header.append(chevron, name, count);
  header.addEventListener('click', () => {
    if (expandedCollections.has(category.id)) {
      expandedCollections.delete(category.id);
    } else {
      expandedCollections.add(category.id);
    }
    renderLibrary();
  });

  const body = document.createElement('div');
  body.className = 'collection-works';
  for (const work of categoryWorks) {
    const candidateWorkIndex = works.findIndex(
      (candidate) => candidate.id === work.id,
    );
    if (candidateWorkIndex !== -1) {
      body.append(createWorkCard(work, candidateWorkIndex));
    }
  }
  collection.append(header, body);
  return collection;
}

function renderLibrary() {
  elements.library.replaceChildren();
  if (works.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '没有发现一级 RJ* 作品文件夹。';
    elements.library.append(empty);
    return;
  }

  const renderedCategories = categories.length > 0
    ? categories
    : [{ id: '', title: '', workIds: works.map((work) => work.id) }];
  for (const category of renderedCategories) {
    const categoryWorks = resolveCategoryWorks(works, category);
    if (category.id === '') {
      for (const work of categoryWorks) {
        const candidateWorkIndex = works.findIndex(
          (candidate) => candidate.id === work.id,
        );
        if (candidateWorkIndex !== -1) {
          elements.library.append(createWorkCard(work, candidateWorkIndex));
        }
      }
    } else if (categoryWorks.length > 0) {
      elements.library.append(renderCategoryNode(category));
    }
  }
}

function loadMedia(audio, url) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', failed);
    };
    const loaded = () => {
      cleanup();
      resolve(audio.duration);
    };
    const failed = () => {
      cleanup();
      reject(new Error('audio metadata failed'));
    };
    audio.addEventListener('loadedmetadata', loaded, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.src = url;
    audio.load();
  });
}

function clearRightMedia() {
  elements.audioRight.pause();
  elements.audioRight.removeAttribute('src');
  elements.audioRight.load();
}

async function fetchSubtitles(source, speakerSides, durationPromise) {
  const url = source.subtitleUrl;
  if (!url) return { cues: [], speakerSides: {} };
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('字幕文件无法读取');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('字幕文件请控制在 20 MB 以内');
  const parsed = parseSubtitle(decodeSubtitleBytes(bytes), { format: source.subtitleFormat || 'vtt', speakerSides, duration: await durationPromise });
  return { ...parsed, cues: assignSourceIdentity(parsed.cues, source) };
}

async function prepareTrack(track, requestId) {
  const leftSource = track.sources.find((source) => source.side === 'left')
    ?? track.sources[0];
  const rightSource = track.sources.find((source) => source.side === 'right')
    ?? null;
  const paired = track.mode === 'paired' && Boolean(rightSource);

  const leftDurationPromise = loadMedia(elements.audioLeft, leftSource.audioUrl);
  const rightDurationPromise = paired
    ? loadMedia(elements.audioRight, rightSource.audioUrl)
    : Promise.resolve(0);
  if (!paired) clearRightMedia();

  const subtitlePromises = paired
    ? [
      fetchSubtitles(leftSource, track.labelSides, leftDurationPromise),
      fetchSubtitles(rightSource, track.labelSides, rightDurationPromise),
    ]
    : [fetchSubtitles(leftSource, undefined, leftDurationPromise)];
  const [durations, subtitleResults] = await Promise.all([
    Promise.all([leftDurationPromise, rightDurationPromise]),
    Promise.allSettled(subtitlePromises),
  ]);
  if (requestId !== loadRequest) return null;

  const [leftDuration, rightDuration] = durations;
  const subtitleErrors = subtitleResults.filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || '字幕读取失败');
  if (paired) {
    const leftParsed = subtitleResults[0].status === 'fulfilled'
      ? subtitleResults[0].value
      : { cues: [] };
    const rightParsed = subtitleResults[1].status === 'fulfilled'
      ? subtitleResults[1].value
      : { cues: [] };
    const playback = buildTrackPlayback({ leftDuration, rightDuration, leftCues: leftParsed.cues, rightCues: rightParsed.cues, paired, syncMode: elements.syncMode.value });
    return {
      ...playback,
      leftDuration, rightDuration,
      sourceCues: { [leftSource.id]: leftParsed.cues, [rightSource.id]: rightParsed.cues },
      paired,
      subtitleErrors,
      subtitlesAvailable: leftParsed.cues.length + rightParsed.cues.length > 0,
    };
  }

  const parsed = subtitleResults[0].status === 'fulfilled'
    ? subtitleResults[0].value
    : { cues: [] };
  const playback = buildTrackPlayback({ leftDuration, leftCues: parsed.cues });
  return {
    ...playback,
    leftDuration, rightDuration: 0,
    sourceCues: { [leftSource.id]: parsed.cues },
    paired: false,
    subtitleErrors,
    cues: parsed.cues,
    subtitlesAvailable: parsed.cues.length > 0,
  };
}

async function playAudio() {
  if (!currentTrack() || !trackReady) return;
  await spectrum.ensureAudioGraph();
  player.play();
}

async function selectTrack(nextWorkIndex, nextTrackIndex, autoplay = false) {
  persistCurrent();
  player.pause();
  trackReady = false;
  preparedTrack = null; aiDocument = null;
  aiWorkbench?.trackChanged();
  spectrum.reset();
  const graphPromise = autoplay
    ? spectrum.ensureAudioGraph()
    : Promise.resolve();
  const requestId = ++loadRequest;
  workIndex = nextWorkIndex;
  trackIndex = nextTrackIndex;
  const work = currentWork();
  const track = currentTrack();
  if (!work || !track) return;

  backgroundPicker.workChanged(work);

  cues = [];
  semanticTimeline = [];
  spectrum.setSemanticFrame(null);
  spectrum.setDialogueFocus(null);
  dialogueItems = [];
  renderDialogueList();
  expandedWorks.add(work.id);
  if (work.categoryPath) expandedCollections.add(work.categoryPath);
  expandTrackFolders(work, track.folderPath);
  localStorage.setItem('asmr-player:last-work', work.id);
  elements.workTitle.textContent = work.title;
  elements.trackTitle.textContent = track.title;
  elements.subtitleStatus.textContent = '载入中';
  document.title = `${track.title} · ASMR v0.0.3`;
  const semanticKey = trackProfileKey(work.id, track.id);
  const visualReference = selectVisualReference(
    work.visualReferenceUrls,
    semanticKey,
  ) ?? work.thumbnailUrl;
  spectrum.setPaletteFromImage(visualReference);
  clearSubtitles();
  updateProgress(0, 0);
  renderLibrary();
  showUi();

  const saved = loadWorkState(localStorage, work.id);
  elements.volume.value = String(saved.volume);
  elements.rate.value = String(saved.rate);

  try {
    const prepared = await prepareTrack(track, requestId);
    if (!prepared || requestId !== loadRequest) return;
    preparedTrack = prepared;
    if (prepared.subtitleErrors.length) showToast(prepared.subtitleErrors.join('；'));
    cues = prepared.cues;
    const semanticKey = trackProfileKey(work.id, track.id);
    const cachedProfile = semanticProfiles[semanticKey];
    if (cachedProfile) {
      semanticTimeline = cachedProfile.timeline;
    } else {
      semanticTimeline = heuristicFallback(cues).timeline;
    }
    dialogueItems = buildDialogueItems(cues);
    renderDialogueList();
    const leftSource = track.sources.find((source) => source.side === 'left')
      ?? track.sources[0];
    const rightSource = track.sources.find((source) => source.side === 'right')
      ?? null;
    spectrum.configure({
      paired: prepared.paired,
      listeningMode: elements.listeningMode.value,
      leftPalette: leftSource?.hairPalette,
      rightPalette: rightSource?.hairPalette,
    });
    player.load({
      nextAlignment: prepared.alignment,
      currentTime: saved.trackId === track.id
        ? resumeTime(prepared.alignment.duration, saved.currentTime)
        : 0,
      rate: saved.rate,
      volume: saved.volume,
      rightEnabled: prepared.paired,
    });
    trackReady = true;
    configureListening();
    spectrum.setSemanticFrame(
      semanticFrameAt(semanticTimeline, player.currentTime()),
    );
    spectrum.setDialogueFocus(dialoguePanTarget(cues, player.currentTime(), {
      paired: prepared.paired,
    }));
    refreshTrackCues();
    aiWorkbench.trackChanged();
    renderActiveSubtitles(player.currentTime());
    updateActiveDialogue(player.currentTime(), activeDrawer === 'dialogue');
    if (autoplay) {
      await graphPromise;
      player.play();
    }
  } catch {
    if (requestId !== loadRequest) return;
    elements.subtitleStatus.textContent = '音轨不可用';
    showToast('此音轨无法载入');
  }
}

function moveTrack(direction, autoplay = true) {
  const adjacent = findAdjacentTrack(works, workIndex, trackIndex, direction);
  if (!adjacent) {
    showToast(direction > 0 ? '播放列表已结束' : '已经是第一条音轨');
    return false;
  }
  selectTrack(adjacent.workIndex, adjacent.trackIndex, autoplay);
  return true;
}

function setLibraryAvailable(available) {
  elements.libraryWelcome.hidden = available;
  elements.app.classList.toggle('awaiting-library', !available);
  for (const name of ['playButton', 'previousButton', 'nextButton', 'progress', 'volume', 'rate', 'dialogueButton', 'listeningMode', 'syncMode']) {
    elements[name].disabled = !available;
  }
}

async function applyLibrary(data, nextLocalLibrary = null) {
  persistCurrent();
  player.pause();
  trackReady = false;
  preparedTrack = null; aiDocument = null;
  aiWorkbench?.trackChanged();
  player.load({ nextAlignment: null });
  ++loadRequest;
  spectrum.reset();
  elements.audioLeft.removeAttribute('src');
  elements.audioLeft.load();
  clearRightMedia();
  backgroundPicker?.workChanged(null);
  localLibrary?.dispose();
  localLibrary = nextLocalLibrary;
  works = data.works.filter((work) => work.tracks.length > 0);
  categories = data.categories ?? [];
  semanticProfiles = data.profiles ?? {};
  expandedWorks.clear();
  expandedFolders.clear();
  expandedCollections.clear();
  setLibraryAvailable(works.length > 0);
  if (works.length === 0) {
    elements.trackTitle.textContent = '选择文件夹，打开你的曲库';
    elements.subtitleStatus.textContent = '本机读取';
    renderLibrary();
    return;
  }
  const lastWorkId = localStorage.getItem('asmr-player:last-work');
  workIndex = Math.max(0, works.findIndex((work) => work.id === lastWorkId));
  const work = currentWork();
  const saved = loadWorkState(localStorage, work.id);
  trackIndex = Math.max(
    0,
    work.tracks.findIndex((track) => track.id === saved.trackId),
  );
  expandedWorks.add(work.id);
  if (work.categoryPath) expandedCollections.add(work.categoryPath);
  await selectTrack(workIndex, trackIndex, false);
}

async function importFolder(files, flat = false) {
  if (files.length === 0) return;
  if (flat) {
    const names = new Set();
    if (files.some((file) => { const name = file.name.toLowerCase(); if (names.has(name)) return true; names.add(name); return false; })) {
      showToast('所选文件中有重名文件，无法确定对应关系。请分批选择或使用文件夹方式。');
      return;
    }
  }
  const requestId = ++importRequest;
  elements.openFolderButton.disabled = true;
  elements.chooseFolderButton.disabled = true;
  elements.openFilesButton.disabled = true;
  elements.chooseFilesButton.disabled = true;
  elements.openFolderButton.textContent = '读取中…';
  elements.importStatus.textContent = '正在读取曲库目录…';
  try {
    const next = await scanLocalFiles(files, {
      onProgress: (progress) => {
        if (requestId === importRequest) {
          elements.importStatus.textContent = `正在读取：${progress.works} 部作品，${progress.tracks} 个音轨`;
        }
      },
    });
    if (requestId !== importRequest) { next.dispose(); return; }
    if (next.counts.tracks === 0) {
      next.dispose();
      elements.importStatus.textContent = '此文件夹没有 MP3 或 WAV。请选择曲库、分类或作品文件夹。';
      showToast('没有找到可播放的 MP3 或 WAV');
      return;
    }
    setActiveDrawer(null);
    await applyLibrary(next, next);
    elements.importStatus.textContent = `已读取 ${next.counts.works} 部作品、${next.counts.tracks} 个音轨，文件留在本机。`;
    showToast(`已读取 ${next.counts.works} 部作品 · ${next.counts.tracks} 个音轨`);
  } catch {
    elements.importStatus.textContent = '文件夹读取失败，请重新选择，并确认文件仍在原位置。';
    showToast('文件夹读取失败，请重新选择');
  } finally {
    if (requestId === importRequest) {
      elements.openFolderButton.disabled = false;
      elements.chooseFolderButton.disabled = false;
      elements.openFilesButton.disabled = false;
      elements.chooseFilesButton.disabled = false;
      elements.openFolderButton.textContent = '打开文件夹';
    }
  }
}

async function initialize() {
  setLibraryAvailable(false);
  try {
    const data = await loadInitialLibrary({ mode: libraryMode, baseUrl: document.baseURI });
    await applyLibrary(data);
  } catch {
    elements.trackTitle.textContent = '可直接选择本机曲库文件夹';
    elements.subtitleStatus.textContent = '等待选择';
    elements.importStatus.textContent = '本地服务暂不可用。也可以直接选择文件夹播放。';
  }
}

elements.openFolderButton.addEventListener('click', () => elements.folderInput.click());
elements.chooseFolderButton.addEventListener('click', () => elements.folderInput.click());
elements.openFilesButton.addEventListener('click', () => elements.filesInput.click());
elements.chooseFilesButton.addEventListener('click', () => elements.filesInput.click());
elements.filesInput.addEventListener('change', () => {
  const files = [...elements.filesInput.files]; elements.filesInput.value = '';
  importFolder(files, true);
});
elements.folderInput.addEventListener('change', () => {
  const files = [...elements.folderInput.files];
  elements.folderInput.value = '';
  importFolder(files);
});

function setActionsOpen(open) {
  elements.topbarActions.classList.toggle('open', open);
  elements.actionsButton.setAttribute('aria-expanded', String(open));
}
elements.actionsButton.addEventListener('click', () => setActionsOpen(elements.actionsButton.getAttribute('aria-expanded') !== 'true'));
elements.topbarActions.addEventListener('click', (event) => { if (event.target.closest('button')) setActionsOpen(false); });
document.addEventListener('pointerdown', (event) => {
  if (!elements.topbarActions.contains(event.target) && !elements.actionsButton.contains(event.target)) setActionsOpen(false);
});

elements.menuButton.addEventListener('click', () => {
  setActiveDrawer(activeDrawer === 'library' ? null : 'library');
});
elements.dialogueButton.addEventListener('click', () => {
  setActiveDrawer(activeDrawer === 'dialogue' ? null : 'dialogue');
});
elements.closeDrawerButton.addEventListener('click', () => setActiveDrawer(null));
elements.closeDialogueButton.addEventListener('click', () => setActiveDrawer(null));
elements.drawerScrim.addEventListener('click', () => setActiveDrawer(null));
const markDialogueManualScroll = () => {
  dialogueManualScrollUntil = performance.now() + 1500;
};
elements.dialogueList.addEventListener('wheel', markDialogueManualScroll, {
  passive: true,
});
elements.dialogueList.addEventListener('touchmove', markDialogueManualScroll, {
  passive: true,
});
elements.dialogueList.addEventListener('pointerdown', markDialogueManualScroll, {
  passive: true,
});
elements.playButton.addEventListener('click', () => {
  if (player.paused()) playAudio();
  else player.pause();
});
elements.nextButton.addEventListener('click', () => moveTrack(1));
elements.previousButton.addEventListener('click', () => {
  if (player.currentTime() > 5) player.seek(0);
  else moveTrack(-1);
});
elements.progress.addEventListener('input', () => {
  player.seek((Number(elements.progress.value) / 1000) * player.duration());
});
elements.volume.addEventListener('input', () => {
  player.setVolume(Number(elements.volume.value));
  persistCurrent();
});
elements.rate.addEventListener('change', () => {
  player.setRate(Number(elements.rate.value));
  persistCurrent();
});
elements.listeningMode.addEventListener('change', configureListening);
elements.syncMode.addEventListener('change', () => {
  if (!trackReady || !preparedTrack) return;
  const playing = !player.paused();
  const time = player.currentTime();
  player.pause();
  const track = currentTrack();
  const left = track.sources.find((source) => source.side === 'left') ?? track.sources[0];
  const right = track.sources.find((source) => source.side === 'right');
  const playback = buildTrackPlayback({
    leftDuration: preparedTrack.leftDuration, rightDuration: preparedTrack.rightDuration,
    leftCues: preparedTrack.sourceCues[left.id], rightCues: right ? preparedTrack.sourceCues[right.id] : [],
    paired: preparedTrack.paired, syncMode: elements.syncMode.value,
  });
  Object.assign(preparedTrack, playback);
  player.load({ nextAlignment: playback.alignment, currentTime: Math.min(time, playback.alignment.duration), rate: Number(elements.rate.value), volume: Number(elements.volume.value), rightEnabled: preparedTrack.paired });
  refreshTrackCues();
  if (playing) playAudio();
});
elements.fullscreenButton.hidden = !document.documentElement.requestFullscreen;
elements.fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { showToast('此浏览器暂不支持页面全屏'); }
});

document.addEventListener('pointermove', showUi, { passive: true });
document.addEventListener('pointerdown', showUi, { passive: true });
document.addEventListener('keydown', (event) => {
  showUi();
  if (event.key === 'Escape') setActionsOpen(false);
  const tagName = event.target?.tagName;
  if (['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(tagName) || aiWorkbench?.isOpen() || backgroundPicker?.isOpen()) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (player.paused()) playAudio();
    else player.pause();
  } else if (event.code === 'ArrowLeft') {
    player.seek(Math.max(0, player.currentTime() - 5));
  } else if (event.code === 'ArrowRight') {
    player.seek(Math.min(player.duration(), player.currentTime() + 5));
  }
});
window.addEventListener('pagehide', (event) => {
  aiWorkbench?.clearKeys();
  persistCurrent();
  player.pause();
  if (event.persisted) return;
  player.destroy();
  spectrum.destroy();
  localLibrary?.dispose();
});

initialize();
