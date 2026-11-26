import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { buildCharacterPrompt, makeConversation, cleanChat, isEcho } from './chat-core.js';

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
const outputBudget = number('RESPONSE_TOKEN_BUDGET', 500, 500);
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
  return { author: clip(m.member?.displayName || m.author.username, 100), bot: m.author.id === client.user.id, text: clip(text + attachment) };
};
const configuredModel = env.CHAT_MODEL?.trim();
const retiredModel = configuredModel === 'qwen/qwen3.5-397b-a17b';
const model = retiredModel || !configuredModel ? 'nvidia/nemotron-3.5-lightning-30b-a3b' : configuredModel;
if (retiredModel) console.warn('[CONFIG] Ignoring retired Qwen configuration; using Nemotron Lightning');
console.log('[CONFIG] revision=hoshina-rebuild-v12 CHAT_MODEL=' + (configuredModel ? safeModel(configuredModel) : '(missing or blank; using Nemotron default)'));
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
    .filter(item => !item.webhookId && (!item.author.bot || item.author.id === client.user.id))
    .sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
    .map(record);
  console.log('[MEMORY] Retrieved=' + previous.length + ' elapsedMs=' + (Date.now() - started));
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
async function generate(context, authorId, channelId) {
  const profile = await loadPersonality();
  const isPartner = Boolean(profile.partnerId && authorId === profile.partnerId);
  const allowPrivateLore = isPartner && privateLoreChannels.has(channelId);
  console.log('[NOTION] Current author matches partner=' + isPartner);
  const topic = [context.current?.text, context.referenced?.text].filter(Boolean).join(' ');
  const system = buildCharacterPrompt(profile, {isPartner, topic, allowPrivateLore});
  const current = String(context.current?.text || '').trim();
  const lightning = model === 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const gemma = model === 'google/gemma-4-31b-it';
  const request = async (retry=false) => {
    const started = Date.now();
    const messages = makeConversation(system, context, {retry});
    const options = lightning ? {
      chat_template_kwargs: {enable_thinking: !retry},
      ...(!retry ? {reasoning_budget: 128} : {})
    } : gemma ? {chat_template_kwargs: {enable_thinking:false}} : {};
    console.log('[AI] Request model=' + model + ' retry=' + retry + ' promptChars=' + messages.reduce((n,m)=>n+m.content.length,0));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.NVIDIA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({model, messages, max_tokens:outputBudget, temperature:0.85, stream:false, ...options}),
      signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) {
      const body = await response.text();
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error?.message || parsed.detail || parsed.message || parsed.title || '';
      } catch { detail = body; }
      console.warn('[AI] HTTP ' + response.status + ' model=' + model + ' detail=' + safeError(typeof detail === 'string' ? detail : JSON.stringify(detail)));
      const error = new Error('AI HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const choice = data.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const cleaned = cleanChat(content, choice?.finish_reason === 'length');
    console.log('[AI] Response elapsedMs=' + (Date.now()-started) + ' finish_reason=' + safeError(choice?.finish_reason) + ' reasoning_present=' + Boolean(choice?.message?.reasoning_content) + ' visibleChars=' + cleaned.length);
    return cleaned && !isEcho(cleaned,current) ? cleaned : '';
  };
  let answer = '';
  try { answer = await request(false); }
  catch (error) {
    // Older hosted builds may reject the optional reasoning parameter. Retry only that class of error.
    if (!(lightning && error.status === 400)) throw error;
    console.warn('[AI] First request rejected; trying direct chat once');
  }
  if (!answer) {
    console.warn('[AI] Empty, truncated, or echoed output; retrying once with shorter context');
    answer = await request(true);
  }
  if (!answer) throw new Error('Empty AI response');
  return answer;
}
client.once(Events.ClientReady, c => {
  console.log('Online as ' + c.user.tag);
  console.log('[MEMORY] Depth=' + historyDepth + ' recent=' + recentDepth + ' outputBudget=' + outputBudget);
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
        const answer = await generate({ ...history, referenced: referenced ? record(referenced) : null, current: record(m) }, m.author.id, m.channelId);
        const chunks = splitDiscord(answer);
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) await m.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false } });
          else await m.channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
      } finally { clearInterval(typing); }
    } catch (error) {
      console.warn('[AI] Interaction failed: ' + safeError(error.name) + ' ' + (error.message?.startsWith('AI HTTP ') || error.message === 'Empty AI response' ? safeError(error.message) : 'check connectivity or Discord permissions'));
      await m.reply({ content: 'I couldn\'t generate a response right now. Please try again shortly.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => console.warn('[Discord] Failed to send error reply'));
    } finally { busy = false; }
  } catch (error) {
    console.warn('Request failed:', error.name, error.message?.startsWith('AI HTTP ') ? error.message : 'check configuration or connectivity');
  }
});
client.login(env.DISCORD_BOT_TOKEN);
