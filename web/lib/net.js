// Live link to the North Pole server: state, clock sync, actions, LED frames. Reconnects forever.
export function connect({ role = 'remote', pid = null, frames = false, onState, onFrame, onMessage, onStatus } = {}) {
  let ws = null, seq = 0, offset = 0, bestRtt = 1e9, alive = false, closedByUs = false;
  const pending = new Map();
  const net = {
    state: null,
    get offset() { return offset; },
    now: () => Date.now() + offset,          // server clock, ms
    get connected() { return alive; },
    act(name, args = {}) {
      return new Promise((resolve, reject) => {
        if (!alive) {
          // fall back to HTTP so taps still work while the socket reconnects
          fetch(`/api/act/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
            .then(r => r.json()).then(j => (j.error ? reject(new Error(j.error)) : resolve(j))).catch(reject);
          return;
        }
        const id = ++seq;
        pending.set(id, { resolve, reject, t: setTimeout(() => { pending.delete(id); reject(new Error('Timed out')); }, 20000) });
        ws.send(JSON.stringify({ type: 'act', id, name, args }));
      });
    },
    send(msg) { if (alive) ws.send(JSON.stringify(msg)); },
    setFrames(on) { frames = on; net.send({ type: 'frames', on }); },
    close() { closedByUs = true; ws?.close(); },
  };
  function sync() { if (alive) ws.send(JSON.stringify({ type: 'ping', c: performance.now() })); }
  function open() {
    const q = new URLSearchParams({ role });
    if (pid) q.set('pid', pid);
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      alive = true; bestRtt = 1e9; onStatus?.(true);
      if (frames) ws.send(JSON.stringify({ type: 'frames', on: true }));
      for (let i = 0; i < 6; i++) setTimeout(sync, i * 250);
    };
    ws.onclose = () => {
      alive = false; onStatus?.(false);
      for (const p of pending.values()) { clearTimeout(p.t); p.reject(new Error('Disconnected')); }
      pending.clear();
      if (!closedByUs) setTimeout(open, 1200);
    };
    ws.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) {
        const v = new Uint8Array(ev.data);
        if (v[0] === 1) onFrame?.(v.subarray(3), (v[1] << 8) | v[2]);
        return;
      }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'pong') {
        const rtt = performance.now() - m.c;
        if (rtt < bestRtt + 5) { bestRtt = Math.min(bestRtt, rtt); offset = m.s + rtt / 2 - Date.now(); }
        return;
      }
      if (m.type === 'state') { net.state = m.state; onState?.(m.state); return; }
      if (m.type === 'result') {
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id); clearTimeout(p.t);
        m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
        return;
      }
      onMessage?.(m);
    };
  }
  open();
  setInterval(sync, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (!alive && ws?.readyState === 3) open(); else sync(); } });
  return net;
}

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function pid() {
  let id = null;
  try { id = localStorage.getItem('np-pid'); } catch { }
  if (!id) { id = Math.random().toString(36).slice(2, 10); try { localStorage.setItem('np-pid', id); } catch { } }
  return id;
}
