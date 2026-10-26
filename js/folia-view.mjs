import {buildFoliaTimeline, foliaFrameAt} from './folia-timeline.mjs';
import {createFoliaScene} from './folia-scene.mjs';
import {segmentFoliaText,foliaGlyphFrame} from './folia-glyphs.mjs';
import {createFoliaBackdrop,DEFAULT_FOLIA_PALETTE} from './folia-theme.mjs';

const PREFERENCE_KEY='asmr-player:folia:v1';

/** A presentation of existing cues, driven exclusively by the player's clock. */
export function createFoliaView({app,button,stage,onSeek,onInteraction=()=>{},storage}) {
  const doc=stage.ownerDocument;
  const normal=doc.querySelector('.subtitle-stage');
  const before=stage.querySelector('#foliaBefore'),current=stage.querySelector('#foliaCurrent');
  const after=stage.querySelector('#foliaAfter'),gap=stage.querySelector('#foliaGap');
  const exit=stage.querySelector('#foliaExit');
  const settings=stage.querySelector('#foliaSettings');
  const rateControl=doc.querySelector('#rate');
  const canvas=doc.querySelector('#foliaSceneCanvas');
  const scene=createFoliaScene({canvas,getPixelRatio:()=>window.devicePixelRatio||1});
  scene.resize(app.clientWidth,app.clientHeight);
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let preferred=false,ready=false,active=false,time=0,signature='',playing=false;
  let timeline=buildFoliaTimeline([]),activeNodes=[],measurement=0;
  let palette=DEFAULT_FOLIA_PALETTE,hasBackground=false;
  const backdrop=createFoliaBackdrop({onChange:state=>{
    palette=state.palette;hasBackground=state.hasBackground;
    app.classList.toggle('folia-image',hasBackground);app.dataset.foliaTheme=state.status;
    for(const key of ['accent','light','echo','star','deep'])app.style.setProperty(`--folia-${key==='accent'?'tint':key}`,palette[key]);
    palette.echo.split(',').map(Number).forEach((value,index)=>app.style.setProperty(`--folia-glyph-${['r','g','b'][index]}`,String(Math.round(value*.65+255*.25))));
    if(active)update(time,{force:true});
  }});
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
      scene.resize(app.clientWidth,app.clientHeight);
      if(active)update(time);
    });
  }
  function syncVisibility() {
    const previous=active;active=preferred&&ready&&timeline.items.length>0;
    const hadFocus=stage.contains(doc.activeElement);
    button.setAttribute('aria-pressed',String(preferred));
    button.title=preferred?(active?'关闭 Folia 沉浸字幕':'Folia 已开启，等待可用字幕'):'开启 Folia 沉浸字幕';
    stage.hidden=!active;stage.inert=!active;
    canvas.hidden=!active;
    app.classList.toggle('folia-active',active);
    if(!active){app.classList.remove('folia-settings-open');settings.setAttribute('aria-expanded','false');}
    normal.setAttribute('aria-hidden',String(active));
    if(active){measure();if(!previous){signature='';update(time);}}
    else if(previous){scene.clear();if(hadFocus)restoreFocus();}
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
    const text=doc.createElement('span');text.className='folia-line-text';
    const segmented=state==='active'?segmentFoliaText(item.text):{parts:[item.text],decorated:false};
    if(segmented.decorated){
      for(const part of segmented.parts){const glyph=doc.createElement('span');glyph.className='folia-glyph';glyph.textContent=part;if(!part.trim())glyph.dataset.blank='true';text.append(glyph);}
    }else text.textContent=item.text;
    line.dataset.glyphs=String(segmented.decorated);
    const progress=doc.createElement('span');progress.className='folia-line-progress';progress.setAttribute('aria-hidden','true');
    line.append(voice,text,progress);
    line.addEventListener('click',()=>{onSeek(item.start);update(item.start,{force:true});onInteraction();});
    return line;
  }
  function update(nextTime,{force=false}={}) {
    time=Number.isFinite(nextTime)?Math.max(0,nextTime):0;
    if(!active)return;
    const reducedMotion=motion.matches;
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
    frame.active.forEach((item,index)=>{
      const line=activeNodes[index];if(!line)return;
      const glyphs=line.querySelectorAll('.folia-glyph');
      const light=foliaGlyphFrame(item,time,glyphs.length,{reducedMotion});
      line.style.setProperty('--line-progress',`${light.progress*100}%`);
      line.style.setProperty('--sweep',String(light.sweep));
      line.style.setProperty('--entry-y',`${(1-light.entrance)*9}px`);
      for(let i=0;i<glyphs.length;i++)glyphs[i].style.setProperty('--glyph-light',String(light.weights[i]));
    });
    const model=scene.render({time,...frame,playing,reducedMotion,playbackRate:Number(rateControl?.value)||1,force,palette,hasBackground});
    stage.dataset.renderer=scene.available?'canvas':'css';
    stage.dataset.motion=reducedMotion?'reduced':'full';
    if(model){
      stage.style.setProperty('--camera-x',`${model.camera.x}px`);
      stage.style.setProperty('--camera-y',`${model.camera.y}px`);
      stage.style.setProperty('--camera-rotate',`${model.camera.rotate}deg`);
      stage.style.setProperty('--camera-scale',String(model.camera.scale));
    }
  }
  const toggle=()=>{
    changePreference(!preferred);
    if(active)exit.focus({preventScroll:true});else restoreFocus();
  };
  const close=()=>changePreference(false,{restore:true});
  button.addEventListener('click',toggle);exit.addEventListener('click',close);
  const toggleSettings=()=>{const expanded=app.classList.toggle('folia-settings-open');settings.setAttribute('aria-expanded',String(expanded));measure();onInteraction();};
  settings.addEventListener('click',toggleSettings);
  const observer=new ResizeObserver(()=>{if(active)measure();});
  observer.observe(doc.querySelector('.topbar'));observer.observe(doc.querySelector('#controls'));observer.observe(app);
  window.addEventListener('resize',measure);
  const motionChanged=()=>{if(active)update(time);};
  motion.addEventListener('change',motionChanged);
  syncVisibility();
  backdrop.setSource(doc.querySelector('#workBackground')?.getAttribute('src'));
  return {
    setBackground:backdrop.setSource,
    setCues(cues){
      timeline=buildFoliaTimeline(cues);signature='';syncVisibility();
      if(!timeline.items.length){before.replaceChildren();current.replaceChildren();after.replaceChildren();activeNodes=[];gap.hidden=true;}
      update(time);
    },
    setReady(value){ready=Boolean(value);syncVisibility();},
    setPlaying(value){playing=Boolean(value);stage.dataset.playing=String(playing);if(active)update(time);},
    update,isActive:()=>active,
    disable({restoreFocus:restore=false}={}){changePreference(false,{restore});},
    destroy(){backdrop.destroy();observer.disconnect();cancelAnimationFrame(measurement);window.removeEventListener('resize',measure);motion.removeEventListener('change',motionChanged);scene.destroy();button.removeEventListener('click',toggle);exit.removeEventListener('click',close);settings.removeEventListener('click',toggleSettings);},
  };
}
