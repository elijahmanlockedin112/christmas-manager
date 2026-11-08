// North Pole TV: the big screen next to the tree. Every scene is driven by server state.
import { connect, $, h, esc } from '/web/lib/net.js';
import { TreeView, halo } from '/web/lib/tree.js';
import { Sound, Listener } from '/web/lib/audio.js';
import { icon } from '/web/lib/icons.js';
import { buildTimeline } from '/shared/song.mjs';
import { syncPreview } from '/web/lib/preview-player.js';

let S = null;
// The Pi's own screen (?kiosk=1): the carols are synthesized on the same 4 small cores that draw the
// scenes, so draw fewer/smaller frames and give the audio a bigger buffer. (Measured on the Pi 4:
// 101 dropouts/min during a carol on the show scene before, 0 with a still scene.)
const LITE = new URLSearchParams(location.search).has('kiosk');
const TREE_OPTS = LITE ? { maxFps: 24, scale: 0.6 } : {};
const sound = new Sound(LITE ? { latencyHint: 0.15, lookahead: 0.8 } : {});
const stage = $('#stage');
let wantFrames = false;
const treeViews = new Set();

const net = connect({
  role: 'tv',
  onState: st => { S = st; update(); },
  onFrame: bytes => { lastFrame = bytes; for (const t of treeViews) t.setFrame(bytes); },
  onStatus: on => $('#offline').classList.toggle('on', !on),
  onMessage: m => {
    if (m.type === 'sfx') sound.sfx(m.name);
    if (m.type === 'strokes') pict.reset(m.strokes);
    if (m.type === 'stroke') pict.add(m.stroke);
  },
});
window.__tv = { net, get state() { return S; }, sound };

// ---------- sound unlock ----------
async function tryUnlock() {
  const ok = await sound.unlock();
  $('#unlock').classList.toggle('on', !ok);
  if (ok) { onAudioReady(); }
  return ok;
}
document.addEventListener('pointerdown', tryUnlock);
document.addEventListener('keydown', tryUnlock);
setTimeout(tryUnlock, 300);
function onAudioReady() { syncShow(); syncRadio(); syncCrackle(); }

