const MAX_GLYPHS=160;
const clamp=value=>Math.max(0,Math.min(1,value));
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;

/** Preserve readable text; very long captions use one DOM text run. */
export function segmentFoliaText(text) {
  if(typeof text!=='string'||!text)return {parts:[],decorated:false};
  // Codepoint length gives an inexpensive early bound before segmenting huge captions.
  if(text.length>MAX_GLYPHS*12)return {parts:[text],decorated:false};
  const parts=segmenter?Array.from(segmenter.segment(text),x=>x.segment):Array.from(text);
  return parts.length<=MAX_GLYPHS?{parts,decorated:true}:{parts:[text],decorated:false};
}

/** Sentence-driven decorative light sweep, never fabricated word alignment. */
export function foliaGlyphFrame(item,time,count,{reducedMotion=false}={}) {
  const start=Number.isFinite(item?.start)?Math.max(0,item.start):0;
  const end=Number.isFinite(item?.end)?Math.max(start+.1,item.end):start+.1;
  const current=Number.isFinite(time)?Math.max(0,time):0;
  const progress=clamp((current-start)/(end-start));
  const length=Number.isFinite(count)?Math.max(0,Math.min(MAX_GLYPHS,Math.floor(count))):0;
  const raw=clamp((current-start)/.65);
  const entrance=reducedMotion?1:raw*raw*(3-2*raw);
  const weights=Array.from({length},(_,index)=>{
    if(reducedMotion)return .82;
    const position=length>1?index/(length-1):.5;
    return .68+.32*Math.exp(-Math.pow((position-progress)*4.5,2));
  });
  return {progress,entrance,weights,sweep:reducedMotion ? .5 : progress};
}
