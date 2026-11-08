// Custom Alexa skill endpoint ("North Pole"): POST /alexa/skill.
// Every request is verified the way Amazon requires (cert chain URL, cert chain, RSA-SHA256 signature,
// 150 s timestamp window, applicationId) before any intent runs. No dependencies, Node 18+.
// XM_SKILL_INSECURE=1 skips cert/signature/timestamp checks for local tests only.
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- vocab tables (also feed skill/build-model.mjs)
export const COLORS = [
  { name: 'red', hex: '#ff1010', syn: ['christmas red', 'bright red', 'candy red'] },
  { name: 'green', hex: '#00d040', syn: ['christmas green', 'bright green'] },
  { name: 'blue', hex: '#1030ff', syn: ['royal blue', 'bright blue'] },
  { name: 'white', hex: '#ffffff', syn: ['snow white', 'bright white'] },
  { name: 'warm white', hex: '#ffb46b', syn: ['soft white', 'cozy white', 'yellow white'] },
  { name: 'cool white', hex: '#c8dcff', syn: ['daylight', 'cold white', 'blue white'] },
  { name: 'gold', hex: '#ffb800', syn: ['golden', 'christmas gold'] },
  { name: 'yellow', hex: '#ffe600', syn: ['sunny yellow'] },
  { name: 'orange', hex: '#ff6a00', syn: ['tangerine'] },
  { name: 'pink', hex: '#ff6eb4', syn: ['light pink', 'bubblegum'] },
  { name: 'hot pink', hex: '#ff1493', syn: ['deep pink', 'fuchsia'] },
  { name: 'purple', hex: '#8000ff', syn: ['royal purple', 'grape'] },
  { name: 'violet', hex: '#b040ff', syn: ['lavender', 'lilac'] },
  { name: 'teal', hex: '#00b3a4', syn: ['turquoise', 'aqua'] },
  { name: 'cyan', hex: '#00e5ff', syn: ['sky blue', 'light blue'] },
  { name: 'magenta', hex: '#ff00cc', syn: ['bright pink'] },
  { name: 'lime', hex: '#9cff00', syn: ['lime green', 'chartreuse'] },
  { name: 'emerald', hex: '#00a86b', syn: ['forest green', 'dark green', 'pine green'] },
  { name: 'ice blue', hex: '#9fe3ff', syn: ['icy blue', 'frost blue', 'baby blue'] },
  { name: 'navy', hex: '#0010a0', syn: ['dark blue', 'midnight blue'] },
  { name: 'amber', hex: '#ff8c00', syn: ['candle', 'candlelight'] },
  { name: 'silver', hex: '#d0d8e0', syn: ['grey', 'gray', 'metallic'] },
  { name: 'crimson', hex: '#dc143c', syn: ['scarlet', 'cherry red'] },
  { name: 'mint', hex: '#98ffcc', syn: ['mint green', 'peppermint green'] },
  { name: 'burgundy', hex: '#8b0a2a', syn: ['wine', 'maroon', 'dark red'] },
];

export const EFFECTS = [
  { id: 'classic', name: 'classic', syn: ['classic christmas', 'traditional', 'christmas lights', 'normal'] },
  { id: 'retro', name: 'retro', syn: ['vintage', 'old school', 'big bulbs'] },
  { id: 'twinkle', name: 'twinkle', syn: ['twinkling', 'sparkle', 'sparkling'] },
  { id: 'candy-cane', name: 'candy cane', syn: ['candy canes', 'stripes', 'striped'] },
  { id: 'snowfall', name: 'snowfall', syn: ['snow', 'snowing', 'snowflakes', 'falling snow'] },
  { id: 'fireplace', name: 'fireplace', syn: ['fire', 'cozy fire', 'crackling fire'] },
  { id: 'aurora', name: 'aurora', syn: ['northern lights', 'aurora borealis'] },
  { id: 'peppermint', name: 'peppermint', syn: ['peppermint swirl', 'mint swirl'] },
  { id: 'rainbow', name: 'rainbow', syn: ['colorful', 'all colors', 'multicolor'] },
  { id: 'starlight', name: 'starlight', syn: ['stars', 'starry', 'starry night'] },
  { id: 'gingerbread', name: 'gingerbread', syn: ['ginger bread', 'cookie', 'cookies'] },
  { id: 'frost', name: 'frost', syn: ['frosty', 'icy', 'ice'] },
  { id: 'chase', name: 'chase', syn: ['chasing', 'racing', 'running lights'] },
  { id: 'ornaments', name: 'ornaments', syn: ['ornament', 'baubles', 'bauble'] },
  { id: 'comet', name: 'comet', syn: ['shooting star', 'shooting stars', 'comets'] },
  { id: 'breathe', name: 'breathe', syn: ['breathing', 'pulse', 'pulsing', 'fade'] },
  { id: 'solid', name: 'solid', syn: ['steady', 'plain', 'solid color'] },
];

