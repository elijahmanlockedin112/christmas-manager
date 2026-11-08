// North Pole Control - the Christmas Manager server.
// Runs on the Raspberry Pi by the tree (or on the PC while testing). Zero-build, Node 18+.
//   /       iPad + phone control center        /tv    the TV stage (Pi HDMI kiosk)
//   /play   family phones join games           /ws    live state, LED frames, game input
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { attachWebSocket } from './ws.mjs';
import { Lights } from './lights.mjs';
import { Games, TEAMS } from './games.mjs';
import { AlexaBridge, lanIp } from './alexa.mjs';
import { AI } from './claude.mjs';
import { Roku } from './roku.mjs';
import { EFFECTS, hasEffect } from '../shared/effects.mjs';
import { buildTimeline, lightCue } from '../shared/song.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 47925);
const DATA = process.env.XM_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const ON_PI = process.env.XM_ON_PI === '1' || (() => { try { return /raspberry pi/i.test(fs.readFileSync('/proc/device-tree/model', 'utf8')); } catch { return false; } })();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- config (persisted) ----------------
const CONFIG_FILE = path.join(DATA, 'config.json');
const DEFAULT_CONFIG = {
  hw: {
    count: 100, turns: 9, layout: null,
    outputs: [
      { type: 'pixels', host: process.env.XM_PIXELS?.split(':')[0] || (ON_PI ? '127.0.0.1' : ''), port: Number(process.env.XM_PIXELS?.split(':')[1] || 47926), on: ON_PI || !!process.env.XM_PIXELS },
      { type: 'beat', host: '', port: 47961, on: false },
      { type: 'wled', host: '', port: 21324, on: false },
    ],
  },
  lights: { power: true, effect: 'classic', color: '#ff3b2f', brightness: 0.8, speed: 1 },
  settings: {
    family: 'The Family', teams: 2, home: { name: 'Atlanta', lat: 33.75, lon: -84.39, utc: -5 },
    lightDelayMs: 0, showAudio: 'tv', alexaJokes: true, joinUrl: '', goodnightMinutes: 20, phones: false, remoteUrl: '', physicalTree: true,
  },
  schedule: { enabled: false, on: '17:00', off: '23:30' },
  alexa: { enabled: true, device: null, proxyIp: '', proxyPort: 47927 },
  voiceMonkey: { token: '', speaker: '', triggers: {} },
  ledPanel: { url: 'http://127.0.0.1:47952', on: false },
  hue: { enabled: true },
  alexaSkill: { appId: '' },
  ai: { capUsd: 5 },
  setupDone: {},
};
function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}
let config = DEFAULT_CONFIG;
try { config = deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch { }
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify(config, null, 1)); fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE); } catch (e) { log('config save', e.message); }
  }, 300);
}

// ---------------- content ----------------
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch (e) { log('content', p, e.message); return fb; } };
const content = {
  jokes: [...readJson('content/jokes-1.json', []), ...readJson('content/jokes-2.json', [])],
  trivia: [...readJson('content/trivia-1.json', []), ...readJson('content/trivia-2.json', [])],
  hits: readJson('content/hits.json', []),
  pictionary: readJson('content/pictionary.json', []),
  charades: readJson('content/charades.json', []),
  wyr: readJson('content/would-you-rather.json', []),
  elf: readJson('content/elf-names.json', { first: ['Jingle'], last: ['McSparkle'], jobs: ['Head of Bows'] }),
  nice: readJson('content/nice-list.json', { nice: ['Nice list confirmed.'], borderline: [] }),
  advent: readJson('content/advent.json', []),
  cities: [...readJson('content/santa-east.json', []), ...readJson('content/santa-west.json', [])].map(c => ({ ...c, lon: c.lon > 180 ? c.lon - 360 : c.lon })),
};
const photos = new Map(); // Nice List photos, memory only
const songs = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'shared', 'carols')).filter(f => f.endsWith('.json'))) {
  try { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'carols', f), 'utf8')); if (!s.hidden) songs.set(s.id, { song: s, tl: buildTimeline(s) }); } catch (e) { log('carol', f, e.message); }
}
log(`content: ${content.jokes.length} jokes, ${content.trivia.length} trivia, ${content.hits.length} hits, ${songs.size} carols, ${content.cities.length} cities`);

// ---------------- live state (broadcast) ----------------
const state = {
  lights: { ...config.lights },
  tv: { scene: 'home', prev: 'home', clients: 0, message: null, power: null },
  show: { playing: false },
  radio: { playing: false, channel: 'christmas', now: null },
  joke: null,
  scanner: null,
  game: null,
  players: [],
  santa: null,
  secretSanta: null,
  alexa: { status: 'off' },
  map: null,
};

// ---------------- app object shared with modules ----------------
const clients = new Set();
let broadcastTimer = null;
const app = {
  root: ROOT, dataDir: DATA, onPi: ON_PI, port: PORT, log, content, state,
  get config() { return config; },
  saveConfig,
  changed() { if (!broadcastTimer) broadcastTimer = setTimeout(broadcastState, 40); },
  broadcastTo(filter, msg) { const s = JSON.stringify(msg); for (const c of clients) if (filter(c)) c.ws.send(s); },
  sfx(name) { app.broadcastTo(c => c.role === 'tv' || (c.role === 'remote' && c.audio), { type: 'sfx', name }); },
  routes: [],
  route(method, p, handler) { app.routes.push({ method, path: p, handler }); },
  songList: () => [...songs.values()].map(({ song }) => ({ id: song.id, title: song.title, by: song.by, year: song.year, mood: song.mood, instrumental: !!song.instrumental, secs: Math.round(songs.get(song.id).tl.total) })),
  setTvScene, playShow, stopShow, pauseShow,
};
app.lights = new Lights(app);
app.games = new Games(app);
app.alexa = new AlexaBridge(app);
app.ai = new AI(app);
app.roku = new Roku(app);
app.roku.push();
// find the TV at startup (read-only; never presses a key by itself)
if (ON_PI) setTimeout(() => app.roku.discover().catch(() => { }), 4000);
app.ai.push();
// Alexa reads longer text in sentence-sized chunks (speak() caps each at 250 characters)
async function alexaRead(text) {
  if (!(app.alexa.ready || app.alexa.vmReady)) return;
  const parts = String(text).match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  let chunk = '';
  for (const p of parts) {
    if ((chunk + p).length > 240 && chunk) { await app.alexa.speak(chunk.trim()).catch(() => { }); await new Promise(r => setTimeout(r, 400 + chunk.length * 55)); chunk = ''; }
    chunk += p;
  }
  if (chunk.trim()) await app.alexa.speak(chunk.trim()).catch(() => { });
}
function showAi(kind, data) {
  state.aiShow = { kind, ...data, at: Date.now() };
  setTvScene('ai');
  app.lights.overlay({ kind: 'burst', color: '#ffd36b', dur: 2 });
  app.sfx('reveal');
  returnLater('ai', 90000);
}

