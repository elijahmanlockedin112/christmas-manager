// Elf Workshop: the family describes any game ("trivia about our family", "would you rather, but only food")
// and Claude Haiku builds it out of the engines the app already has. One Haiku call per game
// (server/claude.mjs buildGame). Built games are saved to data/custom-games.json so they can be replayed free.
//
// The engines read their items from `this.pool(name)` (games.mjs), which prefers g.opts.custom.items.
import fs from 'node:fs';
import path from 'node:path';

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const lc = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const MAX_SAVED = 30;
export const MAX_FACTS = 40;
export const FACT_LEN = 120;
export const MIN_ITEMS = 5;
export const MAX_ITEMS = 12;

// The engines Haiku may choose from. `pool` is the name of the content pool the engine draws from
// (app.content.<pool>); `shape` is shown to the model; `rounds` is how many rounds a custom game plays by default.
export const ENGINES = {
  trivia: { pool: 'trivia', name: 'Trivia Showdown', rounds: 10, shape: '{ "q": question (max 120 chars), "choices": exactly 4 different short answers, "answer": index 0-3 of the TRUE answer, "fact": one short true sentence about the answer, "category": 1-3 words, "difficulty": 1 easy, 2 medium or 3 hard }' },
  'most-likely': { pool: 'mostLikely', name: 'Most Likely To', rounds: 8, shape: 'a string that completes "Most likely to ..." (max 80 chars, no leading "most likely to"), e.g. "hide the last cookie and deny everything". Each round the family votes on WHO in the room fits it.' },
  'mind-reader': { pool: 'mindReader', name: 'Mind Reader', rounds: 0, shape: '{ "a": first option (max 40 chars), "b": second option (max 40 chars) }. One person secretly picks, everyone else guesses which.' },
  'caption-chaos': { pool: 'captions', name: 'Caption Chaos', rounds: 4, shape: '{ "scene": a ridiculous scene to caption (max 120 chars), "ask": the question about it (max 40 chars), e.g. "What does he yell?" }' },
  'would-you-rather': { pool: 'wyr', name: 'Would You Rather', rounds: 8, shape: '{ "a": first choice (max 90 chars), "b": second choice (max 90 chars) } - both should be tempting' },
  pictionary: { pool: 'pictionary', name: 'Pictionary', rounds: 6, shape: '{ "word": something easy to draw, 1-3 plain words, letters only, "level": 1 }' },
  telephone: { pool: 'telephone', name: 'Sketch Telephone', rounds: 0, shape: 'a string: a funny scene to draw (max 60 chars), e.g. "a reindeer at the dentist"' },
  'name-that-song': { pool: 'hits', name: 'Name That Song', rounds: 8, shape: '{ "title": the exact real song title, "artist": the exact real artist, "year": release year (optional) } - REAL recorded songs only, no guessing' },
};
export const ENGINE_IDS = Object.keys(ENGINES);
export const engineName = id => ENGINES[id]?.name || id;

