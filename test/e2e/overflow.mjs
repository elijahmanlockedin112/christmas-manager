// Text-overflow audit for every TV scene, at several screen sizes, with the longest real content.
// node test/e2e/overflow.mjs [outDir]  -> lists every text box that runs off the screen or out of its box.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

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
    for (const [name, fn] of cases) {
      await fn(); await sleep(1300);
      const bad = await p.eval(AUDIT);
      await p.shot(path.join(OUT, `${w}-${name}.png`));
      report.push(`${w}x${h} ${name}: ${bad.length ? bad.join(' | ') : 'ok'}`);
    }
    await act('show.stop');
    // games with real players
    for (const n of ['Grandma Rosemary', 'Uncle Bartholomew', 'Lily', 'Dad']) await act('game.addPlayer', { name: n }).catch(() => { });
    for (const kind of ['trivia', 'would-you-rather', 'name-that-song', 'pictionary']) {
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
    p.close();
  }
} finally {
  await chrome.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
}
const fails = report.filter(l => !l.endsWith(': ok'));
console.log(fails.length ? fails.join('\n') : 'all scenes fit');
console.log(`\n${report.length - fails.length}/${report.length} scene checks fit. Shots in ${OUT}`);
process.exit(fails.length ? 1 : 0);
