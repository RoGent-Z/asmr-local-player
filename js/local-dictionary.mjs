// Dictionary lookup and explicit rules only; no translation inference/model.
const JAPANESE=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const letters=text=>Array.from(text.matchAll(/[\p{L}\p{N}]/gu)).length;
const kana=text=>text.replace(/[\u30a1-\u30f6]/g,char=>String.fromCharCode(char.charCodeAt(0)-0x60));
const normalize=text=>kana(text.normalize('NFKC'));
const RULES=new Map(Object.entries({
  'ありがとうございます':'谢谢','ありがとうございました':'谢谢','ありがとう':'谢谢','どうもありがとう':'非常感谢',
  'おはようございます':'早上好','おはよう':'早上好','こんにちは':'你好','こんばんは':'晚上好','おやすみなさい':'晚安','おやすみ':'晚安',
  'お疲れ様です':'辛苦了','お疲れさま':'辛苦了','すみません':'不好意思','ごめんなさい':'对不起','大丈夫':'没关系',
  '気持ちいい':'舒服','気持ち良い':'舒服','気をつけて':'小心','ゆっくり':'慢慢地','今日は':'今天',
  'どうぞ':'请','はい':'是的','いいえ':'不是','もしもし':'喂','ねえ':'喂','ください':'请',
  'ですね':'呢','ですよ':'哦','です':'','でした':'曾是','だよ':'哦','だね':'呢',
  'は':'','が':'','を':'','の':'的','に':'在','へ':'向','と':'和','で':'在','も':'也','から':'从','まで':'到','ね':'呢','よ':'哦',
}));
const I_TO_U={'い':'う','き':'く','ぎ':'ぐ','し':'す','ち':'つ','に':'ぬ','び':'ぶ','み':'む','り':'る'};
const A_TO_U={'わ':'う','か':'く','が':'ぐ','さ':'す','た':'つ','な':'ぬ','ば':'ぶ','ま':'む','ら':'る'};

function bases(text){
  const out=[];
  const polite=/(.*?)(ませんでした|ません|ました|ます|ましょう)$/.exec(text);
  if(polite&&polite[1]){
    const stem=polite[1],negative=polite[2].startsWith('ません');
    out.push({word:stem+'る',negative});
    const last=stem.at(-1);if(I_TO_U[last])out.push({word:stem.slice(0,-1)+I_TO_U[last],negative});
    if(stem.endsWith('し'))out.push({word:stem.slice(0,-1)+'する',negative});
  }
  const negative=/(.+?)(なかった|ない)$/.exec(text);
  if(negative){
    const stem=negative[1];out.push({word:stem+'る',negative:true});
    const last=stem.at(-1);if(A_TO_U[last])out.push({word:stem.slice(0,-1)+A_TO_U[last],negative:true});
    if(stem.endsWith('く'))out.push({word:stem.slice(0,-1)+'い',negative:true});
  }
  for(const [ending,replacements]of [['いた',['く']],['いだ',['ぐ']],['した',['す']],['んだ',['む','ぶ','ぬ']],['った',['う','つ','る']],['いて',['く']],['いで',['ぐ']],['して',['す']],['んで',['む','ぶ','ぬ']],['って',['う','つ','る']],['た',['る']],['て',['る']]]){
    if(text.endsWith(ending)&&text.length>ending.length)for(const replacement of replacements)out.push({word:text.slice(0,-ending.length)+replacement,negative:false});
  }
  return out.slice(0,12);
}

export function createLocalDictionary(records){
  if(!Array.isArray(records)||records.length>400000)throw new Error('词库数据格式无效');
  const index=new Map();let entries=0,maxLength=1;
  for(const row of records){
    if(!Array.isArray(row)||!Array.isArray(row[1])||!Array.isArray(row[2])||typeof row[3]!=='string'||!row[3])continue;
    const entry={id:String(row[0]),translation:row[3].split(/[；;]/u)[0].slice(0,160),rank:Number.isFinite(row[4])?row[4]:999999,pos:typeof row[5]==='string'?row[5]:''};entries++;
    for(const form of [...row[1],...row[2]]){
      if(typeof form!=='string'||!form||form.length>128)continue;
      const word=normalize(form);maxLength=Math.max(maxLength,Math.min(40,word.length));
      const previous=index.get(word);if(!previous||entry.rank<previous.rank)index.set(word,entry);
    }
  }
  for(const phrase of RULES.keys())maxLength=Math.max(maxLength,phrase.length);

  function translate(input){
    if(typeof input!=='string'||input.length>24000)throw new Error('待翻译文字过长或格式无效');
    if(!JAPANESE.test(input))return{text:input,tokens:[],coverage:letters(input)?0:1,unknown:letters(input)?[input]:[],dictionaryHits:0,ruleHits:0};
    const source=input.normalize('NFKC').replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,'$1');
    const normalized=normalize(source),tokens=[];let offset=0,dictionaryHits=0,ruleHits=0;
    while(offset<source.length){
      let match;
      for(let length=Math.min(maxLength,source.length-offset);length>0&&!match;length--){
        const word=normalized.slice(offset,offset+length);
        if(RULES.has(word)){match={length,translation:RULES.get(word),type:'rule'};break;}
        const entry=index.get(word);
        if(entry){match={length,translation:entry.translation,type:'dictionary',entryId:entry.id};break;}
        if(length>=3)for(const base of bases(word)){
          const candidate=index.get(base.word);
          if(candidate){match={length,translation:(base.negative?'不':'')+candidate.translation,type:'dictionary',entryId:candidate.id};break;}
        }
      }
      if(match){
        tokens.push({source:source.slice(offset,offset+match.length),translation:match.translation,type:match.type,...(match.entryId?{entryId:match.entryId}:{})});
        if(match.type==='dictionary')dictionaryHits++;else ruleHits++;offset+=match.length;
      }else{
        const char=String.fromCodePoint(source.codePointAt(offset)),previous=tokens.at(-1);
        const type=letters(char)?'unknown':'punctuation';
        if(previous?.type===type&&type==='unknown'){previous.source+=char;previous.translation+=char;}else tokens.push({source:char,translation:char,type});
        offset+=char.length;
      }
    }
    const total=tokens.reduce((sum,token)=>sum+letters(token.source),0),unknown=[...new Set(tokens.filter(t=>t.type==='unknown').map(t=>t.source))];
    let text='';
    for(const token of tokens){
      if(!token.translation)continue;
      const gap=text&&letters(token.translation)&&letters(text.at(-1))?' ':'';
      text+=gap+token.translation;
    }
    return{text:text.trim(),tokens,coverage:total?Math.max(0,1-tokens.filter(t=>t.type==='unknown').reduce((sum,t)=>sum+letters(t.source),0)/total):1,unknown,dictionaryHits,ruleHits};
  }
  return{translate,entries,forms:index.size};
}
