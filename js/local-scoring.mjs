// Diagnostics are separate from the interoperable subtitle document.
export function mergeScoring(previous,patch,document){
  const result={};for(const source of document.sources){const selected=Object.hasOwn(patch||{},source.id)?patch[source.id]:previous?.[source.id];if(!selected)continue;
    const ids=new Set(source.cues.map(c=>c.id));result[source.id]={cues:structuredClone(selected.cues.filter(item=>ids.has(item.cueId))),truncated:Boolean(selected.truncated)};
  }return result;
}
export function exportLocalResult(document,scoring){
  const has=Object.values(scoring||{}).some(source=>source.cues.length||source.truncated);
  return JSON.stringify({...document,translationMethod:has?'dictionary-matrix-v2':'dictionary-v1',...(has?{scoring}:{} )},null,2);
}
const reasons={'supported-context':'独立证据与上下文支持此路径','partial-fallback':'部分片段沿用原词库结果','baseline-preferred':'原词库结果得分更高或相同','insufficient-support':'独立证据不足，沿用原词库结果','insufficient-margin':'候选路径分差不足，沿用原词库结果','protected-semantics':'保护否定、数值、方向或人物指代，沿用原词库结果','operation-budget':'达到计算预算，完整保留原词库结果','segment-too-long':'片段较长，完整保留原词库结果','exact-phrase':'采用已保存的精确短语','no-dictionary-evidence':'没有足够词典证据'};
export const scoringReason=value=>reasons[value]||'沿用原词库结果';
export function scoringDetails(scoring,doc=document){
  const details=doc.createElement('details');details.className='local-scoring';const title=doc.createElement('summary');title.textContent='词组评分';details.append(title);
  const note=doc.createElement('p');note.className='field-help';note.textContent=`${scoringReason(scoring.reason)}。相对分用于比较当前上下文的候选，不是翻译正确率。`;details.append(note);
  for(const group of scoring.groups||[]){const row=doc.createElement('div');row.className='local-scoring-row';
    const selected=doc.createElement('p');selected.textContent=`${group.source} → ${group.selected} · 相对分 ${Math.round(group.relativeScore*100)} · ${group.support} 个独立组`;
    const alternatives=doc.createElement('p');alternatives.className='field-help';alternatives.textContent=(group.alternatives||[]).slice(0,2).map(a=>`${a.target} ${Math.round(a.relativeScore*100)}（${a.support}组）`).join('；')||'没有其他候选';
    const reason=doc.createElement('p');reason.className='field-help';reason.textContent=scoringReason(group.reason);row.append(selected,alternatives,reason);details.append(row);
  }
  if(scoring.groupsTruncated){const note=doc.createElement('p');note.className='field-help';note.textContent='本句评分明细达到数量或计算上限，译文仍完整保留。';details.append(note);}
  return details;
}
