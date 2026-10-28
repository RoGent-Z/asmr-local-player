// Exact-cue memory and versioned dictionary preferences; no model calls.
import {validateLocalMatrix} from './local-matrix-schema.mjs?v=0.1.5';
export const PACK_DICTIONARY_VERSION='ja-zh-v1-20261013';
export const isPackVersion=value=>typeof value==='string'&&/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
export const normalizePhraseInput=value=>value.normalize('NFKC').replace(/\s+/g,'').replace(/[。！？!?、…]+$/,'').replace(/[\u30a1-\u30f6]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
export function validatePhrasePack(value){
  const invalid=()=>{throw new Error('本机学习包格式无效，请使用本地语料工具生成的 JSON');};
  if(value?.kind!=='asmr-local-phrase-pack'||(value.version!==1&&value.version!==2)||!Array.isArray(value.entries)||value.entries.length>10000||(!value.entries.length&&!value.glosses?.length)||(value.version===2&&value.package===undefined))invalid();
  const seen=new Set(),entries=[];
  for(const p of value.entries){
    if(typeof p?.source!=='string'||typeof p.target!=='string'||p.source.length>128||p.target.length>160||!p.target.trim()||!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(p.source)||!Number.isSafeInteger(p.support)||p.support<2||p.support>1000000||!Number.isSafeInteger(p.occurrences)||p.occurrences<p.support||p.occurrences>10000000)invalid();
    const source=normalizePhraseInput(p.source);if(source.length<3||seen.has(source))invalid();seen.add(source);entries.push({source,target:p.target.trim(),support:p.support,occurrences:p.occurrences});
  }
  const result={kind:'asmr-local-phrase-pack',version:value.version,entries};
  if(value.package!==undefined){
    const p=value.package;
    if(!p||typeof p.id!=='string'||!/^[a-z0-9][a-z0-9-]{2,63}$/.test(p.id)||!isPackVersion(p.version)||p.dictionaryVersion!==PACK_DICTIONARY_VERSION||typeof p.license!=='string'||! /^[A-Za-z0-9.-]{1,64}$/.test(p.license))invalid();
    result.package={id:p.id,version:p.version,dictionaryVersion:p.dictionaryVersion,license:p.license};
  }
  if(value.glosses!==undefined){if(!Array.isArray(value.glosses)||value.glosses.length>10000)invalid();const ids=new Set();result.glosses=value.glosses.map(p=>{if(typeof p?.entryId!=='string'||!/^\d{1,12}$/.test(p.entryId)||ids.has(p.entryId)||typeof p.target!=='string'||!p.target.trim()||p.target.length>160||!Number.isSafeInteger(p.support)||p.support<5||!Number.isSafeInteger(p.occurrences)||p.occurrences<p.support)invalid();ids.add(p.entryId);return{entryId:p.entryId,target:p.target.trim(),support:p.support,occurrences:p.occurrences};});}
  if(value.version===2)result.matrix=validateLocalMatrix(value.matrix,{dictionaryVersion:PACK_DICTIONARY_VERSION,normalizeSource:s=>s.normalize('NFKC').trim().replace(/[\u30a1-\u30f6]/g,c=>String.fromCharCode(c.charCodeAt(0)-96))});
  return result;
}

export function phrasePackSummary(pack){
  const result={phrases:pack?.entries.length||0,glosses:pack?.glosses?.length||0,package:pack?.package||null};
  if(pack?.version===2&&pack.matrix)result.matrix={status:pack.matrix.status,rows:pack.matrix.translation.length,
    candidates:pack.matrix.translation.reduce((total,row)=>total+row.candidates.length,0),transitions:pack.matrix.transitions.length};
  return result;
}
