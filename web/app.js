// North Pole Control - the iPad / phone control center.
import { connect, $, $$, h, esc } from '/web/lib/net.js';
import { TreeView, MiniTree } from '/web/lib/tree.js';
import { Sound, Listener } from '/web/lib/audio.js';
import { icon } from '/web/lib/icons.js';
import { EFFECTS, makeEffect, spiralLayout } from '/shared/effects.mjs';
import { buildTimeline } from '/shared/song.mjs';

let S = null;                     // latest server state
let content = { advent: [], effects: EFFECTS, radio: [], charades: [] };
let songs = [];
const sound = new Sound();
const tree = new TreeView($('#tree'));
let layoutKey = '';
const ui = { tab: 'lights', paint: null, secretWord: null, peek: false, listening: null, playLocal: false };
try { ui.tab = localStorage.getItem('np-tab') || 'lights'; } catch { }

const net = connect({
  role: 'remote', frames: true,
  onState: st => { S = st; render(); },
  onFrame: bytes => tree.setFrame(bytes),
  onStatus: on => { $('#linkDot').classList.toggle('on', on); if (!on) $('#nowLabel').textContent = 'Reconnecting'; },
  onMessage: m => {
    if (m.type === 'secret') { ui.secretWord = m.word; renderGames(true); }
    if (m.type === 'sfx' && ui.playLocal) sound.sfx(m.name);
  },
});
window.__np = { net, tree, get state() { return S; } };

