// Elf Workshop: buildGame validation (with a FAKE AI, no network), custom pools feeding the engines,
// the saved-games cap, family facts limits and the one-build-at-a-time guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI } from '../server/claude.mjs';
import { Games } from '../server/games.mjs';
import { Workshop, ENGINES, cleanItems, cleanFacts, MAX_SAVED, MAX_FACTS, FACT_LEN } from '../server/workshop.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'np-ws-'));

// ---- buildGame with a fake AI: ai.call returns what the model "wrote" ----
function aiReturning(game, extra = {}) {
  const ai = new AI({ dataDir: tmp(), config: { ai: { capUsd: 5 } }, state: {}, changed() { }, log() { }, alexa: { ready: false }, ...extra });
  ai.prompts = [];
  ai.call = async args => { ai.prompts.push(args); return { game }; };
  return ai;
}
const trivia = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ q: `Question number ${i}?`, choices: [`a${i}`, `b${i}`, `c${i}`, `d${i}`], answer: i % 4, fact: 'True fact.', category: 'Family', difficulty: 1, ...over }));

test('buildGame: good trivia comes back in the exact trivia shape, one Haiku call', async () => {
  const ai = aiReturning({ engine: 'trivia', title: 'The Great Family Quiz', tagline: 'How well do you know us?', items: trivia(9) });
  const out = await ai.buildGame({ request: 'trivia about our family', players: ['Elijah', 'Trinity'], facts: ['Bryson plays point guard'] });
  assert.equal(out.engine, 'trivia');
  assert.equal(out.items.length, 9);
  assert.deepEqual(Object.keys(out.items[0]).sort(), Object.keys(json('trivia-1.json')[0]).sort());
  assert.equal(ai.prompts.length, 1);
  assert.equal(ai.prompts[0].feature, 'workshop');
  assert.equal(ai.prompts[0].maxTokens, 8000); // 2500 truncated a real 12-question game on the Pi
  assert.match(ai.prompts[0].prompt, /Bryson plays point guard/);
  assert.match(ai.prompts[0].prompt, /Elijah, Trinity/);
});

test('buildGame: drops trivia with a bad answer index, wrong choice counts, duplicates and empties', async () => {
  const items = [
    ...trivia(5),
    { ...trivia(1)[0], q: 'Answer out of range?', answer: 4 },
    { ...trivia(1)[0], q: 'Negative answer?', answer: -1 },
    { ...trivia(1)[0], q: 'Only three choices?', choices: ['a', 'b', 'c'] },
    { ...trivia(1)[0], q: 'Empty choice?', choices: ['a', '', 'c', 'd'] },
    { ...trivia(1)[0], q: 'Same choices?', choices: ['a', 'a', 'c', 'd'] },
    { ...trivia(1)[0], q: '   ' },
    { ...trivia(1)[0], q: 'Question number 0?' }, // duplicate
  ];
  const out = await aiReturning({ engine: 'trivia', title: 'T', tagline: '', items }).buildGame({ request: 'x y z' });
  assert.equal(out.items.length, 5);
  assert.ok(out.items.every(q => q.choices.length === 4 && q.answer >= 0 && q.answer <= 3 && q.q.trim()));
});

test('buildGame: fewer than 5 good items fails', async () => {
  const bad = aiReturning({ engine: 'trivia', title: 'T', tagline: '', items: [...trivia(4), { ...trivia(1)[0], q: 'bad?', answer: 9 }] });
  await assert.rejects(() => bad.buildGame({ request: 'trivia' }), /enough good rounds/);
});

