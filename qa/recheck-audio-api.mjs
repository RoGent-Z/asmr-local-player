// Read-only diagnostics: never persist source titles, transcripts or media URLs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const resolver='https://asmr-player-resolver.navyelf7.chatgpt.site',player='https://rogent-z.github.io/asmr-local-player/';
const hosts=['api.asmr-200.com','api.asmr.one','api.asmr-100.com','api.asmr-300.com'];
const works=[{id:'1718088',code:'RJ01718088'},{id:'1603178',code:'RJ01603178'}];
const generic='https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/multiple-audio-formats.html';
const report=process.env.AUDIO_API_REPORT||path.resolve(import.meta.dirname,'../../reports/v0101/api-recheck/local.json');
const stats={at:new Date().toISOString(),platform:process.platform,mockedResponses:false,actualPhone:false,resolver:[],upstream:[],browser:{},mediaRetained:false};
const media=new Map();
async function inspect(url,{json=false,range=false}={}){
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error',credentials:'omit',headers:range?{Range:'bytes=0-63',Origin:'https://rogent-z.github.io'}:{Accept:'application/json'}});
    const base={status:r.status,type:r.headers.get('content-type'),cors:r.headers.get('access-control-allow-origin'),range:r.headers.get('content-range')};
    if(range){if(r.status===206){const data=new Uint8Array(await r.arrayBuffer());return {...base,bytes:data.length};}await r.body?.cancel();return base;}
    const text=await r.text();if(text.length>2*1024*1024)throw Error('Diagnostic response exceeds limit');
    if(json&&r.ok){try{return {...base,data:JSON.parse(text)};}catch{return {...base,invalidJson:true};}}
    return {...base,protectionBlocked:/Attention Required|you have been blocked/i.test(text),title:/<title>([^<]{0,120})<\/title>/i.exec(text)?.[1]||null};
  }catch(error){return {error:error.message,code:error.cause?.code||error.name};}
}
function chooseAudio(nodes){let fallback;for(const n of nodes||[]){if(n.type==='folder'){const found=chooseAudio(n.children);if(found)return found;}else if(n.type==='audio'){const raw=n.mediaStreamUrl||n.mediaDownloadUrl;try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||!(hosts.includes(u.hostname)||/(?:^|\.)kiko-play-niptan\.one$/.test(u.hostname)))continue;if(/\.mp3$/i.test(n.title||''))return u.href;fallback??=u.href;}catch{}}}return fallback;}
stats.resolver.push({path:'/health',...await inspect(resolver+'/health',{json:true})});
// Only the known health version is retained from successful JSON.
const health=stats.resolver[0];if(health.data){health.version=health.data.version;delete health.data;}
for(const source of [...works.map(w=>'https://asmr.one/work/'+w.code),generic]){
  const result=await inspect(resolver+'/api/resolve?url='+encodeURIComponent(source),{json:true}),data=result.data;delete result.data;
  const row={source,...result};if(data){row.provider=data.provider;row.entries=data.entries?.length;row.audio=data.entries?.filter(x=>x.type==='audio').length;const audio=data.entries?.find(x=>x.type==='audio'&&/\.mp3$/i.test(x.path))||data.entries?.find(x=>x.type==='audio');if(audio){row.audioRange=await inspect(audio.url,{range:true});if(source.includes(works[0].code))media.set('resolved',audio.url);}}
  stats.resolver.push(row);
}
for(const work of works){
  for(let i=0;i<hosts.length;i+=2){
    const group=await Promise.all(hosts.slice(i,i+2).map(async host=>{
      const [info,tracks]=await Promise.all([inspect(`https://${host}/api/workInfo/${work.id}`,{json:true}),inspect(`https://${host}/api/tracks/${work.id}?v=2`,{json:true})]);
      const row={work:work.code,host,info:{status:info.status,cors:info.cors,error:info.error,valid:typeof info.data?.title==='string'},tracks:{status:tracks.status,cors:tracks.cors,error:tracks.error,valid:Array.isArray(tracks.data)}};
      if(Array.isArray(tracks.data)){let count=0;const walk=nodes=>{for(const n of nodes){if(n.type==='folder')walk(n.children||[]);else if(n.type==='audio')count++;}};walk(tracks.data);row.tracks.audio=count;const audio=chooseAudio(tracks.data);if(audio&&!media.has(work.code))media.set(work.code,audio);}
      return row;
    }));stats.upstream.push(...group);
  }
  const audio=media.get(work.code);if(audio)stats.upstream.push({work:work.code,stage:'audio CDN',host:new URL(audio).hostname,...await inspect(audio,{range:true})});
}
const browser=await chromium.launch({...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:process.platform==='win32'?{channel:'msedge'}:{}),headless:true,args:['--mute-audio']}),page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(40000);
try{
  await page.goto(player);stats.browser.version=await page.locator('meta[name="app-version"]').getAttribute('content');
  stats.browser.cors=await page.evaluate(async({resolver,hosts,id})=>{const rows=[];for(const url of [resolver+'/health',...hosts.map(h=>`https://${h}/api/workInfo/${id}`)]){try{const r=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(10000)});await r.body?.cancel();rows.push({host:new URL(url).hostname,status:r.status});}catch(e){rows.push({host:new URL(url).hostname,error:e.message});}}return rows;},{resolver,hosts,id:works[0].id});
  await page.locator('#chooseStreamButton').click();await page.locator('#streamUrl').fill('https://asmr.one/work/'+works[0].code);await page.locator('#streamAdd').click();
  await page.waitForFunction(()=>document.querySelector('#streamStatus').dataset.error==='true'||document.querySelector('#streamStatus').textContent.startsWith('已添加'),null,{timeout:45000});
  stats.browser.actualImport={error:await page.locator('#streamStatus').getAttribute('data-error')==='true',message:await page.locator('#streamStatus').textContent()};await page.locator('#streamClose').click();
  const audio=media.get('resolved')||media.get(works[0].code);
  if(audio){
    stats.browser.directAudio=await page.evaluate(url=>new Promise(resolve=>{const a=new Audio();a.crossOrigin='anonymous';a.preload='metadata';a.muted=true;let finished=false;const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);a.pause();a.removeAttribute('src');a.load();resolve(result);},timer=setTimeout(()=>finish({error:'media timeout'}),15000);a.onerror=()=>finish({error:'media error',code:a.error?.code});a.onloadedmetadata=()=>a.play().catch(e=>finish({error:e.name}));a.ontimeupdate=()=>{if(a.currentTime>.25)finish({metadata:true,played:true,durationFinite:Number.isFinite(a.duration),host:new URL(url).hostname});};a.src=url;}),audio);
  }
  stats.diagnosticCompleted=true;
}finally{await browser.close();await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,JSON.stringify(stats,null,2));console.log(JSON.stringify(stats));}
