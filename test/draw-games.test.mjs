// Drawing games (server/draw-games.mjs): the derangement, the chain schedule, secrecy before the reveal,
// the PNG upload checks, ornament persistence and the art critic's fallback. No network, no timers left running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pngUrl } from './e2e/png.mjs';
import { Games } from '../server/games.mjs';
import { derange, telephoneSchedule, telephoneChain, readPng, drift } from '../server/draw-games.mjs';
import { ornamentSpot, ORN_CAP } from '../shared/ornament.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));

// a real, valid PNG (random pixels so it is not tiny)
const png = (w = 160, h = 120) => pngUrl(w, h, 'noise');

function room(n = 5, { ai = null, alexa = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-draw-'));
  const spoken = [];
  const app = {
    dataDir, config: { roster: [], settings: {} }, saveConfig() { }, changed() { }, log() { }, sfx() { }, ai,
    alexa: alexa === 'ready' ? { ready: true, speak: async t => { spoken.push(t); } } : alexa === 'broken' ? { ready: true, speak: async () => { throw new Error('echo down'); } } : { ready: false, speak: async t => { spoken.push(t); } },
    state: { tv: {}, show: {} }, setTvScene() { },
    lights: { overlay() { }, clearOverlays() { } },
    content: { telephone: json('telephone.json'), portraitCritic: json('portrait-critic.json') },
  };
  const games = new Games(app);
  const ids = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'].slice(0, n).map(name => games.addLocal(name).id);
  return { games, app, ids, spoken, g: () => games.g, done: () => { games.end(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('content: 60+ telephone prompts, 30+ critic lines, all short and family-friendly', () => {
  const t = json('telephone.json'), c = json('portrait-critic.json');
  assert.ok(t.length >= 60 && c.length >= 30);
  assert.equal(new Set(t).size, t.length, 'no duplicate prompts');
  for (const p of t) assert.ok(p.length > 5 && p.length <= 48, p);
  for (const l of c) assert.ok(l.length > 20 && l.length <= 200 && !/ugly|fat|stupid|hate/i.test(l), l);
});

test('derange: nobody draws themselves, everyone is drawn exactly once', () => {
  for (const n of [2, 3, 4, 5, 6, 8]) {
    const ids = Array.from({ length: n }, (_, i) => 'p' + i);
    for (let k = 0; k < 150; k++) {
      const m = derange(ids);
      assert.ok(ids.every(id => m[id] !== id), 'a fixed point');
      assert.deepEqual(Object.values(m).sort(), ids.slice().sort());
    }
  }
  assert.throws(() => derange(['solo']), /two people/);
  // even a rigged random source (always 0) still gives a valid derangement
  const m = derange(['a', 'b', 'c'], () => 0);
  assert.ok(['a', 'b', 'c'].every(id => m[id] !== id));
});

test('telephone schedule: one step per player per chain, and nobody meets their own chain early', () => {
  for (let n = 3; n <= 8; n++) {
    const sched = telephoneSchedule(n);
    assert.equal(sched.length, n);
    const seen = Array.from({ length: n }, () => new Set()); // chain -> players who worked on it
    for (let s = 0; s < n; s++) {
      assert.equal(new Set(sched[s]).size, n, 'each chain is worked on once per step');
      for (let i = 0; i < n; i++) {
        const c = sched[s][i];
        if (s === 0) assert.equal(c, i, 'step 1 is your own phrase');
        else assert.notEqual(c, i, 'you never get your own chain back');
        assert.ok(!seen[c].has(i), 'a player worked on a chain twice');
        seen[c].add(i);
      }
    }
    for (const set of seen) assert.equal(set.size, n);
  }
  assert.equal(telephoneChain(0, 1, 5), 4);
});

test('ornament spots are spread out, inside the tree and away from the star', () => {
  const pts = Array.from({ length: ORN_CAP }, (_, k) => ornamentSpot(k));
  for (const p of pts) { assert.ok(p.y >= 0.12 && p.y <= 0.75, `y ${p.y}`); assert.ok(Math.abs(p.x) <= (0.98 - 0.94 * p.y) * 0.75 + 1e-9, 'inside the boughs'); }
  assert.equal(JSON.stringify(ornamentSpot(7)), JSON.stringify(ornamentSpot(7)), 'deterministic');
  // the first few never clump: every pair is a visible distance apart
  let min = 9;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) min = Math.min(min, Math.hypot((pts[i].x - pts[j].x) * 0.8, pts[i].y - pts[j].y));
  assert.ok(min > 0.04, `closest pair ${min}`);
});

test('PNG upload checks: type, signature, size and dimensions', () => {
  const ok = readPng(png(64, 64), { maxBytes: 150000, minDim: 64, maxDim: 512, square: true });
  assert.equal(ok.w, 64);
  assert.throws(() => readPng('data:image/jpeg;base64,/9j/4AAQSkZJRg==', { maxBytes: 1000, maxDim: 512 }), /did not come through/);
  assert.throws(() => readPng('hello', { maxBytes: 1000, maxDim: 512 }), /did not come through/);
  assert.throws(() => readPng(null, { maxBytes: 1000, maxDim: 512 }), /did not come through/);
  assert.throws(() => readPng('data:image/png;base64,' + Buffer.from('not a png at all, just text, long enough to pass the size floor of one hundred bytes xxxxxxxxxxxxxxxxxxxxxxxx').toString('base64'), { maxBytes: 5000, maxDim: 512 }), /did not come through/);
  assert.throws(() => readPng('data:image/png;base64,' + Buffer.alloc(300000, 1).toString('base64'), { maxBytes: 150000, maxDim: 512 }), /too big/);
  assert.throws(() => readPng(png(200, 100), { maxBytes: 150000, minDim: 64, maxDim: 512, square: true }), /wrong size/);
  assert.throws(() => readPng(png(900, 900), { maxBytes: 900000, minDim: 64, maxDim: 512 }), /wrong size|too big/);
  // a valid header is not enough if the base64 has stray characters
  assert.throws(() => readPng(png(64, 64) + '<script>', { maxBytes: 150000, maxDim: 512 }), /did not come through/);
});

test('ornaments: hanging saves a PNG, a record and public state; removing cleans up; the Echo is guarded', async () => {
  const r = room(3, { alexa: 'ready' });
  assert.throws(() => r.games.start('ornaments', {}) && r.games.ornamentHang(r.ids[0], png(64, 64)), /not open/);
  r.games.start('ornaments'); r.games.next();
  assert.equal(r.g().phase, 'workshop');
  assert.throws(() => r.games.ornamentHang('nobody', png(64, 64)), /Who is hanging/);
  assert.throws(() => r.games.ornamentHang(r.ids[0], png(100, 60)), /wrong size/);
  assert.throws(() => r.games.ornamentHang(r.ids[0], 'data:image/png;base64,AAAA'), /did not come through/);
  const a = r.games.ornamentHang(r.ids[0], png(256, 256));
  const b = r.games.ornamentHang(r.ids[1], png(256, 256));
  assert.notEqual(a.slot, b.slot);
  assert.ok(fs.existsSync(path.join(r.app.dataDir, 'ornaments', `${a.id}.png`)));
  assert.equal(r.app.config.ornaments.length, 2);
  assert.deepEqual(r.app.state.ornaments.map(o => o.id), [a.id, b.id]);
  assert.equal(r.g().x.moment.id, b.id);
  assert.match(r.spoken[0], /Ada hung a new ornament on the tree!/);
  const pub = JSON.stringify(r.app.state.ornaments);
  assert.ok(!pub.includes('data:image'), 'public state carries ids, not pixels');
  r.games.ornamentRemove(a.id);
  assert.ok(!fs.existsSync(path.join(r.app.dataDir, 'ornaments', `${a.id}.png`)));
  assert.equal(r.app.state.ornaments.length, 1);
  assert.throws(() => r.games.ornamentRemove(a.id), /already gone/);
  // a freed slot is used first by the next ornament
  const c = r.games.ornamentHang(r.ids[2], png(64, 64));
  assert.equal(c.slot, a.slot);
  r.done();
});

test('ornaments: only the latest 40 are on the tree, and every drawn one has its own spot', () => {
  const r = room(2);
  r.games.start('ornaments'); r.games.next();
  for (let i = 0; i < ORN_CAP + 6; i++) r.games.ornamentHang(r.ids[i % 2], png(64, 64));
  assert.equal(r.app.config.ornaments.length, ORN_CAP + 6, 'all kept on disk');
  assert.equal(r.app.state.ornaments.length, ORN_CAP);
  assert.equal(new Set(r.app.state.ornaments.map(o => o.slot)).size, ORN_CAP, 'no two drawn ornaments share a spot');
  r.done();
});

test('ornaments: a broken Echo never breaks hanging, and no Echo means no speech', () => {
  const quiet = room(2);
  quiet.games.start('ornaments'); quiet.games.next();
  quiet.games.ornamentHang(quiet.ids[0], png(64, 64));
  assert.equal(quiet.spoken.length, 0);
  quiet.done();
  const broken = room(2, { alexa: 'broken' });
  broken.games.start('ornaments'); broken.games.next();
  assert.doesNotThrow(() => broken.games.ornamentHang(broken.ids[0], png(64, 64)));
  broken.done();
});

test('portraits: assignments are secret, nobody draws themselves, only the current person can hand in', () => {
  const r = room(5);
  r.games.start('portraits'); r.games.next();
  assert.equal(r.g().phase, 'draw');
  const secretMap = r.games.secret.assign;
  // not in anything the TV or the iPad's public state carries
  const pub = JSON.stringify(r.app.state);
  for (const [artist, subject] of Object.entries(secretMap)) assert.ok(!pub.includes(`"${artist}":"${subject}"`));
  assert.ok(!('assign' in r.g().x) && !JSON.stringify(r.g()).includes('assign'));
  const seen = new Set();
  const got = {};
  for (const id of r.ids) {
    const s = r.games.drawStart(id);
    got[id] = s.subject.id;
    assert.notEqual(s.subject.id, id, 'never yourself');
    const waiting = r.ids.find(x => x !== id && !r.games.secret.done[x]);
    if (waiting) assert.throws(() => r.games.drawStart(waiting), /in the middle of a turn/);
    assert.deepEqual(r.games.drawStart(id).subject, s.subject, 'asking again gives the same person');
    if (waiting) assert.throws(() => r.games.drawSubmit(waiting, { png: png() }), /not your turn/);
    assert.throws(() => r.games.drawSubmit(id, { png: 'data:image/png;base64,AAAA' }), /did not come through/);
    r.games.drawSubmit(id, { png: png() });
    seen.add(s.subject.id);
    assert.throws(() => r.games.drawStart(id), /already did/);
  }
  assert.equal(seen.size, 5, 'everyone is drawn once');
  assert.deepEqual(got, secretMap);
  r.done();
});

test('portraits: the photo hint works once, and only for the person drawing', () => {
  const r = room(3);
  for (const id of r.ids) r.games.players.get(id).photo = 5;
  r.games.start('portraits'); r.games.next();
  assert.throws(() => r.games.portraitHint(r.ids[0]), /No peeking/);
  r.games.drawStart(r.ids[0]);
  const h = r.games.portraitHint(r.ids[0]);
  assert.equal(h.id, r.games.secret.assign[r.ids[0]]);
  assert.throws(() => r.games.portraitHint(r.ids[0]), /once/);
  r.done();
});

// runs a whole portraits round with the given critic setup and returns the room
async function portraitRound(ai) {
  const r = room(4, { ai });
  r.games.start('portraits'); r.games.next();
  for (const id of r.ids) { r.games.drawStart(id); r.games.drawSubmit(id, { png: png() }); }
  r.games.galleryStart();
  return r;
}

test('portraits: the critic falls back to the written pool with no AI', async () => {
  const r = await portraitRound(null);
  assert.equal(r.g().phase, 'gallery');
  assert.equal(r.g().x.entries.length, 4);
  const pool = new Set(json('portrait-critic.json'));
  for (let i = 0; i < 4; i++) {
    r.games.galleryFrame(i);
    await r.games.galleryReview(i);
    const e = r.g().x.entries[i];
    assert.ok(pool.has(e.review), e.review);
    assert.equal(r.g().x.stage, 'review');
  }
  r.done();
});

test('portraits: one AI call per portrait with the drawing; its line shows and is spoken; a failing AI falls back', async () => {
  const calls = [];
  const ai = { configured: true, portraitCritic: async a => { calls.push(a); return a.artist === 'Bo' ? Promise.reject(new Error('refused')) : `A towering work by ${a.artist}.`; } };
  const r = room(4, { ai, alexa: 'ready' });
  r.games.start('portraits'); r.games.next();
  for (const id of r.ids) { r.games.drawStart(id); r.games.drawSubmit(id, { png: png() }); }
  r.games.galleryStart();
  const pool = new Set(json('portrait-critic.json'));
  let aiLines = 0, fallbacks = 0;
  for (let i = 0; i < 4; i++) {
    r.games.galleryFrame(i);
    await r.games.galleryReview(i);
    const e = r.g().x.entries[i];
    if (/towering work/.test(e.review)) aiLines++; else { assert.ok(pool.has(e.review)); fallbacks++; }
  }
  assert.equal(calls.length, 4, 'exactly one call per portrait');
  assert.ok(calls.every(c => Buffer.isBuffer(c.png) && c.png.length > 500 && c.title.startsWith('Untitled No.') && c.subject && c.artist));
  assert.equal(aiLines, 3); assert.equal(fallbacks, 1);
  assert.equal(r.spoken.length, 4, 'the Echo read every review');
  assert.match(r.spoken[0], /^Untitled No\. \d+, by \w+\. /);
  // the critic never sees anyone but the artist and the person drawn
  assert.ok(calls.every(c => c.artist !== c.subject));
  r.done();
});

test('portraits: voting cannot be for your own, winners score, then the podium works', async () => {
  const r = await portraitRound(null);
  const entries = r.games.secret.entries;
  const mine = entries.find(e => e.artist === r.ids[0]), other = entries.find(e => e.artist !== r.ids[0]);
  r.games.portraitVoteStart();
  assert.equal(r.g().phase, 'vote');
  assert.throws(() => r.games.portraitVote(r.ids[0], mine.n, other.n), /your own/);
  assert.throws(() => r.games.portraitVote(r.ids[0], other.n, mine.n), /your own/);
  assert.throws(() => r.games.portraitVote(r.ids[0], 99, other.n), /one for each/);
  for (const id of r.ids) {
    const pick = entries.find(e => e.artist !== id && e.n === other.n) || entries.find(e => e.artist !== id);
    r.games.portraitVote(id, pick.n, pick.n);
  }
  r.games.portraitReveal();
  assert.equal(r.g().phase, 'reveal');
  const w = r.g().x.results.winners;
  assert.ok(w.accurate.length && w.funny.length);
  const total = [...r.games.players.values()].reduce((a, p) => a + p.score, 0);
  assert.ok(total >= 4 * 200 * 2, `scored ${total}`);
  r.games.next();
  assert.equal(r.g().phase, 'final');
  r.done();
});

test('telephone: every chain gets one step from every player, nobody sees their own chain, secrets stay hidden until the reveal', () => {
  const r = room(5);
  const prompts = new Set();
  r.games.start('telephone'); r.games.next();
  const n = 5;
  assert.equal(r.g().total, n);
  const ownPrompt = {};
  for (let step = 0; step < n; step++) {
    assert.equal(r.g().phase, 'step');
    assert.equal(r.g().x.kind, step % 2 === 0 ? 'draw' : 'guess');
    const publicJson = JSON.stringify(r.app.state);
    for (const ch of r.games.secret.chains) { assert.ok(!publicJson.includes(ch.prompt), 'a phrase leaked into public state'); prompts.add(ch.prompt); }
    for (const id of r.ids) {
      const item = r.games.drawStart(id);
      if (step === 0) { assert.equal(item.type, 'text'); ownPrompt[id] = item.text; }
      else {
        assert.notEqual(item.text, ownPrompt[id], 'you never meet your own phrase again');
        // you only ever see the single step before yours
        const c = telephoneChain(r.ids.indexOf(id), step, n);
        const prev = r.games.secret.chains[c].steps[step - 1];
        assert.notEqual(prev.by, id);
        if (r.g().x.kind === 'guess') assert.ok(item.url?.startsWith('/api/drawing/'));
        else assert.equal(item.text, prev.text);
      }
      if (r.g().x.kind === 'draw') r.games.drawSubmit(id, { png: png() }); else r.games.drawSubmit(id, { text: `guess ${step} by ${id.slice(0, 3)}` });
    }
    assert.equal(r.games.secret.ids.every(id => r.games.secret.done[id]), true);
    r.games.tpStepDone();
  }
  assert.equal(prompts.size, n, 'five different phrases');
  assert.equal(r.g().phase, 'reveal');
  const chains = r.g().x.chains;
  assert.equal(chains.length, n);
  for (const ch of chains) {
    assert.equal(ch.steps.length, n);
    assert.equal(new Set(ch.steps.map(s => s.by)).size, n, 'every player took exactly one step');
    assert.ok(ch.steps.every(s => s.by !== undefined));
    assert.equal(ch.steps[0].by, ch.owner, 'the owner drew the phrase first');
  }
  r.done();
});

test('telephone: reveal walks a chain step by step, then votes (not for your own), results and the furthest chain', () => {
  const r = room(3, { alexa: 'ready' });
  r.games.start('telephone'); r.games.next();
  const texts = ['a cat on a fence', 'banana boat', 'xylophone parade'];
  for (let step = 0; step < 3; step++) {
    for (const [i, id] of r.ids.entries()) {
      r.games.drawStart(id);
      if (r.g().x.kind === 'draw') r.games.drawSubmit(id, { png: png() }); else r.games.drawSubmit(id, { text: texts[i] });
    }
    r.games.tpStepDone();
  }
  assert.equal(r.g().phase, 'reveal');
  const seq = [];
  for (let k = 0; k < 40 && r.g().phase === 'reveal'; k++) { const x = r.g().x; seq.push(`${x.ci}:${x.show}:${x.cmp}`); r.games.tpRevealNext(); }
  assert.equal(r.g().phase, 'vote');
  assert.deepEqual(seq.slice(0, 5), ['0:1:false', '0:2:false', '0:3:false', '0:4:false', '0:4:true']);
  const mine = (() => { for (const [ci, ch] of r.games.secret.chains.entries()) for (const [si, st] of ch.steps.entries()) if (st.by === r.ids[0]) return `${ci}.${si}`; })();
  assert.throws(() => r.games.tpVote(r.ids[0], mine), /your own/);
  assert.throws(() => r.games.tpVote(r.ids[0], '9.9'), /Pick a moment/);
  const target = (() => { for (const [ci, ch] of r.games.secret.chains.entries()) for (const [si, st] of ch.steps.entries()) if (st.by === r.ids[1]) return `${ci}.${si}`; })();
  r.games.tpVote(r.ids[0], target); r.games.tpVote(r.ids[2], target);
  r.games.tpResult();
  assert.equal(r.g().phase, 'verdict');
  assert.deepEqual(r.g().x.winners, [target]);
  assert.ok(r.games.players.get(r.ids[1]).score >= 2 * 150 + 300);
  assert.ok(r.g().x.furthest, 'a furthest chain is named');
  assert.match(r.spoken.at(-1), /went the furthest/);
  r.games.next();
  assert.equal(r.g().phase, 'final');
  r.done();
});

test('telephone: skipped turns do not stall a chain, and a phrase with a skipped drawing still reaches the guesser', () => {
  const r = room(3);
  r.games.start('telephone'); r.games.next();
  r.games.drawStart(r.ids[0]); r.games.drawSubmit(r.ids[0], { skip: true });
  r.games.drawStart(r.ids[1]); r.games.drawSubmit(r.ids[1], { png: png() });
  r.games.skipRest(); // the third person walked away
  assert.ok(r.games.secret.ids.every(id => r.games.secret.done[id]));
  r.games.tpStepDone();
  assert.equal(r.g().x.step, 2);
  const items = r.ids.map(id => { const it = r.games.drawStart(id); r.games.drawSubmit(id, { text: 'a wild guess' }); return it; });
  assert.ok(items.some(i => i.type === 'blank'), 'the guesser of a skipped drawing is told so');
  assert.ok(items.some(i => i.type === 'art'));
  r.done();
});

test('drift: how far a guess is from the phrase it started as', () => {
  assert.equal(drift('Santa stuck in a chimney', 'santa stuck in a chimney'), 0);
  assert.equal(drift('Santa stuck in a chimney', 'banana boat'), 1);
  assert.ok(drift('a reindeer at the dentist', 'a deer at the doctor') > 0.5);
});
