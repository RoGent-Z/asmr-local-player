export const DEFAULT_FOLIA_PALETTE=Object.freeze({
  background:'11, 5, 16',deep:'34, 11, 28',accent:'246, 68, 124',glow:'255, 86, 146',
  light:'255, 232, 242',grid:'222, 74, 128',dust:'255, 206, 226',echo:'236, 124, 168',
  star:'255, 242, 248',
});
const CORE_PALETTE_KEYS=['background','deep','accent','light','grid','dust','echo','star'];
const clampByte=value=>Math.min(255,Math.max(0,Math.round(Number(value)||0)));
const mix=(color,target,amount)=>color.map((value,index)=>clampByte(value+(target[index]-value)*amount));
const white=[255,255,255],black=[0,0,0];
const rgb=color=>color.join(', ');
const parseRgb=value=>String(value).split(',').map(clampByte);
const isValidRgb=text=>typeof text==='string'&&/^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(text)&&text.split(',').every(c=>Number(c)<=255);
const relativeLuminance=([r,g,b])=>{
  const lin=channel=>{const c=channel/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;};
  return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
};
const enrichChroma=color=>{
  const high=Math.max(...color),low=Math.min(...color);
  if(high===low)return color.slice();
  const mid=(high+low)/2;
  const boosted=color.map(channel=>clampByte(mid+(channel-mid)*1.22));
  const peak=Math.max(...boosted);
  if(peak>0&&peak<210){
    const lift=Math.min(1.22,210/peak);
    return boosted.map(channel=>clampByte(channel*lift));
  }
  return boosted;
};
const deriveGlow=color=>{
  const high=Math.max(...color),low=Math.min(...color);
  if(high===low)return mix(color,white,.24);
  const scale=255/Math.max(1,high);
  const lifted=color.map(channel=>clampByte(channel*scale));
  return mix(lifted,white,.11);
};
const clampFillLuminance=(color,maxLum=0.145)=>{
  if(relativeLuminance(color)<=maxLum)return color;
  let lo=0,hi=1;
  for(let step=0;step<14;step+=1){
    const mid=(lo+hi)/2;
    const candidate=color.map(channel=>Math.floor(channel*mid));
    if(relativeLuminance(candidate)<=maxLum)lo=mid;
    else hi=mid;
  }
  return color.map(channel=>Math.floor(channel*lo));
};
const paletteFrom=color=>{
  const vivid=enrichChroma(color);
  const accent=mix(vivid,white,.14);
  return Object.freeze({
    background:rgb(mix(vivid,black,.93)),deep:rgb(mix(vivid,black,.84)),
    accent:rgb(accent),glow:rgb(deriveGlow(accent)),
    light:rgb(mix(vivid,white,.88)),grid:rgb(mix(vivid,white,.18)),
    dust:rgb(mix(vivid,white,.72)),echo:rgb(mix(vivid,white,.44)),
    star:rgb(mix(vivid,white,.93)),
  });
};
const NEUTRAL=paletteFrom([145,145,145]);

/** Derive contrast-safe adaptive UI tokens from any Folia/background palette. */
export function deriveUiTheme(input){
  const palette=normalizeFoliaPalette(input);
  const bg=parseRgb(palette.background),deep=parseRgb(palette.deep),accent=parseRgb(palette.accent);
  const surface=mix(deep,black,.24);
  const surfaceHi=mix(deep,accent,.16);
  // Keep primary button fill rich & readable under light ivory text regardless of artwork hue.
  const fill=clampFillLuminance(mix(accent,black,.16),0.145);
  const fillDeep=mix(fill,black,.28);
  return Object.freeze({
    background:rgb(bg),deep:rgb(deep),surface:rgb(surface),surfaceHi:rgb(surfaceHi),
    accent:palette.accent,glow:palette.glow,light:palette.light,echo:palette.echo,
    fill:rgb(fill),fillDeep:rgb(fillDeep),
  });
}

/** Dominant visible chromatic bucket; grayscale art retains neutral light. */
export function deriveFoliaTheme(imageData){
  const data=imageData?.data;
  if(!data||!Number.isFinite(data.length)||data.length<4)return NEUTRAL;
  const stride=Math.max(1,Math.ceil(data.length/4/4096))*4,buckets=new Map();
  for(let index=0;index+3<data.length;index+=stride){
    const color=[data[index],data[index+1],data[index+2]];
    if(data[index+3]<160||!color.every(value=>Number.isFinite(value)&&value>=0&&value<=255))continue;
    const high=Math.max(...color),low=Math.min(...color);
    if(high<24||low>236||high-low<24)continue;
    const key=color.map(value=>Math.round(value/32)).join(',');
    const bucket=buckets.get(key)||{weight:0,sum:[0,0,0]};
    const weight=.5+.5*(high-low)/Math.max(1,high);
    bucket.weight+=weight;color.forEach((value,i)=>{bucket.sum[i]+=value*weight;});buckets.set(key,bucket);
  }
  const winner=[...buckets.values()].sort((a,b)=>b.weight-a.weight)[0];
  return winner?paletteFrom(winner.sum.map(value=>Math.round(value/winner.weight))):NEUTRAL;
}

export function normalizeFoliaPalette(value){
  if(!value||!CORE_PALETTE_KEYS.every(key=>isValidRgb(value[key])))return DEFAULT_FOLIA_PALETTE;
  const glow=isValidRgb(value.glow)?value.glow:rgb(deriveGlow(parseRgb(value.accent)));
  return Object.freeze({
    ...Object.fromEntries(CORE_PALETTE_KEYS.map(key=>[key,value[key]])),
    glow,
  });
}

/** Sample once per image change. Original display image is never modified. */
export function createFoliaBackdrop({onChange=()=>{},createImage=()=>new Image(),createCanvas=()=>document.createElement('canvas')}={}){
  let generation=0,source=null,destroyed=false,pending=null;
  const publish=(palette,status)=>onChange({source,hasBackground:Boolean(source),palette,status});
  async function setSource(next){
    if(destroyed)return;
    const url=typeof next==='string'&&next?next:null;
    if(url===source)return;
    const request=++generation;source=url;
    pending?.removeAttribute?.('src');pending=null;
    if(!url){publish(DEFAULT_FOLIA_PALETTE,'default');return;}
    // Never leave the previous work's color while decoding the new image.
    publish(NEUTRAL,'loading');
    try{
      const image=createImage();pending=image;
      if(/^https?:/i.test(url))image.crossOrigin='anonymous';
      image.decoding='async';image.src=url;await image.decode();
      if(destroyed||request!==generation)return;
      const canvas=createCanvas();canvas.width=64;canvas.height=64;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(image,0,0,64,64);
      const palette=deriveFoliaTheme(context.getImageData(0,0,64,64));
      if(!destroyed&&request===generation)publish(palette,'ready');
    }catch{
      // CORS may prevent sampling; CSS can still display the original image.
      if(!destroyed&&request===generation)publish(NEUTRAL,'neutral');
    }finally{if(request===generation)pending=null;}
  }
  return{setSource,destroy(){destroyed=true;++generation;pending?.removeAttribute?.('src');pending=null;}};
}
