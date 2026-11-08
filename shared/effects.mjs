// Light effects shared by the server (real LEDs) and the browser (effect previews).
// Every LED has a position: { x: -1..1 (left..right as seen from the couch), y: 0..1 (bottom..top),
// z: -1..1 (back..front), a: angle around the trunk 0..1, u: 0..1 position along the string }.
// An effect is created per run: makeEffect(id) -> step(ctx) which writes linear 0..1 RGB into ctx.out.

export const EFFECTS = [
  { id: 'classic', name: 'Classic Warm', swatch: ['#ffb45c', '#ffd8a0', '#ff9a3c'] },
  { id: 'retro', name: 'Retro C9', swatch: ['#e8322b', '#2a9d4b', '#2f6fd8', '#f4a21f', '#f3d23c'] },
  { id: 'twinkle', name: 'Twinkle', swatch: ['#ffc77a', '#ffffff', '#ffb35a'] },
  { id: 'candy-cane', name: 'Candy Cane', swatch: ['#e3242b', '#ffffff', '#e3242b'] },
  { id: 'snowfall', name: 'Snowfall', swatch: ['#16305e', '#ffffff', '#9fc4ff'] },
  { id: 'fireplace', name: 'Fireplace', swatch: ['#ff5a12', '#ffb020', '#b81d0c'] },
  { id: 'aurora', name: 'Aurora', swatch: ['#19e3a0', '#1a8fd1', '#7b4bd8'] },
  { id: 'peppermint', name: 'Peppermint Swirl', swatch: ['#ffffff', '#e01e37', '#ffffff'] },
  { id: 'rainbow', name: 'Rainbow Rise', swatch: ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'] },
  { id: 'starlight', name: 'Starlight', swatch: ['#0d1b4a', '#ffd36b', '#ffffff'] },
  { id: 'gingerbread', name: 'Gingerbread', swatch: ['#b8662c', '#ffe9c7', '#7a3b14'] },
  { id: 'frost', name: 'Frost', swatch: ['#bfe8ff', '#ffffff', '#3d8fd6'] },
  { id: 'chase', name: 'Red & Green Chase', swatch: ['#e8322b', '#2a9d4b', '#e8322b'] },
  { id: 'ornaments', name: 'Ornaments', swatch: ['#c81e3a', '#1f7a4d', '#d9a531', '#2456b5'] },
  { id: 'comet', name: 'Comets', swatch: ['#ffffff', '#ffd36b', '#ff6b4a'] },
  { id: 'breathe', name: 'Slow Breath', swatch: ['#ff3b2f', '#7a1410', '#ff3b2f'] },
];
export const SPECIAL = ['solid', 'react', 'show', 'paint', 'off', 'mapping'];

// ---------- helpers ----------
export function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = x => x * x * (3 - 2 * x);
function hash(n) { n = (n << 13) ^ n; return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824; }
function h01(i, j = 0) { return (hash(i * 374761 + j * 668265 + 1013) + 1) / 2; }
function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  return h01(i, seed) * (1 - smooth(f)) + h01(i + 1, seed) * smooth(f);
}
function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
  const a = h01(xi + yi * 57, seed), b = h01(xi + 1 + yi * 57, seed);
  const c = h01(xi + (yi + 1) * 57, seed), d = h01(xi + 1 + (yi + 1) * 57, seed);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function put(out, i, c, k = 1) { out[i * 3] = c[0] * k; out[i * 3 + 1] = c[1] * k; out[i * 3 + 2] = c[2] * k; }
function add(out, i, c, k = 1) {
  out[i * 3] = Math.min(1, out[i * 3] + c[0] * k);
  out[i * 3 + 1] = Math.min(1, out[i * 3 + 1] + c[1] * k);
  out[i * 3 + 2] = Math.min(1, out[i * 3 + 2] + c[2] * k);
}

