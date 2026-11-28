export const DEFAULT_FOLIA_PALETTE=Object.freeze({
  background:'16, 11, 20',deep:'28, 18, 34',accent:'220, 120, 154',light:'252, 234, 241',
  grid:'198, 116, 150',dust:'248, 212, 226',echo:'224, 156, 182',star:'255, 240, 246',
});
const mix=(color,target,amount)=>color.map((value,index)=>Math.round(value+(target[index]-value)*amount));
const white=[255,255,255],black=[0,0,0];
const rgb=color=>color.join(', ');
const parseRgb=value=>String(value).split(',').map(part=>Math.min(255,Math.max(0,Math.round(Number(part)||0))));
const relativeLuminance=([r,g,b])=>{
  const lin=channel=>{const c=channel/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;};
  return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
};
const paletteFrom=color=>Object.freeze({
  background:rgb(mix(color,black,.94)),deep:rgb(mix(color,black,.88)),
  accent:rgb(mix(color,white,.16)),light:rgb(mix(color,white,.86)),
  grid:rgb(mix(color,white,.22)),dust:rgb(mix(color,white,.74)),
  echo:rgb(mix(color,white,.52)),star:rgb(mix(color,white,.92)),
});
const NEUTRAL=paletteFrom([145,145,145]);

/** Derive contrast-safe adaptive UI tokens from any Folia/background palette. */
export function deriveUiTheme(input){
  const palette=normalizeFoliaPalette(input);
  const bg=parseRgb(palette.background),deep=parseRgb(palette.deep),accent=parseRgb(palette.accent);
  const surface=mix(deep,black,.12);
  const surfaceHi=mix(deep,accent,.12);
  // Keep primary button fill rich & readable under light ivory text regardless of artwork hue.
  let fill=mix(accent,black,.18);
  const lum=relativeLuminance(fill);
  if(lum>0.145){
    const scale=Math.sqrt(0.145/lum);
    fill=fill.map(channel=>Math.round(channel*scale));
  }
  const fillDeep=mix(fill,black,.24);
  return Object.freeze({
    background:rgb(bg),deep:rgb(deep),surface:rgb(surface),surfaceHi:rgb(surfaceHi),
    accent:palette.accent,light:palette.light,echo:palette.echo,
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
    const weight=.65+.35*(high-low)/Math.max(1,high);
    bucket.weight+=weight;color.forEach((value,i)=>{bucket.sum[i]+=value*weight;});buckets.set(key,bucket);
  }
  const winner=[...buckets.values()].sort((a,b)=>b.weight-a.weight)[0];
  return winner?paletteFrom(winner.sum.map(value=>Math.round(value/winner.weight))):NEUTRAL;
}

export function normalizeFoliaPalette(value){
  if(!value||!Object.keys(DEFAULT_FOLIA_PALETTE).every(key=>{
    const text=value[key];return typeof text==='string'&&/^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(text)&&text.split(',').every(c=>Number(c)<=255);
  }))return DEFAULT_FOLIA_PALETTE;
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_FOLIA_PALETTE).map(key=>[key,value[key]])));
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