export const SONGS = [
  'Jingle Bells', 'We Wish You a Merry Christmas', 'Deck the Halls', 'Up on the Housetop', 'Jolly Old Saint Nicholas',
  'Joy to the World', 'Silent Night', 'O Christmas Tree', 'God Rest Ye Merry Gentlemen', 'Hark the Herald Angels Sing',
  'Carol of the Bells', 'Dance of the Sugar Plum Fairy', 'Russian Dance', 'The First Noel', 'Angels We Have Heard on High',
  'Good King Wenceslas', 'O Come All Ye Faithful', 'Away in a Manger', 'Here We Come A-wassailing', 'It Came Upon the Midnight Clear',
];
export const SONG_SYNONYMS = {
  'We Wish You a Merry Christmas': ['wish you a merry christmas'],
  'Jolly Old Saint Nicholas': ['jolly old st nick', 'jolly old saint nick'],
  'Carol of the Bells': ['ukrainian bell carol'],
  'Dance of the Sugar Plum Fairy': ['sugar plum fairy'],
  'Russian Dance': ['trepak'],
  'The First Noel': ['first noel', 'first nowell'],
  'Here We Come A-wassailing': ['here we come a wassailing', 'wassailing'],
  'God Rest Ye Merry Gentlemen': ['god rest ye merry gentleman'],
};
export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const GAMES = [
  { id: 'trivia', name: 'trivia', label: 'Christmas trivia', syn: ['christmas trivia', 'quiz', 'trivia game'] },
  { id: 'name-that-song', name: 'name that song', label: 'Name That Song', syn: ['guess the song', 'song game', 'name that tune'] },
  { id: 'would-you-rather', name: 'would you rather', label: 'Would You Rather', syn: ['would you rather game'] },
  { id: 'pictionary', name: 'pictionary', label: 'Pictionary', syn: ['drawing game', 'draw and guess'] },
];

export const CHANNELS = [
  { id: 'christmas', name: 'christmas', syn: ['christmas radio', 'classic christmas', 'holiday'] },
  { id: 'xmasrocks', name: 'christmas rocks', syn: ['xmas rocks', 'rock', 'rocking christmas'] },
  { id: 'jollysoul', name: 'jolly soul', syn: ['soul', 'christmas soul'] },
  { id: 'deptstore', name: 'department store', syn: ['dept store', 'mall', 'department store christmas'] },
  { id: 'xmasinfrisko', name: 'christmas in frisko', syn: ['frisko', 'christmas in san francisco', 'xmas in frisko'] },
];

export const TV_SCENES = [
  { id: 'home', name: 'home', say: 'the home screen', syn: ['home screen', 'main screen', 'the tree screen', 'start screen'] },
  { id: 'countdown', name: 'countdown', say: 'the countdown', syn: ['the countdown', 'christmas countdown', 'clock'] },
  { id: 'santa', name: 'santa tracker', say: 'the Santa tracker', syn: ['santa', 'the santa tracker', 'tracker', 'santa map', 'the globe'] },
  { id: 'yule', name: 'yule log', say: 'the yule log', syn: ['fire', 'fireplace', 'the fire', 'the fireplace'] },
  { id: 'nicelist', name: 'nice list', say: 'the Nice List', syn: ['the nice list', 'nice list wall', 'photos', 'the photos'] },
  { id: 'advent', name: 'advent calendar', say: "today's advent door", syn: ['advent', 'advent door', 'calendar'] },
  { id: 'tree', name: 'tree', say: 'the tree', syn: ['the tree', 'tree mirror', 'lights'] },
];
export const INTENTS = [
  'TellJokeIntent', 'CountdownIntent', 'SantaIntent', 'TreeColorIntent', 'TreeEffectIntent', 'TreeOnIntent', 'TreeOffIntent',
  'LightShowIntent', 'StopShowIntent', 'StartGameIntent', 'AdventIntent', 'ElfNameIntent', 'PartyIntent', 'GoodnightIntent',
  'YuleLogIntent', 'RadioIntent', 'AskSantaIntent', 'ReportCardIntent', 'StoryIntent', 'BuildGameIntent', 'TvOnIntent', 'TvOffIntent', 'TvSceneIntent',
];
export const BUILTIN_INTENTS = ['AMAZON.HelpIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.FallbackIntent'];