const WARM = [1, 0.58, 0.22];
const WARM_DIM = [1, 0.45, 0.12];
const RED = [0.92, 0.07, 0.05];
const GREEN = [0.06, 0.62, 0.18];
const GOLD = [1, 0.7, 0.18];
const WHITE = [1, 0.92, 0.8];
const ICE = [0.6, 0.85, 1];
const C9 = [[0.95, 0.08, 0.05], [0.05, 0.6, 0.2], [0.1, 0.3, 0.95], [1, 0.45, 0.04], [1, 0.82, 0.12]];
const JEWELS = [[0.85, 0.05, 0.15], [0.05, 0.55, 0.25], [1, 0.62, 0.1], [0.12, 0.28, 0.85], [0.6, 0.1, 0.7], [1, 0.9, 0.75]];

// ---------- default tree layout: a string spiralled bottom to top around a cone ----------
export function spiralLayout(n, turns = 9) {
  const pos = [];
  for (let i = 0; i < n; i++) {
    const u = n > 1 ? i / (n - 1) : 0;
    const y = 1 - Math.sqrt(1 - u * 0.97);           // more lights near the wide bottom
    const r = 0.95 * (1 - y) + 0.04;
    const a = (y * turns) % 1;
    const ang = a * Math.PI * 2;
    pos.push({ x: r * Math.sin(ang), y, z: r * Math.cos(ang), a, u });
  }
  return pos;
}
// Fill in missing fields for camera-mapped layouts ({x,y} only).
export function normalizeLayout(list) {
  const n = list.length;
  return list.map((p, i) => {
    const y = clamp(p.y ?? 0);
    const r = 0.95 * (1 - y) + 0.04;
    const x = clamp(p.x ?? 0, -1, 1);
    const sinA = clamp(x / r, -1, 1);
    const ang = p.z !== undefined ? Math.atan2(x, p.z) : Math.asin(sinA);
    return { x, y, z: p.z ?? Math.cos(ang) * r, a: (((ang / (Math.PI * 2)) % 1) + 1) % 1, u: n > 1 ? i / (n - 1) : 0, mapped: !!p.mapped };
  });
}

