import {createLocalDictionary} from './local-dictionary.mjs';
import {createLanguageStorage,loadLocalDictionary} from './local-language-store.mjs';
const storage=createLanguageStorage();let dictionary=null,metadata=null,loadController=null,generation=0;
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
        post(id,'progress',{progress:{phase:'index'}});dictionary=createLocalDictionary(loaded.records);
        metadata={manifest:loaded.manifest,cached:loaded.cached,persisted:loaded.persisted,warning:loaded.warning,entries:dictionary.entries,forms:dictionary.forms};loadController=null;
      }
      post(id,'result',{result:metadata});
    }else if(type==='translate'){
      if(!dictionary)throw new Error('请先准备本地词库');
      if(!Array.isArray(data.cues)||data.cues.length>100000)throw new Error('字幕条目格式无效');
      const cues=[],unknown=new Set();let matched=0,total=0;
      for(let index=0;index<data.cues.length;index++){
        if(canceled.has(id))throw new Error('翻译已取消');
        const cue=data.cues[index],result=dictionary.translate(cue.text);
        cues.push({...cue,translation:result.text});matched+=result.coverage*Math.max(1,cue.text.length);total+=Math.max(1,cue.text.length);
        for(const word of result.unknown)if(unknown.size<30)unknown.add(word.slice(0,40));
        if(index%25===0){post(id,'progress',{progress:{phase:'translation',done:index+1,total:data.cues.length}});await new Promise(resolve=>setTimeout(resolve,0));}
      }
      if(canceled.has(id))throw new Error('翻译已取消');
      post(id,'result',{result:{cues,coverage:total?matched/total:1,unknown:[...unknown]}});
    }else if(type==='clear'){
      ++generation;loadController?.abort();loadController=null;dictionary=null;metadata=null;
      await storage.clear();post(id,'result',{result:true});
    }else throw new Error('不支持的本地词库任务');
  }catch(error){post(id,'error',{error:error.message||'本地词库处理失败'});}
  finally{canceled.delete(id);}
});