// ---------- falling snow (behind most scenes) ----------
const snow = { c: $('#snow'), flakes: [], on: true };
// k < 1 renders soft things (snow, fire, glows) at lower resolution; CSS scales them up, which a TV can't tell apart.
function sizeCanvas(c, k = 0.5) { const d = Math.min(1.5, devicePixelRatio || 1) * k; c.width = Math.round(innerWidth * d); c.height = Math.round(innerHeight * d); return d; }
// an out-of-focus light (flat disc with a soft edge), drawn once per colour
function bokehSprite(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.7, `rgba(${rgb},0.6)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  return c;
}
// a soft round glow drawn once, reused as an image (cheap to draw hundreds of times)
function glowSprite([r, g, b], a = 0.5) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${r},${g},${b},${a})`); gr.addColorStop(0.5, `rgba(${r},${Math.round(g * 0.7)},${b >> 1},${a * 0.35})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return c;
}
sizeCanvas(snow.c);
addEventListener('resize', () => { sizeCanvas(snow.c); sizeCanvas($('#fx')); });
for (let i = 0; i < 140; i++) snow.flakes.push({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.2, v: 0.02 + Math.random() * 0.05, w: Math.random() * 6 });
function drawSnow(t, dt) {
  const c = snow.c, x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  if (!snow.on) return;
  const s = c.height / 1000;
  for (const f of snow.flakes) {
    f.y += f.v * dt * (0.6 + f.r * 0.2); f.x += Math.sin(t * 0.5 + f.w) * 0.0004;
    if (f.y > 1.02) { f.y = -0.02; f.x = Math.random(); }
    x.globalAlpha = 0.15 + f.r * 0.12;
    x.fillStyle = '#fff';
    x.beginPath(); x.arc(f.x * c.width, f.y * c.height, f.r * s * 1.6, 0, Math.PI * 2); x.fill();
  }
  x.globalAlpha = 1;
}

// ---------- confetti / sparkle overlay ----------
const fx = { c: $('#fx'), parts: [] };
sizeCanvas(fx.c);
function confetti(colors = ['#e8322b', '#24a35a', '#e8b23f', '#f6eedc'], n = 160) {
  for (let i = 0; i < n; i++) fx.parts.push({ x: Math.random(), y: -0.05 - Math.random() * 0.3, vx: (Math.random() - 0.5) * 0.08, vy: 0.12 + Math.random() * 0.25, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 8, c: colors[i % colors.length], s: 6 + Math.random() * 8, life: 6 });
}
function drawFx(t, dt) {
  const c = fx.c, x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  fx.parts = fx.parts.filter(p => (p.life -= dt) > 0 && p.y < 1.1);
  for (const p of fx.parts) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.vx *= 0.99;
    x.save(); x.translate(p.x * c.width, p.y * c.height); x.rotate(p.r);
    x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore();
  }
}

// ---------- scenes ----------
const scenes = {};
let current = null;
function scene(id, def) { def.el = h('div', { class: `scene ${def.cls || id}` }); stage.append(def.el); scenes[id] = def; def.init?.(); }
function show(id) {
  if (current === id) return;
  const prev = scenes[current];
  prev?.el.classList.remove('on');
  prev?.leave?.();
  current = id;
  const s = scenes[id] || scenes.home;
  s.el.classList.add('on');
  s.enter?.();
  snow.on = !s.noSnow;
  const frames = !!s.frames;
  if (frames !== wantFrames) { wantFrames = frames; net.setFrames(frames); }
  syncCrackle();
}
const fmt = n => n.toLocaleString('en-US');
function countdown() {
  const now = new Date(net.now());
  const y = now.getMonth() === 11 && now.getDate() > 25 ? now.getFullYear() + 1 : now.getFullYear();
  const ms = Math.max(0, new Date(y, 11, 25) - now);
  return { ms, d: Math.floor(ms / 864e5), h: Math.floor(ms / 36e5) % 24, m: Math.floor(ms / 6e4) % 60, s: Math.floor(ms / 1e3) % 60, xmas: now.getMonth() === 11 && now.getDate() === 25, now };
}

// HOME: a string of big bulbs across the top that light in the real tree's colours, warm out-of-focus
// lights behind, the sleeps count, the tree, a rotating fact, and a code to grab the iPad remote.
let lastFrame = null;
let facts = [];
fetch('/api/content').then(r => r.json()).then(c => (facts = (c.facts || []).sort(() => Math.random() - 0.5))).catch(() => { });
scene('home', {
  frames: true,
  init() {
    this.el.innerHTML = `<canvas class="homebg"></canvas>
      <div class="left">
        <div class="kicker" id="hFam"></div><div class="big num" id="hBig"></div><div class="label" id="hLabel"></div>
        <div class="clock" id="hClock"></div>
        <div class="fact-line" id="hFact"></div>
        <div id="hNp"></div>
      </div>
      <div class="treebox"><canvas></canvas></div>
      `;
    this.bg = this.el.querySelector('canvas.homebg');
    this.tree = new TreeView(this.el.querySelector('.treebox canvas'), { floor: true, ...TREE_OPTS });
    this.bokeh = Array.from({ length: 22 }, (_, i) => ({ x: Math.random(), y: 0.25 + Math.random() * 0.75, r: 0.04 + Math.random() * 0.08, c: ['255,170,70', '232,60,50', '60,190,110', '255,215,140'][i % 4], a: 0.05 + Math.random() * 0.07, v: (Math.random() - 0.5) * 0.004, ph: Math.random() * 6 }));
    this.factAt = -100; this.factI = 0;
  },
  enter() { treeViews.add(this.tree); loadLayout(this.tree); sizeCanvas(this.bg); },
  leave() { treeViews.delete(this.tree); },
  update() {
    const c = countdown();
    $('#hFam').textContent = `${S.settings.family}${c.xmas ? '' : ' · counting down'}`;
    $('#hBig').textContent = c.xmas ? '25' : c.d === 0 ? 'Eve' : c.d;
    $('#hLabel').textContent = c.xmas ? 'Merry Christmas' : c.d === 0 ? 'Santa comes tonight' : c.d === 1 ? 'sleep until Christmas' : 'sleeps until Christmas';
    $('#hClock').textContent = c.now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '  ·  ' + c.now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const np = S.radio.playing ? { t: S.radio.now?.title || S.radio.name, a: S.radio.now?.artist || '', art: S.radio.now?.art } : S.alexa?.nowPlaying?.title ? { t: S.alexa.nowPlaying.title, a: S.alexa.nowPlaying.artist, art: S.alexa.nowPlaying.art } : null;
    $('#hNp').innerHTML = np ? `<div class="np">${np.art ? `<img src="${esc(np.art)}" alt="">` : icon('music')}<div><span class="muted">Now playing</span><b>${esc(np.t)}</b><span class="muted">${esc(np.a)}</span></div></div>` : '';
  },
  frame(t, dt) {
    // rotate the fact every 18 s
    if (facts.length && t - this.factAt > 18) {
      this.factAt = t;
      const el = $('#hFact');
      el.classList.remove('on');
      setTimeout(() => { el.innerHTML = `<span>Did you know?</span>${esc(facts[this.factI++ % facts.length])}`; el.classList.add('on'); }, this.factI ? 700 : 0);
    }
    const c = this.bg, x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    // warm room glow + drifting out-of-focus lights
    const g = x.createRadialGradient(W * 0.72, H * 1.05, 0, W * 0.72, H * 1.05, H * 1.1);
    g.addColorStop(0, 'rgba(120,60,20,0.35)'); g.addColorStop(0.5, 'rgba(40,60,30,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (const b of this.bokeh) {
      b.x += b.v * dt; if (b.x < -0.1) b.x = 1.1; if (b.x > 1.1) b.x = -0.1;
      const r = b.r * H, cx = b.x * W, cy = b.y * H + Math.sin(t * 0.3 + b.ph) * H * 0.01;
      b.sprite ||= bokehSprite(b.c);
      x.globalAlpha = b.a * (0.7 + 0.3 * Math.sin(t * 0.8 + b.ph));
      x.drawImage(b.sprite, cx - r, cy - r, r * 2, r * 2);
    }
    x.globalAlpha = 1;
    // the garland: three swags of wire with big C9 bulbs coloured from the real LEDs
    const swags = 3, perSwag = 9, top = H * 0.035, sag = H * 0.075;
    const fr = lastFrame, n = fr ? fr.length / 3 : 0;
    x.strokeStyle = '#1d2a1f'; x.lineWidth = Math.max(2, H * 0.004);
    let k = 0;
    for (let s = 0; s < swags; s++) {
      const x0 = W * (s / swags), x1 = W * ((s + 1) / swags);
      x.beginPath();
      for (let i = 0; i <= 40; i++) { const u = i / 40; const px = x0 + (x1 - x0) * u, py = top + sag * 4 * u * (1 - u); i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke();
      for (let i = 0; i < perSwag; i++, k++) {
        const u = (i + 0.5) / perSwag;
        const px = x0 + (x1 - x0) * u, py = top + sag * 4 * u * (1 - u);
        const slope = Math.atan2(sag * 4 * (1 - 2 * u), x1 - x0);
        let col = [70, 60, 50], lit = 0;
        if (n) { const li = Math.floor((k / (swags * perSwag)) * n) * 3; col = [fr[li], fr[li + 1], fr[li + 2]]; lit = (col[0] + col[1] + col[2]) / 765; }
        const boost = v => Math.min(255, Math.round(v * 0.85 + 60 * lit));
        x.save(); x.translate(px, py); x.rotate(slope * 0.6);
        // socket
        x.fillStyle = '#20301f'; x.fillRect(-H * 0.006, -H * 0.002, H * 0.012, H * 0.016);
        const bh = H * 0.036, bw = H * 0.018;
        if (lit > 0.03) {
          x.globalAlpha = Math.min(1, lit + 0.2);
          x.drawImage(halo(col[0], col[1], col[2]), -H * 0.07, -H * 0.04, H * 0.14, H * 0.14);
          x.globalAlpha = 1;
        }
        x.fillStyle = lit > 0.03 ? `rgb(${boost(col[0])},${boost(col[1])},${boost(col[2])})` : 'rgba(180,190,180,0.18)';
        x.beginPath(); x.moveTo(0, H * 0.012);
        x.bezierCurveTo(bw, H * 0.016, bw * 0.9, bh, 0, bh + H * 0.008);
        x.bezierCurveTo(-bw * 0.9, bh, -bw, H * 0.016, 0, H * 0.012); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.35)'; x.beginPath(); x.ellipse(-bw * 0.3, H * 0.024, bw * 0.15, bh * 0.25, 0, 0, Math.PI * 2); x.fill();
        x.restore();
      }
    }
  },
});

// IPAD SETUP: a big code to open the remote on the iPad and add it to the home screen
scene('setup', {
  cls: 'setupscene',
  update() {
    const url = S.settings.remoteUrl || location.origin + '/';
    if (this.url === url) return;
    this.url = url;
    this.el.innerHTML = `<img src="/api/qr.svg?d=${encodeURIComponent(url)}" alt=""><div><h1>Put North Pole on the iPad</h1>
      <ol><li>Open the <b>Camera</b> on the iPad and point it at this code.</li><li>Tap the yellow link that pops up.</li><li>Tap <b>Share</b> (the square with the arrow), then <b>Add to Home Screen</b>.</li></ol>
      <div class="url">${esc(url)}</div><div class="muted" style="font-size:2.2vh;margin-top:1.4vh">The iPad needs the Tailscale app switched on.</div></div>`;
  },
});

// YULE LOG: a real-time fire
scene('yule', {
  noSnow: true,
  init() { this.el.innerHTML = '<canvas></canvas>'; this.c = this.el.querySelector('canvas'); this.parts = []; this.embers = []; },
  enter() { sizeCanvas(this.c); },
  frame(t, dt) {
    const c = this.c, x = c.getContext('2d'), W = c.width, H = c.height;
    x.globalCompositeOperation = 'source-over';
    x.fillStyle = '#070403'; x.fillRect(0, 0, W, H);
    // hearth glow
    const flick = 0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 3.1);
    const g = x.createRadialGradient(W / 2, H * 0.82, 0, W / 2, H * 0.82, W * 0.55);
    g.addColorStop(0, `rgba(255,120,30,${0.32 * flick})`); g.addColorStop(1, 'rgba(255,80,10,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    // flames: a steady rate (not per frame) of pre-drawn glow sprites, ~250 alive at once
    const base = H * 0.8;
    if (!this.sprites) this.sprites = [[255, 230, 160], [255, 140, 40], [200, 50, 10]].map(c => glowSprite(c, 0.32));
    this.spawn = (this.spawn || 0) + dt * 230;
    while (this.spawn >= 1) {
      this.spawn--;
      const spread = (Math.random() - 0.5) * (Math.random() - 0.5) * 4; // most flames near the middle of the pile
      this.parts.push({ x: W / 2 + spread * W * 0.2, y: base - Math.random() * H * 0.04, vx: (Math.random() - 0.5) * W * 0.02, vy: -H * (0.3 + Math.random() * 0.45) * (1 - Math.abs(spread) * 0.35), life: 0.6 + Math.random() * 0.9, age: 0, r: H * (0.07 + Math.random() * 0.09) });
    }
    if (Math.random() < 0.3) this.embers.push({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: base, vx: (Math.random() - 0.5) * W * 0.05, vy: -H * (0.2 + Math.random() * 0.3), life: 2 + Math.random() * 2, age: 0 });
    x.globalCompositeOperation = 'lighter';
    this.parts = this.parts.filter(p => (p.age += dt) < p.life);
    for (const p of this.parts) {
      p.x += (p.vx + Math.sin(t * 3 + p.y * 0.01) * W * 0.01) * dt; p.y += p.vy * dt;
      const k = p.age / p.life;
      const r = p.r * (1 - k * 0.7);
      x.globalAlpha = 1 - k;
      x.drawImage(this.sprites[k < 0.25 ? 0 : k < 0.6 ? 1 : 2], p.x - r, p.y - r, r * 2, r * 2);
    }
    x.globalAlpha = 1;
    this.embers = this.embers.filter(e => (e.age += dt) < e.life);
    for (const e of this.embers) { e.x += (e.vx + Math.sin(t * 2 + e.age * 5) * W * 0.02) * dt; e.y += e.vy * dt; x.fillStyle = `rgba(255,170,60,${1 - e.age / e.life})`; x.fillRect(e.x, e.y, 2.5, 2.5); }
    x.globalCompositeOperation = 'source-over';
    // logs
    const logs = [[-0.2, 0.83, 0.42, -0.08], [0.18, 0.835, 0.4, 0.1], [0, 0.8, 0.34, 0.02]];
    for (const [dx, yy, len, rot] of logs) {
      x.save(); x.translate(W / 2 + dx * W, H * yy); x.rotate(rot);
      const lw = W * len, lh = H * 0.07;
      const lg = x.createLinearGradient(0, -lh / 2, 0, lh / 2);
      lg.addColorStop(0, '#3a2213'); lg.addColorStop(0.5, '#24140b'); lg.addColorStop(1, '#120904');
      x.fillStyle = lg; x.beginPath(); x.roundRect(-lw / 2, -lh / 2, lw, lh, lh / 2); x.fill();
      x.fillStyle = `rgba(255,110,20,${0.25 + 0.2 * flick})`; x.fillRect(-lw / 2 + lh * 0.3, -lh / 2, lw - lh * 0.6, lh * 0.12);
      x.fillStyle = '#4a2c18'; x.beginPath(); x.ellipse(lw / 2 - lh * 0.1, 0, lh * 0.18, lh / 2.1, 0, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#6b4224'; x.lineWidth = 2; x.beginPath(); x.ellipse(lw / 2 - lh * 0.1, 0, lh * 0.09, lh / 4, 0, 0, Math.PI * 2); x.stroke();
      x.restore();
    }
    // grate
    x.fillStyle = '#0b0b0b'; x.fillRect(W * 0.22, H * 0.88, W * 0.56, H * 0.015);
  },
});

// COUNTDOWN
scene('countdown', {
  init() { this.el.innerHTML = `<div class="title" id="cdTitle"></div><div class="units">${['days', 'hours', 'minutes', 'seconds'].map(u => `<div class="u"><b id="cd-${u}">0</b><span>${u}</span></div>`).join('')}</div>`; },
  frame() {
    const c = countdown();
    $('#cdTitle').textContent = c.xmas ? 'Merry Christmas!' : `Until Christmas morning`;
    $('#cd-days').textContent = c.d; $('#cd-hours').textContent = String(c.h).padStart(2, '0'); $('#cd-minutes').textContent = String(c.m).padStart(2, '0'); $('#cd-seconds').textContent = String(c.s).padStart(2, '0');
  },
});

// SANTA TRACKER: a night globe that turns with Santa, every city lights up as he passes
scene('santa', {
  noSnow: true,
  init() {
    this.el.innerHTML = `<canvas></canvas><div class="panel"><div class="sub" id="snKick"></div><div class="where" id="snWhere"></div><div class="sub" id="snNext"></div><div class="stats"><div><b id="snGifts">0</b><span>presents delivered</span></div><div><b id="snKm">0</b><span>miles flown</span></div><div><b id="snStops">0</b><span>stops</span></div></div><div class="note" id="snNote"></div></div>`;
    this.c = this.el.querySelector('canvas'); this.stops = []; this.rot = 0;
    fetch('/api/santa/route').then(r => r.json()).then(r => (this.stops = r.stops));
  },
  enter() { sizeCanvas(this.c, 0.75); },
  update() {
    const s = S.santa; if (!s) return;
    $('#snKick').textContent = s.preview ? 'Flight preview' : s.phase === 'flying' ? 'Santa is over' : s.phase === 'done' ? 'Mission complete' : 'Christmas Eve flight';
    $('#snWhere').textContent = s.phase === 'flying' ? `${s.city}${s.country ? ', ' + s.country : ''}` : s.phase === 'prep' ? 'The North Pole' : 'Home again';
    const eta = new Date(s.homeEta).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    $('#snNext').textContent = s.phase === 'flying' ? `Next stop: ${s.nextCity}${s.nextCountry ? ', ' + s.nextCountry : ''}` : s.phase === 'prep' ? `${s.message} He reaches ${s.home} around ${eta} on Christmas Eve night.` : s.message;
    $('#snGifts').textContent = fmt(s.giftsDelivered || 0);
    $('#snKm').textContent = fmt(Math.round((s.distanceKm || 0) * 0.621));
    $('#snStops').textContent = `${s.visited || 0} / ${s.total}`;
    $('#snNote').textContent = s.note || '';
  },
  frame(t, dt) {
    const c = this.c, x = c.getContext('2d'), W = c.width, H = c.height;
    const s = S?.santa;
    x.clearRect(0, 0, W, H);
    const R = H * 0.44, cx = W * 0.68, cy = H * 0.52;
    const targetLon = s?.phase === 'flying' ? s.lon : (t * 8) % 360 - 180;
    let d = targetLon - this.rot; while (d > 180) d -= 360; while (d < -180) d += 360;
    this.rot += d * Math.min(1, dt * 2);
    const lat0 = 22 * Math.PI / 180, lon0 = this.rot * Math.PI / 180;
    const proj = (lat, lon) => {
      const la = lat * Math.PI / 180, lo = lon * Math.PI / 180 - lon0;
      const cosc = Math.sin(lat0) * Math.sin(la) + Math.cos(lat0) * Math.cos(la) * Math.cos(lo);
      return { x: cx + R * Math.cos(la) * Math.sin(lo), y: cy - R * (Math.cos(lat0) * Math.sin(la) - Math.sin(lat0) * Math.cos(la) * Math.cos(lo)), vis: cosc > 0, depth: cosc };
    };
    const g = x.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#173326'); g.addColorStop(1, '#0a1712');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(246,238,220,0.07)'; x.lineWidth = 1;
    for (let la = -60; la <= 80; la += 20) { x.beginPath(); let on = false; for (let lo = -180; lo <= 180; lo += 4) { const p = proj(la, lo); if (p.vis) { on ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y); on = true; } else on = false; } x.stroke(); }
    for (let lo = -180; lo < 180; lo += 30) { x.beginPath(); let on = false; for (let la = -80; la <= 90; la += 4) { const p = proj(la, lo); if (p.vis) { on ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y); on = true; } else on = false; } x.stroke(); }
    x.strokeStyle = 'rgba(246,238,220,0.18)'; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
    const visited = s?.visited || 0;
    this.stops.forEach((st, i) => {
      const p = proj(st.lat, st.lon); if (!p.vis) return;
      const lit = i < visited;
      x.fillStyle = lit ? `rgba(255,205,110,${0.5 + 0.5 * p.depth})` : `rgba(246,238,220,${0.12 + 0.2 * p.depth})`;
      x.beginPath(); x.arc(p.x, p.y, lit ? 3.2 : 2, 0, Math.PI * 2); x.fill();
    });
    const np = proj(90, 0);
    if (np.vis) { x.fillStyle = '#e8322b'; x.beginPath(); x.arc(np.x, np.y, 5, 0, Math.PI * 2); x.fill(); }
    if (s?.phase === 'flying') {
      if (s.trail?.length > 1) {
        x.strokeStyle = 'rgba(232,178,63,0.6)'; x.lineWidth = 2; x.beginPath();
        let on = false;
        for (const [la, lo] of s.trail) { const p = proj(la, lo); if (p.vis) { on ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y); on = true; } }
        x.stroke();
      }
      const p = proj(s.lat, s.lon);
      if (p.vis) {
        const pulse = 1 + 0.25 * Math.sin(t * 5);
        const gg = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, 34 * pulse);
        gg.addColorStop(0, 'rgba(232,50,43,0.85)'); gg.addColorStop(1, 'rgba(232,50,43,0)');
        x.fillStyle = gg; x.fillRect(p.x - 40, p.y - 40, 80, 80);
        x.fillStyle = '#fff'; x.beginPath(); x.arc(p.x, p.y, 5, 0, Math.PI * 2); x.fill();
      }
    }
  },
});

// ADVENT
scene('advent', {
  init() { this.el.classList.add('center'); },
  update() {
    const d = S.tv.advent || null;
    const today = new Date(net.now());
    this.el.innerHTML = d ? `<div class="day">December ${d.day}</div><div class="t">${esc(d.title)}</div><div class="ch">${esc(d.challenge)}</div><div class="f">${esc(d.fact)}</div>`
      : `<div class="day">Advent calendar</div><div class="t">${today.getMonth() === 11 ? 'Open today\'s door' : 'Doors open December 1'}</div><div class="ch muted">Tap a door on the iPad.</div>`;
  },
});

// TREE MIRROR
scene('tree', {
  frames: true,
  init() { this.el.classList.add('treemirror'); this.el.innerHTML = '<div class="box"><canvas></canvas></div>'; this.tree = new TreeView(this.el.querySelector('canvas'), TREE_OPTS); },
  enter() { treeViews.add(this.tree); loadLayout(this.tree); }, leave() { treeViews.delete(this.tree); },
});

// LIGHT SHOW: karaoke lyrics + a piano roll of the music the tree is dancing to
scene('show', {
  noSnow: true,
  frames: true,
  init() {
    this.el.innerHTML = `<div class="songtitle"><span><b id="shTitle"></b></span><span id="shBy"></span></div><div id="shMain"></div><canvas class="roll"></canvas><div class="showtree"><canvas></canvas></div>`;
    this.roll = this.el.querySelector('canvas.roll'); this.tl = null; this.key = '';
    this.tree = new TreeView(this.el.querySelector('.showtree canvas'), { floor: false, ...TREE_OPTS });
  },
  enter() { const r = this.roll.getBoundingClientRect(); const k = LITE ? 0.5 : 0.75; this.roll.width = Math.round(r.width * k); this.roll.height = Math.round(r.height * k); treeViews.add(this.tree); loadLayout(this.tree); },
  leave() { treeViews.delete(this.tree); },
  update() {
    const s = S.show;
    if (!s.playing) return;
    $('#shTitle').textContent = s.title; $('#shBy').textContent = `${s.by || ''}${s.year ? ', ' + s.year : ''}`;
    const key = `${s.songId}@${s.startAt}`;
    if (key !== this.key) { this.key = key; this.tl = null; this.line = -2; getSong(s.songId).then(song => { if (this.key === key) this.tl = buildTimeline(song); }); }
  },
  frame(t) {
    const s = S?.show, tl = this.tl;
    if (!s?.playing || !tl) return;
    const now = s.paused ? s.startAt + s.pausedOffset : net.now();
    const sec = (now - s.startAt) / 1000 - tl.lead;
    const main = $('#shMain');
    if (sec < 0 || tl.instrumental || s.lyrics === false) {
      if (this.line !== -1) { this.line = -1; main.innerHTML = `<div class="bigtitle">${esc(tl.title)}</div><div class="bigby">${esc(tl.by || '')}</div><div class="count" id="shCount"></div>`; }
      const cEl = $('#shCount');
      if (cEl) cEl.textContent = sec < 0 ? `${Math.ceil(-sec / tl.spb)}…` : tl.instrumental ? 'Watch the tree' : '';
    } else {
      let li = tl.lines.findIndex(l => sec < l.end + 0.15);
      if (li < 0) li = tl.lines.length - 1;
      while (li < tl.lines.length - 1 && !tl.lines[li].syllables.length) li++;
      const line = tl.lines[li];
      if (this.line !== li) {
        this.line = li;
        const words = [];
        line.syllables.forEach((sy, i) => words.push(`<span class="w" data-i="${i}">${esc(sy.text)}${sy.joinNext ? '' : ' '}</span>`));
        const next = tl.lines.slice(li + 1).find(l => l.syllables.length);
        main.innerHTML = `<div class="lyric">${words.join('')}</div><div class="nextline">${next ? esc(next.syllables.map(x => x.text + (x.joinNext ? '' : ' ')).join('')) : ''}</div>`;
      }
      main.querySelectorAll('.w').forEach(w => {
        const sy = line.syllables[+w.dataset.i];
        w.classList.toggle('sung', sec >= sy.t);
        w.classList.toggle('now', sec >= sy.t && sec < sy.t + sy.dur);
      });
    }
    // piano roll
    const c = this.roll, x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    const span = 6, px = W / span, playX = W * 0.25;
    const lo = tl.lo - 2, hi = tl.hi + 2;
    let hue = 0;
    for (const ch of tl.chords) if (ch.t <= sec) hue = ch.hue;
    for (const n of tl.notes) {
      const x0 = playX + (n.t - sec) * px;
      if (x0 > W || x0 + n.dur * px < 0) continue;
      const y = H - ((n.midi - lo) / (hi - lo)) * H * 0.9 - H * 0.05;
      const on = sec >= n.t && sec < n.t + n.dur;
      x.fillStyle = on ? '#e8b23f' : n.t < sec ? 'rgba(246,238,220,0.18)' : `hsla(${Math.round((tl.chords.find(c2 => c2.t <= n.t && c2.t + c2.dur > n.t)?.hue ?? hue) * 360)} 70% 60% / 0.55)`;
      x.beginPath(); x.roundRect(x0, y - H * 0.02, Math.max(4, n.dur * px - 4), H * 0.04, H * 0.02); x.fill();
    }
    x.fillStyle = 'rgba(246,238,220,0.25)'; x.fillRect(playX, 0, 2, H);
  },
});

// RADIO
scene('radio', {
  noSnow: false,
  init() { this.el.innerHTML = `<div class="art" id="rArt">${icon('music')}</div><div><div class="chan" id="rChan"></div><div class="t" id="rT"></div><div class="a" id="rA"></div><div class="recent" id="rRecent"></div></div><canvas class="viz"></canvas>`; this.viz = this.el.querySelector('canvas'); },
  enter() { const r = this.viz.getBoundingClientRect(); this.viz.width = r.width; this.viz.height = r.height; },
  update() {
    const r = S.radio;
    $('#rChan').textContent = r.name || 'Christmas radio';
    $('#rT').textContent = r.now?.title || 'Tuning in…';
    $('#rA').textContent = r.now?.artist || '';
    $('#rArt').style.backgroundImage = r.now?.art ? `url('${r.now.art}')` : '';
    $('#rArt').innerHTML = r.now?.art ? '' : icon('music');
    $('#rRecent').innerHTML = r.recent?.length ? 'Earlier: ' + r.recent.map(x => `${esc(x.title)} · ${esc(x.artist)}`).join('<br>') : '';
  },
  frame() {
    const c = this.viz, x = c.getContext('2d'), bins = radio.bins;
    x.clearRect(0, 0, c.width, c.height);
    if (!bins) return;
    const n = 64, bw = c.width / n;
    for (let i = 0; i < n; i++) {
      const v = bins[Math.floor(Math.pow(i / n, 1.7) * bins.length * 0.7)] / 255;
      x.fillStyle = i % 2 ? 'rgba(214,49,43,0.55)' : 'rgba(36,163,90,0.55)';
      x.fillRect(i * bw + 2, c.height * (1 - v), bw - 4, c.height * v);
    }
  },
});

// JOKE
scene('joke', {
  cls: 'joke center',
  update() {
    const j = S.joke; if (!j) return;
    const key = j.q + j.phase;
    if (this.key === key) return;
    const first = this.key?.split('punch')[0] !== j.q + 'setup' && j.phase === 'setup';
    this.key = key;
    if (j.phase === 'setup' || first) {
      this.el.innerHTML = j.kind === 'knock' ? `<div class="knock">Knock knock. Who's there?</div><div class="q">${esc(j.q)}.</div><div class="knock" style="margin-top:3vh">${esc(j.q)} who?</div><div class="a">${esc(j.a)}</div>` : `<div class="q">${esc(j.q)}</div><div class="a">${esc(j.a)}</div>`;
    }
    if (j.phase === 'punch') requestAnimationFrame(() => this.el.querySelector('.a')?.classList.add('on'));
  },
});