// ---------- effects ----------
const makers = {
  classic() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const s = 0.82 + 0.18 * noise1(t * 0.35 + i * 7.13, i);
        put(out, i, mix(WARM, WARM_DIM, h01(i, 3) * 0.5), s);
      }
    };
  },
  retro() {
    return ({ n, t, out }) => {
      for (let i = 0; i < n; i++) put(out, i, C9[i % C9.length], 0.78 + 0.22 * noise1(t * 0.25 + i * 3.1, i));
    };
  },
  twinkle() {
    return ({ n, t, out }) => {
      for (let i = 0; i < n; i++) {
        const ph = (t * (0.18 + 0.25 * h01(i, 9)) + h01(i, 4)) % 1;
        const spark = ph < 0.12 ? Math.sin((ph / 0.12) * Math.PI) : 0;
        put(out, i, mix(WARM_DIM, WHITE, spark), 0.35 + 0.65 * spark);
      }
    };
  },
  'candy-cane'() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const v = (p.a * 2 + p.y * 3 - t * 0.35) % 1;
        const red = ((v + 1) % 1) < 0.5;
        put(out, i, red ? RED : WHITE, red ? 1 : 0.85);
      }
    };
  },
  snowfall() {
    const flakes = [];
    return ({ n, t, dt, out, pos }) => {
      if (flakes.length < 14) flakes.push({ x: Math.random() * 2 - 1, y: 1.15, v: 0.08 + Math.random() * 0.08, w: Math.random() * 6 });
      for (const f of flakes) { f.y -= f.v * dt; f.x += Math.sin(t * 1.3 + f.w) * 0.05 * dt; }
      for (let k = flakes.length - 1; k >= 0; k--) if (flakes[k].y < -0.15) flakes.splice(k, 1);
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        let b = 0;
        for (const f of flakes) {
          const d2 = (p.x - f.x) ** 2 * 0.6 + (p.y - f.y) ** 2 * 4;
          b = Math.max(b, Math.exp(-d2 * 60));
        }
        put(out, i, mix([0.03, 0.08, 0.28], WHITE, b), 0.55 + 0.45 * b);
      }
    };
  },
  fireplace() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const heat = clamp(noise2(p.x * 3 + 10, p.y * 4 - t * 2.2, 5) * 1.25 - p.y * 0.8 + 0.25);
        const c = heat > 0.66 ? mix(GOLD, [1, 0.9, 0.55], (heat - 0.66) * 3) : heat > 0.33 ? mix([0.95, 0.25, 0.02], GOLD, (heat - 0.33) * 3) : mix([0.25, 0.02, 0], [0.95, 0.25, 0.02], heat * 3);
        put(out, i, c, 0.25 + 0.75 * heat);
      }
    };
  },
  aurora() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const w = noise2(p.x * 1.6 + t * 0.12, p.y * 2.2 - t * 0.05, 2);
        const band = Math.sin((p.y * 5 + w * 4 - t * 0.3) * Math.PI) * 0.5 + 0.5;
        const c = mix(mix([0.05, 0.9, 0.55], [0.07, 0.45, 0.9], w), [0.5, 0.2, 0.9], clamp(p.y * 1.2 - 0.2) * band);
        put(out, i, c, 0.2 + 0.8 * band);
      }
    };
  },
  peppermint() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const v = (((p.a * 4 - p.y * 1.5 + t * 0.5) % 1) + 1) % 1;
        const k = Math.sin(v * Math.PI * 2) * 0.5 + 0.5;
        put(out, i, mix(WHITE, [0.95, 0.05, 0.15], smooth(k)));
      }
    };
  },
  rainbow() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) put(out, i, hsv(pos[i].y * 0.9 - t * 0.12 + pos[i].a * 0.15, 0.9, 1));
    };
  },
  starlight() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const top = clamp((p.y - 0.84) * 7);
        const ph = (t * (0.1 + 0.2 * h01(i, 1)) + h01(i, 2)) % 1;
        const spark = ph < 0.08 ? Math.sin((ph / 0.08) * Math.PI) : 0;
        let c = mix([0.04, 0.08, 0.35], [0.12, 0.2, 0.6], noise1(t * 0.2 + i, 7));
        c = mix(c, WHITE, spark);
        c = mix(c, GOLD, top);
        put(out, i, c, top > 0 ? 0.7 + 0.3 * Math.sin(t * 2) * top : 0.45 + 0.55 * spark);
      }
    };
  },
  gingerbread() {
    return ({ n, t, out, pos }) => {
      const cols = [[0.75, 0.32, 0.08], [1, 0.62, 0.3], [0.5, 0.16, 0.03]];
      for (let i = 0; i < n; i++) {
        const base = cols[i % 3];
        const ph = (t * 0.3 + h01(i, 8)) % 1;
        const sugar = ph < 0.05 ? Math.sin((ph / 0.05) * Math.PI) : 0;
        put(out, i, mix(base, [1, 0.95, 0.85], sugar), 0.7 + 0.3 * sugar);
      }
    };
  },
  frost() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const sweep = Math.exp(-(((p.x * 0.7 + p.y - (t * 0.25) % 2.4 + 0.6) * 3) ** 2));
        const shimmer = noise1(t * 0.8 + i * 5.7, i);
        put(out, i, mix(mix([0.1, 0.35, 0.8], ICE, shimmer), WHITE, sweep), 0.45 + 0.35 * shimmer + 0.2 * sweep);
      }
    };
  },
  chase() {
    return ({ n, t, out, pos }) => {
      for (let i = 0; i < n; i++) {
        const v = (((pos[i].u * 24 - t * 2.2) % 2) + 2) % 2;
        const which = v < 1 ? RED : GREEN;
        const e = Math.sin((v % 1) * Math.PI);
        put(out, i, which, 0.25 + 0.75 * e);
      }
    };
  },
  ornaments() {
    let state = null;
    return ({ n, t, dt, out }) => {
      if (!state || state.length !== n) state = Array.from({ length: n }, () => ({ c: JEWELS[Math.floor(Math.random() * JEWELS.length)], next: Math.random() * 6 }));
      for (let i = 0; i < n; i++) {
        const s = state[i];
        s.next -= dt;
        if (s.next < 0) { s.c = JEWELS[Math.floor(Math.random() * JEWELS.length)]; s.next = 3 + Math.random() * 8; s.pop = 1; }
        s.pop = Math.max(0, (s.pop || 0) - dt * 1.5);
        put(out, i, mix(s.c, WHITE, s.pop * 0.6), 0.75 + 0.25 * s.pop);
      }
    };
  },
  comet() {
    const comets = [];
    let spawn = 0;
    return ({ n, t, dt, out, pos }) => {
      spawn -= dt;
      if (spawn < 0) { comets.push({ u: -0.05, v: 0.12 + Math.random() * 0.1, c: [WHITE, GOLD, [1, 0.35, 0.25], ICE][Math.floor(Math.random() * 4)] }); spawn = 1.2 + Math.random() * 1.5; }
      for (const c of comets) c.u += c.v * dt;
      for (let k = comets.length - 1; k >= 0; k--) if (comets[k].u > 1.4) comets.splice(k, 1);
      for (let i = 0; i < n; i++) {
        put(out, i, [0.06, 0.03, 0.01]);
        for (const c of comets) {
          const d = c.u - pos[i].u;
          if (d >= 0 && d < 0.18) add(out, i, c.c, Math.pow(1 - d / 0.18, 2.2));
        }
      }
    };
  },
  breathe() {
    return ({ n, t, out, params }) => {
      const c = hexToRgb(params.color || '#ff3b2f');
      const k = 0.15 + 0.85 * smooth((Math.sin(t * 0.9) + 1) / 2);
      for (let i = 0; i < n; i++) put(out, i, c, k);
    };
  },
  solid() {
    return ({ n, out, params }) => {
      const c = hexToRgb(params.color || '#ffb45c');
      for (let i = 0; i < n; i++) put(out, i, c);
    };
  },
  off() { return ({ n, out }) => { for (let i = 0; i < n * 3; i++) out[i] = 0; }; },
  // Music from a microphone or the radio: bass fills the tree from the bottom, highs sparkle at the top,
  // every detected beat throws a ring of colour up the tree.
  react() {
    const rings = [];
    let hue = 0;
    return ({ n, t, dt, out, pos, audio }) => {
      const a = audio || {};
      if (a.beat) { hue = (hue + 0.13) % 1; rings.push({ y: 0, c: hsv(hue, 0.85, 1) }); a.beat = 0; }
      for (const r of rings) r.y += dt * 1.6;
      for (let k = rings.length - 1; k >= 0; k--) if (rings[k].y > 1.4) rings.splice(k, 1);
      const bass = clamp(a.bass || 0), high = clamp(a.high || 0), level = clamp(a.level || 0);
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const fill = clamp((bass * 1.1 - p.y) * 4);
        let c = mix([0.02, 0.05, 0.02], [0.05, 0.6, 0.18], fill * 0.6 + level * 0.2);
        for (const r of rings) { const d = Math.abs(p.y - r.y); if (d < 0.12) c = mix(c, r.c, 1 - d / 0.12); }
        const sp = h01(i, Math.floor(t * 12)) > 1 - high * 0.25 && p.y > 0.4 ? 1 : 0;
        c = mix(c, WHITE, sp);
        put(out, i, c, 0.3 + 0.7 * Math.max(fill, level, sp));
      }
    };
  },
  // Choreographed from the song being played, note by note:
  //  - every melody note lands at a spot that spirals up the tree (height = pitch) and throws a ring of light
  //  - the sounding note glows at its spot, leaving a fading trail
  //  - the chord colours the whole tree; a chord change sweeps the new colour up from the bottom
  //  - downbeats sparkle; the count-in pulses gold; the last bars rise in a rainbow with sparkles
  show() {
    const trails = new Float32Array(1024 * 3);
    const spark = new Float32Array(1024);
    const ripples = [];
    let lastNote = -1, lastChord = -1, lastBeat = -999, wipe = null, songKey = '';
    const noteColor = mood => (mood === 'gentle' ? GOLD : mood === 'mysterious' ? ICE : mood === 'grand' ? WHITE : [1, 0.92, 0.75]);
    const spot = (idx, y) => { const a = (idx * 0.137) % 1, r = 0.95 * (1 - y) + 0.04; return { x: r * Math.sin(a * Math.PI * 2), y, z: r * Math.cos(a * Math.PI * 2) }; };
    return ({ n, t, dt, out, pos, note }) => {
      const s = note || {};
      const key = `${s.mood}`;
      if (key !== songKey || (s.sec ?? 0) < 0 && lastNote > 0) { songKey = key; lastNote = -1; lastChord = -1; ripples.length = 0; }
      const decay = Math.exp(-dt * 2.6), sdecay = Math.exp(-dt * 4);
      for (let i = 0; i < n * 3; i++) trails[i] *= decay;
      for (let i = 0; i < n; i++) spark[i] *= sdecay;
      // events
      if (s.noteIdx >= 0 && s.noteIdx !== lastNote) {
        lastNote = s.noteIdx;
        const p = spot(s.noteIdx, s.pitch01);
        ripples.push({ ...p, t0: t, c: noteColor(s.mood), big: s.downbeat });
        if (ripples.length > 10) ripples.shift();
      }
      if (s.chordIdx >= 0 && s.chordIdx !== lastChord) { if (lastChord !== -1) wipe = { t0: t, hue: s.chordHue }; lastChord = s.chordIdx; }
      if (s.beat !== lastBeat) {
        lastBeat = s.beat;
        const dens = s.countIn ? 0 : s.finale ? 0.2 : s.downbeat ? 0.07 : 0.025;
        for (let i = 0; i < n; i++) if (Math.random() < dens) spark[i] = 1;
      }
      const base = hsv(s.chordHue ?? 0.33, 0.85, 1);
      const bp = Math.pow(1 - (s.beatPhase ?? 1), 3) * (s.downbeat ? 1 : 0.55);
      const level = s.countIn ? 0.08 : 0.3 + 0.25 * bp;
      const head = s.active ? spot(s.noteIdx, s.pitch01) : null;
      const nc = noteColor(s.mood);
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        let c = [base[0] * level, base[1] * level, base[2] * level];
        if (s.countIn) { const k = clamp(1 - p.y * 1.4) * Math.pow(1 - (s.beatPhase ?? 1), 2); c = mix(c, GOLD, k * 0.8); }
        if (wipe) {
          const age = t - wipe.t0, front = age / 0.45;
          if (age < 1.2 && p.y < front) { const wc = hsv(wipe.hue, 0.8, 1); c = mix(c, wc, (1 - age / 1.2) * 0.55 * clamp((front - p.y) * 4)); }
        }
        // the sounding note: a bright spot with a trail
        if (head) {
          const d = Math.hypot(p.x - head.x, (p.y - head.y) * 1.6, (p.z - head.z) * 0.6);
          const k = clamp(1 - d / 0.16) * s.vel;
          if (k > 0) { trails[i * 3] = Math.max(trails[i * 3], nc[0] * k); trails[i * 3 + 1] = Math.max(trails[i * 3 + 1], nc[1] * k); trails[i * 3 + 2] = Math.max(trails[i * 3 + 2], nc[2] * k); }
        }
        // rings of light from each note
        for (const r of ripples) {
          const age = t - r.t0; if (age > 0.9) continue;
          const rad = age * (r.big ? 1.3 : 0.9);
          const d = Math.hypot(p.x - r.x, (p.y - r.y) * 1.5);
          const k = clamp(1 - Math.abs(d - rad) / 0.09) * (1 - age / 0.9) * 0.7;
          if (k > 0) c = mix(c, r.c, k);
        }
        c = [Math.min(1, c[0] + trails[i * 3]), Math.min(1, c[1] + trails[i * 3 + 1]), Math.min(1, c[2] + trails[i * 3 + 2])];
        if (s.finale) c = mix(c, hsv(p.y * 0.8 - t * 0.35, 0.9, 1), clamp((s.progress - 0.9) * 10) * 0.6);
        if (spark[i] > 0.02) c = mix(c, s.finale ? hsv(h01(i, 9), 0.5, 1) : WHITE, spark[i]);
        put(out, i, c);
      }
    };
  },
  paint() {
    return ({ n, out, paint }) => {
      for (let i = 0; i < n; i++) {
        const c = paint && paint[i] ? paint[i] : [0.02, 0.02, 0.02];
        put(out, i, c);
      }
    };
  },
  mapping() {
    return ({ n, out, params }) => {
      for (let i = 0; i < n * 3; i++) out[i] = 0;
      const k = params.mapIndex ?? -1;
      if (k >= 0 && k < n) put(out, k, [1, 1, 1]);
    };
  },
};

