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
  // the TV tab sits in the background: bring it forward and let its entrance animations finish before the screenshot
  const tvLook = async f => { await tv.send('Page.bringToFront'); await sleep(1400); await tv.shot(path.join(OUT, f)); };
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

  // ---------- family games: real taps on the iPad, the TV shows the board ----------
  const fp = (await state()).players, [gma, dad, lily] = ['Grandma', 'Dad', 'Lily'].map(n => fp.find(p => p.name === n).id);
  const rows = await ipad.eval(`[...document.querySelectorAll('.game-list .row .t')].map(e => e.textContent)`);
  check('Games list has the 3 new family games', ['Most Likely To', 'Mind Reader', 'Caption Chaos'].every(n => rows.includes(n)), rows.join(' | '));
  // Most Likely To
  await ipad.tap('[data-start="most-likely"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  check('Most Likely To: a prompt to vote on', st.game?.kind === 'most-likely' && st.game.phase === 'vote' && !!st.game.x.prompt, st.game?.x?.prompt);
  await ipad.shot(path.join(OUT, 'ipad-ml-who.png'));
  await tvLook('tv-ml-vote.png');
  await ipad.tap(`[data-who="${gma}"]`); await sleep(300);
  await ipad.shot(path.join(OUT, 'ipad-ml-vote.png'));
  check('Most Likely To: picker shows everyone, ballot is private', await ipad.eval(`document.querySelectorAll('[data-vote]').length === 3`));
  await ipad.tap(`[data-vote="${dad}"]`); await sleep(500);
  st = await state();
  check('Most Likely To: first vote counted, nobody told who it was for', st.game.x.voted.length === 1 && !JSON.stringify(st.game).includes(`"${gma}":"`));
  check('TV ticks off who has voted', await tv.eval(`document.querySelectorAll('.ml .ml-p .chk').length === 1`));
  await ipad.tap(`[data-who="${dad}"]`); await ipad.tap(`[data-vote="${dad}"]`); await sleep(300);
  await ipad.tap(`[data-who="${lily}"]`); await ipad.tap(`[data-vote="${gma}"]`); await sleep(2200);
  st = await state();
  check('Most Likely To: reveal crowns the crowd pick and scores it', st.game.phase === 'reveal' && st.game.x.winners[0] === dad && st.players.find(p => p.id === dad).score === 250 && st.players.find(p => p.id === gma).score === 100, JSON.stringify(st.game.x.winners));
  await sleep(1200);
  check('TV reveal: voters stacked on the winner, in a Santa hat', await tv.eval(`!!document.querySelector('.ml.reveal .ml-p.win .av .hat') && document.querySelectorAll('.ml.reveal .ml-p.win .stack .av').length === 2`));
  await tvLook('tv-ml-reveal.png');
  await ipad.shot(path.join(OUT, 'ipad-ml-reveal.png'));
  await ipad.tap('#gEnd'); await sleep(400);
  // Mind Reader
  await ipad.tap('[data-start="mind-reader"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  const spot = st.game.x.spot.id, guessers = [gma, dad, lily].filter(id => id !== spot);
  check('Mind Reader: the spotlight person is called up first, choices hidden', st.game.phase === 'turn' && st.game.total === 6 && st.game.x.a === null);
  await tvLook('tv-mr-turn.png');
  await ipad.shot(path.join(OUT, 'ipad-mr-turn.png'));
  await ipad.tap('#seatGo'); await sleep(500);
  await ipad.shot(path.join(OUT, 'ipad-mr-pick.png'));
  await tvLook('tv-mr-pick.png');
  await ipad.tap('[data-side="a"]'); await sleep(500);
  st = await state();
  check('Mind Reader: the pick is locked in and stays secret', st.game.phase === 'guess' && st.game.x.pick === undefined && !JSON.stringify(st.game).includes('"pick":"a"'));
  await ipad.tap(`[data-who="${guessers[0]}"]`); await sleep(300);
  await ipad.shot(path.join(OUT, 'ipad-mr-guess.png'));
  await ipad.tap('[data-gs="a"]'); await sleep(300);
  await tvLook('tv-mr-guess.png');
  await ipad.tap(`[data-who="${guessers[1]}"]`); await ipad.tap('[data-gs="b"]'); await sleep(2200);
  st = await state();
  check('Mind Reader: the right guess scores, the wrong one does not', st.game.phase === 'reveal' && st.game.x.pick === 'a' && st.players.find(p => p.id === guessers[0]).score === 300 && st.players.find(p => p.id === guessers[1]).score === 0 && st.players.find(p => p.id === spot).score === 100, JSON.stringify(st.game.x.gained));
  await sleep(900);
  check('TV reveal: the chosen option is lit, guesser faces under their choice', await tv.eval(`!!document.querySelector('.mr-card.chosen') && document.querySelectorAll('.mr-card .guessers .av').length === 2`));
  await tvLook('tv-mr-reveal.png');
  await ipad.shot(path.join(OUT, 'ipad-mr-reveal.png'));
  await ipad.tap('#gEnd'); await sleep(400);
  // Caption Chaos
  await ipad.tap('[data-start="caption-chaos"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  check('Caption Chaos: a scene to caption, no elf without a key', st.game.phase === 'write' && !!st.game.x.scene && st.game.x.elf === false);
  await ipad.shot(path.join(OUT, 'ipad-cc-who.png'));
  await tvLook('tv-cc-write.png');
  const caps = { [gma]: 'Honestly I just wanted one more cookie before the whole chimney thing got weird', [dad]: 'Not the face, not the face', [lily]: 'I regret everything' };
  for (const id of [gma, dad, lily]) {
    await ipad.tap(`[data-who="${id}"]`); await sleep(200);
    await ipad.tap('#capText'); await ipad.type(caps[id]);
    if (id === gma) await ipad.shot(path.join(OUT, 'ipad-cc-write.png'));
    await ipad.tap('#capGo'); await sleep(300);
  }
  await sleep(2000);
  st = await state();
  check('Caption Chaos: all captions in, anonymous vote starts', st.game.phase === 'vote' && st.game.x.entries.length === 3 && !JSON.stringify(st.game.x.entries).includes('author'));
  await tvLook('tv-cc-vote.png');
  await ipad.tap(`[data-who="${gma}"]`); await sleep(300);
  check('Caption Chaos: you never see your own caption in the vote', await ipad.eval(`document.querySelectorAll('[data-cap]').length === 2 && ![...document.querySelectorAll('[data-cap]')].some(b => b.textContent.includes('one more cookie'))`));
  await ipad.shot(path.join(OUT, 'ipad-cc-vote.png'));
  await ipad.tap('[data-cap]'); await sleep(300);
  for (const id of [dad, lily]) { await ipad.tap(`[data-who="${id}"]`); await ipad.tap('[data-cap]'); await sleep(300); }
  await sleep(2400);
  st = await state();
  check('Caption Chaos: reveal names the authors and pays the votes', st.game.phase === 'reveal' && st.game.x.entries.every(e => e.author && e.voters) && Object.values(st.game.x.gained).every(v => v >= 200) && st.game.x.winners.length >= 1, JSON.stringify(st.game.x.gained));
  await sleep(1500);
  check('TV reveal: winning caption is large with its author', await tv.eval(`!!document.querySelector('.cc.reveal .cc-entry.win') && document.querySelectorAll('.cc.reveal .cc-entry').length === 3`));
  await tvLook('tv-cc-reveal.png');
  await ipad.shot(path.join(OUT, 'ipad-cc-reveal.png'));
  await ipad.tap('#gEnd'); await sleep(400);
  // a full short game ends on the podium
  await act('game.start', { kind: 'most-likely', rounds: 1 }); await act('game.next'); await sleep(300);
  for (const id of [gma, dad, lily]) await act('game.ballot', { pid: id, target: lily });
  await sleep(1800); await act('game.next'); await sleep(1500);
  st = await state();
  check('family game ends on the podium with a champion', st.game.phase === 'final' && st.game.champs.length >= 1 && await tv.eval(`document.querySelectorAll('.podium .av').length === 3`));
  await tvLook('tv-ml-final.png');
  await act('game.end'); await sleep(300);
  await ipad.tap('.tab[data-tab="games"]').catch(() => { });
  // ---------- drawing games: Ornament Workshop, Portrait Studio, Sketch Telephone (real Pencil strokes) ----------
  // a Pencil stroke around the pad (the same CDP pen input the Pictionary check uses)
  const penStroke = async (page, sel, { rx = 0.2, ry = 0.28, n = 28 } = {}) => {
    const r = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const at = a => ({ x: r.x + r.w * (0.5 + rx * Math.cos(a)), y: r.y + r.h * (0.5 + ry * Math.sin(a)) });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at(0), button: 'left', clickCount: 1, pointerType: 'pen', force: 0.6 });
    for (let i = 1; i <= n; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(i / n * Math.PI * 2), button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 }); await sleep(12); }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(0), button: 'left', clickCount: 1, pointerType: 'pen' });
    await sleep(120);
  };
  const strokes = () => ipad.eval(`window.__np.ui.dd.pad ? window.__np.ui.dd.pad.strokes.length : -1`);
  // brightness around a hung ornament, read from the tree's own canvas
  const ornBright = (page, tree, i = 0) => page.eval(`(() => { const t = ${tree}; const o = t.orn[${i}]; if (!o) return -1; const tg = t.ornamentTarget(o.slot), b = t.c.getBoundingClientRect(); const x = Math.round((tg.x - b.left) * t.dpr), y = Math.round((tg.y - b.top) * t.dpr); const d = t.c.getContext('2d').getImageData(x - 3, y - 3, 7, 7).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += (d[k] + d[k + 1] + d[k + 2]) / 3; return Math.round(s / (d.length / 4)); })()`);
  const imgsLoaded = (page, tree) => page.eval(`[...${tree}.ornImg.values()].length > 0 && [...${tree}.ornImg.values()].every(i => i.complete && i.naturalWidth > 0)`);
  await act('game.photo', { pid: gma, photo: jpeg }); await act('game.photo', { pid: lily, photo: jpeg });
  const rows3 = await ipad.eval(`[...document.querySelectorAll('.game-list .row')].map(e => e.querySelector('.t').textContent + '|' + e.querySelector('.s').textContent)`);
  check('Games list has Ornament Workshop, Portrait Studio and Sketch Telephone with a blurb', ['Ornament Workshop', 'Portrait Studio', 'Sketch Telephone'].every(n => rows3.some(r => r.startsWith(n + '|') && r.length > n.length + 30)), rows3.length + ' rows');

  // --- 1. Ornament Workshop ---
  await ipad.tap('[data-start="ornaments"]'); await sleep(300);
  await ipad.shot(path.join(OUT, 'ipad-ornament-lobby.png'));
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  check('Ornament Workshop opens (no rounds, no scores)', st.game?.kind === 'ornaments' && st.game.phase === 'workshop' && st.ornaments.length === 0);
  await ipad.shot(path.join(OUT, 'ipad-ornament-who.png'));
  await tvLook('tv-ornament-workshop.png');
  await ipad.tap(`[data-orn="${lily}"]`); await sleep(400);
  const onPad = await ipad.eval(`(() => { const p = document.querySelector('#dpad'); const r = p.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { round: p.classList.contains('round'), w: Math.round(r.width), h: Math.round(r.height), hit: top === p || p.contains(top), vh: innerHeight, bottom: Math.round(r.bottom) }; })()`);
  check('ornament pad is big, round and tappable on the iPad', onPad.round && onPad.w > 380 && Math.abs(onPad.w - onPad.h) < 3 && onPad.hit && onPad.bottom < onPad.vh, JSON.stringify(onPad));
  await penStroke(ipad, '#dpad');
  check('a Pencil stroke lands on the ornament pad', await strokes() === 1);
  // palm rejection: once a Pencil has been seen, finger touches do not draw
  const pr = await ipad.eval(`(() => { const r = document.querySelector('#dpad').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
  await ipad.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pr.x, y: pr.y }] });
  await ipad.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pr.x + 60, y: pr.y + 40 }] });
  await ipad.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  check('palm rejection: a finger touch after the Pencil draws nothing', await strokes() === 1);
  await ipad.tap('.dd-head'); // CDP quirk: the first tap after a synthetic touch drag is swallowed, so settle it on a harmless spot
  await ipad.tap('.dd-chips .chip[data-k="#d4a21f"]'); await ipad.tap('.dd-sizes .dd-size:nth-child(2)');
  await penStroke(ipad, '#dpad', { rx: 0.1, ry: 0.1 });
  check('gold + thick brush add a second stroke', await strokes() === 2 && await ipad.eval(`window.__np.ui.dd.pad.strokes[1].c === '#d4a21f' && window.__np.ui.dd.pad.strokes[1].w > 0.015`));
  await ipad.tap('#ddUndo');
  check('Undo removes the last stroke', await strokes() === 1);
  await ipad.tap('[data-ball="#1b2745"]');
  await ipad.tap('.dd-chips .chip[data-k="#f6efe0"]'); await penStroke(ipad, '#dpad', { rx: 0.3, ry: 0.15 });
  await ipad.shot(path.join(OUT, 'ipad-ornament-pad.png'));
  await ipad.tap('#ddClear');
  check('Clear wipes the pad', await strokes() === 0);
  await ipad.tap('[data-ball="#f6efe0"]'); await penStroke(ipad, '#dpad'); await ipad.tap('.dd-chips .chip[data-k="#d6312b"]'); await penStroke(ipad, '#dpad', { rx: 0.1, ry: 0.14 });
  await ipad.tap('#ddDone'); await sleep(900);
  st = await state();
  const orn1 = st.ornaments[0];
  check('"Hang it" saves an ornament by Lily', st.ornaments.length === 1 && orn1.name === 'Lily' && orn1.by === lily && st.game.x.moment?.id === orn1.id, JSON.stringify(st.ornaments));
  const pngRes = await fetch(`${BASE}/api/ornament/${orn1.id}.png?v=${orn1.at}`);
  const pngBuf = Buffer.from(await pngRes.arrayBuffer());
  check('ornament PNG is served, small, 256px, long-cached', pngRes.status === 200 && pngRes.headers.get('content-type') === 'image/png' && /max-age=31536000/.test(pngRes.headers.get('cache-control')) && pngBuf.subarray(1, 4).toString() === 'PNG' && pngBuf.readUInt32BE(16) === 256 && pngBuf.length < 100000, `${pngBuf.length} bytes`);
  check('ornament file is under the temp data dir only', fs.existsSync(path.join(DATA, 'ornaments', `${orn1.id}.png`)));
  check('the pad closes and the iPad goes back to the faces', await ipad.eval(`!document.querySelector('#dpad') && document.querySelectorAll('[data-orn]').length === 3`));
  await sleep(500);
  check('TV hanging moment: the ornament swings in with the artist and a hat', await tv.eval(`!!document.querySelector('.orn-fly img.orn-ball') && !!document.querySelector('.orn-who .hat') && document.querySelector('.orn-who b').textContent === 'Lily'`));
  await tvLook('tv-ornament-hanging.png');
  await sleep(4400);
  await tv.shot(path.join(OUT, 'tv-ornament-flying.png'));
  await sleep(1800);
  check('TV: the ornament flew onto the tree and the counter says 1', await tv.eval(`!document.querySelector('.orn-fly') && document.querySelector('#ornN').textContent === '1'`));
  await tv.shot(path.join(OUT, 'tv-ornament-landed.png'));
  // a second one, by Dad
  await ipad.tap(`[data-orn="${dad}"]`); await sleep(300);
  await penStroke(ipad, '#dpad', { rx: 0.25, ry: 0.25 }); await ipad.tap('#ddDone'); await sleep(800);
  st = await state();
  check('second ornament gets its own spot', st.ornaments.length === 2 && st.ornaments[0].slot !== st.ornaments[1].slot);
  // the keepsake: end the game and look at both trees
  await ipad.tap('#gEnd'); await sleep(1800);
  check('ending the workshop brings the tree back', await ipad.eval(`!document.body.classList.contains('gamemode')`));
  await ipad.tap('.tab[data-tab="lights"]'); await sleep(900);
  check('iPad tree has both ornaments', await ipad.eval(`window.__np.tree.orn.length === 2`) && await imgsLoaded(ipad, 'window.__np.tree'));
  const ib = await ornBright(ipad, 'window.__np.tree');
  check('iPad tree really draws an ornament at its spot (bright cream on dark boughs)', ib > 120, `brightness ${ib}`);
  await ipad.shot(path.join(OUT, 'ipad-tree-ornaments.png'));
  await tvLook('tv-home-ornaments.png'); // the TV tab is in the background: bring it forward so it paints
  check('TV home tree has both ornaments', await tv.eval(`window.__tv.homeTree.orn.length === 2`) && await imgsLoaded(tv, 'window.__tv.homeTree'));
  const tb = await ornBright(tv, 'window.__tv.homeTree');
  check('TV tree really draws an ornament at its spot', tb > 120, `brightness ${tb}`);
  // they persist across a page reload
  await ipad.goto(`${BASE}/`); await sleep(1800);
  check('ornaments persist after a reload', await ipad.eval(`window.__np.tree.orn.length === 2`));
  // taking one off: Setup lists them, x asks first
  await ipad.tap('.tab[data-tab="setup"]'); await sleep(500);
  await ipad.eval(`window.__asked = []; window.confirm = m => (window.__asked.push(m), false)`);
  await ipad.tap(`[data-orn-del="${orn1.id}"]`); await sleep(300);
  check('removing asks first; saying no keeps it', await ipad.eval(`window.__asked.length === 1`) && (await state()).ornaments.length === 2);
  await ipad.eval(`window.confirm = () => true`);
  await ipad.tap(`[data-orn-del="${orn1.id}"]`); await sleep(600);
  check('confirmed removal takes it off the tree and deletes the file', (await state()).ornaments.length === 1 && (await fetch(`${BASE}/api/ornament/${orn1.id}.png`)).status === 404 && !fs.existsSync(path.join(DATA, 'ornaments', `${orn1.id}.png`)));
  await ipad.shot(path.join(OUT, 'ipad-setup-ornaments.png'));
  await ipad.tap('.tab[data-tab="games"]'); await sleep(300);

  // --- 2. Portrait Studio ---
  await ipad.tap('[data-start="portraits"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  check('Portrait Studio: drawing phase, nothing about who draws whom in public state', st.game.phase === 'draw' && !/assign|subject/.test(JSON.stringify(st.game)));
  await ipad.shot(path.join(OUT, 'ipad-portrait-who.png'));
  await tvLook('tv-portrait-draw.png');
  const pname = { [gma]: 'Grandma', [dad]: 'Dad', [lily]: 'Lily' }, subjects = {};
  let peeked = false;
  for (const id of [gma, dad, lily]) {
    await ipad.tap(`[data-pdraw="${id}"]`); await sleep(300);
    if (!peeked) { check('secret stays hidden until "show me who"', await ipad.eval(`!document.querySelector('.dd-name') && !!document.querySelector('#ddShow')`)); await ipad.shot(path.join(OUT, 'ipad-portrait-confirm.png')); }
    await ipad.tap('#ddShow'); await sleep(500);
    subjects[id] = await ipad.eval(`document.querySelector('.dd-name').textContent`);
    check(`${pname[id]} is told to draw somebody else (${subjects[id]})`, subjects[id] !== pname[id] && Object.values(pname).includes(subjects[id]));
    if (!peeked) {
      peeked = true;
      await ipad.tap('#ddHint'); await sleep(500);
      check('hint: the subject\'s photo shows faintly over the pad', await ipad.eval(`(() => { const i = document.querySelector('.dd-peek'); return !!i && getComputedStyle(i).opacity < 0.5; })()`));
      await ipad.shot(path.join(OUT, 'ipad-portrait-hint.png'));
      await sleep(3300);
      check('hint: gone after 3 seconds, and only once', await ipad.eval(`!document.querySelector('.dd-peek') && document.querySelector('#ddHint').disabled`));
    }
    await penStroke(ipad, '#dpad');
    if (id === gma) {
      await ipad.shot(path.join(OUT, 'ipad-portrait-pad.png'));
      check('TV: Grandma is drawing, timer running, no subject shown', await tv.eval(`document.querySelector('.dg-h').textContent.includes('Grandma is drawing') && !!document.querySelector('.dg .timer')`));
      await tvLook('tv-portrait-drawing.png');
    }
    await ipad.tap('#ddDone'); await sleep(700);
  }
  check('everyone is drawn exactly once', new Set(Object.values(subjects)).size === 3);
  await sleep(2600);
  st = await state();
  check('gallery opens with 3 untitled works', st.game.phase === 'gallery' && st.game.x.entries.length === 3 && st.game.x.entries.every(e => /^Untitled No\. \d+$/.test(e.title) && /on iPad$/.test(e.medium)), st.game.phase);
  await sleep(500);
  check('TV gallery: gold frame, real photo and a museum placard', await tv.eval(`!!document.querySelector('.gal .gframe') && document.querySelectorAll('.gcorner').length === 4 && !!document.querySelector('.pframe') && /Untitled No\\./.test(document.querySelector('.pl-title').textContent) && /on iPad/.test(document.querySelector('.pl-by').textContent)`));
  await tvLook('tv-portrait-gallery-frame.png');
  await sleep(4000);
  const critic = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'portrait-critic.json'), 'utf8'));
  const review = await tv.eval(`document.querySelector('#plRv')?.textContent || ''`);
  check('TV gallery: the critic review appears on the placard (written pool, no AI key)', critic.includes(review.replace(/^“|”$/g, '')), review);
  await tv.shot(path.join(OUT, 'tv-portrait-gallery-review.png'));
  await ipad.shot(path.join(OUT, 'ipad-portrait-gallery.png'));
  await ipad.tap('#gNext'); await sleep(900);
  await ipad.tap('#gNext'); await sleep(900);
  await ipad.tap('#gNext'); await sleep(1200);
  st = await state();
  check('Next walks the gallery, then voting opens', st.game.phase === 'vote', st.game.phase);
  await tvLook('tv-portrait-vote.png');
  for (const id of [gma, dad, lily]) {
    await ipad.tap(`[data-pvote="${id}"]`); await sleep(300);
    if (id === gma) {
      check('voting: your own portrait is not offered', await ipad.eval(`document.querySelectorAll('[data-acc]').length === 2 && document.querySelectorAll('[data-fun]').length === 2`));
      await ipad.shot(path.join(OUT, 'ipad-portrait-vote.png'));
    }
    await ipad.tap('[data-acc]'); await sleep(150); await ipad.tap('[data-fun]:last-child'); await sleep(150);
    await ipad.tap('#vLock'); await sleep(500);
  }
  await sleep(2600);
  st = await state();
  check('votes score: winners named, points paid', st.game.phase === 'reveal' && st.game.x.results.winners.accurate.length >= 1 && st.game.x.results.winners.funny.length >= 1 && Object.values(st.game.x.gained).every(v => v >= 200), JSON.stringify(st.game.x.gained));
  await sleep(1400);
  check('TV reveal: ribbons on the winning frames', await tv.eval(`document.querySelectorAll('.wall-i .ribbon').length >= 2`));
  await tvLook('tv-portrait-reveal.png');
  await ipad.shot(path.join(OUT, 'ipad-portrait-reveal.png'));
  await ipad.tap('#gNext'); await sleep(1500);
  st = await state();
  check('Portrait Studio ends on the podium', st.game.phase === 'final' && await tv.eval(`document.querySelectorAll('.podium .av').length === 3`));
  await ipad.tap('#gEnd'); await sleep(400);

  // --- 3. Sketch Telephone ---
  await ipad.tap('.tab[data-tab="games"]').catch(() => { });
  await ipad.tap('[data-start="telephone"]'); await sleep(300);
  await ipad.tap('#gNext'); await sleep(700);
  st = await state();
  check('Sketch Telephone: 3 players, 3 steps, step 1 is drawing', st.game.phase === 'step' && st.game.total === 3 && st.game.x.kind === 'draw' && !/prompt|\/api\/drawing/.test(JSON.stringify(st.game)));
  await ipad.shot(path.join(OUT, 'ipad-tp-who.png'));
  await tvLook('tv-tp-step.png');
  const phrase = {}, guesses = {};
  for (let step = 0; step < 3; step++) {
    const kind = (await state()).game.x.kind;
    for (const id of [gma, dad, lily]) {
      await ipad.tap(`[data-tstep="${id}"]`); await sleep(250);
      if (step === 0 && id === gma) await ipad.shot(path.join(OUT, 'ipad-tp-confirm.png'));
      await ipad.tap('#ddShow'); await sleep(500);
      if (kind === 'draw') {
        const text = await ipad.eval(`document.querySelector('.dd-phrase').textContent`);
        if (step === 0) phrase[id] = text; else check(`step ${step + 1}: ${pname[id]} draws someone else's guess, not their own phrase`, Object.values(guesses).includes(text) && text !== phrase[id], text);
        await penStroke(ipad, '#dpad', { rx: 0.15 + step * 0.05, ry: 0.2 });
        if (step === 0 && id === gma) await ipad.shot(path.join(OUT, 'ipad-tp-draw.png'));
        await ipad.tap('#ddDone');
      } else {
        const src = await ipad.eval(`document.querySelector('.dd-art')?.getAttribute('src') || ''`);
        if (id === gma) { check('guessing: the iPad shows only the previous drawing', src.startsWith('/api/drawing/') && await ipad.eval(`!document.querySelector('#dpad') && !!document.querySelector('#tpGuess')`)); await ipad.shot(path.join(OUT, 'ipad-tp-guess.png')); }
        guesses[id] = `a very confused ${pname[id].toLowerCase()} thing`;
        await ipad.tap('#tpGuess'); await ipad.type(guesses[id]);
        await ipad.tap('#ddDone');
      }
      await sleep(500);
    }
    await sleep(2300);
  }
  check('3 different starting phrases', new Set(Object.values(phrase)).size === 3, JSON.stringify(phrase));
  st = await state();
  check('after the last step the reveal starts with every chain complete', st.game.phase === 'reveal' && st.game.x.chains.length === 3 && st.game.x.chains.every(c => c.steps.length === 3 && new Set(c.steps.map(s => s.by)).size === 3));
  await tvLook('tv-tp-reveal-first.png');
  await ipad.shot(path.join(OUT, 'ipad-tp-reveal.png'));
  let sawThen = false, sawCmp = false, taps = 0;
  while ((await state()).game.phase === 'reveal' && taps < 30) {
    await ipad.tap('#tpNext'); taps++;
    await sleep(800);
    const x = (await state()).game.x;
    if (x && x.show >= 3 && !sawThen && !x.cmp) { sawThen = await tv.eval(`!!document.querySelector('.tp-then')`); await tv.shot(path.join(OUT, 'tv-tp-reveal-step.png')); }
    if (x && x.cmp && !sawCmp) { sawCmp = await tv.eval(`!!document.querySelector('.tp-cmp .tp-quote')`); await tvLook('tv-tp-reveal-compare.png'); }
  }
  check('reveal: "and then…" transitions and a started-as / ended-as comparison', sawThen && sawCmp, `then ${sawThen} cmp ${sawCmp} taps ${taps}`);
  check('reveal took 5 Next taps per chain (3 steps + compare + next chain)', taps === 15, `${taps}`);
  st = await state();
  check('after the last chain, voting for the favourite moment', st.game.phase === 'vote');
  await ipad.tap(`[data-tvote="${gma}"]`); await sleep(300);
  check('voting: your own steps are not offered', await ipad.eval(`document.querySelectorAll('[data-moment]').length === 6`));
  await ipad.shot(path.join(OUT, 'ipad-tp-vote.png'));
  await ipad.tap('[data-moment]'); await ipad.tap('#vLock'); await sleep(400);
  for (const id of [dad, lily]) { await ipad.tap(`[data-tvote="${id}"]`); await sleep(250); await ipad.tap('[data-moment]'); await ipad.tap('#vLock'); await sleep(400); }
  await sleep(2600);
  st = await state();
  check('verdict: a favourite moment and the chain that went furthest', st.game.phase === 'verdict' && st.game.x.winners.length >= 1 && !!st.game.x.furthest, JSON.stringify(st.game.x.furthest));
  await sleep(900);
  await tvLook('tv-tp-verdict.png');
  await ipad.shot(path.join(OUT, 'ipad-tp-verdict.png'));
  await ipad.tap('#gNext'); await sleep(1500);
  check('Sketch Telephone ends on the podium', (await state()).game.phase === 'final' && await tv.eval(`document.querySelectorAll('.podium .av').length === 3`));
  await ipad.tap('#gEnd'); await sleep(400);
  await act('game.photo', { pid: gma, photo: jpeg }).catch(() => { });
  await ipad.tap('.tab[data-tab="games"]').catch(() => { });

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
