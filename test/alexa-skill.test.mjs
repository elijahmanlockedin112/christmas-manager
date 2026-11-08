import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync } from 'node:crypto';
import tls from 'node:tls';
import fs from 'node:fs';
import {
  install, verifyCertUrl, verifyTimestamp, checkApplicationId, verifySignature, verifyCertChain, verifyRequest,
  handleAlexaRequest, splitPem, COLORS, EFFECTS, SONGS, GAMES, CHANNELS, INTENTS, BUILTIN_INTENTS, slugify,
} from '../server/alexa-skill.mjs';

const APP_ID = 'amzn1.ask.skill.test-1234';
const ANSWERS = {
  'joke.random': { q: 'What do elves learn in school?', a: 'The elf-abet! & more', kind: 'pun' },
  countdown: { days: 17, hours: 4, minutes: 5, isChristmas: false, isEve: false },
  'santa.status': { active: true, city: 'Paris', country: 'France', nextCity: 'Rome', giftsDelivered: 1234567, message: '' },
  'advent.today': { day: 5, title: 'Cookie Day', challenge: 'Bake cookies', fact: 'Cookies are tasty' },
  'show.play': { ok: true, title: 'Jingle Bells' },
  'elf.name': { elf: 'Twinkle Toes', job: 'Chief Sock Stuffer' },
  'scene.party': { ok: true, say: "Let's party & dance!" },
  'scene.goodnight': { ok: true, say: 'Goodnight, tree.' },
  'game.start': { ok: true, joinUrl: 'http://x/join' },
};
function fakeApp() {
  const calls = []; const routes = {};
  return {
    calls, routes, config: { alexaSkill: { appId: APP_ID } }, onPi: false, saved: 0,
    saveConfig() { this.saved++; }, log() {},
    route(m, p, h) { routes[`${m} ${p}`] = h; },
    async act(name, args) { calls.push([name, args]); return ANSWERS[name] || { ok: true }; },
  };
}
const slot = (name, value, id) => ({ name, value, ...(id ? { resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' }, values: [{ value: { name: value, id } }] }] } } : {}) });
const intentEnv = (name, slots = {}, extra = {}) => ({
  version: '1.0',
  session: { new: true, application: { applicationId: APP_ID } },
  request: { type: 'IntentRequest', requestId: 'r1', timestamp: new Date().toISOString(), intent: { name, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v])) }, ...extra },
});
const ssml = (r) => r.response.outputSpeech.ssml;

// Drive the real HTTP route handler with fakes.
async function post(app, envelope, headers = {}) {
  const handler = app.routes['POST /alexa/skill'];
  const body = Buffer.from(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
  let status, text;
  const res = { writeHead(s) { status = s; }, end(t) { text = t; } };
  await handler({ headers, method: 'POST' }, res, { body, url: new URL('http://x/alexa/skill'), json: () => JSON.parse(body) });
  return { status, json: JSON.parse(text) };
}

// ---------------------------------------------------------------- verification pieces
test('cert url rules', () => {
  const ok = (u) => assert.equal(verifyCertUrl(u).ok, true, u);
  const no = (u) => assert.equal(verifyCertUrl(u).ok, false, u);
  ok('https://s3.amazonaws.com/echo.api/echo-api-cert.pem');
  ok('https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem');
  ok('https://S3.AMAZONAWS.COM/echo.api/../echo.api/echo-api-cert.pem');
  no('http://s3.amazonaws.com/echo.api/echo-api-cert.pem');
  no('https://s3.amazonaws.com:8443/echo.api/echo-api-cert.pem');
  no('https://notamazon.com/echo.api/echo-api-cert.pem');
  no('https://s3.amazonaws.com.evil.com/echo.api/echo-api-cert.pem');
  no('https://s3.amazonaws.com/EcHo.api/echo-api-cert.pem');
  no('https://s3.amazonaws.com/invalid.path/echo-api-cert.pem');
  no('https://s3.amazonaws.com/echo.api/../evil/cert.pem');
  no('https://user@s3.amazonaws.com/echo.api/c.pem');
  no('not a url');
  no(undefined);
});

test('timestamp window is 150 seconds', () => {
  const now = Date.now();
  assert.equal(verifyTimestamp(new Date(now - 100e3).toISOString(), now).ok, true);
  assert.equal(verifyTimestamp(new Date(now + 100e3).toISOString(), now).ok, true);
  assert.equal(verifyTimestamp(new Date(now - 151e3).toISOString(), now).ok, false);
  assert.equal(verifyTimestamp(new Date(now + 151e3).toISOString(), now).ok, false);
  assert.equal(verifyTimestamp(undefined, now).ok, false);
  assert.equal(verifyTimestamp('garbage', now).ok, false);
});

test('applicationId: match, mismatch, missing, and pin-first-seen', () => {
  const app = fakeApp();
  assert.equal(checkApplicationId(app, APP_ID).ok, true);
  assert.equal(checkApplicationId(app, 'other').ok, false);
  assert.equal(checkApplicationId(app, undefined).ok, false);
  const fresh = fakeApp(); fresh.config = {};
  const r = checkApplicationId(fresh, 'amzn1.first');
  assert.equal(r.ok, true); assert.equal(r.learned, true);
  assert.equal(fresh.config.alexaSkill.appId, 'amzn1.first'); assert.equal(fresh.saved, 1);
  assert.equal(checkApplicationId(fresh, 'amzn1.second').ok, false);
});

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sign = (body, key = privateKey) => crypto.createSign('RSA-SHA256').update(body).sign(key, 'base64');

test('signature verification with a generated RSA key', () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verifySignature(publicKey, sign(body), body), true);
  assert.equal(verifySignature(publicKey, sign(body), Buffer.from('{"hello":"w0rld"}')), false);
  assert.equal(verifySignature(publicKey, sign(body, other.privateKey), body), false);
  assert.equal(verifySignature(publicKey, undefined, body), false);
  assert.equal(verifySignature(publicKey, 'not-base64!!', body), false);
});

