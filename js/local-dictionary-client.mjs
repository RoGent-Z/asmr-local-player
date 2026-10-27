export function createLocalDictionaryClient({workerFactory=()=>new Worker(new URL('./local-translation-worker.mjs?v=0.1.4',import.meta.url),{type:'module'})}={}){
  let worker=null,serial=0,ready=null;const pending=new Map();
  function ensureWorker(){
    if(worker)return worker;worker=workerFactory();
    worker.addEventListener('message',({data})=>{
      const task=pending.get(data?.id);if(!task)return;
      if(data.event==='progress'){task.onProgress(data.progress);return;}
      if(data.event==='result')task.finish(null,data.result);else if(data.event==='error')task.finish(new Error(data.error||'本地词库处理失败'));
    });
    worker.addEventListener('error',()=>{for(const task of [...pending.values()])task.finish(new Error('本地词库运行失败，请重试'));worker?.terminate();worker=null;ready=null;});return worker;
  }
  function request(type,payload={}, {signal,onProgress=()=>{}}={}){
    if(signal?.aborted)return Promise.reject(signal.reason||new DOMException('已取消','AbortError'));
    const current=ensureWorker(),id=++serial;
    return new Promise((resolve,reject)=>{
      const cancel=()=>{current.postMessage({id,type:'cancel'});finish(signal.reason||new DOMException('已取消','AbortError'));};
      const finish=(error,result)=>{pending.delete(id);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(result);};
      pending.set(id,{finish,onProgress});signal?.addEventListener('abort',cancel,{once:true});current.postMessage({id,type,...payload});
    });
  }
  async function prepare(options){if(!ready)ready=request('init',{},options).catch(error=>{ready=null;throw error;});return ready;}
  return{prepare,translate:async(cues,options)=>{await prepare(options);return request('translate',{cues},options);},
    async phraseStatus(options){const result=await request('phrase-status',{},options);ready=null;return result;},
    async importPhrases(pack,options){const result=await request('import-phrases',{pack},options);ready=null;return result;},
    async removePhrases(options){const result=await request('remove-phrases',{},options);ready=null;return result;},
    async clear(){ready=null;return request('clear');},
    destroy(){for(const task of [...pending.values()])task.finish(new DOMException('已关闭','AbortError'));worker?.terminate();worker=null;ready=null;}};
}