test('buildGame: an engine that is not on the whitelist is refused; title is capped at 40', async () => {
  await assert.rejects(() => aiReturning({ engine: 'poker', title: 'T', tagline: '', items: ['a', 'b', 'c', 'd', 'e', 'f'] }).buildGame({ request: 'poker night' }), /couldn't pick a game/);
  const out = await aiReturning({ engine: 'telephone', title: 'A very long title that goes on and on and on forever', tagline: 't', items: ['a reindeer at the dentist', 'a snowman at the beach', 'Santa on a bike', 'an elf in a gift box', 'a penguin in a scarf', 'a sleigh in traffic'] }).buildGame({ request: 'silly drawings' });
  assert.ok(out.title.length <= 40 && out.title.length > 10);
});

test('buildGame: every engine gives items in the shape its content pool uses', () => {
  const sample = {
    trivia: trivia(1), 'most-likely': ['Most likely to hide the last cookie.'], 'mind-reader': [{ a: 'Cocoa', b: 'Cider' }],
    'caption-chaos': [{ scene: 'A reindeer drives the van.', ask: 'What is it saying?' }], 'would-you-rather': [{ a: 'Eat pizza', b: 'Eat tacos' }],
    pictionary: [{ word: 'Snow Globe', level: 3 }], telephone: ['a reindeer at the dentist'], 'name-that-song': [{ title: 'White Christmas', artist: 'Bing Crosby', year: 1942 }],
  };
  const poolFiles = { trivia: 'trivia-1.json', 'most-likely': 'most-likely.json', 'mind-reader': 'mind-reader.json', 'caption-chaos': 'captions.json', 'would-you-rather': 'would-you-rather.json', pictionary: 'pictionary.json', telephone: 'telephone.json', 'name-that-song': 'hits.json' };
  for (const [engine, raw] of Object.entries(sample)) {
    const [item] = cleanItems(engine, raw), [ref] = json(poolFiles[engine]);
    assert.ok(item !== undefined, engine);
    assert.equal(typeof item, typeof ref, engine);
    if (typeof ref === 'object') for (const k of Object.keys(ref)) assert.ok(k in item || ['era', 'year', 'category', 'difficulty', 'fact'].includes(k), `${engine} lacks ${k}`);
  }
  assert.equal(cleanItems('most-likely', ['Most likely to hide the last cookie.'])[0], 'hide the last cookie');
  assert.equal(cleanItems('pictionary', [{ word: 'Snow Globe' }, { word: 'x' }, { word: 'a1b' }]).length, 1);
  assert.equal(cleanItems('would-you-rather', [{ a: 'Same', b: 'same' }]).length, 0);
  assert.deepEqual(Object.keys(ENGINES).sort(), ['caption-chaos', 'mind-reader', 'most-likely', 'name-that-song', 'pictionary', 'telephone', 'trivia', 'would-you-rather']);
});

test('buildGame: name that song keeps only songs with a real preview clip, unless the Echo is ready', async () => {
  const songs = Array.from({ length: 9 }, (_, i) => ({ title: `Song ${i}`, artist: `Artist ${i}`, year: 2000 + i }));
  const game = { engine: 'name-that-song', title: 'Y2K Christmas', tagline: 'Pop', items: songs };
  const found = new Set(['Song 0', 'Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5']);
  const out = await aiReturning(game).buildGame({ request: '2000s pop', echoReady: false, findPreview: async h => (found.has(h.title) ? { url: 'x' } : null) });
  assert.equal(out.items.length, 6);
  assert.ok(out.items.every(s => found.has(s.title) && s.ask === `${s.title} by ${s.artist}`));
  await assert.rejects(() => aiReturning(game).buildGame({ request: '2000s pop', echoReady: false, findPreview: async h => (h.title === 'Song 0' ? { url: 'x' } : null) }), /enough good rounds/);
  const echo = await aiReturning(game).buildGame({ request: '2000s pop', echoReady: true, findPreview: async () => { throw new Error('should not be asked'); } });
  assert.equal(echo.items.length, 9);
});

test('buildGame uses the wrapper: no key means a friendly refusal before any network call', async () => {
  const ai = new AI({ dataDir: tmp(), config: { ai: { capUsd: 5 } }, state: {}, changed() { } });
  await assert.rejects(() => ai.buildGame({ request: 'trivia' }), /API key/);
});

// ---- the engines read custom pools ----
function room(n = 4) {
  const dataDir = tmp();
  const app = {
    dataDir, config: { roster: [], settings: {}, workshop: { facts: [] } }, saveConfig() { }, changed() { }, log() { }, sfx() { }, ai: null,
    state: { tv: {}, show: {} }, setTvScene(s) { this.tvScene = s; }, broadcastTo() { },
    lights: { overlay() { }, clearOverlays() { } },
    content: { trivia: json('trivia-1.json'), hits: json('hits.json'), wyr: json('would-you-rather.json'), pictionary: json('pictionary.json'), mostLikely: json('most-likely.json'), mindReader: json('mind-reader.json'), captions: json('captions.json'), telephone: json('telephone.json') },
  };
  app.games = new Games(app);
  const ids = ['Ada', 'Bo', 'Cy', 'Di', 'Ed'].slice(0, n).map(name => app.games.addLocal(name).id);
  app.workshop = new Workshop(app);
  return { app, games: app.games, ids, ws: app.workshop };
}
const customGame = (engine, items, extra = {}) => ({ id: 'g1', title: 'Custom', tagline: 't', engine, request: 'r', items, by: null, at: Date.now(), ...extra });

test('custom trivia: every question comes from the custom list, the answers stay off the wire', () => {
  const { games, ws } = room(3);
  const items = cleanItems('trivia', trivia(9));
  ws.startGame(customGame('trivia', items));
  assert.equal(games.g.kind, 'trivia');
  assert.equal(games.g.total, 9);
  assert.ok(!JSON.stringify(games.g).includes('a0'), 'custom items are never broadcast');
  assert.equal(games.g.opts.custom.title, 'Custom');
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    games.next();
    if (games.g.phase === 'turn') games.turnReady(games.g.round);
    assert.ok(items.some(q => q.q === games.g.q), `question ${i} is custom: ${games.g.q}`);
    const right = items.find(q => q.q === games.g.q);
    assert.equal(games.g.choices[games.secret.answer], right.choices[right.answer]);
    seen.add(games.g.q);
    games.triviaReveal();
  }
  assert.equal(seen.size, 9, 'no repeats before the pool runs out');
  games.end();
});

