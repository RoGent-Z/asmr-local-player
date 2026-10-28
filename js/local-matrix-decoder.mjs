// Bounded statistical search over licensed dictionary candidates. No model or network calls.
const letters=s=>Array.from(s.matchAll(/[\p{L}\p{N}]/gu)).length;
const log=x=>Math.log(Math.max(1e-12,x));
const protectedSource=/[0-9一二三四五六七八九十百千万〇零]|ない|なかった|なく|なけれ|ません|ず|ぬ|ではありません|じゃない|左右|左|右|前|後|上|下|東|西|南|北|ひだり|みぎ|うしろ|まえ|わたし|わたくし|ぼく|おれ|あなた|あんた|きみ|かれ|かのじょ|あのひと|このひと|私|僕|俺|君|彼|彼女|自分/u;
const clauseBoundary=/[。！？!?；;\n、，,]/u;
export const dictionarySource=input=>input.normalize('NFKC').replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,'$1');
export function joinDictionaryTokens(tokens){
  let text='';for(const token of tokens){if(!token.translation)continue;const last=Array.from(text).at(-1)||'',first=Array.from(token.translation)[0]||'';
    const gap=text&&/[\p{L}\p{N}]/u.test(last)&&/[\p{L}\p{N}]/u.test(first)&&!(/\p{Script=Han}/u.test(last)&&/\p{Script=Han}/u.test(first))?' ':'';text+=gap+token.translation;
  }return text.trim();
}
const tokenKey=t=>JSON.stringify([t.source,t.translation,t.type,t.entryId||'']);
const plainToken=t=>({source:t.source,translation:t.translation,type:t.type,...(t.entryId?{entryId:t.entryId}:{})});

