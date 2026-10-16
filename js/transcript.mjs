import { parseSubtitle } from './subtitles.mjs';

const MAX_CUES = 100000;
const MAX_TEXT = 24000;

function safeString(value, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.length > max) throw new Error('字幕文字或标识格式无效');
  return value.replace(/\u0000/g, '');
}

function checkedCue(cue, index) {
  if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
    || cue.start < 0 || cue.end <= cue.start || cue.end > 864000) throw new Error('字幕时间无效');
  const out = { id: safeString(String(cue.id ?? index), 2048), start: cue.start, end: cue.end, text: safeString(cue.text) };
  if (cue.translation !== undefined) out.translation = safeString(cue.translation);
  if (cue.speaker !== undefined && cue.speaker !== null) out.speaker = safeString(String(cue.speaker), 160);
  return out;
}

function timestamp(value) {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('字幕时间格式无效');
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseTimedText(text, { sourceId = 'import', format, duration = 0 } = {}) {
  if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('字幕文件过大或格式无效');
  if (['ass', 'ssa', 'lrc'].includes(format)) {
    return parseSubtitle(text, { format, duration }).cues.map((cue, index) => checkedCue({
      id: `${sourceId}:${index}`, start: cue.start, end: cue.end,
      text: cue.speaker && cue.text.startsWith(`【${cue.speaker}】`) ? cue.text.slice(cue.speaker.length + 2) : cue.text,
      ...(cue.speaker ? { speaker: cue.speaker } : {}),
    }, index));
  }
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    if (/^(WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex].trim());
    if (!match) throw new Error('字幕时间格式无效');
    const raw = lines.slice(timingIndex + 1).join('\n').trim();
    if (!raw) continue;
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw)?.[1];
    const cue = checkedCue({ id: `${sourceId}:${cues.length}`, start: timestamp(match[1]), end: timestamp(match[2]), text: raw.replace(/<\/?(?:v|c|b|i|u|ruby|rt)(?:[\s.][^>]*)?>/g, ''), ...(voice ? { speaker: voice } : {}) });
    cues.push(cue);
    if (cues.length > MAX_CUES) throw new Error('字幕条目过多');
  }
  if (!cues.length) throw new Error('没有找到带时间轴的字幕，请检查文件格式');
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function makeTranscriptDocument({ trackKey = '', sources = [] } = {}) {
  if (!Array.isArray(sources) || sources.length > 32) throw new Error('字幕来源格式无效');
  let count = 0;
  const sourceIds = new Set();
  return {
    kind: 'asmr-transcript', version: 1, trackKey: safeString(trackKey, 12000),
    sources: sources.map((source) => {
      const id = safeString(source.id, 2048);
      if (sourceIds.has(id)) throw new Error('字幕来源标识重复');
      sourceIds.add(id);
      if (!Array.isArray(source.cues)) throw new Error('字幕条目格式无效');
      count += source.cues.length;
      if (count > MAX_CUES) throw new Error('字幕条目过多');
      const ids = new Set();
      const cues = source.cues.map((cue, index) => {
        const result = checkedCue(cue, index);
        if (ids.has(result.id)) throw new Error('字幕标识重复');
        ids.add(result.id);
        return result;
      });
      return { id, side: ['left', 'right'].includes(source.side) ? source.side : 'center', label: source.label ? safeString(source.label, 160) : null, cues };
    }),
  };
}

export function readTranscriptDocument(text, expectedTrackKey) {
  if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('字幕结果文件过大');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('字幕结果 JSON 无效'); }
  if (data?.kind !== 'asmr-transcript' || data.version !== 1) throw new Error('不支持此字幕结果版本');
  const doc = makeTranscriptDocument(data);
  if (expectedTrackKey !== undefined && doc.trackKey !== expectedTrackKey) throw new Error('字幕结果与当前音轨不匹配');
  return doc;
}

export function displaySourceCues(source, mode = 'bilingual') {
  return source.cues.map((cue) => {
    const body = mode === 'original' || !cue.translation ? cue.text
      : mode === 'translated' ? cue.translation : `${cue.text}\n${cue.translation}`;
    const label = [source.label, cue.speaker].filter(Boolean).join(' · ');
    const text = label && !body.startsWith(`【${label}】`) ? `【${label}】${body}` : body;
    return { start: cue.start, end: cue.end, text,
      segments: [{ label: label || null, side: ['left', 'right'].includes(source.side) ? source.side : 'center', text }] };
  });
}

function formatTimestamp(value, format) {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
}

export function exportTimedText(cues, format = 'vtt') {
  if (!['vtt', 'srt'].includes(format)) throw new Error('不支持此字幕格式');
  const blocks = cues.map((cue, index) => {
    const safe = checkedCue(cue, index);
    const text = safe.text.replace(/\r/g, '').replace(/\n\s*\n/g, '\n').replace(/-->/g, '→');
    return `${index + 1}\n${formatTimestamp(safe.start, format)} --> ${formatTimestamp(safe.end, format)}\n${text}`;
  });
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`;
}
