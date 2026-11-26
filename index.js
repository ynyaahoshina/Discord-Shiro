import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { buildPrompt, conversation, clean, recycled, isFresh, HISTORY_CUTOFF, allowEmotes, renderApprovedEmotes, EMOTE_GUIDE, leakedOutput, wrongPartnerAddress, transcriptOutput } from './dialogue.js';

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
const outputBudget = number('RESPONSE_TOKEN_BUDGET', 1024, 1024);
const cooldown = Math.min(number('COOLDOWN_MS', 1000, 300000), 1000);
const dailyLimit = number('DAILY_REQUEST_LIMIT', 200, 10000);
const personality = await readFile(new URL('./personality.txt', import.meta.url), 'utf8');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false }
});
const last = new Map();
let busy = false, day = '', used = 0;
const clip = (s, n = 1200) => String(s ?? '').slice(0, n);
const record = m => {
  const text = String(m.content || '').replace(/<@!?(\d+)>/g, (_, id) => id === client.user.id ? '' : '@' + (m.mentions.users.get(id)?.username || 'member')).trim();
  const attachment = m.attachments?.size ? ' [Attachment present; image content unavailable]' : '';
  return { id: m.id, replyTo: m.reference?.messageId || null, authorId: m.author.id, timestamp: m.createdTimestamp, system: Boolean(m.system), author: clip(m.member?.displayName || m.author.username, 100), bot: m.author.id === client.user.id, text: clip(text + attachment) };
};
const configuredModel = env.CHAT_MODEL?.trim();
const retiredModels = new Set(['qwen/qwen3.5-397b-a17b','google/gemma-4-31b-it','meta/muse-glimmer-30b']);
const defaultModel = 'z-ai/glm-5.3-flash';
const model = !configuredModel || retiredModels.has(configuredModel) ? defaultModel : configuredModel;
const requestTimeout = number('AI_REQUEST_TIMEOUT_MS', 25000, 90000);
const totalTimeout = number('AI_TOTAL_TIMEOUT_MS', 35000, 120000);
if(retiredModels.has(configuredModel)) console.warn('[CONFIG] Ignoring retired model; using GLM Flash');
console.log('[CONFIG] revision=glm-stream-v24 selectedModel='+safeModel(model)+' requestTimeoutMs='+requestTimeout+' totalTimeoutMs='+totalTimeout);
function safeModel(value) { return /^[a-zA-Z0-9._/-]+$/.test(value) ? value : '(invalid format)'; }
const endpoint = (env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').trim().replace(/\/$/, '') + '/chat/completions';
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

async function generate(context, authorId, channelId, guild) {
  const acknowledgment=barePingReply(context);
  if(acknowledgment!==null){
    console.log('[AI] Bare ping acknowledged locally; no generation request');
    return acknowledgment;
  }
  const profile = await loadPersonality();
  const isPartner = Boolean(profile.partnerId && authorId === profile.partnerId);
  const allowPrivateLore = isPartner && privateLoreChannels.has(channelId);
  context = {...context, isPartner, emotes: allowEmotes(context) ? await resolveGuildEmotes(guild) : {}};
  context = {...context, previous:(context.previous||[]).filter(row=>!row.bot||!sceneLeak(row.text)), referenced:context.referenced?.bot&&sceneLeak(context.referenced.text)?null:context.referenced};
  console.log('[NOTION] Current author matches partner=' + isPartner);
  const topic = [context.current?.text, isFresh(context.referenced) ? context.referenced?.text : ''].filter(Boolean).join(' ');
  const system = buildPrompt(profile, {isPartner, topic, allowPrivateLore});
  const deadline=Date.now()+totalTimeout;
  const request = async (selected, retry=false) => {
    const started = Date.now();
    const remaining=Math.min(requestTimeout,deadline-started);
    if(remaining<=0)throw new Error('AI generation deadline exceeded');
    const messages = conversation(system, context, {retry});
    const options = selected === 'z-ai/glm-5.3-flash'
      ? {reasoning_effort:'low',chat_template_kwargs:{reasoning_effort:'low',clear_thinking:true}}
      : {};
    console.log('[AI] Request model=' + selected + ' retry=' + retry + ' messages=' + messages.length + ' promptChars=' + messages.reduce((n,m)=>n+m.content.length,0));
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
    if(leakedOutput(rawContent,messages[0]?.content||'')){
      console.warn('[AI] Rejected internal-instruction output; model='+selected);
      return '';
    }
    if(sceneLeak(rawContent)||transcriptOutput(rawContent,context)){
      console.warn('[AI] Rejected narration, transcript-like or unrelated technical output; model='+selected);
      return '';
    }
    const rawCleaned=clean(rawContent,choice?.finish_reason==='length');
    const cleaned=renderApprovedEmotes(rawCleaned,context);
    const repeat=Boolean(cleaned&&recycled(cleaned,context));
    const wrongAddress=Boolean(isPartner&&wrongPartnerAddress(cleaned));
    if(wrongAddress)console.warn('[AI] Rejected inappropriate partner address');
    console.log('[AI] Response model='+selected+' elapsedMs='+(Date.now()-started)+' finish_reason='+safeError(choice?.finish_reason)+' reasoning_present='+Boolean(choice?.message?.reasoning_content)+' completionTokens='+(data.usage?.completion_tokens??'unknown')+' visibleChars='+cleaned.length+' recycled='+repeat);
    return cleaned&&!repeat&&!wrongAddress?cleaned:'';
  };
  for(let attempt=0;attempt<2;attempt++){
    try{
      const answer=await request(model,attempt>0);
      if(answer)return answer;
    }catch(error){
      if(error.name==='TimeoutError'||error.name==='AbortError'){
        console.warn('[AI] Generation timed out model='+model+'; no automatic timeout retry');
        throw new Error('AI generation timed out');
      }
      console.warn('[AI] Generation request failed model='+model+' type='+safeError(error.name)+' detail='+safeError(error.message));
      throw error;
    }
    if(deadline-Date.now()<5000)break;
    if(attempt===0)console.warn('[AI] Retrying rejected output once with compact context');
  }
  throw new Error('Empty AI response');
}
client.once(Events.ClientReady, c => {
  console.log('Online as ' + c.user.tag);
  console.log('[MEMORY] Depth=' + historyDepth + ' recent=' + recentDepth + ' outputBudget=' + outputBudget);
  console.log('[MEMORY] New conversation boundary=' + new Date(HISTORY_CUTOFF).toISOString());
  console.log('[AI] Active model=' + model + ' endpoint=' + new URL(endpoint).origin + new URL(endpoint).pathname);
});
client.on(Events.MessageCreate, async m => {
  if (m.author.bot || m.webhookId || !m.inGuild() || !guilds.has(m.guildId) || !channels.has(m.channelId)) return;
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
        const answer = await generate({ ...history, referenced: referenced ? record(referenced) : null, current: record(m) }, m.author.id, m.channelId, m.guild);
        const chunks = splitDiscord(answer);
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await m.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
          else await m.channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
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