// MESSAGE
scene('message', { cls: 'message center', update() { const m = S.tv.message; if (!m) return; this.el.innerHTML = `<div class="text">${esc(m.text)}</div>${m.from ? `<div class="from">${esc(m.from)}</div>` : ''}`; } });

// NICE LIST SCANNER
scene('scanner', {
  cls: 'scanner center',
  update() {
    const s = S.scanner; if (!s) return;
    const key = s.phase + s.at;
    if (this.key === key) return;
    this.key = key;
    if (s.phase === 'scanning') this.el.innerHTML = `<div class="scanbig">Scanning${s.name ? ' ' + esc(s.name) : ''} for the Nice List…</div><div class="scanbar"><i></i></div>`;
    else if (s.photoId) {
      // their photo as a polaroid, the stamp slammed on top
      this.el.innerHTML = `<div class="certificate"><div class="polaroid"><img src="/api/photo/${s.photoId}" alt=""><div class="cap">${esc(s.name || 'Nice List')}</div><span class="stamp on-photo">${s.borderline ? 'Mostly nice' : 'Nice'}</span></div>
        <div class="cert-text"><div class="kick">Official Nice List · ${new Date(net.now()).getFullYear()}</div>${s.name ? `<div class="name">${esc(s.name)}</div>` : ''}<div class="verdict">${esc(s.verdict)}</div><div class="elf">Elf name: <b>${esc(s.elf.elf)}</b><br>${esc(s.elf.job)}</div></div></div>`;
      confetti(['#4fe08a', '#f6eedc', '#e8b23f']);
    } else { this.el.innerHTML = `<div><span class="stamp">${s.borderline ? 'Mostly nice' : 'Nice'}</span></div>${s.name ? `<div class="name">${esc(s.name)}</div>` : ''}<div class="verdict">${esc(s.verdict)}</div><div class="elf">Official elf name: ${esc(s.elf.elf)}, ${esc(s.elf.job)}</div>`; confetti(['#4fe08a', '#f6eedc', '#e8b23f']); }
  },
});

