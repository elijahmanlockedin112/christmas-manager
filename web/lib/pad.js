// The iPad's drawing pad for the drawing games (ornaments, portraits, telephone). Strokes are kept as
// data, so Undo and a resize just redraw them. Touch and Apple Pencil both work; once a Pencil has been
// seen, plain finger touches are ignored so a resting palm never draws (the same rule Pictionary uses).
export const THIN = 0.007, THICK = 0.022;

export function makePad(host, { round = false, paper = '#fbf5e9', color = '#14281d', width = THIN, sawPen, onPen, onChange } = {}) {
  host.innerHTML = `<div class="dpad${round ? ' round' : ''}" id="dpad"><canvas></canvas></div>`;
  const wrap = host.firstElementChild, c = wrap.firstElementChild, x = c.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  const api = { strokes: [], paper, color, width };
  let cur = null;

  const press = p => (p.t === 'pen' ? 0.55 + (p.f || 0.5) * 0.9 : 1);
  const dot = (s, p) => { x.fillStyle = s.c; x.beginPath(); x.arc(p.x * c.width, p.y * c.height, Math.max(1, s.w * c.width * press(p) / 2), 0, Math.PI * 2); x.fill(); };
  const seg = (s, a, b) => { x.strokeStyle = s.c; x.lineWidth = Math.max(1, s.w * c.width * press(b)); x.beginPath(); x.moveTo(a.x * c.width, a.y * c.height); x.lineTo(b.x * c.width, b.y * c.height); x.stroke(); };
  const drawStroke = s => { if (s.p.length === 1) dot(s, s.p[0]); for (let i = 1; i < s.p.length; i++) seg(s, s.p[i - 1], s.p[i]); };
  const redraw = () => {
    x.fillStyle = api.paper; x.fillRect(0, 0, c.width, c.height);
    x.lineCap = 'round'; x.lineJoin = 'round';
    for (const s of api.strokes) drawStroke(s);
    if (cur) drawStroke(cur);
  };
  const size = () => { const r = wrap.getBoundingClientRect(); if (!r.width) return; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); redraw(); };
  const ro = new ResizeObserver(size); ro.observe(wrap);
  size();

  const pt = e => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: e.pointerType, f: e.pressure }; };
  wrap.onpointerdown = e => {
    if (e.pointerType === 'touch' && sawPen?.()) return;
    if (e.pointerType === 'pen') onPen?.();
    wrap.setPointerCapture(e.pointerId);
    const p = pt(e);
    cur = { c: api.color, w: api.width, p: [p] };
    x.lineCap = 'round'; dot(cur, p);
  };
  wrap.onpointermove = e => {
    if (!cur) return;
    for (const ev of e.getCoalescedEvents?.() || [e]) { const p = pt(ev); seg(cur, cur.p[cur.p.length - 1], p); cur.p.push(p); }
  };
  wrap.onpointerup = wrap.onpointercancel = () => { if (!cur) return; api.strokes.push(cur); cur = null; onChange?.(); };

  api.undo = () => { api.strokes.pop(); redraw(); onChange?.(); };
  api.clear = () => { api.strokes = []; redraw(); onChange?.(); };
  api.setColor = k => { api.color = k; };
  api.setWidth = w => { api.width = w; };
  api.setPaper = k => { api.paper = k; redraw(); };
  api.blank = () => api.strokes.length === 0;
  // PNG data URL at the given width. A round pad exports a circle with clear corners.
  api.toPng = outW => {
    const o = document.createElement('canvas');
    o.width = outW; o.height = Math.round(outW * c.height / c.width);
    const g = o.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (round) { g.beginPath(); g.arc(o.width / 2, o.height / 2, o.width / 2, 0, Math.PI * 2); g.clip(); }
    g.drawImage(c, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  };
  api.destroy = () => { ro.disconnect(); wrap.onpointerdown = wrap.onpointermove = wrap.onpointerup = wrap.onpointercancel = null; };
  return api;
}