const toastEl = $('#toast');
let toastT = 0;
function toast(msg, err = false) { toastEl.textContent = msg; toastEl.className = `toast show${err ? ' err' : ''}`; clearTimeout(toastT); toastT = setTimeout(() => (toastEl.className = 'toast'), 2600); }
async function act(name, args, okMsg) {
  try { const r = await net.act(name, args); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}

// ---------------- tabs ----------------
const TABS = [['lights', 'Lights', 'tree'], ['music', 'Music', 'music'], ['games', 'Games', 'games'], ['fun', 'Fun', 'gift'], ['tv', 'TV', 'tv'], ['setup', 'Setup', 'gear']];
$('#tabs').innerHTML = TABS.map(([id, label, ic]) => `<button class="tab" data-tab="${id}">${icon(ic)}<span>${label}</span></button>`).join('');
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
function setTab(id) {
  ui.tab = id;
  try { localStorage.setItem('np-tab', id); } catch { }
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  $$('.view').forEach(v => v.classList.toggle('on', v.dataset.view === id));
  $('#views').scrollTop = 0;
  render();
}

// ---------------- stage (tree, power, brightness) ----------------
$('#briIcon').innerHTML = icon('sparkle');
$('#power').innerHTML = icon('power');
$('#power').onclick = () => act('lights.set', { power: !S?.lights.power });
let briT = 0;
$('#bri').oninput = e => { clearTimeout(briT); const v = e.target.value / 100; briT = setTimeout(() => act('lights.set', { brightness: v }), 60); };

async function loadLayout() {
  const r = await fetch('/api/layout').then(r => r.json());
  tree.setLayout(r.layout);
}
function renderStage() {
  if (!S) return;
  if (S.hw.layoutKey !== layoutKey) { layoutKey = S.hw.layoutKey; loadLayout(); }
  $('#power').classList.toggle('on', !!S.lights.power);
  if (document.activeElement !== $('#bri')) $('#bri').value = Math.round((S.lights.brightness ?? 0.8) * 100);
  const eff = EFFECTS.find(e => e.id === S.lights.effect);
  let label = 'On the tree', name = eff?.name || S.lights.effect;
  if (!S.lights.power) { label = 'Tree is off'; name = 'Lights out'; }
  else if (S.show.playing) { label = 'Light show'; name = S.show.title; }
  else if (S.radio.playing) { label = 'Dancing to the radio'; name = S.radio.now?.title || S.radio.name; }
  else if (S.lights.effect === 'react') { label = 'Listening'; name = 'Music mode'; }
  else if (S.lights.effect === 'paint') { label = 'Painted by hand'; name = 'Your design'; }
  else if (S.lights.effect === 'solid') { label = 'One colour'; name = 'Solid'; }
  $('#nowLabel').textContent = label;
  $('#nowName').textContent = name;
  const d = countdown();
  $('#sleeps').innerHTML = d.isChristmas ? '<b>Merry Christmas</b>' : `<b class="num">${d.days === 0 ? 'Tonight' : d.days}</b>${d.days === 0 ? 'Christmas Eve' : d.days === 1 ? 'sleep to go' : 'sleeps to go'}`;
}
function countdown() {
  const now = new Date(net.now());
  const y = now.getMonth() === 11 && now.getDate() > 25 ? now.getFullYear() + 1 : now.getFullYear();
  const ms = Math.max(0, new Date(y, 11, 25) - now);
  return { days: Math.floor(ms / 864e5), isChristmas: now.getMonth() === 11 && now.getDate() === 25 };
}

// ---------------- paint with Pencil on the tree ----------------
const PAINT_COLORS = ['#e8322b', '#24a35a', '#e3ad3a', '#ffffff', '#3a7be0', '#b04ad8', '#ff8a2a'];
function startPaint() {
  ui.paint = { color: PAINT_COLORS[0], erase: false };
  const wrap = $('#treeWrap');
  wrap.classList.add('painting');
  const bar = h('div', { class: 'paintbar', id: 'paintbar' });
  const draw = () => {
    bar.innerHTML = PAINT_COLORS.map(c => `<button class="chip${!ui.paint.erase && ui.paint.color === c ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('') +
      `<button class="tool${ui.paint.erase ? ' on' : ''}" data-t="erase" aria-label="Eraser">${icon('eraser')}</button>` +
      `<button class="tool" data-t="fill" aria-label="Fill">${icon('wand')}</button>` +
      `<button class="done" data-t="done">Done</button>`;
  };
  draw();
  bar.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { ui.paint.color = b.dataset.c; ui.paint.erase = false; }
    else if (b.dataset.t === 'erase') ui.paint.erase = !ui.paint.erase;
    else if (b.dataset.t === 'fill') act('paint.fill', { color: ui.paint.erase ? null : ui.paint.color });
    else if (b.dataset.t === 'done') return stopPaint();
    draw();
  };
  wrap.append(bar);
  act('paint.fill', { color: null });
  let pts = [], down = false, last = 0;
  const flush = () => { if (pts.length) { net.send({ type: 'act', id: 0, name: 'paint.stroke', args: { points: pts, color: ui.paint.color, erase: ui.paint.erase, radius: 0.085 } }); pts = []; } };
  ui.paint.handlers = {
    down: e => { if (e.target.closest('.paintbar')) return; down = true; wrap.setPointerCapture(e.pointerId); pts.push(tree.toTree(e.clientX, e.clientY)); flush(); },
    move: e => { if (!down) return; for (const ev of e.getCoalescedEvents?.() || [e]) pts.push(tree.toTree(ev.clientX, ev.clientY)); if (performance.now() - last > 40) { last = performance.now(); flush(); } },
    up: () => { down = false; flush(); },
  };
  wrap.addEventListener('pointerdown', ui.paint.handlers.down);
  wrap.addEventListener('pointermove', ui.paint.handlers.move);
  wrap.addEventListener('pointerup', ui.paint.handlers.up);
  wrap.addEventListener('pointercancel', ui.paint.handlers.up);
  toast('Draw on the tree. The real lights follow.');
}
function stopPaint() {
  const wrap = $('#treeWrap');
  if (ui.paint?.handlers) for (const [k, ev] of [['down', 'pointerdown'], ['move', 'pointermove'], ['up', 'pointerup'], ['up', 'pointercancel']]) wrap.removeEventListener(ev, ui.paint.handlers[k]);
  ui.paint = null;
  wrap.classList.remove('painting');
  $('#paintbar')?.remove();
  render();
}

// ---------------- LIGHTS ----------------
const SWATCH_COLORS = [['#e8322b', 'Cranberry'], ['#ff6a1f', 'Ember'], ['#e3ad3a', 'Gold'], ['#ffb45c', 'Warm white'], ['#e9f1ff', 'Snow'], ['#1f9a52', 'Pine'], ['#2fd17c', 'Mint'], ['#7cc8ff', 'Ice'], ['#2e5ee0', 'Royal'], ['#e65a9b', 'Rose'], ['#9a4ae0', 'Plum']];
let minis = [];
function buildLights() {
  const v = $('[data-view=lights]');
  v.innerHTML = `
    <div class="sec">
      <div class="sec-head"><h2>Scenes</h2><span class="aside">One tap sets the whole room</span></div>
      <div class="scenes">
        <button class="scene hot" data-scene="showtime">${icon('star')}<div><b>Showtime</b><span>TV on, lights down, carols with a light show</span></div></button>
        <button class="scene" data-scene="party">${icon('sparkle')}<div><b>Party</b><span>Christmas rock radio, tree dances to it</span></div></button>
        <button class="scene" data-scene="cozy">${icon('fire')}<div><b>Cozy</b><span>Yule log on the TV, fireplace glow, lounge music</span></div></button>
        <button class="scene" data-scene="goodnight">${icon('moon')}<div><b>Goodnight</b><span>Soft glow, Alexa says goodnight, off later</span></div></button>
      </div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Effects</h2><button class="btn sm" id="paintBtn">${icon('pencil')}Paint the tree</button></div>
      <div class="bulbs" id="bulbs">${EFFECTS.map(e => `<button class="bulb" data-fx="${e.id}"><canvas></canvas><span>${e.name}</span></button>`).join('')}</div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>One colour</h2><span class="aside" id="colorAside">Tap to fill the tree</span></div>
      <div class="chips" id="chips">${SWATCH_COLORS.map(([c, n]) => `<button class="chip" title="${n}" data-color="${c}" style="background:${c}"></button>`).join('')}
        <label class="chip-input" title="Any colour">${icon('plus')}<input type="color" id="anyColor" value="#ff3b2f"></label></div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Moments</h2><span class="aside">Play over whatever is running</span></div>
      <div class="btns">
        <button class="btn" data-fx-flash="burst">${icon('sparkle')}Sparkle burst</button>
        <button class="btn" data-fx-flash="flash">${icon('star')}Gold flash</button>
        <button class="btn" data-fx-flash="wipe">${icon('candy')}Red fill</button>
        <button class="btn" data-fx-flash="sweep">${icon('scan')}Scan</button>
      </div>
    </div>`;
  v.querySelector('.scenes').onclick = e => { const b = e.target.closest('[data-scene]'); if (b) act(`scene.${b.dataset.scene}`, {}, r => r.say || 'Done'); };
  $('#bulbs').onclick = e => { const b = e.target.closest('[data-fx]'); if (b) { if (ui.paint) stopPaint(); act('lights.set', { effect: b.dataset.fx }); } };
  $('#chips').onclick = e => { const b = e.target.closest('[data-color]'); if (b) setColor(b.dataset.color); };
  $('#anyColor').oninput = e => setColor(e.target.value);
  $('#paintBtn').onclick = () => (ui.paint ? stopPaint() : startPaint());
  v.querySelectorAll('[data-fx-flash]').forEach(b => (b.onclick = () => {
    const kind = b.dataset.fxFlash;
    act('fx.flash', { kind, color: kind === 'flash' ? '#ffcf5a' : kind === 'wipe' ? '#e8322b' : kind === 'sweep' ? '#5cff9a' : '#ffffff', dur: kind === 'wipe' ? 2.5 : kind === 'sweep' ? 5 : 1.6 });
  }));
  const lay = spiralLayout(34, 6);
  minis = $$('#bulbs canvas').map((c, i) => ({ mini: new MiniTree(c, lay), fn: makeEffect(EFFECTS[i].id), out: new Float32Array(34 * 3) }));
}
function setColor(c) {
  const breathe = S?.lights.effect === 'breathe';
  act('lights.set', breathe ? { color: c, effect: 'breathe' } : { color: c, effect: 'solid' });
}
function renderLights() {
  if (!S) return;
  $$('#bulbs .bulb').forEach(b => b.classList.toggle('on', S.lights.power && b.dataset.fx === S.lights.effect));
  $$('#chips .chip').forEach(b => b.classList.toggle('on', ['solid', 'breathe'].includes(S.lights.effect) && b.dataset.color === S.lights.color));
  $('#colorAside').textContent = S.lights.effect === 'breathe' ? 'Sets the breathing colour' : 'Tap to fill the tree';
  $('#paintBtn').innerHTML = ui.paint ? `${icon('check')}Done painting` : `${icon('pencil')}Paint the tree`;
}
let miniT = 0, miniLast = performance.now();
function animateMinis(now) {
  requestAnimationFrame(animateMinis);
  if (ui.tab !== 'lights' || now - miniLast < 50 || document.hidden) return;
  const dt = (now - miniLast) / 1000; miniLast = now; miniT += dt;
  for (const m of minis) {
    m.fn({ n: 34, t: miniT, dt, pos: m.mini.layout, out: m.out, params: { color: S?.lights.color || '#ff3b2f' }, audio: { bass: 0.5 + 0.5 * Math.sin(miniT * 4), level: 0.5, high: 0.3, beat: Math.sin(miniT * 4) > 0.97 }, note: null });
    m.mini.draw(m.out);
  }
}
requestAnimationFrame(animateMinis);

// ---------------- MUSIC ----------------
function buildMusic() {
  const v = $('[data-view=music]');
  v.innerHTML = `
    <div class="sec">
      <div class="sec-head"><h2>Light shows</h2><button class="btn sm" id="playAll">${icon('play')}Play them all</button></div>
      <p class="hint">Carols play on the TV while every note lights the tree: low notes at the bottom, high notes at the top, chords change the colour.</p>
      <div id="showNow"></div>
      <div class="rows" id="songRows"></div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Christmas radio</h2><span class="aside">Real songs on the TV. The tree dances.</span></div>
      <div id="radioNow"></div>
      <div class="rows" id="radioRows"></div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Alexa</h2><span class="status" id="alexaStatus"></span></div>
      <div id="alexaBox"></div>
    </div>
    <div class="sec">
      <div class="sec-head"><h2>Tree listens</h2><button class="switch" id="listenSw" aria-label="Listen"></button></div>
      <p class="hint">Uses this device's microphone so the tree dances to anything playing in the room, including the Echo. Leave the iPad near the speaker.</p>
    </div>`;
  $('#playAll').onclick = () => act('show.play', { playlist: true }, 'Light show starting on the TV');
  $('#songRows').onclick = e => {
    const r = e.target.closest('[data-song]'); if (!r) return;
    if (S.show.playing && S.show.songId === r.dataset.song) act('show.stop'); else act('show.play', { song: r.dataset.song }, 'Starting on the TV');
  };
  $('#radioRows').onclick = e => { const r = e.target.closest('[data-ch]'); if (!r) return; if (S.radio.playing && S.radio.channel === r.dataset.ch) act('radio.stop'); else act('radio.play', { channel: r.dataset.ch }); };
  $('#listenSw').onclick = toggleListen;
}
function renderMusic() {
  if (!S) return;
  const show = S.show;
  $('#showNow').innerHTML = show.playing ? `<div class="nowbar"><div class="art">${icon('music')}</div><div class="grow"><div class="t">${esc(show.title)}</div><div class="s">${esc(show.by || '')}${show.playlist ? ' · playing all' : ''}</div></div><button class="btn sm" id="stopShow">${icon('stop')}Stop</button></div>` : '';
  if (show.playing) $('#stopShow').onclick = () => act('show.stop');
  $('#songRows').innerHTML = songs.map(s => `<div class="row${show.playing && show.songId === s.id ? ' playing' : ''}" data-song="${s.id}" role="button">
      <div class="lead">${icon(show.playing && show.songId === s.id ? 'stop' : 'play')}</div>
      <div class="grow"><div class="t">${esc(s.title)}</div><div class="s">${esc(s.by)}${s.year ? ', ' + s.year : ''}</div></div>
      <span class="tag">${s.instrumental ? 'instrumental' : s.mood}</span><span class="num muted">${Math.floor(s.secs / 60)}:${String(s.secs % 60).padStart(2, '0')}</span></div>`).join('');
  const r = S.radio;
  $('#radioNow').innerHTML = r.playing ? `<div class="nowbar"><div class="art" style="${r.now?.art ? `background-image:url('${esc(r.now.art)}')` : ''}">${r.now?.art ? '' : icon('speaker')}</div><div class="grow"><div class="t">${esc(r.now?.title || r.name)}</div><div class="s">${esc(r.now?.artist || 'Tuning in')} · ${esc(r.name)}</div></div><button class="btn sm" id="stopRadio">${icon('stop')}Stop</button></div>` : '';
  if (r.playing) $('#stopRadio').onclick = () => act('radio.stop');
  $('#radioRows').innerHTML = (content.radio || []).map(c => `<div class="row${r.playing && r.channel === c.id ? ' playing' : ''}" data-ch="${c.id}" role="button"><div class="lead">${icon(r.playing && r.channel === c.id ? 'stop' : 'speaker')}</div><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.blurb)}</div></div></div>`).join('');
  renderAlexa();
  $('#listenSw').classList.toggle('on', !!ui.listening);
}
function renderAlexa() {
  const a = S.alexa || {};
  const st = $('#alexaStatus');
  const label = { ready: 'Connected', login: 'Waiting for sign-in', connecting: 'Connecting', error: 'Problem', off: 'Not connected', missing: 'Not installed' }[a.status] || a.status;
  st.textContent = a.voiceMonkey && !a.ready ? 'Voice Monkey only' : label;
  st.className = `status ${a.ready ? 'ok' : a.status === 'error' ? 'bad' : a.status === 'login' || a.voiceMonkey ? 'warn' : ''}`;
  const box = $('#alexaBox');
  const sig = JSON.stringify([a.status, a.device, a.devices?.length, a.nowPlaying, a.voiceMonkey, a.error]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!a.ready) {
    box.innerHTML = `<div class="box">
      ${a.status === 'login' ? `<p class="hint" style="margin-top:0">Sign in to Amazon once on this page (open it on any device on your Wi-Fi). The app then controls your Echo.</p><div class="btns"><a class="btn light" href="${esc(a.loginUrl)}" target="_blank" rel="noopener">${icon('link')}Open Amazon sign-in</a><button class="btn" id="alexaRetry">Check again</button></div><p class="hint mt">${esc(a.loginUrl)}</p>`
        : `<p class="hint" style="margin-top:0">Connect your Amazon account so the app can play music on the Echo, pause it for games, read jokes and make announcements.</p><button class="btn light" id="alexaConnect">${icon('link')}Connect Alexa</button>`}
      ${a.error ? `<p class="hint mt" style="color:#ff8a80">${esc(a.error)}</p>` : ''}
      ${a.voiceMonkey ? `<div class="sep"></div><p class="hint">Voice Monkey is set up, so announcements already work.</p>${announceForm()}` : ''}
    </div>`;
    $('#alexaConnect') && ($('#alexaConnect').onclick = () => act('alexa.connect', {}, 'Starting Amazon sign-in'));
    $('#alexaRetry') && ($('#alexaRetry').onclick = () => act('alexa.connect'));
    bindAnnounce();
    return;
  }
  const np = a.nowPlaying;
  box.innerHTML = `
    ${np?.title ? `<div class="nowbar"><div class="art" style="${np.art ? `background-image:url('${esc(np.art)}')` : ''}">${np.art ? '' : icon('speaker')}</div><div class="grow"><div class="t">${esc(np.title)}</div><div class="s">${esc(np.artist)} · ${esc(np.state?.toLowerCase() || '')}</div></div></div>` : ''}
    <label class="field"><span>Echo</span><select id="alexaDev">${(a.devices || []).map(d => `<option value="${d.serial}"${d.serial === a.device ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
    <div class="btns">
      <button class="btn light" data-say="play christmas music">${icon('music')}Christmas music</button>
      <button class="btn" data-cmd="pause">${icon('pause')}</button>
      <button class="btn" data-cmd="play">${icon('play')}</button>
      <button class="btn" data-cmd="next">${icon('next')}</button>
      <button class="btn" data-vol="-1">${icon('minus')}</button>
      <button class="btn" data-vol="1">${icon('plus')}</button>
    </div>
    <div class="btns mt">
      <button class="btn sm" data-say="play christmas classics">Classics</button>
      <button class="btn sm" data-say="play michael buble christmas">Bublé</button>
      <button class="btn sm" data-say="play christmas jazz">Jazz</button>
      <button class="btn sm" data-say="play kids christmas songs">Kids</button>
      <button class="btn sm" data-say="play the sound of a crackling fireplace">Fireplace sounds</button>
    </div>
    <label class="field mt"><span>Tell Alexa anything (typed, she does it without anyone talking)</span>
      <div class="inline"><input type="text" id="alexaText" placeholder="play Mariah Carey All I Want for Christmas"><button class="btn" id="alexaSend">Send</button></div></label>
    ${announceForm()}`;
  $('#alexaDev').onchange = e => act('alexa.device', { serial: e.target.value });
  box.querySelectorAll('[data-say]').forEach(b => (b.onclick = () => act('alexa.text', { text: b.dataset.say }, 'Sent to Alexa')));
  box.querySelectorAll('[data-cmd]').forEach(b => (b.onclick = () => act('alexa.command', { command: b.dataset.cmd })));
  let vol = 40;
  box.querySelectorAll('[data-vol]').forEach(b => (b.onclick = () => { vol = Math.max(0, Math.min(100, vol + 10 * b.dataset.vol)); act('alexa.command', { command: 'volume', value: vol }, `Volume ${vol}`); }));
  const send = () => { const t = $('#alexaText').value.trim(); if (t) act('alexa.text', { text: t }, 'Sent to Alexa').then(() => ($('#alexaText').value = '')); };
  $('#alexaSend').onclick = send;
  $('#alexaText').onkeydown = e => e.key === 'Enter' && send();
  bindAnnounce();
}
function announceForm() {
  return `<label class="field mt"><span>Announce on every Echo</span><div class="inline"><input type="text" id="annText" placeholder="Cookies are out of the oven!"><button class="btn" id="annSend">${icon('bell')}</button></div></label>
  <div class="btns"><button class="btn sm" data-ann="Ho ho ho! Santa here. I hear this house has been very nice this year.">Santa says hi</button><button class="btn sm" data-ann="Attention elves. Dinner is ready. Report to the kitchen.">Dinner</button><button class="btn sm" data-ann="Elf patrol reminder: Santa can see you. Keep it nice!">Elf patrol</button></div>`;
}
function bindAnnounce() {
  const go = t => act('alexa.speak', { text: t, announce: true }, 'Announced');
  $('#annSend') && ($('#annSend').onclick = () => { const t = $('#annText').value.trim(); if (t) go(t).then(() => ($('#annText').value = '')); });
  $$('[data-ann]').forEach(b => (b.onclick = () => go(b.dataset.ann)));
}
async function toggleListen() {
  if (ui.listening) { ui.listening.stop(); ui.listening.stream.getTracks().forEach(t => t.stop()); ui.listening = null; act('lights.restore'); renderMusic(); return; }
  try {
    await sound.unlock();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = sound.ctx.createMediaStreamSource(stream);
    const L = new Listener(sound.ctx, src, lv => net.send({ type: 'audio', bass: lv.bass, mid: lv.mid, high: lv.high, level: lv.level, beat: lv.beat }));
    L.stream = stream;
    ui.listening = L;
    act('lights.set', { effect: 'react' }, 'The tree is listening');
  } catch (e) { toast(location.protocol === 'https:' ? 'Microphone was blocked.' : 'Mic needs the https:// (Tailscale) address.', true); }
  renderMusic();
}

// ---------------- GAMES ----------------
// Everyone plays on this iPad (pass it around). Phones are optional (Setup switch in the Players box).
const GAMES = [
  ['trivia', 'Trivia Showdown', 'Question on the TV. Pass the iPad: each person taps their answer in secret.', 'star'],
  ['name-that-song', 'Name That Song', 'Alexa plays a real Christmas hit. Slap your name on the iPad to buzz in.', 'music'],
  ['would-you-rather', 'Would You Rather', 'Everyone picks A or B. The tree splits red and green to show the room.', 'shuffle'],
  ['pictionary', 'Pictionary', 'Take turns drawing on the iPad with the Pencil. Everyone guesses out loud.', 'pencil'],
];
const GAME_NAMES = Object.fromEntries(GAMES.map(g => [g[0], g[1]]));
const ANS = ['#d6312b', '#1f9a52', '#c98d16', '#3a7be0'];
let lastGameSig = '';
ui.newTeam = null;
ui.votes = {};
ui.voteRound = '';
function buildGames() { renderGames(true); }
const teamOf = id => S.teams.find(t => t.id === id) || { color: '#888', name: '' };
function rosterHtml() {
  const team = teamOf;
  const add = `<div class="addp"><input type="text" id="newName" placeholder="Add a player" maxlength="16" autocomplete="off"><div class="addteams">${S.teams.map(t => `<button class="chip${(ui.newTeam || S.teams[0].id) === t.id ? ' on' : ''}" data-nt="${t.id}" title="${esc(t.name)}" style="background:${t.color};width:34px;height:34px"></button>`).join('')}</div><button class="btn light" id="addP">Add</button></div>`;
  const list = S.players.length
    ? `<div class="players mt">${S.players.map(p => `<span class="player${p.online ? '' : ' off'}"><button class="pteam" data-pid="${p.id}" title="Switch team"><i style="background:${team(p.team).color}"></i>${esc(p.name)}</button><span class="num muted">${p.score || ''}</span>${p.local ? `<button class="px" data-del="${p.id}" aria-label="Remove ${esc(p.name)}">${icon('x')}</button>` : '<span class="tag">phone</span>'}</span>`).join('')}</div><p class="hint mt">Tap a name to switch teams.</p>`
    : '<p class="hint mt">Add everyone who is playing. They are remembered for next time.</p>';
  const teams = `<div class="btns mt">${[2, 3, 4].map(n => `<button class="btn sm${S.teams.length === n ? ' light' : ''}" data-teams="${n}">${n} teams</button>`).join('')}</div>`;
  const phones = `<label class="inline mt" style="gap:10px"><button class="switch${S.settings.phones ? ' on' : ''}" id="phonesSw"></button><span class="muted">Let people with phones play on their own phone too</span></label>${S.settings.phones ? `<div class="join mt"><img alt="Join code" src="/api/qr.svg?d=${encodeURIComponent(S.joinUrl)}"><div><div class="muted" style="font-size:13px">Phones on the home Wi-Fi join at</div><div class="url">${esc(S.joinUrl)}</div></div></div>` : ''}`;
  return add + list + teams + phones;
}
function bindRoster(v) {
  const addNow = () => { const n = $('#newName').value.trim(); if (!n) return; act('game.addPlayer', { name: n, team: ui.newTeam || S.teams[0].id }).then(() => { $('#newName').value = ''; $('#newName').focus(); }); };
  $('#addP').onclick = addNow;
  $('#newName').onkeydown = e => e.key === 'Enter' && addNow();
  v.querySelectorAll('[data-nt]').forEach(b => (b.onclick = () => { ui.newTeam = b.dataset.nt; v.querySelectorAll('[data-nt]').forEach(x => x.classList.toggle('on', x === b)); }));
  v.querySelectorAll('[data-teams]').forEach(b => (b.onclick = () => act('game.teams', { teams: +b.dataset.teams })));
  v.querySelectorAll('[data-pid]').forEach(b => (b.onclick = () => { const p = S.players.find(x => x.id === b.dataset.pid); if (!p) return; const ids = S.teams.map(t => t.id); act('game.setTeam', { id: p.id, team: ids[(ids.indexOf(p.team) + 1) % ids.length] }); }));
  v.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => act('game.kick', { id: b.dataset.del })));
  $('#phonesSw').onclick = () => act('settings.set', { phones: !S.settings.phones });
}
function renderGames(force) {
  if (!S) return;
  const g = S.game;
  const sig = JSON.stringify([g, S.players, S.teams, ui.secretWord, S.alexa?.ready, S.settings.phones, ui.votes]);
  if (!force && sig === lastGameSig) return;
  lastGameSig = sig;
  const v = $('[data-view=games]');
  const typing = document.activeElement?.id === 'newName' ? $('#newName').value : null;
  if (g?.kind === 'pictionary' && g.phase === 'draw' && $('#drawpad')) { renderHostBits(); return; }
  if (!g) {
    v.innerHTML = `
      <div class="sec"><div class="sec-head"><h2>Game night</h2><span class="aside">Board on the TV, play on this iPad</span></div>
        <div class="rows game-list">${GAMES.map(([id, name, blurb, ic]) => `<div class="row big"><div class="lead">${icon(ic)}</div><div class="grow"><div class="t">${name}</div><div class="s" style="white-space:normal">${blurb}${id === 'name-that-song' && !S.alexa?.ready ? ' Without Alexa it plays the carols on the TV.' : ''}</div></div><button class="btn primary" data-start="${id}"${S.players.length ? '' : ' disabled'}>Start</button></div>`).join('')}
        <div class="row big"><div class="lead">${icon('people')}</div><div class="grow"><div class="t">Charades</div><div class="s" style="white-space:normal">Hold the iPad (or a phone) on your forehead while the family acts it out.</div></div><a class="btn" href="/charades" target="_blank">Open</a></div></div>
      </div>
      <div class="sec"><div class="sec-head"><h2>Players</h2><span class="aside">${S.players.length} playing</span></div>${rosterHtml()}</div>`;
    bindRoster(v);
  } else {
    v.innerHTML = `<div class="sec"><div class="host"><div class="host-top"><div><div class="host-meta">${GAME_NAMES[g.kind]} · ${g.phase === 'lobby' ? 'ready to start' : g.phase === 'final' ? 'final scores' : `round ${g.round} of ${g.total}`}</div><h3 id="hostTitle"></h3></div><div class="btns" id="hostBtns"></div></div><div class="host-body" id="hostBody"></div></div></div>
      <div class="sec"><div class="sec-head"><h2>Players</h2><span class="aside">${S.players.length} playing</span></div>${rosterHtml()}</div>`;
    bindRoster(v);
    renderHostBits(true);
  }
  v.querySelectorAll('[data-start]').forEach(b => (b.onclick = async () => { ui.secretWord = null; await act('game.start', { kind: b.dataset.start }); }));
  if (typing !== null) { $('#newName').value = typing; $('#newName').focus(); }
}
function renderHostBits(full) {
  const g = S.game; if (!g) return;
  const title = $('#hostTitle'), body = $('#hostBody'), btns = $('#hostBtns');
  const nextLabel = g.phase === 'lobby' ? 'Start round 1' : g.round >= g.total && g.phase === 'reveal' ? 'Final scores' : 'Next';
  btns.innerHTML = `${g.phase !== 'final' ? `<button class="btn primary" id="gNext">${nextLabel}</button>` : `<button class="btn primary" id="gAgain">Play again</button>`}${['question', 'vote', 'draw', 'playing', 'buzzed', 'pass'].includes(g.phase) ? '<button class="btn" id="gReveal">Reveal</button>' : ''}<button class="btn ghost" id="gEnd">End</button>`;
  $('#gNext') && ($('#gNext').onclick = () => act('game.next', { round: g.round, phase: g.phase }));
  $('#gAgain') && ($('#gAgain').onclick = () => act('game.start', { kind: g.kind }));
  $('#gReveal') && ($('#gReveal').onclick = () => act('game.reveal', { round: g.round }));
  $('#gEnd').onclick = () => { ui.secretWord = null; act('game.end'); };
  const scores = g.teamScores || teamTotals();
  const scoreline = `<div class="scoreline">${S.teams.map(t => `<span style="color:${t.color}">${t.name} ${scores[t.id] || 0}</span>`).join('')}</div>`;
  const locals = S.players.filter(p => p.local);
  if (g.phase === 'lobby') { title.textContent = 'Everyone ready?'; body.innerHTML = `<p class="hint" style="margin:0">${S.players.length} playing. Add anyone missing below, then start.</p>`; return; }
  if (g.phase === 'final') { const w = S.teams.find(t => t.id === g.winner); title.textContent = w ? `${w.name} wins` : 'Final scores'; body.innerHTML = scoreline; return; }

  if (g.kind === 'trivia') {
    title.textContent = g.category || 'Trivia';
    if (g.phase === 'question') {
      const next = locals.find(p => !g.answered.includes(p.id));
      body.innerHTML = `<div class="host-q">${esc(g.q)}</div>` + (next
        ? `<div class="turn" style="border-color:${teamOf(next.team).color}"><div class="turn-name" style="color:${teamOf(next.team).color}">${esc(next.name)}'s turn</div><div class="host-meta">Tap your answer, then pass the iPad.</div>
            <div class="bigans">${g.choices.map((c, i) => `<button class="bans" data-ans="${i}" style="background:${ANS[i]}"><b>${'ABCD'[i]}</b>${esc(c)}</button>`).join('')}</div>
            <button class="btn sm ghost mt" id="skipP">Skip ${esc(next.name)}</button></div>`
        : `<p class="host-meta">Everyone has answered. Revealing…</p>`);
      body.querySelectorAll('[data-ans]').forEach(b => (b.onclick = () => { act('game.answer', { pid: next.id, choice: +b.dataset.ans }); body.querySelector('.bigans').innerHTML = `<div class="locked">Locked in. Pass the iPad${locals.find(p => p.id !== next.id && !g.answered.includes(p.id)) ? ` to ${esc(locals.find(p => p.id !== next.id && !g.answered.includes(p.id)).name)}` : ''}.</div>`; }));
      $('#skipP') && ($('#skipP').onclick = () => act('game.answer', { pid: next.id, choice: -1 }).then(() => { if (locals.every(p => p.id === next.id || g.answered.includes(p.id))) act('game.reveal', { round: g.round }); }));
    } else {
      const got = Object.keys(g.gained || {}).map(id => S.players.find(p => p.id === id)?.name).filter(Boolean);
      body.innerHTML = `<div class="host-q">${esc(g.q)}</div><div class="answer-line">${esc(g.choices[g.answer])}</div><p class="host-meta">${got.length ? `Got it: ${got.map(esc).join(', ')}` : 'Nobody got it'}</p><p class="host-meta">${esc(g.fact || '')}</p>${scoreline}`;
    }
  } else if (g.kind === 'name-that-song') {
    if (g.phase === 'playing') {
      title.textContent = 'Know it? Slap your name!';
      body.innerHTML = `<div class="buzzers">${S.players.map(p => `<button class="buzzer" data-buzz="${p.id}" style="background:${teamOf(p.team).color}"${(g.wrong || []).includes(p.id) ? ' disabled' : ''}>${esc(p.name)}</button>`).join('')}</div><p class="host-meta mt">${g.source === 'alexa' ? 'Playing on Alexa.' : 'Playing a carol on the TV.'} A wrong guess locks you out for this song.</p>`;
      body.querySelectorAll('[data-buzz]').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); act('game.buzz', { pid: b.dataset.buzz }); }));
    } else if (g.phase === 'buzzed') {
      const p = S.players.find(x => x.id === g.buzz.pid);
      title.textContent = `${g.buzz.name} buzzed in`;
      body.innerHTML = p?.local || !p ? `<div class="turn" style="border-color:${teamOf(g.buzz.team).color}"><div class="turn-name" style="color:${teamOf(g.buzz.team).color}">${esc(g.buzz.name)}, which song?</div><div class="bigans">${g.choices.map((c, i) => `<button class="bans" data-pick="${i}" style="background:${ANS[i]}"><b>${'ABCD'[i]}</b><span>${esc(c.title)}${c.artist ? `<small>${esc(c.artist)}</small>` : ''}</span></button>`).join('')}</div></div>` : `<p class="host-meta">Waiting for ${esc(g.buzz.name)} to pick on their phone…</p>`;
      body.querySelectorAll('[data-pick]').forEach(b => (b.onclick = () => act('game.pick', { pid: g.buzz.pid, choice: +b.dataset.pick })));
    } else {
      title.textContent = g.item?.title || '';
      body.innerHTML = `<p class="host-meta" style="margin-top:0">${esc(g.item?.artist || '')}${g.winner ? ` · ${esc(S.players.find(p => p.id === g.winner)?.name || '')} got it` : ' · nobody got it'}</p>${scoreline}`;
    }
  } else if (g.kind === 'would-you-rather') {
    title.textContent = 'Would you rather…';
    const key = `${g.round}:${g.a}`;
    if (ui.voteRound !== key) { ui.voteRound = key; ui.votes = {}; }
    body.innerHTML = `<div class="two"><div class="box"><b style="color:#ff6a5e">A</b> ${esc(g.a)}${g.result ? `<div class="host-meta mt">${g.result.a.length} votes</div>` : ''}</div><div class="box"><b style="color:#3fd17c">B</b> ${esc(g.b)}${g.result ? `<div class="host-meta mt">${g.result.b.length} votes</div>` : ''}</div></div>` +
      (g.phase === 'vote' ? `<div class="rows mt">${locals.map(p => `<div class="row" style="min-height:52px"><div class="grow"><div class="t"><span style="color:${teamOf(p.team).color}">●</span> ${esc(p.name)}</div></div><button class="btn sm${ui.votes[p.id] === 'a' ? ' primary' : ''}" data-vote="a" data-vp="${p.id}">A</button><button class="btn sm" data-vote="b" data-vp="${p.id}" style="${ui.votes[p.id] === 'b' ? 'background:#1f9a52;border-color:#1f9a52;color:#fff' : ''}">B</button></div>`).join('')}</div>` : '');
    body.querySelectorAll('[data-vote]').forEach(b => (b.onclick = () => { ui.votes[b.dataset.vp] = b.dataset.vote; act('game.vote', { pid: b.dataset.vp, side: b.dataset.vote }); renderGames(true); }));
  } else if (g.kind === 'pictionary') {
    if (g.phase === 'pass') {
      title.textContent = `${g.drawer.name} draws next`;
      body.innerHTML = `<div class="turn" style="border-color:${teamOf(g.drawer.team).color}"><div class="turn-name" style="color:${teamOf(g.drawer.team).color}">Pass the iPad to ${esc(g.drawer.name)}</div><p class="host-meta">Only ${esc(g.drawer.name)} looks at the screen. Everyone else, eyes on the TV.</p><button class="btn primary" id="showWord" style="height:52px;margin-top:6px">I'm ${esc(g.drawer.name)}, show my word</button></div>`;
      $('#showWord').onclick = () => act('game.drawReady');
    } else if (g.phase === 'draw') {
      title.textContent = g.drawer ? `${g.drawer.name}, draw this` : 'Draw this';
      if (full || !$('#drawpad')) {
        body.innerHTML = `<div class="secret" id="secretWord"></div><div class="drawpad" id="drawpad"><canvas></canvas></div><div class="drawtools" id="drawtools"></div><div class="host-meta mt">Someone shouted it? Tap who got it:</div><div class="btns mt" id="awardRow"></div>`;
        setupDrawpad();
      }
      $('#secretWord').textContent = ui.secretWord || '…';
      $('#awardRow').innerHTML = S.players.filter(p => p.id !== g.drawer?.pid).map(p => `<button class="btn" data-award="${p.id}" style="border-color:${teamOf(p.team).color}"><i style="width:10px;height:10px;border-radius:50%;background:${teamOf(p.team).color};display:inline-block"></i>${esc(p.name)}</button>`).join('') + '<button class="btn ghost" id="nobody">Nobody got it</button>';
      $('#awardRow').querySelectorAll('[data-award]').forEach(b => (b.onclick = () => act('game.award', { pid: b.dataset.award })));
      $('#nobody').onclick = () => act('game.reveal', { round: g.round });
    } else {
      title.textContent = g.word ? `It was "${g.word}"` : 'Pictionary';
      body.innerHTML = `${g.correct?.length ? `<p class="host-meta">Got it: ${g.correct.map(c => esc(c.name)).join(', ')}</p>` : '<p class="host-meta">Nobody got it this time.</p>'}${scoreline}`;
    }
  }
}
function teamTotals() { const s = {}; for (const p of S.players) s[p.team] = (s[p.team] || 0) + (p.score || 0); return s; }
function setupDrawpad() {
  const pad = $('#drawpad'), c = pad.querySelector('canvas'), x = c.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  const size = () => { const r = pad.getBoundingClientRect(); c.width = r.width * dpr; c.height = r.height * dpr; x.lineCap = 'round'; x.lineJoin = 'round'; };
  size();
  let col = '#14281d', width = 0.008, cur = null;
  const tools = $('#drawtools');
  const cols = ['#14281d', '#d6312b', '#1f9a52', '#e0a92e', '#3a7be0', '#8a5a2b'];
  const draw = () => { tools.innerHTML = cols.map(k => `<button class="chip${k === col ? ' on' : ''}" style="background:${k};width:32px;height:32px" data-k="${k}"></button>`).join('') + `<button class="btn sm" data-w="0.008">Thin</button><button class="btn sm" data-w="0.02">Thick</button><button class="btn sm" data-k="#fbf5e9">${icon('eraser')}</button><button class="btn sm" id="padClear">Clear</button>`; };
  draw();
  tools.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'padClear') { x.clearRect(0, 0, c.width, c.height); net.send({ type: 'stroke', stroke: { clear: true } }); return; }
    if (b.dataset.k) col = b.dataset.k; if (b.dataset.w) width = +b.dataset.w; draw();
  };
  const pt = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.pressure || 0.5]; };
  const seg = (a, b, w) => { x.strokeStyle = cur.c; x.lineWidth = Math.max(1, w * c.width * (0.5 + b[2])); x.beginPath(); x.moveTo(a[0] * c.width, a[1] * c.height); x.lineTo(b[0] * c.width, b[1] * c.height); x.stroke(); };
  let sent = 0;
  const send = (end) => { if (!cur) return; const pts = cur.p.slice(sent > 0 ? sent - 1 : 0); if (pts.length > 1 || end) net.send({ type: 'stroke', stroke: { c: cur.c, w: cur.w, p: pts.map(q => [+q[0].toFixed(4), +q[1].toFixed(4), +q[2].toFixed(2)]) } }); sent = cur.p.length; };
  pad.onpointerdown = e => { if (e.pointerType === 'touch' && ui.sawPen) return; if (e.pointerType === 'pen') ui.sawPen = true; pad.setPointerCapture(e.pointerId); cur = { c: col, w: width, p: [pt(e)] }; sent = 0; };
  pad.onpointermove = e => { if (!cur) return; for (const ev of e.getCoalescedEvents?.() || [e]) { const p = pt(ev); seg(cur.p[cur.p.length - 1], p, cur.w); cur.p.push(p); } if (cur.p.length - sent > 6) send(); };
  pad.onpointerup = pad.onpointercancel = () => { send(true); cur = null; };
}

