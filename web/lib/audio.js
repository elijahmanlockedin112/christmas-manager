// All sound for North Pole Control, synthesized live (no audio files):
// carol arrangements that follow the server clock, game sound effects, a fireplace crackle,
// plus the radio player and a microphone listener that feed the tree's music-reactive mode.

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Sound {
  // latencyHint: seconds of output buffer. The Pi's TV uses a big one (0.15) so busy graphics can't
  // starve the audio; playSong schedules that much earlier, so the music stays on the server clock.
  constructor({ latencyHint = 'playback', lookahead = 0.4 } = {}) {
    this.ctx = null;
    this.player = null;
    this.crackle = null;
    this.latencyHint = latencyHint;
    this.lookahead = lookahead;
  }
  get ready() { return !!this.ctx && this.ctx.state === 'running'; }
  // seconds between scheduling a sound and hearing it
  get outLatency() { return this.ctx ? (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) : 0; }
  init() {
    if (this.ctx) return this.ctx;
    const C = window.AudioContext || window.webkitAudioContext;
    const ctx = new C({ latencyHint: this.latencyHint });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    // small hall reverb from generated noise
    this.verb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    this.verb.buffer = ir;
    this.verbIn = ctx.createGain(); this.verbIn.gain.value = 0.32;
    this.verbIn.connect(this.verb); this.verb.connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return ctx;
  }
  async unlock() { this.init(); if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { } } return this.ready; }
  bus(level = 1) { const g = this.ctx.createGain(); g.gain.value = level; g.connect(this.master); g.connect(this.verbIn); return g; }

  // ---------- instruments: each schedules one note at ctx time t ----------
  env(g, t, a, peak, decay, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.3), t + a + decay);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
  }
  celesta(out, m, t, dur, v = 0.6) {
    const c = this.ctx, f = mtof(m), end = t + Math.min(2.4, dur + 1.1);
    for (const [ratio, amp, dec] of [[1, 1, 0.9], [2, 0.35, 0.35], [4.01, 0.12, 0.12]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f * ratio;
      this.env(g, t, 0.004, v * amp * 0.32, dec, end);
      o.connect(g); g.connect(out); o.start(t); o.stop(end + 0.05);
    }
  }
  bell(out, m, t, dur, v = 0.6) {
    const c = this.ctx, f = mtof(m), end = t + Math.min(3, dur + 1.6);
    const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain();
    car.frequency.value = f; mod.frequency.value = f * 3.5;
    mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 1.2);
    mod.connect(mg); mg.connect(car.frequency);
    this.env(g, t, 0.003, v * 0.22, 0.5, end);
    car.connect(g); g.connect(out);
    car.start(t); mod.start(t); car.stop(end + 0.05); mod.stop(end + 0.05);
  }
  brass(out, m, t, dur, v = 0.6) {
    const c = this.ctx, f = mtof(m), end = t + dur + 0.18;
    const flt = c.createBiquadFilter(), g = c.createGain();
    flt.type = 'lowpass'; flt.Q.value = 1.2;
    flt.frequency.setValueAtTime(500, t); flt.frequency.linearRampToValueAtTime(2600 + v * 1500, t + 0.07); flt.frequency.exponentialRampToValueAtTime(1300, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.13, t + 0.05);
    g.gain.setValueAtTime(v * 0.11, t + Math.max(0.06, dur - 0.05)); g.gain.exponentialRampToValueAtTime(0.0001, end);
    for (const d of [-6, 5]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; o.connect(flt); o.start(t); o.stop(end + 0.05); }
    flt.connect(g); g.connect(out);
  }
  pad(out, freqs, t, dur, v = 0.5) {
    const c = this.ctx, end = t + dur + 0.7;
    const flt = c.createBiquadFilter(), g = c.createGain();
    flt.type = 'lowpass'; flt.frequency.value = 1100;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v * 0.05, t + 0.35);
    g.gain.setValueAtTime(v * 0.05, t + dur); g.gain.exponentialRampToValueAtTime(0.0001, end);
    for (const f of freqs) for (const d of [-9, 8]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; o.connect(flt); o.start(t); o.stop(end + 0.05); }
    flt.connect(g); g.connect(out);
  }
  pluck(out, m, t, v = 0.5) {
    const c = this.ctx, end = t + 0.6;
    const o = c.createOscillator(), g = c.createGain(), flt = c.createBiquadFilter();
    o.type = 'triangle'; o.frequency.value = mtof(m);
    flt.type = 'lowpass'; flt.frequency.setValueAtTime(3200, t); flt.frequency.exponentialRampToValueAtTime(600, t + 0.3);
    this.env(g, t, 0.003, v * 0.16, 0.12, end);
    o.connect(flt); flt.connect(g); g.connect(out); o.start(t); o.stop(end + 0.05);
  }
  bass(out, m, t, dur, v = 0.6) {
    const c = this.ctx, end = t + Math.min(dur, 1.2) + 0.1;
    const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o2.type = 'triangle'; o.frequency.value = mtof(m); o2.frequency.value = mtof(m + 12);
    const g2 = c.createGain(); g2.gain.value = 0.25;
    this.env(g, t, 0.01, v * 0.4, 0.4, end);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.master);
    o.start(t); o2.start(t); o.stop(end + 0.05); o2.stop(end + 0.05);
  }
  sleigh(out, t, v = 0.5, shakes = 1) {
    const c = this.ctx;
    for (let s = 0; s < shakes; s++) {
      const tt = t + s * 0.045;
      const src = c.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 1 + Math.random() * 0.2;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7800 + Math.random() * 1500; bp.Q.value = 2.2;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, tt); g.gain.exponentialRampToValueAtTime(v * 0.35 * (s ? 0.6 : 1), tt + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.16);
      src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(out);
      src.start(tt, Math.random()); src.stop(tt + 0.2);
    }
  }
  kick(out, t, v = 0.6) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    g.gain.setValueAtTime(v * 0.7, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.4);
  }
  snare(out, t, v = 0.4, len = 0.12) {
    const c = this.ctx, src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.6;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f); f.connect(g); g.connect(out); src.start(t, Math.random()); src.stop(t + len + 0.02);
  }

  // ---------- carols ----------
  // net.now() is the server clock; show = state.show from the server.
  playSong(song, tl, show, net, { latency = 0 } = {}) {
    this.stopSong();
    if (!this.ctx) return;
    const out = this.bus(0.9);
    const mood = song.mood || 'bright';
    const p = { song, tl, show, out, ni: 0, ci: 0, beat: Math.floor(-tl.lead / tl.spb) - 1, timer: null, done: false };
    const lookahead = this.lookahead;
    const songSec = () => (net.now() - show.startAt) / 1000 - tl.lead;
    const toCtx = s => this.ctx.currentTime + (s - songSec()) - latency / 1000 - this.outLatency;
    const tick = () => {
      if (p.done) return;
      const now = songSec();
      const until = now + lookahead;
      // melody
      while (p.ni < tl.notes.length && tl.notes[p.ni].t < until) {
        const n = tl.notes[p.ni++];
        if (n.t < now - 0.05) continue;
        const t = toCtx(n.t), v = 0.75;
        if (mood === 'grand') { this.brass(out, n.midi, t, n.dur * 0.95, v); this.bell(out, n.midi + 12, t, n.dur, 0.25); }
        else if (mood === 'bright') { this.bell(out, n.midi, t, n.dur, 0.55); this.celesta(out, n.midi, t, n.dur, 0.7); }
        else if (mood === 'mysterious') { this.celesta(out, n.midi + 12, t, n.dur, 0.85); }
        else this.celesta(out, n.midi, t, n.dur, 0.85);
      }
      // chords
      while (p.ci < tl.chords.length && tl.chords[p.ci].t < until) {
        const ch = tl.chords[p.ci++];
        if (ch.t + ch.dur < now) continue;
        const start = Math.max(ch.t, now);
        const t = toCtx(start), dur = ch.t + ch.dur - start;
        const root = 48 + ch.root;
        const freqs = ch.tones.map(x => mtof(root + 12 + x));
        if (mood === 'gentle' || mood === 'grand') this.pad(out, freqs, t, dur, mood === 'grand' ? 0.8 : 0.6);
        this.bass(out, 36 + ch.bass, t, dur, 0.55);
        if (mood === 'bright' || mood === 'mysterious') {
          const step = tl.spb / 2;
          const tones = ch.tones.map(x => root + 12 + x);
          for (let k = 0; k * step < dur - 0.01; k++) this.pluck(out, tones[k % tones.length] + (k % 4 === 3 ? 12 : 0), t + k * step, mood === 'mysterious' ? 0.5 : 0.35);
        }
      }
      // percussion on the beat grid (includes the count-in)
      while ((p.beat + 1) * tl.spb < until) {
        p.beat++;
        const bt = p.beat * tl.spb;
        if (bt < now - 0.05 || bt > tl.total + 0.01) continue;
        const t = toCtx(bt);
        const downbeat = ((p.beat % tl.meter) + tl.meter) % tl.meter === 0;
        if (p.beat < 0) { this.sleigh(out, t, 0.5, downbeat ? 3 : 1); continue; }
        if (mood === 'bright') { this.sleigh(out, t, 0.45, 2); this.sleigh(out, t + tl.spb / 2, 0.25, 1); if (downbeat) this.kick(out, t, 0.5); else if (tl.meter === 4 && p.beat % 2 === 1) this.snare(out, t, 0.12); }
        else if (mood === 'grand') { if (downbeat) this.kick(out, t, 0.6); }
        else if (mood === 'mysterious') { this.sleigh(out, t, 0.18, 1); }
        else if (downbeat) this.bell(out, 84 + (tl.chords.find(c => c.t <= bt && c.t + c.dur > bt)?.root ?? 0), t, 1, 0.08);
      }
      if (now > tl.total + 3) p.done = true;
    };
    tick();
    p.timer = setInterval(tick, 40);
    this.player = p;
  }
  stopSong(fade = 0.25) {
    const p = this.player;
    if (!p) return;
    p.done = true;
    clearInterval(p.timer);
    try { p.out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3); setTimeout(() => p.out.disconnect(), fade * 1000 + 300); } catch { }
    this.player = null;
  }

  // ---------- sound effects ----------
  sfx(name) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + 0.02, out = this.bus(0.9);
    const arp = (notes, step, fn = 'bell', v = 0.6) => notes.forEach((m, i) => this[fn](out, m, t + i * step, step * 2, v));
    if (name === 'drumroll') { for (let i = 0; i < 44; i++) this.snare(out, t + i * 0.06 + Math.random() * 0.01, 0.06 + i * 0.006, 0.08); }
    else if (name === 'rimshot') { this.snare(out, t, 0.5, 0.1); this.kick(out, t + 0.16, 0.5); this.snare(out, t + 0.36, 0.45, 0.08); const s = c.createBufferSource(); s.buffer = this.noise; const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000; const g = c.createGain(); g.gain.setValueAtTime(0.35, t + 0.36); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6); s.connect(f); f.connect(g); g.connect(out); s.start(t + 0.36); s.stop(t + 1.7); }
    else if (name === 'buzz') { const o = c.createOscillator(), g = c.createGain(); o.type = 'square'; o.frequency.value = 155; g.gain.setValueAtTime(0.12, t); g.gain.setValueAtTime(0.12, t + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55); o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.6); }
    else if (name === 'correct') arp([72, 76, 79, 84], 0.09, 'bell', 0.8);
    else if (name === 'wrong') { this.brass(out, 52, t, 0.3, 0.5); this.brass(out, 47, t + 0.32, 0.6, 0.5); }
    else if (name === 'question') arp([79, 84], 0.12, 'celesta', 0.8);
    else if (name === 'reveal') { arp([84, 88, 91, 96], 0.06, 'celesta', 0.7); this.sleigh(out, t, 0.4, 3); }
    else if (name === 'fanfare') { [[60, 0, 0.18], [64, 0.2, 0.18], [67, 0.4, 0.18], [72, 0.6, 0.9]].forEach(([m, d, l]) => { this.brass(out, m, t + d, l, 0.8); this.brass(out, m - 12, t + d, l, 0.5); }); this.sleigh(out, t + 0.6, 0.6, 4); }
    else if (name === 'scan') { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(400, t); for (let i = 0; i < 12; i++) o.frequency.linearRampToValueAtTime(i % 2 ? 420 : 1300, t + 0.45 * (i + 1)); g.gain.value = 0.05; o.connect(g); g.connect(out); o.start(t); o.stop(t + 5.5); }
    else if (name === 'nice') { arp([72, 76, 79, 84, 88], 0.08, 'bell', 0.9); this.sleigh(out, t + 0.4, 0.6, 5); }
    else if (name === 'chime') arp([84], 0.2, 'bell', 0.6);
    else if (name === 'tick') this.pluck(out, 96, t, 0.55); // last seconds of a hot-seat timer
    else if (name === 'tock') this.pluck(out, 91, t, 0.5);
    setTimeout(() => out.disconnect(), 6000);
  }

  // ---------- fireplace ----------
  startCrackle() {
    if (!this.ready || this.crackle) return;
    const c = this.ctx, out = c.createGain(); out.gain.value = 0.5; out.connect(this.master);
    const rumble = c.createBufferSource(); rumble.buffer = this.noise; rumble.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const rg = c.createGain(); rg.gain.value = 0.05;
    rumble.connect(lp); lp.connect(rg); rg.connect(out); rumble.start();
    const timer = setInterval(() => {
      const t = c.currentTime;
      for (let i = 0; i < 4; i++) if (Math.random() < 0.45) {
        const tt = t + Math.random() * 0.25, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
        s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 1500 + Math.random() * 4500; f.Q.value = 1;
        const v = Math.random() < 0.1 ? 0.6 : 0.12 + Math.random() * 0.2;
        g.gain.setValueAtTime(v, tt); g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.01 + Math.random() * 0.04);
        s.connect(f); f.connect(g); g.connect(out); s.start(tt, Math.random()); s.stop(tt + 0.08);
      }
    }, 250);
    this.crackle = { out, rumble, timer };
  }
  stopCrackle() {
    const k = this.crackle; if (!k) return;
    clearInterval(k.timer); try { k.rumble.stop(); k.out.disconnect(); } catch { }
    this.crackle = null;
  }
}