// AI ELVES: report cards, Mad Libs stories and Santa's answers (written by Claude Haiku on the Pi)
scene('ai', {
  cls: 'aiscene',
  update() {
    const a = S.aiShow; if (!a) return;
    if (this.at === a.at) return;
    this.at = a.at;
    if (a.kind === 'report') {
      const c = a.card;
      this.el.innerHTML = `<div class="reportcard"><div class="rc-head"><div class="kick">North Pole Academy · Official Report Card</div><div class="rc-name">${esc(a.name)}</div><div class="rc-title">${esc(c.title)}</div></div>
        <div class="rc-rows">${(c.grades || []).map(g => `<div class="rc-row"><span class="rc-sub">${esc(g.subject)}</span><b class="rc-grade">${esc(g.grade)}</b><span class="rc-note">${esc(g.note)}</span></div>`).join('')}</div>
        <div class="rc-santa">“${esc(c.santaNote)}”<span>Santa Claus</span></div></div>`;
      confetti(['#e8b23f', '#f6eedc', '#d6312b']);
    } else if (a.kind === 'madlibs') {
      const story = esc(a.story).replace(/\[\[(.+?)\]\]/g, '<b class="ml-word">$1</b>');
      this.el.innerHTML = `<div class="mlib"><div class="kick">Santa's Mad Libs</div><h1>${esc(a.title)}</h1><p>${story}</p></div>`;
    } else if (a.kind === 'santa') {
      this.el.innerHTML = `<div class="asksanta"><div class="kick">${a.asker ? esc(a.asker) + ' asked Santa' : 'A question for Santa'}</div><div class="q">“${esc(a.question)}”</div><div class="a">${esc(a.answer)}</div><div class="sig">Santa Claus</div></div>`;
    }
  },
});