// ---------------------------------------------------------------- request verification pieces
export function verifyCertUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'cert url is not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'cert url must be https' };
  if (u.hostname.toLowerCase() !== 's3.amazonaws.com') return { ok: false, reason: 'cert url host must be s3.amazonaws.com' };
  if (!u.pathname.startsWith('/echo.api/')) return { ok: false, reason: 'cert url path must start with /echo.api/' };
  if (u.port && u.port !== '443') return { ok: false, reason: 'cert url port must be 443' };
  if (u.username || u.password) return { ok: false, reason: 'cert url must not contain credentials' };
  return { ok: true };
}

export function verifyTimestamp(ts, now = Date.now(), toleranceMs = 150000) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: 'missing or invalid timestamp' };
  if (Math.abs(now - t) > toleranceMs) return { ok: false, reason: 'timestamp outside 150 second window' };
  return { ok: true };
}

export function getApplicationId(envelope) {
  return envelope?.session?.application?.applicationId || envelope?.context?.System?.application?.applicationId || null;
}

// Pins the first applicationId seen when none is configured (trust on first use; the signature is still checked).
export function checkApplicationId(app, id) {
  if (!id) return { ok: false, reason: 'no applicationId in request' };
  const cfg = (app.config.alexaSkill ||= {});
  if (!cfg.appId) {
    cfg.appId = id;
    try { app.saveConfig?.(); } catch {}
    app.log?.('[alexa] pinned skill applicationId', id);
    return { ok: true, learned: true };
  }
  return cfg.appId === id ? { ok: true } : { ok: false, reason: 'applicationId mismatch' };
}

export function splitPem(text) {
  return String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
}

let rootCache = null;
function defaultAnchors() {
  if (!rootCache) rootCache = tls.rootCertificates.map((p) => { try { return new crypto.X509Certificate(p); } catch { return null; } }).filter(Boolean);
  return rootCache;
}

// Verifies the chain: dates, SAN, each cert signed by the next, top cert anchored in Node's trust store.
// opts.anchors: array of PEM/X509Certificate; null skips anchoring. opts.san: null skips the SAN check.
export function verifyCertChain(pems, { now = Date.now(), san = 'echo-api.amazon.com', anchors } = {}) {
  let certs;
  try { certs = pems.map((p) => (p instanceof crypto.X509Certificate ? p : new crypto.X509Certificate(p))); }
  catch { return { ok: false, reason: 'unparseable certificate' }; }
  if (!certs.length) return { ok: false, reason: 'empty certificate chain' };
  for (const c of certs) {
    if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return { ok: false, reason: 'certificate outside validity dates' };
  }
  const leaf = certs[0];
  if (san) {
    const names = String(leaf.subjectAltName || '').split(',').map((s) => s.trim().toLowerCase());
    if (!names.includes(`dns:${san}`)) return { ok: false, reason: `leaf certificate SAN lacks ${san}` };
  }
  for (let i = 0; i + 1 < certs.length; i++) {
    let signed = false;
    try { signed = certs[i].checkIssued(certs[i + 1]) && certs[i].verify(certs[i + 1].publicKey); } catch {}
    if (!signed) return { ok: false, reason: `certificate ${i} is not signed by certificate ${i + 1}` };
  }
  if (anchors !== null && !process.env.XM_SKILL_NO_ANCHOR) {
    const roots = (anchors || defaultAnchors()).map((a) => (a instanceof crypto.X509Certificate ? a : new crypto.X509Certificate(a)));
    const top = certs[certs.length - 1];
    const ok = roots.some((r) => {
      if (r.fingerprint256 === top.fingerprint256) return true;
      try { return top.checkIssued(r) && top.verify(r.publicKey); } catch { return false; }
    });
    if (!ok) return { ok: false, reason: 'certificate chain does not end at a trusted root' };
  }
  return { ok: true, leafKey: leaf.publicKey };
}

