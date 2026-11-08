// Glow sprites, one per quantized colour, drawn once and reused (a Raspberry Pi can't afford a new
// radial gradient for every bulb on every frame).
const HALOS = new Map();
export function halo(r, g, b) {
  const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  let c = HALOS.get(key);
  if (c) return c;
  const R = ((key >> 8) & 15) * 17, G = ((key >> 4) & 15) * 17, B = (key & 15) * 17;
  c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${R},${G},${B},0.55)`); gr.addColorStop(0.35, `rgba(${R},${G},${B},0.16)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  if (HALOS.size > 1500) HALOS.clear();
  HALOS.set(key, c);
  return c;
}

// Draws the living tree: a painted fir silhouette with every real LED at its real position,
// lit with the exact colours the server is sending to the strip.
export class TreeView {
  constructor(canvas, { interactive = false, star = true, floor = true } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.layout = [];
    this.colors = new Uint8Array(0);
    this.star = star;
    this.floor = floor;
    this.bg = null;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.raf = null;
    this.dirty = true;
    const loop = () => { if (this.dirty) { this.draw(); this.dirty = false; } this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  setLayout(list) { this.layout = list || []; this.bg = null; this.dirty = true; }
  setFrame(bytes) { this.colors = bytes; this.dirty = true; }
  resize() {
    const r = this.c.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width * this.dpr)), hgt = Math.max(10, Math.round(r.height * this.dpr));
    if (w !== this.c.width || hgt !== this.c.height) { this.c.width = w; this.c.height = hgt; this.bg = null; this.dirty = true; }
  }
  // tree geometry in canvas px
  geom() {
    const W = this.c.width, H = this.c.height;
    const treeH = Math.min(H * 0.86, W * 1.45);
    const half = treeH * 0.36;
    const cx = W / 2;
    const bottom = H * 0.5 + treeH * 0.47;
    return { W, H, treeH, half, cx, bottom, top: bottom - treeH };
  }
  project(p) {
    const g = this.geom();
    return { x: g.cx + p.x * g.half, y: g.bottom - p.y * g.treeH * 0.94 - g.treeH * 0.02 };
  }
  // client coords -> tree coords (x -1..1, y 0..1)
  toTree(clientX, clientY) {
    const r = this.c.getBoundingClientRect();
    const g = this.geom();
    const px = (clientX - r.left) * this.dpr, py = (clientY - r.top) * this.dpr;
    return { x: (px - g.cx) / g.half, y: (g.bottom - g.treeH * 0.02 - py) / (g.treeH * 0.94) };
  }
  paintBackground() {
    const g = this.geom();
    const off = document.createElement('canvas');
    off.width = g.W; off.height = g.H;
    const x = off.getContext('2d');
    // floor glow
    if (this.floor) {
      const fg = x.createRadialGradient(g.cx, g.bottom + g.treeH * 0.02, 0, g.cx, g.bottom + g.treeH * 0.02, g.half * 1.6);
      fg.addColorStop(0, 'rgba(255,200,140,0.10)'); fg.addColorStop(1, 'rgba(255,200,140,0)');
      x.save(); x.translate(0, (g.bottom + g.treeH * 0.02) * 0.82); x.scale(1, 0.18); x.translate(0, -(g.bottom + g.treeH * 0.02));
      x.fillStyle = fg; x.fillRect(0, 0, g.W, g.H * 6); x.restore();
    }
    // trunk
    x.fillStyle = '#2a1a10';
    const tw = g.half * 0.16;
    x.fillRect(g.cx - tw / 2, g.bottom - g.treeH * 0.02, tw, g.treeH * 0.07);
    // tiers of boughs, back to front, each a soft scalloped triangle
    const tiers = 7;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < tiers; t++) {
      const k0 = t / tiers, k1 = (t + 1.6) / tiers;
      const yTop = g.bottom - g.treeH * Math.min(1, (1 - k0) * 1.0);
      const yBot = g.bottom - g.treeH * Math.max(0, 1 - k1) * 1.0;
      const wBot = g.half * Math.min(1, k1 * 1.02);
      const shade = 18 + t * 3;
      x.beginPath();
      x.moveTo(g.cx, yTop);
      const steps = 9 + t * 2;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const px = g.cx + wBot * (u * 2 - 1);
        const py = yBot + Math.sin(u * Math.PI * steps) * 0;
        if (s === 0) x.lineTo(px, py);
        else x.quadraticCurveTo(g.cx + wBot * ((s - 0.5) / steps * 2 - 1), yBot + wBot * 0.09, px, py);
      }
      x.closePath();
      const grd = x.createLinearGradient(g.cx - wBot, 0, g.cx + wBot, 0);
      grd.addColorStop(0, `hsl(150 38% ${shade - 8}%)`);
      grd.addColorStop(0.55, `hsl(148 34% ${shade}%)`);
      grd.addColorStop(1, `hsl(152 40% ${shade - 10}%)`);
      x.fillStyle = grd;
      x.fill();
      // needles texture
      x.save(); x.clip();
      x.strokeStyle = `hsla(140 30% ${shade + 12}% / 0.18)`;
      x.lineWidth = Math.max(1, this.dpr * 0.8);
      for (let i = 0; i < 220 + t * 40; i++) {
        const u = rnd() * 2 - 1, v = rnd();
        const yy = yTop + (yBot - yTop) * v;
        const ww = wBot * ((yy - yTop) / (yBot - yTop));
        const xx = g.cx + u * ww;
        x.beginPath(); x.moveTo(xx, yy); x.lineTo(xx + (u > 0 ? 1 : -1) * 6 * this.dpr, yy + 4 * this.dpr); x.stroke();
      }
      x.restore();
    }
    this.bg = off;
  }
  draw() {
    const x = this.ctx;
    const g = this.geom();
    if (!this.bg) this.paintBackground();
    x.clearRect(0, 0, g.W, g.H);
    x.drawImage(this.bg, 0, 0);
    const n = Math.min(this.layout.length, this.colors.length / 3);
    const r0 = Math.max(2.2, g.half * 0.022);
    // back lights first (seen through the branches), then front
    for (const pass of [0, 1]) {
      x.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const p = this.layout[i];
        const front = (p.z ?? 1) >= -0.1;
        if ((pass === 1) !== front) continue;
        const r = this.colors[i * 3], gg = this.colors[i * 3 + 1], b = this.colors[i * 3 + 2];
        const lum = (r + gg + b) / 765;
        if (lum < 0.01) continue;
        const q = this.project(p);
        const rad = r0 * (front ? 1 : 0.75) * (4 + lum * 5);
        // a cached glow image per colour (4 bits per channel) instead of a new gradient per bulb per frame
        x.globalAlpha = front ? 1 : 0.38;
        x.drawImage(halo(r, gg, b), q.x - rad, q.y - rad, rad * 2, rad * 2);
      }
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'source-over';
      for (let i = 0; i < n; i++) {
        const p = this.layout[i];
        const front = (p.z ?? 1) >= -0.1;
        if ((pass === 1) !== front) continue;
        const r = this.colors[i * 3], gg = this.colors[i * 3 + 1], b = this.colors[i * 3 + 2];
        const q = this.project(p);
        const lum = (r + gg + b) / 765;
        if (lum < 0.03) {
          // an unlit bulb: a faint glint of glass, not a black hole in the branches
          x.fillStyle = front ? 'rgba(200,220,205,0.10)' : 'rgba(200,220,205,0.05)';
          x.beginPath(); x.arc(q.x, q.y, r0 * 0.75, 0, Math.PI * 2); x.fill();
          continue;
        }
        const lift = v => Math.min(255, Math.round(v * 0.75 + 70 * lum));
        x.fillStyle = front ? `rgb(${lift(r)},${lift(gg)},${lift(b)})` : `rgba(${r},${gg},${b},0.45)`;
        x.beginPath(); x.arc(q.x, q.y, r0 * (front ? 1 : 0.7), 0, Math.PI * 2); x.fill();
      }
    }
    if (this.star) {
      const sx = g.cx, sy = g.bottom - g.treeH * 1.0 - r0 * 2;
      const sr = g.half * 0.11;
      x.save();
      x.translate(sx, sy);
      const glow = x.createRadialGradient(0, 0, 0, 0, 0, sr * 2.6);
      glow.addColorStop(0, 'rgba(255,214,120,0.35)'); glow.addColorStop(1, 'rgba(255,214,120,0)');
      x.fillStyle = glow; x.fillRect(-sr * 3, -sr * 3, sr * 6, sr * 6);
      x.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const rr = i % 2 ? sr * 0.42 : sr;
        x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      x.closePath();
      x.fillStyle = '#f3c65a';
      x.fill();
      x.restore();
    }
  }
  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
}