test('cert chain: garbage, empty, SAN, and trust anchoring', () => {
  assert.equal(verifyCertChain([]).ok, false);
  assert.equal(verifyCertChain(['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----']).ok, false);
  const root = tls.rootCertificates[0];
  // a real root has no echo-api SAN
  assert.match(verifyCertChain([root], { anchors: [root] }).reason, /SAN/);
  // with SAN check off, a self-anchored root passes; unanchored fails
  const good = verifyCertChain([root], { san: null, anchors: [root] });
  assert.equal(good.ok, true); assert.ok(good.leafKey);
  assert.match(verifyCertChain([root], { san: null, anchors: [tls.rootCertificates[5]] }).reason, /trusted root/);
  // validity dates
  assert.match(verifyCertChain([root], { san: null, anchors: null, now: Date.parse('1990-01-01') }).reason, /validity/);
  // two unrelated certs are not a chain
  assert.match(verifyCertChain([tls.rootCertificates[0], tls.rootCertificates[5]], { san: null, anchors: null }).reason, /not signed/);
  assert.equal(splitPem(root + '\n' + root).length, 2);
});

test('verifyRequest: full flow with a stubbed chain and real signature', async () => {
  const app = fakeApp();
  const env = intentEnv('TellJokeIntent');
  const raw = Buffer.from(JSON.stringify(env));
  const url = 'https://s3.amazonaws.com/echo.api/echo-api-cert.pem';
  const stubs = { fetchChain: async () => ['pem'], verifyChain: () => ({ ok: true, leafKey: publicKey }) };
  const hdr = (over = {}) => ({ signaturecertchainurl: url, 'signature-256': sign(raw), ...over });
  const run = (headers, body = raw, extra = {}) => verifyRequest(app, headers, body, { insecure: false, ...stubs, ...extra });

  assert.equal((await run(hdr())).ok, true);
  assert.match((await run(hdr({ signaturecertchainurl: 'http://s3.amazonaws.com/echo.api/x.pem' }))).reason, /https/);
  assert.match((await run(hdr({ 'signature-256': sign(raw, other.privateKey) }))).reason, /signature/);
  assert.match((await run(hdr(), Buffer.from(raw.toString().replace('Joke', 'Jokf')))).reason, /signature/);
  assert.match((await run(hdr(), raw, { fetchChain: async () => { throw new Error('nope'); } })).reason, /download/);
  assert.match((await run(hdr(), raw, { verifyChain: () => ({ ok: false, reason: 'bad chain' }) })).reason, /bad chain/);

  const stale = Buffer.from(JSON.stringify({ ...env, request: { ...env.request, timestamp: new Date(Date.now() - 300e3).toISOString() } }));
  const st = await run({ ...hdr(), 'signature-256': sign(stale) }, stale);
  assert.equal(st.ok, false); assert.match(st.reason, /timestamp/);

  const wrong = Buffer.from(JSON.stringify({ ...env, session: { application: { applicationId: 'evil' } } }));
  const wr = await run({ ...hdr(), 'signature-256': sign(wrong) }, wrong);
  assert.equal(wr.ok, false); assert.equal(wr.status, 403);
});