// ---------------- FUN ----------------
function buildFun() {
  const v = $('[data-view=fun]');
  v.innerHTML = `
    <div class="sec" id="aiSec"></div>
    <div class="sec"><div class="sec-head"><h2>Joke machine</h2><span class="aside">${content.jokes || 180} jokes</span></div>
      <div class="box"><div id="jokeNow" class="host-q" style="font-size:19px;margin-bottom:12px">Drumroll on the TV, punchline, rimshot, the tree pops.</div>
      <div class="btns"><button class="btn primary" id="jokeTv">${icon('laugh')}Tell one on the TV</button><button class="btn" id="jokeHere">Just show me one</button></div></div></div>
    <div class="sec"><div class="sec-head"><h2>Nice List Scanner</h2><span class="aside">Point the iPad at a kid</span></div>
      <div class="inline"><input type="text" id="scanName" placeholder="Their name"><button class="btn primary" id="scanGo">${icon('scan')}Scan</button></div>
      <p class="hint mt">The camera scans them, the tree sweeps green, and the TV certifies them nice with their official elf name.</p></div>
    <div class="sec"><div class="sec-head"><h2>Advent calendar</h2><button class="btn sm ghost" id="peekBtn">${ui.peek ? 'Hide future days' : 'Peek ahead'}</button></div><div class="advent" id="advent"></div><div id="adventOpen" class="mt"></div></div>
    <div class="sec"><div class="sec-head"><h2>Message on the TV</h2></div>
      <div class="inline"><input type="text" id="msgText" placeholder="Stockings are hung. Everyone to the living room!"><button class="btn" id="msgGo">Show</button></div>
      <label class="inline mt" style="gap:10px"><button class="switch" id="msgAnn"></button><span class="muted">Also announce it on Alexa</span></label></div>
    <div class="sec"><div class="sec-head"><h2>Elf name</h2></div>
      <div class="inline"><input type="text" id="elfName" placeholder="Your first name"><button class="btn" id="elfGo">Get mine</button></div><div id="elfOut" class="mt"></div></div>
    <div class="sec"><div class="sec-head"><h2>Secret Santa</h2><span class="aside" id="ssAside"></span></div><div id="ssBox"></div></div>
    <div class="sec"><div class="sec-head"><h2>Santa tracker</h2></div>
      <p class="hint">On Christmas Eve the TV follows Santa city by city as midnight crosses the world. Try the flight now.</p>
      <div class="btns"><button class="btn" id="santaTv">${icon('globe')}Show on TV</button><button class="btn" id="santaPrev">${icon('sleigh')}Preview the flight</button></div></div>`;
  $('#jokeTv').onclick = () => act('joke.tell', {}).then(j => ($('#jokeNow').innerHTML = `${esc(j.kind === 'knock' ? `Knock knock. ${j.q}…` : j.q)}<div class="muted" style="font-size:16px;margin-top:6px">${esc(j.a)}</div>`));
  $('#jokeHere').onclick = () => act('joke.random').then(j => ($('#jokeNow').innerHTML = `${esc(j.kind === 'knock' ? `Knock knock. Who's there? ${j.q}. ${j.q} who?` : j.q)}<div class="muted" style="font-size:16px;margin-top:6px">${esc(j.a)}</div>`));
  $('#scanGo').onclick = () => openScanner($('#scanName').value.trim());
  $('#peekBtn').onclick = () => { ui.peek = !ui.peek; buildFun(); renderFun(); };
  $('#advent').onclick = e => { const d = e.target.closest('[data-day]'); if (!d) return; if (d.classList.contains('locked')) { toast('Not yet! Opens on December ' + d.dataset.day + '.'); return; } openDoor(+d.dataset.day); };
  let ann = false;
  $('#msgAnn').onclick = e => { ann = !ann; e.currentTarget.classList.toggle('on', ann); };
  $('#msgGo').onclick = () => { const t = $('#msgText').value.trim(); if (t) act('tv.message', { text: t, announce: ann }, 'On the TV').then(() => ($('#msgText').value = '')); };
  $('#elfGo').onclick = () => act('elf.name', { name: $('#elfName').value.trim() }).then(r => ($('#elfOut').innerHTML = `<div class="box"><div class="secret" style="font-size:28px">${esc(r.elf)}</div><div class="muted">${esc(r.job)}</div></div>`));
  $('#santaTv').onclick = () => act('tv.scene', { scene: 'santa' }, 'Santa tracker on the TV');
  $('#santaPrev').onclick = () => act('santa.preview', { speed: 520 }, 'Flight preview: about 3 minutes');
}
function renderFun() {
  if (!S) return;
  const now = new Date(net.now());
  const today = now.getMonth() === 11 ? now.getDate() : 0;
  $('#advent').innerHTML = Array.from({ length: 25 }, (_, i) => i + 1).map(d => {
    const locked = !ui.peek && d > today;
    return `<button class="door${d === today ? ' today' : ''}${d < today ? ' open' : ''}${locked ? ' locked' : ''}" data-day="${d}">${d}${d === 25 ? '<small>Christmas</small>' : d === 24 ? '<small>Eve</small>' : ''}</button>`;
  }).join('');
  const ss = S.secretSanta;
  $('#ssAside').textContent = ss ? `${ss.revealed.length} of ${ss.names.length} have looked` : 'Private draw, revealed on each phone';
  const box = $('#ssBox');
  const sig = JSON.stringify(ss);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!ss) {
    box.innerHTML = `<label class="field"><span>Everyone in the exchange, one per line</span><textarea id="ssNames" placeholder="Mom&#10;Dad&#10;E&#10;Grandma"></textarea></label>
      <label class="field"><span>Pairs who shouldn't draw each other (optional), like "Mom, Dad", one pair per line</span><textarea id="ssEx" style="min-height:60px"></textarea></label>
      <button class="btn primary" id="ssDraw">${icon('shuffle')}Draw names</button>`;
    $('#ssDraw').onclick = () => {
      const names = $('#ssNames').value.split('\n').map(s => s.trim()).filter(Boolean);
      const ex = $('#ssEx').value.split('\n').map(l => l.split(',').map(s => s.trim())).filter(p => p.length === 2 && p[0] && p[1]);
      act('secretsanta.draw', { names, exclusions: ex }, 'Drawn! Everyone opens the join page on their phone.');
    };
  } else {
    box.innerHTML = `<div class="players">${ss.names.map(n => `<span class="player${ss.revealed.includes(n) ? '' : ' off'}"><i style="background:${ss.revealed.includes(n) ? 'var(--green)' : 'var(--dim)'}"></i>${esc(n)}</span>`).join('')}</div>
      <p class="hint mt">Each person opens <span class="num" style="color:var(--gold)">${esc(S.joinUrl)}</span> on their own phone and taps Secret Santa. Nobody else sees the match, including this iPad.</p>
      <button class="btn sm ghost" id="ssReset">Start over</button>`;
    $('#ssReset').onclick = () => confirm('Throw away this draw?') && act('secretsanta.reset');
  }
}
function openDoor(day) {
  const d = content.advent.find(x => x.day === day);
  if (!d) return;
  act('advent.open', { day });
  $('#adventOpen').innerHTML = `<div class="box" style="border-color:${d.color}"><div class="host-meta">December ${d.day}</div><div class="host-q" style="margin:4px 0 8px">${esc(d.title)}</div><p style="margin:0 0 8px">${esc(d.challenge)}</p><p class="muted" style="margin:0">${esc(d.fact)}</p></div>`;
}

// ---------------- Nice List Scanner (camera) ----------------
async function openScanner(name) {
  const ov = h('div', { class: 'overlay' });
  ov.innerHTML = `<video playsinline autoplay muted></video><div class="scan-frame"></div><div class="scanline"></div>
    <div class="ov-top"><b style="font-family:var(--serif);font-size:20px">Nice List Scanner</b><button class="btn sm" id="scanClose">${icon('x')}</button></div>
    <div class="ov-bottom"><div id="scanStatus" style="font-size:17px;font-weight:500">Hold still${name ? ', ' + esc(name) : ''}…</div><div class="meter"><i id="scanMeter"></i></div><div class="muted" id="scanSub">Connecting to the North Pole database</div></div>`;
  document.body.append(ov);
  let stream = null, facing = 'user', photo = null;
  const video = ov.querySelector('video');
  // front camera first (selfie view, mirrored); Flip switches to the back camera
  const startCam = async () => {
    stream?.getTracks().forEach(t => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false });
      video.srcObject = stream;
      video.style.transform = facing === 'user' ? 'scaleX(-1)' : '';
    } catch { video.style.display = 'none'; ov.style.background = 'radial-gradient(circle at 50% 40%, #12351f, #050a07 70%)'; }
  };
  await startCam();
  ov.querySelector('.ov-top').insertAdjacentHTML('beforeend', `<button class="btn sm" id="scanFlip" style="margin-left:auto;margin-right:8px">${icon('camera')}Flip</button>`);
  ov.querySelector('#scanFlip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCam(); };
  const snap = () => {
    if (!video.videoWidth) return null;
    const c = document.createElement('canvas'), w = 640, hgt = Math.round(640 * video.videoHeight / video.videoWidth);
    c.width = w; c.height = hgt;
    const x = c.getContext('2d');
    if (facing === 'user') { x.translate(w, 0); x.scale(-1, 1); }
    x.drawImage(video, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', 0.78);
  };
  const close = () => { stream?.getTracks().forEach(t => t.stop()); ov.remove(); clearInterval(timer); };
  ov.querySelector('#scanClose').onclick = close;
  act('scanner.start', { name });
  const steps = ['Checking cookie-sharing history', 'Counting thank-you notes', 'Reviewing bedtime records', 'Measuring kindness levels', 'Cross-checking with the elves', 'Consulting Santa'];
  let k = 0;
  const timer = setInterval(() => {
    k++;
    ov.querySelector('#scanMeter').style.width = `${Math.min(100, k * 2)}%`;
    ov.querySelector('#scanSub').textContent = steps[Math.min(steps.length - 1, Math.floor(k / 9))];
    if (k === 30) { photo = snap(); if (photo) { const f = ov.querySelector('.scan-frame'); f.style.transition = 'background .1s'; f.style.background = 'rgba(255,255,255,.8)'; setTimeout(() => (f.style.background = ''), 120); } }
    if (k >= 52) {
      clearInterval(timer);
      act('scanner.result', { name, photo }).then(r => {
        ov.querySelector('.scanline')?.remove();
        ov.querySelector('.ov-bottom').innerHTML = `<div class="verdict">${r.borderline ? 'Mostly nice' : 'Certified nice'}</div><p style="font-size:18px;margin:10px 0 6px">${esc(r.verdict)}</p><p class="muted" style="margin:0 0 16px">Official elf name: <b style="color:var(--text)">${esc(r.elf.elf)}</b>, ${esc(r.elf.job)}</p><div class="btns"><button class="btn light" id="scanAgain">Scan someone else</button><button class="btn" id="scanDone">Done</button></div>`;
        ov.querySelector('#scanDone').onclick = close;
        ov.querySelector('#scanAgain').onclick = () => { close(); const n = prompt('Name?') || ''; openScanner(n.trim()); };
      });
    }
  }, 100);
}

// ---------------- TV ----------------
const TV_SCENES = [['home', 'Home', 'Countdown, clock, falling snow, what is playing', 'tree'], ['yule', 'Yule log', 'A crackling fire for the TV', 'fire'], ['countdown', 'Big countdown', 'Days, hours, minutes and seconds', 'calendar'], ['santa', 'Santa tracker', 'Live on Christmas Eve', 'globe'], ['advent', 'Today\'s door', 'The advent calendar on the big screen', 'gift'], ['tree', 'Tree mirror', 'The lights, drawn on the TV', 'sparkle'], ['nicelist', 'Nice List Wall', 'Everyone scanned tonight, in polaroids', 'scan'], ['setup', 'iPad setup code', 'A big code to put this remote on another iPad', 'link']];
function buildTv() {
  const v = $('[data-view=tv]');
  v.innerHTML = `
    <div class="sec"><div class="sec-head"><h2>The TV</h2><span class="status" id="tvStatus"></span></div>
      <div class="btns"><button class="btn" id="tvOn">${icon('power')}Turn on</button><button class="btn" id="tvInput">${icon('tv')}Switch to the Pi</button><button class="btn ghost" id="tvOff">Off</button></div>
      <p class="hint mt" id="tvHint"></p>
      <div class="box mt" id="rokuBox"></div>
      <div class="btns mt"><button class="btn" id="kioskOpen">${icon('tv')}Open the TV screen</button><button class="btn" id="kioskClose">${icon('x')}Close the TV screen</button></div>
      <p class="hint mt">Close shows the Pi's desktop; the lights keep running. On the Pi itself: press Esc, or move the mouse and click Exit.</p></div>
    <div class="sec"><div class="sec-head"><h2>On screen</h2></div><div class="rows" id="tvRows"></div></div>
    <div class="sec"><div class="sec-head"><h2>Sound for shows</h2></div>
      <label class="inline" style="gap:10px"><button class="switch" id="localSw"></button><span class="muted">Play light-show music and game sounds on this device too</span></label></div>`;
  $('#tvOn').onclick = () => act('tv.power', { on: true }, r => (r.ok ? 'TV on' : r.note || 'Sent'));
  $('#tvOff').onclick = () => act('tv.power', { on: false }, r => (r.ok ? 'TV off' : r.note || 'Sent'));
  $('#tvInput').onclick = () => act('tv.input', {}, r => (r.ok ? 'Switched' : r.note || 'Sent'));
  $('#kioskOpen').onclick = () => act('tv.kiosk', { open: true }, r => (r.ok ? 'Opening on the Pi' : r.note));
  $('#kioskClose').onclick = () => act('tv.kiosk', { open: false }, r => (r.ok ? 'Closed. The Pi shows its desktop.' : r.note));
  $('#tvRows').onclick = e => { const r = e.target.closest('[data-scene]'); if (r) act('tv.scene', { scene: r.dataset.scene }); };
  $('#localSw').onclick = async () => { ui.playLocal = !ui.playLocal; if (ui.playLocal) await sound.unlock(); net.send({ type: 'audio-out', on: ui.playLocal }); renderTv(); syncLocalShow(); };
}
function renderTv() {
  if (!S) return;
  const n = S.tv.clients;
  const st = $('#tvStatus');
  st.textContent = n ? `${n} screen${n > 1 ? 's' : ''} connected` : 'No TV connected';
  st.className = `status ${n ? 'ok' : 'warn'}`;
  $('#tvHint').innerHTML = S.onPi ? 'Turn on and Switch use Wi-Fi control on a Roku TV, or HDMI-CEC on other TVs.' : `The TV page is <span class="num" style="color:var(--gold)">${esc(S.joinUrl.replace('/play', '/tv'))}</span>. On the Pi it opens by itself on the HDMI TV.`;
  const rk = S.tv.roku || {};
  const rb = $('#rokuBox');
  const rsig = JSON.stringify(rk);
  if (rb.dataset.sig !== rsig) {
    rb.dataset.sig = rsig;
    rb.innerHTML = !rk.found
      ? `<b>Roku TV</b><p class="hint" style="margin:4px 0 10px">No Roku TV found on the Wi-Fi yet.</p><button class="btn sm" id="rkFind">Look again</button>`
      : `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><b>${esc(rk.model || 'Roku TV')}</b><span class="status ${rk.allowed ? 'ok' : rk.allowed === false ? 'bad' : 'warn'}">${rk.allowed ? 'Control allowed' : rk.allowed === false ? 'TV is blocking control' : 'Not tested yet'}</span></div>
        ${rk.allowed ? '' : `<p class="hint" style="margin:8px 0">On the TV with its remote: <b>Settings → System → Advanced system settings → Control by mobile apps → Enabled</b>. For turning on from standby also turn on <b>Settings → System → Power → Fast TV start</b>.</p>`}
        <div class="host-meta mt">The Pi is plugged into</div>
        <div class="btns mt">${[1, 2, 3, 4].map(n => `<button class="btn sm${rk.piInput === n ? ' light' : ''}" data-hdmi="${n}">HDMI ${n}</button>`).join('')}<button class="btn sm ghost" id="rkDetect">Detect</button></div>
        <div class="btns mt"><button class="btn sm" id="rkTest">Test control</button></div>`;
    $('#rkFind') && ($('#rkFind').onclick = () => act('tv.findRoku', {}, r => (r.ok ? `Found ${r.model}` : r.note)));
    rb.querySelectorAll('[data-hdmi]').forEach(b => (b.onclick = () => act('tv.setInput', { input: +b.dataset.hdmi }, `Pi set to HDMI ${b.dataset.hdmi}`)));
    $('#rkDetect') && ($('#rkDetect').onclick = () => act('tv.detectInput', {}, r => (r.ok ? `Pi is on HDMI ${r.piInput}` : r.note)));
    $('#rkTest') && ($('#rkTest').onclick = () => act('tv.rokuTest', {}, r => (r.ok ? 'The TV accepts commands' : r.note)));
  }
  $('#tvRows').innerHTML = TV_SCENES.map(([id, name, s, ic]) => `<div class="row${S.tv.scene === id ? ' playing' : ''}" data-scene="${id}" role="button"><div class="lead">${icon(ic)}</div><div class="grow"><div class="t">${name}</div><div class="s">${s}</div></div>${S.tv.scene === id ? icon('check') : ''}</div>`).join('');
  $('#localSw').classList.toggle('on', ui.playLocal);
}
let localSongKey = '';
async function syncLocalShow() {
  const s = S?.show;
  const key = ui.playLocal && s?.playing && !s.paused ? `${s.songId}@${s.startAt}` : '';
  if (key === localSongKey) return;
  localSongKey = key;
  if (!key) { sound.stopSong(); return; }
  const r = await fetch(`/api/song/${s.songId}`).then(r => r.json());
  sound.playSong(r.song, buildTimeline(r.song), s, net);
}

// ---------------- SETUP ----------------
function buildSetup() {
  const v = $('[data-view=setup]');
  v.innerHTML = `
    <div class="sec" id="checklist"></div>
    <div class="sec"><div class="sec-head"><h2>AI elves (Claude)</h2><span class="aside" id="aiCost"></span></div>
      <p class="hint">Powers the Elf Report Card, Santa's Mad Libs and Ask Santa (Claude Haiku). The key stays on the Pi and is never shown again.</p>
      <div class="inline"><input type="password" id="aiKey" placeholder="sk-ant-…" autocomplete="off"><button class="btn" id="aiKeySave">Save key</button></div>
      <div class="two mt"><label class="field"><span>Monthly budget ($)</span><input type="number" id="aiCap" min="0.5" step="0.5"></label><div class="field"><span class="muted" style="font-size:12.5px">&nbsp;</span><button class="btn" id="aiCapSave">Save budget</button></div></div>
      <div id="aiUsage" class="mt"></div></div>
    <div class="sec"><div class="sec-head"><h2>Real tree lights</h2><label class="inline" style="gap:10px"><span class="muted" style="font-size:13px">I have pixel lights</span><button class="switch" id="ptSw"></button></label></div>
      <p class="hint" id="ptHint">Off: the tree on the TV and iPad does the light shows; the real tree runs on its own. Turn on if you ever add addressable pixel lights (docs/HARDWARE.md).</p>
      <div id="hwBody"><span class="aside" id="hwAside" style="display:block;margin-bottom:8px"></span>
      <div class="two"><label class="field"><span>Number of lights on the string</span><input type="number" id="hwCount" min="1" max="1000"></label>
      <label class="field"><span>Times the string wraps around the tree</span><input type="number" id="hwTurns" min="2" max="30" step="0.5"></label></div>
      <div class="rows" id="outRows"></div>
      <div class="btns mt"><button class="btn" id="hwSave">Save lights</button><button class="btn" id="mapBtn">${icon('camera')}Map my tree with the camera</button><button class="btn ghost" id="mapClear">Forget map</button></div>
      <p class="hint mt">Mapping lights each bulb one at a time while the camera finds it, so effects, painting and games use the real positions. Takes about a minute, room lights off.</p></div></div>
    <div class="sec"><div class="sec-head"><h2>Schedule</h2><button class="switch" id="schSw"></button></div>
      <div class="two"><label class="field"><span>Lights on</span><input type="time" id="schOn"></label><label class="field"><span>Lights off</span><input type="time" id="schOff"></label></div></div>
    <div class="sec"><div class="sec-head"><h2>Family</h2></div>
      <div class="two"><label class="field"><span>Family name (shown on the TV)</span><input type="text" id="famName"></label>
      <label class="field"><span>Home city for the Santa tracker</span><select id="homeCity"></select></label></div>
      <label class="field"><span>Light delay for shows (ms) if the lights run ahead of the TV sound</span><input type="number" id="lightDelay" step="10"></label>
      <label class="field"><span>Join address for phones (blank = automatic)</span><input type="text" id="joinUrl" placeholder="http://192.168.1.50:47925/play"></label>
      <button class="btn" id="famSave">Save</button></div>
    <div class="sec"><div class="sec-head"><h2>Voice Monkey</h2><span class="aside">Optional, official Alexa announcements</span></div>
      <div class="two"><label class="field"><span>API token</span><input type="password" id="vmToken" placeholder="from app.voicemonkey.io/tokens"></label><label class="field"><span>Speaker device ID</span><input type="text" id="vmSpeaker"></label></div>
      <label class="field"><span>Routine trigger ID that plays Christmas music (optional)</span><input type="text" id="vmMusic"></label>
      <div class="btns"><button class="btn" id="vmSave">Save</button><button class="btn ghost" id="alexaOut">Sign Alexa out</button></div></div>
    <div class="sec"><div class="sec-head"><h2>LED panel</h2><button class="switch" id="lpSw"></button></div>
      <label class="field"><span>LED Control Center address</span><input type="text" id="lpUrl"></label>
      <div class="btns"><button class="btn" id="lpSave">Save</button><button class="btn" id="lpSend">Send countdown now</button></div></div>
    <div class="sec"><div class="sec-head"><h2>Talk to the tree</h2></div>
      <p class="hint">On the Pi the tree shows up in the Alexa app as smart lights. Say "Alexa, discover devices", then "Alexa, turn the Christmas Tree red", "Alexa, turn on Light Show", "Alexa, turn on Yule Log". The full North Pole skill ("Alexa, ask North Pole for a joke") is in docs/ALEXA.md.</p></div>`;
  $('#ptSw').onclick = () => act('settings.set', { physicalTree: !S.settings.physicalTree });
  $('#hwSave').onclick = () => act('hw.set', { count: +$('#hwCount').value, turns: +$('#hwTurns').value, outputs: readOutputs() }, 'Saved');
  $('#mapBtn').onclick = openMapper;
  $('#mapClear').onclick = () => act('map.clear', {}, 'Back to the default spiral');
  $('#schSw').onclick = () => act('settings.set', { schedule: { enabled: !S.schedule.enabled } });
  const saveSch = () => act('settings.set', { schedule: { on: $('#schOn').value, off: $('#schOff').value } }, 'Schedule saved');
  $('#schOn').onchange = saveSch; $('#schOff').onchange = saveSch;
  $('#famSave').onclick = () => {
    const city = cities[+$('#homeCity').value];
    act('settings.set', { family: $('#famName').value, lightDelayMs: +$('#lightDelay').value || 0, joinUrl: $('#joinUrl').value.trim(), home: city ? { name: city.name, lat: city.lat, lon: city.lon, utc: city.utc } : undefined }, 'Saved');
  };
  $('#vmSave').onclick = () => act('settings.set', { voiceMonkey: { token: $('#vmToken').value.trim() || undefined, speaker: $('#vmSpeaker').value.trim(), triggers: $('#vmMusic').value.trim() ? { music: $('#vmMusic').value.trim() } : {} } }, 'Saved');
  $('#alexaOut').onclick = () => confirm('Sign Alexa out of this app?') && act('alexa.signout', {}, 'Signed out');
  $('#lpSw').onclick = () => act('settings.set', { ledPanel: { on: !S.ledPanel.on } });
  $('#lpSave').onclick = () => act('settings.set', { ledPanel: { url: $('#lpUrl').value.trim() } }, 'Saved');
  $('#lpSend').onclick = () => act('ledpanel.countdown', {}, r => (r.ok ? `Sent: ${r.text}` : r.note || 'Panel did not answer'));
  setupFilled = false;
}
let cities = [];
let setupFilled = false;
function readOutputs() {
  return $$('#outRows [data-out]').map(r => ({ type: r.dataset.out, host: r.querySelector('input[type=text]').value, port: +r.querySelector('input[type=number]').value, on: r.querySelector('.switch').classList.contains('on') }));
}
function renderSetup() {
  if (!S) return;
  const pt = !!S.settings.physicalTree;
  $('#ptSw').classList.toggle('on', pt);
  $('#hwBody').style.display = pt ? '' : 'none';
  $('#ptHint').style.display = pt ? 'none' : '';
  $('#hwAside').textContent = S.hw.mapped ? 'Mapped with the camera' : 'Default spiral layout';
  $('#schSw').classList.toggle('on', !!S.schedule.enabled);
  $('#lpSw').classList.toggle('on', !!S.ledPanel.on);
  if (setupFilled) return;
  setupFilled = true;
  $('#hwCount').value = S.hw.count;
  $('#hwTurns').value = 9;
  const names = { pixels: ['Pixel lights on the Pi', 'Pi address (127.0.0.1 on the Pi itself)'], wled: ['WLED controller', 'Controller IP'], beat: ['Plain string lights (beat-lights Arduino)', 'Pi address'] };
  $('#outRows').innerHTML = S.hw.outputs.map(o => `<div class="row" data-out="${o.type}"><div class="grow"><div class="t">${names[o.type]?.[0] || o.type}</div><div class="inline mt"><input type="text" value="${esc(o.host)}" placeholder="${names[o.type]?.[1] || 'host'}"><input type="number" value="${o.port}" style="max-width:110px"></div></div><button class="switch${o.on ? ' on' : ''}"></button></div>`).join('');
  $$('#outRows .switch').forEach(s => (s.onclick = () => s.classList.toggle('on')));
  $('#schOn').value = S.schedule.on; $('#schOff').value = S.schedule.off;
  $('#famName').value = S.settings.family;
  $('#lightDelay').value = S.settings.lightDelayMs || 0;
  $('#joinUrl').value = S.settings.joinUrl || '';
  $('#vmSpeaker').value = S.voiceMonkey.speaker || '';
  $('#lpUrl').value = S.ledPanel.url || '';
  fetch('/api/santa/route').then(r => r.json()).then(r => {
    cities = r.stops.slice().sort((a, b) => a.name.localeCompare(b.name));
    $('#homeCity').innerHTML = cities.map((c, i) => `<option value="${i}"${c.name === S.settings.home.name ? ' selected' : ''}>${esc(c.name)}, ${esc(c.country)}</option>`).join('');
    cities.forEach(c => (c.utc = c.utc ?? S.settings.home.utc));
  });
}

// ---------------- camera mapping ----------------
async function openMapper() {
  const ov = h('div', { class: 'overlay' });
  ov.innerHTML = `<video playsinline autoplay muted></video><canvas class="full" style="pointer-events:none"></canvas>
    <div class="ov-top"><b style="font-family:var(--serif);font-size:20px">Map the tree</b><button class="btn sm" id="mapClose">${icon('x')}</button></div>
    <div class="ov-bottom"><div id="mapStatus" style="font-size:17px;font-weight:500">Turn the room lights off, stand back so the whole tree fits, and hold the iPad still.</div><div class="meter"><i id="mapMeter"></i></div><div class="btns"><button class="btn light" id="mapGo">Start mapping</button></div></div>`;
  document.body.append(ov);
  const video = ov.querySelector('video');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false }); video.srcObject = stream; }
  catch { ov.querySelector('#mapStatus').textContent = location.protocol === 'https:' ? 'Camera was blocked.' : 'The camera needs the https:// (Tailscale) address.'; }
  let cancelled = false;
  const close = () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()); ov.remove(); act('map.cancel').catch(() => { }); };
  ov.querySelector('#mapClose').onclick = close;
  ov.querySelector('#mapGo').onclick = async () => {
    ov.querySelector('#mapGo').remove();
    const n = S.hw.count;
    const W = 320, H = Math.round(320 * (video.videoHeight || 720) / (video.videoWidth || 1280));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    const grab = () => { x.drawImage(video, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await act('map.start');
    await act('map.index', { index: -1 });
    await wait(500);
    const dark = grab();
    const pts = [];
    for (let i = 0; i < n && !cancelled; i++) {
      await act('map.index', { index: i });
      await wait(320);
      const f = grab();
      let best = 0, bx = 0, by = 0, sx = 0, sy = 0, sw = 0;
      for (let p = 0, k = 0; p < f.length; p += 4, k++) {
        const d = (f[p] + f[p + 1] + f[p + 2]) - (dark[p] + dark[p + 1] + dark[p + 2]);
        if (d > best) { best = d; bx = k % W; by = (k / W) | 0; }
      }
      for (let yy = Math.max(0, by - 6); yy < Math.min(H, by + 7); yy++) for (let xx = Math.max(0, bx - 6); xx < Math.min(W, bx + 7); xx++) {
        const p = (yy * W + xx) * 4; const d = Math.max(0, (f[p] + f[p + 1] + f[p + 2]) - (dark[p] + dark[p + 1] + dark[p + 2]) - best * 0.5);
        sx += xx * d; sy += yy * d; sw += d;
      }
      pts.push(best > 90 && sw ? { px: sx / sw, py: sy / sw, found: true } : { found: false });
      ov.querySelector('#mapMeter').style.width = `${((i + 1) / n) * 100}%`;
      ov.querySelector('#mapStatus').textContent = `Light ${i + 1} of ${n}: ${pts[i].found ? 'found' : 'hidden'}`;
    }
    if (cancelled) return;
    const found = pts.filter(p => p.found);
    if (found.length < n * 0.4) { ov.querySelector('#mapStatus').textContent = `Only ${found.length} of ${n} lights were visible. Darken the room and try again.`; act('map.cancel'); return; }
    const minX = Math.min(...found.map(p => p.px)), maxX = Math.max(...found.map(p => p.px)), minY = Math.min(...found.map(p => p.py)), maxY = Math.max(...found.map(p => p.py));
    const cx = (minX + maxX) / 2, half = Math.max(1, (maxX - minX) / 2), hgt = Math.max(1, maxY - minY);
    const out = pts.map(p => (p.found ? { x: (p.px - cx) / half, y: 1 - (p.py - minY) / hgt, found: true } : null));
    for (let i = 0; i < n; i++) if (!out[i]) {
      let a = i - 1, b = i + 1; while (a >= 0 && !out[a]?.found) a--; while (b < n && !out[b]?.found) b++;
      const A = out[a] || out[b], B = out[b] || out[a]; const k = b > a ? (i - a) / (b - a) : 0.5;
      out[i] = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, found: false };
    }
    await act('map.save', { points: out });
    ov.querySelector('#mapStatus').textContent = `Mapped ${found.length} of ${n} lights. Effects now follow your real tree.`;
    setTimeout(close, 2500);
  };
}