export function verifySignature(leafKey, signatureB64, rawBody) {
  try {
    if (!signatureB64) return false;
    return crypto.createVerify('RSA-SHA256').update(rawBody).verify(leafKey, String(signatureB64), 'base64');
  } catch { return false; }
}

const chainCache = new Map();
export function fetchCertChain(url) {
  const hit = chainCache.get(url);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.pems);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('cert download status ' + res.statusCode)); }
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 65536) { req.destroy(new Error('cert chain too large')); } else parts.push(c); });
      res.on('end', () => {
        const pems = splitPem(Buffer.concat(parts).toString('utf8'));
        if (!pems.length) return reject(new Error('no certificates in download'));
        let expires = Date.now() + 3600e3;
        try { expires = Math.min(expires, ...pems.map((p) => Date.parse(new crypto.X509Certificate(p).validTo))); } catch {}
        chainCache.set(url, { pems, expires });
        resolve(pems);
      });
    });
    req.on('timeout', () => req.destroy(new Error('cert download timeout')));
    req.on('error', reject);
  });
}

// Full check of one HTTP request. Returns {ok:true, envelope} or {ok:false, status, reason}.
export async function verifyRequest(app, headers, rawBody, opts = {}) {
  const now = opts.now ?? Date.now();
  const insecure = opts.insecure ?? process.env.XM_SKILL_INSECURE === '1';
  const bad = (reason, status = 400) => ({ ok: false, status, reason });
  if (!insecure) {
    const url = headers['signaturecertchainurl'];
    const cu = verifyCertUrl(url);
    if (!cu.ok) return bad(cu.reason);
    let chain;
    try { chain = await (opts.fetchChain || fetchCertChain)(url); } catch (e) { return bad('cert download failed: ' + e.message); }
    const cv = (opts.verifyChain || verifyCertChain)(chain, { now });
    if (!cv.ok) return bad(cv.reason);
    if (!verifySignature(cv.leafKey, headers['signature-256'], rawBody)) return bad('signature mismatch');
  }
  let envelope;
  try { envelope = JSON.parse(rawBody.toString('utf8')); } catch { return bad('body is not JSON'); }
  if (!insecure) {
    const tv = verifyTimestamp(envelope?.request?.timestamp, now);
    if (!tv.ok) return bad(tv.reason);
  }
  const ap = checkApplicationId(opts.app || app, getApplicationId(envelope));
  if (!ap.ok) return bad(ap.reason, 403);
  return { ok: true, envelope };
}

// ---------------------------------------------------------------- slots
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an|my|lights?|mode|effect)\b/g, ' ').replace(/\s+/g, ' ').trim();

function resolveSlot(slot, table, keyOf) {
  if (!slot) return null;
  const auth = slot.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === 'ER_SUCCESS_MATCH');
  const rv = auth?.values?.[0]?.value;
  if (rv) {
    const hit = table.find((t) => keyOf(t) === rv.id || t.name === rv.name);
    if (hit) return hit;
  }
  const spoken = norm(slot.value);
  if (!spoken) return null;
  return table.find((t) => norm(t.name) === spoken || (t.syn || []).some((s) => norm(s) === spoken))
    || table.find((t) => spoken.includes(norm(t.name)) || (t.syn || []).some((s) => spoken.includes(norm(s))))
    || null;
}

// ---------------------------------------------------------------- speech
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BRK = (t = '2s') => `<break time="${t}"/>`;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function reply(inner, { end = true, reprompt } = {}) {
  const r = { outputSpeech: { type: 'SSML', ssml: `<speak>${inner}</speak>` }, shouldEndSession: end };
  if (reprompt) r.reprompt = { outputSpeech: { type: 'SSML', ssml: `<speak>${reprompt}</speak>` } };
  return { version: '1.0', sessionAttributes: {}, response: r };
}

const HELP = 'You can say, dear Santa, then any question. Ask for a report card for someone, or say, tell us a story. Say, turn on the TV, or show the Santa tracker on the TV. '
  + 'You can also ask me to tell a joke, count the sleeps until Christmas, or find Santa. '
  + 'Tell the tree to change color, switch effects, or start a light show. Say, make us a game about, then any idea, and the elves will build it. I can also play a game, open the advent calendar, give you an elf name, or light the yule log. '
  + 'What would you like?';

