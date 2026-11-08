// The light engine: runs the current effect at 40 fps, crossfades between effects, adds game overlays,
// and sends frames to every output (Pi pixel daemon, WLED, the old beat-lights relay) and to screens.
import dgram from 'node:dgram';
import { makeEffect, applyOverlays, spiralLayout, normalizeLayout, hexToRgb } from '../shared/effects.mjs';

const FPS = 40;
const SCREEN_FPS = 25;

export class Lights {
  constructor(app) {
    this.app = app;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', e => app.log('udp', e.message));
    this.t0 = Date.now();
    this.overlays = [];
    this.audio = { bass: 0, mid: 0, high: 0, level: 0, beat: 0, at: 0 };
    this.cueProvider = null; // () => cue for the 'show' effect
    this.paint = [];
    this.frameListeners = new Set();
    this.mapIndex = -1;
    this.stats = { fps: 0, sent: 0 };
    this.layout = [];
    this.applyLayout();
    this.current = { id: null, fn: null };
    this.prev = null; // { fn, start, dur }
    // (this.out / this.tmp are sized by applyLayout above; don't reset them here)
    this.lastScreen = 0;
    this.lastLevel = 0;
    this.timer = setInterval(() => this.tick(), 1000 / FPS);
  }
  get cfg() { return this.app.config.hw; }
  get st() { return this.app.state.lights; }
  now() { return (Date.now() - this.t0) / 1000; }

  applyLayout() {
    const n = Math.max(1, Math.min(1000, this.cfg.count | 0));
    const mapped = Array.isArray(this.cfg.layout) && this.cfg.layout.length === n;
    this.layout = mapped ? normalizeLayout(this.cfg.layout) : spiralLayout(n, this.cfg.turns || 9);
    this.paint = new Array(n).fill(null);
    this.out = new Float32Array(n * 3);
    this.tmp = new Float32Array(n * 3);
  }

  effectId() {
    if (this.mapIndex >= 0) return 'mapping';
    if (!this.st.power) return 'off';
    return this.st.effect;
  }

  overlay(o) {
    const start = this.now();
    this.overlays.push({ ...o, start });
    if (this.overlays.length > 12) this.overlays.shift();
  }
  clearOverlays(kind) { this.overlays = kind ? this.overlays.filter(o => o.kind !== kind) : []; }

  tick() {
    const t = this.now();
    const dt = 1 / FPS;
    const n = this.layout.length;
    const id = this.effectId();
    if (id !== this.current.id) {
      if (this.current.fn) this.prev = { fn: this.current.fn, start: t, dur: id === 'mapping' || this.current.id === 'mapping' ? 0.01 : 0.9 };
      this.current = { id, fn: makeEffect(id) };
    }
    const audio = this.audio;
    if (Date.now() - audio.at > 1500) { audio.bass *= 0.9; audio.mid *= 0.9; audio.high *= 0.9; audio.level *= 0.9; }
    const ctx = {
      n, t, dt, pos: this.layout, out: this.out, audio,
      note: this.cueProvider ? this.cueProvider() : null,
      paint: this.paint,
      params: { color: this.st.color, speed: this.st.speed, mapIndex: this.mapIndex },
    };
    try { this.current.fn(ctx); } catch (e) { this.app.log('effect', id, e.message); }
    if (this.prev) {
      const k = (t - this.prev.start) / this.prev.dur;
      if (k >= 1) this.prev = null;
      else {
        try { this.prev.fn({ ...ctx, out: this.tmp }); } catch { }
        for (let i = 0; i < n * 3; i++) this.out[i] = this.tmp[i] + (this.out[i] - this.tmp[i]) * k;
      }
    }
    this.overlays = this.overlays.filter(o => !o.dur || t - o.start < o.dur + (o.hold || 0));
    if (this.mapIndex < 0) applyOverlays(this.overlays, ctx);
    const bri = this.mapIndex >= 0 ? 1 : Math.max(0, Math.min(1, this.st.brightness ?? 0.8));
    const bytes = Buffer.allocUnsafe(n * 3);
    let sum = 0;
    for (let i = 0; i < n * 3; i++) {
      const v = Math.max(0, Math.min(1, this.out[i] * bri));
      bytes[i] = Math.round(v * 255);
      sum += v;
    }
    this.send(bytes, sum / (n * 3));
    if (Date.now() - this.lastScreen >= 1000 / SCREEN_FPS - 2) {
      this.lastScreen = Date.now();
      for (const fn of this.frameListeners) fn(bytes);
    }
  }

  send(bytes, level) {
    const outs = this.cfg.outputs || [];
    for (const o of outs) {
      if (!o.on || !o.host) continue;
      try {
        if (o.type === 'pixels') {
          const head = Buffer.from([0x58, 0x4d, 1, (bytes.length / 3) >> 8, (bytes.length / 3) & 255]);
          this.sock.send(Buffer.concat([head, bytes]), o.port || 47926, o.host);
        } else if (o.type === 'wled') {
          const max = Math.min(bytes.length, 490 * 3);
          this.sock.send(Buffer.concat([Buffer.from([2, 2]), bytes.subarray(0, max)]), o.port || 21324, o.host);
        } else if (o.type === 'beat') {
          // Plain (single-colour) string lights on the beat-lights Arduino: send overall brightness 0-255.
          const v = Math.round(Math.min(1, level * 2.2) * 255);
          if (Math.abs(v - this.lastLevel) >= 1) this.sock.send(Buffer.from(`${v}\n`), o.port || 47961, o.host);
          this.lastLevel = v;
        }
      } catch (e) { /* host unresolved etc. */ }
    }
  }

  setAudio(a) {
    const au = this.audio;
    au.bass = +a.bass || 0; au.mid = +a.mid || 0; au.high = +a.high || 0; au.level = +a.level || 0;
    if (a.beat) au.beat = 1;
    au.at = Date.now();
  }

  // Pencil strokes from the iPad: points in tree space (x -1..1, y 0..1) colour every LED within radius.
  paintStroke(points, color, radius = 0.09, erase = false) {
    const c = erase ? null : hexToRgb(color);
    for (const p of points) {
      for (let i = 0; i < this.layout.length; i++) {
        const L = this.layout[i];
        if (L.z < -0.35 && !L.mapped) continue; // back of the tree isn't visible from the front
        const d = Math.hypot(L.x - p.x, (L.y - p.y) * 1.4);
        if (d < radius) this.paint[i] = c;
      }
    }
  }
  paintFill(color) { const c = color ? hexToRgb(color) : null; this.paint = this.paint.map(() => c); }

  stop() { clearInterval(this.timer); try { this.sock.close(); } catch { } }
}
