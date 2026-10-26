import {localPcmChunks} from './local-audio.mjs';
const abortError=()=>new DOMException('本地识别已取消','AbortError');
const check=signal=>{if(signal?.aborted)throw signal.reason||abortError();};
let runtimePromise;
export function loadVoskRuntime(url){
  if(runtimePromise)return runtimePromise;
  runtimePromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=url;script.async=true;
    script.onload=()=>globalThis.Vosk?.Model?resolve(globalThis.Vosk):reject(new Error('本地识别运行库无效'));
    script.onerror=()=>reject(new Error('本地识别运行库下载失败，请重试'));document.head.append(script);
  }).catch(error=>{runtimePromise=null;throw error;});return runtimePromise;
}

export function createLocalAsr({modelUrl,runtimeUrl,loadRuntime=loadVoskRuntime,chunksImpl=localPcmChunks,modelTimeoutMs=180000}={}){
  let model=null,loading=null,destroyed=false,stopLoading=null,revision=0;
  function release(){
    revision++;const stop=stopLoading;stopLoading=null;stop?.(abortError());
    if(!model)return;
    const previous=model;model=null;
    try{previous.terminate();}catch{ /* Initialization may have failed. */ }
    // Pinned Vosk Model exposes its worker. Hard termination also interrupts
    // archive loading or a stalled WASM task before it can allocate more memory.
    previous.worker?.terminate?.();
  }
  async function prepare({signal,onProgress=()=>{}}={}){
    check(signal);if(destroyed)throw new Error('本地识别已关闭');if(model?.ready)return model;
    if(loading)return loading;
    const requestRevision=revision;
    loading=(async()=>{
      onProgress({phase:'runtime'});const Vosk=await loadRuntime(runtimeUrl);check(signal);
      if(destroyed||requestRevision!==revision)throw abortError();
      model=new Vosk.Model(modelUrl,-2);onProgress({phase:'model'});
      try{
        await new Promise((resolve,reject)=>{
          let finished=false;
          const done=error=>{if(finished)return;finished=true;stopLoading=null;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
          const cancel=()=>done(signal.reason||abortError());
          const timer=setTimeout(()=>done(new Error('本地识别语言库加载超时，请检查网络或设备可用内存后重试')),modelTimeoutMs);
          stopLoading=done;
          model.on('load',message=>message.result?done():done(new Error('日语识别语言库加载失败')));
          model.on('error',()=>done(new Error('日语识别语言库无法加载；请检查浏览器存储、网络和可用内存')));
          signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
        });
        check(signal);onProgress({phase:'asr-ready'});return model;
      }catch(error){release();throw error;}
    })();
    try{return await loading;}finally{loading=null;}
  }
  async function transcribe(source,{signal,onProgress=()=>{}}={}){
    const loaded=await prepare({signal,onProgress});check(signal);
    const recognizer=new loaded.KaldiRecognizer(16000);recognizer.setWords(true);
    const cues=[];let pending=null,finished=false,fedEnd=0;
    const settle=error=>{if(!pending)return;const wait=pending;pending=null;clearTimeout(wait.timer);error?wait.reject(error):wait.resolve();};
    recognizer.on('result',message=>{
      if(finished)return;
      const result=message?.result;
      if(typeof result?.text==='string'&&result.text.trim()){
        const words=Array.isArray(result.result)?result.result.filter(word=>Number.isFinite(word.start)&&Number.isFinite(word.end)&&word.end>word.start):[];
        const start=Math.max(0,words[0]?.start??(cues.at(-1)?.end||0));
        const end=Math.min(Number.isFinite(source.duration)&&source.duration>0?source.duration:fedEnd,words.at(-1)?.end??fedEnd);
        if(end>start)cues.push({id:`local:${cues.length}`,start,end,text:result.text.trim().slice(0,24000)});
      }
      settle();
    });
    recognizer.on('partialresult',()=>settle());recognizer.on('error',()=>settle(new Error('本地语音识别失败，请重试或缩短音频')));
    const cancel=()=>{settle(signal.reason||abortError());release();};signal?.addEventListener('abort',cancel,{once:true});
    const acknowledged=send=>new Promise((resolve,reject)=>{
      pending={resolve,reject,timer:setTimeout(()=>settle(new Error('本地识别响应超时，请检查设备可用内存')),60000)};
      try{check(signal);send();}catch(error){settle(error);}
    });
    try{
      for await(const chunk of chunksImpl(source,{signal,onProgress})){
        for(let offset=0;offset<chunk.pcm.length;offset+=4096){
          check(signal);fedEnd+=Math.min(4096,chunk.pcm.length-offset)/16000;
          await acknowledged(()=>recognizer.acceptWaveformFloat(chunk.pcm.subarray(offset,offset+4096),16000));
          onProgress({phase:'recognition',done:Math.min(source.duration||fedEnd,fedEnd),total:source.duration||fedEnd,sentences:cues.length});
        }
      }
      check(signal);await acknowledged(()=>recognizer.retrieveFinalResult());check(signal);return cues;
    }catch(error){release();throw error;
    }finally{
      finished=true;settle(abortError());signal?.removeEventListener('abort',cancel);
      if(model?.ready)try{recognizer.remove();}catch{ /* Worker may have closed. */ }
    }
  }
  return{prepare,transcribe,get ready(){return Boolean(model?.ready);},reset(){release();},destroy(){destroyed=true;release();}};
}
