// Three drawing games for the family, mixed into the Games class (see games.mjs). Everyone shares the one
// iPad: a person taps their own face, the iPad shows only what that person may see, and they draw.
//
//   ornaments  Ornament Workshop: not a contest. Each person draws a round ornament and hangs it on the
//              virtual tree for the whole season (saved on disk, drawn on the TV and the iPad tree).
//   portraits  Portrait Studio: everyone secretly draws another family member, then a gallery on the TV
//              (with an art critic) and a vote for the most accurate and the funniest.
//   telephone  Sketch Telephone: phrase -> drawing -> guess -> drawing ... passed around the iPad, then
//              a chain-by-chain reveal on the TV.
//
// Public state lives in g.x (broadcast to every screen). Secrets (who draws whom, what each chain looks
// like before the reveal) stay in this.secret and are only handed to the iPad as the answer to the
// action the person just tapped. Drawings are PNGs held in memory (this.drawings), served by id.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ORN_CAP } from '../shared/ornament.mjs';

export const DRAW_KINDS = ['ornaments', 'portraits', 'telephone'];
export const DRAW_NAMES = { ornaments: 'Ornament Workshop', portraits: 'Portrait Studio', telephone: 'Sketch Telephone' };
export const PORTRAIT_SECS = 75, TP_DRAW_SECS = 45, TP_GUESS_SECS = 30;
const MEDIA = ['crayon', 'felt marker', 'wet paint', 'charcoal', 'sparkle gel pen', 'holiday glitter', 'pastel', 'candy-cane ink'];
const FALLBACK_CRITIC = ['A bold study in lines. The artist is not sorry.'];

const rid = () => crypto.randomBytes(6).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const shuffle = (a, rnd = Math.random) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG sent as a data URL by the iPad: checked the same way the player photo upload is (type, size
// cap), plus the real PNG signature and the picture's dimensions read from its header.
export function readPng(dataUrl, { minBytes = 100, maxBytes, minDim = 16, maxDim, square = false }) {
  const bad = new Error('That picture did not come through. Try again.');
  const s = String(dataUrl ?? '');
  if (s.length > maxBytes * 1.4 + 64) throw new Error('That picture is too big. Try again.');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) throw bad;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < minBytes) throw bad;
  if (buf.length > maxBytes) throw new Error('That picture is too big. Try again.');
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') throw bad;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w < minDim || h < minDim || w > maxDim || h > maxDim || (square && w !== h)) throw new Error('That picture is the wrong size. Try again.');
  return { buf, w, h };
}

// Everyone draws somebody else, and nobody draws themselves.
export function derange(ids, rnd = Math.random) {
  if (ids.length < 2) throw new Error('It takes at least two people');
  for (let tries = 0; tries < 300; tries++) {
    const s = shuffle(ids, rnd);
    if (s.every((v, i) => v !== ids[i])) return Object.fromEntries(ids.map((id, i) => [id, s[i]]));
  }
  return Object.fromEntries(ids.map((id, i) => [id, ids[(i + 1) % ids.length]]));
}

// Sketch Telephone: with n players there are n chains and n steps. In step s, player i works on chain
// (i - s) mod n. So every chain gets exactly one step from every player, and nobody sees their own
// chain again (the one they started) until the reveal.
export const telephoneChain = (playerIdx, step, n) => (((playerIdx - step) % n) + n) % n;
export const telephoneSchedule = n => Array.from({ length: n }, (_, s) => Array.from({ length: n }, (_, i) => telephoneChain(i, s, n)));

const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'with', 'for'].includes(w)));
export function drift(a, b) { const A = words(a), B = words(b); if (!A.size && !B.size) return 0; let hit = 0; for (const w of A) if (B.has(w)) hit++; return 1 - hit / new Set([...A, ...B]).size; }