// ---------------- AI elves (Fun tab) ----------------
const ML_PROMPTS = [['silly noun', 'a rubber chicken'], ['adjective', 'sparkly'], ['food', 'mashed potatoes'], ['sound', 'BOING'], ['place in the house', 'the laundry room'], ['number', '47'], ['animal', 'a llama'], ['verb ending in -ing', 'moonwalking']];
ui.ml = { i: 0, words: {} };
function renderAi() {
  const box = $('#aiSec'); if (!box || !S) return;
  const on = !!S.ai?.configured;
  const sig = JSON.stringify([on, S.players.map(p => p.name), ui.ml.i]);
  if (box.dataset.sig === sig) { $('#aiBusy') && ($('#aiBusy').textContent = S.ai?.busy ? 'The elves are writing…' : ''); return; }
  box.dataset.sig = sig;
  const who = `<option value="">Who is it for?</option>${S.players.map(p => `<option>${esc(p.name)}</option>`).join('')}<option value="__other">Someone else…</option>`;
  const step = ui.ml.i, done = step >= ML_PROMPTS.length;
  box.innerHTML = `<div class="sec-head"><h2>AI elves</h2><span class="aside" id="aiBusy"></span></div>
    ${on ? '' : '<p class="hint">Add the Claude key in Setup to turn these on. Until then, see what each one looks like on the TV:</p><div class="btns" style="margin-bottom:12px"><button class="btn sm" data-demo="report">Example report card</button><button class="btn sm" data-demo="madlibs">Example story</button><button class="btn sm" data-demo="santa">Example Santa answer</button></div>'}
    <div class="box"><b class="serif" style="font-family:var(--serif);font-size:19px">Elf Report Card</b><p class="hint" style="margin:4px 0 10px">Three quick answers, then the TV shows their official North Pole report card and Alexa reads Santa's verdict.</p>
      <div class="two"><select id="rcWho">${who}</select><input type="text" id="rcCookie" placeholder="Favorite Christmas cookie"></div>
      <div class="two mt"><input type="text" id="rcProud" placeholder="Something they're proud of this year"><input type="text" id="rcConfess" placeholder="A small, funny confession"></div>
      <button class="btn primary mt" id="rcGo"${on ? '' : ' disabled'}>${icon('star')}Make the report card</button></div>
    <div class="box"><b style="font-family:var(--serif);font-size:19px">Santa's Mad Libs</b><p class="hint" style="margin:4px 0 10px">Pass the iPad: everyone adds one word without seeing the story. Then the TV and Alexa tell it, starring the family.</p>
      ${done ? `<p style="margin:0 0 10px">All ${ML_PROMPTS.length} words are in.</p><div class="btns"><button class="btn primary" id="mlGo"${on ? '' : ' disabled'}>${icon('wand')}Write the story</button><button class="btn ghost" id="mlReset">Start over</button></div>`
      : `<div class="host-meta">Word ${step + 1} of ${ML_PROMPTS.length}</div><div class="turn-name" style="font-size:24px;margin:4px 0 10px">Give me ${/^[aeiou]/.test(ML_PROMPTS[step][0]) ? 'an' : 'a'} ${ML_PROMPTS[step][0]}</div><div class="inline"><input type="text" id="mlWord" placeholder="like “${ML_PROMPTS[step][1]}”" autocomplete="off"><button class="btn light" id="mlNext">Next</button></div>`}</div>
    <div class="box"><b style="font-family:var(--serif);font-size:19px">Ask Santa</b><p class="hint" style="margin:4px 0 10px">Santa answers on the TV, and out loud through Alexa.</p>
      <div class="two"><select id="asWho"><option value="">Who's asking?</option>${S.players.map(p => `<option>${esc(p.name)}</option>`).join('')}</select><input type="text" id="asQ" placeholder="How do the reindeer fly?"></div>
      <button class="btn primary mt" id="asGo"${on ? '' : ' disabled'}>${icon('bell')}Ask</button><div id="asOut" class="mt"></div></div>`;
  box.querySelectorAll('[data-demo]').forEach(b => (b.onclick = () => act('ai.demo', { kind: b.dataset.demo }, 'Example on the TV')));
  $('#rcWho').onchange = e => { if (e.target.value === '__other') { const n = prompt('Their name?'); if (n) { const o = h('option', {}, n.trim()); e.target.add(o, e.target.options.length - 1); e.target.value = n.trim(); } else e.target.value = ''; } };
  $('#rcGo').onclick = () => {
    const name = $('#rcWho').value; if (!name) return toast('Pick who it is for', true);
    act('ai.reportCard', { name, cookie: $('#rcCookie').value, proud: $('#rcProud').value, confess: $('#rcConfess').value }, 'On the TV now').then(() => ['rcCookie', 'rcProud', 'rcConfess'].forEach(id => ($('#' + id).value = '')));
  };
  if (done) {
    $('#mlGo').onclick = () => act('ai.madlibs', { words: Object.fromEntries(ML_PROMPTS.map(([k], i) => [k, ui.ml.words[i]])) }, 'Story time on the TV').then(() => { ui.ml = { i: 0, words: {} }; renderAi(); });
    $('#mlReset').onclick = () => { ui.ml = { i: 0, words: {} }; renderAi(); };
  } else {
    const next = () => { const w = $('#mlWord').value.trim(); if (!w) return toast('Type a word first', true); ui.ml.words[ui.ml.i] = w; ui.ml.i++; renderAi(); $('#mlWord')?.focus(); };
    $('#mlNext').onclick = next; $('#mlWord').onkeydown = e => e.key === 'Enter' && next();
  }
  $('#asGo').onclick = () => {
    const q = $('#asQ').value.trim(); if (!q) return toast('Type a question', true);
    act('ai.askSanta', { question: q, asker: $('#asWho').value }).then(r => { $('#asOut').innerHTML = `<div class="host-q" style="font-size:18px">“${esc(r.answer)}”</div>`; $('#asQ').value = ''; });
  };
}