export function createMatrixDecoder(matrix,{baseline,candidatesAt,normalize,rankOf,glossHas}){
  const p=matrix.parameters,w=p.weights,rows=new Map(matrix.translation.map(row=>[row.source,row.candidates])),unigrams=new Map(matrix.unigrams.map(r=>[r.target,r.probability])),transitions=new Map();
  for(const edge of matrix.transitions){if(!transitions.has(edge.from))transitions.set(edge.from,new Map());transitions.get(edge.from).set(edge.to,edge.probability);}
  const evidence=edge=>rows.get(edge.word||normalize(edge.source))?.find(c=>c.entryId===edge.entryId&&c.target===edge.translation);
  function step(previous,edge){
    const e=evidence(edge),row=rows.get(edge.word||normalize(edge.source));
    let score=0,next=previous;
    if(edge.type==='dictionary'){
      score+=w.translation*log(e?.probability??(row?Math.min(...row.map(c=>c.probability))*.05:1));
      score+=w.evidence*log(e?(e.support+1)/(matrix.provenance.trainingGroups+1):1/(matrix.provenance.trainingGroups+1));
      score-=w.prior*Math.log1p(Math.max(0,edge.rank??rankOf(edge.entryId)??999999));
    }
    if(edge.type==='unknown'){score-=w.unknown*letters(edge.source);next=null;}
    else if(edge.type==='punctuation'){next=null;}
    else if(edge.translation){
      const base=unigrams.get(edge.translation)||1e-12,row=previous?transitions.get(previous):null;
      // A known row is interpolated as a full distribution; missing edges receive backoff mass.
      const probability=row?p.transitionMix*(row.get(edge.translation)||0)+(1-p.transitionMix)*base:base;
      score+=w.transition*log(probability);next=edge.translation;
    }
    return{score,next};
  }
  return function translate(input){
    const fullBaseline=baseline(input),source=dictionarySource(input),budget={operations:0};
    const spend=(n=1)=>{if(budget.operations+n>p.maxOperations)throw BUDGET;budget.operations+=n;};
    const BUDGET=Symbol('operation-budget');
    let groups=[],groupsTruncated=false;
    const diagnose=(base,status,reason,extra={})=>({...base,scoring:{method:'matrix-v2',status,reason,operations:budget.operations,groups,groupsTruncated,...extra}});
    if(fullBaseline.phraseHits)return diagnose(fullBaseline,'fallback','exact-phrase');
    if(!fullBaseline.tokens.length)return diagnose(fullBaseline,'unchanged','no-dictionary-evidence');
    // Segment the frozen token stream, not the raw string: a dictionary word may
    // contain punctuation, and a Latin-only clause still owns unknown tokens.
    const chunks=[];let chunk=[];for(const token of fullBaseline.tokens){chunk.push(token);if(token.type==='punctuation'&&clauseBoundary.test(token.source)){chunks.push(chunk);chunk=[];}}if(chunk.length)chunks.push(chunk);
    const clauseResults=[];let adopted=0;
    for(const tokens of chunks){
      const part=tokens.map(t=>t.source).join(''),original={text:joinDictionaryTokens(tokens),tokens},normal=normalize(part);
      if(protectedSource.test(normal)){clauseResults.push({result:original,status:'fallback',reason:'protected-semantics'});continue;}
      if(part.length>p.maxSegmentLength){clauseResults.push({result:original,status:'fallback',reason:'segment-too-long'});continue;}
      let offset=0;const baselineEdges=new Map(),protectedSpans=[],baselineKeys=new Set();
      for(const token of original.tokens){const edge={...token,start:offset,length:token.source.length};baselineEdges.set(offset,edge);baselineKeys.add(`${offset}:${tokenKey(edge)}`);if(['unknown','punctuation'].includes(token.type))protectedSpans.push(edge);offset+=edge.length;}
      const allowed=edge=>!protectedSpans.some(span=>edge.start<span.start+span.length&&edge.start+edge.length>span.start&&(edge.start!==span.start||edge.length!==span.length||edge.translation!==span.translation||edge.type!==span.type));
      let chosen,runner,baselinePath,reason='unchanged';
      try{
        const beams=new Map([[0,[{score:0,previous:null,tokens:[],key:''}]]]);
        for(let at=0;at<part.length;at++){
          const states=beams.get(at);if(!states?.length)continue;
          const candidates=candidatesAt(part,normal,at,spend),frozen=baselineEdges.get(at);if(frozen)candidates.push(frozen);
          const unique=new Map();for(const c of candidates){spend();const edge={...c,start:at};if(edge.length>0&&at+edge.length<=part.length&&allowed(edge))unique.set(tokenKey(edge),edge);}
          for(const state of states)for(const edge of unique.values()){
            spend();const value=step(state.previous,edge),end=at+edge.length,next={score:state.score+value.score,previous:value.next,tokens:[...state.tokens,edge],key:state.key+'\0'+tokenKey(edge)};
            let target=beams.get(end);if(!target){target=[];beams.set(end,target);}const same=target.find(x=>x.key===next.key);if(same)continue;
            target.push(next);target.sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));if(target.length>p.beamWidth)target.length=p.beamWidth;
          }
          beams.delete(at);
        }
        baselinePath={score:0,previous:null,tokens:[...baselineEdges.values()],key:'baseline'};
        for(const edge of baselinePath.tokens){spend();const value=step(baselinePath.previous,edge);baselinePath.score+=value.score;baselinePath.previous=value.next;}
        const paths=[...(beams.get(part.length)||[]),baselinePath].sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key));
        const distinct=new Map();for(const path of paths){const text=joinDictionaryTokens(path.tokens);if(!distinct.has(text))distinct.set(text,{...path,text});}
        [chosen,runner]=[...distinct.values()];
        const changedDictionary=chosen?.tokens.filter(edge=>edge.type==='dictionary'&&!baselineKeys.has(`${edge.start}:${tokenKey(edge)}`))||[];
        if(!chosen||chosen.text===original.text)reason='baseline-preferred';
        else if(!changedDictionary.length||changedDictionary.some(edge=>(evidence(edge)?.support||0)<p.minSupport))reason='insufficient-support';
        else if(runner&&chosen.score-runner.score<p.minMargin)reason='insufficient-margin';
        else reason='supported-context';
        const selected=reason==='supported-context'?chosen:baselinePath;
        for(let index=0;index<selected.tokens.length;index++){const edge=selected.tokens[index],row=rows.get(edge.word||normalize(edge.source));if(!row||edge.type!=='dictionary')continue;
          if(groups.length>=64||budget.operations+selected.tokens.length*(row.length+1)>p.maxOperations){groupsTruncated=true;break;}
          const candidates=[...row];if(!candidates.some(c=>c.entryId===edge.entryId&&c.target===edge.translation))candidates.push({entryId:edge.entryId,target:edge.translation,support:0});
          const byTarget=new Map();for(const candidate of candidates){let previous=null,score=0;for(let i=0;i<selected.tokens.length;i++){
            spend();const variant=i===index?{...edge,entryId:candidate.entryId,translation:candidate.target,rank:rankOf(candidate.entryId)}:selected.tokens[i],value=step(previous,variant);score+=value.score;previous=value.next;
          }const old=byTarget.get(candidate.target);if(!old||score>old.weightedScore)byTarget.set(candidate.target,{target:candidate.target,weightedScore:score,support:candidate.support});}
          const ranked=[...byTarget.values()].sort((a,b)=>b.weightedScore-a.weightedScore||a.target.localeCompare(b.target)),top=ranked[0].weightedScore,total=ranked.reduce((n,c)=>n+Math.exp(c.weightedScore-top),0);
          for(const c of ranked)c.relativeScore=Math.exp(c.weightedScore-top)/total;
          const alternatives=[];for(const c of ranked)if(c.target!==edge.translation&&!alternatives.some(a=>a.target===c.target)){alternatives.push(c);if(alternatives.length===2)break;}
          const selectedScore=byTarget.get(edge.translation);groups.push({source:edge.source,selected:edge.translation,relativeScore:selectedScore?.relativeScore||0,weightedScore:selectedScore?.weightedScore??null,support:evidence(edge)?.support||0,alternatives,reason});
        }
      }catch(error){if(error!==BUDGET)throw error;groups=[];groupsTruncated=true;return diagnose(fullBaseline,'fallback','operation-budget');}
      if(reason==='supported-context'){
        adopted++;const tokens=chosen.tokens.map(plainToken);clauseResults.push({result:{...original,text:chosen.text,tokens},status:'adopted',reason,pathScore:chosen.score,margin:runner?chosen.score-runner.score:null});
      }else clauseResults.push({result:original,status:reason==='baseline-preferred'?'unchanged':'fallback',reason,pathScore:chosen?.score??null,margin:runner?chosen.score-runner.score:null});
    }
    const firstFallback=clauseResults.find(c=>c.status==='fallback'),last=clauseResults.at(-1);
    if(!adopted)return diagnose(fullBaseline,firstFallback?'fallback':'unchanged',firstFallback?.reason||last?.reason||'no-dictionary-evidence',{pathScore:last?.pathScore??null,margin:last?.margin??null});
    const tokens=clauseResults.flatMap(c=>c.result.tokens),unknown=[...new Set(tokens.filter(t=>t.type==='unknown').map(t=>t.source))],total=tokens.reduce((n,t)=>n+letters(t.source),0);
    const result={text:joinDictionaryTokens(tokens),tokens,coverage:total?Math.max(0,1-tokens.filter(t=>t.type==='unknown').reduce((n,t)=>n+letters(t.source),0)/total):1,unknown,dictionaryHits:tokens.filter(t=>t.type==='dictionary').length,ruleHits:tokens.filter(t=>t.type==='rule').length,phraseHits:0,glossHits:tokens.filter(t=>t.entryId&&glossHas(t.entryId)).length};
    return diagnose(result,'adopted',firstFallback?'partial-fallback':'supported-context',{pathScore:last?.pathScore??null,margin:last?.margin??null});
  };
}
