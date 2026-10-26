const DB_NAME='asmr-player:local-japanese:v1';
const DEFAULT_MANIFEST=new URL('../language/v1/manifest.json',import.meta.url).href;
const aborted=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('已取消','AbortError');};
const sha256=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');

export function createLanguageStorage(idb=globalThis.indexedDB){
  let connection;
  async function open(){
    if(connection)return connection;
    if(!idb)throw new Error('浏览器不允许本地数据库');
    connection=await new Promise((resolve,reject)=>{
      const request=idb.open(DB_NAME,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('packs');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('本地语言库被其他页面占用'));
    });
    connection.onversionchange=()=>{connection?.close();connection=null;};return connection;
  }
  async function operation(mode,action){
    const database=await open();
    return new Promise((resolve,reject)=>{
      const transaction=database.transaction('packs',mode),store=transaction.objectStore('packs');let result;
      const request=action(store);if(request)request.onsuccess=()=>{result=request.result;};
      transaction.oncomplete=()=>resolve(result);transaction.onabort=()=>reject(transaction.error||new Error('语言缓存事务失败'));transaction.onerror=()=>{};
    });
  }
  return{get:key=>operation('readonly',store=>store.get(key)),put:(key,value)=>operation('readwrite',store=>store.put(value,key)),clear:()=>operation('readwrite',store=>store.clear()),close(){connection?.close();connection=null;}};
}

function validateManifest(value){
  if(value?.kind!=='asmr-local-language'||typeof value.version!=='string'||value.version.length>100||!Number.isSafeInteger(value.entries)||value.entries<1||value.entries>400000||!Array.isArray(value.dictionary)||value.dictionary.length<1||value.dictionary.length>16)throw new Error('本地词库清单无效');
  const seen=new Set();let total=0;
  for(const file of value.dictionary){
    if(!/^language\/v1\/ja-zh-\d{2}\.json$/.test(file?.path)||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<2||file.bytes>8*1024*1024||!/^\w{64}$/.test(file.sha256)||!/^[0-9a-f]+$/.test(file.sha256))throw new Error('本地词库清单路径或校验值无效');
    seen.add(file.path);total+=file.bytes;
  }
  if(total>64*1024*1024)throw new Error('本地词库清单过大');return value;
}

async function fetchAsset(url,file,{signal,fetchImpl,onBytes}){
  const response=await fetchImpl(url,{signal,credentials:'omit',redirect:'error'});
  if(!response.ok||response.status!==200)throw new Error('词库下载失败，请检查网络后重试');
  const chunks=[];let length=0;
  if(response.body?.getReader){
    const reader=response.body.getReader();
    try{while(true){aborted(signal);const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>file.bytes)throw new Error('词库文件大小校验失败');chunks.push(value);onBytes?.(value.length);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }else{const data=new Uint8Array(await response.arrayBuffer());length=data.length;chunks.push(data);onBytes?.(length);}
  if(length!==file.bytes)throw new Error('词库下载不完整，大小校验失败');
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(await sha256(bytes)!==file.sha256)throw new Error('词库文件校验失败，请重试');aborted(signal);return bytes.buffer;
}

export async function loadLocalDictionary({manifestURL=DEFAULT_MANIFEST,signal,onProgress=()=>{},fetchImpl=globalThis.fetch,storage=createLanguageStorage()}={}){
  aborted(signal);let previous;
  try{previous=await storage.get('pack');}catch{ /* Memory-only loading remains available. */ }
  let manifest;
  try{
    const response=await fetchImpl(manifestURL,{signal,credentials:'omit',redirect:'error',cache:'no-cache'});
    if(!response.ok)throw new Error('网络不可用');
    const text=await response.text();if(text.length>128000)throw new Error('本地词库清单过大');manifest=validateManifest(JSON.parse(text));
  }catch(error){aborted(signal);if(!previous?.manifest)throw error;manifest=validateManifest(previous.manifest);}
  const total=manifest.dictionary.reduce((sum,file)=>sum+file.bytes,0);let done=0,cached=false,buffers=[];
  if(previous?.manifest?.version===manifest.version&&Array.isArray(previous.buffers)&&previous.buffers.length===manifest.dictionary.length){
    let valid=true;
    for(let index=0;index<previous.buffers.length;index++){
      const buffer=previous.buffers[index],file=manifest.dictionary[index];
      if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==file.bytes||await sha256(buffer)!==file.sha256){valid=false;break;}
    }
    if(valid){cached=true;buffers=previous.buffers;done=total;onProgress({phase:'cached',done,total});}
  }
  if(!cached)for(const file of manifest.dictionary){
    // Manifest paths are relative to the website root, never to another host.
    const url=new URL('../../'+file.path,manifestURL);
    buffers.push(await fetchAsset(url,file,{signal,fetchImpl,onBytes:count=>{done+=count;onProgress({phase:'download',done,total});}}));
  }
  aborted(signal);const records=[];
  for(const buffer of buffers){
    const rows=JSON.parse(new TextDecoder().decode(buffer));if(!Array.isArray(rows))throw new Error('词库内容格式无效');
    for(const row of rows)records.push(row);
  }
  if(records.length!==manifest.entries)throw new Error('词库条目完整性校验失败');
  let persisted=cached,warning='';
  if(!cached){
    aborted(signal);
    try{await storage.put('pack',{manifest,buffers});persisted=true;}catch{warning='无法保存语言缓存，本次仍可使用；下次可能需要重新下载。';}
  }
  onProgress({phase:'ready',done:total,total});return{manifest,records,cached,persisted,warning};
}
