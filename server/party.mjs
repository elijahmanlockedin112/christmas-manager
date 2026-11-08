// Three solo "family" party games that put the people, not the questions, in the spotlight.
// They are mixed into the Games class (see games.mjs). Everyone plays on the one iPad: a player taps
// their own face to say who they are, so nobody has to pass the iPad in a fixed order.
//
//   most-likely   "Most likely to hide the last cookie": everyone secretly votes for a person.
//   mind-reader   one person secretly picks A or B, everyone else guesses what they picked.
//   caption-chaos everyone captions a ridiculous scene, then votes for the funniest (not their own).
//                 If the Claude key is set, an elf sneaks a caption of its own into the pile.
//
// Public state lives in g.x (broadcast). Secrets (who voted for whom, the hidden pick) stay in this.secret
// until the reveal.

export const PARTY_KINDS = ['most-likely', 'mind-reader', 'caption-chaos'];
export const PARTY_NAMES = { 'most-likely': 'Most Likely To', 'mind-reader': 'Mind Reader', 'caption-chaos': 'Caption Chaos' };

const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const partyMethods = {
  // Called from start(): checks the room is big enough and returns the first-round settings.
  partySetup(kind, opts) {
    const ids = [...this.players.keys()];
    const need = kind === 'mind-reader' ? 2 : 3;
    if (ids.length < need) throw new Error(`${PARTY_NAMES[kind]} needs at least ${need} players`);
    this.used.party ||= {};
    this.used.party[kind] = new Set();
    if (kind === 'mind-reader') {
      // everyone gets the spotlight the same number of times
      const laps = ids.length >= 4 ? 1 : 2;
      let order = [];
      for (let i = 0; i < laps; i++) order = order.concat(shuffle(ids));
      return { order, total: opts.rounds ? Math.min(opts.rounds, 30) : order.length };
    }
    return { total: opts.rounds ? Math.min(opts.rounds, 20) : kind === 'caption-chaos' ? 4 : 8 };
  },
  partyPick(kind, list) {
    const used = (this.used.party[kind] ||= new Set());
    if (used.size >= list.length) used.clear();
    let i, guard = 0;
    do { i = Math.floor(Math.random() * list.length); } while (used.has(i) && guard++ < 300);
    used.add(i);
    return list[i];
  },
  pub(pid) {
    const p = this.publicPlayers().find(x => x.id === pid);
    return p ? { id: p.id, name: p.name, color: p.color, photo: p.photo } : null;
  },
  partyRound() {
    const k = this.g.kind;
    if (k === 'most-likely') this.mlRound();
    else if (k === 'mind-reader') this.mrRound();
    else this.capRound();
  },
  partyReveal() {
    const g = this.g;
    if (g.kind === 'most-likely') this.mlReveal();
    else if (g.kind === 'mind-reader') this.mrReveal();
    else if (g.phase === 'write') this.capVoteStart();
    else this.capReveal();
  },
  partyAfterReveal(ms) { if (this.g.opts.auto !== false) this.after(ms, () => this.next()); },
  partyGain(gained) {
    for (const [pid, pts] of Object.entries(gained)) { const p = this.players.get(pid); if (p) p.score += pts; }
    this.syncPlayers();
  },
  partyFlash(pid) {
    const c = this.pub(pid)?.color || '#e0a92e';
    this.app.lights.overlay({ kind: 'flash', color: c, dur: 1.2 });
    this.app.lights.overlay({ kind: 'burst', color: '#ffffff', dur: 1.8 });
  },

  // ---------- Most Likely To ----------
  mlRound() {
    const prompt = this.partyPick('most-likely', this.app.content.mostLikely);
    this.secret = { votes: {} };
    this.g = { ...this.g, phase: 'vote', x: { prompt, voted: [] } };
    this.app.sfx('question');
    this.after(150000, () => this.mlReveal());
  },
  mlVote(pid, target) {
    const g = this.g;
    if (!g || g.kind !== 'most-likely' || g.phase !== 'vote' || !this.players.has(pid) || !this.players.has(target) || this.secret.votes[pid]) return;
    this.secret.votes[pid] = target;
    this.g = { ...g, x: { ...g.x, voted: Object.keys(this.secret.votes) } };
    if (Object.keys(this.secret.votes).length >= this.players.size) this.after(1000, () => this.mlReveal());
  },
  mlReveal() {
    const g = this.g;
    if (!g || g.kind !== 'most-likely' || g.phase !== 'vote') return;
    const votes = this.secret.votes, tally = {};
    for (const id of this.players.keys()) tally[id] = 0;
    for (const t of Object.values(votes)) if (t in tally) tally[t]++;
    const top = Math.max(0, ...Object.values(tally));
    // somebody has to actually be the crowd's pick: two or more votes
    const winners = top >= 2 ? Object.keys(tally).filter(id => tally[id] === top) : [];
    const gained = {};
    for (const [voter, t] of Object.entries(votes)) if (winners.includes(t)) gained[voter] = (gained[voter] || 0) + 100;
    for (const w of winners) gained[w] = (gained[w] || 0) + 150;
    this.partyGain(gained);
    this.g = { ...g, phase: 'reveal', x: { ...g.x, ballots: votes, tally, winners, gained } };
    if (winners.length) { this.partyFlash(winners[0]); this.app.sfx('reveal'); } else this.app.sfx('wrong');
    this.partyAfterReveal(10000);
  },

  // ---------- Mind Reader ----------
  mrRound() {
    const g = this.g;
    const live = g.order.filter(id => this.players.has(id));
    if (!live.length) return this.final();
    const spot = this.pub(live[(g.round - 1) % live.length]);
    const pair = this.partyPick('mind-reader', this.app.content.mindReader);
    this.secret = { pair, pick: null, guesses: {} };
    this.g = { ...g, phase: 'turn', x: { spot, a: null, b: null, guessed: [] } };
    this.app.sfx('question');
  },
  mrReady(round) {
    const g = this.g;
    if (!g || g.kind !== 'mind-reader' || g.phase !== 'turn' || (round !== undefined && round !== g.round)) return;
    this.g = { ...g, phase: 'pick', x: { ...g.x, a: this.secret.pair.a, b: this.secret.pair.b } };
  },
  mrPick(pid, side) {
    const g = this.g;
    if (!g || g.kind !== 'mind-reader' || g.phase !== 'pick' || pid !== g.x.spot.id || !['a', 'b'].includes(side)) return;
    this.secret.pick = side;
    this.g = { ...g, phase: 'guess', x: { ...g.x, guessed: [] } };
    this.app.sfx('chime');
  },
  mrGuess(pid, side) {
    const g = this.g;
    if (!g || g.kind !== 'mind-reader' || g.phase !== 'guess' || !this.players.has(pid) || pid === g.x.spot.id || this.secret.guesses[pid] || !['a', 'b'].includes(side)) return;
    this.secret.guesses[pid] = side;
    this.g = { ...g, x: { ...g.x, guessed: Object.keys(this.secret.guesses) } };
    const others = [...this.players.keys()].filter(id => id !== g.x.spot.id);
    if (others.every(id => this.secret.guesses[id])) this.after(1000, () => this.mrReveal());
  },
  mrReveal() {
    const g = this.g;
    if (!g || g.kind !== 'mind-reader' || !['pick', 'guess'].includes(g.phase)) return;
    const pick = this.secret.pick, guesses = this.secret.guesses;
    const right = pick ? Object.keys(guesses).filter(id => guesses[id] === pick) : [];
    const gained = {};
    for (const id of right) gained[id] = 300;
    if (right.length) gained[g.x.spot.id] = 100 * right.length;
    this.partyGain(gained);
    const others = [...this.players.keys()].filter(id => id !== g.x.spot.id).length;
    this.g = { ...g, phase: 'reveal', x: { ...g.x, a: this.secret.pair.a, b: this.secret.pair.b, pick, guesses, right, gained, others } };
    if (right.length) { this.partyFlash(g.x.spot.id); this.app.sfx('correct'); } else this.app.sfx('wrong');
    this.partyAfterReveal(9500);
  },

  // ---------- Caption Chaos ----------
  capRound() {
    const sc = this.partyPick('caption-chaos', this.app.content.captions);
    const secs = this.g.opts.seconds || 90;
    const round = this.g.round;
    this.secret = { captions: {}, elf: null, round, entryAuthor: {}, votes: {} };
    const elfOn = !!this.app.ai?.configured && this.g.opts.elf !== false;
    this.g = { ...this.g, phase: 'write', startsAt: Date.now(), endsAt: Date.now() + secs * 1000, x: { scene: sc.scene, ask: sc.ask, written: [], elf: elfOn } };
    this.app.sfx('question');
    this.after(secs * 1000, () => this.capVoteStart());
    if (elfOn) {
      // the elf writes while the family types. If it's late or fails, the round just goes without it.
      this.app.ai.captionElf({ scene: sc.scene, ask: sc.ask }).then(t => {
        if (this.secret.round === round && this.g?.kind === 'caption-chaos' && this.g.phase === 'write') this.secret.elf = clean(t, 90) || null;
      }).catch(e => this.app.log('ai', 'caption elf', e.message));
    }
  },
  capSubmit(pid, text, skip) {
    const g = this.g;
    if (!g || g.kind !== 'caption-chaos' || g.phase !== 'write' || !this.players.has(pid) || g.x.written.includes(pid)) return;
    const t = clean(text, 90);
    if (!t && !skip) return;
    if (t) this.secret.captions[pid] = t;
    this.g = { ...g, x: { ...g.x, written: [...g.x.written, pid] } };
    if (g.x.written.length + 1 >= this.players.size) this.after(900, () => this.capVoteStart());
  },
  capVoteStart() {
    const g = this.g;
    if (!g || g.kind !== 'caption-chaos' || g.phase !== 'write') return;
    const raw = Object.entries(this.secret.captions).map(([author, text]) => ({ author, text }));
    if (this.secret.elf) raw.push({ author: 'elf', text: this.secret.elf });
    if (raw.length < 2) { this.secret.entries = raw; this.g = { ...g, phase: 'vote', x: { ...g.x, entries: [], voted: [] } }; return this.capReveal(); }
    const entries = shuffle(raw).map((e, i) => ({ id: 'c' + i, ...e }));
    this.secret.entries = entries;
    this.g = { ...g, phase: 'vote', startsAt: Date.now(), endsAt: Date.now() + 75000, x: { ...g.x, entries: entries.map(e => ({ id: e.id, text: e.text })), voted: [] } };
    this.app.sfx('chime');
    this.after(75000, () => this.capReveal());
  },
  capVote(pid, entryId) {
    const g = this.g;
    if (!g || g.kind !== 'caption-chaos' || g.phase !== 'vote' || !this.players.has(pid) || this.secret.votes[pid]) return;
    const e = (this.secret.entries || []).find(x => x.id === entryId);
    if (!e || e.author === pid) return; // no voting for yourself
    this.secret.votes[pid] = entryId;
    this.g = { ...g, x: { ...g.x, voted: Object.keys(this.secret.votes) } };
    if (Object.keys(this.secret.votes).length >= this.players.size) this.after(1000, () => this.capReveal());
  },
  capReveal() {
    const g = this.g;
    if (!g || g.kind !== 'caption-chaos' || g.phase !== 'vote') return;
    const entries = (this.secret.entries || []).map(e => ({ id: e.id, text: e.text, author: e.author, voters: Object.keys(this.secret.votes).filter(v => this.secret.votes[v] === e.id) }));
    entries.sort((a, b) => b.voters.length - a.voters.length);
    const top = entries[0]?.voters.length || 0;
    const winners = top > 0 ? entries.filter(e => e.voters.length === top).map(e => e.id) : [];
    const gained = {};
    for (const e of entries) {
      if (e.author === 'elf' || !e.voters.length) continue;
      gained[e.author] = e.voters.length * 200 + (winners.includes(e.id) ? 300 : 0);
    }
    this.partyGain(gained);
    this.g = { ...g, phase: 'reveal', x: { ...g.x, entries, winners, gained, voted: Object.keys(this.secret.votes) } };
    const w = entries.find(e => e.id === winners[0]);
    if (w && w.author !== 'elf') { this.partyFlash(w.author); this.app.sfx('reveal'); } else if (w) this.app.sfx('rimshot'); else this.app.sfx('wrong');
    this.partyAfterReveal(winners.length ? 12000 : 6000);
  },
};
