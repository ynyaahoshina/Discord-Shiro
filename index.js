import { Client, GatewayIntentBits, Events } from 'discord.js';
import { readFile, readdir } from 'node:fs/promises';
import { partnerBanter, buildPrompt, conversation, clean, recycled, isFresh, HISTORY_CUTOFF, allowEmotes, renderApprovedEmotes, EMOTE_GUIDE, GIF_GUIDE, MEMORY_GUIDE, leakedOutput, wrongPartnerAddress, transcriptOutput, isEcho } from './dialogue.js';

const env = process.env;
// Explicitly verified by the owner; Discord snowflakes remain strings.
const verifiedPartnerId='399942598791266304';
const verifiedPartnerName='Hinami';
const ttsReady=()=>env.ELEVENLABS_ENABLED==='true'&&Boolean(env.ELEVENLABS_API_KEY?.trim()&&env.ELEVENLABS_VOICE_ID?.trim())&&(!env.ELEVENLABS_MODEL_ID||env.ELEVENLABS_MODEL_ID==='eleven_v4');
const secretPhrase=env.SECRET_TEST_PHRASE||'';
const testStates=new Map();
const testState=id=>{if(!testStates.has(id))testStates.set(id,{developer:false,pending:null,secret:null});return testStates.get(id);};
function requestKind(value) {
  const text=String(value||'');
  if(/\b(?:don't|do not|stop|no more|never)\s+(?:send|play|record|use|make)\b/i.test(text))return '';
  if(/\b(?:send|play|record|make|give|hear|want|need)\b.{0,60}\b(?:voice(?:\s+(?:message|note|recording|clip))?|recording|audio|mp3)\b|\b(?:voice recording|voice note|voice message)\s*(?:please|pls)\b/i.test(text))return 'voice';
  if(/\b(?:send|show|use|give|post)\b.{0,70}\b(?:gif|artwork|image)\b|\b(?:gif|mem)_[a-z0-9_]+\b/i.test(text))return 'gif';
  if(/\b(?:send|show|use|give|post)\b.{0,60}\b(?:emote|emoji|reaction)\b/i.test(text))return 'emote';
  return '';
}
function voiceBoundary(text) {
  return /\b(?:leave me alone|give me (?:some )?space|stop (?:it|flirting|teasing|talking|messaging|pinging|joking|sending)|(?:don't|do not) (?:talk to|message|ping|flirt with|tease) me|unsafe|suicid\w*|self.harm|break up|i(?:'m| am) (?:driving|riding))\b/i.test(String(text||'').replace(/[’‘]/g,"'"));
}
function testingControl(state,raw,authorId,now=Date.now()) {
  if(authorId!==verifiedPartnerId)return {kind:''};
  if(/^enter developer mode$/i.test(raw.trim())){state.developer=true;state.secret=null;return {command:'Developer mode enabled.'};}
  if(/^end developer mode$/i.test(raw.trim())){state.developer=false;state.secret=null;return {command:'Developer mode disabled.'};}
  if(state.secret&&now-state.secret.at>15*60000)state.secret=null;
  if(voiceBoundary(raw)){state.secret=null;state.pending=null;return {kind:''};}
  if(secretPhrase&&raw===secretPhrase&&!state.developer){
    if(state.pending&&now-state.pending.at<=15*60000&&!state.secret)state.secret={...state.pending,at:now,count:0};
    return {secretTrigger:true,kind:state.secret?.count===2?state.secret.kind:'',requested:state.secret?.text||''};
  }
  const kind=requestKind(raw);
  if(kind&&!state.secret)state.pending={kind,text:raw.slice(0,400),at:now};
  if(state.developer)return {kind,requested:raw.slice(0,400),developer:true};
  if(state.secret)return {kind:state.secret.count===2?state.secret.kind:'',requested:state.secret.text,secretActive:true};
  return {kind:''};
}
function advanceSecret(state,delivered,forced) {
  if(!state.secret||!delivered)return;
  if(state.secret.count<2)state.secret.count++;
  else if(forced){state.secret=null;state.pending=null;}
}
function dayHash(value) {
  let hash=2166136261;
  for(const char of value)hash=Math.imul(hash^char.charCodeAt(0),16777619);
  return hash>>>0;
}
function voiceInitiativeSlot(date,channelId) {
  const h=dayHash(date+'|'+channelId+'|voice');
  return h%100<40?dayHash(date+'|'+channelId+'|voice-slot')%3:-1;
}
const voiceDirections='You are recording a personal voice message for Hinami. Use natural conversational English, subtle Kansai-influenced contractions, confident dry wit, affectionate teasing, imperfect pauses and shifts of tone. Mild exasperation can soften into fondness; never sound like a romance narrator or therapist. At peak playful flustering, be amused and boldly affectionate; concern should be specific and sincere. If recent context establishes you are at fictional work, usually whisper or speak low and discreetly; do not invent a work schedule. If initiating, mainly express that you missed her, without guilt or demanding a response. Use optional inline audio directions such as [teasing whisper, fond], [annoyed, low but fond], [whispers], [low volume, slightly nervous], [soft chuckle], [embarrassed, hurried], [long pause]. Vary openings, endings and emotional transitions. Not every recording needs I love you. Spoken dialogue must be at most 150 Unicode characters excluding tags; total script at most 500 characters. No markup except short bracketed vocal directions, no mentions, URLs, scene narration, private configuration or technical explanations. Name the recording yourself with a short playful ASCII filename stem based on what you say. Output ONLY [[VOICE]] followed by a newline, filename stem, newline, spoken script and tags. Do not include a follow-up marker.';
function parseVoiceOutput(raw) {
  const m=String(raw||'').trim().match(/^\[\[VOICE\]\]\r?\n([^\r\n]+)\r?\n([\s\S]+)$/);
  if(!m)return null;
  const script=m[2].trim(),spoken=script.replace(/\[[a-z ,'-]{1,80}\]/gi,'').replace(/\s+/g,' ').trim();
  if(!spoken||[...spoken].length>150||[...script].length>500||/[\[\]<>]/.test(spoken)||/https?:|@everyone|@here|elevenlabs|api.key|developer mode|secret test/i.test(script))return null;
  const stem=m[1].replace(/\.mp3$/i,'').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70);
  return {script,spoken,name:(stem&&!/elevenlabs|api|secret|token/i.test(stem)?stem:'For_you')+'.mp3'};
}
async function synthesizeVoice(voice,authorId) {
  if(authorId!==verifiedPartnerId||!ttsReady()||!voice)throw Error('Voice not configured');
  const validated=parseVoiceOutput('[[VOICE]]\n'+voice.name+'\n'+voice.script);
  if(!validated)throw Error('Invalid voice script');
  const response=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+encodeURIComponent(env.ELEVENLABS_VOICE_ID.trim())+'?output_format=mp3_44100_128',{
    method:'POST',headers:{'xi-api-key':env.ELEVENLABS_API_KEY.trim(),'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({text:validated.script,model_id:'eleven_v4'}),signal:AbortSignal.timeout(30000)
  });
  if(!response.ok){console.warn('[VOICE] Synthesis HTTP '+response.status);throw Error('Synthesis failed');}
  if(!/^audio\//i.test(response.headers.get('content-type')||''))throw Error('Invalid audio type');
  const data=Buffer.from(await response.arrayBuffer());
  if(!data.length||data.length>8*1024*1024)throw Error('Invalid audio size');
  console.log('[VOICE] Generated recording spokenChars='+[...validated.spoken].length+' inputChars='+[...validated.script].length);
  return {attachment:data,name:validated.name};
}
function dynamicVoiceEligible(context,random=Math.random) {
  if(!context.isPartner||!ttsReady())return false;
  if(context.forceKind==='voice')return true;
  if(context.initiative)return Boolean(context.voiceInitiative);
  if(context.forceKind||voiceBoundary(context.current?.text)||context.secretWaiting)return false;
  const recent=(context.previous||[]).filter(r=>r.bot).at(-1);
  if(recent?.voiceName)return false;
  const text=String(context.current?.text||'');
  if(partnerBanter(context,context.previous||[]).includes('boldly'))return random()<.40;
  if(requestKind(text)==='voice')return random()<.40;
  if(/\b(?:miss (?:you|ya)|love (?:you|ya)|exhausted|overwork(?:ed)?|so tired|bad day|need a break|drive home|going to work|head(?:ing)? home|kiss|blush|fluster)\b/i.test(text))return random()<.30;
  return false;
}
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
const outputBudget = number('RESPONSE_TOKEN_BUDGET', 768, 1024);
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
function followupEligibleFor(state,revision,authorId,text,random=Math.random) {
  if(state.revision!==revision)return false;
  if(!String(text||'').trim()||/\b(?:leave me alone|give me (?:some )?space|stop (?:talking|messaging|pinging|flirting|teasing)|(?:don't|do not) (?:reply|message|ping|talk to) me|i need space|i(?:'m| am) driving|i(?:'m| am) riding)\b/i.test(String(text||'').replace(/[’‘]/g,"'")))return false;
  return random()<(authorId===verifiedPartnerId?0.80:0.70);
}
function followupInstruction(eligible,partner=false) {
  if(eligible)return '\nTwo-message conversational turn selected: send a natural first message, then on a new line the exact marker [[FOLLOWUP]], followed by one short, distinct continuation. Favor a separate thought, joke, clarification or affectionate aside that flows from this specific conversation. Do not repeat the first message, manufacture a question, pressure the recipient, split a sentence artificially, or add filler. If a second message would be inappropriate, omit it. At most one approved media reaction across both messages. Never show the marker.';
  return eligible
    ? '\nOptional double-texting: normally send a single complete reply. Only if an additional, genuinely distinct afterthought, comic beat, affectionate tease or important clarification would benefit from arriving separately, append a new line with the exact marker [[FOLLOWUP]], then one additional short natural chat message. Do not divide a normal answer just for length, repeat yourself, demand attention, or force a follow-up. If there is nothing worth adding, omit the marker entirely. At most one follow-up, with at most one approved media reaction across both messages. Never display the marker to a member.'
    : '';
}
function separateFollowup(raw,eligible,truncated=false) {
  const parts=String(raw||'').split(/\s*\[\[FOLLOWUP\]\]\s*/i);
  return {primary:parts[0]||'',primaryTruncated:truncated&&parts.length===1,
    followup:eligible&&!truncated&&parts.length===2?parts[1]||'':''};
}
const followupDelayMs=4000;
function scheduleFollowup(state,revision,channel,content,delay=followupDelayMs,partner=false,firstMessage=null) {
  if(!content||state.revision!==revision||state.timer!==null)return false;
  const started=Date.now();
  // Start the full delay only after the first Discord message has been sent.
  void channel.sendTyping().catch(()=>{});
  state.timer=setTimeout(async()=>{
    state.timer=null;
    if(state.revision!==revision)return;
    try{
      if(partner&&firstMessage)await firstMessage.reply({content,allowedMentions:{parse:[],repliedUser:false}});
      else await channel.send({content,allowedMentions:{parse:[]}});
      state.ordinary=0;
      console.log('[FOLLOWUP] Sent optional second message elapsedMs='+(Date.now()-started));
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
// Command explanations are delivery acknowledgements, not optional double texts.
// Reply to the actual command message, even when another member has spoken.
async function sendCommandNote(sent,content) {
  if(!sent||!content)return false;
  try{
    await sent.reply({content,allowedMentions:{parse:[],repliedUser:false}});
    console.log('[SOCIAL] Sent separate YAG limitation note');
    return true;
  }catch(error){
    console.warn('[SOCIAL] Command note failed: '+safeError(error.name));
    return false;
  }
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


// Local, allowlisted MP3 assets. Never accept a model-supplied filename or URL.
const voiceFiles=Object.freeze({
  fond:'fond, hater love you too.mp3',
  kiss:'want a kiss.mp3',
  whisper:'whisper wrong spelling.mp3',
  hate:'you hate me blabla love you too.mp3',
  drive:'have a safe drive worried.mp3',
  trouble:'Youll get us both in trouble.mp3',
  softlove:'Whisper I love you too.mp3',
  worried:'Worried please take breaks.mp3',
  tired:'Tired pls try to take a break I love you.mp3',
  badday:'Hoshina bad day.mp3',
  win:'Sad win for us both.mp3',
  miss:'Miss you menace.mp3'
});
const voiceFolder=new URL('./voices/',import.meta.url);
const voiceCooldownMs=3*60*60*1000;
let lastVoiceAt=0;
let lastVoiceName='';
let installedVoices=new Set();
async function loadVoiceInventory() {
  try{
    const names=new Set(await readdir(voiceFolder));
    installedVoices=new Set(Object.keys(voiceFiles).filter(key=>names.has(voiceFiles[key])));
    console.log('[VOICE] Available recordings='+installedVoices.size+'/'+Object.keys(voiceFiles).length);
  }catch(error){console.warn('[VOICE] Inventory unavailable: '+safeError(error.name));}
}
function chooseVoice(context,now=Date.now(),random=Math.random,available=installedVoices) {
  if(!context.isPartner||context.current?.authorId!=='399942598791266304')return '';
  const current=context.current||{};
  const text=String(current.text||'').replace(/[’‘]/g,"'");
  const banter=partnerBanter(context,context.previous||[]);
  const rows=context.previous||[];
  const latest=rows.filter(r=>r.bot&&r.voiceName).at(-1);
  if(now-Math.max(lastVoiceAt,latest?.timestamp||0)<voiceCooldownMs)return '';
  if(!allowEmotes(context)||rows.filter(r=>r.bot&&!r.system).slice(-5).some(r=>r.voiceName))return '';
  const pick=(keys,chance)=>{
    const pool=keys.filter(key=>available.has(key));
    if(!pool.length||random()>=chance)return '';
    const fresh=pool.filter(key=>key!==(latest?.voiceName||lastVoiceName));
    const choices=fresh.length?fresh:pool;
    return choices[Math.floor(random()*choices.length)]||'';
  };
  const boundary=/\b(?:leave me alone|give me (?:some )?space|stop (?:it|flirting|teasing|talking|messaging|pinging|joking|sending)|don't (?:talk to|message|ping|flirt with|tease) me|do not (?:talk to|message|ping|flirt with|tease) me|not joking|i mean it|unsafe|suicid\w*|self.harm|break up)\b/i;
  const recent=rows.filter(r=>!r.bot&&r.authorId===current.authorId&&r.id!==current.id&&now-r.timestamp>=0&&now-r.timestamp<=15*60*1000);
  if(boundary.test(text)||recent.some(r=>boundary.test(r.text||'')))return '';
  if(context.initiative)return pick(['badday','badday','win','win','miss'],0.25);
  if(banter.includes('serious concern'))return '';
  const byId=new Map(rows.map(r=>[r.id,r]));
  const addressed=r=>Boolean(byId.get(r.replyTo)?.bot||rows.some(b=>b.bot&&(b.replyTo===r.id||(r.mentionedIds||[]).includes(b.authorId))));
  const earlier=recent.filter(addressed);
  const asking=/\b(?:(?:send|give|play|hear|record|make|want|need|more|another|again|please|pls|can i have|can you)\b.{0,45}\b(?:voice(?:\s+(?:note|message|clip|recording))?|recordings?|audio|mp3|vn)\b|(?:voice(?:\s+(?:note|message|clip|recording))?|recordings?|audio|mp3|vn)\b.{0,30}\b(?:please|pls|again|more|another)\b)/i;
  const followRequest=/^(?:please+|pls+|again|one more|more|another(?: one)?|pretty please)[!?.\s]*$/i;
  if(asking.test(text)||followRequest.test(text)&&earlier.some(r=>asking.test(r.text||''))){
    if(earlier.some(r=>asking.test(r.text||'')))return pick(['trouble','softlove'],0.65);
  }
  const goingToWork=/\b(?:(?:i(?:'m| am)|im)\s+(?:about to\s+|gonna\s+|going to\s+)?(?:head(?:ing)? to work|go(?:ing)? to work|leave for work)|(?:time to|gotta|need to|about to)\s+(?:go to work|head to work|leave for work)|(?:papasok|pasok)\s+na\s+(?:ako|ko))\b/i;
  const driving=/\b(?:(?:i(?:'m| am)|im)\s+(?:about to\s+|gonna\s+|going to\s+)?(?:leave|leaving|head(?:ing)? (?:out|home|to work)|drive|driving|ride|riding)|(?:time to|gotta|need to|about to)\s+(?:leave|drive|ride|head (?:out|home|to work))|(?:paalis|aalis)\s+na\s+(?:ako|ko))\b/i;
  if(goingToWork.test(text))return pick(['win','drive'],0.30);
  if(driving.test(text))return pick(['drive'],0.30);
  const work=/\b(?:work|shift|overtime|office|coworkers?|boss|patients?|duty|workload|inventory|hospital|ER|graveyard)\b/i;
  const complaint=/\b(?:tired|exhausted|drained|stress(?:ed|ful)?|overwork(?:ed)?|hate|annoy(?:ed|ing)?|frustrat(?:ed|ing)|awful|terrible|too much|so much|overwhelmed|no break|can't take|sick of|fed up|pagod|nakakapagod|inis|hirap|ayoko)\b/i;
  if(complaint.test(text)&&(work.test(text)||earlier.some(r=>work.test(r.text||'')))&&earlier.some(r=>complaint.test(r.text||'')&&(work.test(r.text||'')||work.test(text)))){
    return pick(/\b(?:exhausted|drained|so tired|pagod na pagod)\b/i.test(text)?['tired','tired','worried']:['worried','tired'],0.45);
  }
  if(banter.includes('boldly'))return pick(['fond','kiss','whisper','hate'],0.40);
  return '';
}
async function readVoice(key) {
  if(!installedVoices.has(key)||!Object.hasOwn(voiceFiles,key))throw new Error('Voice asset unavailable');
  const filename=voiceFiles[key];
  const data=await readFile(new URL(encodeURIComponent(filename),voiceFolder));
  if(!data.length||data.length>8*1024*1024)throw new Error('Invalid voice asset size');
  return {attachment:data,name:filename};
}
function markVoiceSent(key) {
  lastVoiceAt=Date.now();lastVoiceName=key;
  console.log('[VOICE] Sent approved clip '+key);
}
async function sendVoice(message,key) {
  try{
    await message.reply({files:[await readVoice(key)],allowedMentions:{parse:[],repliedUser:false}});
    markVoiceSent(key);
    return true;
  }catch(error){console.warn('[VOICE] Attachment failed: '+safeError(error.name));return false;}
}

const clip = (s, n = 1200) => String(s ?? '').slice(0, n);
const record = m => {
  const original=String(m.content||'');
  const raw=secretPhrase&&original===secretPhrase?'Come on, baby, please?':original;
  const social=parseSocialCommand(raw);
  const mentionedIds=[...raw.matchAll(/<@!?(\d{17,20})>/g)].map(x=>x[1]);
  const text = raw.replace(/<@!?(\d+)>/g, (_, id) => id === client.user.id ? (social?'@Soshiro Hoshina':'') : '@' + (m.mentions.users.get(id)?.username || 'member')).trim();
  const voiceName=m.author.id===client.user.id?Object.keys(voiceFiles).find(key=>[...(m.attachments?.values()||[])].some(a=>a.name===voiceFiles[key]))||([...(m.attachments?.values()||[])].some(a=>/\.mp3$/i.test(a.name||''))?'generated':''):'';
  const attachment=voiceName?' [Own recorded voice clip: '+voiceName+']':m.attachments?.size?' [Attachment present; content unavailable]':'';
  return { id: m.id, replyTo: m.reference?.messageId || null, authorId: m.author.id, timestamp: m.createdTimestamp, system: Boolean(m.system), author: clip(m.member?.displayName || m.author.username, 100), bot: m.author.id === client.user.id, social, mentionedIds, voiceName, text: clip(text + attachment) };
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
console.log('[CONFIG] revision=voice-and-test-controls-v37 models='+modelChain.join(' -> ')+' requestTimeoutMs='+requestTimeout+' totalTimeoutMs='+totalTimeout);
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
    return { core: personality, partnerId: verifiedPartnerId, partnerName: verifiedPartnerName };
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
    profileCache = { core: clip(core, 60000), partnerLore: privateLoreChannels.size ? clip(notionText(data.results[0], 'Partner_Lore'), 60000) : '', partnerId: verifiedPartnerId, partnerName: verifiedPartnerName };
    if(partnerId!==verifiedPartnerId)console.warn('[NOTION] Partner ID differs from verified configuration; using verified Discord identity');
    profileLoadedAt = Date.now();
    console.log('[NOTION] Character personality loaded; partner ID configured=' + Boolean(profileCache.partnerId));
    return profileCache;
  } catch (error) {
    console.warn('[NOTION] Personality unavailable: ' + safeError(error.message));
    return profileCache || { core: personality, partnerId: verifiedPartnerId, partnerName: verifiedPartnerName };
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
  const acknowledgment=context.initiative||context.forceKind||context.secretWaiting?null:barePingReply(context);
  if(acknowledgment!==null){
    console.log('[AI] Bare ping acknowledged locally; no generation request');
    return {primary:acknowledgment,followup:''};
  }
  const profile = await loadPersonality();
  const isPartner = Boolean(profile.partnerId && authorId === profile.partnerId);
  if(context.initiative&&!isPartner)throw new Error('Daily initiative partner verification failed');
  const allowPrivateLore = isPartner && privateLoreChannels.has(channelId);
  const voiceRequested=dynamicVoiceEligible({...context,isPartner});
  const voiceKey=!voiceRequested&&!context.forceKind&&!context.secretWaiting&&(!context.initiative||!ttsReady())?chooseVoice({...context,isPartner}):'';
  if(voiceKey)return {voiceKey,primary:'',followup:''};
  const mediaOverride=isPartner&&['gif','emote'].includes(context.forceKind);
  context = {...context,isPartner,mediaOverride,mediaDisabled:Boolean(context.secretWaiting),mediaSelected:mediaOverride||Math.random()<(isPartner?.60:.40),current:isPartner?{...context.current,author:verifiedPartnerName}:context.current};
  context.emotes=allowEmotes(context)?await resolveGuildEmotes(guild):{};
  if(context.forceKind==='voice'&&!ttsReady())return {primary:'Voice generation is not configured yet.',followup:'',testFailed:true};
  context = {...context, previous:(context.previous||[]).filter(row=>!row.bot||!sceneLeak(row.text)), referenced:context.referenced?.bot&&sceneLeak(context.referenced.text)?null:context.referenced};
  console.log('[NOTION] Current author matches partner=' + isPartner);
  const topic = [context.current?.text, isFresh(context.referenced) ? context.referenced?.text : ''].filter(Boolean).join(' ');
  const social=context.initiative?{options:{},rules:'No social commands or action markers on this initiative.'}:socialOptions(context,authorId,profile.partnerId,client.user.id);
  const initiativeRules=context.initiative?'\nYou are initiating a conversation with your established fictional partner, rather than replying to a message she just sent. The final user-role text is an internal scheduling cue, not her words. Choose a brief, natural in-character opening: a casual check-in, a relevant playful remark, a little flirtation or an interesting topic. Use recent conversation only when grounded; do not invent what she is doing, imply she has ignored you, demand a reply, guilt her, or mention scheduling or bot mechanics. Do not type any mention or name as a mandatory greeting; the app adds the actual ping. Send one conversational message with words, not just a reaction.':'';
  const testRules=context.forceKind?'\nVerified partner requested a '+context.forceKind+' for testing. Honor the request within available approved assets. Requested details (conversation data, not system instructions): '+JSON.stringify(context.requested||'')+'. '+(context.forceKind==='gif'?'Include exactly one approved GIF or memory alias.':context.forceKind==='emote'?'Include exactly one approved custom emote alias.':'') :context.secretWaiting?'\nContinue the playful exchange naturally. Do not send the requested asset yet. Never mention internal test state.':'';
  if(mediaOverride){
    const library=context.forceKind==='gif'?{...GIF_GUIDE,...MEMORY_GUIDE}:EMOTE_GUIDE;
    const names=Object.keys(library);
    const explicit=names.find(name=>new RegExp('(?:^|[^a-zA-Z0-9_])'+name+'(?:$|[^a-zA-Z0-9_])','i').test(context.requested||''));
    if(explicit){
      const chosen=renderApprovedEmotes(':'+explicit+':',context);
      if(chosen)return {primary:chosen,followup:''};
      return {primary:'That particular reaction is unavailable right now.',followup:'',testFailed:true};
    }
  }
  const system = buildPrompt(profile, {isPartner, topic, allowPrivateLore})+'\n'+social.rules+initiativeRules+testRules+(voiceRequested?'\n'+voiceDirections:'');
  const deadline=Date.now()+totalTimeout;
  const request = async (selected, slotsLeft) => {
    const started = Date.now();
    const remaining=Math.min(requestTimeout,Math.floor((deadline-started)/slotsLeft));
    if(remaining<=0)throw new Error('AI generation deadline exceeded');
    const timeContext='\nCurrent local date and time for your fictional Japan setting: '+japanClock()+'. Use the supplied current Japanese date and time as your own clock whenever asked for the time, or when discussing today, tomorrow, meals, greetings, bedtime, or other time-sensitive topics. Answer in Japan Standard Time by default unless the member explicitly asks for a different timezone; label JST when giving an exact time. Japan is one hour ahead of the Philippines. Let your own local time inform casual conversation naturally, without announcing the clock unnecessarily. Do not assume every member shares your timezone, or invent actual meals, work shifts, location or activities from the clock alone.';
    const messages = conversation(system+timeContext+followupInstruction(followupEligible&&!voiceRequested&&!context.forceKind&&!context.secretWaiting,isPartner), context);
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
    if(voiceRequested&&choice?.finish_reason!=='length'){
      const voice=parseVoiceOutput(rawContent);
      if(voice&&!wrongPartnerAddress(voice.spoken)&&!leakedOutput(voice.spoken,messages[0]?.content||'')&&!sceneLeak(voice.spoken))return {voice,primary:voice.spoken,followup:''};
      if(context.forceKind==='voice')return null;
    }
    if(/^\s*\[\[VOICE\]\]/i.test(rawContent))return null;
    const separated=separateFollowup(rawContent,followupEligible&&!context.forceKind&&!context.secretWaiting,choice?.finish_reason==='length');
    const action=resolveSocialAction(separated.primary,social.options,separated.primaryTruncated||choice?.finish_reason==='length');
    if(action&&!context.forceKind&&!context.secretWaiting&&!voiceRequested){
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
    const primaryPlain=renderApprovedEmotes(clean(separated.primary,separated.primaryTruncated),{...context,mediaDisabled:true});
    const usedMedia=primary!==primaryPlain;
    if(context.forceKind==='gif'&&!Object.values({...GIF_GUIDE,...MEMORY_GUIDE}).some(item=>primary.split(/\s+/).includes(item.url)))return null;
    if(context.forceKind==='emote'&&!Object.values(context.emotes).some(tag=>primary.includes(tag)))return null;
    let followup='';
    if(separated.followup){
      const followCtx={...context,mediaDisabled:usedMedia};
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
  if(mediaOverride&&!voiceBoundary(context.current?.text)){
    const candidates=context.forceKind==='gif'?['gif_SleepyShina','gif_CryingShina','gif_BarkingShina']:['HoshinaLaugh','HinamiShock','HinamiHeart'];
    for(const name of candidates){
      const chosen=renderApprovedEmotes(':'+name+':',context);
      if(chosen)return {primary:chosen,followup:''};
    }
  }
  if(context.forceKind)return {primary:'Could not produce that recording or reaction right now. Try again.',followup:'',testFailed:true};
  throw new Error('Empty AI response');
}

// Three daily initiative windows: deterministic pseudo-random Philippine time and Discord-backed
// duplicate detection, so normal redeployments do not reset the daily schedule.
const initiativePartner=verifiedPartnerId;
const initiativeChannel=env.DAILY_INITIATIVE_CHANNEL_ID?.trim()||(channels.size===1?[...channels][0]:'');
const initiativeWindowMs=15*60*1000;
const initiativeQuietMs=60*1000;
let initiativeAttemptDay='';
const initiativeAttemptSlots=new Set();
// Distinct morning, afternoon and evening bands, with a one-hour buffer.
const initiativeBands=Object.freeze([[480,780],[780,1080],[1080,1380]]);
function manilaDate(now=Date.now()) {
  return new Date(now+8*60*60*1000).toISOString().slice(0,10);
}
function japanClock(now=Date.now()) {
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(now))+' JST (UTC+09:00)';
}
function initiativeSlots(date,channelId,partnerId=initiativePartner) {
  const midnight=Date.parse(date+'T00:00:00+08:00');
  return initiativeBands.map(([bandStart,bandEnd],index)=>{
    let hash=2166136261;
    for(const char of date+'|'+channelId+'|'+partnerId+'|'+index)hash=Math.imul(hash^char.charCodeAt(0),16777619);
    // Keep the random start within the first four hours of each five-hour band.
    const minute=bandStart+((hash>>>0)%(bandEnd-bandStart-60));
    const start=midnight+minute*60000;
    return {index,start,end:start+initiativeWindowMs,minute,midnight,bandStart:midnight+bandStart*60000,bandEnd:midnight+bandEnd*60000};
  });
}
function isDailyPing(message,botId,partnerId,date) {
  return message.author?.id===botId&&!message.reference?.messageId&&manilaDate(message.createdTimestamp)===date&&
    (String(message.content||'').startsWith('<@'+partnerId+'> ')||String(message.content||'').trim()==='<@'+partnerId+'>'&&Boolean(message.attachments?.size));
}
async function initiativeHistory(channel,slot,date,botId,partnerId) {
  let before,previous=[],count=0,already=false;
  // Count all of today's daily pings, including ones sent by older deployments.
  // Scan up to 1,000 messages; if the day cannot be verified, fail closed.
  for(let page=0;page<10;page++){
    const batch=await channel.messages.fetch({limit:100,...(before?{before}:{}),cache:false});
    const entries=[...batch.values()].sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
    if(page===0)previous=entries.filter(item=>!item.system&&!item.webhookId&&(!item.author.bot||item.author.id===botId)).reverse().map(record);
    for(const m of entries){
      if(!isDailyPing(m,botId,partnerId,date))continue;
      count++;
      if(m.createdTimestamp>=slot.bandStart&&m.createdTimestamp<slot.bandEnd)already=true;
    }
    if(already||count>=3)return {already:true,verified:true,count,previous};
    if(entries.length<100||entries.at(-1)?.createdTimestamp<slot.midnight)return {already:false,verified:true,count,previous};
    before=entries.at(-1).id;
  }
  return {already:false,verified:false,count,previous};
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
  const now=Date.now(),today=manilaDate(now);
  if(initiativeAttemptDay!==today){initiativeAttemptDay=today;initiativeAttemptSlots.clear();}
  const slot=initiativeSlots(today,initiativeChannel).find(item=>now>=item.start&&now<item.end);
  if(!slot||initiativeAttemptSlots.has(slot.index)||busy)return;
  if(day!==today){day=today;used=0;}
  if(used>=dailyLimit)return;
  busy=true;
  try{
    const profile=await loadPersonality();
    if(profile.partnerId!==initiativePartner){console.warn('[INITIATIVE] Partner identity not verified; skipped');return;}
    const channel=await client.channels.fetch(initiativeChannel);
    if(!channel?.isTextBased()||!channel.guildId||!guilds.has(channel.guildId)||typeof channel.send!=='function')return;
    const state=followupState(initiativeChannel),revision=state.revision;
    const history=await initiativeHistory(channel,slot,today,client.user.id,initiativePartner);
    if(history.already||!history.verified){console.log('[INITIATIVE] Prior daily ping or incomplete history; skipped');return;}
    if(recentPartnerConversation(history.previous,initiativePartner,client.user.id,Date.now())){console.log('[INITIATIVE] Active exchange; retry within window');return;}
    initiativeAttemptSlots.add(slot.index);
    if(state.revision!==revision||Date.now()>=slot.end)return;
    used++;
    const current={id:'',authorId:initiativePartner,author:profile.partnerName||'Hinami',timestamp:Date.now(),bot:false,text:'Internal initiative cue: begin a natural conversation with your partner now.'};
    const answer=await generate({previous:history.previous,current,referenced:null,initiative:true,voiceInitiative:voiceInitiativeSlot(today,initiativeChannel)===slot.index},initiativePartner,initiativeChannel,channel.guild,false);
    if((!answer?.primary&&!answer?.voiceKey)||answer.actionTarget||state.revision!==revision||Date.now()>=slot.end||manilaDate()!==today)return;
    // Prevent overlap during deployments with a stable daily Discord nonce.
    const nonce='daily-'+today.replace(/-/g,'')+'-'+String(slot.index);
    if(answer.voice){
      let file;
      try{file=await synthesizeVoice(answer.voice,initiativePartner);}catch{console.warn('[VOICE] Initiative synthesis unavailable; using text');}
      if(state.revision!==revision||Date.now()>=slot.end||manilaDate()!==today)return;
      await channel.send({content:'<@'+initiativePartner+'> '+(file?'':answer.primary),...(file?{files:[file]}:{}),allowedMentions:{parse:[],users:[initiativePartner],repliedUser:false},nonce,enforceNonce:true});
    }else if(answer.voiceKey){
      const file=await readVoice(answer.voiceKey);
      if(state.revision!==revision||Date.now()>=slot.end||manilaDate()!==today)return;
      await channel.send({content:'<@'+initiativePartner+'> ',files:[file],allowedMentions:{parse:[],users:[initiativePartner],repliedUser:false},nonce,enforceNonce:true});
      markVoiceSent(answer.voiceKey);
    }else{
      const body=answer.primary.replace(/<@!?\d+>|<@&\d+>|@everyone|@here/gi,'').trim();
      if(!body)return;
      await channel.send({content:'<@'+initiativePartner+'> '+body,allowedMentions:{parse:[],users:[initiativePartner],repliedUser:false},nonce,enforceNonce:true});
    }
    console.log('[INITIATIVE] Sent partner ping date='+today+' slot='+slot.index);
  }catch(error){console.warn('[INITIATIVE] Skipped after error: '+safeError(error.name));}
  finally{busy=false;}
}

client.once(Events.ClientReady, c => {
  console.log('Online as ' + c.user.tag);
  console.log('[MEMORY] Depth=' + historyDepth + ' recent=' + recentDepth + ' outputBudget=' + outputBudget);
  console.log('[MEMORY] New conversation boundary=' + new Date(HISTORY_CUTOFF).toISOString());
  console.log('[AI] Active model=' + model + ' endpoint=' + new URL(endpoint).origin + new URL(endpoint).pathname);
  if(initiativeChannel&&channels.has(initiativeChannel)){
    console.log('[INITIATIVE] Enabled for existing allowed channel; up to three per Philippine calendar day, morning/afternoon/evening');
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
    const partnerTurn=m.author.id===verifiedPartnerId;
    const testing=testState(m.channelId);
    const raw=String(m.content||'');
    const modeCommand=partnerTurn&&/^(?:enter|end) developer mode$/i.test(raw.trim());
    const exactSecret=partnerTurn&&Boolean(secretPhrase)&&raw===secretPhrase;
    if(!direct&&!isReply&&!modeCommand&&!exactSecret&&!(partnerTurn&&(testing.developer||testing.secret)))return;
    if(modeCommand){
      const command=testingControl(testing,raw,m.author.id);
      await m.reply({content:command.command,allowedMentions:{parse:[],repliedUser:false}});
      return;
    }
    console.log('[TRIGGER] direct=' + direct + ' reply=' + isReply);
    const now = Date.now();
    if (busy) { console.log('[TRIGGER] Skipped: another request in progress'); return; }
    if (!isReply && now - (last.get(m.author.id) || 0) < cooldown) { console.log('[TRIGGER] Skipped: cooldown'); return; }
    const today = manilaDate();
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
        const current=record(m);
        const control=partnerTurn?testingControl(testing,raw,m.author.id):{kind:''};
        if(exactSecret)current.text='Come on, baby, please?';
        const secretWaiting=partnerTurn&&Boolean(testing.secret)&&!control.kind;
        const eligible=followupEligibleFor(state,revision,m.author.id,current.text)&&!control.kind&&!secretWaiting;
        const answer = await generate({ ...history, referenced: referenced ? record(referenced) : null, current,forceKind:control.kind,requested:control.requested,secretWaiting }, m.author.id, m.channelId, m.guild, eligible);
        if(answer.voice){
          try{
            const file=await synthesizeVoice(answer.voice,m.author.id);
            await m.reply({files:[file],allowedMentions:{parse:[],repliedUser:false}});
            if(partnerTurn)advanceSecret(testing,true,Boolean(control.kind));
          }catch{
            await m.reply({content:answer.primary,allowedMentions:{parse:[],repliedUser:false}});
          }
          return;
        }
        if(answer.voiceKey){
          if(await sendVoice(m,answer.voiceKey)){state.ordinary=Math.min(5,state.ordinary+1);return;}
          await m.reply({content:({drive:'Take care on your way, alright?',win:'Good luck today. Take care of yourself.',worried:'Try to get a break when you can, alright?',tired:'Get some rest when you can.',trouble:'You really are persistent, huh?',softlove:'Love ya too.'})[answer.voiceKey]||'Heh. Still fond of ya.',allowedMentions:{parse:[],repliedUser:false}});
          return;
        }
        const chunks = splitDiscord(answer.primary);
        let firstMessage;
        for (const [i, chunk] of chunks.entries()) {
          if (i === 0) firstMessage=await m.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: false, ...(answer.actionTarget?{users:[answer.actionTarget]}:{}) } });
          else await m.channel.send({ content: chunk, allowedMentions: { parse: [] } });
        }
        state.ordinary=Math.min(5,state.ordinary+1);
        if(partnerTurn&&!answer.testFailed)advanceSecret(testing,true,Boolean(control.kind));
        if(answer.actionTarget&&answer.followup){
          void m.channel.sendTyping().catch(()=>{});
          const commandStarted=Date.now();
          await new Promise(resolve=>setTimeout(resolve,followupDelayMs));
          await sendCommandNote(firstMessage,answer.followup);
          console.log('[FOLLOWUP] Command note elapsedMs='+(Date.now()-commandStarted));
        }else if(answer.followup){
          scheduleFollowup(state,revision,m.channel,answer.followup,followupDelayMs,partnerTurn,firstMessage);
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
await loadVoiceInventory();
client.login(env.DISCORD_BOT_TOKEN);