// Turns any audio node into bass/mid/high levels and beats (for the tree's music-reactive mode).
export class Listener {
  constructor(ctx, source, onLevels) {
    this.an = ctx.createAnalyser();
    this.an.fftSize = 1024; this.an.smoothingTimeConstant = 0.55;
    source.connect(this.an);
    this.bins = new Uint8Array(this.an.frequencyBinCount);
    this.hz = ctx.sampleRate / this.an.fftSize;
    this.max = { bass: 30, mid: 30, high: 30 };
    this.hist = [];
    this.lastBeat = 0;
    this.onLevels = onLevels;
    this.timer = setInterval(() => this.step(), 33);
  }
  band(a, b) { let s = 0, n = 0; for (let i = Math.floor(a / this.hz); i <= Math.min(this.bins.length - 1, Math.ceil(b / this.hz)); i++) { s += this.bins[i]; n++; } return n ? s / n : 0; }
  step() {
    this.an.getByteFrequencyData(this.bins);
    const raw = { bass: this.band(30, 160), mid: this.band(300, 2000), high: this.band(4000, 11000) };
    const lv = {};
    for (const k of Object.keys(raw)) { this.max[k] = Math.max(raw[k], this.max[k] * 0.995, 20); lv[k] = Math.pow(raw[k] / this.max[k], 1.6); }
    this.hist.push(raw.bass); if (this.hist.length > 30) this.hist.shift();
    const avg = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
    const now = performance.now();
    let beat = false;
    if (raw.bass > avg * 1.22 && raw.bass > this.max.bass * 0.55 && now - this.lastBeat > 280) { beat = true; this.lastBeat = now; }
    this.onLevels({ bass: lv.bass, mid: lv.mid, high: lv.high, level: (lv.bass + lv.mid + lv.high) / 3, beat, bins: this.bins });
  }
  stop() { clearInterval(this.timer); try { this.an.disconnect(); } catch { } }
}