// NICE LIST WALL: everyone scanned tonight
scene('nicelist', {
  cls: 'nicewall',
  update() {
    const list = S.niceList || [];
    const key = list.map(p => p.at).join();
    if (this.key === key) return;
    this.key = key;
    this.el.innerHTML = `<div class="wall-head"><div class="kick">Official Nice List · ${new Date(net.now()).getFullYear()}</div><h1>${list.length ? `${list.length} certified nice` : 'Nobody scanned yet'}</h1></div>
      <div class="wall">${list.map((p, i) => `<div class="polaroid small" style="transform:rotate(${[-4, 3, -2, 5, -3, 2][i % 6]}deg)">${p.photoId ? `<img src="/api/photo/${p.photoId}" alt="">` : '<div class="nophoto"></div>'}<div class="cap">${esc(p.name || 'Elf')}<small>${esc(p.elf)}</small></div></div>`).join('')}</div>
      ${list.length ? '' : '<div class="muted" style="font-size:3vh;margin-top:3vh">Fun tab on the iPad, then Nice List Scanner.</div>'}`;
  },
});

// GAMES
const TEAMCOL = id => S.teams.find(t => t.id === id)?.color || '#888';
const pict = {
  strokes: [], c: null,
  reset(list) { this.strokes = list || []; this.redraw(); },
  add(s) { if (s.clear) { this.strokes = []; this.redraw(); return; } this.strokes.push(s); this.drawStroke(s); },
  redraw() { if (!this.c) return; const x = this.c.getContext('2d'); x.clearRect(0, 0, this.c.width, this.c.height); for (const s of this.strokes) this.drawStroke(s); },
  drawStroke(s) {
    if (!this.c || !s.p) return;
    const x = this.c.getContext('2d'), W = this.c.width, H = this.c.height;
    x.strokeStyle = s.c; x.lineCap = 'round'; x.lineJoin = 'round';
    for (let i = 1; i < s.p.length; i++) { const a = s.p[i - 1], b = s.p[i]; x.lineWidth = Math.max(1.5, s.w * W * (0.5 + (b[2] || 0.5))); x.beginPath(); x.moveTo(a[0] * W, a[1] * H); x.lineTo(b[0] * W, b[1] * H); x.stroke(); }
  },
};
// ---------- people: photo (or initial) in their colour, optionally wearing a Santa hat ----------
const HAT = `<svg class="hat" viewBox="0 0 120 100" aria-hidden="true"><path d="M14 72 C 20 38, 48 10, 84 12 C 99 13, 109 27, 107 44 L 97 45 C 95 36, 89 31, 80 33 C 89 45, 96 57, 102 72 Z" fill="#c8202a"/><path d="M28 64 C 36 40, 56 22, 80 20" stroke="#8f121b" stroke-width="5" stroke-linecap="round" fill="none" opacity=".45"/><rect x="4" y="64" width="110" height="24" rx="12" fill="#f7f1e6"/><rect x="10" y="68" width="98" height="5" rx="2.5" fill="#fff" opacity=".7"/><circle cx="104" cy="48" r="11" fill="#f7f1e6"/></svg>`;
const STAR = `<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9l7.1-.6z" fill="#e8b23f" stroke="#fff3c9" stroke-width=".8"/></svg>`;
const person = id => S.players.find(p => p.id === id) || null;
function avatar(p, { hat = false, cls = '', ring = false } = {}) {
  if (!p) return '';
  const face = p.photo ? `<img src="/api/player-photo/${encodeURIComponent(p.id)}?v=${p.photo}" alt="">` : `<span>${esc((p.name || '?')[0].toUpperCase())}</span>`;
  return `<div class="av ${cls}" style="--c:${p.color || 'var(--gold)'}">${ring ? '<svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="47" class="track"/><circle cx="50" cy="50" r="47" class="left" id="gRing" pathLength="100"/></svg>' : ''}<div class="face">${face}</div>${hat ? HAT : ''}</div>`;
}
// solo scoreboard: little faces with scores
const playersLine = () => `<div class="faces">${[...S.players].sort((a, b) => b.score - a.score).map(p => `<span>${avatar(p, { cls: 'xs' })}<b>${fmt(p.score || 0)}</b></span>`).join('')}</div>`;

