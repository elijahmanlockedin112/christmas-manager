// Minimal Chrome DevTools driver (Node 24: global WebSocket + fetch). Used by the e2e checks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ port = 9333 } = {}) {
  const profile = path.join(os.tmpdir(), `np-cdp-${port}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--mute-audio', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--hide-scrollbars', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); }
  }
  return {
    port, proc,
    async page(url, { width = 390, height = 844, mobile = false, scale = 1 } = {}) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const p = new Page(t.webSocketDebuggerUrl);
      await p.ready;
      await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Log.enable');
      await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      if (mobile) { await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); p.mobile = true; }
      await p.goto(url);
      return p;
    },
    async close() { try { proc.kill(); } catch { } await sleep(300); fs.rmSync(profile, { recursive: true, force: true }); },
  };
}

class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.cb = new Map(); this.errors = []; this.logs = [];
    this.ready = new Promise(r => (this.ws.onopen = r));
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.cb.has(m.id)) { const { res, rej } = this.cb.get(m.id); this.cb.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.cb.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.cb.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
    });
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(1500); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed'); return r.result.value; }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
  // real input: find the element's centre, check it's the top element there, then tap it
  async tap(selector) {
    await this.send('Page.bringToFront');
    const pt = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center', behavior:'instant'}); const r = el.getBoundingClientRect(); const x = r.left + r.width/2, y = r.top + r.height/2; const top = document.elementFromPoint(x, y); return { x, y, ok: !!top && (top === el || el.contains(top)) }; })()`);
    if (!pt) throw new Error(`tap: no element ${selector}`);
    if (!pt.ok) throw new Error(`tap: ${selector} is covered at ${Math.round(pt.x)},${Math.round(pt.y)}`);
    if (this.mobile) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    await sleep(350);
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  close() { this.ws.close(); }
}
export { sleep };