export const drawMethods = {
  drawSetup(kind, opts) {
    const ids = [...this.players.keys()];
    const need = kind === 'ornaments' ? 1 : 3;
    if (ids.length < need) throw new Error(`${DRAW_NAMES[kind]} needs at least ${need} ${need === 1 ? 'player' : 'players'}`);
    this.drawings.clear();
    this.used.draw = { critic: new Set(), tp: new Set(), count: 0 };
    if (kind === 'portraits') return { total: opts.rounds ? Math.max(1, Math.min(2, opts.rounds | 0)) : 1 };
    if (kind === 'telephone') return { total: ids.length };
    return { total: 1 };
  },
  drawCleanup() { this.drawings.clear(); },
  drawingBuf(id) { return this.drawings.get(String(id).replace(/[^\w]/g, '')) || null; },
  drawRound() {
    const k = this.g.kind;
    if (k === 'ornaments') this.ornRound(); else if (k === 'portraits') this.portraitRound(); else this.tpRound();
  },
  // Next from the iPad: moves a showing along. Returns true when it handled the press.
  drawAdvance() {
    const g = this.g, k = g.kind;
    if (k === 'portraits') {
      if (g.phase === 'gallery') { this.galleryAdvance(); return true; }
      if (g.phase === 'vote') { this.portraitReveal(); return true; }
      if (g.phase === 'draw') { this.skipRest(); return true; }
    } else if (k === 'telephone') {
      if (g.phase === 'step') { this.skipRest(); return true; }
      if (g.phase === 'reveal') { this.tpRevealNext(); return true; }
      if (g.phase === 'vote') { this.tpResult(); return true; }
    }
    return false;
  },
  // the Reveal button: stop waiting
  drawReveal() {
    const g = this.g;
    if (g.kind === 'portraits' && g.phase === 'vote') this.portraitReveal();
    else if (g.kind === 'telephone' && g.phase === 'vote') this.tpResult();
    else if (g.kind !== 'ornaments' && ['draw', 'step'].includes(g.phase)) this.skipRest();
  },
  drawStart(pid) {
    const g = this.g;
    if (g?.kind === 'portraits') return this.portraitStart(String(pid));
    if (g?.kind === 'telephone') return this.tpStart(String(pid));
    throw new Error('Nobody is drawing right now');
  },
  drawSubmit(pid, a = {}) {
    const g = this.g;
    if (g?.kind === 'portraits') return this.portraitSubmit(String(pid), a);
    if (g?.kind === 'telephone') return this.tpSubmit(String(pid), a);
    throw new Error('Nobody is drawing right now');
  },
  // somebody walked away: skip whoever has not drawn and move on
  skipRest() {
    const s = this.secret, g = this.g;
    if (!s?.ids) return;
    for (const id of s.ids) if (!s.done[id]) { s.current = id; g.kind === 'portraits' ? this.portraitDone(id, null) : this.tpDone(id, { skipped: true }); }
  },
  echo(text) {
    try { const a = this.app.alexa; if (a?.ready) Promise.resolve(a.speak(text, { announce: false })).catch(e => this.app.log?.('echo', e.message)); }
    catch (e) { this.app.log?.('echo', e.message); }
  },
  echoName(pid) { return this.players.get(pid)?.name || 'Someone'; },

  // ---------- Ornament Workshop ----------
  syncOrnaments() {
    const list = this.app.config.ornaments || [];
    this.app.state.ornaments = list.slice(-ORN_CAP).map(o => ({ id: o.id, slot: o.slot, by: o.pid, name: o.name, at: o.at }));
    this.app.changed();
  },
  ornRound() {
    this.secret = {};
    this.g = { ...this.g, phase: 'workshop', x: { moment: null, hung: [] } };
    this.app.sfx('chime');
  },
  ornamentHang(pid, png) {
    const g = this.g;
    if (!g || g.kind !== 'ornaments' || g.phase !== 'workshop') throw new Error('The workshop is not open');
    const p = this.players.get(pid);
    if (!p) throw new Error('Who is hanging this one?');
    const { buf } = readPng(png, { maxBytes: 150000, minDim: 64, maxDim: 512, square: true });
    const list = (this.app.config.ornaments ||= []);
    // the first free spot among the ornaments that are drawn (the latest ORN_CAP)
    const used = new Set(list.slice(-(ORN_CAP - 1)).map(o => o.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const id = 'o' + Date.now().toString(36) + rid().slice(0, 4);
    const dir = path.join(this.app.dataDir, 'ornaments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.png`), buf);
    const pub = this.pub(pid);
    const rec = { id, pid, name: p.name, color: pub.color, at: Date.now(), slot };
    list.push(rec);
    this.app.saveConfig();
    this.syncOrnaments();
    this.g = { ...g, x: { ...g.x, moment: { ...rec, photo: pub.photo }, hung: [...g.x.hung, pid] } };
    this.partyFlash(pid);
    this.app.sfx('reveal');
    this.echo(`${p.name} hung a new ornament on the tree!`);
    this.after(11000, () => { const h = this.g; if (h?.kind === 'ornaments') this.g = { ...h, x: { ...h.x, moment: null } }; });
    return rec;
  },
  ornamentRemove(id) {
    id = String(id || '');
    const list = this.app.config.ornaments || [];
    const i = list.findIndex(o => o.id === id);
    if (i < 0) throw new Error('That ornament is already gone');
    list.splice(i, 1);
    try { fs.unlinkSync(path.join(this.app.dataDir, 'ornaments', `${id.replace(/[^\w-]/g, '')}.png`)); } catch { }
    this.app.saveConfig();
    this.syncOrnaments();
    return { ok: true };
  },

  // ---------- Portrait Studio ----------
  portraitRound() {
    const ids = [...this.players.keys()];
    this.secret = { ids, assign: derange(ids), done: {}, hinted: {}, current: null, round: this.g.round };
    this.g = { ...this.g, phase: 'draw', startsAt: null, endsAt: null, x: { ids, done: [], current: null, endsAt: null, secs: this.g.opts.seconds || PORTRAIT_SECS } };
    this.app.sfx('question');
  },
  turnGuard(pid) {
    const s = this.secret;
    if (!s.ids?.includes(pid)) throw new Error('Who is this?');
    if (s.done[pid]) throw new Error('You already did yours');
    if (s.current && s.current !== pid) throw new Error(`${this.echoName(s.current)} is in the middle of a turn`);
    return s;
  },
  beginTurn(pid, secs, grace) {
    const s = this.secret, g = this.g;
    s.current = pid; s.startsAt = Date.now(); s.endsAt = Date.now() + secs * 1000; s.secs = secs;
    this.g = { ...g, startsAt: s.startsAt, endsAt: s.endsAt, x: { ...g.x, current: pid, endsAt: s.endsAt } };
    this.app.sfx('chime');
    // the iPad submits when the clock runs out; this is only the backstop if the iPad went to sleep
    this.after(secs * 1000 + grace, () => { if (this.secret?.current === pid) g.kind === 'portraits' ? this.portraitDone(pid, null) : this.tpDone(pid, { skipped: true }); });
  },
  portraitStart(pid) {
    const g = this.g;
    if (g.phase !== 'draw') throw new Error('Not drawing right now');
    const s = this.turnGuard(pid);
    if (!s.current) this.beginTurn(pid, g.opts.seconds || PORTRAIT_SECS, 9000);
    const sub = this.pub(s.assign[pid]);
    return { subject: { id: sub.id, name: sub.name, color: sub.color, photo: sub.photo }, endsAt: s.endsAt, secs: s.secs, hinted: !!s.hinted[pid], canHint: !!sub.photo };
  },
  portraitHint(pid) {
    const s = this.secret;
    if (this.g?.kind !== 'portraits' || this.g.phase !== 'draw' || s.current !== pid) throw new Error('No peeking right now');
    if (s.hinted[pid]) throw new Error('You already peeked once');
    const sub = this.pub(s.assign[pid]);
    if (!sub.photo) throw new Error(`${sub.name} does not have a photo yet`);
    s.hinted[pid] = true;
    return { id: sub.id, photo: sub.photo };
  },
  portraitSubmit(pid, a) {
    const g = this.g, s = this.secret;
    if (g.phase !== 'draw' || s.current !== pid) throw new Error('It is not your turn to hand this in');
    if (a.skip) return this.portraitDone(pid, null), { ok: true };
    const { buf } = readPng(a.png, { maxBytes: 600000, minDim: 100, maxDim: 1600 });
    const id = rid();
    this.drawings.set(id, buf);
    this.portraitDone(pid, id);
    return { ok: true };
  },
  portraitDone(pid, artId) {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'portraits' || g.phase !== 'draw' || s.done[pid]) return;
    s.done[pid] = artId ? { art: artId } : { skipped: true };
    s.current = null;
    this.g = { ...g, startsAt: null, endsAt: null, x: { ...g.x, done: Object.keys(s.done), current: null, endsAt: null } };
    this.clear();
    if (s.ids.every(id => s.done[id])) this.after(1400, () => this.galleryStart());
    else this.app.sfx('correct');
  },
  critPick() {
    const list = this.app.content.portraitCritic?.length ? this.app.content.portraitCritic : FALLBACK_CRITIC;
    const used = (this.used.draw.critic ||= new Set());
    if (used.size >= list.length) used.clear();
    let i, guard = 0;
    do { i = Math.floor(Math.random() * list.length); } while (used.has(i) && guard++ < 300);
    used.add(i);
    return list[i];
  },
  // The critic's line for one portrait: Haiku looks at the drawing and writes a snooty but affectionate
  // review. With no key, or if the call fails, a line from the written pool. Never throws.
  async reviewFor(e) {
    const ai = this.app.ai;
    if (ai?.configured && typeof ai.portraitCritic === 'function') {
      try {
        const t = clean(await ai.portraitCritic({ title: e.title, medium: e.medium, artist: this.echoName(e.artist), subject: this.echoName(e.subject), png: this.drawings.get(e.artId) }), 280);
        if (t) return t;
      } catch (err) { this.app.log?.('ai', 'portrait critic', err.message); }
    }
    return this.critPick();
  },
  galleryStart() {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'portraits' || g.phase !== 'draw') return;
    const drawn = shuffle(s.ids.filter(id => s.done[id]?.art));
    const entries = drawn.map(artist => {
      const n = ++this.used.draw.count;
      return { n, title: `Untitled No. ${n}`, medium: MEDIA[Math.floor(Math.random() * MEDIA.length)] + ' on iPad', artist, subject: s.assign[artist], art: `/api/drawing/${s.done[artist].art}.png`, artId: s.done[artist].art, review: null };
    });
    s.entries = entries; s.votes = {};
    if (!entries.length) { this.g = { ...g, phase: 'reveal', startsAt: null, endsAt: null, x: { entries: [], results: null, gained: {} } }; this.partyAfterReveal(4000); return; }
    // the critic writes one portrait at a time (the AI wrapper takes one call at once), ahead of the show
    let chain = Promise.resolve();
    s.reviewP = entries.map(e => (chain = chain.then(() => this.reviewFor(e))));
    this.g = { ...g, phase: 'gallery', startsAt: null, endsAt: null, x: { entries: entries.map(pubEntry), idx: -1, stage: 'frame' } };
    this.galleryFrame(0);
  },
  galleryFrame(i) {
    const g = this.g, e = this.secret.entries[i];
    this.g = { ...g, x: { ...g.x, idx: i, stage: 'frame' } };
    this.app.sfx('reveal');
    this.partyFlash(e.artist);
    this.after(4800, () => this.galleryReview(i));
  },
  async galleryReview(i) {
    const s = this.secret, e = s.entries[i];
    let text = await Promise.race([s.reviewP[i], sleep(9000).then(() => null)]);
    if (!text) text = this.critPick();
    const g = this.g;
    if (g?.kind !== 'portraits' || g.phase !== 'gallery' || g.x.idx !== i || g.x.stage !== 'frame') return;
    e.review = text;
    this.g = { ...g, x: { ...g.x, stage: 'review', entries: g.x.entries.map(x => (x.n === e.n ? { ...x, review: text } : x)) } };
    this.app.sfx('chime');
    this.echo(`${e.title}, by ${this.echoName(e.artist)}. ${text}`);
    this.after(Math.max(7000, 3500 + text.length * 80), () => this.galleryAdvance());
  },
  galleryAdvance() {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'portraits' || g.phase !== 'gallery') return;
    const i = g.x.idx + 1;
    if (i < s.entries.length) this.galleryFrame(i); else this.portraitVoteStart();
  },
  portraitVoteStart() {
    const g = this.g, s = this.secret;
    if (s.entries.length < 2) return this.portraitReveal();
    this.g = { ...g, phase: 'vote', startsAt: Date.now(), endsAt: Date.now() + 120000, x: { entries: g.x.entries, voted: [] } };
    this.app.sfx('chime');
    this.after(120000, () => this.portraitReveal());
  },
  portraitVote(pid, accurate, funny) {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'portraits' || g.phase !== 'vote' || !s.ids.includes(pid) || s.votes[pid]) return;
    const find = n => s.entries.find(e => e.n === (n | 0));
    const a = find(accurate), f = find(funny);
    if (!a || !f) throw new Error('Pick one for each');
    if (a.artist === pid || f.artist === pid) throw new Error('You cannot vote for your own');
    s.votes[pid] = { accurate: a.n, funny: f.n };
    this.g = { ...g, x: { ...g.x, voted: Object.keys(s.votes) } };
    if (Object.keys(s.votes).length >= s.ids.length) this.after(1000, () => this.portraitReveal());
  },
  portraitReveal() {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'portraits' || !['vote', 'gallery'].includes(g.phase)) return;
    const counts = { accurate: {}, funny: {} };
    for (const e of s.entries) { counts.accurate[e.n] = 0; counts.funny[e.n] = 0; }
    for (const v of Object.values(s.votes || {})) { counts.accurate[v.accurate]++; counts.funny[v.funny]++; }
    const win = c => { const top = Math.max(0, ...Object.values(c)); return top > 0 ? Object.keys(c).filter(n => c[n] === top).map(Number) : []; };
    const winners = { accurate: win(counts.accurate), funny: win(counts.funny) };
    const gained = {};
    for (const e of s.entries) {
      let pts = counts.accurate[e.n] * 200 + counts.funny[e.n] * 200;
      if (winners.accurate.includes(e.n)) pts += 300;
      if (winners.funny.includes(e.n)) pts += 300;
      if (pts) gained[e.artist] = (gained[e.artist] || 0) + pts;
    }
    this.partyGain(gained);
    this.g = { ...g, phase: 'reveal', startsAt: null, endsAt: null, x: { entries: g.x.entries, results: { counts, winners }, gained } };
    const first = s.entries.find(e => e.n === (winners.funny[0] ?? winners.accurate[0]));
    if (first) { this.partyFlash(first.artist); this.app.sfx('fanfare'); } else this.app.sfx('wrong');
    this.partyAfterReveal(14000);
  },

  // ---------- Sketch Telephone ----------
  tpRound() {
    const g = this.g, step = g.round - 1;
    if (step === 0) {
      const ids = [...this.players.keys()];
      const pool = this.app.content.telephone?.length ? this.app.content.telephone : ['Santa stuck in a chimney'];
      const used = this.used.draw.tp;
      const fresh = shuffle(pool.map((_, i) => i).filter(i => !used.has(i)));
      const picks = (fresh.length >= ids.length ? fresh : shuffle(pool.map((_, i) => i))).slice(0, ids.length);
      for (const i of picks) used.add(i);
      this.secret = { ids, step: 0, done: {}, current: null, chains: ids.map((owner, c) => ({ owner, prompt: pool[picks[c] % pool.length], steps: [] })) };
      this.g = { ...this.g, total: ids.length };
    }
    const s = this.secret, n = s.ids.length;
    s.step = step; s.done = {}; s.current = null;
    const kind = step % 2 === 0 ? 'draw' : 'guess';
    const secs = kind === 'draw' ? (g.opts.drawSeconds || TP_DRAW_SECS) : (g.opts.guessSeconds || TP_GUESS_SECS);
    this.g = { ...this.g, phase: 'step', startsAt: null, endsAt: null, x: { step: step + 1, of: n, kind, secs, ids: s.ids, done: [], current: null, endsAt: null } };
    this.app.sfx('question');
  },
  // what this person sees: only the step before theirs in the chain they were handed
  tpItem(pid) {
    const s = this.secret, n = s.ids.length, step = s.step;
    const c = telephoneChain(s.ids.indexOf(pid), step, n);
    const chain = s.chains[c];
    if (step === 0) return { type: 'text', text: chain.prompt };
    const prev = chain.steps[step - 1];
    if (prev?.kind === 'draw') return prev.art ? { type: 'art', url: `/api/drawing/${prev.art}.png` } : { type: 'blank' };
    return { type: 'text', text: prev?.text || 'a mystery' };
  },
  tpStart(pid) {
    const g = this.g;
    if (g.phase !== 'step') throw new Error('Not your turn yet');
    const s = this.turnGuard(pid);
    if (!s.current) this.beginTurn(pid, g.x.secs, 9000);
    return { ...this.tpItem(pid), kind: g.x.kind, step: g.x.step, of: g.x.of, secs: s.secs, endsAt: s.endsAt };
  },
  tpSubmit(pid, a) {
    const g = this.g, s = this.secret;
    if (g.phase !== 'step' || s.current !== pid) throw new Error('It is not your turn to hand this in');
    if (a.skip) return this.tpDone(pid, { skipped: true }), { ok: true };
    if (g.x.kind === 'draw') {
      const { buf } = readPng(a.png, { maxBytes: 600000, minDim: 100, maxDim: 1600 });
      const id = rid(); this.drawings.set(id, buf);
      this.tpDone(pid, { art: id });
    } else {
      const text = clean(a.text, 60);
      if (!text) throw new Error('Type what you think it is');
      this.tpDone(pid, { text });
    }
    return { ok: true };
  },
  tpDone(pid, out) {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'telephone' || g.phase !== 'step' || s.done[pid]) return;
    const n = s.ids.length, c = telephoneChain(s.ids.indexOf(pid), s.step, n);
    s.chains[c].steps[s.step] = { by: pid, kind: g.x.kind, ...out };
    s.done[pid] = true; s.current = null;
    this.g = { ...g, startsAt: null, endsAt: null, x: { ...g.x, done: Object.keys(s.done), current: null, endsAt: null } };
    this.clear();
    if (s.ids.every(id => s.done[id])) this.after(1400, () => this.tpStepDone());
    else this.app.sfx('correct');
  },
  tpStepDone() {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'telephone' || g.phase !== 'step') return;
    if (s.step + 1 < s.ids.length) { this.g = { ...g, round: g.round + 1 }; this.tpRound(); } else this.tpRevealStart();
  },
  tpPublic() {
    const s = this.secret;
    return s.chains.map(ch => ({ owner: ch.owner, prompt: ch.prompt, steps: ch.steps.map(st => ({ by: st.by, kind: st.kind, text: st.text || null, art: st.art ? `/api/drawing/${st.art}.png` : null, skipped: !!st.skipped })) }));
  },
  tpRevealStart() {
    const g = this.g;
    this.g = { ...g, phase: 'reveal', startsAt: null, endsAt: null, x: { chains: this.tpPublic(), ci: 0, show: 1, cmp: false } };
    this.app.sfx('fanfare');
  },
  tpRevealNext() {
    const g = this.g;
    if (g?.kind !== 'telephone' || g.phase !== 'reveal') return;
    const x = g.x, n = x.chains.length;
    let { ci, show, cmp } = x;
    if (!cmp && show < n + 1) { show++; this.app.sfx('reveal'); }
    else if (!cmp) { cmp = true; this.app.sfx('fanfare'); }
    else if (ci + 1 < n) { ci++; show = 1; cmp = false; this.app.sfx('chime'); }
    else return this.tpVoteStart();
    this.g = { ...g, x: { ...x, ci, show, cmp } };
  },
  tpSkipChain() {
    const g = this.g;
    if (g?.kind !== 'telephone' || g.phase !== 'reveal') return;
    this.g = { ...g, x: { ...g.x, show: g.x.chains.length + 1, cmp: true } };
    this.app.sfx('fanfare');
  },
  tpVoteStart() {
    const g = this.g, s = this.secret;
    s.votes = {};
    this.g = { ...g, phase: 'vote', startsAt: Date.now(), endsAt: Date.now() + 120000, x: { chains: g.x.chains, voted: [] } };
    this.app.sfx('chime');
    this.after(120000, () => this.tpResult());
  },
  tpVote(pid, moment) {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'telephone' || g.phase !== 'vote' || !s.ids.includes(pid) || s.votes[pid]) return;
    const m = /^(\d+)\.(\d+)$/.exec(String(moment));
    const st = m && s.chains[+m[1]]?.steps[+m[2]];
    if (!st) throw new Error('Pick a moment');
    if (st.by === pid) throw new Error('You cannot vote for your own');
    s.votes[pid] = String(moment);
    this.g = { ...g, x: { ...g.x, voted: Object.keys(s.votes) } };
    if (Object.keys(s.votes).length >= s.ids.length) this.after(1000, () => this.tpResult());
  },
  tpResult() {
    const g = this.g, s = this.secret;
    if (g?.kind !== 'telephone' || g.phase !== 'vote') return;
    const counts = {};
    for (const m of Object.values(s.votes)) counts[m] = (counts[m] || 0) + 1;
    const top = Math.max(0, ...Object.values(counts));
    const winners = top > 0 ? Object.keys(counts).filter(m => counts[m] === top) : [];
    const gained = {};
    for (const [m, c] of Object.entries(counts)) {
      const [ci, si] = m.split('.').map(Number);
      const by = s.chains[ci].steps[si].by;
      gained[by] = (gained[by] || 0) + c * 150 + (winners.includes(m) ? 300 : 0);
    }
    this.partyGain(gained);
    // the chain that drifted furthest: its last guess shares the fewest words with the starting phrase
    let furthest = null, far = -1;
    s.chains.forEach((ch, ci) => {
      const last = [...ch.steps].reverse().find(st => st.kind === 'guess' && st.text);
      if (!last) return;
      const d = drift(ch.prompt, last.text);
      if (d > far) { far = d; furthest = { ci, from: ch.prompt, to: last.text }; }
    });
    this.g = { ...g, phase: 'verdict', startsAt: null, endsAt: null, x: { chains: g.x.chains, counts, winners, gained, furthest } };
    this.app.sfx('reveal');
    if (winners.length) this.partyFlash(s.chains[+winners[0].split('.')[0]].steps[+winners[0].split('.')[1]].by);
    if (furthest) this.echo(`The chain that went the furthest started as ${furthest.from}, and ended up as ${furthest.to}.`);
    this.partyAfterReveal(14000);
  },
};

// the gallery entry as every screen may see it (no file id, review filled in when the critic speaks)
function pubEntry(e) { return { n: e.n, title: e.title, medium: e.medium, artist: e.artist, subject: e.subject, art: e.art, review: null }; }