// ---------- family games: Most Likely To, Mind Reader, Caption Chaos ----------
const PARTY_TV = ['most-likely', 'mind-reader', 'caption-chaos'];
const PARTY_TITLE = { 'most-likely': 'Most Likely To', 'mind-reader': 'Mind Reader', 'caption-chaos': 'Caption Chaos' };
const CHK = `<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#3fd17c"/><path d="M6.5 12.5l3.6 3.6 7.4-8" stroke="#0b1510" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ELF = { id: 'elf', name: 'The Elf', color: '#1f9a52' };
const who = id => (id === 'elf' ? ELF : person(id)) || { id, name: '?', color: '#888' };
function partyView(g, prevPhase, { timer, teamsLine }) {
  const x = g.x || {}, foot = (left = '') => `<div class="g-foot"><span>${left}</span>${teamsLine}</div>`;
  const nPlayers = S.players.length;
  if (g.kind === 'most-likely') {
    if (g.phase === 'vote') {
      return `<div class="ml"><div class="ml-lead">Who is the most likely to</div><h1 class="ml-q">${esc(x.prompt)}?</h1>
        <div class="ml-row">${S.players.map((p, i) => `<div class="ml-p" style="animation-delay:${i * 90}ms">${avatar(p, { cls: 'lg' })}${x.voted.includes(p.id) ? CHK : ''}<b>${esc(p.name)}</b></div>`).join('')}</div></div>
        <div class="g-foot"><span class="votes-in">${S.players.map(p => `<i class="${x.voted.includes(p.id) ? 'on' : ''}" style="--c:${p.color}"></i>`).join('')}<em>${x.voted.length} of ${nPlayers} have voted. Use the iPad, in secret.</em></span>${teamsLine}</div>`;
    }
    const win = new Set(x.winners || []);
    const names = [...win].map(id => who(id).name);
    const verdict = win.size ? `${names.join(' & ')}${win.size > 1 ? ' tie' : ''}. ${Math.max(...Object.values(x.tally))} votes.` : 'Five different answers. Nobody agrees.';
    const cols = S.players.map((p, i) => {
      const voters = Object.keys(x.ballots || {}).filter(v => x.ballots[v] === p.id);
      return `<div class="ml-p ${win.has(p.id) ? 'win' : ''}" style="animation-delay:${i * 140}ms"><div class="stack">${voters.map(v => avatar(who(v), { cls: 'xs' })).join('')}</div><div class="cnt num">${x.tally[p.id] || 0}</div>${avatar(p, { cls: win.has(p.id) ? 'lg' : 'md', hat: win.has(p.id) })}<b>${esc(p.name)}</b>${x.gained?.[p.id] ? `<span class="pts">+${x.gained[p.id]}</span>` : ''}</div>`;
    }).join('');
    return `<div class="ml reveal"><div class="ml-lead">Most likely to</div><h1 class="ml-q sm">${esc(x.prompt)}</h1><div class="ml-row">${cols}</div><div class="ml-verdict ${win.size ? 'good' : ''}">${esc(verdict)}</div></div>` + foot();
  }

  if (g.kind === 'mind-reader') {
    const sp = person(x.spot.id) || x.spot;
    if (g.phase === 'turn') {
      return `<div class="upnext"><div class="pop">${avatar(sp, { hat: true, cls: 'xl' })}</div><div><div class="muted" style="font-size:3vh">Round ${g.round} of ${g.total}</div><h1>${esc(sp.name)}, you're in the spotlight!</h1><div style="font-size:3.4vh">Take the iPad and tap <b>show my choice</b>. Everyone else, eyes on the TV.</div></div></div>` + foot();
    }
    const rev = g.phase === 'reveal';
    const guessers = side => Object.keys(x.guesses || {}).filter(id => x.guesses[id] === side);
    const opt = (side, i) => {
      const chosen = rev && x.pick === side;
      return `<div class="mr-card ${rev ? (chosen ? 'chosen' : 'dim') : ''}"><i style="background:${i ? '#3a7be0' : '#d6312b'}">${'AB'[i]}</i><span>${esc(x[side])}</span>${rev ? `<div class="guessers">${guessers(side).map(id => `<span class="${chosen ? 'ok' : 'no'}">${avatar(who(id), { cls: 'xs' })}</span>`).join('')}</div>` : ''}</div>`;
    };
    const guessed = x.guessed || [];
    const status = rev ? '' : g.phase === 'pick' ? `<div class="mr-status">${esc(sp.name)} is choosing in secret…</div>`
      : `<div class="mr-status"><span class="votes-in">${S.players.filter(p => p.id !== sp.id).map(p => `<i class="${guessed.includes(p.id) ? 'on' : ''}" style="--c:${p.color}"></i>`).join('')}</span>Guess what ${esc(sp.name)} picked. ${guessed.length} of ${nPlayers - 1} in.</div>`;
    const right = x.right || [];
    const verdict = !rev ? '' : right.length ? (right.length === x.others ? `${esc(sp.name)} is an open book.` : `${right.length} of ${x.others} read ${esc(sp.name)} right.`) : `${esc(sp.name)} fooled everyone.`;
    return `<div class="mr"><div class="who ${rev ? (right.length ? 'yay' : 'droop') : ''}">${avatar(sp, { hat: true, cls: 'xl' })}<b style="color:${sp.color}">${esc(sp.name)}</b></div><div class="mr-main"><div class="ml-lead">${rev ? `${esc(sp.name)} picked` : `Which would ${esc(sp.name)} pick?`}</div><div class="mr-cards">${opt('a', 0)}<div class="or">or</div>${opt('b', 1)}</div>${rev ? `<div class="ml-verdict ${right.length ? 'good' : ''}">${verdict}</div>` : status}</div></div>` + foot();
  }

  // caption chaos
  const scene = (sm = false) => `<div class="cc-scene ${sm ? 'sm' : ''}"><div class="ml-lead">The scene</div><div class="cc-text">${esc(x.scene)}</div><div class="cc-ask">${esc(x.ask)}</div></div>`;
  if (g.phase === 'write') {
    return `<div class="cc">${scene()}<div class="cc-write">${timer(g.endsAt)}<div class="ml-row cc-faces">${S.players.map(p => `<div class="ml-p ${x.written.includes(p.id) ? 'done' : ''}">${avatar(p, { cls: 'md' })}${x.written.includes(p.id) ? CHK : ''}<b>${esc(p.name)}</b><span class="state">${x.written.includes(p.id) ? 'Caption in' : 'Writing…'}</span></div>`).join('')}${x.elf ? `<div class="ml-p">${avatar(ELF, { cls: 'md' })}<b>The Elf</b><span class="state">Sneaking one in</span></div>` : ''}</div></div></div>` + foot();
  }
  if (g.phase === 'vote') {
    return `<div class="cc">${scene(true)}${timer(g.endsAt)}<div class="cc-list">${x.entries.map((e, i) => `<div class="cc-entry" style="animation-delay:${i * 120}ms"><i class="num">${i + 1}</i><span>${esc(e.text)}</span></div>`).join('')}</div></div><div class="g-foot"><span class="votes-in">${S.players.map(p => `<i class="${x.voted.includes(p.id) ? 'on' : ''}" style="--c:${p.color}"></i>`).join('')}<em>${x.voted.length} of ${nPlayers} voted. You can't vote for your own.</em></span>${teamsLine}</div>`;
  }
  const win = new Set(x.winners || []);
  if (!x.entries.length) return `<div class="cc">${scene()}<div class="ml-verdict">Not enough captions to vote on.</div></div>` + foot();
  return `<div class="cc reveal">${scene(true)}<div class="cc-list res">${x.entries.map((e, i) => {
    const a = who(e.author), w = win.has(e.id);
    return `<div class="cc-entry ${w ? 'win' : ''}" style="animation-delay:${i * 160}ms">${avatar(a, { cls: w ? 'md' : 'xs', hat: w && e.author !== 'elf' })}<span><em>${esc(a.name)}</em>${esc(e.text)}</span><b class="num">${e.voters.length}</b></div>`;
  }).join('')}</div></div>` + foot();
}