// ---------------- setup checklist + AI key (Setup tab) ----------------
let aiSetupBound = false;
function renderChecklist() {
  const box = $('#checklist'); if (!box || !S) return;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const done = S.setupDone || {};
  const items = [
    { id: 'icon', t: 'North Pole on the iPad home screen', d: 'Share (square with arrow) → Add to Home Screen.', ok: standalone },
    { id: 'pi', t: 'Running on the Raspberry Pi', d: 'The Pi starts everything by itself when it powers on.', ok: S.onPi },
    { id: 'tv', t: 'Pi plugged into the TV', d: 'HDMI from the Pi into the TV. The TV screen counts as connected when it shows North Pole.', ok: S.tv.clients > 0 },
    S.tv.roku?.found
      ? { id: 'roku', t: `The app can turn on the ${S.tv.roku.model || 'Roku TV'}`, d: 'On the TV: Settings → System → Advanced system settings → Control by mobile apps → Enabled. Then TV tab → Test control, and pick the Pi\'s HDMI input.', ok: !!S.tv.roku.allowed && !!S.tv.roku.piInput, go: 'tv' }
      : { id: 'cec', t: 'TV remote control (HDMI-CEC) on', d: 'In the TV settings turn on CEC (Roku TV: Settings → System → Control other devices (CEC); Samsung: Anynet+; Sony: Bravia Sync; LG: SimpLink). Then Showtime turns the TV on.', manual: true },
    { id: 'family', t: 'Family added for games', d: 'Games tab → Players: add everyone with a team colour.', ok: S.players.length > 0, go: 'games' },
    { id: 'alexa', t: 'Alexa connected', d: 'Music tab → Alexa → Connect, then sign in to Amazon once.', ok: !!S.alexa?.ready, go: 'music' },
    { id: 'hue', t: 'Alexa can see the North Pole switches', d: 'Say "Alexa, discover devices". Then try "Alexa, turn on Countdown".', ok: !!S.hueSeenAt || !!done.hue },
    ...(S.settings.physicalTree ? [
      { id: 'lights', t: 'Pixel lights on the tree', d: 'Buy and wire them: the guide is docs/HARDWARE.md (about $40–70). Until then the TV shows the tree.', manual: true, link: '/docs/HARDWARE.md' },
      { id: 'map', t: 'Tree mapped with the camera', d: 'After the lights are on: set the light count below, then Map my tree.', ok: S.hw.mapped },
    ] : []),
    { id: 'ai', t: 'AI elves switched on', d: 'Paste the Claude key just below.', ok: !!S.ai?.configured },
    { id: 'tailscale', t: 'Optional: reach the Pi from anywhere', d: 'Install Tailscale on the Pi so the iPad link works away from home without the PC.', manual: true, optional: true },
    { id: 'skill', t: 'Optional: the "North Pole" Alexa skill', d: '"Alexa, ask North Pole for a joke". Steps in docs/ALEXA.md.', manual: true, optional: true, link: '/docs/ALEXA.md' },
  ];
  const isOk = it => (it.manual ? !!done[it.id] : !!it.ok);
  const core = items.filter(i => !i.optional);
  const count = core.filter(isOk).length;
  box.innerHTML = `<div class="sec-head"><h2>Get set up</h2><span class="aside">${count} of ${core.length} done</span></div>
    <div class="meter" style="background:var(--line2);height:6px;margin:0 0 12px"><i style="width:${(count / core.length) * 100}%;background:var(--green)"></i></div>
    <div class="rows">${items.map(it => `<div class="row" style="align-items:flex-start;min-height:0">
      <div class="lead" style="width:32px;height:32px;border-radius:50%;${isOk(it) ? 'background:var(--green);color:#fff' : ''}">${isOk(it) ? icon('check') : `<span class="num" style="font-size:13px">${items.indexOf(it) + 1}</span>`}</div>
      <div class="grow"><div class="t" style="white-space:normal;${isOk(it) ? 'color:var(--muted);text-decoration:line-through' : ''}">${esc(it.t)}</div><div class="s" style="white-space:normal">${esc(it.d)}</div></div>
      ${it.manual ? `<button class="btn sm" data-tick="${it.id}">${done[it.id] ? 'Undo' : 'Done'}</button>` : ''}${it.go && !isOk(it) ? `<button class="btn sm" data-go="${it.go}">Open</button>` : ''}${it.link ? `<a class="btn sm ghost" href="${it.link}" target="_blank">Guide</a>` : ''}</div>`).join('')}</div>`;
  box.querySelectorAll('[data-tick]').forEach(b => (b.onclick = () => act('setup.tick', { id: b.dataset.tick, done: !done[b.dataset.tick] })));
  box.querySelectorAll('[data-go]').forEach(b => (b.onclick = () => setTab(b.dataset.go)));
  if (!aiSetupBound) {
    aiSetupBound = true;
    $('#aiKeySave').onclick = () => act('ai.setKey', { key: $('#aiKey').value }, r => (r.configured ? 'Key saved. The AI elves are on.' : 'Key removed')).then(() => { $('#aiKey').value = ''; loadAiUsage(); });
    $('#aiCapSave').onclick = () => act('ai.setCap', { capUsd: +$('#aiCap').value }, 'Budget saved').then(loadAiUsage);
    loadAiUsage();
  }
  $('#aiCost').textContent = S.ai?.configured ? `$${(S.ai.month || 0).toFixed(3)} of $${(S.ai.cap || 5).toFixed(2)} this month` : 'Not set up';
}
async function loadAiUsage() {
  try {
    const u = await net.act('ai.usage');
    if (document.activeElement !== $('#aiCap')) $('#aiCap').value = u.cap;
    const feat = Object.entries(u.byFeature).map(([k, v]) => `${esc(k)} $${v.toFixed(4)}`).join(' · ') || 'nothing yet';
    $('#aiUsage').innerHTML = `<div class="box"><div class="two"><div><div class="host-meta">This month</div><div class="num" style="font-size:22px">$${u.month.toFixed(4)}</div><div class="host-meta">${u.calls} calls${u.failed ? `, ${u.failed} failed` : ''} · budget $${u.cap.toFixed(2)}</div></div><div><div class="host-meta">Today</div><div class="num" style="font-size:22px">$${u.today.toFixed(4)}</div><div class="host-meta">${esc(feat)}</div></div></div>
      ${u.recent.length ? `<div class="sep"></div><div class="host-meta" style="margin-bottom:6px">Latest calls (prices as of ${esc(u.prices.date)})</div>${u.recent.slice(0, 6).map(r => `<div class="num" style="font-size:12.5px;color:${r.ok ? 'var(--muted)' : '#ff8a80'}">${esc(r.time.slice(5, 16).replace('T', ' '))} ${esc(r.feature)} ${r.input}→${r.output} tok $${(r.cost || 0).toFixed(5)}${r.ok ? '' : ' failed'}</div>`).join('')}` : ''}</div>`;
  } catch { }
}

// ---------------- render ----------------
function render() {
  renderStage();
  if (!S) return;
  if (ui.tab === 'lights') renderLights();
  if (ui.tab === 'music') renderMusic();
  if (ui.tab === 'games') renderGames();
  if (ui.tab === 'fun') { renderFun(); renderAi(); }
  if (ui.tab === 'tv') renderTv();
  if (ui.tab === 'setup') { renderSetup(); renderChecklist(); }
  syncLocalShow();
}

(async function boot() {
  buildLights();
  try {
    const [c, s] = await Promise.all([fetch('/api/content').then(r => r.json()), fetch('/api/songs').then(r => r.json())]);
    content = c; songs = s.songs.sort((a, b) => a.title.localeCompare(b.title));
  } catch { }
  buildMusic(); buildGames(); buildFun(); buildTv(); buildSetup();
  setTab(ui.tab);
  setInterval(renderStage, 30000);
})();
