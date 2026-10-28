// Structural checks only: licensed candidate membership is verified during export.
const PROBABILITY_TOLERANCE=1e-5;
const invalid=()=>{throw new Error('本机学习包格式无效，请使用本地语料工具生成的 JSON');};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const probability=value=>Number.isFinite(value)&&value>0&&value<=1;
const normalized=sum=>Math.abs(sum-1)<=PROBABILITY_TOLERANCE;
const text=value=>typeof value==='string'&&value.length<=160&&value.trim().length>0;
const collection=(value,min,max)=>Array.isArray(value)&&value.length>=min&&value.length<=max;

export function validateLocalMatrix(value,{dictionaryVersion,normalizeSource}){
  if(!record(value)||value.revision!==1||!['experimental','stable'].includes(value.status)
    ||!collection(value.translation,1,10000)||!collection(value.unigrams,1,50000)
    ||!collection(value.transitions,0,100000))invalid();

  const provenance=value.provenance;
  if(!record(provenance)||provenance.dictionaryVersion!==dictionaryVersion
    ||!integer(provenance.trainingGroups,1,1000000)||!integer(provenance.trainingPairs,0,100000000)
    ||provenance.algorithm!=='group-normalized-lexical-v2')invalid();
  const support=count=>integer(count,0,provenance.trainingGroups);

  const parameters=value.parameters;
  if(!record(parameters)||parameters.beamWidth!==16||!integer(parameters.maxOperations,1000,200000)
    ||!integer(parameters.maxSegmentLength,16,512)||!integer(parameters.minSupport,2,1000000)
    ||!bounded(parameters.minMargin,0,100)||!bounded(parameters.transitionMix,0,1)
    ||!record(parameters.weights))invalid();
  const weights={};
  for(const key of ['translation','transition','evidence','prior','unknown']){
    if(!bounded(parameters.weights[key],0,100))invalid();
    weights[key]=parameters.weights[key];
  }
  if(!Object.values(weights).some(weight=>weight>0))invalid();

  const targets=new Set(),unigrams=[];
  let unigramSum=0;
  for(const item of value.unigrams){
    if(!record(item)||!text(item.target)||!probability(item.probability)||!support(item.support))invalid();
    const target=item.target.trim();
    if(targets.has(target))invalid();
    targets.add(target);unigramSum+=item.probability;
    unigrams.push({target,probability:item.probability,support:item.support});
  }
  if(!normalized(unigramSum))invalid();

  const sources=new Set(),translation=[];
  let totalCandidates=0;
  for(const row of value.translation){
    if(!record(row)||typeof row.source!=='string'||row.source.length>128||!collection(row.candidates,1,32))invalid();
    const source=normalizeSource(row.source);
    if(!source.length||source.length>128||sources.has(source))invalid();
    sources.add(source);
    totalCandidates+=row.candidates.length;
    if(totalCandidates>80000)invalid();
    const seen=new Set(),candidates=[];
    let sum=0,mass=0;
    for(const item of row.candidates){
      if(!record(item)||typeof item.entryId!=='string'||!/^\d{1,12}$/.test(item.entryId)
        ||!text(item.target)||!probability(item.probability)||!support(item.support)
        ||!bounded(item.mass,0,item.support))invalid();
      const target=item.target.trim(),key=JSON.stringify([item.entryId,target]);
      if(!targets.has(target)||seen.has(key))invalid();
      seen.add(key);sum+=item.probability;mass+=item.mass;
      candidates.push({entryId:item.entryId,target,probability:item.probability,support:item.support,mass:item.mass});
    }
    if(!normalized(sum)||mass>provenance.trainingGroups+PROBABILITY_TOLERANCE)invalid();
    translation.push({source,candidates});
  }

  const transitions=[],transitionRows=new Map();
  for(const item of value.transitions){
    if(!record(item)||!text(item.from)||!text(item.to)||!probability(item.probability)||!support(item.support))invalid();
    const from=item.from.trim(),to=item.to.trim();
    if(!targets.has(from)||!targets.has(to))invalid();
    let row=transitionRows.get(from);
    if(!row){row={targets:new Set(),sum:0};transitionRows.set(from,row);}
    if(row.targets.has(to))invalid();
    row.targets.add(to);row.sum+=item.probability;
    transitions.push({from,to,probability:item.probability,support:item.support});
  }
  for(const row of transitionRows.values())if(!normalized(row.sum))invalid();

  return {
    revision:1,status:value.status,translation,unigrams,transitions,
    parameters:{beamWidth:16,maxOperations:parameters.maxOperations,maxSegmentLength:parameters.maxSegmentLength,
      minSupport:parameters.minSupport,minMargin:parameters.minMargin,transitionMix:parameters.transitionMix,weights},
    provenance:{dictionaryVersion:provenance.dictionaryVersion,trainingGroups:provenance.trainingGroups,
      trainingPairs:provenance.trainingPairs,algorithm:provenance.algorithm}
  };
}