scene('game', {
  init() { this.key = ''; },
  update() {
    const g = S.game;
    if (!g) return;
    const key = JSON.stringify([g.kind, g.phase, g.round, g.q, g.a, g.buzz, g.answer, g.word, g.result, g.winner, S.players.map(p => p.id + p.photo + p.score), S.teams.length, g.kind === 'pictionary' ? 0 : g.answered?.length, g.votesIn, g.guesses?.length, g.correct?.length, g.turn?.pid, g.picked, g.x]);
    if (key === this.key) return;
    const prevPhase = this.phase;
    this.key = key; this.phase = g.phase;
    const names = { trivia: 'Trivia Showdown', 'name-that-song': 'Name That Song', 'would-you-rather': 'Would You Rather', pictionary: 'Pictionary', ...PARTY_TITLE };
    const top = `<div class="g-top"><b>${names[g.kind]}</b><span>${g.phase === 'lobby' || g.phase === 'final' ? '' : `Round ${g.round} of ${g.total}`}</span></div>`;
    const scores = g.teamScores || (() => { const s = {}; for (const p of S.players) s[p.team] = (s[p.team] || 0) + (p.score || 0); return s; })();
    const teamsLine = g.solo ? playersLine() : `<div class="teams">${S.teams.map(t => `<span style="color:${t.color}">${t.name} ${fmt(scores[t.id] || 0)}</span>`).join('')}</div>`;
    const timer = endsAt => `<div class="timer"><i id="gTimer" data-ends="${endsAt}" data-dur="${endsAt - Date.now()}"></i></div>`;
    const el = this.el;
    this.ticked = prevPhase === g.phase ? this.ticked : 99;
    if (g.solo && g.phase === 'lobby') {
      el.innerHTML = top + `<div class="final"><h1>Get ready</h1><div class="muted" style="font-size:3vh">Everyone for themselves. Pass the iPad around.</div><div class="lineup">${S.players.map((p, i) => `<div style="animation-delay:${i * 120}ms">${avatar(p, { hat: true, cls: 'md' })}<b>${esc(p.name)}</b></div>`).join('')}</div></div>`;
      return;
    }
    if (g.solo && g.phase === 'final') {
      const board = g.board || [];
      const champs = new Set(g.champs || []);
      const podium = [board[1], board[0], board[2]].filter(Boolean);
      el.innerHTML = top + `<div class="final"><h1>${champs.size ? [...champs].map(id => esc(board.find(p => p.id === id)?.name || '')).join(' & ') + (champs.size > 1 ? ' tie!' : ' wins!') : 'Final scores'}</h1><div class="podium">${podium.map(p => `<div class="${p === board[0] ? 'first' : ''}">${champs.has(p.id) ? STAR : ''}${avatar(person(p.id) || p, { hat: true, cls: p === board[0] ? 'lg' : 'md' })}<b>${esc(p.name)}</b><span class="num">${fmt(p.score)}</span></div>`).join('')}</div>${board.length > 3 ? `<div class="rest">${board.slice(3).map((p, i) => `<span>${i + 4}. ${esc(p.name)} <b class="num">${fmt(p.score)}</b></span>`).join('')}</div>` : ''}</div>`;
      if (prevPhase !== 'final') confetti([board[0]?.color || '#e8b23f', '#f6eedc', '#e8b23f']);
      return;
    }
    if (PARTY_TV.includes(g.kind)) {
      el.innerHTML = top + partyView(g, prevPhase, { timer, teamsLine });
      if (g.phase === 'reveal' && prevPhase !== 'reveal') {
        const x = g.x, hit = g.kind === 'most-likely' ? x.winners?.[0] : g.kind === 'mind-reader' ? (x.right?.length ? x.spot.id : null) : (x.winners?.[0] && x.entries.find(e => e.id === x.winners[0])?.author);
        if (hit && hit !== 'elf') confetti([who(hit).color || '#e8b23f', '#f6eedc', '#e8b23f'], 110);
      }
      return;
    }
    if (g.kind === 'trivia' && g.hotSeat && g.turn) {
      const p = person(g.turn.pid) || g.turn;
      const L = ['A', 'B', 'C', 'D'], LC = ['#d6312b', '#1f9a52', '#d69a1e', '#3a7be0'];
      if (g.phase === 'turn') {
        el.innerHTML = top + `<div class="upnext"><div class="pop">${avatar(p, { hat: true, cls: 'xl' })}</div><div><div class="muted" style="font-size:3vh">Question ${g.round} of ${g.total}</div><h1>${esc(p.name)}, you're up!</h1><div style="font-size:3.4vh">Grab the iPad and tap <b>I'm ready</b>.</div>${g.turn.streak >= 2 ? `<div class="streak">${g.turn.streak} in a row. Keep it going!</div>` : ''}</div></div><div class="g-foot"><span></span>${teamsLine}</div>`;
        return;
      }
      const rev = g.phase === 'reveal';
      const right = rev && g.gained?.[p.id], timedOut = rev && g.turn.timedOut;
      const mood = !rev ? '' : right ? 'yay' : 'droop';
      const verdict = !rev ? (g.picked !== null && g.picked !== undefined && g.picked >= 0 ? '<div class="verdict">Locked in…</div>' : `<div class="secs num" id="gSecs"></div>`)
        : right ? `<div class="verdict good">+${fmt(g.gained[p.id])}</div>${g.turn.streak >= 3 ? `<div class="streak">${g.turn.streak} in a row!</div>` : ''}` : `<div class="verdict bad">${timedOut ? "Time's up!" : 'So close!'}</div>`;
      el.innerHTML = top + `<div class="hotseat"><div class="who ${mood}">${avatar(p, { hat: true, cls: 'xl', ring: !rev })}<b style="color:${p.color}">${esc(p.name)}</b>${verdict}</div><div class="qa"><div class="muted" style="font-size:2.4vh;margin-bottom:1.4vh">${esc(g.category || '')}</div><div class="g-q">${esc(g.q || '')}</div>${rev && g.fact ? `<div class="fact">${esc(g.fact)}</div>` : ''}<div class="g-choices">${(g.choices || []).map((c, i) => `<div class="g-choice${rev ? (i === g.answer ? ' right' : i === g.picked ? ' wrong' : ' dim') : i === g.picked ? ' picked' : ''}"><i style="background:${LC[i]}">${L[i]}</i>${esc(c)}</div>`).join('')}</div></div></div><div class="g-foot"><span></span>${teamsLine}</div>`;
      if (!rev) { const r = $('#gRing'); if (r) { r.dataset.ends = g.endsAt; r.dataset.dur = g.endsAt - g.startsAt; } }
      if (rev && right && prevPhase !== 'reveal') confetti([p.color, '#f6eedc', '#e8b23f'], 90);
      return;
    }
    if (g.phase === 'lobby') {
      const rosterHtml = `<div class="roster">${S.teams.map(t => `<div class="tm"><b style="color:${t.color}">${t.name}</b>${S.players.filter(p => p.team === t.id).map(p => `<span class="pill" style="background:${t.color}">${esc(p.name)}</span>`).join('')}</div>`).join('')}</div>`;
      el.innerHTML = S.settings.phones
        ? top + `<div class="lobby"><img src="/api/qr.svg?d=${encodeURIComponent(S.joinUrl)}" alt=""><div><h1>Get ready</h1><div class="muted" style="font-size:2.6vh">Play on the iPad, or scan the code to use your phone</div><div class="url">${esc(S.joinUrl)}</div>${rosterHtml}</div></div>`
        : top + `<div class="final"><h1>Get ready</h1><div class="muted" style="font-size:3vh;margin-bottom:2vh">Everyone plays on the iPad. Pass it around.</div>${rosterHtml}</div>`;
      return;
    }
    if (g.phase === 'final') {
      const w = S.teams.find(t => t.id === g.winner);
      el.innerHTML = top + `<div class="final"><h1 style="color:${w?.color || 'var(--gold)'}">${w ? esc(w.name) + ' wins!' : 'Final scores'}</h1>${teamsLine}<div class="board mt" style="margin-top:4vh">${(g.board || []).slice(0, 10).map((p, i) => `<div><span>${i + 1}. <span style="color:${TEAMCOL(p.team)}">●</span> ${esc(p.name)}</span><b>${fmt(p.score)}</b></div>`).join('')}</div></div>`;
      if (prevPhase !== 'final') confetti([w?.color || '#e8b23f', '#f6eedc', '#e8b23f']);
      return;
    }
    const L = ['A', 'B', 'C', 'D'], LC = ['#d6312b', '#1f9a52', '#d69a1e', '#3a7be0'];
    if (g.kind === 'trivia') {
      const rev = g.phase === 'reveal';
      el.innerHTML = top + `<div class="muted" style="font-size:2.4vh;margin-bottom:1.6vh">${esc(g.category)}</div><div class="g-q">${esc(g.q)}</div>${rev ? `<div class="fact">${esc(g.fact)}</div>` : timer(g.endsAt)}<div class="g-choices">${g.choices.map((c, i) => `<div class="g-choice${rev ? (i === g.answer ? ' right' : ' dim') : ''}"><i style="background:${LC[i]}">${L[i]}</i>${esc(c)}${rev ? `<span class="cnt">${g.counts[i]}</span>` : ''}</div>`).join('')}</div><div class="g-foot"><span>${rev ? '' : (() => { const next = S.players.find(p => p.local && !g.answered.includes(p.id)); return next ? `<b style="color:${TEAMCOL(next.team)}">${esc(next.name)}</b>'s turn on the iPad · ${g.answered.length} of ${S.players.filter(p => p.online).length} in` : `${g.answered.length} of ${S.players.filter(p => p.online).length} answered`; })()}</span>${teamsLine}</div>`;
    } else if (g.kind === 'name-that-song') {
      if (g.phase === 'buzzed') el.innerHTML = top + `<div class="nts"><div class="record stop"></div><div><div class="buzzed" style="color:${TEAMCOL(g.buzz.team)}">${esc(g.buzz.name)}</div><div style="font-size:4vh;margin-top:2vh">buzzed in! Which song is it?</div>${timer(g.buzzEndsAt)}</div></div><div class="g-foot"><span></span>${teamsLine}</div>`;
      else if (g.phase === 'reveal') el.innerHTML = top + `<div class="nts"><div class="record"></div><div><div class="muted" style="font-size:3vh">${g.winner ? esc(S.players.find(p => p.id === g.winner)?.name || '') + ' got it' : 'Nobody got it'}</div><div class="buzzed" style="font-size:9vh;margin-top:1vh">${esc(g.item.title)}</div><div style="font-size:4vh;color:var(--muted);margin-top:1.4vh">${esc(g.item.artist || '')}${g.item.year ? ', ' + g.item.year : ''}</div></div></div><div class="g-foot"><span></span>${teamsLine}</div>`;
      else el.innerHTML = top + `<div class="nts"><div class="record"></div><div><div class="buzzed">Name that song</div><div style="font-size:4vh;margin-top:2vh;color:var(--muted)">${g.source === 'alexa' ? 'Listen to Alexa.' : 'Listen…'} Slap your name on the iPad the second you know it.</div>${g.wrong?.length ? `<div style="font-size:2.6vh;margin-top:3vh;color:#ff8a80">Locked out: ${g.wrong.map(id => esc(S.players.find(p => p.id === id)?.name || '')).join(', ')}</div>` : ''}${timer(g.endsAt)}</div></div><div class="g-foot"><span></span>${teamsLine}</div>`;
    } else if (g.kind === 'would-you-rather') {
      const r = g.result;
      el.innerHTML = `<div class="wyr"><div class="a"><div class="bar" style="height:${r ? r.share * 100 : 0}%"></div><div class="k">Would you rather…</div><div class="opt">${esc(g.a)}</div>${r ? `<div class="pct">${Math.round(r.share * 100)}%</div><div class="names">${r.a.map(esc).join(', ')}</div>` : ''}</div><div class="b"><div class="bar" style="height:${r ? (1 - r.share) * 100 : 0}%"></div><div class="k">&nbsp;</div><div class="opt">${esc(g.b)}</div>${r ? `<div class="pct">${Math.round((1 - r.share) * 100)}%</div><div class="names">${r.b.map(esc).join(', ')}</div>` : ''}</div><div class="or">or</div></div>`;
      if (!r) { el.querySelector('.a').insertAdjacentHTML('beforeend', `<div class="names" style="margin-top:4vh">${g.votesIn} voted</div>`); }
    } else if (g.kind === 'pictionary') {
      if (g.phase === 'pass') {
        el.innerHTML = top + `<div class="final"><div class="muted" style="font-size:3vh">Next artist</div><h1 style="color:${TEAMCOL(g.drawer.team)}">${esc(g.drawer.name)}</h1><div style="font-size:3.4vh">Pass them the iPad. No peeking!</div><div style="margin-top:5vh">${teamsLine}</div></div>`;
        pict.reset([]);
        return;
      }
      if (g.phase === 'draw' && prevPhase === 'draw' && el.querySelector('.paper')) {
        el.querySelector('#pFeed').innerHTML = feedHtml(g);
        return;
      }
      el.innerHTML = top + `<div class="pict"><div class="paper"><canvas></canvas></div><div><div class="muted" style="font-size:2.4vh">${g.phase === 'draw' ? `${g.drawer ? esc(g.drawer.name) + ' is drawing. ' : ''}Shout your guesses!` : 'The word was'}</div><div class="mask" style="${g.phase === 'reveal' ? 'font-family:var(--serif);letter-spacing:0;font-size:7vh;font-weight:800' : ''}">${esc(g.phase === 'reveal' ? g.word : g.mask)}</div>${g.phase === 'draw' ? timer(g.endsAt) : ''}<div class="feed" id="pFeed">${feedHtml(g)}</div><div style="margin-top:4vh">${teamsLine}</div></div></div>`;
      const c = el.querySelector('.paper canvas'); const r = c.getBoundingClientRect(); c.width = r.width; c.height = r.height;
      pict.c = c; pict.redraw();
    }
  },
  frame() {
    const ring = $('#gRing');
    if (ring && ring.dataset.ends) {
      // hot seat: the ring around their face runs down, turns red and ticks for the last 5 seconds
      const left = (+ring.dataset.ends - net.now()) / 1000, frac = Math.max(0, Math.min(1, left * 1000 / (+ring.dataset.dur || 1)));
      ring.style.strokeDashoffset = String(100 - frac * 100);
      ring.classList.toggle('hurry', left < 5.5);
      const s = $('#gSecs'); if (s) s.textContent = Math.max(0, Math.ceil(left));
      const whole = Math.ceil(left);
      if (s && whole <= 5 && whole > 0 && whole < this.ticked) { this.ticked = whole; sound.sfx(whole % 2 ? 'tick' : 'tock'); }
    }
    const t = $('#gTimer'); if (!t) return;
    const ends = +t.dataset.ends, dur = +t.dataset.dur || 1;
    t.style.transform = `scaleX(${Math.max(0, Math.min(1, (ends - net.now()) / dur))})`;
  },
});
function feedHtml(g) { return [...(g.correct || []).map(c => `<div class="ok" style="color:${TEAMCOL(c.team)}">${esc(c.name)} got it! +${c.pts}</div>`), ...(g.guesses || []).slice(-8).reverse().map(x => `<div><span style="color:${TEAMCOL(x.team)}">${esc(x.name)}:</span> ${esc(x.text)}</div>`)].join(''); }