// AI answers must come back inside Alexa's ~8 s window; if the elves are slow, say so and let the TV show it.
async function withinAlexaTime(promise, ms = 6500) {
  let t;
  const slow = new Promise(res => { t = setTimeout(() => res({ slow: true }), ms); });
  const r = await Promise.race([promise.then(v => ({ v }), e => ({ e })), slow]);
  clearTimeout(t);
  return r;
}
const plain = (s) => esc(String(s || '').replace(/\[\[|\]\]/g, ''));

const HANDLERS = {
  async AskSantaIntent({ app, slots }) {
    const q = slots.question?.value;
    if (!q) return reply('What would you like to ask Santa? Say, dear Santa, then your question.', { end: false, reprompt: 'Say, dear Santa, then your question.' });
    const r = await withinAlexaTime(app.act('ai.askSanta', { question: q, read: false }));
    if (r.slow) return reply("Santa is writing his answer. Look at the TV!");
    if (r.e) return reply(esc(r.e.message || "Santa's mailbox is jammed. Try again in a minute."));
    const ans = plain(r.v.answer);
    return reply(/^\W*ho,? ho/i.test(ans) ? ans : `Ho ho ho! ${ans}`);
  },
  async ReportCardIntent({ app, slots }) {
    const name = slots.name?.value;
    if (!name) return reply('Whose report card should the elves write?', { end: false, reprompt: 'Say, a report card for, then a name.' });
    const r = await withinAlexaTime(app.act('ai.reportCard', { name: name.charAt(0).toUpperCase() + name.slice(1), read: false }));
    if (r.slow) return reply(`The elves are grading ${esc(name)} right now. Look at the TV!`);
    if (r.e) return reply(esc(r.e.message || 'The elves lost their red pens. Try again.'));
    const c = r.v.card;
    return reply(`Here is ${esc(name)}'s elf report card. ${plain(c.title)}. ${BRK('400ms')} ${(c.grades || []).slice(0, 2).map(g => `${plain(g.subject)}: ${plain(g.grade)}.`).join(' ')} ${BRK('400ms')} Santa says: ${plain(c.santaNote)} The whole card is on the TV.`);
  },
  async StoryIntent({ app }) {
    const r = await withinAlexaTime(app.act('ai.story', { read: false }), 6800);
    if (r.slow) return reply('The elves are writing a story. It will be on the TV in a moment!');
    if (r.e) return reply(esc(r.e.message || 'The elves ran out of ink. Try again.'));
    return reply(`${plain(r.v.title)}. ${BRK('500ms')} ${plain(r.v.story)}`);
  },
  // The elves build the game in the background; Alexa only has to say it started (the TV shows the rest)
  async BuildGameIntent({ app, slots }) {
    const request = slots.request?.value;
    if (!request) return reply('What game should the elves make? Say, make us a game about, then your idea.', { end: false, reprompt: 'Say, make us a game about, then your idea.' });
    const r = await withinAlexaTime(Promise.resolve().then(() => app.act('workshop.build', { request, by: 'Alexa' })), 4000);
    if (r.e) return reply(esc(r.e.message || 'The elves cannot start that right now.'));
    return reply('The elves are building it now. Look at the TV!');
  },
  async TvOnIntent({ app }) {
    const r = await app.act('tv.power', { on: true });
    return reply(r.ok ? 'Turning on the TV and switching to the North Pole.' : esc(r.note || "I couldn't reach the TV."));
  },
  async TvOffIntent({ app }) {
    const r = await app.act('tv.power', { on: false });
    return reply(r.ok ? 'TV off. The tree keeps glowing.' : esc(r.note || "I couldn't reach the TV."));
  },
  async TvSceneIntent({ app, slots }) {
    const sc = resolveSlot(slots.scene, TV_SCENES, (t) => t.id) || TV_SCENES[0];
    await app.act('tv.scene', { scene: sc.id });
    return reply(`Putting ${esc(sc.say)} on the TV.`);
  },
  async TellJokeIntent({ app }) {
    const j = await app.act('joke.random', {});
    return reply(`${esc(j.q)} ${BRK('2s')} ${esc(j.a)} ${BRK('500ms')} ${pick(['Ho ho ho!', 'The elves are rolling on the floor!', 'Santa would be proud.'])}`);
  },
  async CountdownIntent({ app }) {
    const c = await app.act('countdown', {});
    if (c.isChristmas) return reply('Merry Christmas! Ho ho ho! The magic is happening right now.');
    if (c.isEve) return reply(`It's Christmas Eve! Only ${esc(c.hours)} hours to go. Santa is warming up the sleigh.`);
    return reply(`Only ${esc(c.days)} ${c.days === 1 ? 'sleep' : 'sleeps'} until Christmas! That's ${esc(c.days)} days and ${esc(c.hours)} hours. The elves are working hard.`);
  },
  async SantaIntent({ app }) {
    const s = await app.act('santa.status', {});
    if (!s.active) return reply(esc(s.message || "Santa is at the North Pole, checking his list twice. Keep those stockings ready!"));
    const gifts = s.giftsDelivered != null ? ` He has delivered <say-as interpret-as="cardinal">${esc(s.giftsDelivered)}</say-as> gifts so far.` : '';
    const next = s.nextCity ? ` Next stop, ${esc(s.nextCity)}.` : '';
    return reply(`Santa is over ${esc(s.city)}${s.country ? ', ' + esc(s.country) : ''} right now!${next}${gifts} Ho ho ho!`);
  },
  async TreeColorIntent({ app, slots }) {
    const c = resolveSlot(slots.color, COLORS, (t) => t.name);
    if (!c) return reply("I'm not sure which color that is. Try red, green, gold, or ice blue.");
    await app.act('lights.set', { power: true, effect: 'solid', color: c.hex });
    return reply(`Done! The tree is glowing ${esc(c.name)}.`);
  },
  async TreeEffectIntent({ app, slots }) {
    const e = resolveSlot(slots.effect, EFFECTS, (t) => t.id);
    if (!e) return reply('I did not catch that effect. Try twinkle, candy cane, snowfall, fireplace, or rainbow.');
    await app.act('lights.set', { power: true, effect: e.id });
    return reply(`Ooh, ${esc(e.name)}! The tree is all set.`);
  },
  async TreeOnIntent({ app }) {
    await app.act('lights.set', { power: true });
    return reply('The tree is lit! Merry Christmas.');
  },
  async TreeOffIntent({ app }) {
    await app.act('lights.set', { power: false });
    return reply('Lights out. Sweet dreams, little tree.');
  },
  async LightShowIntent({ app, slots }) {
    const s = slots.song;
    // the family wants real recordings only: the synthesized carol shows are off unless realSongsOnly is false
    if (app.config?.settings?.realSongsOnly !== false) {
      await app.act('radio.play', {});
      return reply('Christmas radio is on the TV, with real songs. The tree is dancing along!');
    }
    const r = await app.act('show.play', slots.song?.value ? { song: resolveSong(s) } : { random: true });
    return reply(`Cueing up ${esc(r?.title || 'a surprise show')}! Watch the tree and the TV.`);
  },
  async StopShowIntent({ app }) {
    await app.act('show.stop', {});
    return reply('Show stopped. The elves are taking a bow.');
  },
  async StartGameIntent({ app, slots }) {
    const g = resolveSlot(slots.game, GAMES, (t) => t.id) || GAMES[0];
    const picked = !!slots.game?.value && resolveSlot(slots.game, GAMES, (t) => t.id);
    await app.act('game.start', { kind: g.id });
    return reply(`${picked ? '' : "You didn't pick one, so "}${esc(g.label)} is starting! Look at the TV, then grab your phones and join with the code on screen.`);
  },
  async AdventIntent({ app }) {
    const a = await app.act('advent.today', {});
    if (!a || a.none) return reply("The advent calendar isn't open today. Come back in December and we will open a door together!");
    return reply(`Behind door ${esc(a.day)}: ${esc(a.title)}. ${BRK('500ms')} Today's challenge: ${esc(a.challenge)} ${BRK('500ms')} Fun fact: ${esc(a.fact)}`);
  },
  async ElfNameIntent({ app, slots }) {
    const name = slots.name?.value;
    const r = await app.act('elf.name', name ? { name } : {});
    return reply(`${name ? esc(name) + ', your' : 'Your'} elf name is ${esc(r.elf)}! ${BRK('300ms')} Your job at the workshop: ${esc(r.job)}.`);
  },
  async PartyIntent({ app }) {
    const r = await app.act('scene.party', {});
    return reply(esc(r?.say || "Party time! Let's go!"));
  },
  async GoodnightIntent({ app }) {
    const r = await app.act('scene.goodnight', {});
    return reply(esc(r?.say || 'Goodnight! Sleep tight till Santa comes.'));
  },
  async YuleLogIntent({ app }) {
    await app.act('tv.scene', { scene: 'yule' });
    await app.act('lights.set', { power: true, effect: 'fireplace' });
    return reply('Cozy time! The yule log is crackling on the TV, and the tree is glowing like a fireplace.');
  },
  async RadioIntent({ app, slots }) {
    const ch = resolveSlot(slots.channel, CHANNELS, (t) => t.id);
    await app.act('radio.play', ch ? { channel: ch.id } : {});
    return reply(`Christmas radio is on${ch ? ', tuned to ' + esc(ch.name) : ''}. Enjoy the music!`);
  },
};

