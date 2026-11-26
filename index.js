import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { buildPrompt, conversation, clean, recycled, isFresh, HISTORY_CUTOFF, allowEmotes, renderApprovedEmotes, EMOTE_GUIDE, leakedOutput, wrongPartnerAddress, transcriptOutput, isEcho } from './dialogue.js';

const env = process.env;
for (const key of ['DISCORD_BOT_TOKEN', 'NVIDIA_API_KEY', 'ALLOWED_CHANNEL_IDS', 'ALLOWED_GUILD_IDS']) {
  if (!env[key]?.trim()) throw new Error('Missing configuration: ' + key);
}
const ids = value => new Set(value.split(',').map(s => s.trim()).filter(Boolean));
const channels = ids(env.ALLOWED_CHANNEL_IDS);
const guilds = ids(env.ALLOWED_GUILD_IDS);
const privateLoreChannels = ids(env.PRIVATE_LORE_CHANNEL_IDS || '');
if (!channels.size || !guilds.size) throw new Error('Configure test channel and guild allowlists.');
const number = (key, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(env[key], 10) || fallback));
const historyDepth = 100;
const recentDepth = 100;
const outputBudget = number('RESPONSE_TOKEN_BUDGET', 512, 1024);
const cooldown = Math.min(number('COOLDOWN_MS', 1000, 300000), 1000);
const dailyLimit = number('DAILY_REQUEST_LIMIT', 200, 10000);
const personality = await readFile(new URL('./personality.txt', import.meta.url), 'utf8');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false }
});
const last = new Map();
let busy = false, day = '', used = 0;
// Per-channel state: no follow-up quota, only a conservative eligibility gate.
const followupStates=new Map();
function followupState(channelId) {
  if(!followupStates.has(channelId))followupStates.set(channelId,{ordinary:0,revision:0,timer:null});
  return followupStates.get(channelId);
}
function noteChannelActivity(state) {
  state.revision++;
  if(state.timer!==null){
    clearTimeout(state.timer);state.timer=null;
    console.log('[FOLLOWUP] Canceled: new channel activity');
  }
}
function followupInstruction(eligible) {
  return eligible
    ? '\nOptional double-texting: normally send a single complete reply. Only if an additional, genuinely distinct afterthought, comic beat, affectionate tease or important clarification would benefit from arriving separately, append a new line with the exact marker [[FOLLOWUP]], then one additional short natural chat message. Do not divide a normal answer just for length, repeat yourself, demand attention, or force a follow-up. If there is nothing worth adding, omit the marker entirely. At most one follow-up, with at most one approved media reaction across both messages. Never display the marker to a member.'
    : '';
}
function separateFollowup(raw,eligible,truncated=false) {
  const parts=String(raw||'').split(/\s*\[\[FOLLOWUP\]\]\s*/i);
  return {primary:parts[0]||'',primaryTruncated:truncated&&parts.length===1,
    followup:eligible&&!truncated&&parts.length===2?parts[1]||'':''};
}
function scheduleFollowup(state,revision,channel,content,delay=3000+Math.floor(Math.random()*5001),commandNote=false) {
  if(!content||(!commandNote&&state.ordinary<5)||state.revision!==revision||state.timer!==null)return false;
  state.timer=setTimeout(async()=>{
    state.timer=null;
    if(state.revision!==revision)return;
    try{
      await channel.send({content,allowedMentions:{parse:[]}});
      state.ordinary=0;
      console.log('[FOLLOWUP] Sent optional second message');
    }catch(error){console.warn('[FOLLOWUP] Send failed: '+safeError(error.name));}
  },delay);
  console.log('[FOLLOWUP] Scheduled optional second message delayMs='+delay);
  return true;
}

