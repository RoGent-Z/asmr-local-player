import {chunkAudio} from './audio-chunks.mjs';
import {canReadAiAudio} from './ai-workbench.mjs';
const COMPAT_BYTES=64*1024*1024;
const check=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');};

async function boundedBytes(response,limit,signal){
  const size=Number(response.headers.get('Content-Length'));
  if(size>limit){await response.body?.cancel();throw new Error('音源不支持有界分段读取且体积较大，请下载后选择本机文件');}
  const parts=[];let length=0;
  if(!response.body?.getReader){const data=new Uint8Array(await response.arrayBuffer());if(data.length>limit)throw new Error('音频分段大小超限');return data;}
  const reader=response.body.getReader();
  try{while(true){check(signal);const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw new Error('音频分段大小超限');parts.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

export async function openLocalAudio(source,{baseUrl=globalThis.location?.href,fetchImpl=globalThis.fetch,signal}={}){
  check(signal);if(source.blob)return source.blob;
  if(!canReadAiAudio(source,baseUrl))throw new Error('当前音频来源不可读取，请选择本机文件或已解析作品');
  const url=new URL(source.audioUrl,baseUrl);
  const fetchRange=(first,last)=>fetchImpl(url,{headers:{Range:`bytes=${first}-${last}`},signal,credentials:'omit',redirect:'error'});
  const response=await fetchRange(0,0);
  if(response.status===200)return new Blob([await boundedBytes(response,COMPAT_BYTES,signal)],{type:response.headers.get('Content-Type')||'application/octet-stream'});
  const match=/^bytes 0-0\/(\d+)$/.exec(response.headers.get('Content-Range')||'');
  if(response.status!==206||!match){await response.body?.cancel();throw new Error('音源分段 Range 响应无效');}
  const size=Number(match[1]);if(!Number.isSafeInteger(size)||size<1||size>16*1024**3)throw new Error('音源分段大小无效');
  if((await boundedBytes(response,1,signal)).length!==1)throw new Error('音源分段 Range 长度无效');
  return{size,slice(start=0,end=size){
    const first=Math.max(0,Math.min(size,Math.trunc(start))),stop=Math.max(first,Math.min(size,Math.trunc(end)));
    return{size:stop-first,async arrayBuffer(){
      check(signal);if(first===stop)return new ArrayBuffer(0);
      const result=await fetchRange(first,stop-1),expected=`bytes ${first}-${stop-1}/${size}`;
      if(result.status!==206||result.headers.get('Content-Range')!==expected){await result.body?.cancel();throw new Error('音源分段 Range 与请求不符');}
      const bytes=await boundedBytes(result,stop-first,signal);if(bytes.length!==stop-first)throw new Error('音源分段不完整');return bytes.buffer;
    }};
  }};
}

export function monoPcm(buffer,{start=0,end=buffer.duration,targetRate=16000}={}){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||!Number.isFinite(targetRate)||targetRate<=0||!buffer.numberOfChannels)throw new Error('音频采样参数无效');
  const begin=Math.max(0,start),finish=Math.min(buffer.duration,end),count=Math.max(0,Math.round((finish-begin)*targetRate));
  if(count>16000*60)throw new Error('本地识别片段过长');
  const channels=Array.from({length:Math.min(8,buffer.numberOfChannels)},(_,i)=>buffer.getChannelData(i));
  const output=new Float32Array(count),ratio=buffer.sampleRate/targetRate;
  for(let i=0;i<count;i++){
    const position=begin*buffer.sampleRate+i*ratio,first=Math.min(buffer.length-1,Math.floor(position)),last=Math.min(buffer.length-1,first+1),fraction=position-first;
    let value=0;for(const channel of channels)value+=channel[first]*(1-fraction)+channel[last]*fraction;
    output[i]=Math.max(-1,Math.min(1,value/channels.length));
  }
  return output;
}

export async function* localPcmChunks(source,{signal,onProgress=()=>{},fetchImpl=globalThis.fetch,baseUrl=globalThis.location?.href}={}){
  const audio=await openLocalAudio(source,{signal,fetchImpl,baseUrl});
  const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Audio)throw new Error('当前浏览器不支持本地音频解码');
  const context=new Audio({sampleRate:16000});
  try{
    for await(const chunk of chunkAudio(audio,{name:source.name,chunkSeconds:20,maxBytes:2*1024*1024,signal})){
      check(signal);const bytes=await chunk.blob.arrayBuffer();check(signal);
      let decoded;try{decoded=await context.decodeAudioData(bytes);}catch{throw new Error('浏览器无法解码当前音频片段，本地识别支持MP3／PCM或浮点WAV');}
      check(signal);
      const pcm=monoPcm(decoded,{start:Math.max(0,chunk.ownedStart-chunk.start),end:Math.min(decoded.duration,chunk.ownedEnd-chunk.start)});
      yield{pcm,start:chunk.ownedStart,end:chunk.ownedEnd,sampleRate:16000};
      onProgress({phase:'audio',done:chunk.ownedEnd,total:source.duration||chunk.ownedEnd});
    }
  }finally{await context.close().catch(()=>{});}
}