function resolveSong(slot) {
  const auth = slot.resolutions?.resolutionsPerAuthority?.find((a) => a.status?.code === 'ER_SUCCESS_MATCH');
  return auth?.values?.[0]?.value?.name || slot.value;
}

// ---------------------------------------------------------------- dispatch
// Elf mode: "Alexa, open North Pole" keeps listening, so every follow-up goes to the app (no "ask North Pole"
// prefix needed) until someone says stop, or nobody talks for a while.
function keepListening(r) {
  r.sessionAttributes = { ...(r.sessionAttributes || {}), elf: true };
  if (r.response?.outputSpeech) {
    r.response.shouldEndSession = false;
    r.response.reprompt = { outputSpeech: { type: 'SSML', ssml: '<speak>What next? Or say stop.</speak>' } };
  }
  return r;
}

export async function handleAlexaRequest(app, envelope) {
  const req = envelope?.request || {};
  const elf = !!envelope?.session?.attributes?.elf;
  try {
    if (req.type === 'LaunchRequest') {
      app.lights?.overlay?.({ kind: 'burst', color: '#ffd36b', dur: 1.5 });
      return keepListening(reply("Elf mode is on! I'm listening for the North Pole. Say, dear Santa, then a question. Or, a report card for someone, tell us a story, show the countdown on the TV, or make the tree red. What would you like?", { end: false, reprompt: 'Say, dear Santa, then a question.' }));
    }
    if (req.type === 'SessionEndedRequest') return { version: '1.0', response: {} };
    if (req.type !== 'IntentRequest') return reply('The elves did not understand that one.');
    const name = req.intent?.name;
    const slots = req.intent?.slots || {};
    if (name === 'AMAZON.HelpIntent') return keepListening(reply(HELP, { end: false, reprompt: 'What would you like? You can say, tell me a joke.' }));
    if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent') return reply('Merry Christmas! The elves wave goodbye.');
    if (name === 'AMAZON.FallbackIntent' || !HANDLERS[name]) {
      const r = reply('Hmm, the elves did not catch that. Try, dear Santa, then a question, or, show the countdown on the TV.');
      return elf ? keepListening(r) : r;
    }
    const out = await HANDLERS[name]({ app, slots });
    return elf ? keepListening(out) : out;
  } catch (e) {
    app.log?.('[alexa] intent failed:', req.intent?.name, e.message);
    const nf = /song|find|unknown|not found/i.test(e.message);
    return reply(nf ? "I couldn't find that carol in the workshop songbook. Try Jingle Bells or Silent Night." : 'Oh no, an elf tripped over a cable. Please try again in a moment.');
  }
}

export async function install(app) {
  app.route('POST', '/alexa/skill', async (req, res, { body }) => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); res.end(JSON.stringify(obj)); };
    try {
      const v = await verifyRequest(app, req.headers || {}, body);
      if (!v.ok) { app.log('[alexa] rejected:', v.reason); return send(v.status, { error: v.reason }); }
      const rq = v.envelope?.request || {};
      app.log('[alexa] heard', rq.type + (rq.intent?.name ? ' ' + rq.intent.name : ''));
      return send(200, await handleAlexaRequest(app, v.envelope));
    } catch (e) {
      app.log('[alexa] error', e.message);
      return send(500, { error: 'internal error' });
    }
  });
  app.log('[alexa] skill endpoint ready at POST /alexa/skill' + (process.env.XM_SKILL_INSECURE === '1' ? ' (INSECURE test mode: signatures not checked)' : ''));
}
