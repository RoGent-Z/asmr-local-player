import {createLocalDictionaryClient} from './local-dictionary-client.mjs?v=0.1.4';
import {fetchPackCatalog,loadTranslationPack,comparePackVersions,assertPackCompatibility,TRANSLATION_PACK_ID} from './translation-pack-catalog.mjs?v=0.1.4';
import {createLocalAsr} from './local-asr.mjs';
import {makeTranscriptDocument,mergeTranscriptDocuments,displaySourceCues,exportTimedText} from './transcript.mjs';
const ids=['localDialog','localClose','localPrepare','localClearCache','localDictionaryStatus','localAsrStatus','localTrackName','localForm','localTaskMode','localSource','localStart','localCancel','localProgress','localStatus','localDisplayMode','localCoverage','localPreview','localApply','localRestore','localExportVtt','localExportSrt','localExportJson','localPhraseImport','localPhraseFile','localPhraseStatus','localPhraseRemove','localPackInstall','localPackCheck','localPackVersion','localPackStatus'];
const root=new URL('../',import.meta.url);
const canceled=()=>new DOMException('任务已取消','AbortError');

export function createLocalWorkbench({getContext,onApply,onRestore,onOpenChange=()=>{}}){
  const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)])),entry=document.querySelector('#localTranslateButton');
  let dictionary=createLocalDictionaryClient(),metadata=null,asr=null,controller=null,serial=0,busy=false,documentResult=null,summary=null,taskTrack=null;
  const results=new Map();let viewTrack=null,clearingCache=false,importingPhrases=false;
  let packCatalog=null,installedPackage=null;
  const appVersion=document.querySelector('meta[name="app-version"]').content;
  const status=(text,error=false)=>{el.localStatus.textContent=text;el.localStatus.classList.toggle('is-error',error);};
  function context(){try{return getContext();}catch{return null;}}
  function setBusy(value){
    busy=value;for(const id of ['localPrepare','localClearCache','localTaskMode','localSource','localPhraseImport','localPhraseRemove','localPackInstall','localPackCheck','localPackVersion'])el[id].disabled=value;
    el.localStart.disabled=value||!context()?.sources?.length;el.localCancel.disabled=!value||clearingCache||importingPhrases;
    el.localRestore.disabled=clearingCache||importingPhrases;
  }
  function renderPackInfo(info){
    installedPackage=info.package||null;
    const has=info.phrases||info.glosses;
    el.localPhraseStatus.textContent=has?`${installedPackage?'已安装 v'+installedPackage.version:'本机导入 · 未标版本'}：${info.phrases||0} 条精确短语 · ${info.glosses||0} 项词义偏好 · ${info.persisted?'已保存在此浏览器':'本次可用，未能缓存'}`:'未安装可选词组包，当前使用基础词库。';
    renderPackCatalog();
  }
  function renderPackCatalog(){
    if(!packCatalog)return;const selected=el.localPackVersion.value;
    el.localPackVersion.replaceChildren(new Option(`最新版 · v${packCatalog.releases[0].version}`,'latest'));
    for(const r of packCatalog.releases){const option=new Option(`v${r.version} · ${r.glosses} 项词义`,r.version);try{assertPackCompatibility(r,appVersion);}catch{option.disabled=true;option.textContent+=` · 需更新网站`;}el.localPackVersion.append(option);}
    if([...el.localPackVersion.options].some(o=>o.value===selected&&!o.disabled))el.localPackVersion.value=selected;
    const latest=packCatalog.releases[0];let text=`最新版 v${latest.version} · ${latest.glosses} 项词义偏好`;
    if(installedPackage?.id===TRANSLATION_PACK_ID){const compared=comparePackVersions(latest.version,installedPackage.version);text+=compared>0?' · 有可用更新':compared===0?' · 已是最新版':' · 本机版本较新';}
    try{assertPackCompatibility(latest,appVersion);}catch(error){text+=` · ${error.message}`;}el.localPackStatus.textContent=text;
  }
  async function refreshPackInfo(){
    if(busy)return;const run=serial;
    try{const info=await dictionary.phraseStatus();if(run===serial&&!busy)renderPackInfo(info);}catch{if(run===serial&&!busy)el.localPhraseStatus.textContent='本机状态暂不可读，安装后可在当前页面使用。';}
  }
  function progress(value,run){
    if(run!==serial)return;
    if(Number.isFinite(value.total)&&value.total>0){el.localProgress.value=Math.max(0,Math.min(1,value.done/value.total));}
    else el.localProgress.removeAttribute('value');
    const mb=n=>(n/1024/1024).toFixed(1);
    if(value.phase==='download')status(`正在下载日中词库 ${mb(value.done)} / ${mb(value.total)} MiB…`);
    else if(value.phase==='cached')status('正在从浏览器本机缓存读取词库…');
    else if(value.phase==='index')status('正在建立本地词形索引…');
    else if(value.phase==='runtime'||value.phase==='model')status('正在准备本地日语听写，首次需下载并展开语言库，请保持页面打开…');
    else if(value.phase==='recognition')status(`正在本机听写 ${Math.floor(value.done)} / ${Math.ceil(value.total)} 秒 · 已识别 ${value.sentences} 句`);
    else if(value.phase==='translation')status(`正在按词库翻译 ${value.done} / ${value.total} 句…`);
  }
  async function prepare(signal,run,withAsr){
    const ready=await dictionary.prepare({signal,onProgress:value=>progress(value,run)});
    if(run!==serial||signal.aborted)throw canceled();metadata=ready;
    el.localDictionaryStatus.textContent=`${ready.entries.toLocaleString('en-US')} 条词条 · ${ready.cached?'本机缓存':ready.persisted?'已缓存到本机':'本次可用'}`;
    renderPackInfo({...ready,persisted:ready.phrasePersisted});
    document.querySelector('#localResourcesSummary').textContent='词库已就绪 · 听写按需加载';
    document.querySelector('#localResourcesPanel').open=false;
    if(withAsr){
      if(!/^language\/v1\/vosk-ja-0\.22\.tar\.gz$/.test(ready.manifest.asr?.path)||ready.manifest.runtime?.path!=='js/vendor/vosk-0.0.8.js')throw new Error('日语听写资源清单无效');
      asr??=createLocalAsr({modelUrl:new URL(ready.manifest.asr.path,root).href,runtimeUrl:new URL(ready.manifest.runtime.path,root).href});
      el.localAsrStatus.textContent='正在加载本地日语识别…';
      await asr.prepare({signal,onProgress:value=>progress(value,run)});
      if(run!==serial||signal.aborted)throw canceled();el.localAsrStatus.textContent='日语听写已就绪 · 本机运行';
      document.querySelector('#localResourcesSummary').textContent='词库与听写已就绪';
    }
    return ready;
  }
  function renderResult(){
    el.localPreview.replaceChildren();const sources=documentResult?.sources||[],cues=sources.flatMap(source=>source.cues.map(cue=>({...cue,label:source.label})));
    for(const cue of cues.slice(0,8)){
      const row=document.createElement('article');row.className='local-cue';
      const time=document.createElement('span');time.className='local-cue-time';time.textContent=`${Math.floor(cue.start/60)}:${String(Math.floor(cue.start%60)).padStart(2,'0')}${cue.label?' · '+cue.label:''}`;
      const original=document.createElement('p');original.className='local-original';original.textContent=cue.text;
      const translated=document.createElement('p');translated.className='local-chinese';translated.textContent=cue.translation||'未匹配，保留原文';row.append(time,original,translated);el.localPreview.append(row);
    }
    el.localCoverage.textContent=cues.length?`当前结果 ${cues.length} 条字幕${summary?` · 本次翻译匹配文字约 ${Math.round(summary.coverage*100)}%`:''}。${summary?.unknown?.length?'未匹配内容保留原文：'+summary.unknown.slice(0,8).join('、'):'词库拼接不保证语序和多义词正确。'}`:'尚未生成结果。';
    for(const id of ['localApply','localExportVtt','localExportSrt','localExportJson'])el[id].disabled=!cues.length;
  }
  function apply(){
    if(!documentResult||context()?.trackKey!==documentResult.trackKey){status('结果对应的音轨已改变，请回到原音轨或重新处理。',true);return;}
    results.delete(documentResult.trackKey);
    results.set(documentResult.trackKey,{document:documentResult,summary,displayMode:el.localDisplayMode.value,source:el.localSource.value});
    while(results.size>12)results.delete(results.keys().next().value);
    onApply(documentResult,el.localDisplayMode.value);
  }
  function cancel({message=true}={}){
    const running=busy,previous=metadata;serial++;controller?.abort(canceled());controller=null;asr?.reset();dictionary.destroy();dictionary=createLocalDictionaryClient();metadata=null;
    if(previous)el.localDictionaryStatus.textContent=previous.persisted?`${previous.entries.toLocaleString('en-US')} 条词条 · 已缓存到本机`:'词库未缓存 · 请重新准备';
    if(asr)el.localAsrStatus.textContent='听写已停止 · 下次优先读取本机缓存';
    document.querySelector('#localResourcesSummary').textContent='语言库按需加载';
    clearingCache=false;importingPhrases=false;setBusy(false);
    if(running){el.localDialog.dataset.state='canceled';status(message?'任务已取消，播放器保留原有字幕。':'页面任务已取消，返回后可重新操作。');}
  }
  async function run(event){
    event?.preventDefault();if(busy)return;const current=context();if(!current?.sources?.length){status('请先打开一个可播放的音轨。',true);return;}
    const selected=current.sources.filter(source=>el.localSource.value==='all'||source.id===el.localSource.value);
    if(!selected.length)return;
    const audio=el.localTaskMode.value==='audio';
    if(!audio&&selected.some(source=>!source.cues.length)){status('所选音源没有字幕，请选择“识别音频并词库翻译”。',true);return;}
    if(audio&&selected.some(source=>!['mp3','wav'].includes(source.audioFormat||/\.([a-z0-9]+)$/i.exec(source.name||'')?.[1]?.toLowerCase()||'wav'))){status('本地听写目前支持 MP3／WAV，请切换格式或使用已有字幕。',true);return;}
    const run=++serial;controller=new AbortController();const signal=controller.signal;taskTrack=current.trackKey;setBusy(true);el.localDialog.dataset.state='running';el.localProgress.value=0;
    try{
      const ready=await prepare(signal,run,audio),sources=[];let coverage=0,phraseHits=0,glossHits=0;const unknown=new Set();
      for(const source of selected){
        const cues=audio?await asr.transcribe(source,{signal,onProgress:value=>progress(value,run)}):source.cues;
        if(run!==serial||signal.aborted)throw canceled();
        if(!cues.length)throw new Error('没有识别到可用日语句子。可尝试较清晰的录音，或使用已有字幕。');
        const translated=await dictionary.translate(cues,{signal,onProgress:value=>progress(value,run)});
        coverage+=translated.coverage;phraseHits+=translated.phraseHits||0;glossHits+=translated.glossHits||0;for(const word of translated.unknown)unknown.add(word);
        sources.push({id:source.id,side:source.side,label:source.label,cues:translated.cues});
      }
      if(run!==serial||signal.aborted||context()?.trackKey!==current.trackKey)throw canceled();
      const previous=results.get(current.trackKey)?.document||makeTranscriptDocument(current);
      documentResult=mergeTranscriptDocuments(previous,{trackKey:current.trackKey,sources});summary={coverage:coverage/selected.length,unknown:[...unknown]};renderResult();apply();
      el.localDialog.dataset.state='done';el.localProgress.value=1;status(`本地翻译已完成并应用到播放器。${phraseHits||glossHits?`本机学习包命中 ${phraseHits} 条短语、${glossHits} 处词义偏好。`:''}${ready.warning||'译文来自词库和规则，未调用 AI 翻译接口。'}`);
    }catch(error){if(run===serial){el.localDialog.dataset.state=signal.aborted?'canceled':'error';status(signal.aborted?'任务已取消，播放器保留原有字幕。':error.message||'本地翻译失败',!signal.aborted);}}
    finally{if(run===serial){controller=null;setBusy(false);}}
  }
  async function prepareOnly(){
    if(busy)return;
    const run=++serial;taskTrack=null;controller=new AbortController();const signal=controller.signal;setBusy(true);el.localDialog.dataset.state='preparing';
    try{await prepare(signal,run,true);if(run===serial){status('本地词库与日语听写已准备，可以开始翻译。');el.localDialog.dataset.state='ready';el.localProgress.value=1;}}
    catch(error){if(run===serial){status(error.message||'语言库准备失败',!signal.aborted);el.localDialog.dataset.state=signal.aborted?'canceled':'error';}}
    finally{if(run===serial){controller=null;setBusy(false);}}
  }
  async function clearCache(){
    if(busy)return;
    cancel({message:false});const run=serial;taskTrack=null;clearingCache=true;setBusy(true);status('正在清除本地语言缓存…');
    try{
      await dictionary.clear();
      if(run!==serial)return;
      el.localDictionaryStatus.textContent='词库缓存已清除';
      el.localPhraseStatus.textContent='本机学习包已清除，需要时可重新导入。';
      installedPackage=null;renderPackCatalog();
      await new Promise((resolve,reject)=>{
        const request=indexedDB.deleteDatabase('/vosk'),timer=setTimeout(()=>reject(new Error('识别缓存仍被其他页面使用，请关闭其他播放器页面后重试')),8000);
        request.onsuccess=()=>{clearTimeout(timer);resolve();};request.onerror=()=>{clearTimeout(timer);reject(request.error);};
      });
      if(run!==serial)return;
      el.localAsrStatus.textContent='听写缓存已清除';status('语言缓存已清除，需要时可重新准备。');el.localDialog.dataset.state='idle';
    }catch(error){if(run===serial)status(error.message||'缓存清除失败',true);}finally{if(run===serial){clearingCache=false;setBusy(false);}}
  }
  function trackChanged(){
    const current=context();if(busy&&taskTrack!==null&&current?.trackKey!==taskTrack)cancel();
    const changed=viewTrack!==(current?.trackKey||null);viewTrack=current?.trackKey||null;
    const saved=results.get(viewTrack);
    if(documentResult?.trackKey!==viewTrack){documentResult=saved?.document||null;summary=saved?.summary||null;renderResult();}
    if(changed&&!busy){
      el.localDialog.dataset.state=documentResult?'done':'idle';el.localProgress.value=documentResult?1:0;
      status(documentResult?'已恢复本页面中的本地翻译结果，可继续应用或导出。':'准备就绪，选择处理方式后开始。');
      if(saved)el.localDisplayMode.value=saved.displayMode;
    }
    el.localTrackName.textContent=current?.title||'先打开一个音轨';
    const selected=changed?saved?.source:el.localSource.value;
    el.localSource.replaceChildren();
    for(const source of [{id:'all',label:'全部音源'},...(current?.sources||[]).map((source,index)=>({id:source.id,label:source.label||`音源 ${index+1}`}))]){
      const option=document.createElement('option');option.value=source.id;option.textContent=source.label;el.localSource.append(option);
    }
    if([...el.localSource.options].some(option=>option.value===selected))el.localSource.value=selected;
    setBusy(busy);
  }
  function open(){trackChanged();if(!el.localDialog.open){el.localDialog.showModal();onOpenChange(true);}void refreshPackInfo();}
  async function onlinePack(install){
    if(busy)return;const run=++serial;taskTrack=null;importingPhrases=true;setBusy(true);controller=new AbortController();const signal=controller.signal,selected=el.localPackVersion.value;
    status(install?'正在检查并下载词组包…':'正在检查词组包更新…');
    try{
      packCatalog=await fetchPackCatalog({signal});if(run!==serial)return;renderPackCatalog();
      if(install){
        const release=selected==='latest'?packCatalog.releases[0]:packCatalog.releases.find(r=>r.version===selected);if(!release)throw new Error('所选版本已不在目录，请重新检查更新');
        const pack=await loadTranslationPack(release,{appVersion,signal,onProgress:({done,total})=>{if(run!==serial){return;}el.localProgress.value=done/total;status(`正在下载词组包 v${release.version} · ${Math.round(done/1024)} / ${Math.round(total/1024)} KiB…`);}});
        if(run!==serial||signal.aborted)return;const result=await dictionary.importPhrases(pack);if(run!==serial)return;renderPackInfo(result);el.localProgress.value=1;
        status(`词组包 v${release.version} 已安装。${result.persisted?'刷新后自动恢复。':'本次可用，浏览器未能保存；刷新后需重新安装。'}下次翻译使用此包，已有字幕结果不变。`);
      }else status('版本检查完成，已安装的包保持原样。');
    }catch(error){if(run===serial)status(error.message||'词组包操作失败，原包保留',true);}
    finally{if(run===serial){controller=null;importingPhrases=false;setBusy(false);}}
  }
  async function importPhrases(){
    const file=el.localPhraseFile.files?.[0];if(!file||busy)return;
    if(file.size>8*1024*1024){status('学习包超过8 MiB上限',true);el.localPhraseFile.value='';return;}
    const run=++serial;taskTrack=null;importingPhrases=true;setBusy(true);status('正在导入本机学习包…');
    try{
      const pack=JSON.parse(await file.text());if(run!==serial)return;
      const result=await dictionary.importPhrases(pack);
      if(run!==serial)return;renderPackInfo(result);
      status('学习包已导入。下次翻译将优先使用；词义偏好是语料统计参考，不保证语境准确。');
    }catch(error){if(run===serial)status(error.message||'学习包导入失败',true);}
    finally{if(run===serial){importingPhrases=false;setBusy(false);}el.localPhraseFile.value='';}
  }
  async function removePhrases(){
    if(busy)return;const run=++serial;taskTrack=null;importingPhrases=true;setBusy(true);
    try{const result=await dictionary.removePhrases();if(run!==serial)return;installedPackage=null;renderPackCatalog();el.localPhraseStatus.textContent=result.persisted?'本机学习包已移除，基础词库缓存保留。':'当前页面已移除学习包，缓存未能更新。';status('下一次翻译将使用基础词库和规则。');}
    catch(error){if(run===serial)status(error.message||'移除学习包失败',true);}
    finally{if(run===serial){importingPhrases=false;setBusy(false);}}
  }
  function close(){el.localDialog.close();}
  function download(format){
    if(!documentResult)return;
    const documents=format==='json'?[{content:JSON.stringify({...documentResult,translationMethod:'dictionary-v1'},null,2),name:'all',mime:'application/json'}]:documentResult.sources.map((source,index)=>({content:exportTimedText(displaySourceCues(source,el.localDisplayMode.value),format),name:`source-${index+1}`,mime:'text/plain'}));
    for(const item of documents){const url=URL.createObjectURL(new Blob([item.content],{type:item.mime+';charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`asmr-local-ja-${item.name}.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  }
  entry.addEventListener('click',open);el.localClose.addEventListener('click',close);el.localForm.addEventListener('submit',run);el.localCancel.addEventListener('click',()=>cancel());el.localPrepare.addEventListener('click',prepareOnly);el.localClearCache.addEventListener('click',clearCache);
  el.localPhraseImport.addEventListener('click',()=>el.localPhraseFile.click());el.localPhraseFile.addEventListener('change',importPhrases);
  el.localPhraseRemove.addEventListener('click',removePhrases);
  el.localPackCheck.addEventListener('click',()=>onlinePack(false));el.localPackInstall.addEventListener('click',()=>onlinePack(true));
  el.localApply.addEventListener('click',apply);el.localRestore.addEventListener('click',()=>{if(busy)cancel();onRestore();});el.localDisplayMode.addEventListener('change',()=>{if(documentResult)apply();});
  for(const [id,format]of [['localExportVtt','vtt'],['localExportSrt','srt'],['localExportJson','json']])el[id].addEventListener('click',()=>download(format));
  el.localDialog.addEventListener('close',()=>{if(el.localDialog.open)return;onOpenChange(false);const active=document.activeElement;if(active&&active!==document.body&&!el.localDialog.contains(active))return;(entry.getClientRects().length?entry:document.querySelector('#actionsButton'))?.focus({preventScroll:true});});
  trackChanged();
  return{trackChanged,isOpen:()=>el.localDialog.open,cancel,resume(){trackChanged();void refreshPackInfo();if(el.localDialog.dataset.state==='canceled')status('页面已恢复，未完成的任务已取消，可重新操作。');},destroy(){cancel({message:false});dictionary.destroy();asr?.destroy();entry.removeEventListener('click',open);}};
}
