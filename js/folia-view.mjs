import {buildFoliaTimeline, foliaFrameAt} from './folia-timeline.mjs';

const PREFERENCE_KEY='asmr-player:folia:v1';
const clamp=value=>Math.min(1,Math.max(0,value));

/** A presentation of existing cues, driven exclusively by the player's clock. */
export function createFoliaView({app,button,stage,onSeek,onInteraction=()=>{},storage}) {
  const doc=stage.ownerDocument;
  const normal=doc.querySelector('.subtitle-stage');
  const before=stage.querySelector('#foliaBefore'),current=stage.querySelector('#foliaCurrent');
  const after=stage.querySelector('#foliaAfter'),gap=stage.querySelector('#foliaGap');
  const exit=stage.querySelector('#foliaExit');
  let preferred=false,ready=false,active=false,time=0,signature='',playing=false;
  let timeline=buildFoliaTimeline([]),activeNodes=[],measurement=0;
  try {preferred=storage?.getItem(PREFERENCE_KEY)==='true';} catch { /* Restricted storage: this visit still works. */ }

  function restoreFocus() {
    const target=button.getClientRects().length?button:doc.querySelector('#actionsButton');
    target?.focus({preventScroll:true});
  }
  function measure() {
    cancelAnimationFrame(measurement);
    measurement=requestAnimationFrame(()=>{
      const header=doc.querySelector('.topbar'),controls=doc.querySelector('#controls');
      // offset metrics ignore the auto-hide transform on the player's chrome.
      stage.style.setProperty('--folia-top',`${header.offsetTop+header.offsetHeight+8}px`);
      stage.style.setProperty('--folia-bottom',`${Math.max(0,app.clientHeight-controls.offsetTop)+8}px`);
    });
  }
  function syncVisibility() {
    const previous=active;active=preferred&&ready&&timeline.items.length>0;
    const hadFocus=stage.contains(doc.activeElement);
    button.setAttribute('aria-pressed',String(preferred));
    button.title=preferred?(active?'关闭 Folia 沉浸字幕':'Folia 已开启，等待可用字幕'):'开启 Folia 沉浸字幕';
    stage.hidden=!active;stage.inert=!active;
    app.classList.toggle('folia-active',active);
    normal.setAttribute('aria-hidden',String(active));
    if(active){measure();if(!previous){signature='';update(time);}}
    else if(previous&&hadFocus)restoreFocus();
  }
  function changePreference(value,{restore=false}={}) {
    preferred=Boolean(value);
    try {storage?.setItem(PREFERENCE_KEY,String(preferred));} catch { /* The button remains usable without persistence. */ }
    syncVisibility();onInteraction();
    if(restore)restoreFocus();
  }
  function makeLine(item,state) {
    const line=doc.createElement('button');line.type='button';line.className='folia-line';
    line.dataset.foliaId=item.id;line.dataset.side=item.side;line.dataset.phase=state;
    if(item.text.length>180)line.dataset.density='long';
    line.title=`${Math.floor(item.start/60)}:${String(Math.floor(item.start%60)).padStart(2,'0')} · 点击跳转`;
    if(state==='active')line.setAttribute('aria-current','true');
    const voice=doc.createElement('span');voice.className='folia-voice';
    voice.textContent=item.label||(item.side==='left'?'左声部':item.side==='right'?'右声部':'独白');
    const text=doc.createElement('span');text.className='folia-line-text';text.textContent=item.text;
    const progress=doc.createElement('span');progress.className='folia-line-progress';progress.setAttribute('aria-hidden','true');
    line.append(voice,text,progress);
    line.addEventListener('click',()=>{onSeek(item.start);update(item.start);onInteraction();});
    return line;
  }
  function update(nextTime) {
    time=Number.isFinite(nextTime)?Math.max(0,nextTime):0;
    if(!active)return;
    const frame=foliaFrameAt(timeline,time,{context:1});
    const nextSignature=JSON.stringify([frame.before.map(x=>x.id),frame.active.map(x=>x.id),frame.after.map(x=>x.id)]);
    if(nextSignature!==signature){
      const focusId=stage.contains(doc.activeElement)?doc.activeElement.dataset.foliaId:null;
      before.replaceChildren(...frame.before.map(x=>makeLine(x,'before')));
      current.replaceChildren(...frame.active.map(x=>makeLine(x,'active')));
      after.replaceChildren(...frame.after.map(x=>makeLine(x,'after')));
      current.scrollTop=0;
      activeNodes=[...current.children];
      gap.hidden=!frame.gap;
      gap.querySelector('span').textContent=frame.after.length?'静听片刻':'这一段字幕已结束';
      stage.dataset.duet=String(new Set(frame.active.map(x=>x.side)).size>1);
      if(focusId){
        const target=[...stage.querySelectorAll('[data-folia-id]')].find(n=>n.dataset.foliaId===focusId&&n.getClientRects().length>0);
        (target||exit).focus({preventScroll:true});
      }
      signature=nextSignature;
    }
    frame.active.forEach((item,index)=>activeNodes[index]?.style.setProperty('--line-progress',`${clamp((time-item.start)/(item.end-item.start))*100}%`));
  }
  const toggle=()=>{
    changePreference(!preferred);
    if(active)exit.focus({preventScroll:true});else restoreFocus();
  };
  const close=()=>changePreference(false,{restore:true});
  button.addEventListener('click',toggle);exit.addEventListener('click',close);
  const observer=new ResizeObserver(()=>{if(active)measure();});
  observer.observe(doc.querySelector('.topbar'));observer.observe(doc.querySelector('#controls'));observer.observe(app);
  window.addEventListener('resize',measure);
  syncVisibility();
  return {
    setCues(cues){
      timeline=buildFoliaTimeline(cues);signature='';syncVisibility();
      if(!timeline.items.length){before.replaceChildren();current.replaceChildren();after.replaceChildren();activeNodes=[];gap.hidden=true;}
      update(time);
    },
    setReady(value){ready=Boolean(value);syncVisibility();},
    setPlaying(value){playing=Boolean(value);stage.dataset.playing=String(playing);},
    update,isActive:()=>active,
    disable({restoreFocus:restore=false}={}){changePreference(false,{restore});},
    destroy(){observer.disconnect();cancelAnimationFrame(measurement);window.removeEventListener('resize',measure);button.removeEventListener('click',toggle);exit.removeEventListener('click',close);},
  };
}
