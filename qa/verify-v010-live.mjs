// Real anonymous production network, native Edge audio, no intercepted responses.
// Only counts and technical properties are retained; downloaded audio is deleted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const project=path.resolve(import.meta.dirname,'../..');
const resolver='https://asmr-player-resolver.navyelf7.chatgpt.site';
const player='https://rogent-z.github.io/asmr-local-player/';
const source='https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/multiple-audio-formats.html';
const report=process.env.V010_REPORT||path.join(project,'reports/v010/live-verification.json');
const channel=process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':null);
const browser=await chromium.launch({...(channel?{channel}:{}),headless:true,args:['--mute-audio']});
const context=await browser.newContext({acceptDownloads:true});
await context.addInitScript(()=>{
  Object.defineProperty(window,'showDirectoryPicker',{value:undefined,configurable:true});
  window.__audioContexts=[];const Original=window.AudioContext;
  if(Original)window.AudioContext=class extends Original{constructor(...args){super(...args);window.__audioContexts.push(this);}};
});
const page=await context.newPage();let stage='health and public URL contracts',download;
const stats={testedAt:new Date().toISOString(),browser:browser.version(),hostPlatform:process.platform,actualPhone:false,mockedResponses:false,source};
try{
  await page.goto(player,{waitUntil:'networkidle'});
  assert.equal(await page.locator('meta[name="app-version"]').getAttribute('content'),'0.0.10');
  stats.network=await page.evaluate(async({resolver,source})=>{
    const health=await fetch(resolver+'/health',{credentials:'omit'});if(!health.ok)throw Error('health '+health.status);
    const result={health:health.status,version:(await health.json()).version,sources:[]};
    for(const url of [source,source.replace('multiple-audio-formats.html','viper.mp3'),'https://asmr.one/work/RJ01603178']){
      const response=await fetch(resolver+'/api/resolve?url='+encodeURIComponent(url),{credentials:'omit'});
      if(!response.ok)throw Error('resolve '+response.status);
      const w=await response.json(),audio=w.entries.find(e=>e.type==='audio');
      const r=await fetch(audio.url,{headers:{Range:'bytes=0-63'},credentials:'omit'});
      const bytes=(await r.arrayBuffer()).byteLength;
      result.sources.push({provider:w.provider,entries:w.entries.length,audio:w.entries.filter(e=>e.type==='audio').length,rangeStatus:r.status,contentLength:Number(r.headers.get('content-length')),bytes});
    }
    return result;
  },{resolver,source});
  assert.equal(stats.network.version,'0.0.7');
  assert.deepEqual(stats.network.sources.map(x=>x.provider),['web','web','asmr-one']);
  for(const x of stats.network.sources){assert.equal(x.rangeStatus,206);assert.equal(x.contentLength,64);assert.equal(x.bytes,64);}
  stage='generic HTML URL import';await page.locator('#chooseStreamButton').click();
  await page.locator('#streamUrl').fill(source);await page.locator('#streamAdd').click();
  await page.waitForFunction(()=>document.querySelector('#streamStatus').textContent.startsWith('已添加'),null,{timeout:45000});
  await page.waitForFunction(()=>!document.querySelector('#playButton').disabled);
  assert.equal(await page.locator('#streamFormat').inputValue(),'mp3');
  await page.locator('#streamClose').click();
  stage='native playback WebAudio and seek';await page.locator('#playButton').click();
  await page.waitForFunction(()=>document.querySelector('#audioLeft').currentTime>.3);
  await page.locator('#progress').evaluate(n=>{n.value='500';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>{const a=document.querySelector('#audioLeft');return a.currentTime>a.duration*.4;});
  stats.playback=await page.evaluate(()=>({advanced:true,seek:true,crossOrigin:document.querySelector('#audioLeft').crossOrigin,audioContextRunning:window.__audioContexts.some(c=>c.state==='running')}));
  assert.equal(stats.playback.audioContextRunning,true);assert.equal(stats.playback.crossOrigin,'anonymous');await page.locator('#playButton').click();
  stage='refresh restoration';await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>!document.querySelector('#playButton').disabled);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('asmr-player:remote-library:v1')).length),1);
  await page.locator('#menuButton').click();assert.equal(await page.locator('.work-cloud-badge').count(),1);assert.equal(await page.locator('.collection-header').count(),0);await page.keyboard.press('Escape');stats.persisted=true;
  stage='streaming ZIP';await page.locator('#streamButton').click();await page.locator('#streamFilesPanel summary').click();await page.locator('#streamSelectNone').click();
  await page.locator('#streamFileList input').evaluateAll(nodes=>{const audio=nodes.find(n=>/\.mp3$/i.test(n.dataset.path));if(!audio)throw Error('MP3 missing');audio.click();});
  const pending=page.waitForEvent('download',{timeout:45000});await page.locator('#streamDownload').click();download=await pending;
  const archive=await download.path();assert.ok(archive);
  await page.waitForFunction(()=>document.querySelector('#streamStatus').textContent.includes('交给浏览器'),null,{timeout:45000});
  const bytes=(await fs.stat(archive)).size;
  const python=process.env.PYTHON_EXE||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const check=spawnSync(python,['-c','import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"files":len(z.infolist()),"crcValid":z.testzip() is None}))',archive],{encoding:'utf8'});
  assert.equal(check.status,0);const zip=JSON.parse(check.stdout);assert.equal(zip.files,1);assert.equal(zip.crcValid,true);assert.ok(bytes>1000000);
  stats.download={streamingZip:true,selectedFiles:1,bytes,independentCrcValid:true};
  await download.delete();download=null;
  stage='actual online ASMR subtitles in Folia';
  await page.locator('#streamUrl').fill('https://asmr.one/work/RJ01603178');await page.locator('#streamAdd').click();
  await page.waitForFunction(()=>document.querySelector('#streamStatus').textContent.startsWith('已添加'),null,{timeout:45000});
  await page.locator('#streamClose').click();await page.locator('#menuButton').click();
  const card=page.locator('.work-card[data-provider="asmr-one"]').first();
  if(!await card.evaluate(n=>n.classList.contains('expanded')))await card.locator('.work-header').click();
  await card.locator('.track-button').evaluateAll(buttons=>{
    const item=buttons.find(b=>b.querySelector('.track-badge')?.textContent!=='无字幕');if(!item)throw Error('No subtitled track');item.click();
  });
  await page.waitForFunction(()=>!document.querySelector('#playButton').disabled&&document.querySelectorAll('.dialogue-item').length>0,null,{timeout:45000});
  if(await page.locator('#backgroundDialog').isVisible())await page.locator('#backgroundGallery .background-choice').first().click();
  if(await page.locator('#playButton').getAttribute('aria-label')==='暂停')await page.locator('#playButton').click();
  await page.locator('#dialogueButton').click();await page.locator('.dialogue-item').first().click();await page.keyboard.press('Escape');
  const asmrSrc=await page.locator('#audioLeft').evaluate(a=>a.src);
  await page.locator('#foliaButton').click();await page.locator('#foliaStage').waitFor({state:'visible'});
  assert.ok(await page.locator('#foliaCurrent [data-folia-id]').count()>0);
  assert.ok(await page.locator('#foliaCurrent .folia-glyph').count()>0);
  assert.equal(await page.locator('#foliaStage').getAttribute('data-renderer'),'canvas');
  await page.waitForFunction(()=>['ready','neutral'].includes(document.querySelector('#app').dataset.foliaTheme)&&document.querySelector('#workBackground').naturalWidth>0);
  stats.background=await page.evaluate(()=>({
    imageShown:document.querySelector('#app').classList.contains('folia-image'),
    blur:getComputedStyle(document.querySelector('#workBackground')).filter,
    theme:document.querySelector('#app').dataset.foliaTheme,
    sourceRecorded:false,
  }));
  assert.equal(stats.background.imageShown,true);assert.equal(stats.background.blur,'blur(14px)');
  const scene=await page.locator('#foliaSceneCanvas').evaluate(canvas=>{
    const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let green=0;const colors=new Set();
    for(let i=0;i<bytes.length;i+=4*113){const r=bytes[i],g=bytes[i+1],b=bytes[i+2];if(g>45&&g>r*1.15)green++;colors.add((r>>3)<<10|(g>>3)<<5|(b>>3));}
    return {pixels:canvas.width*canvas.height,colors:colors.size,green};
  });
  assert.ok(scene.pixels<=2500000&&scene.colors>30&&scene.green>0);
  assert.equal(await page.locator('#audioLeft').evaluate(a=>a.src),asmrSrc);
  const cueTime=await page.locator('#audioLeft').evaluate(a=>a.currentTime);
  await page.locator('#playButton').click();await page.waitForFunction(t=>document.querySelector('#audioLeft').currentTime>t+.2,cueTime);
  await page.locator('#foliaExit').click();assert.equal(await page.locator('#playButton').getAttribute('aria-label'),'暂停');
  await page.locator('#playButton').click();
  stats.folia={actualOnlineAsmrSubtitles:true,stageShown:true,sentenceCountPositive:true,playbackAdvanced:true,togglePreservedAudio:true,originalTextRecorded:false,canvasScene:true,glyphSweep:true,scene};
  stats.originalMediaRetained=false;stats.passed=true;
}catch(error){stats.passed=false;stats.failure={stage,message:error.message.split('\n')[0]};process.exitCode=1;}
finally{if(download)await download.delete().catch(()=>{});await browser.close();await fs.writeFile(report,JSON.stringify(stats,null,2)+'\n');console.log(JSON.stringify(stats));}