// Social commands are selected by the model, then independently authorized here.
const hugFriends=Object.freeze({GEL:'692379268843569185',INDIE:'625861843545751594',MAX:'764225265298833418'});
const carrotId='304407007769919489';
function parseSocialCommand(raw) {
  const m=String(raw||'').trim().match(/^-(hug|kiss|stab)\s+<@!?(\d{17,20})>$/i);
  return m?{action:m[1].toLowerCase(),target:m[2]}:null;
}
function socialOptions(context,authorId,partnerId,botId) {
  const text=String(context.current?.text||'');
  const received=context.current?.social;
  const incoming=received?.target===botId?received.action:'';
  const partner=Boolean(partnerId&&authorId===partnerId);
  const safe=!/\b(?:actual(?:ly)?\s+(?:hurt|kill|stab)|injur(?:y|ed)|bleeding|suicid\w*|self.harm|threat|abuse|unsafe|scared|panic|trauma|serious fight|leave me alone|don't (?:kiss|hug|stab)|do not (?:kiss|hug|stab)|stop (?:kiss|hug|stab))\b/i.test(text);
  const hugRequest=incoming==='hug'||/\b(?:hug|hugs|cuddle|embrace)\b/i.test(text);
  const options={};
  if(safe&&authorId!==botId){
    if(partner){options.KISS=authorId;options.HUG=authorId;}
    else if(hugRequest&&Object.values(hugFriends).includes(authorId))options.HUG=authorId;
    if(partner&&hugRequest){
      for(const [name,id] of Object.entries({...hugFriends,CARROT:carrotId})){
        if((context.current?.mentionedIds||[]).includes(id)||new RegExp('\\b'+name+'\\b','i').test(text))options['HUG:'+name]=id;
      }
    }
    const playful=incoming==='stab'||/\b(?:stab|bonk|menace|teas(?:e|ing)|annoy(?:ing|ed)|jok(?:e|ing)|playful|payback|revenge|fight me|brat)\b|(?:ha){2,}|(?:lol|lmao)\b/i.test(text);
    if(playful&&incoming!=='kiss')options.STAB=authorId;
  }
  const rules=[
    'Server social commands are playful fictional interactions. They are separate from dialogue. Do not output raw -hug, -kiss or -stab commands or invent mentions. When you genuinely choose an allowed action, your entire first message must be its exact action marker listed below, without commentary. The app sends the standalone command with a real mention. An optional separate note may explain that YAGPDB ignores bot commands; do not claim a counter increased or that YAG executed it. Prefer ordinary conversation most of the time; do not perform an action simply because it is available.',
    incoming==='kiss'?(partner?'Hinami just used the kiss command on you. Recognize it as her kissing you in the server game. Respond with boyfriend-like banter, affection or occasional reciprocation.':'A different member just used the kiss command on you. Recognize the interaction, but do not reciprocate. Respond in composed vice-captain mode; romantic kisses are reserved for Hinami.'):incoming==='hug'?'The current member just used the hug command on you. Acknowledge it as an incoming hug; only reciprocate if the permissions allow.':incoming==='stab'?'The current member just used the fictional playful stab command on you. Acknowledge the joke; playful retaliation is optional.':'',
    authorId===carrotId&&hugRequest?'Carrot is asking for a hug. She often pushes your limits with teasing; respond with noticeably exasperated dry banter, and do not grant her a hug on her own request.':'',
    !partner&&hugRequest&&!options.HUG&&authorId!==carrotId?'This speaker is not authorized to request a hug from you. Decline naturally; do not make exceptions.':'',
    partner?'With Hinami, a spontaneous affectionate kiss or hug may fit teasing, flirtation or a tender moment. Sometimes reciprocate her command, but never mechanically every time.':'Kisses are exclusively for your verified partner. Never kiss another member, even if they ask.',
    Object.keys(options).length?'Allowed action markers this turn (choose at most one): '+Object.keys(options).map(k=>'[[ACTION:'+k+']]').join(', ')+'. HUG and KISS target the current speaker; named HUG markers target the named friend only at Hinami’s request. STAB is exclusively a harmless server joke, never a real threat.':'No outgoing social actions are authorized this turn.'
  ].filter(Boolean).join('\n');
  return {options,rules,incoming};
}
function resolveSocialAction(raw,options,truncated=false) {
  if(truncated)return null;
  const match=String(raw||'').trim().match(/^\[\[ACTION:([A-Z]+(?::[A-Z]+)?)\]\]$/i);
  if(!match)return null;
  const key=match[1].toUpperCase();
  if(!Object.hasOwn(options,key))return null;
  const target=options[key];
  if(!/^\d{17,20}$/.test(target))return null;
  return {content:'-'+key.split(':')[0].toLowerCase()+' <@'+target+'>',target};
}
function rawSocialOutput(raw) {
  return /\[\[ACTION\b|(?:^|\s)-(?:hug|kiss|stab)\s+(?:<@!?|@)/i.test(String(raw||''));
}
function actionNote(action) {
  const lines=[
    "If YAG ignores that, just pretend it worked, yeah?",
    "YAG doesn't listen to me, so use your imagination.",
    "If that didn't register, the thought still counts."
  ];
  const n=action==='kiss'?0:action==='hug'?2:1;
  return lines[n];
}

const clip = (s, n = 1200) => String(s ?? '').slice(0, n);
const record = m => {
  const raw=String(m.content||'');
  const social=parseSocialCommand(raw);
  const mentionedIds=[...raw.matchAll(/<@!?(\d{17,20})>/g)].map(x=>x[1]);
  const text = raw.replace(/<@!?(\d+)>/g, (_, id) => id === client.user.id ? (social?'@Soshiro Hoshina':'') : '@' + (m.mentions.users.get(id)?.username || 'member')).trim();
  const attachment = m.attachments?.size ? ' [Attachment present; image content unavailable]' : '';
  return { id: m.id, replyTo: m.reference?.messageId || null, authorId: m.author.id, timestamp: m.createdTimestamp, system: Boolean(m.system), author: clip(m.member?.displayName || m.author.username, 100), bot: m.author.id === client.user.id, social, mentionedIds, text: clip(text + attachment) };
};
const configuredModel = env.CHAT_MODEL?.trim();
const defaultModels = ['nvidia/nemotron-3.5-super-vl-120b-a12b','nvidia/nemotron-3.5-bolt-e4b','nvidia/nemotron-3-ultra-550b-a55b'];
// Only these three approved models participate in the conversational chain.
const modelChain = defaultModels.includes(configuredModel)
  ? [configuredModel,...defaultModels.filter(m=>m!==configuredModel)] : defaultModels;
const model = modelChain[0];
const requestTimeout = number('AI_REQUEST_TIMEOUT_MS', 15000, 90000);
const totalTimeout = number('AI_TOTAL_TIMEOUT_MS', 45000, 120000);
const modelCooldowns = new Map();
if(configuredModel&&!defaultModels.includes(configuredModel))console.warn('[CONFIG] Superseding previous chat model with Super VL');
console.log('[CONFIG] revision=daily-initiative-v28 models='+modelChain.join(' -> ')+' requestTimeoutMs='+requestTimeout+' totalTimeoutMs='+totalTimeout);
function safeModel(value) { return /^[a-zA-Z0-9._/-]+$/.test(value) ? value : '(invalid format)'; }
const endpoint = (env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
function safeError(value) {
  let result = String(value ?? '');
  for (const [key, secret] of Object.entries(env)) {
    if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key) && secret) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/(?:nvapi-|sk-|gsk_)[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 800);
}
let profileCache = null;
let profileLoadedAt = 0;
const notionText = (page, key) => {
  const p = page.properties?.[key];
  if (p?.type === 'number') return String(p.number ?? '');
  if (p?.type === 'select') return p.select?.name || '';
  return (p?.title || p?.rich_text || []).map(t => t.plain_text || '').join('').trim();
};
async function loadPersonality() {
  const secret = env.NOTION_SECRET_MY?.trim();
  const database = env.NOTION_BOT_DATABASE_ID?.trim();
  if (!secret || !database) {
    console.warn('[NOTION] Missing secret or database ID; using local personality');
    return { core: personality, partnerId: '', partnerName: '' };
  }
  if (profileCache && Date.now() - profileLoadedAt < 300000) return profileCache;
  try {
    // Only retrieve the explicitly named character. Never fetch tokens or other characters' data.
    const url = new URL('https://api.notion.com/v1/databases/' + encodeURIComponent(database) + '/query');
    for (const field of ['Name', 'Core_Instructions', 'Partner_ID', 'Partner_Name', ...(privateLoreChannels.size ? ['Partner_Lore'] : [])]) url.searchParams.append('filter_properties', field);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: 'Name', title: { equals: env.NOTION_CHARACTER_NAME || 'Soshiro Hoshina' } }, page_size: 2 }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error('Notion HTTP ' + res.status);
    const data = await res.json();
    if (data.results?.length !== 1) throw new Error('Expected exactly one matching character');
    const core = notionText(data.results[0], 'Core_Instructions');
    if (!core) throw new Error('Core_Instructions missing');
    const partnerId = notionText(data.results[0], 'Partner_ID').replace(/^<@!?([0-9]+)>$/, '$1').trim();
    profileCache = { core: clip(core, 60000), partnerLore: privateLoreChannels.size ? clip(notionText(data.results[0], 'Partner_Lore'), 60000) : '', partnerId: /^\d{17,20}$/.test(partnerId) ? partnerId : '', partnerName: clip(notionText(data.results[0], 'Partner_Name'), 120) };
    profileLoadedAt = Date.now();
    console.log('[NOTION] Character personality loaded; partner ID configured=' + Boolean(profileCache.partnerId));
    return profileCache;
  } catch (error) {
    console.warn('[NOTION] Personality unavailable: ' + safeError(error.message));
    return profileCache || { core: personality, partnerId: '', partnerName: '' };
  }
}
async function readThreadHistory(message) {
  const started = Date.now();
  const batch = await message.channel.messages.fetch({ limit: 100, before: message.id, cache: false });
  const previous = [...batch.values()]
    .filter(item => !item.system && !item.webhookId && (!item.author.bot || item.author.id === client.user.id))
    .sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    .map(record);
  console.log('[MEMORY] Retrieved=' + previous.length + ' fresh=' + previous.filter(isFresh).length + ' elapsedMs=' + (Date.now() - started));
  return { previous };
}
function splitDiscord(text) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf('\n', 1900);
    if (cut < 1000) cut = rest.lastIndexOf(' ', 1900);
    if (cut < 1000) cut = 1900;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
const emojiRefresh = new Map();
async function resolveGuildEmotes(guild) {
  if (!guild) return {};
  let emojis = guild.emojis.cache;
  const names = new Set([...emojis.values()].map(emoji=>emoji.name));
  if (Object.keys(EMOTE_GUIDE).some(name=>!names.has(name)) && Date.now()-(emojiRefresh.get(guild.id)||0)>=300000) {
    emojiRefresh.set(guild.id,Date.now());
    try { emojis = await guild.emojis.fetch(); }
    catch(error) { console.warn('[EMOTES] Guild emoji refresh unavailable: '+safeError(error.name)); }
  }
  const me = guild.members.me;
  const result = {};
  for (const emoji of emojis.values()) {
    if (!Object.hasOwn(EMOTE_GUIDE,emoji.name) || emoji.available === false) continue;
    if (emoji.roles?.cache?.size && !emoji.roles.cache.some(role=>me?.roles.cache.has(role.id))) continue;
    result[emoji.name] = '<'+(emoji.animated?'a':'')+':'+emoji.name+':'+emoji.id+'>';
  }
  console.log('[EMOTES] Approved available='+Object.keys(result).length+'/'+Object.keys(EMOTE_GUIDE).length);
  return result;
}
// Extra guard for first-person scene prose and inline dialogue labels.
function sceneLeak(value) {
  const text=String(value||'');
  return /\b(?:the |my )?(?:text |message )?notification(?: light)?\s+(?:blinks?|lights? up|flashes|pops? up|buzzes)\b/i.test(text)
    || /\b(?:my|his|her|the) (?:phone|screen)\s+(?:blinks?|lights? up|flashes|buzzes|vibrates)\b/i.test(text)
    || /\bI\s+(?:open|check|read)\s+(?:the|my)\s+(?:chat|phone|screen|message)\s+(?:and\s+)?(?:tilt|smile|smirk|glance|look|tap|type|sigh|chuckle)\b/i.test(text)
    || /(?:^|[\s.!?])(?:Soshiro(?: Hoshina)?|Hoshina|Hinami|Narrator)\s*:\s*["“]/i.test(text);
}
function barePingReply(context) {
  if(String(context.current?.text||'').trim())return null;
  const choices=['Hm?','Yeah?','What is it?'];
  const id=String(context.current?.id||'0');
  const n=Number(id.slice(-4));
  return choices[Number.isFinite(n)?n%choices.length:0];
}
// Collect streamed visible text only. Never send or store reasoning content.
async function readCompletion(response, started, selected) {
  if(!response.headers?.get('content-type')?.includes('text/event-stream')) return response.json();
  if(!response.body)throw new Error('AI stream body missing');
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let buffer='',content='',reasoning=false,finish=null,usage,first=false,doneEvent=false;
  function line(raw){
    if(!raw.startsWith('data:'))return;
    const payload=raw.slice(5).trim();
    if(payload==='[DONE]'){doneEvent=true;return;}
    if(!payload)return;
    let packet;try{packet=JSON.parse(payload)}catch{throw new Error('Invalid AI stream event')}
    if(packet.error)throw new Error('AI stream error');
    if(packet.usage)usage=packet.usage;
    const c=packet.choices?.[0],delta=c?.delta||{};
    if(!first&&(delta.reasoning_content||delta.reasoning||delta.content)){
      first=true;console.log('[AI] First generated token model='+selected+' elapsedMs='+(Date.now()-started));
    }
    if(delta.reasoning_content||delta.reasoning)reasoning=true;
    const part=typeof delta.content==='string'?delta.content:Array.isArray(delta.content)?delta.content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join(''):'';
    if(part&&!content)console.log('[AI] First visible text model='+selected+' elapsedMs='+(Date.now()-started));
    content+=part;
    if(c?.finish_reason)finish=c.finish_reason;
  }
  try{
    while(!doneEvent){
      const chunk=await reader.read();
      if(chunk.done){buffer+=decoder.decode();break;}
      buffer+=decoder.decode(chunk.value,{stream:true});
      const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';
      for(const item of lines){line(item);if(doneEvent)break;}
    }
    if(buffer.trim()&&!doneEvent)line(buffer);
    if(!doneEvent&&!finish)throw new Error('AI stream ended without completion');
    return {choices:[{message:{content,reasoning_content:reasoning?true:undefined},finish_reason:finish||'stop'}],usage};
  }finally{try{await reader.cancel()}catch{}}
}

async function generate(context, authorId, channelId, guild, followupEligible=false) {
  const acknowledgment=context.initiative?null:barePingReply(context);
  if(acknowledgment!==null){
    console.log('[AI] Bare ping acknowledged locally; no generation request');
    return {primary:acknowledgment,followup:''};
  }
  const profile = await loadPersonality();
  const isPartner = Boolean(profile.partnerId && authorId === profile.partnerId);
  if(context.initiative&&!isPartner)throw new Error('Daily initiative partner verification failed');
  const allowPrivateLore = isPartner && privateLoreChannels.has(channelId);
  context = {...context, isPartner, emotes: allowEmotes(context) ? await resolveGuildEmotes(guild) : {}};
  context = {...context, previous:(context.previous||[]).filter(row=>!row.bot||!sceneLeak(row.text)), referenced:context.referenced?.bot&&sceneLeak(context.referenced.text)?null:context.referenced};
  console.log('[NOTION] Current author matches partner=' + isPartner);
  const topic = [context.current?.text, isFresh(context.referenced) ? context.referenced?.text : ''].filter(Boolean).join(' ');
  const social=context.initiative?{options:{},rules:'No social commands or action markers on this initiative.'}:socialOptions(context,authorId,profile.partnerId,client.user.id);
  const initiativeRules=context.initiative?'\nYou are initiating a conversation with your established fictional partner, rather than replying to a message she just sent. The final user-role text is an internal scheduling cue, not her words. Choose a brief, natural in-character opening: a casual check-in, a relevant playful remark, a little flirtation or an interesting topic. Use recent conversation only when grounded; do not invent what she is doing, imply she has ignored you, demand a reply, guilt her, or mention scheduling or bot mechanics. Do not type any mention or name as a mandatory greeting; the app adds the actual ping. Send one conversational message with words, not just a reaction.':'';
  const system = buildPrompt(profile, {isPartner, topic, allowPrivateLore})+'\n'+social.rules+initiativeRules;
  const deadline=Date.now()+totalTimeout;
  const request = async (selected, slotsLeft) => {
    const started = Date.now();
    const remaining=Math.min(requestTimeout,Math.floor((deadline-started)/slotsLeft));
    if(remaining<=0)throw new Error('AI generation deadline exceeded');
    const messages = conversation(system+followupInstruction(followupEligible), context);
    const options = {chat_template_kwargs:{enable_thinking:false}};
    console.log('[AI] Request model=' + selected + ' timeoutMs='+remaining+' messages=' + messages.length + ' promptChars=' + messages.reduce((n,m)=>n+m.content.length,0));
    const response = await fetch(endpoint, {
      method:'POST',
      headers:{Authorization:'Bearer '+env.NVIDIA_API_KEY,'Content-Type':'application/json','Accept':'text/event-stream'},
      body:JSON.stringify({model:selected,messages,max_tokens:outputBudget,temperature:0.7,stream:true,...options}),
      signal:AbortSignal.timeout(remaining)
    });
    if(!response.ok){
      const body=await response.text();
      let detail='';
      try{const parsed=JSON.parse(body);detail=parsed.error?.message||parsed.detail||parsed.message||parsed.title||'';}catch{detail=body;}
      console.warn('[AI] HTTP '+response.status+' model='+selected+' detail='+safeError(typeof detail==='string'?detail:JSON.stringify(detail)));
      const error=new Error('AI HTTP '+response.status);error.status=response.status;throw error;
    }
    console.log('[AI] Response headers model='+selected+' elapsedMs='+(Date.now()-started));
    const data=await readCompletion(response,started,selected);
    const choice=data.choices?.[0];
    const content=choice?.message?.content;
    const rawContent=typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join(''):'';
    const separated=separateFollowup(rawContent,followupEligible,choice?.finish_reason==='length');
    const action=resolveSocialAction(separated.primary,social.options,separated.primaryTruncated||choice?.finish_reason==='length');
    if(action){
      console.log('[AI] Authorized social action='+action.content.split(' ')[0]);
      return {primary:action.content,actionTarget:action.target,followup:actionNote(action.content.split(' ')[0].slice(1))};
    }
    const valid=(raw,ctx,truncated=false)=>{
      if(!raw||rawSocialOutput(raw)||leakedOutput(raw,messages[0]?.content||'')||sceneLeak(raw)||transcriptOutput(raw,ctx))return '';
      const rendered=renderApprovedEmotes(clean(raw,truncated),ctx);
      if(!rendered||recycled(rendered,ctx)||(isPartner&&wrongPartnerAddress(rendered)))return '';
      return rendered;
    };
    const primary=valid(separated.primary,context,separated.primaryTruncated);
    if(!primary||(context.initiative&&!/[\p{L}]/u.test(renderApprovedEmotes(clean(separated.primary,separated.primaryTruncated),{...context,previous:[]})))){
      console.warn('[AI] Rejected unusable primary reply; model='+selected);
      return null;
    }
    // Preserve the normal media permission/cooldown. If the first message used
    // a reaction, render the optional second message as text only.
    const primaryPlain=renderApprovedEmotes(clean(separated.primary,separated.primaryTruncated),{...context,previous:[]});
    const usedMedia=primary!==primaryPlain;
    let followup='';
    if(separated.followup){
      const followCtx={...context,previous:usedMedia?[]:context.previous};
      const candidate=valid(separated.followup,followCtx);
      if(candidate&&candidate.length<=1200&&!isEcho(candidate,primary)&&!recycled(candidate,{...context,previous:[...(context.previous||[]),{text:primary}]}))followup=candidate;
    }
    console.log('[AI] Response model='+selected+' elapsedMs='+(Date.now()-started)+' finish_reason='+safeError(choice?.finish_reason)+' reasoning_present='+Boolean(choice?.message?.reasoning_content)+' completionTokens='+(data.usage?.completion_tokens??'unknown')+' visibleChars='+primary.length+' followup='+Boolean(followup));
    return {primary,followup};
  };
  const candidates=modelChain.filter(m=>(modelCooldowns.get(m)||0)<=Date.now());
  if(!candidates.length){console.warn('[AI] All conversational endpoints cooling down');throw new Error('Empty AI response');}
  for(let i=0;i<candidates.length;i++){
    if(deadline-Date.now()<=0)break;
    const selected=candidates[i];
    try{
      const answer=await request(selected,candidates.length-i);
      if(answer){console.log('[AI] Accepted reply model='+selected);return answer;}
      console.warn('[AI] Unusable reply model='+selected+'; trying next model');
    }catch(error){
      // Authentication failure affects the shared key, so do not waste further calls.
      if(error.status===401)throw error;
      const timedOut=error.name==='TimeoutError'||error.name==='AbortError';
      if(error.status===410)modelCooldowns.set(selected,Infinity);
      else if(timedOut||[403,404,408,429,500,502,503,504].includes(error.status)||error.name==='TypeError')modelCooldowns.set(selected,Date.now()+60000);
      console.warn('[AI] Model failed='+selected+' reason='+safeError(timedOut?'timeout':error.message)+'; trying next model');
    }
    if(i+1<candidates.length)console.log('[AI] Failover '+selected+' -> '+candidates[i+1]);
  }
  throw new Error('Empty AI response');
}

// Once-daily initiative: deterministic pseudo-random Manila time and Discord-backed
// duplicate detection, so normal redeployments do not reset the daily schedule.
const initiativePartner='399942598791266304';
const initiativeChannel=env.DAILY_INITIATIVE_CHANNEL_ID?.trim()||(channels.size===1?[...channels][0]:'');
const initiativeWindowMs=15*60*1000;
const initiativeQuietMs=60*60*1000;
let initiativeAttemptDay='';
function manilaDate(now=Date.now()) {
  return new Date(now+8*60*60*1000).toISOString().slice(0,10);
}
function initiativeSlot(date,channelId,partnerId=initiativePartner) {
  // A deterministic day-specific hash keeps the random-looking time across restarts.
  let hash=2166136261;
  for(const char of date+'|'+channelId+'|'+partnerId)hash=Math.imul(hash^char.charCodeAt(0),16777619);
  const minutes=8*60+((hash>>>0)%(15*60));
  const midnight=Date.parse(date+'T00:00:00+08:00');
  return {start:midnight+minutes*60000,end:Math.min(midnight+23*60*60000,midnight+minutes*60000+initiativeWindowMs),minute:minutes,midnight};
}
function isDailyPing(message,botId,partnerId,date) {
  return message.author?.id===botId&&!message.reference?.messageId&&manilaDate(message.createdTimestamp)===date&&
    String(message.content||'').startsWith('<@'+partnerId+'> ');
}
async function initiativeHistory(channel,slot,date,botId,partnerId) {
  let before,previous=[];
  // Scan to the beginning of today's scheduled window, even in a busy channel.
  // If the bounded scan cannot establish absence of a previous ping, fail closed.
  for(let page=0;page<10;page++){
    const batch=await channel.messages.fetch({limit:100,...(before?{before}:{}),cache:false});
    const entries=[...batch.values()].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
    if(page===0)previous=entries.filter(item=>!item.system&&!item.webhookId&&(!item.author.bot||item.author.id===botId)).reverse().map(record);
    if(entries.some(m=>isDailyPing(m,botId,partnerId,date)))return {already:true,verified:true,previous};
    if(entries.length<100||entries.at(-1)?.createdTimestamp<slot.start)return {already:false,verified:true,previous};
    before=entries.at(-1).id;
  }
  return {already:false,verified:false,previous};
}
function recentPartnerConversation(previous,partnerId,botId,now) {
  const byId=new Map(previous.map(r=>[r.id,r]));
  return previous.some(r=>{
    if(now-r.timestamp>=initiativeQuietMs||r.timestamp>now)return false;
    const target=byId.get(r.replyTo);
    if(r.authorId===partnerId)return (r.mentionedIds||[]).includes(botId)||target?.bot;
    if(r.bot)return target?.authorId===partnerId||(r.mentionedIds||[]).includes(partnerId);
    return false;
  });
}
async function dailyInitiative() {
  if(!initiativeChannel||!channels.has(initiativeChannel)||!client.isReady())return;
  const now=Date.now(),today=manilaDate(now),slot=initiativeSlot(today,initiativeChannel);
  if(now<slot.start||now>=slot.end||initiativeAttemptDay===today||busy)return;
  if(day!==today){day=today;used=0;}
  if(used>=dailyLimit)return;
  initiativeAttemptDay=today;
  busy=true;
  try{
    const profile=await loadPersonality();
    if(profile.partnerId!==initiativePartner){console.warn('[INITIATIVE] Partner identity not verified; skipped');return;}
    const channel=await client.channels.fetch(initiativeChannel);
    if(!channel?.isTextBased()||!channel.guildId||!guilds.has(channel.guildId)||typeof channel.send!=='function')return;
    const state=followupState(initiativeChannel),revision=state.revision;
    const history=await initiativeHistory(channel,slot,today,client.user.id,initiativePartner);
    if(history.already||!history.verified){console.log('[INITIATIVE] Prior daily ping or incomplete history; skipped');return;}
    if(recentPartnerConversation(history.previous,initiativePartner,client.user.id,Date.now())){console.log('[INITIATIVE] Recent partner conversation; skipped');return;}
    if(state.revision!==revision||Date.now()>=slot.end)return;
    used++;
    const current={id:'',authorId:initiativePartner,author:profile.partnerName||'Hinami',timestamp:Date.now(),bot:false,text:'Internal initiative cue: begin a natural conversation with your partner now.'};
    const answer=await generate({previous:history.previous,current,referenced:null,initiative:true},initiativePartner,initiativeChannel,channel.guild,false);
    if(!answer?.primary||answer.actionTarget||state.revision!==revision||Date.now()>=slot.end||manilaDate()!==today)return;
    // Prevent overlap during deployments with a stable daily Discord nonce.
    const nonce='daily-'+today.replace(/-/g,'')+'-'+String(slot.minute);
    const body=answer.primary.replace(/<@!?\d+>|<@&\d+>|@everyone|@here/gi,'').trim();
    if(!body)return;
    await channel.send({content:'<@'+initiativePartner+'> '+body,allowedMentions:{parse:[],users:[initiativePartner],repliedUser:false},nonce,enforceNonce:true});
    console.log('[INITIATIVE] Sent daily partner ping date='+today);
  }catch(error){console.warn('[INITIATIVE] Skipped after error: '+safeError(error.name));}
  finally{busy=false;}
}

client.once(Events.ClientReady, c => {
  console.log('Online as ' + c.user.tag);
  console.log('[MEMORY] Depth=' + historyDepth + ' recent=' + recentDepth + ' outputBudget=' + outputBudget);
  console.log('[MEMORY] New conversation boundary=' + new Date(HISTORY_CUTOFF).toISOString());
  console.log('[AI] Active model=' + model + ' endpoint=' + new URL(endpoint).origin + new URL(endpoint).pathname);
  if(initiativeChannel&&channels.has(initiativeChannel)){
    console.log('[INITIATIVE] Enabled for existing allowed channel; once per Manila day, 08:00–23:00');
    setInterval(()=>void dailyInitiative(),30000);
    void dailyInitiative();
  }else console.warn('[INITIATIVE] Disabled: multiple allowed channels or invalid initiative channel; set DAILY_INITIATIVE_CHANNEL_ID to the intended allowed channel');
});
client.on(Events.MessageCreate, async m => {
  if (!m.inGuild() || !guilds.has(m.guildId) || !channels.has(m.channelId)) return;
  const state=followupState(m.channelId);
  if(m.author.id!==client.user.id&&!m.system)noteChannelActivity(state);
  if (m.author.bot || m.webhookId || m.system) return;
  const revision=state.revision;
  let referenced;
  try {
    if (m.reference?.messageId && (!m.reference.channelId || m.reference.channelId === m.channelId)) {
      referenced = await m.fetchReference().catch(error => {
        console.warn('[TRIGGER] Reply reference lookup failed: ' + safeError(error.name));
        return null;
      });
    }
    const direct = new RegExp('<@!?' + client.user.id + '>').test(m.content);
    const isReply = referenced?.author.id === client.user.id;
    if (!direct && !isReply) return;
    console.log('[TRIGGER] direct=' + direct + ' reply=' + isReply);
    const now = Date.now();
    if (busy) { console.log('[TRIGGER] Skipped: another request in progress'); return; }
    if (!isReply && now - (last.get(m.author.id) || 0) < cooldown) { console.log('[TRIGGER] Skipped: cooldown'); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (day !== today) { day = today; used = 0; }
    if (used >= dailyLimit) { console.log('[TRIGGER] Skipped: daily request cap'); return; }
    busy = true;
    used++;
    last.set(m.author.id, now);
    for (const [id, time] of last) if (now - time > cooldown) last.delete(id);
    try {
      await m.channel.sendTyping().catch(() => {});
      const typing = setInterval(() => m.channel.sendTyping().catch(() => {}), 8000);
      try {
        const history = await readThreadHistory(m);
        const answer = await generate({ ...history, referenced: referenced ? record(referenced) : null, current: record(m) }, m.author.id, m.channelId, m.guild, state.ordinary>=5&&state.revision===revision);
        const chunks = splitDiscord(answer.primary);
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await m.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false, ...(answer.actionTarget?{users:[answer.actionTarget]}:{}) } });
          else await m.channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
        state.ordinary=Math.min(5,state.ordinary+1);
        if(answer.followup)scheduleFollowup(state,revision,m.channel,answer.followup,undefined,Boolean(answer.actionTarget));
      } finally { clearInterval(typing); }
    } catch (error) {
      console.warn('[AI] Interaction failed: ' + safeError(error.name) + ' ' + (error.message?.startsWith('AI HTTP ') || ['Empty AI response','AI generation timed out','AI generation deadline exceeded'].includes(error.message) ? safeError(error.message) : 'check connectivity or Discord permissions'));
      await m.reply({ content: 'I\'m a little busy right now, mind lettin\ a man have his peace? Thank you.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => console.warn('[Discord] Failed to send error reply'));
    } finally { busy = false; }
  } catch (error) {
    console.warn('Request failed:', error.name, error.message?.startsWith('AI HTTP ') ? error.message : 'check configuration or connectivity');
  }
});
client.login(env.DISCORD_BOT_TOKEN);