test('custom most-likely, would-you-rather, pictionary, mind-reader, caption-chaos and telephone read their custom pools', () => {
  const { games, ws } = room(4);
  const run = (engine, raw, read) => {
    const items = cleanItems(engine, raw);
    ws.startGame(customGame(engine, items));
    games.next();
    assert.ok(read(games, items), engine);
    games.end();
  };
  run('most-likely', ['wear socks to bed', 'sing in the shower', 'lose the remote', 'bake a cake', 'name the cat'], (g, it) => it.includes(g.g.x.prompt));
  run('would-you-rather', [1, 2, 3, 4, 5, 6].map(i => ({ a: `Option A${i}`, b: `Option B${i}` })), (g, it) => it.some(x => x.a === g.g.a && x.b === g.g.b));
  run('pictionary', ['moose', 'lantern', 'toboggan', 'fireplace', 'snow fort'].map(word => ({ word })), (g, it) => it.some(x => x.word === g.secret.word));
  run('mind-reader', [1, 2, 3, 4, 5].map(i => ({ a: `Left${i}`, b: `Right${i}` })), (g, it) => { g.turnReady(g.g.round); return it.some(x => x.a === g.g.x.a); });
  run('caption-chaos', [1, 2, 3, 4, 5].map(i => ({ scene: `Scene ${i} is weird.`, ask: 'What now?' })), (g, it) => it.some(x => x.scene === g.g.x.scene));
  run('telephone', ['a goat in a boat', 'a fox in socks', 'a mouse in a house', 'a bee at tea', 'a pig in a wig'], (g, it) => g.secret.chains.every(c => it.includes(c.prompt)));
});

test('custom name-that-song draws its hits from the custom list; normal games are untouched', async () => {
  const prev = process.env.XM_PREVIEWS; process.env.XM_PREVIEWS = '0';
  const { games, ws, app } = room(3);
  const items = cleanItems('name-that-song', Array.from({ length: 6 }, (_, i) => ({ title: `Custom Song ${i}`, artist: `Band ${i}` })));
  app.alexa = { ready: true, text: async () => { }, command: async () => ({}) };
  ws.startGame(customGame('name-that-song', items));
  games.next();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(games.g.source, 'alexa');
  assert.ok(games.g.choices.every(c => /^Custom Song/.test(c.title)));
  games.end();
  // a normal game afterwards uses the built-in pool again
  games.start('would-you-rather'); games.next();
  const all = app.content.wyr;
  assert.ok(all.some(x => x.a === games.g.a));
  games.end();
  if (prev === undefined) delete process.env.XM_PREVIEWS; else process.env.XM_PREVIEWS = prev;
});

test('a custom game must match its game type', () => {
  const { games } = room(3);
  assert.throws(() => games.start('trivia', { custom: { engine: 'most-likely', items: ['x'], pool: 'mostLikely' } }), /does not match/);
});

