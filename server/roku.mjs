// Roku TV control over Wi-Fi (Roku External Control Protocol, port 8060).
// Finds the TV by SSDP ("roku:ecp"), then sends key presses: PowerOn, PowerOff, InputHDMI1-4.
// The TV must allow it: Settings > System > Advanced system settings > Control by mobile apps > Enabled
// (required since Roku OS 14.1; otherwise key presses get HTTP 403).
import dgram from 'node:dgram';
import http from 'node:http';

function request(method, url, timeout = 3000) {
  return new Promise(resolve => {
    const req = http.request(url, { method, timeout }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}
const tag = (xml, t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml) || [])[1] || '';

export class Roku {
  constructor(app) {
    this.app = app;
    this.searching = false;
  }
  get cfg() { return (this.app.config.roku ||= {}); }
  push(extra = {}) {
    const c = this.cfg;
    this.app.state.tv.roku = { found: !!c.host, host: c.host || null, model: c.model || null, piInput: c.piInput || null, allowed: c.allowed ?? null, ...extra };
    this.app.changed();
  }
  discover() {
    if (this.searching) return Promise.resolve(this.cfg.host || null);
    this.searching = true;
    return new Promise(resolve => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const done = async host => {
        try { s.close(); } catch { }
        this.searching = false;
        if (host) {
          const info = await request('GET', `${host}/query/device-info`);
          this.app.config.roku = { ...this.cfg, host, model: `${tag(info.body, 'vendor-name')} ${tag(info.body, 'model-name')}`.trim() };
          this.app.saveConfig();
        }
        this.push();
        resolve(host);
      };
      let found = null;
      s.on('message', m => {
        const loc = /LOCATION:\s*(http:\/\/[^\r\n]+)/i.exec(m.toString());
        if (loc && !found) { found = loc[1].trim().replace(/\/$/, ''); clearTimeout(t); done(found); }
      });
      s.on('error', () => { clearTimeout(t); done(null); });
      const t = setTimeout(() => done(null), 3500);
      s.bind(() => {
        const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 2\r\n\r\n');
        s.send(msg, 1900, '239.255.255.250');
      });
    });
  }
  async key(k) {
    if (!this.cfg.host) await this.discover();
    if (!this.cfg.host) return { ok: false, note: 'No Roku TV found on the Wi-Fi.' };
    const r = await request('POST', `${this.cfg.host}/keypress/${k}`);
    const allowed = r.status === 200 ? true : r.status === 403 ? false : this.cfg.allowed ?? null;
    if (allowed !== this.cfg.allowed) { this.app.config.roku = { ...this.cfg, allowed }; this.app.saveConfig(); this.push(); }
    if (r.status === 403) return { ok: false, note: 'The TV blocked it. On the TV: Settings > System > Advanced system settings > Control by mobile apps > Enabled.' };
    if (r.status !== 200) { this.app.config.roku = { ...this.cfg, host: null }; this.app.saveConfig(); this.push(); return { ok: false, note: "The TV didn't answer. Is it on the Wi-Fi?" }; }
    return { ok: true };
  }
  async activeInput() {
    if (!this.cfg.host) return null;
    const r = await request('GET', `${this.cfg.host}/query/active-app`);
    const m = /id="tvinput\.hdmi(\d)"/i.exec(r.body);
    return m ? Number(m[1]) : null;
  }
  // The TV is showing the Pi right now: remember which HDMI that is.
  async detectPiInput() {
    if (!this.cfg.host) await this.discover();
    const n = await this.activeInput();
    if (!n) return { ok: false, note: "The TV isn't on an HDMI input. Switch it to the Pi with the TV remote, then try again." };
    this.app.config.roku = { ...this.cfg, piInput: n }; this.app.saveConfig(); this.push();
    return { ok: true, piInput: n };
  }
  setPiInput(n) { this.app.config.roku = { ...this.cfg, piInput: Math.max(1, Math.min(4, n | 0)) }; this.app.saveConfig(); this.push(); return { ok: true }; }
  async showPi() { return this.cfg.piInput ? this.key(`InputHDMI${this.cfg.piInput}`) : { ok: false, note: 'Tell me which HDMI input the Pi is on first (TV tab).' }; }
}
