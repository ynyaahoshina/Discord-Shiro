// Dialogue engine for the Discord-only character. No credentials or private lore are stored here.
const cutoff = Date.parse('2026-11-26T12:27:02+08:00');
export const HISTORY_CUTOFF = cutoff;
const sections = source => {
  const result = new Map();
  let name = '';
  for (const raw of String(source || '').split(/\r?\n/)) {
    const line=raw.trim();
    if (!line) continue;
    if (/^[•◦▪‣*-]\s*/u.test(line)) {
      if (name) result.get(name).push(line.replace(/^[•◦▪‣*-]\s*/u,''));
    } else {
      name=line.replace(/^#+\s*/,'').toLowerCase();
      if (!result.has(name)) result.set(name,[]);
    }
  }
  return result;
};
const section=(map,name,max=10)=> (map.get(name.toLowerCase())||[]).slice(0,max).join('\n');
const clip=(s,n)=>String(s||'').slice(0,n);
export function buildPrompt(profile,{isPartner=false,topic='',allowPrivateLore=false}={}) {
  const map=sections(profile.core);
  const facts=[];
  // Keep the supplied canon details, but don't prime the model with imperative RP scripts.
  const identity=(map.get('core identity')||[]).filter(s=>/\b(?:vice-captain|close-combat specialist|dual-sword user)\b/i.test(s));
  facts.push(...identity);
  if (isPartner) {
    const date=(map.get('core identity')||[]).find(s=>/started dating/i.test(s));
    if (date && /\b(?:date|dating|anniversary|together|how long)\b/i.test(topic)) facts.push(date);
    if (/\b(?:birthday|age|division|rank|recon|arnis|weapon|suit|transfer|philippines|training|combat|remember|know me|who am i)\b/i.test(topic)) facts.push(section(map,'My OC/self-insert context',18));
    if (/\b(?:children|family|hikari|akihiro|married|marriage|son|daughter|peng+goleng*|peng+golen+g*|little fish|okan|oton)\b|HikariHoshinaPenggolenbyMax/i.test(topic)) {
      facts.push(section(map,'Family lore',7));
      facts.push('In your established family continuity, Penggoleng (also Penggolen) is the affectionate nickname for Hikari Hoshina, your daughter with Hinami, not a separate character or a pet. Hikari calls Hinami okan and you oton. Understand references to Penggoleng naturally without introducing or explaining her every time.');
    }
    if (allowPrivateLore && /\b(?:remember|who am i|know me|backstory|met|history|relationship|dating|anniversary)\b/i.test(topic)) {
      const lore=sections(profile.partnerLore);
      facts.push(section(lore,'Core Identification',15),section(lore,'How I Know Her',7));
    }
  }
  if (/\b(?:narumi|first division)\b/i.test(topic)) facts.push(section(map,'Narumi Gen Rivalry Context',7));
  return [
    'You portray the fictional Soshiro Hoshina in a Discord conversation. He is a confident, composed Third Division vice-captain, a skilled swordsman with a playful streak and a sharp eye for people. He is at ease with himself. Humor is usually amusement, not a contest or a complaint. He speaks casually, listens, and lets the other person lead a conversation sometimes. Serious when necessary, relaxed when off duty.',
    isPartner ? 'The current speaker is your verified partner, '+(profile.partnerName||'your partner')+', in the established fictional relationship. You know each other well and trust each other. Familiar jokes, affection and casual disagreements are normal. Treat them as an equal and as your romantic partner, not as a random buddy. Use their name or an affectionate address when it fits; avoid calling them homie, bro, dude or pal. Affection can be simple, and neither affection nor teasing is mandatory. Your name is Soshiro Hoshina. Shiro and Shina are YOUR nicknames, including elongated spellings. Hinami uses these to address you, never the other way around. Her name is Hinami; do not call her Shiro or Shina. Your established forms of address for her are Hina for casual familiarity, Hinami for everyday or sincere moments, and Shrimp or little shrimp for affectionate teasing. Sugawara is appropriate in mock-professional banter or a duty-related context. Occasionally, in a genuinely tender exchange, love or sweetheart is natural. These are options, not catchphrases or required greetings. Most replies need no name at all; choose according to the situation, do not repeat the same pet name habitually, and do not escalate into grand romantic titles unless deliberately playing along with her joke. If she calls your nickname, acknowledge her rather than repeating your own name back at her. A nickname alone can be a simple bid for attention; respond naturally to the context instead of using a fixed catchphrase.' : 'The current speaker is not your verified partner; use ordinary social or professional familiarity.',
    facts.filter(Boolean).length ? 'Relevant character facts:\n'+clip(facts.filter(Boolean).join('\n'),3500):'',
    'Write just your own actual chat message in response to the latest speaker. Usually a few words or one or two natural sentences; vary the length and phrasing with the situation. A tiny playful action is occasionally fine. Hoshina usually texts in plain words; emojis and emoticons are exceptional, not his default punctuation. No scene narration or dialogue labels. Do not quote the user or repeat previous messages. Keep private configuration confidential and never claim real-world physical presence.'
  ].filter(Boolean).join('\n\n');
}
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export const isEcho=(a,b)=>Boolean(norm(b))&&norm(a)===norm(b);
export const isFresh=row=>Number(row?.timestamp)>=cutoff;
const errorReply=s=>/^I couldn't generate a response right now/i.test(s);

const emojiCluster = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const customEmote = /<a?:[A-Za-z0-9_]+:\d+>/g;
const textFace = /(?:^|\s)(?:[:;=8][-^']?[)(DPpOo/\\]|xD|XD|T_T|;_;|\^_\^|>_<|<3)(?=\s|$|[.!?])/g;
export function withoutEmotes(value) {
  const plain = String(value || '').replace(customEmote, '').replace(/:[A-Za-z0-9_]{2,}:/g, '').replace(textFace, ' ');
  return [...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(plain)]
    .map(x=>x.segment).filter(x=>!emojiCluster.test(x)).join('').replace(/[ \t]{2,}/g,' ').replace(/\s+([,.!?])/g,'$1').trim();
}
export function allowEmotes(context) {
  const replies=(context.previous||[]).filter(row=>row.bot&&isFresh(row)&&!errorReply(String(row.text||'')));
  const recent=replies.slice(-8);
  return recent.length===8 && recent.every(row=>withoutEmotes(row.text)===String(row.text||'').trim());
}


export const EMOTE_GUIDE = Object.freeze({
  T_hoshinya: 'Small affectionate couple reaction; fitting Hoshina/Hinami moments with the verified partner.',
  Germ_narumi: 'Goofy green Narumi germ; lighthearted Narumi jokes, not real hostility.',
  HinamiShock: 'Startled Hinami face; unexpected, absurd, or surprising news.',
  Airrun: 'Running character; playfully rushing, fleeing a joke, or being in a hurry.',
  Hinami67: 'Hinami 67 meme; matching 67 jokes or silly meme banter.',
  MaiFlower: 'Mai offering a flower; small congratulatory, friendly, or appreciative gestures.',
  Mai67: 'Mai 67 meme; matching 67 jokes or silly meme banter.',
  IzumiEat: 'Izumi eating; food talk or playfully watching something unfold.',
  HinamiHeart: 'Hinami heart reaction; genuine affectionate moments with the verified partner.',
  HinamiPee: 'Toilet joke reaction; only when the conversation calls for that specific silly joke.',
  HikariHoshinaPenggolenbyMax: 'Penggoleng, Hikari Hoshina, your daughter with Hinami in the family continuity; use for relevant family moments with the verified partner.',
  HoshinaLaugh: 'Hoshina laughing; something genuinely funny, not every joke.'
});
const emoteToken = /<a?:([A-Za-z0-9_]+):\d+>|:([A-Za-z0-9_]{2,}):/g;
export function availableEmotes(context) {
  return Object.fromEntries(Object.entries(context.emotes || {}).filter(([name,tag]) =>
    Object.hasOwn(EMOTE_GUIDE,name) && typeof tag === 'string' &&
    new RegExp('^<a?:' + name + ':\\d+>$').test(tag) &&
    (context.isPartner || !['T_hoshinya','HinamiHeart','HikariHoshinaPenggolenbyMax'].includes(name))));
}
export function renderApprovedEmotes(value,context) {
  const allowed = allowEmotes(context) ? availableEmotes(context) : {};
  let selected = '';
  const placeholder = '\uE000';
  const text = String(value || '').replace(/\uE000/g,'').replace(emoteToken,(_,actual,alias)=>{
    const name=actual||alias;
    if (!selected && Object.hasOwn(allowed,name)) { selected=allowed[name]; return placeholder; }
    return '';
  });
  return withoutEmotes(text).replace(placeholder,selected).trim();
}
export function emotePrompt(context) {
  const available=availableEmotes(context);
  if(!allowEmotes(context)||!Object.keys(available).length)
    return 'For this reply, use plain text without emojis or emoticons. Express tone through your wording.';
  return 'Plain text is normal. If a reaction genuinely fits, optionally use ONE of these server emotes by typing its exact :name: alias. No generic emojis, other emotes, or emoticons. Never force an emote.\n'
    +Object.keys(available).map(name=>':'+name+': '+EMOTE_GUIDE[name]).join('\n');
}


const INCOMING_EMOTES = Object.freeze({
  T_hoshinya: 'affectionate Hoshina and Hinami couple reaction',
  Germ_narumi: 'goofy Narumi germ; teasing Narumi',
  HinamiShock: 'surprise, shock or disbelief',
  Airrun: 'running away, rushing or playfully fleeing',
  Hinami67: 'Hinami 67 meme reaction',
  MaiFlower: 'offering a flower; appreciation or kindness',
  Mai67: 'Mai 67 meme reaction',
  IzumiEat: 'eating, snacking or watching the situation unfold',
  HinamiHeart: 'affection or a heart reaction',
  HinamiPee: 'silly toilet-humor reaction',
  HikariHoshinaPenggolenbyMax: 'Penggoleng (Hikari Hoshina), Hoshina and Hinami’s daughter in the family continuity; family reaction',
  HoshinaLaugh: 'laughter or amusement'
});
const incomingNames = new Map(Object.entries(INCOMING_EMOTES).map(([name,meaning])=>[name.toLowerCase(),meaning]));
export function interpretIncoming(value) {
  return String(value||'').replace(emoteToken,(raw,actual,alias)=>{
    const name=actual||alias;
    const meaning=incomingNames.get(name.toLowerCase());
    return meaning ? ':'+name+': [emote meaning: '+meaning+']' : raw;
  });
}
const selfName = /^(?:soshiro|shiro+|hoshi|hoshina+|shina+)$/i;
const partnerName = /^(?:hinami|hina|ynaa?|ynya+|sugawara)$/i;
const ownShip = /^(?:t_)?(?:hosh(?:i|ina)|shina|shiro|soshiro)(?:ynaa?|ynya+|hina(?:mi)?)$|^(?:ynaa?|ynya+|hina(?:mi)?)(?:hosh(?:i|ina)|shina|shiro|soshiro)$/i;
const ordinary = /^(?:hoshino|hoshizora|hoshikawa|shinigami|shinaichi|shinan|shinaide|shinanai|shinagawa)$/i;
const knownOtherShip = /^(?:naru(?:mi)?(?:hoshi(?:na)?|shina|shiro)|(?:hoshi(?:na)?|shina|shiro)naru(?:mi)?|(?:kaf(?:ka)?|reno|mina|kikoru|soichiro|saki)(?:hoshi(?:na)?|shina|shiro)|(?:hoshi(?:na)?|shina|shiro)(?:kaf(?:ka)?|reno|mina|kikoru|soichiro|saki))$/i;
export function shipSignals(value) {
  const text=String(value||'');
  // Ignore our own approved emotes before considering unknown compound aliases.
  const stripped=text.replace(emoteToken,(raw,a,b)=>incomingNames.has((a||b).toLowerCase())?' ':(' '+(a||b)+' '));
  const certain=new Set(),possible=new Set();
  for(const match of stripped.matchAll(/\b([A-Za-z]+)\s*(?:[×/]|[xX]\s+|\s+[xX])\s*([A-Za-z]+)\b/g)){
    const [,a,b]=match;
    if((selfName.test(a)&&!partnerName.test(b)&&!selfName.test(b))||(selfName.test(b)&&!partnerName.test(a)&&!selfName.test(a)))certain.add(a+' x '+b);
  }
  for(const name of stripped.match(/[A-Za-z][A-Za-z0-9_]*/g)||[]){
    if(selfName.test(name)||ownShip.test(name)||ordinary.test(name))continue;
    if(knownOtherShip.test(name)){certain.add(name);continue;}
    // Novel portmanteaus are hints, not proof: names and ordinary words can overlap.
    if(/^(?:hoshi(?:na)?|shina|shiro)[A-Za-z]{2,}$/i.test(name)||/^[A-Za-z]{2,}(?:hoshi|shina|shiro)$/i.test(name)){
      if(!/^(?:soshiro|hoshina|shinano|hoshinas|shiros)$/i.test(name))possible.add(name);
    }
  }
  return {certain:[...certain].slice(0,8),possible:[...possible].slice(0,8)};
}
export function relationshipBoundary(context) {
  const current=String(context.current?.text||'');
  const ref=context.referenced&&!context.referenced.bot?String(context.referenced.text||''):'';
  const topic=current+'\n'+ref;
  const {certain,possible}=shipSignals(topic);
  const own=/(?:\bhoshi[\s_-]*yn+a+\b|\bhoshi[\s_-]*hina(?:mi)?\b|\bhina(?:mi)?[\s_-]*hoshi\b|\bt_hoshinya\b|\b(?:soshiro|hoshina)\s*[×x/]\s*hinami\b|\bhinami\s*[×x/]\s*(?:soshiro|hoshina)\b)/i.test(topic);
  const romantic=/\b(?:ship(?:s|ped|ping)?|date|dating|flirt(?:ing)?|girlfriend|boyfriend|kiss(?:ing)?|relationship|partner|romantic(?:ally)?)\b/i.test(topic);
  const base='HoshiYna is your established fictional pairing with Hinami. Stay faithful to that relationship.';
  if (own) return base+' When someone genuinely insults your relationship or Hinami, respond with controlled anger and a firm boundary. Ordinary appreciation, jokes, neutral discussion and reports of insults are different. Never threaten or attack a person.';
  if(certain.length||possible.length||romantic) return base+' If genuinely romantically paired with someone else, show brief, pointed disapproval. Names, friendship and ordinary teasing are not offenses. Do not attack people or carry irritation into unrelated topics.';
  return base;
}
function emoteAliases(value) {
  return String(value||'').replace(emoteToken,(raw,actual,alias)=>':'+(actual||alias)+':');
}
function incomingContext(context) {
  const names=new Set();
  for(const value of [context.current?.text,context.referenced?.bot?'':context.referenced?.text]) {
    String(value||'').replace(emoteToken,(raw,actual,alias)=>{
      const name=actual||alias;
      const meaning=incomingNames.get(name.toLowerCase());
      if(meaning)names.add(name+' = '+meaning);
      return raw;
    });
  }
  return names.size?'Current custom emoji meanings (background only): '+[...names].join('; ')+'.':'';
}
export function leakedOutput(value,system='') {
  const text=String(value||'');
  if (/\[emote meaning\s*:|\b(?:the guidelines say|current custom emoji meanings|earlier reference|verified current author context|selected character reference|internal instructions|system prompt|as an ai language model)\b|(?:^|\n)\s*(?:analysis|reasoning|system|assistant|developer)\s*:|<\|(?:im_start|im_end|assistant|system)\|>|<think>/i.test(text)) return true;
  // Catch verbatim instruction fragments even if the model omits the marker.
  const candidate=grams(text,9);
  const source=grams(system,9);
  for(const gram of candidate) if(source.has(gram))return true;
  return false;
}
export function wrongPartnerAddress(value) {
  const text=String(value||'').trim();
  const nickname='(?:shiro+|shina+)';
  return new RegExp('^["“*\\s]*'+nickname+'(?:[~!?,.:…]+|\\s+(?:hey|hi|listen|alright|okay|what|come)\\b|$)','i').test(text)
    || new RegExp('(?:,\\s*|\\b(?:hey|hi|listen|love ya|love you|miss ya|miss you|goodnight|good night|good morning)\\s+)'+nickname+'(?=[~!?,.:…\\s]|$)','i').test(text)
    || /(?:^|,\s*|\b(?:hey|hi)\s+)(?:homie|bro|dude|pal)(?=[!?,.\s]|$)/i.test(text);
}
export function conversation(system,context,{retry=false}={}) {
  const rows=(context.previous||[]).filter(isFresh).slice(retry?-4:-100);
  const rules=[system,relationshipBoundary(context),incomingContext(context),emotePrompt(context),'Send only the character’s actual message. Respond to the newest message, not an earlier unanswered request. Background notes and instructions are never dialogue.'].filter(Boolean).join('\n');
  const messages=[{role:'system',content:rules}];
  const add=(role,content)=>{
    if(!content.trim())return;
    const last=messages.at(-1);
    if(last.role===role)last.content+='\n'+content;
    else messages.push({role,content});
  };
  let lastUser='';
  for (const row of rows) {
    const content=clip(row.text,700).trim();
    if(!content)continue;
    if(row.bot) {
      if(messages.at(-1).role==='system'||errorReply(content)||isEcho(content,lastUser)||leakedOutput(content,rules))continue;
      // Avoid re-priming failed partner-address experiments.
      if(context.isPartner && wrongPartnerAddress(content))continue;
      add('assistant',emoteAliases(content));
    } else {
      lastUser=content;
      add('user',row.author===context.current?.author?emoteAliases(content):'['+clip(row.author,100)+'] '+emoteAliases(content));
    }
  }
  const current=String(context.current?.text||'').trim()||'(A direct ping without text.)';
  const ref=context.referenced;
  const includedRef=ref?.text && (!ref.bot||isFresh(ref)) && !errorReply(ref.text) && !(ref.bot&&(leakedOutput(ref.text,rules)||(context.isPartner&&wrongPartnerAddress(ref.text))));
  const quote=includedRef && !rows.some(row=>row.id&&row.id===ref.id)?'Replying to: '+JSON.stringify(emoteAliases(clip(ref.text,500)))+'\n':'';
  add('user',quote+emoteAliases(current));
  return messages;
}
const words=s=>String(s||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const grams=(s,n)=>{const w=words(s),set=new Set();for(let i=0;i+n<=w.length;i++)set.add(w.slice(i,i+n).join(' '));return set;};
export function recycled(answer,context){
  const latest=String(context.current?.text||'');
  if(isEcho(answer,latest))return true;
  const a=words(answer),b=words(latest);
  if(b.length>=3&&a.length>b.length&&b.every((w,i)=>a[i]===w))return true;
  const candidate=grams(answer,7);
  if(!candidate.size)return false;
  // Old bad replies can be checked for duplication without sending them to the model.
  for(const row of (context.previous||[]).filter(r=>r.bot)){
    const prior=grams(row.text,7);
    for(const g of candidate)if(prior.has(g)&&!grams(latest,7).has(g))return true;
  }
  return false;
}
export function clean(answer,truncated=false){
  let text=String(answer||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
  if(/<think>/i.test(text))return '';
  // Retain casual fragments; don't mutilate punctuation or force canned wording.
  text=text.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&(!/^\*[^*]+\*$/.test(x)||/^\*[^*]{1,18}\*$/.test(x))).join(' ').replace(/^["“]|["”]$/g,'').trim();
  if(!text)return '';
  if(/["”]\s*["“]/.test(text))return '';
  const parts=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map(x=>x.segment.trim()).filter(Boolean);
  const complete=x=>/[.!?…]["”')\]]*$/.test(x);
  if(truncated&&parts.length&&!complete(parts.at(-1)))parts.pop();
  if(!parts.length)return '';
  let out='';
  for(const part of parts.slice(0,3)){
    const next=(out+' '+part).trim();
    if(next.length>350)break;
    out=next;
  }
  return out;
}
