// Browser CORS is the permission boundary. This path never proxies a URL or
// forwards cookies, and accepts only the exact audio address entered by the user.
const formats = new Set(['mp3','wav','m4a','aac','ogg','opus','flac','webm','mp4','oga']);
const types = new Set(['audio/mpeg','audio/mp3','audio/wav','audio/wave','audio/x-wav','audio/vnd.wave','audio/mp4','audio/x-m4a','audio/aac','audio/aacp','audio/ogg','application/ogg','audio/opus','audio/flac','audio/x-flac','audio/webm','video/webm','video/mp4']);

export function isDirectAudioUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash
      &&host.includes('.')&&!/^[\d.]+$/.test(host)&&!host.includes(':')
      &&!/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      &&formats.has(/\.([a-z0-9]+)$/i.exec(url.pathname)?.[1].toLowerCase());
  } catch { return false; }
}

export function isDirectAudioSource(source) {
  return source?.transport==='direct'&&source.remoteProvider==='web'
    &&source.audioUrl===source.sourceUrl&&isDirectAudioUrl(source.sourceUrl);
}

export async function probeDirectAudio(value,{fetchImpl=globalThis.fetch,signal,timeoutMs=8000}={}) {
  if(!isDirectAudioUrl(value))return null;
  if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let response;
  try {
    response=await fetchImpl(value,{headers:{Range:'bytes=0-0'},credentials:'omit',redirect:'error',signal:controller.signal});
    if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');
    if(controller.signal.aborted)return null;
    if(![200,206].includes(response.status)||!types.has(response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()))return null;
    const range=response.headers.get('Content-Range');
    if(response.status===206&&range&&!/^bytes 0-0\/[1-9]\d*$/.test(range))return null;
    if(response.status===200&&range)return null;
    if(response.status===206){
      const reader=response.body?.getReader();if(!reader)return null;let received=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>1)return null;}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(received!==1)return null;
    }
    // Content-Range is not CORS-safelisted. Without it, do not mistake the
    // one-byte probe's Content-Length for the size of the entire audio file.
    const size=Number(response.status===206?range?.split('/')[1]:response.headers.get('Content-Length'));
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    const id=Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('').slice(0,24);
    let filename;
    try{filename=decodeURIComponent(new URL(value).pathname.split('/').at(-1));}catch{filename=new URL(value).pathname.split('/').at(-1);}
    filename=filename.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').slice(-240);
    if(!filename||filename==='.'||filename==='..')return null;
    return {version:1,provider:'web',transport:'direct',workId:id,sourceUrl:value,code:'',
      title:filename.replace(/\.[^.]+$/,''),coverUrl:null,resolvedAt:new Date().toISOString(),
      entries:[{id:'audio',path:filename,type:'audio',url:value,downloadUrl:value,
        ...(Number.isSafeInteger(size)&&size>0?{size}:{})}]};
  } catch(error) {
    if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');
    return null;
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    await response?.body?.cancel().catch(()=>{});
  }
}
