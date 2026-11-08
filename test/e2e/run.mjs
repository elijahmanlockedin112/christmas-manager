// End-to-end walk-through on a throwaway server (its own port + temp data dir, never the real one).
// node test/e2e/run.mjs [outDir]   -> screenshots + a pass/fail list
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'np-shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 47935, BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'np-e2e-data');
fs.rmSync(DATA, { recursive: true, force: true });
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const want = k => !only.length || only.includes(k);

const srv = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), XM_DATA: DATA, XM_HUE_PORT: '0', XM_PREVIEWS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => (srvLog += d)); srv.stderr.on('data', d => (srvLog += d));
for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/state`); break; } catch { await sleep(200); } }

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const state = () => fetch(`${BASE}/api/state`).then(r => r.json());
const act = (name, args = {}) => fetch(`${BASE}/api/act/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }).then(r => r.json());

// fake family phones
function phone(pid, name, team) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=player&pid=${pid}`);
  const p = { ws, send: m => ws.send(JSON.stringify(m)) };
  p.ready = new Promise(r => (ws.onopen = () => { p.send({ type: 'join', name, team }); setTimeout(r, 200); }));
  return p;
}

const chrome = await launch({ port: 9344 });
const pages = [];
try {
  // ---------- iPad control center ----------
  const ipad = await chrome.page(`${BASE}/`, { width: 1180, height: 820, mobile: true, scale: 1 });
  pages.push(['ipad', ipad]);
  await sleep(1500);
  await ipad.shot(path.join(OUT, 'ipad-lights.png'));
  // the real LED colours the server streams (not canvas pixels, which include the always-lit star)
  const ledSum = () => ipad.eval(`(() => { const c = window.__np.tree.colors; let s = 0; for (const v of c) s += v; return { s, n: c.length / 3 }; })()`);
  const boot = await ledSum();
  check('LEDs are lit from boot (default Classic Warm)', boot.n === 100 && boot.s > 100 * 3 * 40, JSON.stringify(boot));
  // and the check can fail: power off must read dark
  await act('lights.set', { power: false }); await sleep(1500);
  const dark = await ledSum();
  check('power off really darkens the LEDs', dark.s === 0, JSON.stringify(dark));
  await act('lights.set', { power: true }); await sleep(1200);
  await ipad.tap('[data-fx="candy-cane"]');
  await sleep(400);
  check('tap effect sets tree effect', (await state()).lights.effect === 'candy-cane');
  await ipad.tap('[data-color="#1f9a52"]');
  await sleep(300);
  const s1 = await state();
  check('colour chip makes tree solid pine', s1.lights.effect === 'solid' && s1.lights.color === '#1f9a52');
  await ipad.tap('[data-fx="twinkle"]');
  await sleep(1200);
  const tw = await ledSum();
  check('twinkle streams lit LEDs to the iPad tree', tw.s > 1000, JSON.stringify(tw));
  await ipad.tap('#power');
  check('power button turns tree off', (await state()).lights.power === false);
  await ipad.tap('#power');
  for (const tab of ['music', 'games', 'fun', 'tv', 'setup']) {
    await ipad.tap(`.tab[data-tab="${tab}"]`);
    await sleep(500);
    await ipad.shot(path.join(OUT, `ipad-${tab}.png`));
  }
  await ipad.tap('.tab[data-tab="lights"]');

  // ---------- phone control center ----------
  if (want('phone')) {
    const ph = await chrome.page(`${BASE}/`, { width: 390, height: 844, mobile: true, scale: 2 });
    pages.push(['phone', ph]);
    await sleep(1200);
    await ph.shot(path.join(OUT, 'phone-lights.png'));
    await ph.tap('.tab[data-tab="music"]'); await sleep(400); await ph.shot(path.join(OUT, 'phone-music.png'));
    await ph.tap('.tab[data-tab="games"]'); await sleep(400); await ph.shot(path.join(OUT, 'phone-games.png'));
    const overflow = await ph.eval('document.documentElement.scrollWidth - innerWidth');
    check('phone: no sideways scroll', overflow <= 0, `overflow ${overflow}`);
  }

  // ---------- TV ----------
  const tv = await chrome.page(`${BASE}/tv`, { width: 1920, height: 1080, scale: 0.5 });
  pages.push(['tv', tv]);
  await sleep(1500);
  await tv.eval(`document.dispatchEvent(new PointerEvent('pointerdown'))`);
  await tv.shot(path.join(OUT, 'tv-home.png'));
  check('TV counts as a connected screen', (await state()).tv.clients >= 1);

  let st;
  // ---------- pass-the-iPad play (no phones), all with real taps on the iPad ----------
  await ipad.tap('.tab[data-tab="games"]');
  // everyone for themselves is the default: no team picker
  for (const name of ['Grandma', 'Dad', 'Lily']) {
    await ipad.tap('#newName'); await ipad.type(name);
    await ipad.tap('#addP'); await sleep(300);
  }
  st = await state();
  check('iPad roster: 3 players added on the iPad', st.players.filter(p => p.local).length === 3 && new Set(st.players.map(p => p.color)).size === 3, st.players.map(p => p.name + ':' + p.color).join(' '));
  // a photo for Dad, made the way the iPad makes one (square JPEG from a canvas)
  const dadId = st.players.find(p => p.name === 'Dad').id;
  const jpeg = await ipad.eval(`(() => { const c = document.createElement('canvas'); c.width = c.height = 420; const x = c.getContext('2d'); x.fillStyle = '#2a6'; x.fillRect(0, 0, 420, 420); x.fillStyle = '#fc9'; x.beginPath(); x.arc(210, 190, 110, 0, 7); x.fill(); for (let i = 0; i < 400; i++) { x.fillStyle = 'hsl(' + i + ',60%,50%)'; x.fillRect(Math.random() * 420, Math.random() * 420, 6, 6); } return c.toDataURL('image/jpeg', 0.84); })()`);
  await act('game.photo', { pid: dadId, photo: jpeg });
  await sleep(500);
  const shown = await ipad.eval(`!!document.querySelector('[data-photo="${dadId}"] img')`);
  const photoRes = await fetch(`${BASE}/api/player-photo/${dadId}?v=1`);
  check('player photo saved and shown on the iPad', shown && photoRes.status === 200 && (photoRes.headers.get('content-type') || '').includes('jpeg'));
  await ipad.shot(path.join(OUT, 'ipad-roster.png'));
  // trivia hot seat: one person at a time, on the TV with a hat and a timer
  await ipad.tap('[data-start="trivia"]'); await sleep(400);
  check('game mode: the iPad hides the tree and tabs', await ipad.eval(`document.body.classList.contains('gamemode') && getComputedStyle(document.querySelector('.stage')).display === 'none'`));
  await ipad.tap('#gNext'); await sleep(600);
  st = await state();
  check('hot seat: a "you\'re up" turn first, 3 questions each', st.game?.phase === 'turn' && !!st.game.turn?.pid && st.game.total === 9, `${st.game?.phase} ${st.game?.total}`);
  await sleep(800);
  check('TV shows whose turn it is, in a Santa hat', await tv.eval(`!!document.querySelector('.upnext .av .hat')`));
  await tv.shot(path.join(OUT, 'tv-hotseat-turn.png'));
  await ipad.shot(path.join(OUT, 'ipad-hotseat-turn.png'));
  await ipad.tap('#seatGo'); await sleep(900);
  st = await state();
  check('"I\'m ready" starts the question and the clock', st.game?.phase === 'question' && st.game.endsAt > Date.now() + 10000);
  check('TV hot seat: face, hat and timer ring', await tv.eval(`!!document.querySelector('.hotseat .av .hat') && !!document.querySelector('#gRing')`));
  await tv.shot(path.join(OUT, 'tv-hotseat-question.png'));
  await ipad.shot(path.join(OUT, 'ipad-hotseat-question.png'));
  const seat = st.game.turn.pid;
  await act('game.answer', { pid: st.players.find(p => p.id !== seat).id, choice: 0 }); // someone else can't answer
  await ipad.tap('[data-ans="1"]'); await sleep(2200);
  st = await state();
  check('hot seat answer reveals after a beat', st.game?.phase === 'reveal' && st.game.picked === 1 && Object.keys(st.game.gained || {}).every(id => id === seat), JSON.stringify(st.game?.gained));
  await sleep(600);
  await tv.shot(path.join(OUT, 'tv-hotseat-reveal.png'));
  await ipad.tap('#gEnd'); await sleep(500);
  check('ending the game brings the tree back', await ipad.eval(`!document.body.classList.contains('gamemode')`));
  await ipad.tap('.tab[data-tab="games"]'); await sleep(200);
  // team play still works: 2 teams, pass the iPad for one shared question
  await ipad.tap('[data-teams="2"]'); await sleep(400);
  await ipad.tap('[data-start="trivia"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(500);
  await ipad.shot(path.join(OUT, 'ipad-trivia-turn.png'));
  await tv.shot(path.join(OUT, 'tv-trivia-turn.png'));
  for (let i = 0; i < 3; i++) { await ipad.tap(`[data-ans="${i % 4}"]`); await sleep(450); }
  await sleep(900);
  st = await state();
  check('pass-the-iPad trivia: 3 turns then reveal', st.game?.phase === 'reveal', st.game?.phase);
  await ipad.tap('#gEnd'); await sleep(300);
  // name that song: slap your name
  await ipad.tap('[data-start="name-that-song"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  await ipad.shot(path.join(OUT, 'ipad-buzzers.png'));
  const lilyId = (await state()).players.find(p => p.name === 'Lily').id;
  await ipad.tap(`[data-buzz="${lilyId}"]`); await sleep(400);
  st = await state();
  check('iPad name buzzer buzzes in Lily', st.game?.phase === 'buzzed' && st.game.buzz.name === 'Lily');
  await ipad.shot(path.join(OUT, 'ipad-pick.png'));
  await ipad.tap('[data-pick="0"]'); await sleep(400);
  st = await state();
  check('buzzed player picks on the iPad', ['reveal', 'playing'].includes(st.game?.phase), st.game?.phase);
  await ipad.tap('#gEnd'); await sleep(300);
  // would you rather: A/B per person
  await ipad.tap('[data-start="would-you-rather"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(500);
  for (const [i, side] of [[0, 'a'], [1, 'b'], [2, 'a']]) { const id = (await state()).players.filter(p => p.local)[i].id; await ipad.tap(`[data-vote="${side}"][data-vp="${id}"]`); await sleep(250); }
  await sleep(900);
  st = await state();
  check('iPad votes reveal the split', st.game?.phase === 'reveal' && st.game.result.a.length === 2, JSON.stringify(st.game?.result));
  await ipad.tap('#gEnd'); await sleep(300);
  // pictionary: pass, show word, draw, award the guesser
  await ipad.tap('[data-start="pictionary"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(500);
  st = await state();
  check('pictionary passes the iPad to a drawer first', st.game?.phase === 'pass' && !!st.game.drawer, st.game?.drawer?.name);
  await tv.shot(path.join(OUT, 'tv-pict-pass.png'));
  await ipad.tap('#showWord'); await sleep(700);
  const w2 = await ipad.eval(`document.querySelector('#secretWord')?.textContent`);
  check('drawer sees the word after "show my word"', w2 && w2 !== '…', w2);
  const drawerId = (await state()).game.drawer.pid;
  const guesser = (await state()).players.find(p => p.id !== drawerId);
  await ipad.tap(`[data-award="${guesser.id}"]`); await sleep(1600);
  st = await state();
  check('tapping who guessed scores and reveals', st.game?.phase === 'reveal' && st.players.find(p => p.id === guesser.id).score > 0);
  await ipad.tap('#gEnd'); await sleep(300);
  for (const p of (await state()).players.filter(p => p.local)) await act('game.kick', { id: p.id });

  // ---------- trivia with three phones + one real phone page ----------
  await act('settings.set', { phones: true });
  await ipad.tap('.tab[data-tab="games"]');
  const fam = [phone('p1', 'Grandma', 'red'), phone('p2', 'E', 'green'), phone('p3', 'Dad', 'red')];
  await Promise.all(fam.map(p => p.ready));
  await sleep(400);
  await ipad.tap('[data-start="trivia"]');
  await sleep(400);
  const play = await chrome.page(`${BASE}/play`, { width: 390, height: 844, mobile: true, scale: 2 });
  pages.push(['play', play]);
  await sleep(800);
  await play.tap('#nm'); await play.type('Aunt Jo');
  await play.tap('[data-t="green"]');
  await play.tap('#go');
  await sleep(600);
  st = await state();
  check('phone page joins with name + team', st.players.some(p => p.name === 'Aunt Jo' && p.team === 'green'), `${st.players.length} players`);
  await sleep(400);
  await tv.shot(path.join(OUT, 'tv-lobby.png'));
  await ipad.tap('#gNext');
  await sleep(800);
  st = await state();
  check('trivia question is live', st.game?.phase === 'question' && st.game.choices.length === 4);
  await play.shot(path.join(OUT, 'play-question.png'));
  await play.tap('.ans[data-i="1"]');
  fam[0].send({ type: 'answer', choice: 0 }); fam[1].send({ type: 'answer', choice: 2 });
  await sleep(500);
  await tv.shot(path.join(OUT, 'tv-question.png'));
  fam[2].send({ type: 'answer', choice: 3 });
  await sleep(1500);
  st = await state();
  check('all answered -> reveal', st.game?.phase === 'reveal');
  await tv.shot(path.join(OUT, 'tv-reveal.png'));
  await play.shot(path.join(OUT, 'play-reveal.png'));
  await act('game.end');

  // ---------- would you rather ----------
  await act('game.start', { kind: 'would-you-rather' }); await act('game.next'); await sleep(400);
  fam[0].send({ type: 'vote', side: 'a' }); fam[1].send({ type: 'vote', side: 'b' }); fam[2].send({ type: 'vote', side: 'a' });
  await play.tap('[data-s="a"]');
  await sleep(1400);
  st = await state();
  check('would you rather reveals the split', st.game?.phase === 'reveal' && st.game.result.a.length === 3, JSON.stringify(st.game?.result?.share));
  await tv.shot(path.join(OUT, 'tv-wyr.png'));
  await act('game.end');

  // ---------- name that song (carols on the TV, no Alexa in tests) ----------
  await act('game.start', { kind: 'name-that-song' }); await act('game.next'); await sleep(900);
  await tv.shot(path.join(OUT, 'tv-nts-playing.png'));
  await play.shot(path.join(OUT, 'play-buzz.png'));
  await play.tap('#buzz');
  await sleep(500);
  st = await state();
  check('phone BUZZ button buzzes in', st.game?.phase === 'buzzed' && st.game.buzz.name === 'Aunt Jo');
  await tv.shot(path.join(OUT, 'tv-nts-buzzed.png'));
  await play.shot(path.join(OUT, 'play-pick.png'));
  await act('game.end'); await sleep(500); // the iPad leaves game mode (tree and tabs come back)

  // ---------- pictionary: strokes from the iPad pad reach the TV ----------
  await ipad.tap('.tab[data-tab="games"]');
  await act('game.start', { kind: 'pictionary' }); await sleep(300);
  await ipad.tap('#gNext'); await sleep(600);
  await ipad.tap('#showWord'); await sleep(800);
  const pad = await ipad.eval(`(() => { const r = document.querySelector('#drawpad').getBoundingClientRect(); return {x:r.left, y:r.top, w:r.width, h:r.height}; })()`);
  await ipad.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pad.x + pad.w * 0.3, y: pad.y + pad.h * 0.5, button: 'left', clickCount: 1, pointerType: 'pen', force: 0.6 });
  for (let i = 0; i <= 30; i++) { const a = i / 30 * Math.PI * 2; await ipad.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pad.x + pad.w * (0.5 + 0.2 * Math.cos(a)), y: pad.y + pad.h * (0.5 + 0.3 * Math.sin(a)), button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 }); await sleep(15); }
  await ipad.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pad.x + pad.w * 0.7, y: pad.y + pad.h * 0.5, button: 'left', clickCount: 1, pointerType: 'pen' });
  await sleep(700);
  const word = await ipad.eval(`document.querySelector('#secretWord')?.textContent`);
  check('iPad gets the secret word', word && word !== '…', word);
  const ink = await tv.eval(`(() => { const c = document.querySelector('.paper canvas'); if (!c) return -1; const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for (let i=3;i<d.length;i+=16) if (d[i] > 0) n++; return n; })()`);
  check('Pencil stroke appears on the TV', ink > 50, `ink ${ink}`);
  fam[0].send({ type: 'guess', text: 'banana' });
  fam[1].send({ type: 'guess', text: word });
  await sleep(600);
  st = await state();
  check('right guess scores', st.game?.correct?.some(c => c.name === 'E'));
  await ipad.shot(path.join(OUT, 'ipad-pictionary.png'));
  await tv.shot(path.join(OUT, 'tv-pictionary.png'));
  await act('game.end');

  // ---------- final screen ----------
  await act('game.start', { kind: 'trivia', rounds: 1, resetScores: false }); await act('game.next'); await sleep(300);
  for (const p of fam) p.send({ type: 'answer', choice: 0 });
  await play.tap('.ans[data-i="0"]');
  await sleep(1500); await act('game.next'); await sleep(900);
  await tv.shot(path.join(OUT, 'tv-final.png'));
  await act('game.end');

  // ---------- light show karaoke ----------
  await act('show.play', { song: 'jingle-bells' });
  await sleep(1200);
  await tv.shot(path.join(OUT, 'tv-show-countin.png'));
  await sleep(6500);
  await tv.shot(path.join(OUT, 'tv-show-lyrics.png'));
  const sung = await tv.eval(`document.querySelectorAll('.lyric .w.sung').length`);
  check('karaoke highlights syllables in time', sung > 0, `sung ${sung}`);
  st = await state();
  check('show drives the tree', st.lights.effect === 'show');
  await act('show.stop');
  st = await state();
  check('tree returns to its effect after the show', st.lights.effect !== 'show', st.lights.effect);

  // ---------- regressions from the code review ----------
  await act('game.start', { kind: 'trivia' }); await act('game.next'); await sleep(300);
  fam[0].send({ type: 'answer', choice: 2000000000 });
  fam[1].send({ type: 'answer', choice: -4 });
  fam[2].ws.send('{not json');
  await sleep(300);
  const t0 = Date.now(); st = await state();
  check('garbage answers ignored, server responsive', Date.now() - t0 < 500 && st.game.answered.length === 0, `${Date.now() - t0}ms`);
  await act('game.end');
  await act('lights.set', { effect: 'rainbow' });
  await act('radio.play', { channel: 'christmas' });
  await act('paint.stroke', { points: [{ x: 0, y: 0.5 }], color: '#ff0000' });
  await act('radio.stop');
  await act('paint.exit');
  st = await state();
  check('paint during radio, radio stops, exit paint -> back to rainbow', st.lights.effect === 'rainbow', st.lights.effect);
  const bad = await act('lights.set', { effect: 'show' });
  check('cannot force the show effect with no show', !!bad.error);
  const r400 = await fetch(`${BASE}/%E0%A4%A`).then(r => r.status);
  check('bad URL gets 400, not a hang', r400 === 400);

  // ---------- other TV scenes ----------
  for (const [name, fn, wait] of [
    ['yule', () => act('scene.cozy'), 1500],
    ['countdown', () => act('tv.scene', { scene: 'countdown' }), 1200],
    ['santa', () => act('santa.preview', { speed: 2400 }), 4500],
    ['joke', () => act('joke.tell', { say: false }), 5600],
    ['scanner', () => act('scanner.result', { name: 'Lily' }), 1200],
    ['advent', () => act('advent.open', { day: 7 }), 1200],
    ['message', () => act('tv.message', { text: 'Cookies are out of the oven!', from: 'Mom' }), 1200],
    ['radio', () => act('radio.play', { channel: 'christmas' }), 4000],
  ]) {
    await fn(); await sleep(wait);
    await tv.shot(path.join(OUT, `tv-${name}.png`));
  }
  await act('radio.stop');
  st = await state();
  check('santa preview flies', st.santa?.phase === 'flying', st.santa?.city);

  for (const [n, p] of pages) check(`no page errors: ${n}`, p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
  for (const p of fam) p.ws.close();
} catch (e) {
  check('run finished', false, e.stack);
} finally {
  await chrome.close();
  srv.kill();
  fs.writeFileSync(path.join(OUT, 'server.log'), srvLog);
  fs.rmSync(DATA, { recursive: true, force: true });
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed. Shots in ${OUT}`);
  process.exit(bad.length ? 1 : 0);
}
