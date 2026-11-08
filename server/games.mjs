// Party games. Phones join as players (/play), the TV shows the board (/tv), the iPad hosts (/).
// Public game state lives in app.state.game and is broadcast; secrets (the Pictionary word,
// Secret Santa matches) go only to the device that may see them.
import fs from 'node:fs';
import path from 'node:path';
import { previewFor } from './previews.mjs';
import { PARTY_KINDS, partyMethods } from './party.mjs';
import { DRAW_KINDS, drawMethods } from './draw-games.mjs';

// one colour per person when everyone plays for themselves
export const PLAYER_COLORS = ['#d6312b', '#1f9a52', '#e0a92e', '#3a7be0', '#b45ad8', '#e8743b', '#2bb3b1', '#d94f8c'];

export const TEAMS = [
  { id: 'red', name: 'Team Holly', color: '#d6312b' },
  { id: 'green', name: 'Team Pine', color: '#1f9a52' },
  { id: 'gold', name: 'Team Star', color: '#e0a92e' },
  { id: 'blue', name: 'Team Frost', color: '#3a7be0' },
];
const teamOf = id => TEAMS.find(t => t.id === id) || TEAMS[0];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export function guessMatches(guess, word) {
  const g = norm(guess), w = norm(word);
  if (!g || !w) return false;
  if (g === w || g.replace(/ /g, '') === w.replace(/ /g, '')) return true;
  if (g === w + 's' || g + 's' === w) return true;
  return w.length >= 6 && lev(g, w) <= (w.length >= 10 ? 2 : 1);
}

export class Games {
  constructor(app) {
    this.app = app;
    this.players = new Map(); // id -> {id, name, team, score, sockets:Set}
    this.timer = null;
    this.secret = {};
    this.used = { trivia: new Set(), hits: new Set(), wyr: new Set(), pict: new Set() };
    this.strokes = [];
    this.drawings = new Map(); // finished PNG drawings of the drawing games (server/draw-games.mjs), by id
    this.drawIdx = -1;
    // the family roster for pass-the-iPad play is remembered between restarts
    for (const lp of app.config.roster || []) this.players.set(lp.id, { id: lp.id, name: lp.name, team: lp.team, photo: lp.photo || 0, score: 0, sockets: new Set(), local: true });
    this.streak = {}; // pid -> correct answers in a row (solo trivia)
    this.app.state.players = this.publicPlayers();
    this.syncOrnaments(); // the ornaments hung on the tree stay for the whole season
  }
  get g() { return this.app.state.game; }
  set g(v) { this.app.state.game = v; this.app.changed(); }