// ---------- shared data ----------
const songCache = new Map();
function getSong(id) { if (!songCache.has(id)) songCache.set(id, fetch(`/api/song/${id}`).then(r => r.json()).then(r => r.song)); return songCache.get(id); }
let layoutJson = null, layoutKeyLoaded = '';
async function loadLayout(tree) {
  if (!layoutJson || layoutKeyLoaded !== S?.hw.layoutKey) { layoutKeyLoaded = S?.hw.layoutKey; layoutJson = (await fetch('/api/layout').then(r => r.json())).layout; }
  tree.setLayout(layoutJson);
}

// ---------- audio sync ----------
let showKey = '';
async function syncShow() {
  const s = S?.show;
  const key = s?.playing && !s.paused ? `${s.songId}@${s.startAt}` : '';
  if (key === showKey || !sound.ready) return;
  showKey = key;
  if (!key) { sound.stopSong(); return; }
  const song = await getSong(s.songId);
  if (showKey !== key) return;
  sound.playSong(song, buildTimeline(song), s, net, { latency: 0 });
}
const radio = { el: null, listener: null, channel: '', bins: null };
function syncRadio() {
  const r = S?.radio;
  const want = r?.playing ? r.channel : '';
  if (want === radio.channel || !sound.ready) return;
  radio.channel = want;
  if (radio.el) { radio.el.pause(); radio.el.src = ''; radio.listener?.stop(); radio.el = null; radio.bins = null; }
  if (!want) return;
  const a = new Audio(); a.crossOrigin = 'anonymous'; a.src = `/radio/${want}`; a.preload = 'none';
  const src = sound.ctx.createMediaElementSource(a);
  const gain = sound.ctx.createGain(); gain.gain.value = 0.9;
  src.connect(gain); gain.connect(sound.master);
  radio.listener = new Listener(sound.ctx, src, lv => { radio.bins = lv.bins; net.send({ type: 'audio', bass: lv.bass, mid: lv.mid, high: lv.high, level: lv.level, beat: lv.beat }); });
  a.play().catch(() => { });
  // if the stream drops (Wi-Fi blip), reconnect while the radio is still on
  const retry = () => { if (radio.el !== a) return; radio.channel = ''; setTimeout(syncRadio, 2000); };
  a.onended = retry; a.onerror = retry;
  radio.el = a;
}
function syncCrackle() { if (current === 'yule' && sound.ready) sound.startCrackle(); else sound.stopCrackle(); }

// ---------- update + loop ----------
function update() {
  if (!S) return;
  let id = S.tv.scene;
  if (id === 'game' && !S.game) id = S.tv.prev || 'home';
  if (id === 'show' && !S.show.playing) id = S.tv.prev || 'home';
  if (id === 'joke' && !S.joke) id = 'home';
  if (!scenes[id]) id = 'home';
  show(id);
  scenes[id].update?.();
  syncShow(); syncRadio();
  syncPreview(S.game, net.now); // real song clips for Name That Song
}
let last = performance.now(), t0 = last;
const perf = { n: 0, t: last };
function loop(now) {
  requestAnimationFrame(loop);
  if (now - last < (LITE ? 38 : 30)) return; // ~30 fps is plenty for a TV (~25 on the Pi, leaving room for the audio)
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  // report real smoothness to the server every 5 s (shown on the iPad's TV tab)
  perf.n++;
  if (now - perf.t > 5000) { net.send({ type: 'perf', fps: Math.round(perf.n * 1000 / (now - perf.t)), scene: current }); perf.n = 0; perf.t = now; }
  const t = (now - t0) / 1000;
  drawSnow(t, dt); drawFx(t, dt);
  if (S) scenes[current]?.frame?.(t, dt);
}
requestAnimationFrame(loop);
setInterval(() => { if (current === 'home' && S) scenes.home.update(); }, 10000);

// ---------- getting out of the full-screen kiosk on the Pi ----------
// Esc on a keyboard, or move the mouse and click "Exit to desktop". Only on the Pi's own screen (?kiosk=1).
if (new URLSearchParams(location.search).has('kiosk')) {
  const btn = $('#exitKiosk');
  let hideT = 0;
  const exit = () => { btn.textContent = 'Closing…'; net.act('tv.kiosk', { open: false }).catch(() => { }); };
  addEventListener('keydown', e => { if (e.key === 'Escape') exit(); });
  addEventListener('mousemove', () => {
    btn.classList.add('on'); document.body.classList.add('mouse');
    clearTimeout(hideT);
    hideT = setTimeout(() => { btn.classList.remove('on'); document.body.classList.remove('mouse'); }, 4000);
  });
  btn.addEventListener('click', e => { e.stopPropagation(); exit(); });
}
