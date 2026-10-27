import {validatePhrasePack,isPackVersion,PACK_DICTIONARY_VERSION} from './local-phrases.mjs?v=0.1.4';

export const TRANSLATION_PACK_ID='rogent-asmr-ja-zh';
export const TRANSLATION_PACK_REPO='https://github.com/RoGent-Z/asmr-zh-translation-pack';
export const TRANSLATION_PACK_CATALOG='https://raw.githubusercontent.com/RoGent-Z/asmr-zh-translation-pack/main/catalog.json';
const raw='https://raw.githubusercontent.com/RoGent-Z/asmr-zh-translation-pack/refs/tags/';
const MAX_BYTES=8*1024*1024;
export function comparePackVersions(a,b){
  if(!isPackVersion(a)||!isPackVersion(b))throw new Error('词组包版本无效');
  const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;
}
function validateRelease(r){
  if(!r||!isPackVersion(r.version)||!isPackVersion(r.minAppVersion)||typeof r.dictionaryVersion!=='string'||r.dictionaryVersion.length>80||r.url!==`${raw}v${r.version}/packs/asmr-ja-zh.json`||!Number.isSafeInteger(r.bytes)||r.bytes<2||r.bytes>MAX_BYTES||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||![r.phrases,r.glosses].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=10000)||r.phrases+r.glosses===0)throw new Error('词组包版本清单无效');
  return{version:r.version,minAppVersion:r.minAppVersion,dictionaryVersion:r.dictionaryVersion,url:r.url,bytes:r.bytes,sha256:r.sha256,phrases:r.phrases,glosses:r.glosses};
}
export function validatePackCatalog(c){
  if(c?.kind!=='asmr-translation-pack-catalog'||c.version!==1||c.id!==TRANSLATION_PACK_ID||!Array.isArray(c.releases)||c.releases.length<1||c.releases.length>100)throw new Error('词组包目录无效');
  const seen=new Set(),releases=c.releases.map(r=>{const clean=validateRelease(r);if(seen.has(clean.version))throw new Error('词组包版本重复');seen.add(clean.version);return clean;}).sort((a,b)=>comparePackVersions(b.version,a.version));
  return{kind:c.kind,version:1,id:c.id,releases};
}
export function assertPackCompatibility(release,appVersion){
  if(!isPackVersion(appVersion)||comparePackVersions(appVersion,release.minAppVersion)<0)throw new Error(`请先更新网站到 v${release.minAppVersion} 或更新版本`);
  if(release.dictionaryVersion!==PACK_DICTIONARY_VERSION)throw new Error('此版本需要不同的基础词库，请先更新网站');
}
async function fetchBytes(url,{fetchImpl=globalThis.fetch,signal,limit,expectedBytes,onProgress=()=>{},timeoutMs=30000}={}){
  signal?.throwIfAborted();const control=new AbortController(),forward=()=>control.abort(signal.reason);signal?.addEventListener('abort',forward,{once:true});
  const timer=setTimeout(()=>control.abort(new DOMException('下载超时，请检查网络后重试','TimeoutError')),timeoutMs);let reader;
  try{
    let response;try{response=await fetchImpl(url,{signal:control.signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'});}catch(error){if(control.signal.aborted)throw control.signal.reason;throw new Error('无法连接词组包下载源，请检查网络；已安装的包仍可使用');}
    control.signal.throwIfAborted();if(!response.ok||!response.body)throw new Error(`词组包下载失败（HTTP ${response.status}），原包保留`);
    if(Number(response.headers.get('content-length'))>limit)throw new Error('词组包下载大小超过上限');
    reader=response.body.getReader();const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();control.signal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>limit||(expectedBytes&&size>expectedBytes))throw new Error('词组包下载大小与清单不一致');chunks.push(value);onProgress({done:size,total:expectedBytes||0});}
    if(expectedBytes&&size!==expectedBytes)throw new Error('词组包下载不完整，原包保留');
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);try{await reader?.cancel();}catch{}}
}
function json(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('词组包文件不是有效的 JSON，原包保留');}}
export async function fetchPackCatalog(options={}){
  return validatePackCatalog(json(await fetchBytes(TRANSLATION_PACK_CATALOG,{...options,limit:256*1024,timeoutMs:options.timeoutMs??15000})));
}
export async function loadTranslationPack(release,{appVersion,...options}={}){
  const r=validateRelease(release);assertPackCompatibility(r,appVersion);
  const bytes=await fetchBytes(r.url,{...options,limit:MAX_BYTES,expectedBytes:r.bytes});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==r.sha256)throw new Error('词组包完整性校验失败，原包保留');
  const pack=validatePhrasePack(json(bytes));
  if(pack.package?.id!==TRANSLATION_PACK_ID||pack.package.version!==r.version||pack.package.dictionaryVersion!==r.dictionaryVersion||pack.package.license!=='CC-BY-SA-4.0'||pack.entries.length!==r.phrases||(pack.glosses?.length||0)!==r.glosses)throw new Error('词组包内容与版本清单不一致，原包保留');
  options.signal?.throwIfAborted();return pack;
}