export function makeEffect(id) {
  const m = makers[id] || makers.classic;
  return m();
}
export const hasEffect = id => !!makers[id];

// ---------- overlays (games, buzzers, votes) applied on top of the effect ----------
// overlay = { kind:'flash'|'burst'|'split'|'sweep'|'wipe', color, color2, start (s), dur (s), value }
export function applyOverlays(overlays, { n, t, out, pos }) {
  for (const o of overlays) {
    const age = t - o.start;
    if (age < 0) continue;
    const k = o.dur ? clamp(age / o.dur) : 0;
    const c = hexToRgb(o.color);
    if (o.kind === 'flash') {
      const a = (1 - k) * (age < 0.08 ? age / 0.08 : 1);
      for (let i = 0; i < n; i++) {
        out[i * 3] += (c[0] - out[i * 3]) * a; out[i * 3 + 1] += (c[1] - out[i * 3 + 1]) * a; out[i * 3 + 2] += (c[2] - out[i * 3 + 2]) * a;
      }
    } else if (o.kind === 'burst') {
      const r = k * 1.6;
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const d = Math.hypot(p.x * 0.8, p.y - 0.55);
        const ring = clamp(1 - Math.abs(d - r) / 0.15) * (1 - k);
        const sp = h01(i, Math.floor(t * 14)) > 0.8 ? (1 - k) : 0;
        const cc = sp ? hsv(h01(i, 5), 0.6, 1) : c;
        const a = Math.max(ring, sp * 0.8);
        out[i * 3] += (cc[0] - out[i * 3]) * a; out[i * 3 + 1] += (cc[1] - out[i * 3 + 1]) * a; out[i * 3 + 2] += (cc[2] - out[i * 3 + 2]) * a;
      }
    } else if (o.kind === 'split') {
      // value = share for color (left), rest color2 (right); bars grow in from the bottom.
      const c2 = hexToRgb(o.color2 || '#2a9d4b');
      const grow = clamp(age / 0.8);
      const cut = (o.value ?? 0.5) * 2 - 1;
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        if (p.y > grow) continue;
        const cc = p.x < cut ? c : c2;
        out[i * 3] = cc[0]; out[i * 3 + 1] = cc[1]; out[i * 3 + 2] = cc[2];
      }
    } else if (o.kind === 'sweep') {
      // a scanning line bottom->top->bottom (Nice List scanner, mapping hints)
      const y = 0.5 - 0.55 * Math.cos(age * 2.4);
      for (let i = 0; i < n; i++) {
        const a = clamp(1 - Math.abs(pos[i].y - y) / 0.07);
        out[i * 3] += (c[0] - out[i * 3]) * a; out[i * 3 + 1] += (c[1] - out[i * 3 + 1]) * a; out[i * 3 + 2] += (c[2] - out[i * 3 + 2]) * a;
      }
    } else if (o.kind === 'wipe') {
      // fill from bottom to top over dur, then hold
      for (let i = 0; i < n; i++) {
        if (pos[i].y > k * 1.05) continue;
        out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
      }
    } else if (o.kind === 'dim') {
      const a = clamp(o.value ?? 0.2);
      for (let i = 0; i < n * 3; i++) out[i] *= a;
    }
  }
}
