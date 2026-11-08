// Text-overflow audit for every TV scene, at several screen sizes, with the longest real content.
// node test/e2e/overflow.mjs [outDir]  -> lists every text box that runs off the screen or out of its box.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { pngUrl } from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'np-overflow');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 47949, BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), 'np-overflow-data');
fs.rmSync(DATA, { recursive: true, force: true });
const srv = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), XM_DATA: DATA, XM_HUE_PORT: '0' }, stdio: 'ignore' });
for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/state`); break; } catch { await sleep(200); } }
const act = (n, a = {}) => fetch(`${BASE}/api/act/${n}`, { method: 'POST', body: JSON.stringify(a) }).then(r => r.json());
const longest = (arr, f) => arr.slice().sort((a, b) => f(b).length - f(a).length)[0];
const jokes = [...JSON.parse(fs.readFileSync(path.join(ROOT, 'content/jokes-1.json'))), ...JSON.parse(fs.readFileSync(path.join(ROOT, 'content/jokes-2.json')))];
const lj = longest(jokes, j => j.q + j.a);

// the check that runs inside the page: any visible text box outside the safe screen, or clipped inside its box
const AUDIT = `(() => {
  const W = innerWidth, H = innerHeight, bad = [];
  const scene = document.querySelector('.scene.on');
  if (!scene) return ['no scene'];
  for (const el of scene.querySelectorAll('*')) {
    if (!el.childNodes.length || el.closest('svg')) continue;
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const label = (el.className || el.tagName) + ': ' + el.textContent.trim().slice(0, 40);
    if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) bad.push('OFF SCREEN ' + label + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ']');
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') bad.push('CLIPPED ' + label);
    // a word too long for the width spills past the right edge of its own box
    const range = document.createRange(); range.selectNodeContents(el);
    const tr = range.getBoundingClientRect();
    if (tr.right > W + 1) bad.push('TEXT PAST EDGE ' + label);
  }
  return bad;
})()`;

const cases = [
  ['home', async () => act('tv.scene', { scene: 'home' })],
  ['countdown', async () => act('tv.scene', { scene: 'countdown' })],
  ['joke-long', async () => { await act('joke.tell', { q: lj.q, a: lj.a, kind: lj.kind, say: false }); await sleep(5200); }],
  ['message-120', async () => act('tv.message', { text: 'Grandma says the cookies are out of the oven, everyone wash your hands and come to the kitchen before Dad eats all!!', from: 'The North Pole Kitchen Elves' })],
  ['scanner', async () => act('scanner.result', { name: 'Maximiliana-Jo' })],
  ['advent', async () => { const adv = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/advent.json'))); const d = longest(adv, a => a.title + a.challenge + a.fact); await act('advent.open', { day: d.day }); }],
  ['santa', async () => { await act('santa.preview', { speed: 3000 }); await sleep(2500); }],
  ['setup', async () => act('tv.scene', { scene: 'setup' })],
  ['ai-report', async () => { await act('ai.demo', { kind: 'report' }); await sleep(800); }],
  ['ai-madlibs', async () => act('ai.demo', { kind: 'madlibs' })],
  ['ai-santa', async () => act('ai.demo', { kind: 'santa' })],
  ['nicelist', async () => act('tv.scene', { scene: 'nicelist' })],
  ['radio', async () => { await act('radio.play', { channel: 'deptstore' }); await sleep(3000); }],
  ['show', async () => { await act('radio.stop'); await act('show.play', { song: 'god-rest-ye' }); await sleep(7000); }],
];

const sizes = [[1920, 1080], [1280, 720], [1024, 768]];
const chrome = await launch({ port: 9377 });
const report = [];
try {
  for (const [w, h] of sizes) {
    const p = await chrome.page(`${BASE}/tv`, { width: w, height: h, scale: 0.5 });
    await sleep(1500);
    for (const [name, fn] of (process.env.PARTY_ONLY || process.env.DRAW_ONLY) ? [] : cases) {
      await fn(); await sleep(1300);
      const bad = await p.eval(AUDIT);
      await p.shot(path.join(OUT, `${w}-${name}.png`));
      report.push(`${w}x${h} ${name}: ${bad.length ? bad.join(' | ') : 'ok'}`);
    }
    await act('show.stop');
    // games with real players
    for (const n of ['Grandma Rosemary', 'Uncle Bartholomew', 'Lily', 'Dad']) await act('game.addPlayer', { name: n }).catch(() => { });
    for (const kind of (process.env.PARTY_ONLY || process.env.DRAW_ONLY) ? [] : ['trivia', 'would-you-rather', 'name-that-song', 'pictionary']) {
      await act('game.start', { kind }); await sleep(500);
      let bad = await p.eval(AUDIT); report.push(`${w}x${h} ${kind}-lobby: ${bad.length ? bad.join(' | ') : 'ok'}`);
      for (let r = 0; r < (kind === 'trivia' ? 6 : 2); r++) {
        await act('game.next'); await sleep(900);
        bad = await p.eval(AUDIT);
        report.push(`${w}x${h} ${kind}-r${r + 1}: ${bad.length ? bad.join(' | ') : 'ok'}`);
        if (r === 0) await p.shot(path.join(OUT, `${w}-${kind}.png`));
        await act('game.reveal', {}); await sleep(700);
        bad = await p.eval(AUDIT);
        report.push(`${w}x${h} ${kind}-reveal${r + 1}: ${bad.length ? bad.join(' | ') : 'ok'}`);
      }
      await act('game.end'); await sleep(300);
    }
    // the family games, with the longest names and captions the iPad allows
    const ids = (await fetch(`${BASE}/api/state`).then(r => r.json())).players.map(p => p.id);
    const audit = async tag => { const bad = await p.eval(AUDIT); report.push(`${w}x${h} ${tag}: ${bad.length ? bad.join(' | ') : 'ok'}`); };
    const long = 'Honestly I only wanted one more cookie before the chimney thing got really weird';
    for (const kind of process.env.DRAW_ONLY ? [] : ['most-likely', 'mind-reader', 'caption-chaos']) {
      await act('game.start', { kind, rounds: 2 }); await sleep(500); await audit(`${kind}-lobby`);
      for (let r = 0; r < 2; r++) {
        await act('game.next'); await sleep(900);
        if (kind === 'most-likely') {
          await audit(`${kind}-vote${r + 1}`);
          for (const id of ids.slice(0, 3)) await act('game.ballot', { pid: id, target: ids[1] });
          await act('game.reveal'); await sleep(1500); await audit(`${kind}-reveal${r + 1}`);
        } else if (kind === 'mind-reader') {
          await audit(`${kind}-turn${r + 1}`);
          await act('game.turnReady', {}); await sleep(600); await audit(`${kind}-pick${r + 1}`);
          const spot = (await fetch(`${BASE}/api/state`).then(r => r.json())).game.x.spot.id;
          await act('game.pickSide', { pid: spot, side: 'b' }); await sleep(500);
          for (const id of ids.filter(i => i !== spot)) await act('game.guessSide', { pid: id, side: id === ids[0] ? 'b' : 'a' });
          await sleep(300); await audit(`${kind}-guess${r + 1}`);
          await act('game.reveal'); await sleep(1500); await audit(`${kind}-reveal${r + 1}`);
        } else {
          await audit(`${kind}-write${r + 1}`);
          for (const id of ids) await act('game.caption', { pid: id, text: long });
          await act('game.reveal'); await sleep(1500); await audit(`${kind}-vote${r + 1}`);
          for (const id of ids) { await act('game.ballot', { pid: id, target: 'c0' }); await act('game.ballot', { pid: id, target: 'c1' }); }
          await act('game.reveal'); await sleep(1500); await audit(`${kind}-reveal${r + 1}`);
        }
      }
      await act('game.end'); await sleep(300);
    }
    // the drawing games, with real PNGs and the longest names (a pretend drawing from each player)
    const ids2 = (await fetch(`${BASE}/api/state`).then(r => r.json())).players.map(q => q.id);
    const shot = async tag => { await p.shot(path.join(OUT, `${w}-${tag}.png`)); };
    const longName = 'Honestly one more cookie before the chimney thing got really weird';
    // Ornament Workshop: lobby, workshop, the hanging moment, the ornament landed
    await act('game.start', { kind: 'ornaments' }); await sleep(500); await audit('ornaments-lobby');
    await act('game.next'); await sleep(900); await audit('ornaments-workshop'); await shot('ornaments-workshop');
    for (let i = 0; i < 3; i++) await act('game.ornamentHang', { pid: ids2[i], png: pngUrl(256, 256, 'art', i + 1) });
    await sleep(1800); await audit('ornaments-moment'); await shot('ornaments-moment');
    await sleep(5200); await audit('ornaments-landed'); await shot('ornaments-landed');
    await act('game.end'); await sleep(600);
    // Portrait Studio
    await act('game.start', { kind: 'portraits' }); await sleep(500); await audit('portraits-lobby');
    await act('game.next'); await sleep(900); await audit('portraits-draw');
    const first = await act('game.drawStart', { pid: ids2[0] }); await sleep(700); await audit('portraits-drawing'); await shot('portraits-drawing');
    await act('game.drawSubmit', { pid: ids2[0], png: pngUrl(720, 540, 'art', 0) });
    for (let i = 1; i < ids2.length; i++) { await act('game.drawStart', { pid: ids2[i] }); await act('game.drawSubmit', { pid: ids2[i], png: pngUrl(720, 540, 'art', i) }); }
    await sleep(2800); await audit('portraits-gallery-frame'); await shot('portraits-gallery-frame');
    await sleep(4600); await audit('portraits-gallery-review'); await shot('portraits-gallery-review');
    for (let i = 0; i < ids2.length; i++) await act('game.next');
    await sleep(1000); await audit('portraits-vote'); await shot('portraits-vote');
    const pstate = (await fetch(`${BASE}/api/state`).then(r => r.json())).game;
    for (const id of ids2) { const pick = pstate.x.entries.find(e => e.artist !== id); await act('game.portraitVote', { pid: id, accurate: pick.n, funny: pick.n }); }
    await sleep(2800); await audit('portraits-reveal'); await shot('portraits-reveal');
    await act('game.end'); await sleep(500);
    // Sketch Telephone
    await act('game.start', { kind: 'telephone' }); await sleep(500); await audit('telephone-lobby');
    await act('game.next'); await sleep(900); await audit('telephone-step');
    await act('game.drawStart', { pid: ids2[0] }); await sleep(600); await audit('telephone-drawing'); await shot('telephone-drawing');
    for (let step = 0; step < ids2.length; step++) {
      const kind = (await fetch(`${BASE}/api/state`).then(r => r.json())).game.x.kind;
      for (const [i, id] of ids2.entries()) {
        await act('game.drawStart', { pid: id });
        await act('game.drawSubmit', kind === 'draw' ? { pid: id, png: pngUrl(720, 540, 'art', i + step) } : { pid: id, text: longName.slice(0, 60) });
      }
      await sleep(2200);
    }
    await audit('telephone-reveal-first'); await shot('telephone-reveal-first');
    let n = 0;
    while ((await fetch(`${BASE}/api/state`).then(r => r.json())).game.phase === 'reveal' && n < 40) {
      await act('game.next'); n++; await sleep(1700);
      const x = (await fetch(`${BASE}/api/state`).then(r => r.json())).game.x;
      if (n === 3) { await audit('telephone-reveal-step'); await shot('telephone-reveal-step'); }
      if (x?.cmp && !report.some(l => l.includes(`${w}x${h} telephone-compare`))) { await audit('telephone-compare'); await shot('telephone-compare'); }
    }
    await audit('telephone-vote'); await shot('telephone-vote');
    const tg = (await fetch(`${BASE}/api/state`).then(r => r.json())).game;
    for (const id of ids2) { let m; for (const [ci, ch] of tg.x.chains.entries()) for (const [si, st] of ch.steps.entries()) if (!m && st.by !== id) m = `${ci}.${si}`; await act('game.tpVote', { pid: id, moment: m }); }
    await sleep(2800); await audit('telephone-verdict'); await shot('telephone-verdict');
    await act('game.end'); await sleep(300);
    p.close();
  }
} finally {
  await chrome.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
}
const fails = report.filter(l => !l.endsWith(': ok'));
console.log(fails.length ? fails.join('\n') : 'all scenes fit');
console.log(`\n${report.length - fails.length}/${report.length} scene checks fit. Shots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