function snapshot() {
  return {
    ...state,
    lights: { ...state.lights },
    hw: { count: config.hw.count, mapped: Array.isArray(config.hw.layout), outputs: config.hw.outputs, layoutKey: `${config.hw.count}-${config.hw.turns}-${Array.isArray(config.hw.layout) ? config.hw.layout.length + ':' + (config.hw.layout[0]?.x ?? 0) : 's'}` },
    settings: config.settings, schedule: config.schedule, setupDone: config.setupDone || {},
    ledPanel: config.ledPanel,
    voiceMonkey: { configured: !!config.voiceMonkey.token, speaker: config.voiceMonkey.speaker, triggers: Object.keys(config.voiceMonkey.triggers || {}) },
    teams: TEAMS.slice(0, Math.min(4, Math.max(2, config.settings.teams || 2))),
    joinUrl: joinUrl(),
    onPi: ON_PI,
    serverTime: Date.now(),
  };
}
function broadcastState() {
  broadcastTimer = null;
  state.tv.clients = [...clients].filter(c => c.role === 'tv').length;
  const msg = JSON.stringify({ type: 'state', state: snapshot() });
  for (const c of clients) c.ws.send(msg);
}
function joinUrl() { return config.settings.joinUrl || `http://${lanIp()}:${PORT}/play`; }

// LED frames to screens that asked for them (binary: 0x01, count u16, rgb...)
app.lights.frameListeners.add(bytes => {
  let msg = null;
  for (const c of clients) {
    if (!c.frames || c.ws.backlog > 64 * 1024) continue;
    if (!msg) { msg = Buffer.allocUnsafe(3 + bytes.length); msg[0] = 1; msg.writeUInt16BE(bytes.length / 3, 1); bytes.copy(msg, 3); }
    c.ws.send(msg);
  }
});

// What the tree rests on when a temporary mode (paint, mic, show, radio) ends.
function baseEffect() {
  if (state.show.playing) return 'show';
  if (state.radio.playing) return 'react';
  return config.lights.effect && !['show', 'react', 'paint', 'mapping'].includes(config.lights.effect) ? config.lights.effect : 'classic';
}
let returnTimer = null;
function returnLater(scene, ms) { clearTimeout(returnTimer); returnTimer = setTimeout(() => { if (state.tv.scene === scene) setTvScene(backScene()); }, ms); }
// Where the TV goes back to after a joke, message or scanner: the game if one is running.
function backScene() { return state.game ? 'game' : state.show.playing && !state.show.game ? 'show' : state.tv.prev || 'home'; }