test('without XM_SKILL_INSECURE the route rejects unsigned requests', async () => {
  const prev = process.env.XM_SKILL_INSECURE;
  delete process.env.XM_SKILL_INSECURE;
  try {
    const app = fakeApp(); await install(app);
    const r = await post(app, intentEnv('TellJokeIntent'));
    assert.equal(r.status, 400);
    assert.equal(app.calls.length, 0);
  } finally { if (prev !== undefined) process.env.XM_SKILL_INSECURE = prev; }
});

// ---------------------------------------------------------------- intents end-to-end (insecure mode)
process.env.XM_SKILL_INSECURE = '1';   // set at load; only the "rejects unsigned" test above unsets it temporarily

async function run(name, slots, setup) {
  const app = fakeApp(); if (setup) setup(app);
  await install(app);
  const r = await post(app, intentEnv(name, slots));
  assert.equal(r.status, 200, name);
  assert.equal(r.json.version, '1.0');
  const s = ssml(r.json);
  assert.match(s, /^<speak>[\s\S]*<\/speak>$/);
  assert.doesNotMatch(s, /<audio/);
  return { app, r: r.json, s, calls: app.calls };
}

test('Launch keeps the session open with a reprompt', async () => {
  const app = fakeApp(); await install(app);
  const r = await post(app, { ...intentEnv('x'), request: { type: 'LaunchRequest', timestamp: new Date().toISOString() } });
  assert.equal(r.json.response.shouldEndSession, false);
  assert.match(r.json.response.reprompt.outputSpeech.ssml, /<speak>/);
  assert.match(ssml(r.json), /North Pole/);
});

test('SessionEnded returns no speech; Help keeps open; Stop/Cancel/Fallback end', async () => {
  const app = fakeApp(); await install(app);
  const se = await post(app, { ...intentEnv('x'), request: { type: 'SessionEndedRequest', reason: 'USER_INITIATED', timestamp: new Date().toISOString() } });
  assert.equal(se.status, 200); assert.equal(se.json.response.outputSpeech, undefined);
  const h = (await run('AMAZON.HelpIntent')).r.response;
  assert.equal(h.shouldEndSession, false); assert.ok(h.reprompt);
  for (const n of ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.FallbackIntent']) {
    const { r } = await run(n);
    assert.equal(r.response.shouldEndSession, true, n);
    assert.equal(r.response.reprompt, undefined, n);
  }
});

test('TellJokeIntent: 2s break before the punchline, text escaped', async () => {
  const { s, calls } = await run('TellJokeIntent');
  assert.deepEqual(calls, [['joke.random', {}]]);
  assert.match(s, /school\?\s*<break time="2s"\/>\s*The elf-abet! &amp; more/);
});

test('CountdownIntent (days, eve, christmas)', async () => {
  const { s } = await run('CountdownIntent');
  assert.match(s, /17 sleeps/);
  const eve = await run('CountdownIntent', {}, (a) => { ANSWERS.countdown = { days: 0, hours: 9, isEve: true }; });
  assert.match(eve.s, /Christmas Eve/);
  ANSWERS.countdown = { days: 0, hours: 0, isChristmas: true };
  assert.match((await run('CountdownIntent')).s, /Merry Christmas/);
  ANSWERS.countdown = { days: 17, hours: 4, minutes: 5, isChristmas: false, isEve: false };
});

test('SantaIntent active and idle', async () => {
  const a = await run('SantaIntent');
  assert.match(a.s, /Paris, France/); assert.match(a.s, /Rome/); assert.match(a.s, /say-as interpret-as="cardinal">1234567</);
  const saved = ANSWERS['santa.status'];
  ANSWERS['santa.status'] = { active: false, message: 'Santa is resting.' };
  assert.match((await run('SantaIntent')).s, /resting/);
  ANSWERS['santa.status'] = saved;
});