// Small animated cone of dots that previews an effect (used for the effect buttons).
export class MiniTree {
  constructor(canvas, layout) {
    this.c = canvas; this.x = canvas.getContext('2d'); this.layout = layout;
    const d = Math.min(2, devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round((r.width || 64) * d); canvas.height = Math.round((r.height || 64) * d);
  }
  draw(out) {
    const { c, x } = this;
    x.clearRect(0, 0, c.width, c.height);
    const W = c.width, H = c.height;
    const n = this.layout.length;
    for (let i = 0; i < n; i++) {
      const p = this.layout[i];
      if (p.z < -0.2) continue;
      const px = W / 2 + p.x * W * 0.36, py = H * 0.9 - p.y * H * 0.8;
      // perceptual boost so dim effects still read at thumbnail size
      const k = v => Math.min(255, Math.pow(Math.max(0, v), 0.55) * 255) | 0;
      const r = k(out[i * 3]), g = k(out[i * 3 + 1]), b = k(out[i * 3 + 2]);
      const rad = W * 0.04 * (0.7 + 0.3 * (p.z + 1) / 2);
      x.fillStyle = `rgba(${r},${g},${b},0.28)`;
      x.beginPath(); x.arc(px, py, rad * 2.1, 0, Math.PI * 2); x.fill();
      x.fillStyle = `rgb(${r},${g},${b})`;
      x.beginPath(); x.arc(px, py, rad, 0, Math.PI * 2); x.fill();
    }
  }
}