// ---------------- TV ----------------
function setTvScene(scene, keepPrev) {
  if (state.tv.scene !== scene) {
    if (!keepPrev && !['game', 'joke', 'scanner', 'message', 'show'].includes(state.tv.scene)) state.tv.prev = state.tv.scene;
    if (['home', 'yule', 'countdown', 'santa', 'advent', 'radio', 'tree'].includes(scene)) state.tv.prev = scene;
    state.tv.scene = scene;
    app.changed();
  }
}
function cec(cmd) {
  if (!ON_PI) return Promise.resolve({ ok: false, note: 'TV control works on the Pi (HDMI-CEC).' });
  return new Promise(resolve => {
    const p = spawn('cec-client', ['-s', '-d', '1'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const t = setTimeout(() => { try { p.kill(); } catch { } resolve({ ok: false }); }, 15000);
    p.on('error', () => {
      clearTimeout(t);
      const args = cmd === 'on 0' ? ['-d0', '--to', '0', '--image-view-on'] : cmd === 'standby 0' ? ['-d0', '--to', '0', '--standby'] : ['-d0', '--playback', '-S'];
      const q = spawn('cec-ctl', args, { stdio: 'ignore' });
      q.on('error', () => resolve({ ok: false, note: 'No cec-client or cec-ctl on this Pi.' }));
      q.on('exit', code => resolve({ ok: code === 0 }));
    });
    p.on('exit', code => { clearTimeout(t); resolve({ ok: code === 0 }); });
    p.stdin.end(cmd + '\n');
  });
}

// ---------------- light shows (carols on the TV, lights choreographed to every note) ----------------
let showQueue = [];
let showEndTimer = null;
function playShow(id, opts = {}) {
  let entry = songs.get(id);
  if (!entry && id) {
    const q = String(id).toLowerCase().replace(/[^a-z ]/g, '');
    entry = [...songs.values()].find(e => e.song.title.toLowerCase().replace(/[^a-z ]/g, '').includes(q) || q.includes(e.song.title.toLowerCase().replace(/[^a-z ]/g, '')));
  }
  if (!entry) { const all = [...songs.values()]; entry = all[Math.floor(Math.random() * all.length)]; }
  if (!entry) throw new Error('No songs installed.');
  const { song, tl } = entry;
  if (state.radio.playing) radioStop();
  const startAt = Date.now() + (opts.delay ?? 1800);
  state.show = { playing: true, paused: false, songId: song.id, title: song.title, by: song.by, year: song.year, instrumental: !!song.instrumental, startAt, lead: tl.lead, total: tl.total, lyrics: opts.lyrics !== false, game: !!opts.game, playlist: !!opts.playlist };
  state.lights.effect = 'show';
  state.lights.power = true;
  if (!opts.game) setTvScene('show');
  scheduleShowEnd();
  app.changed();
  return { ok: true, title: song.title };
}
function scheduleShowEnd() {
  clearTimeout(showEndTimer);
  const s = state.show;
  if (!s.playing || s.paused) return;
  const endsIn = s.startAt + (s.lead + s.total) * 1000 + 2500 - Date.now();
  showEndTimer = setTimeout(() => {
    if (state.show.playlist) {
      if (!showQueue.length) showQueue = [...songs.keys()].sort(() => Math.random() - 0.5);
      const next = showQueue.shift();
      playShow(next === state.show.songId ? showQueue.shift() : next, { playlist: true, delay: 2500 });
    } else if (!state.show.game) stopShow();
  }, Math.max(0, endsIn));
}
function pauseShow(paused) {
  const s = state.show;
  if (!s.playing || s.paused === paused) return;
  if (paused) { s.paused = true; s.pausedOffset = Date.now() - s.startAt; clearTimeout(showEndTimer); }
  else { s.paused = false; s.startAt = Date.now() - s.pausedOffset + 300; scheduleShowEnd(); }
  app.changed();
}
function stopShow() {
  clearTimeout(showEndTimer);
  if (!state.show.playing) return;
  state.show = { playing: false };
  if (state.lights.effect === 'show') state.lights.effect = baseEffect();
  if (state.tv.scene === 'show') setTvScene(backScene());
  app.changed();
}
app.lights.cueProvider = () => {
  const s = state.show;
  if (!s.playing) return null;
  const entry = songs.get(s.songId);
  if (!entry) return null;
  const now = s.paused ? s.startAt + s.pausedOffset : Date.now();
  return lightCue(entry.tl, (now - s.startAt) / 1000 - entry.tl.lead - (config.settings.lightDelayMs || 0) / 1000);
};

// ---------------- radio (SomaFM Christmas channels, proxied so the TV can analyse the audio) ----------------
const RADIO = {
  christmas: { name: 'Christmas Lounge', blurb: 'Chilled holiday grooves and classic winter lounge' },
  xmasinfrisko: { name: 'Xmas in Frisko', blurb: 'SomaFM\'s wacky and eclectic holiday mix' },
  jollysoul: { name: "Jolly Ol' Soul", blurb: 'Soul, R&B and funk Christmas classics' },
  xmasrocks: { name: 'Christmas Rocks!', blurb: 'Indie and alternative holiday season rock' },
  deptstore: { name: 'Department Store Christmas', blurb: 'Holiday elevator music from a fictional store' },
};
let radioPoll = null;
function radioPlay(channel) {
  if (!RADIO[channel]) channel = state.radio.channel in RADIO ? state.radio.channel : 'christmas';
  stopShow();
  state.radio = { playing: true, channel, name: RADIO[channel].name, now: null, startedAt: Date.now() };
  if (!['show', 'game'].includes(state.tv.scene)) setTvScene('radio');
  state.lights.effect = 'react';
  pollNowPlaying();
  clearInterval(radioPoll);
  radioPoll = setInterval(pollNowPlaying, 15000);
  app.changed();
  return { ok: true, name: RADIO[channel].name };
}
function radioStop() {
  clearInterval(radioPoll);
  if (!state.radio.playing) return { ok: true };
  state.radio = { playing: false, channel: state.radio.channel, now: null };
  if (state.lights.effect === 'react') state.lights.effect = baseEffect();
  if (state.tv.scene === 'radio') setTvScene('home');
  app.changed();
  return { ok: true };
}
async function pollNowPlaying() {
  if (!state.radio.playing) return;
  try {
    const r = await fetch(`https://somafm.com/songs/${state.radio.channel}.json`, { headers: { 'user-agent': 'NorthPoleControl/1.0' } });
    const j = await r.json();
    const s = j.songs?.[0];
    if (s && (!state.radio.now || state.radio.now.title !== s.title)) {
      state.radio.now = { title: s.title, artist: s.artist, album: s.album, art: s.albumArt || '' };
      state.radio.recent = (j.songs || []).slice(1, 5).map(x => ({ title: x.title, artist: x.artist }));
      app.changed();
    }
  } catch (e) { log('radio now-playing', e.message); }
}
function proxyRadio(req, res, id) {
  if (!RADIO[id]) { res.writeHead(404); res.end(); return; }
  const tryHosts = ['ice2', 'ice6', 'ice5', 'ice4', 'ice1'];
  let started = false, closed = false;
  req.on('close', () => { closed = true; });
  const attempt = k => {
    if (closed) return;
    if (k >= tryHosts.length) { if (!res.headersSent) res.writeHead(502); res.end(); return; }
    import('node:https').then(({ default: https }) => {
      const up = https.get(`https://${tryHosts[k]}.somafm.com/${id}-128-mp3`, { headers: { 'user-agent': 'NorthPoleControl/1.0', 'icy-metadata': '0' } }, r => {
        if (r.statusCode !== 200) { r.resume(); attempt(k + 1); return; }
        started = true;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        r.on('error', () => res.end());
        r.on('end', () => res.end());
        r.pipe(res);
        req.on('close', () => up.destroy());
      });
      // before the stream starts, try the next server; after, end cleanly and let the TV reconnect
      up.on('error', () => (started ? res.end() : attempt(k + 1)));
      up.setTimeout(10000, () => up.destroy());
    });
  };
  attempt(0);
}

// ---------------- Santa tracker ----------------
const route = (() => {
  const year = new Date().getFullYear();
  const list = content.cities.slice().sort((a, b) => b.utc - a.utc || b.lon - a.lon);
  const byZone = {};
  for (const c of list) (byZone[c.utc] ||= []).push(c);
  const stops = [];
  for (const c of list) {
    const zone = byZone[c.utc];
    const k = zone.indexOf(c) / Math.max(1, zone.length);
    stops.push({ ...c, at: (y) => Date.UTC(y, 11, 25, 0, 0) - c.utc * 3600e3 + k * 50 * 60e3 });
  }
  return stops;
})();
let santaPreview = null; // { started, speed }
function santaClock() {
  const now = Date.now();
  const y = new Date().getFullYear();
  if (santaPreview) {
    const start = route[0].at(y) - 20 * 60e3;
    const t = start + (now - santaPreview.started) * santaPreview.speed;
    if (t > route[route.length - 1].at(y) + 30 * 60e3) { santaPreview = null; return now; }
    return t;
  }
  return now;
}
function santaStatus() {
  const y = new Date().getFullYear();
  const t = santaClock();
  const first = route[0].at(y), last = route[route.length - 1].at(y);
  const home = config.settings.home;
  const homeEta = Date.UTC(y, 11, 25, 0, 0) - home.utc * 3600e3 + 30 * 60e3;
  const base = { preview: !!santaPreview, now: t, homeEta, home: home.name, total: route.length };
  if (t < first) {
    const hrs = (first - t) / 3600e3;
    return { ...base, active: false, phase: 'prep', message: hrs < 30 ? 'Santa is loading the sleigh at the North Pole.' : 'The elves are still building toys at the North Pole.', startsAt: first, city: 'North Pole', country: '', lat: 90, lon: 0, visited: 0, giftsDelivered: 0, distanceKm: 0 };
  }
  if (t > last + 45 * 60e3) return { ...base, active: false, phase: 'done', message: 'Santa is back at the North Pole, fast asleep.', city: 'North Pole', lat: 90, lon: 0, visited: route.length, giftsDelivered: 2.2e9, distanceKm: 510000000 / 1000 };
  let i = 0;
  while (i < route.length - 1 && route[i + 1].at(y) <= t) i++;
  const cur = route[i], nxt = route[i + 1] || null;
  const seg = nxt ? Math.max(0, Math.min(1, (t - cur.at(y)) / (nxt.at(y) - cur.at(y)))) : 1;
  const lat = nxt ? cur.lat + (nxt.lat - cur.lat) * seg : cur.lat;
  let dl = nxt ? nxt.lon - cur.lon : 0; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
  const lon = cur.lon + dl * seg;
  const frac = (t - first) / (last - first);
  return {
    ...base, active: true, phase: 'flying', city: cur.name, country: cur.country, note: cur.note, nextCity: nxt?.name || 'North Pole', nextCountry: nxt?.country || '',
    lat, lon, visited: i + 1, giftsDelivered: Math.round(2.2e9 * Math.pow(Math.max(0, frac), 1.1)), distanceKm: Math.round(frac * 510000),
    trail: route.slice(Math.max(0, i - 25), i + 1).map(c => [c.lat, c.lon]), message: `Santa just left ${cur.name}.`,
  };
}
app.route('GET', '/api/santa/route', (req, res) => sendJson(res, { stops: route.map(c => ({ name: c.name, country: c.country, lat: c.lat, lon: c.lon })) }));
setInterval(() => {
  if (state.tv.scene === 'santa' || santaPreview || (new Date().getMonth() === 11 && [24, 25].includes(new Date().getDate()))) { state.santa = santaStatus(); app.changed(); }
}, 1000);

// ---------------- countdown / advent ----------------
function countdown() {
  const now = new Date();
  const y = now.getMonth() === 11 && now.getDate() > 25 ? now.getFullYear() + 1 : now.getFullYear();
  const target = new Date(y, 11, 25, 0, 0, 0);
  const ms = Math.max(0, target - now);
  const isChristmas = now.getMonth() === 11 && now.getDate() === 25;
  return { target: target.getTime(), days: Math.floor(ms / 864e5), hours: Math.floor(ms / 36e5) % 24, minutes: Math.floor(ms / 6e4) % 60, seconds: Math.floor(ms / 1e3) % 60, isChristmas, isEve: now.getMonth() === 11 && now.getDate() === 24 };
}
function adventToday() {
  const now = new Date();
  if (now.getMonth() !== 11 || now.getDate() > 25) return { none: true, day: 0, startsIn: countdown().days - 24 };
  return content.advent.find(d => d.day === now.getDate()) || { none: true };
}

// ---------------- jokes, scanner, elf names, secret santa ----------------
let jokeTimer = null;
const recentJokes = [];
function randomJoke() {
  let j, guard = 0;
  do { j = content.jokes[Math.floor(Math.random() * content.jokes.length)]; } while (recentJokes.includes(j) && guard++ < 50);
  recentJokes.push(j); if (recentJokes.length > 60) recentJokes.shift();
  return j;
}
function tellJoke(args = {}) {
  const j = args.q ? args : randomJoke();
  const isKnock = j.kind === 'knock';
  state.joke = { q: j.q, a: j.a, kind: j.kind, phase: 'setup', at: Date.now() };
  setTvScene('joke');
  app.sfx('drumroll');
  const say = config.settings.alexaJokes && app.alexa.ready && args.say !== false;
  if (say) app.alexa.speak(isKnock ? `Knock knock. Who's there? ${j.q}. ${j.q} who?` : j.q).catch(() => { });
  clearTimeout(jokeTimer);
  jokeTimer = setTimeout(() => {
    state.joke = { ...state.joke, phase: 'punch', at: Date.now() };
    app.sfx('rimshot');
    app.lights.overlay({ kind: 'burst', color: '#ffd36b', dur: 1.6 });
    if (say) app.alexa.speak(j.a).catch(() => { });
    app.changed();
    jokeTimer = setTimeout(() => { if (state.tv.scene === 'joke') { state.joke = null; setTvScene(backScene()); } }, 15000);
  }, isKnock ? 6500 : 4800);
  app.changed();
  return { ok: true, q: j.q, a: j.a, kind: j.kind };
}
function hashStr(s) { let h = 2166136261; for (const ch of String(s).toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function elfName(name) {
  const e = content.elf;
  const h = name ? hashStr(name) : Math.floor(Math.random() * 1e9);
  return { elf: `${e.first[h % e.first.length]} ${e.last[(h >>> 8) % e.last.length]}`, job: e.jobs[(h >>> 16) % e.jobs.length] };
}
function drawSecretSanta(names, exclusions = []) {
  names = [...new Set(names.map(n => String(n).trim()).filter(Boolean))];
  if (names.length < 3) throw new Error('Add at least 3 people.');
  const bad = new Set(exclusions.flatMap(([a, b]) => [`${a}>${b}`, `${b}>${a}`]));
  for (let tries = 0; tries < 5000; tries++) {
    const perm = names.slice().sort(() => Math.random() - 0.5);
    if (names.every((n, i) => perm[i] !== n && !bad.has(`${n}>${perm[i]}`))) {
      const pairs = Object.fromEntries(names.map((n, i) => [n, perm[i]]));
      fs.writeFileSync(path.join(DATA, 'secret-santa.json'), JSON.stringify({ pairs, at: Date.now() }));
      state.secretSanta = { names, drawnAt: Date.now(), revealed: [] };
      config.secretSanta = { names, exclusions, revealed: [] };
      saveConfig();
      app.changed();
      return { ok: true };
    }
  }
  throw new Error('Those rules make a draw impossible. Remove a rule.');
}

// ---------------- scenes ----------------
let goodnightTimer = null;
async function scene(name) {
  clearTimeout(goodnightTimer);
  if (name === 'showtime') {
    cec('on 0').then(() => cec('as'));
    app.lights.overlay({ kind: 'dim', value: 0.05, dur: 3 });
    setTimeout(() => playShow(null, { playlist: true, delay: 2000 }), 2500);
    return { ok: true, say: 'Showtime! Dim the lights.' };
  }
  if (name === 'party') {
    state.lights.power = true;
    radioPlay('xmasrocks');
    app.lights.overlay({ kind: 'burst', color: '#ffffff', dur: 2 });
    return { ok: true, say: 'Party mode is on at the North Pole!' };
  }
  if (name === 'cozy') {
    stopShow(); radioPlay('christmas');
    config.lights.effect = 'fireplace'; saveConfig(); state.lights = { ...state.lights, power: true, effect: 'fireplace' };
    setTvScene('yule');
    return { ok: true, say: 'Cozy mode. Grab a blanket.' };
  }
  if (name === 'goodnight') {
    stopShow(); radioStop();
    if (app.alexa.ready || app.alexa.vmReady) app.alexa.speak(`Goodnight from the North Pole. ${countdown().days > 0 ? `Only ${countdown().days} more sleeps until Christmas.` : 'Merry Christmas!'}`, { announce: true }).catch(() => { });
    state.lights = { ...state.lights, power: true, effect: 'breathe', color: '#ff8a3a' };
    setTvScene('countdown');
    const mins = config.settings.goodnightMinutes || 20;
    goodnightTimer = setTimeout(() => { state.lights.power = false; cec('standby 0'); app.changed(); }, mins * 60e3);
    app.changed();
    return { ok: true, say: `Goodnight! The tree turns off in ${mins} minutes.` };
  }
  throw new Error('Unknown scene');
}

// ---------------- LED panel (CoolLED via led-calendar, optional) ----------------
async function ledPanelCountdown() {
  const lp = config.ledPanel;
  if (!lp.on || !lp.url) return { ok: false, note: 'LED panel is off in settings.' };
  const c = countdown();
  const text = c.isChristmas ? 'MERRY CHRISTMAS' : c.days === 0 ? 'CHRISTMAS EVE' : `${c.days} ${c.days === 1 ? 'SLEEP' : 'SLEEPS'} TO XMAS`;
  const tomorrow = new Date(); tomorrow.setHours(23, 59, 0, 0);
  const until = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60e3).toISOString().slice(0, 19);
  const r = await fetch(`${lp.url}/api/cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'message', text, color: 'rose', icon: 'star', until }) });
  return { ok: r.ok, text };
}

// ---------------- schedule ----------------
setInterval(() => {
  const s = config.schedule;
  if (!s.enabled) return;
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (hm === s.on && !state.lights.power) { state.lights.power = true; app.changed(); log('schedule: on'); }
  if (hm === s.off && state.lights.power) { state.lights.power = false; stopShow(); app.changed(); log('schedule: off'); }
  if (hm === '00:01' && config.ledPanel.on) ledPanelCountdown().catch(() => { });
}, 30000);

// ---------------- actions (one place for the iPad, the API, Alexa and the skill) ----------------
const actions = {
  'lights.set'(a) {
    const L = state.lights;
    if (a.power !== undefined) L.power = !!a.power;
    if (a.effect !== undefined) {
      if (!hasEffect(a.effect) || a.effect === 'mapping' || (a.effect === 'show' && !state.show.playing)) throw new Error(`Can't use effect ${a.effect} now`);
      if (state.show.playing && a.effect !== 'show') stopShow();
      L.effect = a.effect; L.power = true;
    }
    if (a.color !== undefined && /^#[0-9a-f]{6}$/i.test(a.color)) { L.color = a.color; if (a.effect === undefined && !['breathe', 'solid'].includes(L.effect)) L.effect = 'solid'; L.power = true; }
    if (a.brightness !== undefined) L.brightness = Math.max(0.02, Math.min(1, +a.brightness));
    if (a.speed !== undefined) L.speed = Math.max(0.2, Math.min(3, +a.speed));
    if (!['show', 'react', 'paint', 'mapping'].includes(L.effect)) config.lights = { power: L.power, effect: L.effect, color: L.color, brightness: L.brightness, speed: L.speed };
    else config.lights = { ...config.lights, power: L.power, brightness: L.brightness };
    saveConfig(); app.changed();
    return { ok: true };
  },
  'lights.get'() { const L = state.lights; return { power: L.power, effect: L.effect, color: L.color, brightness: L.brightness }; },
  'effects.list'() { return { effects: EFFECTS }; },
  'fx.flash'(a) { app.lights.overlay({ kind: a.kind || 'flash', color: a.color || '#ffffff', color2: a.color2, value: a.value, dur: Math.min(10, +a.dur || 1) }); return { ok: true }; },
  'paint.stroke'(a) { if (state.lights.effect !== 'paint') { state.lights.effect = 'paint'; state.lights.power = true; app.changed(); } app.lights.paintStroke(a.points || [], a.color, a.radius, a.erase); return { ok: true }; },
  'paint.fill'(a) { app.lights.paintFill(a.color); if (state.lights.effect !== 'paint') { state.lights.effect = 'paint'; app.changed(); } return { ok: true }; },
  'paint.exit'() { if (state.lights.effect === 'paint') { state.lights.effect = baseEffect(); app.changed(); } return { ok: true }; },
  'lights.restore'() { if (['react', 'paint', 'show'].includes(state.lights.effect)) { state.lights.effect = baseEffect(); app.changed(); } return { ok: true }; },

  'show.play'(a) { return playShow(a.song, { lyrics: a.lyrics, playlist: !!a.playlist || !!a.random && !a.song }); },
  'show.stop'() { stopShow(); return { ok: true }; },
  'songs.list'() { return { songs: app.songList() }; },

  'tv.scene'(a) { setTvScene(a.scene === 'home' ? 'home' : a.scene); return { ok: true }; },
  'tv.message'(a) { state.tv.message = { text: String(a.text || '').slice(0, 120), from: String(a.from || '').slice(0, 30), at: Date.now() }; setTvScene('message'); returnLater('message', 25000); if (a.announce && (app.alexa.ready || app.alexa.vmReady)) app.alexa.speak(state.tv.message.text, { announce: true }).catch(() => { }); app.lights.overlay({ kind: 'burst', color: '#ffd36b', dur: 2 }); return { ok: true }; },
  // TV control: Roku over Wi-Fi first (reliable, can pick the input), HDMI-CEC as the fallback
  async 'tv.power'(a) {
    let r = { ok: false };
    if (config.roku?.host || ON_PI) {
      r = await app.roku.key(a.on ? 'PowerOn' : 'PowerOff');
      if (r.ok && a.on && config.roku?.piInput) { await new Promise(res => setTimeout(res, 2500)); await app.roku.showPi(); }
    }
    if (!r.ok) { const c = await cec(a.on ? 'on 0' : 'standby 0'); if (a.on) await cec('as'); if (c.ok) r = c; else r.note = r.note || c.note; }
    state.tv.power = !!a.on; app.changed();
    return r;
  },
  async 'tv.input'() { const r = config.roku?.piInput ? await app.roku.showPi() : { ok: false }; return r.ok ? r : (await cec('as')).ok ? { ok: true } : r; },
  async 'tv.findRoku'() { const host = await app.roku.discover(); return host ? { ok: true, model: config.roku.model } : { ok: false, note: 'No Roku TV found. Is it on and on the same Wi-Fi as the Pi?' }; },
  async 'tv.detectInput'() { return app.roku.detectPiInput(); },
  'tv.setInput'(a) { return app.roku.setPiInput(a.input); },
  async 'tv.rokuTest'() { return app.roku.key('PowerOn'); }, // harmless when the TV is already on; tells us if the TV allows control
  // open / close the full-screen TV page on the Pi's own screen
  'tv.kiosk'(a) {
    if (!ON_PI) return { ok: false, note: 'This only works on the Pi.' };
    const uid = process.getuid?.() ?? 1000;
    const env = { ...process.env, WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
    const script = path.join(ROOT, 'pi', a.open ? 'kiosk.sh' : 'tv-close.sh');
    // run it in the desktop session (systemd --user), so it isn't tied to this server's service
    const p = spawn('systemd-run', ['--user', '--collect', '--quiet', 'sh', script], { env, stdio: 'ignore', detached: true });
    p.on('error', () => spawn('sh', [script], { env, stdio: 'ignore', detached: true }).unref());
    p.unref();
    return { ok: true };
  },

  'radio.play'(a) { return radioPlay(a.channel); },
  'radio.stop'() { return radioStop(); },
  'radio.channels'() { return { channels: Object.entries(RADIO).map(([id, v]) => ({ id, ...v })) }; },

  'joke.random'() { const j = randomJoke(); return { q: j.q, a: j.a, kind: j.kind }; },
  'joke.tell'(a) { return tellJoke(a); },
  countdown() { return countdown(); },
  'santa.status'() { return santaStatus(); },
  'santa.preview'(a) { santaPreview = a.stop ? null : { started: Date.now(), speed: Math.max(60, Math.min(3000, +a.speed || 520)) }; state.santa = santaStatus(); if (!a.stop) setTvScene('santa'); app.changed(); return { ok: true }; },
  'advent.today'() { return adventToday(); },
  'advent.open'(a) { const d = content.advent.find(x => x.day === (a.day | 0)); if (!d) throw new Error('No such day'); state.tv.advent = d; setTvScene('advent'); actions['lights.set']({ effect: d.effect }); app.lights.overlay({ kind: 'burst', color: d.color, dur: 2 }); return { ok: true, ...d }; },
  'elf.name'(a) { return elfName(a.name); },
  'scanner.start'(a) { state.scanner = { phase: 'scanning', name: String(a.name || '').slice(0, 20), at: Date.now() }; setTvScene('scanner'); app.lights.overlay({ kind: 'sweep', color: '#5cff9a', dur: 6 }); app.sfx('scan'); return { ok: true }; },
  'scanner.result'(a) {
    const lines = content.nice;
    const border = a.borderline && lines.borderline.length;
    const pool = border ? lines.borderline : lines.nice;
    const verdict = pool[Math.floor(Math.random() * pool.length)];
    const elf = elfName(a.name || state.scanner?.name);
    // the photo stays in memory only (never written to disk), served to the TV by id
    let photoId = null;
    if (typeof a.photo === 'string' && /^data:image\/jpeg;base64,/.test(a.photo) && a.photo.length < 600000) {
      photoId = Math.random().toString(36).slice(2, 10);
      photos.set(photoId, Buffer.from(a.photo.split(',')[1], 'base64'));
      while (photos.size > 16) photos.delete(photos.keys().next().value);
    }
    state.scanner = { phase: 'result', name: String(a.name || state.scanner?.name || '').slice(0, 20), verdict, elf, borderline: !!border, at: Date.now(), photoId };
    state.niceList = [{ name: state.scanner.name, elf: elf.elf, job: elf.job, photoId, borderline: !!border, at: Date.now() }, ...(state.niceList || [])].slice(0, 12);
    app.lights.clearOverlays('sweep');
    app.lights.overlay({ kind: 'wipe', color: '#1fd16b', dur: 1.2, hold: 2 });
    setTimeout(() => app.lights.overlay({ kind: 'burst', color: '#ffffff', dur: 2 }), 1300);
    app.sfx('nice');
    setTvScene('scanner'); returnLater('scanner', 25000);
    return { ok: true, ...state.scanner };
  },
  'secretsanta.draw'(a) { return drawSecretSanta(a.names || [], a.exclusions || []); },
  'secretsanta.reset'() { try { fs.unlinkSync(path.join(DATA, 'secret-santa.json')); } catch { } state.secretSanta = null; delete config.secretSanta; saveConfig(); app.changed(); return { ok: true }; },

  'game.start'(a) { app.games.start(a.kind, a); return { ok: true, joinUrl: joinUrl() }; },
  'game.next'(a) { const g = state.game; if (g && a.round !== undefined && (a.round !== g.round || a.phase !== g.phase)) return { ok: true, ignored: true }; app.games.next(); return { ok: true }; },
  'game.reveal'(a) { const g = state.game; if (g && a.round !== undefined && a.round !== g.round) return { ok: true, ignored: true }; if (g?.kind === 'trivia') app.games.triviaReveal(); else if (g?.kind === 'pictionary') app.games.pictReveal(); else if (g?.kind === 'would-you-rather') app.games.wyrReveal(); else if (g?.kind === 'name-that-song') app.games.songReveal(null); return { ok: true }; },
  'game.end'() { app.games.end(); return { ok: true }; },
  'game.kick'(a) { app.games.kick(a.id); return { ok: true }; },
  // pass-the-iPad play: the iPad acts for whichever person is holding it
  'game.addPlayer'(a) { const p = app.games.addLocal(a.name, a.team); return { ok: true, id: p.id }; },
  'game.answer'(a) { app.games.triviaAnswer(String(a.pid), a.choice); return { ok: true }; },
  'game.vote'(a) { app.games.vote(String(a.pid), a.side); return { ok: true }; },
  'game.buzz'(a) { app.games.buzz(String(a.pid)); return { ok: true }; },
  'game.pick'(a) { if (Number.isInteger(a.choice)) app.games.songJudge(String(a.pid), a.choice); return { ok: true }; },
  'game.award'(a) { app.games.award(String(a.pid)); return { ok: true }; },
  'game.drawReady'() { app.games.drawReady(); return { ok: true }; },
  'game.teams'(a) { config.settings.teams = Math.max(2, Math.min(4, a.teams | 0)); saveConfig(); app.changed(); return { ok: true }; },
  'game.setTeam'(a) { const p = app.games.players.get(a.id); if (p && TEAMS.some(t => t.id === a.team)) { p.team = a.team; app.games.syncPlayers(); } return { ok: true }; },

  async 'alexa.text'(a) { await app.alexa.text(a.text); return { ok: true }; },
  async 'alexa.speak'(a) { await app.alexa.speak(a.text, { announce: !!a.announce }); return { ok: true }; },
  async 'alexa.command'(a) { await app.alexa.command(a.command, a.value); return { ok: true }; },
  'alexa.connect'() { app.alexa.start(); return { ok: true }; },
  'alexa.signout'() { app.alexa.signOut(); return { ok: true }; },
  'alexa.device'(a) { config.alexa.device = a.serial; saveConfig(); app.alexa.push(); return { ok: true }; },

  'scene.showtime'() { return scene('showtime'); },
  'scene.party'() { return scene('party'); },
  'scene.cozy'() { return scene('cozy'); },
  'scene.goodnight'() { return scene('goodnight'); },
  'ledpanel.countdown'() { return ledPanelCountdown(); },

  'map.start'() { state.map = { active: true, index: -1 }; app.lights.mapIndex = -1; app.changed(); return { ok: true, count: config.hw.count }; },
  'map.index'(a) { app.lights.mapIndex = a.index | 0; state.map = { active: true, index: a.index | 0 }; return { ok: true }; },
  'map.save'(a) {
    const pts = a.points;
    if (!Array.isArray(pts) || pts.length !== config.hw.count) throw new Error(`Need ${config.hw.count} points`);
    config.hw.layout = pts.map(p => ({ x: +p.x, y: +p.y, mapped: !!p.found }));
    app.lights.mapIndex = -1; state.map = null; saveConfig(); app.lights.applyLayout(); app.changed();
    return { ok: true };
  },
  'map.cancel'() { app.lights.mapIndex = -1; state.map = null; app.changed(); return { ok: true }; },
  'map.clear'() { config.hw.layout = null; saveConfig(); app.lights.applyLayout(); app.changed(); return { ok: true }; },

  'settings.set'(a) {
    for (const k of ['family', 'remoteUrl', 'physicalTree', 'lightDelayMs', 'showAudio', 'alexaJokes', 'joinUrl', 'goodnightMinutes', 'phones']) if (a[k] !== undefined) config.settings[k] = a[k];
    if (a.teams !== undefined) config.settings.teams = Math.max(2, Math.min(4, a.teams | 0));
    if (a.home && typeof a.home.lat === 'number') config.settings.home = a.home;
    if (a.schedule) config.schedule = { ...config.schedule, ...a.schedule };
    if (a.ledPanel) config.ledPanel = { ...config.ledPanel, ...a.ledPanel };
    if (a.voiceMonkey) { config.voiceMonkey = { ...config.voiceMonkey, ...a.voiceMonkey }; app.alexa.push(); }
    saveConfig(); app.changed();
    return { ok: true };
  },
  'hw.set'(a) {
    if (a.count !== undefined) { const n = Math.max(1, Math.min(1000, a.count | 0)); if (n !== config.hw.count) { config.hw.count = n; config.hw.layout = null; } }
    if (a.turns !== undefined) config.hw.turns = Math.max(2, Math.min(30, +a.turns));
    if (Array.isArray(a.outputs)) config.hw.outputs = a.outputs.map(o => ({ type: o.type, host: String(o.host || '').trim(), port: o.port | 0, on: !!o.on }));
    saveConfig(); app.lights.applyLayout(); app.changed();
    return { ok: true };
  },
  status() { return { ok: true, onPi: ON_PI, uptime: process.uptime(), clients: clients.size, lights: state.lights, version: 1 }; },

  // ---------- AI (Claude Haiku) ----------
  'ai.setKey'(a) { app.ai.setKey(a.key); return { ok: true, configured: app.ai.configured }; },
  'ai.setCap'(a) { const v = Math.max(0.5, Math.min(100, +a.capUsd || 5)); config.ai = { ...config.ai, capUsd: v }; saveConfig(); app.ai.push(); return { ok: true }; },
  'ai.usage'() { return app.ai.usage(); },
  // a free sample (no API call) so the family can see what each AI elf does before a key is added
  'ai.demo'(a) {
    const kind = ['report', 'madlibs', 'santa'].includes(a.kind) ? a.kind : 'report';
    if (kind === 'report') showAi('report', { name: 'Grandma', card: { title: 'Chief Cookie Quality Inspector', grades: [{ subject: 'Advanced Snickerdoodles', grade: 'A+', note: 'Tested 40 batches. Demands a recount.' }, { subject: 'Gift Wrapping Physics', grade: 'B', note: 'Bows are perfect. Tape usage is a crime scene.' }, { subject: 'Reindeer Diplomacy', grade: 'Gold Star', note: 'Talked Dasher out of a snack strike.' }, { subject: 'Staying Up for Santa', grade: 'C-', note: 'Asleep by 8:15. Snoring was festive.' }], santaNote: "Grandma, the elves want your recipe and I want your patience. Nice List, top shelf, as always." } });
    else if (kind === 'madlibs') showAi('madlibs', { title: 'The Night the Llama Took the Sleigh', story: 'On Christmas Eve, Grandma heard a loud [[BOING]] coming from [[the laundry room]]. She found [[a llama]] [[moonwalking]] across the dryer, wearing a [[sparkly]] scarf and holding [[a rubber chicken]]. "I am the new reindeer," it said, "and I eat only [[mashed potatoes]]." Dad offered it [[47]] marshmallows instead. The llama accepted, hopped onto the roof and pulled Santa\'s sleigh all the way to Ohio and back before breakfast. By morning, everyone agreed it was the best Christmas Eve on record, even if the dryer now plays carols when you open it.' });
    else showAi('santa', { asker: 'Lily', question: 'How do the reindeer fly?', answer: 'Ho ho ho! Every reindeer gets one magic acorn on Christmas Eve, and Mrs. Claus bakes it into a cookie. Rudolph always asks for two, so we keep a spare in my left boot.' });
    return { ok: true, demo: true };
  },
  async 'ai.reportCard'(a) {
    const name = String(a.name || '').trim().slice(0, 24);
    if (!name) throw new Error('Pick who the report card is for.');
    const card = await app.ai.reportCard({ name, cookie: String(a.cookie || '').slice(0, 60), proud: String(a.proud || '').slice(0, 120), confess: String(a.confess || '').slice(0, 120) });
    card.grades = (card.grades || []).slice(0, 4);
    showAi('report', { name, card });
    if (a.read !== false) alexaRead(`Elf report card for ${name}. ${card.title}. ${card.santaNote}`);
    return { ok: true, card };
  },
  async 'ai.madlibs'(a) {
    const names = (state.players || []).map(p => p.name).slice(0, 8);
    const out = await app.ai.madlibs({ words: a.words || {}, names });
    showAi('madlibs', { title: out.title, story: out.story });
    if (a.read !== false) alexaRead(`${out.title}. ${out.story.replace(/\[\[|\]\]/g, '')}`);
    return { ok: true, ...out };
  },
  async 'ai.story'(a) {
    const names = (state.players || []).map(p => p.name).slice(0, 8);
    const pool = ['a runaway sled', 'a sneezing reindeer', 'forty-seven marshmallows', 'a tiny top hat', 'a singing toaster', 'a snowman with a cold', 'a glitter explosion', 'a confused penguin', 'a lost mitten', 'a jingling sock', 'a candy cane sword', 'a very loud bell'];
    const words = pool.sort(() => Math.random() - 0.5).slice(0, 4);
    const out = await app.ai.story({ names, words });
    showAi('madlibs', { title: out.title, story: out.story });
    if (a.read !== false) alexaRead(`${out.title}. ${out.story}`);
    return { ok: true, ...out };
  },
  async 'ai.askSanta'(a) {
    const question = String(a.question || '').trim().slice(0, 300);
    if (!question) throw new Error('Type a question for Santa.');
    const answer = await app.ai.askSanta({ question, asker: String(a.asker || '').slice(0, 24) });
    showAi('santa', { question, asker: String(a.asker || '').slice(0, 24), answer });
    if (a.read !== false) alexaRead(/^\W*ho,? ho/i.test(answer) ? answer : `Ho ho ho! ${answer}`);
    return { ok: true, answer };
  },

  // ---------- setup checklist (manual ticks; the rest is detected live) ----------
  'setup.tick'(a) { config.setupDone = { ...config.setupDone, [String(a.id).slice(0, 30)]: !!a.done }; saveConfig(); app.changed(); return { ok: true }; },
};
app.act = async (name, args = {}) => {
  const fn = actions[name];
  if (!fn) throw new Error(`Unknown action ${name}`);
  return fn(args || {});
};

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
function sendJson(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function qrSvg(text) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(String(text).slice(0, 300));
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff8ec"/><path d="${d}" fill="#14281d"/></svg>`;
}
const PAGES = { '/': 'web/index.html', '/tv': 'web/tv.html', '/play': 'web/play.html', '/charades': 'web/charades.html' };

// Public-traffic guard. If the Pi's Tailscale ever exposes this server to the internet (Funnel, for the
// Alexa skill), those requests arrive from tailscaled on 127.0.0.1 WITH X-Forwarded-For but WITHOUT a
// Tailscale-User-Login identity (Serve adds that for the family's own devices and strips any spoofed copy).
// Such requests may reach only the Alexa skill endpoint. The TV kiosk (local, no X-Forwarded-For) and
// LAN devices are unaffected.
export function isPublic(req) {
  const ra = req.socket?.remoteAddress || '';
  const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  return local && !!req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
}
const PUBLIC_OK = new Set(['/alexa/skill']);
app.isPublic = isPublic;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end('Bad URL'); return; }
  if (isPublic(req) && !PUBLIC_OK.has(p)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Private'); return; }
  if (p === '/api/whoami') return sendJson(res, { public: isPublic(req), via: req.headers['x-forwarded-for'] ? 'proxy' : 'direct', user: req.headers['tailscale-user-login'] ? 'tailnet member' : null });
  try {
    for (const r of app.routes) {
      if (r.method === req.method && (r.path === p || (r.path.endsWith('*') && p.startsWith(r.path.slice(0, -1))))) {
        const body = await readBody(req);
        return await r.handler(req, res, { url, body, json: () => JSON.parse(body.toString('utf8') || '{}') });
      }
    }
    if (PAGES[p]) return serveFile(res, path.join(ROOT, PAGES[p]));
    if (p === '/api/state') return sendJson(res, snapshot());
    if (p === '/api/help') return sendJson(res, { actions: Object.keys(actions), post: '/api/act/<name> with a JSON body' });
    if (p.startsWith('/api/act/') && req.method === 'POST') {
      const name = p.slice('/api/act/'.length);
      const body = await readBody(req);
      let args = {};
      try { args = JSON.parse(body.toString('utf8') || '{}'); } catch { return sendJson(res, { error: 'bad JSON' }, 400); }
      try { return sendJson(res, (await app.act(name, args)) || { ok: true }); } catch (e) { log('act failed', name, '-', e.message); return sendJson(res, { error: e.message }, 400); }
    }
    if (p === '/api/qr.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' }); return res.end(qrSvg(url.searchParams.get('d') || joinUrl())); }
    if (p === '/api/songs') return sendJson(res, { songs: app.songList() });
    if (p.startsWith('/api/photo/')) { const b = photos.get(p.slice(11)); if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(b); }
    if (p === '/api/layout') return sendJson(res, { layout: app.lights.layout.map(q => ({ x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(3), a: +q.a.toFixed(4), u: +q.u.toFixed(4) })) });
    if (p.startsWith('/api/song/')) { const e = songs.get(p.slice(10)); return e ? sendJson(res, { song: e.song }) : sendJson(res, { error: 'not found' }, 404); }
    if (p === '/api/content') return sendJson(res, { facts: content.advent.map(a => a.fact).filter(Boolean), charades: content.charades, pictionaryCount: content.pictionary.length, advent: content.advent, effects: EFFECTS, radio: Object.entries(RADIO).map(([id, v]) => ({ id, ...v })), jokes: content.jokes.length, trivia: content.trivia.length, hits: content.hits.length });
    if (p.startsWith('/radio/')) return proxyRadio(req, res, p.slice(7));
    if (p === '/api/secretsanta/reveal' && req.method === 'POST') {
      const { name } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      let pairs = {};
      try { pairs = JSON.parse(fs.readFileSync(path.join(DATA, 'secret-santa.json'), 'utf8')).pairs; } catch { return sendJson(res, { error: 'No draw yet' }, 404); }
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(pairs, name)) return sendJson(res, { error: 'Name not in the draw' }, 404);
      if (state.secretSanta && !state.secretSanta.revealed.includes(name)) { state.secretSanta.revealed.push(name); config.secretSanta.revealed = state.secretSanta.revealed; saveConfig(); app.changed(); }
      return sendJson(res, { giver: name, receiver: pairs[name] });
    }
    for (const dir of ['web', 'shared', 'content', 'docs']) {
      if (p.startsWith(`/${dir}/`)) {
        const file = path.normalize(path.join(ROOT, p));
        if (!file.startsWith(path.join(ROOT, dir) + path.sep)) break;
        return serveFile(res, file);
      }
    }
    if (p === '/manifest.webmanifest') return serveFile(res, path.join(ROOT, 'web', 'manifest.webmanifest'));
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    log('http', p, e.stack || e.message);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500); else res.end();
  }
});
function readBody(req) {
  return new Promise(resolve => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(Buffer.alloc(0));
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size < 2e6) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ---------------- WebSocket ----------------
let clientSeq = 0;
const PLAYER_ACTS = new Set(['fx.flash', 'elf.name', 'joke.random', 'countdown']);
attachWebSocket(server, '/ws', ws => {
  const role = ['tv', 'remote', 'player'].includes(ws.url.searchParams.get('role')) ? ws.url.searchParams.get('role') : 'remote';
  const c = { ws, role, id: ++clientSeq, frames: false, audio: false, pid: ws.url.searchParams.get('pid') || null };
  clients.add(c);
  if (role === 'player' && c.pid) app.games.attach(ws, c.pid);
  ws.send(JSON.stringify({ type: 'hello', id: c.id, serverTime: Date.now() }));
  ws.send(JSON.stringify({ type: 'state', state: snapshot() }));
  app.changed();
  ws.on('close', () => { clients.delete(c); app.changed(); });
  ws.on('message', async (data, binary) => {
    if (binary) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', c: m.c, s: Date.now() })); return; }
    if (m.type === 'frames') { c.frames = !!m.on; return; }
    if (m.type === 'audio-out') { c.audio = !!m.on; return; }
    if (m.type === 'audio') { app.lights.setAudio(m); return; }
    if (m.type === 'perf' && role === 'tv') { state.tv.fps = Math.max(0, Math.min(120, m.fps | 0)); state.tv.fpsScene = String(m.scene || '').slice(0, 20); app.changed(); return; }
    if (m.type === 'stroke') { if (role !== 'player') app.games.stroke({ ...m.stroke, from: c.id }); return; }
    if (role === 'player' && m.type !== 'act') { if (c.pid) app.games.onPlayerMessage(ws, c.pid, m); return; }
    if (m.type === 'act') {
      if (role === 'player' && !PLAYER_ACTS.has(m.name)) { ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'Not allowed' })); return; }
      try { const data = await app.act(m.name, m.args); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: data || { ok: true } })); }
      catch (e) { log('act failed', m.name, '-', e.message); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: e.message })); }
    }
  });
}, { reject: isPublic });
setInterval(() => { for (const c of clients) { if (Date.now() - c.ws.lastSeen > 60000) c.ws.close(); else c.ws.ping(); } }, 20000);

// ---------------- optional modules (Alexa local devices + North Pole skill) ----------------
for (const mod of ['hue.mjs', 'alexa-skill.mjs']) {
  const file = path.join(ROOT, 'server', mod);
  if (!fs.existsSync(file)) continue;
  import('./' + mod).then(m => m.install?.(app)).then(() => log('module', mod, 'ready')).catch(e => log('module', mod, 'failed:', e.message));
}

if (config.secretSanta) state.secretSanta = { names: config.secretSanta.names, drawnAt: 1, revealed: config.secretSanta.revealed || [] };
server.listen(PORT, '0.0.0.0', () => {
  log(`North Pole Control on http://localhost:${PORT}  (LAN ${joinUrl().replace('/play', '')})  pi=${ON_PI}`);
  if (config.alexa.enabled && fs.existsSync(path.join(DATA, 'alexa-cookie.json'))) app.alexa.start();
});
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled', e?.stack || e));