test('TreeColorIntent maps colors to hex (resolved id and plain text)', async () => {
  let x = await run('TreeColorIntent', { color: slot('color', 'gold', 'gold') });
  assert.deepEqual(x.calls, [['lights.set', { power: true, effect: 'solid', color: '#ffb800' }]]);
  assert.match(x.s, /gold/);
  x = await run('TreeColorIntent', { color: slot('color', 'forest green') });
  assert.equal(x.calls[0][1].color, COLORS.find((c) => c.name === 'emerald').hex);
  x = await run('TreeColorIntent', { color: slot('color', 'plaid') });
  assert.equal(x.calls.length, 0); assert.match(x.s, /not sure/);
  assert.ok(COLORS.length >= 25);
  for (const c of COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
});

test('TreeEffectIntent maps synonyms and every effect id', async () => {
  const cases = { 'candy cane': 'candy-cane', fire: 'fireplace', snow: 'snowfall', rainbow: 'rainbow', twinkle: 'twinkle', 'northern lights': 'aurora' };
  for (const [spoken, id] of Object.entries(cases)) {
    const { calls } = await run('TreeEffectIntent', { effect: slot('effect', spoken) });
    assert.deepEqual(calls, [['lights.set', { power: true, effect: id }]], spoken);
  }
  const { calls } = await run('TreeEffectIntent', { effect: slot('effect', 'candy canes', 'candy-cane') });
  assert.equal(calls[0][1].effect, 'candy-cane');
  const official = 'classic retro twinkle candy-cane snowfall fireplace aurora peppermint rainbow starlight gingerbread frost chase ornaments comet breathe solid'.split(' ');
  assert.deepEqual(EFFECTS.map((e) => e.id), official);
  assert.equal((await run('TreeEffectIntent', { effect: slot('effect', 'zzz') })).calls.length, 0);
});

test('TreeOn / TreeOff', async () => {
  assert.deepEqual((await run('TreeOnIntent')).calls, [['lights.set', { power: true }]]);
  assert.deepEqual((await run('TreeOffIntent')).calls, [['lights.set', { power: false }]]);
});

test('LightShowIntent plays real songs (radio) by default', async () => {
  const x = await run('LightShowIntent', { song: slot('song', 'silent night', 'silent-night') });
  assert.deepEqual(x.calls, [['radio.play', {}]]);
  assert.match(x.s, /radio/i);
});

test('LightShowIntent with and without a song, and failure (carol shows turned back on)', async () => {
  const carols = (a) => { a.config.settings = { realSongsOnly: false }; };
  let x = await run('LightShowIntent', {}, carols);
  assert.deepEqual(x.calls, [['show.play', { random: true }]]);
  assert.match(x.s, /Jingle Bells/);
  x = await run('LightShowIntent', { song: slot('song', 'silent night', 'silent-night') }, carols);
  assert.deepEqual(x.calls, [['show.play', { song: 'silent night' }]]);
  const bad = await run('LightShowIntent', { song: slot('song', 'zzz') }, (a) => { carols(a); a.act = async () => { throw new Error('song not found'); }; });
  assert.match(bad.s, /songbook/);
});

test('StopShowIntent', async () => {
  assert.deepEqual((await run('StopShowIntent')).calls, [['show.stop', {}]]);
});

test('StartGameIntent for each game and the default', async () => {
  for (const [spoken, kind] of [['trivia', 'trivia'], ['name that song', 'name-that-song'], ['would you rather', 'would-you-rather'], ['pictionary', 'pictionary']]) {
    assert.deepEqual((await run('StartGameIntent', { game: slot('game', spoken) })).calls, [['game.start', { kind }]], spoken);
  }
  const d = await run('StartGameIntent');
  assert.deepEqual(d.calls, [['game.start', { kind: 'trivia' }]]);
  assert.match(d.s, /didn't pick/);
});

test('AdventIntent today and none', async () => {
  const a = await run('AdventIntent');
  assert.match(a.s, /door 5: Cookie Day/); assert.match(a.s, /Bake cookies/);
  const saved = ANSWERS['advent.today']; ANSWERS['advent.today'] = { none: true };
  assert.match((await run('AdventIntent')).s, /December/);
  ANSWERS['advent.today'] = saved;
});

test('ElfNameIntent with and without a name', async () => {
  let x = await run('ElfNameIntent', { name: slot('name', 'Ava') });
  assert.deepEqual(x.calls, [['elf.name', { name: 'Ava' }]]);
  assert.match(x.s, /Ava, your elf name is Twinkle Toes/); assert.match(x.s, /Chief Sock Stuffer/);
  x = await run('ElfNameIntent');
  assert.deepEqual(x.calls, [['elf.name', {}]]);
});

test('Party / Goodnight / YuleLog / Radio', async () => {
  let x = await run('PartyIntent');
  assert.deepEqual(x.calls, [['scene.party', {}]]); assert.match(x.s, /party &amp; dance/);
  x = await run('GoodnightIntent');
  assert.deepEqual(x.calls, [['scene.goodnight', {}]]); assert.match(x.s, /Goodnight, tree/);
  x = await run('YuleLogIntent');
  assert.deepEqual(x.calls, [['tv.scene', { scene: 'yule' }], ['lights.set', { power: true, effect: 'fireplace' }]]);
  x = await run('RadioIntent');
  assert.deepEqual(x.calls, [['radio.play', {}]]);
  x = await run('RadioIntent', { channel: slot('channel', 'jolly soul') });
  assert.deepEqual(x.calls, [['radio.play', { channel: 'jollysoul' }]]);
});

test('BuildGameIntent starts the workshop and answers inside Alexa\'s window; errors are spoken', async () => {
  const x = await run('BuildGameIntent', { request: slot('request', 'christmas movies') });
  assert.deepEqual(x.calls, [['workshop.build', { request: 'christmas movies', by: 'Alexa' }]]);
  assert.match(x.s, /elves are building it now\. Look at the TV/);
  assert.equal(x.r.response.shouldEndSession, true);
  const none = await run('BuildGameIntent');
  assert.deepEqual(none.calls, []);
  assert.equal(none.r.response.shouldEndSession, false);
  const busy = await run('BuildGameIntent', { request: slot('request', 'snowmen') }, (a) => { a.act = async () => { throw new Error('The elves are still building the last game.'); }; });
  assert.match(busy.s, /still building the last game/);
  const slow = await run('BuildGameIntent', { request: slot('request', 'snowmen') }, (a) => { a.act = () => new Promise(() => { }); });
  assert.match(slow.s, /Look at the TV/);
});

test('action failure gives a friendly spoken error', async () => {
  const x = await run('TreeOnIntent', {}, (a) => { a.act = async () => { throw new Error('lights offline'); }; });
  assert.match(x.s, /elf tripped/);
});

test('unknown applicationId is rejected with 403 even in insecure mode', async () => {
  const app = fakeApp(); await install(app);
  const env = intentEnv('TreeOnIntent'); env.session.application.applicationId = 'amzn1.evil';
  const r = await post(app, env);
  assert.equal(r.status, 403); assert.equal(app.calls.length, 0);
});

test('every handled intent is in the interaction model, and vocab is in sync', () => {
  const model = JSON.parse(fs.readFileSync(new URL('../skill/interaction-model.json', import.meta.url), 'utf8')).interactionModel.languageModel;
  assert.equal(model.invocationName, 'north pole');
  const names = model.intents.map((i) => i.name);
  for (const n of [...INTENTS, ...BUILTIN_INTENTS]) assert.ok(names.includes(n), n);
  for (const i of model.intents.filter((i) => INTENTS.includes(i.name))) {
    assert.ok(i.samples.length >= 6 && i.samples.length <= 12, `${i.name} has ${i.samples.length} samples`);
    for (const s of i.samples) for (const m of s.matchAll(/\{(\w+)\}/g)) assert.ok((i.slots || []).some((x) => x.name === m[1]), `${i.name}: slot ${m[1]}`);
  }
  const type = (n) => model.types.find((t) => t.name === n).values;
  assert.deepEqual(type('EFFECT').map((v) => v.id), EFFECTS.map((e) => e.id));
  assert.deepEqual(type('TREE_COLOR').map((v) => v.name.value), COLORS.map((c) => c.name));
  assert.deepEqual(type('SONG').map((v) => v.name.value), SONGS);
  assert.equal(SONGS.length, 20);
  assert.deepEqual(type('GAME').map((v) => v.id), GAMES.map((g) => g.id));
  assert.deepEqual(type('RADIO_CHANNEL').map((v) => v.id), CHANNELS.map((c) => c.id));
  assert.ok(type('SONG').every((v) => v.id === slugify(v.name.value)));
});