// ---- saved games, facts, the build guard ----
test('saved games keep only the latest 30, newest first, and can be deleted', () => {
  const { ws } = room(3);
  for (let i = 0; i < MAX_SAVED + 5; i++) ws.save(customGame('telephone', ['a', 'b', 'c', 'd', 'e'], { id: 'g' + i, title: 'G' + i, at: i }));
  const list = ws.list();
  assert.equal(list.length, MAX_SAVED);
  assert.equal(list[0].id, 'g' + (MAX_SAVED + 4));
  assert.ok(!list.some(g => g.id === 'g0'));
  ws.delete('g10');
  assert.ok(!ws.list().some(g => g.id === 'g10'));
  assert.throws(() => ws.delete('nope'), /already gone/);
  assert.equal(ws.app.state.workshop.games.length, MAX_SAVED - 1);
  assert.ok(!('items' in ws.app.state.workshop.games[0]), 'state lists never carry the items');
});

test('family facts: max 40, 120 chars each, trimmed, deduped, saved in config', () => {
  const { ws, app } = room(3);
  const r = ws.setFacts(['  Bryson plays point guard  ', 'bryson plays point guard', '', 'x'.repeat(300), ...Array.from({ length: 60 }, (_, i) => `fact ${i}`)]);
  assert.equal(r.facts.length, MAX_FACTS);
  assert.equal(r.facts[0], 'Bryson plays point guard');
  assert.equal(r.facts[1].length, FACT_LEN);
  assert.deepEqual(app.config.workshop.facts, r.facts);
  assert.deepEqual(app.state.workshop.facts, r.facts);
  assert.deepEqual(cleanFacts('one\ntwo\r\n\nthree'), ['one', 'two', 'three']);
});

test('one build at a time; friendly errors; the game starts after the reveal and is saved', async () => {
  const { ws, app, games } = room(3);
  ws.revealMs = 30;
  let release;
  app.ai = { configured: true, busy: false, cap: 5, usage: () => ({ month: 0 }), buildGame: () => new Promise(r => { release = r; }) };
  assert.throws(() => ws.build({ request: 'hi' }), /Tell the elves/);
  const first = ws.build({ request: 'reindeer trivia', by: 'Ada' });
  assert.deepEqual(first, { ok: true, building: true });
  assert.equal(app.tvScene, 'workshop');
  assert.equal(app.state.workshop.phase, 'building');
  assert.equal(app.state.workshop.by.name, 'Ada');
  assert.throws(() => ws.build({ request: 'something else' }), /still building the last game/);
  release({ engine: 'most-likely', title: 'Reindeer Rumble', tagline: 'Vote!', items: ['hide a carrot', 'name a reindeer', 'eat the grass', 'pull the sleigh', 'nap in the barn'] });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(app.state.workshop.phase, 'reveal');
  assert.equal(app.state.workshop.game.title, 'Reindeer Rumble');
  assert.equal(app.state.workshop.game.engineName, 'Most Likely To');
  assert.equal(ws.list().length, 1);
  assert.equal(ws.list()[0].by, 'Ada');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(games.g.kind, 'most-likely');
  assert.ok(['hide a carrot', 'name a reindeer', 'eat the grass', 'pull the sleigh', 'nap in the barn'].includes(games.pool('mostLikely')[0]));
  assert.equal(app.state.workshop.phase, 'idle');
  // a game is running: no new build until it ends
  assert.throws(() => ws.build({ request: 'another' }), /Finish or end the current game/);
  games.end();
  // replay from Made by the elves
  ws.play(ws.list()[0].id);
  assert.equal(games.g.opts.custom.title, 'Reindeer Rumble');
  games.end();
  ws.stop();
});

test('build refuses politely when AI is not set up or the monthly cap is reached, and recovers from a failed build', async () => {
  const { ws, app } = room(3);
  ws.revealMs = 20;
  app.ai = { configured: false, usage: () => ({ month: 0 }), cap: 5 };
  assert.throws(() => ws.build({ request: 'trivia please' }), /Claude key/);
  app.ai = { configured: true, busy: false, cap: 5, usage: () => ({ month: 5.2 }) };
  assert.throws(() => ws.build({ request: 'trivia please' }), /budget/);
  app.ai = { configured: true, busy: false, cap: 5, usage: () => ({ month: 0 }), buildGame: async () => { throw new Error("The elves couldn't make enough good rounds for that one."); } };
  ws.build({ request: 'trivia please' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(app.state.workshop.phase, 'error');
  assert.match(app.state.workshop.error, /enough good rounds/);
  assert.equal(ws.building, false, 'a failed build frees the guard');
  assert.equal(ws.list().length, 0);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(app.state.workshop.phase, 'idle');
  ws.stop();
});
