import {createLocalDictionary} from './local-dictionary.mjs?v=0.1.5';
import {createLanguageStorage,loadLocalDictionary} from './local-language-store.mjs';
import {validatePhrasePack,phrasePackSummary} from './local-phrases.mjs?v=0.1.5';
const storage=createLanguageStorage();let dictionary=null,metadata=null,baseWarning='',loadController=null,generation=0;
let phrasePack=null,phrasesLoaded=false,phraseRevision=0,phrasePersisted=true;
async function loadPhrases(){
  if(phrasesLoaded)return;const revision=phraseRevision;
  const value=await storage.get('phrases'),saved=value?validatePhrasePack(value):null;
  if(revision===phraseRevision&&!phrasesLoaded){phrasePack=saved;phrasesLoaded=true;dictionary?.setPhrases(saved);if(metadata)metadata={...metadata,...phrasePackSummary(saved),warning:baseWarning};}
}
const canceled=new Set();
const post=(id,event,data)=>self.postMessage({id,event,...data});
self.addEventListener('message',async({data})=>{
  const {id,type}=data||{};if(!Number.isSafeInteger(id))return;
  if(type==='cancel'){canceled.add(id);loadController?.abort();return;}
  try{
    if(type==='init'){
      if(!dictionary){
        const current=++generation;loadController=new AbortController();
        const loaded=await loadLocalDictionary({storage,signal:loadController.signal,onProgress:progress=>post(id,'progress',{progress})});
        if(current!==generation||canceled.has(id))throw new Error('词库任务已取消');
        baseWarning=loaded.warning||'';let warning=baseWarning;
        try{await loadPhrases();}catch{warning+=' 本机词组包暂时无法读取，本次仅使用基础词库；重新打开面板可重试，或重新安装词组包。';}
        if(current!==generation||canceled.has(id))throw new Error('词库任务已取消');
        post(id,'progress',{progress:{phase:'index'}});dictionary=createLocalDictionary(loaded.records,{phrasePack});
        metadata={manifest:loaded.manifest,cached:loaded.cached,persisted:loaded.persisted,warning,entries:dictionary.entries,forms:dictionary.forms,...phrasePackSummary(phrasePack),phrasePersisted};loadController=null;
      }
      post(id,'result',{result:metadata});
    }else if(type==='translate'){
      if(!dictionary)throw new Error('请先准备本地词库');
      if(!Array.isArray(data.cues)||data.cues.length>100000)throw new Error('字幕条目格式无效');
      const cues=[],unknown=new Set(),scoring=[];let matched=0,total=0,phraseHits=0,glossHits=0,scoringCharacters=0,scoringTruncated=false;
      for(let index=0;index<data.cues.length;index++){
        if(canceled.has(id))throw new Error('翻译已取消');
        const cue=data.cues[index],result=dictionary.translate(cue.text);
        cues.push({...cue,translation:result.text});matched+=result.coverage*Math.max(1,cue.text.length);total+=Math.max(1,cue.text.length);phraseHits+=result.phraseHits||0;glossHits+=result.glossHits||0;
        if(result.scoring){const item={cueId:String(cue.id??index),scoring:result.scoring},size=JSON.stringify(item).length;
          if(scoring.length<2000&&scoringCharacters+size<=1024*1024){scoring.push(item);scoringCharacters+=size;}else scoringTruncated=true;
        }
        for(const word of result.unknown)if(unknown.size<30)unknown.add(word.slice(0,40));
        if(result.scoring||index%25===0){post(id,'progress',{progress:{phase:'translation',done:index+1,total:data.cues.length}});await new Promise(resolve=>setTimeout(resolve,0));}
      }
      if(canceled.has(id))throw new Error('翻译已取消');
      post(id,'result',{result:{cues,coverage:total?matched/total:1,unknown:[...unknown],phraseHits,glossHits,...(scoring.length||scoringTruncated?{scoring,scoringTruncated}:{})}});
    }else if(type==='phrase-status'){
      await loadPhrases();post(id,'result',{result:{...phrasePackSummary(phrasePack),persisted:phrasePersisted}});
    }else if(type==='import-phrases'){
      const pack=validatePhrasePack(data.pack);let persisted=true;
      if(canceled.has(id))throw new Error('导入已取消');
      ++phraseRevision;try{await storage.put('phrases',pack);}catch{persisted=false;}
      phrasePack=pack;phrasesLoaded=true;phrasePersisted=persisted;dictionary?.setPhrases(pack);if(metadata)metadata={...metadata,...phrasePackSummary(pack),phrasePersisted,warning:baseWarning};
      post(id,'result',{result:{...phrasePackSummary(pack),persisted}});
    }else if(type==='remove-phrases'){
      ++phraseRevision;let persisted=true;try{await storage.put('phrases',null);}catch{persisted=false;}
      phrasePack=null;phrasesLoaded=true;phrasePersisted=persisted;dictionary?.setPhrases(null);if(metadata)metadata={...metadata,...phrasePackSummary(null),phrasePersisted,warning:baseWarning};
      post(id,'result',{result:{persisted}});
    }else if(type==='clear'){
      ++generation;++phraseRevision;loadController?.abort();loadController=null;dictionary=null;metadata=null;baseWarning='';phrasePack=null;phrasesLoaded=false;phrasePersisted=true;
      await storage.clear();post(id,'result',{result:true});
    }else throw new Error('不支持的本地词库任务');
  }catch(error){post(id,'error',{error:error.message||'本地词库处理失败'});}
  finally{canceled.delete(id);}
});