// Turns whatever the model wrote into items in exactly the shape the engine's pool uses. Bad items are dropped.
export function cleanItems(engine, raw) {
  if (!ENGINES[engine]) throw new Error(`Unknown game type ${engine}`);
  const seen = new Set(), out = [];
  const take = (key, item) => { const k = lc(key); if (!k || seen.has(k)) return; seen.add(k); out.push(item); };
  for (const r of Array.isArray(raw) ? raw : []) {
    try {
      if (engine === 'trivia') {
        if (!r || typeof r !== 'object' || !Array.isArray(r.choices)) continue;
        const choices = r.choices.map(c => clean(c, 60));
        const q = clean(r.q, 140);
        if (!q || choices.length !== 4 || choices.some(c => !c) || new Set(choices.map(lc)).size !== 4) continue;
        if (!Number.isInteger(r.answer) || r.answer < 0 || r.answer > 3) continue;
        take(q, { q, choices, answer: r.answer, difficulty: Math.min(3, Math.max(1, r.difficulty | 0 || 1)), category: clean(r.category, 30) || 'Elf Workshop', fact: clean(r.fact, 160) });
      } else if (engine === 'most-likely') {
        const t = clean(typeof r === 'string' ? r : r?.text, 90).replace(/^most likely to\s+/i, '').replace(/[.?!]+$/, '');
        if (t.length >= 4) take(t, t);
      } else if (engine === 'telephone') {
        const t = clean(typeof r === 'string' ? r : r?.text, 70).replace(/[.?!]+$/, '');
        if (t.length >= 4) take(t, t);
      } else if (engine === 'mind-reader' || engine === 'would-you-rather') {
        const n = engine === 'mind-reader' ? 50 : 110;
        const a = clean(r?.a, n), b = clean(r?.b, n);
        if (a && b && lc(a) !== lc(b)) take(a + '|' + b, { a, b });
      } else if (engine === 'caption-chaos') {
        const scene = clean(r?.scene, 140), ask = clean(r?.ask, 60);
        if (scene && ask) take(scene, { scene, ask });
      } else if (engine === 'pictionary') {
        const word = clean(r?.word ?? r, 24).toLowerCase();
        if (/^[a-z][a-z '-]*[a-z]$/.test(word)) take(word, { word, level: 1 });
      } else if (engine === 'name-that-song') {
        const title = clean(r?.title, 80), artist = clean(r?.artist, 60);
        if (!title || !artist) continue;
        const year = Number.isInteger(r.year) && r.year >= 1900 && r.year <= 2100 ? r.year : null;
        take(title + '|' + artist, { title, artist, ...(year ? { year } : {}), level: 1, ask: `${title} by ${artist}` });
      }
    } catch { /* a malformed item is just dropped */ }
  }
  return out.slice(0, MAX_ITEMS);
}

export function cleanFacts(list) {
  if (typeof list === 'string') list = list.split(/\r?\n/);
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const f of list) {
    const t = clean(f, FACT_LEN);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

// canned game for the e2e test server (XM_FAKE_AI=1): no API key, no network, real code path everywhere else
export async function fakeBuildGame({ request }) {
  await new Promise(r => setTimeout(r, Number(process.env.XM_FAKE_AI_MS) || 2500));
  const topic = clean(request, 40).replace(/[^\w ]/g, '').trim() || 'the North Pole';
  const title = clean(`${topic.charAt(0).toUpperCase()}${topic.slice(1)} Showdown`, 40);
  if (/most likely/i.test(request)) {
    return { engine: 'most-likely', title, tagline: 'The elves wrote these about you.', items: ['wrap a gift in the wrong paper', 'sing the loudest carol', 'sneak a cookie before dinner', 'fall asleep under the tree', 'lose the tape again', 'find the best hiding spot'] };
  }
  const q = (text, choices, answer) => ({ q: text, choices, answer, difficulty: 1, category: 'Elf Workshop', fact: 'The elves checked this one twice.' });
  return {
    engine: 'trivia', title, tagline: `Six questions the elves built for "${topic}".`,
    items: [
      q('Which animal leads Santa\'s sleigh with a red nose?', ['Rudolph', 'Dasher', 'Comet', 'Cupid'], 0),
      q('What do you hang on a Christmas tree?', ['Ornaments', 'Anchors', 'Hubcaps', 'Umbrellas'], 0),
      q('What colour is a candy cane stripe, usually?', ['Red', 'Brown', 'Black', 'Gray'], 0),
      q('Who lives at the North Pole with Santa?', ['Mrs. Claus', 'The Easter Bunny', 'A pirate', 'The tooth fairy'], 0),
      q('What do you leave out for Santa?', ['Cookies and milk', 'A bicycle', 'Spaghetti', 'A snowboard'], 0),
      q('Which month is Christmas in?', ['December', 'June', 'March', 'October'], 0),
    ],
  };
}

export class Workshop {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.dataDir, 'custom-games.json');
    this.building = false;
    this.revealMs = Number(process.env.XM_WORKSHOP_REVEAL_MS) || 7000;
    this.timers = new Set();
    this.view = { phase: 'idle' };
    this.push();
  }
  get fake() { return process.env.XM_FAKE_AI === '1'; }
  later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); t.unref?.(); this.timers.add(t); return t; }
  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  // ---------- saved games ----------
  list() {
    try { const l = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
  }
  write(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(list));
    fs.renameSync(this.file + '.tmp', this.file);
  }
  save(game) {
    const list = [game, ...this.list().filter(g => g.id !== game.id)].slice(0, MAX_SAVED);
    this.write(list);
    return game;
  }
  find(id) { return this.list().find(g => g.id === String(id)); }
  delete(id) {
    const list = this.list(), next = list.filter(g => g.id !== String(id));
    if (next.length === list.length) throw new Error('That game is already gone.');
    this.write(next);
    this.push();
    return { ok: true };
  }

  // ---------- family facts ----------
  facts() { return cleanFacts(this.app.config.workshop?.facts); }
  setFacts(list) {
    const facts = cleanFacts(list);
    this.app.config.workshop = { ...this.app.config.workshop, facts };
    this.app.saveConfig();
    this.push();
    return { ok: true, facts };
  }

  // ---------- state for the screens ----------
  push() {
    const games = this.list().map(g => ({ id: g.id, title: g.title, tagline: g.tagline, engine: g.engine, engineName: engineName(g.engine), request: g.request, by: g.by, at: g.at, count: g.items.length }));
    this.app.state.workshop = { ...this.view, games, facts: this.facts() };
    this.app.changed();
  }
  show(patch) { this.view = { ...this.view, ...patch }; this.push(); }

  // ---------- building ----------
  who(by) {
    const players = [...(this.app.games?.players?.values() || [])];
    const t = clean(by, 24).toLowerCase();
    const p = t && (players.find(x => x.id === by) || players.find(x => x.name.toLowerCase() === t));
    return p ? { id: p.id, name: p.name } : t ? { id: null, name: clean(by, 24) } : null;
  }
  // Returns right away; the build runs in the background and reports through state.workshop.
  build({ request, by } = {}) {
    request = clean(request, 200);
    if (request.length < 3) throw new Error('Tell the elves what game to make.');
    if (this.building) throw new Error('The elves are still building the last game. One at a time!');
    if (this.app.state.game) throw new Error('Finish or end the current game first, then the elves can build a new one.');
    const ai = this.app.ai;
    if (!this.fake) {
      if (!ai?.configured) throw new Error('The elves need the Claude key first. Add it in Setup.');
      if (ai.usage().month >= ai.cap) throw new Error(`This month's AI budget ($${ai.cap.toFixed(2)}) is used up. Raise it in Setup.`);
      if (ai.busy) throw new Error('The elves are still writing something else. Try again in a moment.');
    }
    const who = this.who(by);
    this.building = true;
    this.stop();
    this.show({ phase: 'building', request, by: who, stage: 0, at: Date.now(), game: null, error: null });
    this.app.setTvScene('workshop');
    this.app.sfx('chime');
    this.app.lights?.overlay?.({ kind: 'sweep', color: '#e8b23f', dur: 3 });
    [[2500, 1], [6000, 2], [11000, 3], [17000, 4]].forEach(([ms, stage]) => this.later(ms, () => { if (this.building) this.show({ stage }); }));
    this.run(request, who).catch(e => this.app.log?.('workshop', e.message));
    return { ok: true, building: true };
  }
  async run(request, who) {
    const app = this.app;
    try {
      const players = [...app.games.players.values()].map(p => p.name).slice(0, 8);
      const build = this.fake ? fakeBuildGame : args => app.ai.buildGame(args);
      const out = await build({ request, players, facts: this.facts() });
      const items = out.items;
      const game = this.save({
        id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        title: out.title, tagline: out.tagline, engine: out.engine, request, items,
        by: who?.name || null, byId: who?.id || null, at: Date.now(),
      });
      this.building = false;
      this.stop();
      this.show({ phase: 'reveal', stage: 5, game: { id: game.id, title: game.title, tagline: game.tagline, engine: game.engine, engineName: engineName(game.engine), count: items.length }, error: null, at: Date.now() });
      app.sfx('fanfare');
      app.lights?.overlay?.({ kind: 'burst', color: '#ffd36b', dur: 2.5 });
      try {
        if (app.alexa?.ready) app.alexa.speak(`${game.title}! The elves built it. Look at the TV.`).catch(() => { });
      } catch { /* the TV is the main show */ }
      this.later(this.revealMs, () => this.launch(game));
    } catch (e) {
      this.building = false;
      this.stop();
      this.fail(e.message || 'The elves dropped the box. Try again.');
    }
  }
  fail(message) {
    this.show({ phase: 'error', error: String(message).slice(0, 200) });
    this.later(Math.min(this.revealMs, 6000), () => {
      this.show({ phase: 'idle', error: null });
      if (this.app.state.tv.scene === 'workshop') this.app.setTvScene(this.app.state.tv.prev && this.app.state.tv.prev !== 'workshop' ? this.app.state.tv.prev : 'home');
    });
  }
  customFor(game) {
    const eng = ENGINES[game.engine];
    if (!eng) throw new Error('That game uses an engine this version does not have.');
    const custom = { id: game.id, title: game.title, tagline: game.tagline, engine: game.engine, pool: eng.pool, by: game.by || null };
    // the items (trivia answers!) stay on the server: not enumerable, so never broadcast with the game state
    Object.defineProperty(custom, 'items', { value: game.items, enumerable: false });
    return custom;
  }
  startGame(game) {
    const eng = ENGINES[game.engine];
    if (!eng) throw new Error('That game uses an engine this version does not have.');
    const opts = { custom: this.customFor(game) };
    if (eng.rounds) opts.rounds = Math.min(eng.rounds, game.items.length);
    return this.app.games.start(game.engine, opts);
  }
  launch(game) {
    try {
      this.startGame(game);
      this.show({ phase: 'idle', error: null });
    } catch (e) {
      this.fail(`${e.message}. It is saved under Made by the elves.`);
    }
  }
  play(id) {
    const game = this.find(id);
    if (!game) throw new Error('The elves cannot find that game any more.');
    if (this.building) throw new Error('The elves are still building. Wait for the reveal.');
    this.startGame(game);
    return { ok: true };
  }
}