  // ---------- players ----------
  // local = plays on the iPad (pass it around); otherwise a phone that joined at /play
  publicPlayers() {
    return [...this.players.values()].map((p, i) => ({ id: p.id, name: p.name, team: p.team, color: PLAYER_COLORS[i % PLAYER_COLORS.length], score: p.score, photo: p.photo || 0, local: !!p.local, online: !!p.local || p.sockets.size > 0 }));
  }
  // Everyone for themselves (the default for the family): scores, turns and the winner are per person.
  solo() { return this.app.config.settings.solo !== false; }
  // Solo trivia passes the iPad: one person per question, on the TV with a timer.
  hotSeat() { return this.solo() && this.localCount() > 0 && ![...this.players.values()].some(p => !p.local && p.sockets.size); }
  setPhoto(pid, jpeg) {
    const p = this.players.get(pid);
    if (!p) throw new Error('Who is this photo for?');
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(jpeg || ''));
    if (!m) throw new Error('That photo did not come through. Try again.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 500 || buf.length > 400000) throw new Error('That photo is too big. Try again.');
    const dir = path.join(this.app.dataDir, 'players');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pid.replace(/[^\w-]/g, '')}.jpg`), buf);
    p.photo = Date.now();
    this.syncPlayers();
    return p.photo;
  }
  syncPlayers() {
    this.app.state.players = this.publicPlayers();
    this.app.config.roster = [...this.players.values()].filter(p => p.local).map(p => ({ id: p.id, name: p.name, team: p.team, photo: p.photo || 0 }));
    this.app.saveConfig();
    this.app.changed();
  }
  autoTeam() {
    const counts = Object.fromEntries(TEAMS.slice(0, this.teamCount()).map(t => [t.id, 0]));
    for (const q of this.players.values()) if (q.team in counts) counts[q.team]++;
    return Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
  }
  addLocal(name, team) {
    name = String(name || '').trim().slice(0, 16);
    if (!name) throw new Error('Type a name');
    if ([...this.players.values()].some(p => p.local && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already playing`);
    const id = 'L' + Math.random().toString(36).slice(2, 8);
    const p = { id, name, team: TEAMS.slice(0, this.teamCount()).some(t => t.id === team) ? team : this.autoTeam(), score: 0, sockets: new Set(), local: true };
    this.players.set(id, p);
    this.app.lights.overlay({ kind: 'flash', color: teamOf(p.team).color, dur: 0.9 });
    this.syncPlayers();
    return p;
  }
  localCount() { let n = 0; for (const p of this.players.values()) if (p.local) n++; return n; }
  attach(ws, pid) {
    let p = this.players.get(pid);
    if (p) { p.sockets.add(ws); this.syncPlayers(); }
    ws.on('close', () => { const q = this.players.get(pid); if (q) { q.sockets.delete(ws); this.syncPlayers(); } });
    if (this.g?.kind === 'pictionary') ws.send(JSON.stringify({ type: 'strokes', strokes: this.strokes }));
  }
  join(ws, pid, name, team) {
    name = String(name || '').trim().slice(0, 16) || 'Elf';
    let p = this.players.get(pid);
    if (!p) {
      p = { id: pid, name, team: TEAMS.some(t => t.id === team) ? team : this.autoTeam(), score: 0, sockets: new Set([ws]) };
      this.players.set(pid, p);
      this.app.lights.overlay({ kind: 'flash', color: teamOf(p.team).color, dur: 0.9 });
    } else {
      p.name = name;
      if (TEAMS.some(t => t.id === team)) p.team = team;
      p.sockets.add(ws);
    }
    this.syncPlayers();
    return p;
  }
  teamCount() { return Math.min(4, Math.max(2, (this.app.config.settings.teams | 0) || 2)); }
  kick(pid) { this.players.delete(pid); this.syncPlayers(); }
  resetScores() { for (const p of this.players.values()) p.score = 0; this.syncPlayers(); }
  teamScores() {
    const s = {};
    for (const t of TEAMS.slice(0, this.teamCount())) s[t.id] = 0;
    for (const p of this.players.values()) s[p.team] = (s[p.team] || 0) + p.score;
    return s;
  }
  toPlayer(pid, msg) { const p = this.players.get(pid); if (p) for (const ws of p.sockets) ws.send(JSON.stringify(msg)); }

  // ---------- flow helpers ----------
  clear() { clearTimeout(this.timer); this.timer = null; }
  after(ms, fn) { this.clear(); const token = Symbol(); this.token = token; this.timer = setTimeout(() => { if (this.token === token) fn(); }, ms); }
  end() {
    this.clear();
    this.stopGameAudio();
    this.drawings.clear();
    this.g = null;
    this.app.lights.clearOverlays();
    this.app.setTvScene(this.app.state.tv.prev || 'home');
  }

  start(kind, opts = {}) {
    if (!['trivia', 'name-that-song', 'would-you-rather', 'pictionary', ...PARTY_KINDS, ...DRAW_KINDS].includes(kind)) throw new Error('Unknown game');
    // the family games always play for yourself, whatever the team switch says
    const party = PARTY_KINDS.includes(kind) ? this.partySetup(kind, opts) : DRAW_KINDS.includes(kind) ? this.drawSetup(kind, opts) : null;
    this.clear();
    this.stopGameAudio();
    this.app.lights.clearOverlays();
    this.secret = {};
    if (opts.resetScores !== false) this.resetScores();
    this.streak = {};
    this.g = { kind, phase: 'lobby', round: 0, total: opts.rounds || ({ trivia: 10, 'name-that-song': 8, 'would-you-rather': 8, pictionary: 6 })[kind] || 8, opts, startedAt: Date.now(), solo: this.solo() || !!party };
    if (party) this.g = { ...this.g, ...party };
    if (kind === 'trivia' && this.hotSeat()) {
      // everyone gets the same number of turns, in a shuffled order
      const order = shuffle([...this.players.values()].filter(p => p.local).map(p => p.id));
      const each = Math.max(1, Math.round((opts.rounds || 10) / order.length));
      this.g = { ...this.g, hotSeat: true, order, total: Math.min(30, each * order.length) };
    }
    this.app.setTvScene('game', true);
    return { ok: true };
  }
  next() {
    const g = this.g;
    if (!g) return;
    // the drawing games use Next to move a gallery or a chain reveal along
    if (DRAW_KINDS.includes(g.kind) && g.phase !== 'lobby' && this.drawAdvance()) return;
    if (g.round >= g.total && g.phase !== 'lobby') return this.final();
    g.round++;
    if (g.kind === 'trivia' && g.hotSeat) this.triviaTurn();
    else if (g.kind === 'trivia') this.triviaQuestion();
    else if (g.kind === 'name-that-song') this.songRound();
    else if (g.kind === 'would-you-rather') this.wyrRound();
    else if (g.kind === 'pictionary') this.pictRound();
    else if (PARTY_KINDS.includes(g.kind)) this.partyRound();
    else if (DRAW_KINDS.includes(g.kind)) this.drawRound();
  }
  final() {
    this.clear();
    this.stopGameAudio();
    const scores = this.teamScores();
    const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const board = this.publicPlayers().sort((a, b) => b.score - a.score);
    let col = winner ? teamOf(winner[0]).color : '#e0a92e';
    if (this.g.solo) {
      // ties share the crown
      const top = board[0]?.score || 0;
      const champs = top > 0 ? board.filter(p => p.score === top).map(p => p.id) : [];
      this.g = { ...this.g, phase: 'final', board, champs, winner: null, turn: null };
      col = board.find(p => p.id === champs[0])?.color || col;
    } else this.g = { ...this.g, phase: 'final', teamScores: scores, winner: winner ? winner[0] : null, board };
    this.app.lights.overlay({ kind: 'wipe', color: col, dur: 1.4, hold: 3 });
    setTimeout(() => this.app.lights.overlay({ kind: 'burst', color: '#ffffff', dur: 2.5 }), 1800);
    this.app.sfx('fanfare');
  }

  // ---------- Trivia ----------
  // Solo trivia (hot seat): "Trinity, you're up!" on the TV with her photo; she takes the iPad and taps
  // ready, then the question and her timer start. Only she can answer.
  triviaTurn() {
    const g = this.g;
    const live = g.order.filter(id => this.players.has(id));
    if (!live.length) return this.final();
    const pid = live[(g.round - 1) % live.length];
    const p = this.players.get(pid), pub = this.publicPlayers().find(x => x.id === pid);
    this.secret = {};
    this.g = { ...g, phase: 'turn', turn: { pid, name: p.name, color: pub.color, photo: pub.photo, streak: this.streak[pid] || 0 }, q: null, choices: null, answer: null, answered: [], gained: null, picked: null };
    this.app.sfx('question');
  }
  turnReady(round) {
    const g = this.g;
    if (g?.kind === 'mind-reader') return this.mrReady(round);
    if (!g || g.kind !== 'trivia' || g.phase !== 'turn' || (round !== undefined && round !== g.round)) return;
    this.triviaQuestion({ seconds: g.opts.seconds || 20 });
  }
  triviaQuestion({ seconds } = {}) {
    const pool = this.app.content.trivia.filter((q, i) => !this.used.trivia.has(i) && (!this.g.opts.difficulty || q.difficulty <= this.g.opts.difficulty));
    if (!pool.length) this.used.trivia.clear();
    const all = this.app.content.trivia;
    const pick = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];
    this.used.trivia.add(all.indexOf(pick));
    const order = shuffle([0, 1, 2, 3]);
    // passing the iPad around takes time: give everyone room to answer
    const locals = this.localCount();
    const secs = seconds || this.g.opts.seconds || (locals ? Math.max(20, 12 + 8 * locals) : 20);
    this.secret = { answer: order.indexOf(pick.answer), answers: {} };
    this.g = {
      ...this.g, phase: 'question', q: pick.q, category: pick.category, difficulty: pick.difficulty,
      choices: order.map(i => pick.choices[i]), fact: null, answer: null, answered: [],
      startsAt: Date.now(), endsAt: Date.now() + secs * 1000, factText: pick.fact,
    };
    delete this.g.factText;
    this.secret.fact = pick.fact;
    this.app.sfx('question');
    this.after(secs * 1000, () => this.triviaReveal());
  }
  triviaAnswer(pid, choice) {
    const g = this.g;
    if (!g || g.kind !== 'trivia' || g.phase !== 'question' || !this.players.has(pid) || this.secret.answers[pid] !== undefined) return;
    if (!Number.isInteger(choice) || choice < -1 || choice > 3) return;
    if (g.hotSeat && g.turn?.pid !== pid) return; // only the person in the hot seat
    this.secret.answers[pid] = { choice, at: Date.now() };
    g.answered = Object.keys(this.secret.answers);
    if (g.hotSeat) { g.picked = choice; this.app.changed(); this.after(1400, () => this.triviaReveal()); return; } // a beat of suspense
    this.app.changed();
    const online = this.publicPlayers().filter(p => p.online).length;
    if (g.answered.length >= online && online > 0) this.after(600, () => this.triviaReveal());
  }
  triviaReveal() {
    const g = this.g;
    if (!g || g.phase !== 'question') return;
    const counts = [0, 0, 0, 0];
    const gained = {};
    const dur = g.endsAt - g.startsAt;
    for (const [pid, a] of Object.entries(this.secret.answers)) {
      if (a.choice < 0) continue; // skipped (pass-the-iPad)
      counts[a.choice]++;
      if (a.choice === this.secret.answer) {
        // speed bonus when each person answers on their own (phone or hot seat); passing the iPad
        // around for one shared question is flat 1000. Hot seat: 3+ in a row adds a streak bonus.
        let pts = this.localCount() && !g.hotSeat ? 1000 : Math.round((500 + 500 * Math.max(0, (g.endsAt - a.at) / dur)) / 10) * 10;
        if (g.hotSeat) { this.streak[pid] = (this.streak[pid] || 0) + 1; if (this.streak[pid] >= 3) pts += 250; }
        gained[pid] = pts;
        const p = this.players.get(pid);
        if (p) p.score += pts;
      }
    }
    if (g.hotSeat && g.turn && !gained[g.turn.pid]) this.streak[g.turn.pid] = 0;
    this.syncPlayers();
    const turn = g.turn ? { ...g.turn, streak: this.streak[g.turn.pid] || 0, timedOut: !this.secret.answers[g.turn.pid] } : g.turn;
    this.g = { ...g, phase: 'reveal', answer: this.secret.answer, fact: this.secret.fact, counts, gained, turn };
    const winners = Object.keys(gained).map(id => this.players.get(id)).filter(Boolean);
    if (winners.length) {
      const fastest = Object.entries(gained).sort((a, b) => b[1] - a[1])[0][0];
      this.app.lights.overlay({ kind: 'flash', color: g.solo ? this.publicPlayers().find(x => x.id === fastest)?.color || '#e0a92e' : teamOf(this.players.get(fastest)?.team).color, dur: 1.2 });
      this.app.lights.overlay({ kind: 'burst', color: '#ffffff', dur: 1.8 });
      this.app.sfx('correct');
    } else { this.app.lights.overlay({ kind: 'flash', color: '#3a1010', dur: 1 }); this.app.sfx('wrong'); }
    if (this.g.opts.auto !== false) this.after(g.hotSeat ? 6500 : 8000, () => this.next());
  }

  // ---------- Name That Christmas Song ----------
  async songRound() {
    const opts = this.g.opts;
    let useAlexa = !!this.app.alexa?.ready && opts.source !== 'carols' && opts.source !== 'preview';
    // XM_PREVIEWS=0: no internet lookups (the e2e test server)
    let usePreview = !useAlexa && opts.source !== 'carols' && this.app.content.hits.length > 0 && process.env.XM_PREVIEWS !== '0';
    let item, choices, preview = null, artwork = null;
    const pickHit = () => {
      let hits = this.app.content.hits.filter((h, i) => !this.used.hits.has(i) && (!opts.level || h.level <= opts.level));
      if (!hits.length) { this.used.hits.clear(); hits = this.app.content.hits; }
      const h = hits[Math.floor(Math.random() * hits.length)] || this.app.content.hits[0];
      this.used.hits.add(this.app.content.hits.indexOf(h));
      return h;
    };
    const hitChoices = h => shuffle([h, ...shuffle(this.app.content.hits.filter(x => x.title !== h.title)).slice(0, 3)]).map(x => ({ title: x.title, artist: x.artist }));
    if (usePreview) {
      const round = this.g.round;
      for (let tries = 0; tries < 4 && !preview; tries++) {
        const h = pickHit();
        const p = await previewFor(h, { dataDir: this.app.dataDir, log: this.app.log });
        if (this.g?.kind !== 'name-that-song' || this.g.round !== round) return; // game ended or moved on while looking up
        if (p) { preview = p; item = h; }
      }
      if (!preview) usePreview = false;
    }
    if (usePreview) {
      choices = hitChoices(item);
      artwork = preview.artwork;
    } else if (useAlexa) {
      item = pickHit();
      choices = hitChoices(item);
    } else {
      const songs = this.app.songList();
      const s = songs[Math.floor(Math.random() * songs.length)];
      item = { title: s.title, id: s.id };
      choices = shuffle([s, ...shuffle(songs.filter(x => x.id !== s.id)).slice(0, 3)]).map(x => ({ title: x.title, artist: '' }));
    }
    const startsAt = Date.now() + 2500;
    this.secret = { item, answer: choices.findIndex(c => c.title === item.title), locked: new Set(), artwork, previewStartsAt: startsAt, previewOffset: 0 };
    this.g = { ...this.g, phase: 'playing', source: usePreview ? 'preview' : useAlexa ? 'alexa' : 'carols', choices, buzz: null, answer: null, wrong: [], endsAt: Date.now() + 35000, startsAt };
    delete this.g.preview; delete this.g.artwork;
    if (usePreview) this.g.preview = { url: preview.url, startsAt };
    this.app.sfx('question');
    this.after(35000, () => this.songReveal(null));
    if (usePreview) {
      // the TV plays the clip itself (web/lib/preview-player.js)
    } else if (useAlexa) {
      try { await this.app.alexa.text(`play ${item.ask}`); } catch (e) { this.app.log('alexa', e.message); }
    } else {
      this.app.playShow(item.id, { lyrics: false, game: true, delay: 2500 });
    }
  }
  // Stops whatever music a game started (carol on the TV or a track on the Echo).
  // Pause/resume the TV-played preview clip; tracks seconds played so the TV can resume.
  previewPause(paused) {
    const g = this.g, pv = g?.preview;
    if (!pv || g.source !== 'preview') return;
    const s = this.secret;
    if (paused && !pv.paused) {
      s.previewOffset = Math.max(0, (s.previewOffset || 0) + (Date.now() - Math.max(s.previewStartsAt || 0, s.previewResumedAt || 0)) / 1000);
      g.preview = { ...pv, paused: true, offset: +s.previewOffset.toFixed(2) };
    } else if (!paused && pv.paused) {
      s.previewResumedAt = Date.now();
      g.preview = { ...pv, paused: false, offset: pv.offset || 0 };
    } else return;
    this.app.changed();
  }
  stopGameAudio() {
    if (this.app.state.show.game) this.app.stopShow();
    if (this.g?.kind === 'name-that-song' && this.g.source === 'alexa') this.app.alexa?.command('pause').catch(() => { });
  }
  async buzz(pid) {
    const g = this.g;
    if (!g || g.kind !== 'name-that-song' || g.phase !== 'playing' || this.secret.locked.has(pid)) return;
    const p = this.players.get(pid);
    if (!p) return;
    this.secret.remaining = Math.max(5000, g.endsAt - Date.now());
    this.g = { ...g, phase: 'buzzed', buzz: { pid, name: p.name, team: p.team }, buzzEndsAt: Date.now() + 10000 };
    this.app.lights.overlay({ kind: 'flash', color: teamOf(p.team).color, dur: 10, hold: 0 });
    this.app.sfx('buzz');
    if (g.source === 'alexa') this.app.alexa.command('pause').catch(() => { });
    else if (g.source === 'preview') this.previewPause(true);
    else this.app.pauseShow(true);
    this.after(10000, () => this.songJudge(pid, -1));
  }
  songJudge(pid, choice) {
    const g = this.g;
    if (!g || g.phase !== 'buzzed' || g.buzz?.pid !== pid) return;
    this.app.lights.clearOverlays('flash');
    if (choice === this.secret.answer) {
      const p = this.players.get(pid);
      const pts = 1000 + Math.round(Math.max(0, g.endsAt - Date.now()) / 35);
      if (p) p.score += pts;
      this.syncPlayers();
      this.songReveal(pid, pts);
    } else {
      this.secret.locked.add(pid);
      this.app.sfx('wrong');
      this.app.lights.overlay({ kind: 'flash', color: '#400000', dur: 0.8 });
      this.g = { ...g, phase: 'playing', buzz: null, wrong: [...(g.wrong || []), pid], endsAt: Date.now() + this.secret.remaining };
      if (g.source === 'alexa') this.app.alexa.command('play').catch(() => { });
      else if (g.source === 'preview') { this.g.preview = g.preview; this.previewPause(false); }
      else this.app.pauseShow(false);
      this.after(this.secret.remaining, () => this.songReveal(null));
    }
  }
  songReveal(pid, pts = 0) {
    const g = this.g;
    if (!g || g.kind !== 'name-that-song' || g.phase === 'reveal' || !this.secret.item) return;
    this.g = { ...g, phase: 'reveal', answer: this.secret.answer, winner: pid, points: pts, item: { title: this.secret.item.title, artist: this.secret.item.artist || '', year: this.secret.item.year || null } };
    if (g.source === 'preview') this.g.artwork = this.secret.artwork || null;
    if (pid) { this.app.lights.overlay({ kind: 'burst', color: teamOf(this.players.get(pid)?.team).color, dur: 2 }); this.app.sfx('correct'); }
    if (g.source === 'alexa') this.app.alexa.command('play').catch(() => { }); else if (g.source !== 'preview') this.app.pauseShow(false);
    this.after(9000, () => {
      if (g.source === 'alexa') this.app.alexa.command('pause').catch(() => { }); else if (g.source !== 'preview') this.app.stopShow();
      this.next();
    });
  }

  // ---------- Would You Rather ----------
  wyrRound() {
    const list = this.app.content.wyr;
    let i = Math.floor(Math.random() * list.length), guard = 0;
    while (this.used.wyr.has(i) && guard++ < 200) i = Math.floor(Math.random() * list.length);
    this.used.wyr.add(i);
    this.secret = { votes: {} };
    this.g = { ...this.g, phase: 'vote', a: list[i].a, b: list[i].b, votesIn: 0, endsAt: Date.now() + 15000, result: null };
    this.app.lights.overlay({ kind: 'split', color: '#d6312b', color2: '#1f9a52', value: 0.5, dur: 15 });
    this.after(15000, () => this.wyrReveal());
  }
  vote(pid, side) {
    const g = this.g;
    if (!g || g.kind !== 'would-you-rather' || g.phase !== 'vote' || !this.players.has(pid)) return;
    this.secret.votes[pid] = side === 'b' ? 'b' : 'a';
    g.votesIn = Object.keys(this.secret.votes).length;
    this.app.changed();
    const online = this.publicPlayers().filter(p => p.online).length;
    if (g.votesIn >= online) this.after(500, () => this.wyrReveal());
  }
  wyrReveal() {
    const g = this.g;
    if (!g || g.phase !== 'vote') return;
    const v = Object.entries(this.secret.votes);
    const a = v.filter(x => x[1] === 'a').map(x => this.players.get(x[0])?.name).filter(Boolean);
    const b = v.filter(x => x[1] === 'b').map(x => this.players.get(x[0])?.name).filter(Boolean);
    const share = a.length + b.length ? a.length / (a.length + b.length) : 0.5;
    this.app.lights.clearOverlays('split');
    this.app.lights.overlay({ kind: 'split', color: '#d6312b', color2: '#1f9a52', value: share, dur: 8 });
    for (const [pid, side] of v) { const p = this.players.get(pid); const minority = side === 'a' ? share < 0.5 : share > 0.5; if (p && !minority) p.score += 100; }
    this.syncPlayers();
    this.g = { ...g, phase: 'reveal', result: { a, b, share } };
    this.app.sfx('reveal');
    this.after(8000, () => this.next());
  }

  // ---------- Pictionary (draw on the iPad, guess on phones, watch on the TV) ----------
  pictRound() {
    const level = this.g.opts.level || 2;
    const list = this.app.content.pictionary.filter(w => w.level <= level);
    let w, guard = 0;
    do { w = list[Math.floor(Math.random() * list.length)]; } while (this.used.pict.has(w.word) && guard++ < 200);
    this.used.pict.add(w.word);
    this.strokes = [];
    this.app.broadcastTo(c => c.role !== 'remote', { type: 'strokes', strokes: [] });
    this.secret = { word: w.word, guessed: new Set() };
    // take turns drawing: the iPad is passed to the next player, who taps "show my word"
    const roster = [...this.players.values()];
    let drawer = null;
    if (roster.length) { this.drawIdx = (this.drawIdx + 1) % roster.length; const d = roster[this.drawIdx]; drawer = { pid: d.id, name: d.name, team: d.team }; }
    this.g = { ...this.g, phase: drawer ? 'pass' : 'draw', mask: w.word.replace(/[a-z]/gi, '_'), letters: w.word.replace(/ /g, '').length, guesses: [], correct: [], word: null, drawer, endsAt: null, startsAt: null };
    this.clear();
    if (!drawer) this.drawReady();
  }
  drawReady() {
    const g = this.g;
    if (!g || g.kind !== 'pictionary' || !['pass', 'draw'].includes(g.phase) || g.endsAt && g.phase === 'draw') return;
    const secs = g.opts.seconds || 80;
    this.g = { ...g, phase: 'draw', endsAt: Date.now() + secs * 1000, startsAt: Date.now() };
    this.app.broadcastTo(c => c.role === 'remote', { type: 'secret', word: this.secret.word });
    this.app.lights.overlay({ kind: 'dim', value: 0.55, dur: secs });
    this.after(secs * 1000, () => this.pictReveal());
  }
  // someone guessed it out loud: the iPad taps who
  award(pid) {
    const g = this.g;
    if (!g || g.kind !== 'pictionary' || g.phase !== 'draw') return;
    const p = this.players.get(pid);
    if (!p || pid === g.drawer?.pid || this.secret.guessed.has(pid)) return;
    this.secret.guessed.add(pid);
    const pts = 300 + Math.round(700 * Math.max(0, (g.endsAt - Date.now()) / (g.endsAt - g.startsAt)));
    p.score += pts;
    const d = g.drawer && this.players.get(g.drawer.pid);
    if (d) d.score += 400;
    this.syncPlayers();
    this.g = { ...g, correct: [...g.correct, { name: p.name, team: p.team, pts }] };
    this.app.lights.overlay({ kind: 'burst', color: teamOf(p.team).color, dur: 1.6 });
    this.app.sfx('correct');
    this.after(1200, () => this.pictReveal());
  }
  stroke(s) {
    if (!this.g || this.g.kind !== 'pictionary' || this.g.phase !== 'draw') return;
    if (s.clear) this.strokes = []; else this.strokes.push(s);
    if (this.strokes.length > 4000) this.strokes.shift();
    this.app.broadcastTo(c => c.role !== 'remote' || c.id !== s.from, { type: 'stroke', stroke: s });
  }
  guess(pid, text) {
    const g = this.g;
    if (!g || g.kind !== 'pictionary' || g.phase !== 'draw') return;
    const p = this.players.get(pid);
    if (!p || this.secret.guessed.has(pid)) return;
    const clean = String(text || '').slice(0, 40);
    if (guessMatches(clean, this.secret.word)) {
      this.secret.guessed.add(pid);
      const pts = 300 + Math.round(700 * Math.max(0, (g.endsAt - Date.now()) / (g.endsAt - g.startsAt)));
      p.score += pts;
      this.syncPlayers();
      g.correct = [...g.correct, { name: p.name, team: p.team, pts }];
      this.app.lights.overlay({ kind: 'burst', color: teamOf(p.team).color, dur: 1.6 });
      this.app.sfx('correct');
      this.toPlayer(pid, { type: 'you-got-it', word: this.secret.word, pts });
      const online = this.publicPlayers().filter(q => q.online).length;
      if (this.secret.guessed.size >= online) this.after(1200, () => this.pictReveal());
    } else {
      g.guesses = [...g.guesses.slice(-14), { name: p.name, team: p.team, text: clean }];
    }
    this.app.changed();
  }
  pictReveal() {
    const g = this.g;
    if (!g || g.kind !== 'pictionary' || !['draw', 'pass'].includes(g.phase)) return;
    this.app.lights.clearOverlays('dim');
    this.g = { ...g, phase: 'reveal', word: this.secret.word };
    this.app.sfx('reveal');
    this.after(7000, () => this.next());
  }

  // ---------- messages from phones ----------
  onPlayerMessage(ws, pid, m) {
    if (m.type === 'join') { const p = this.join(ws, pid, m.name, m.team); ws.send(JSON.stringify({ type: 'joined', player: { id: p.id, name: p.name, team: p.team } })); }
    else if (m.type === 'answer') this.triviaAnswer(pid, m.choice);
    else if (m.type === 'buzz') this.buzz(pid);
    else if (m.type === 'pick') { if (Number.isInteger(m.choice)) this.songJudge(pid, m.choice); }
    else if (m.type === 'vote') this.vote(pid, m.side);
    else if (m.type === 'guess') this.guess(pid, m.text);
    else if (m.type === 'cheer') this.app.lights.overlay({ kind: 'flash', color: teamOf(this.players.get(pid)?.team).color, dur: 0.6 });
  }
}

Object.assign(Games.prototype, partyMethods, drawMethods);
