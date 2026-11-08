// Alexa bridge.
//  1. alexa-remote2 (unofficial, full control): play anything by typed command ("play christmas music"),
//     pause/next/volume, speak and announce, read what's playing. One-time Amazon sign-in through its
//     local login proxy; the cookie is saved in data/alexa-cookie.json and refreshed weekly.
//  2. Voice Monkey (official skill, free tier 200 requests/month): announcements + routine triggers.
// Whichever is set up is used; alexa-remote2 wins when both are.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import http from 'node:http';

// The sign-in proxy only speaks http, but Amazon's pages push the browser to https://<pi>:47927/...
// (ERR_SSL_PROTOCOL_ERROR right after typing the email):
//  - their Content-Security-Policy says upgrade-insecure-requests, so the browser upgrades the form post
//  - HSTS headers, and sometimes redirects that point at https://<pi>:47927/
// On the sign-in proxy's responses only: drop those headers and turn such redirects back into http.
let redirectFixFor = '', proxyPortFix = 0;
const FORCE_HTTPS = ['content-security-policy', 'content-security-policy-report-only', 'strict-transport-security'];
export function fixProxyRedirects(httpBase) {
  const httpsBase = httpBase.replace(/^http:/, 'https:');
  proxyPortFix = +(new URL(httpBase).port) || 80;
  if (redirectFixFor === httpsBase) return;
  const first = !redirectFixFor;
  redirectFixFor = httpsBase;
  if (!first) return;
  const fix = v => (typeof v === 'string' && v.startsWith(redirectFixFor) ? 'http' + v.slice(5) : v);
  const orig = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (code, ...rest) {
    try {
      const loc = this.getHeader('location');
      if (loc) this.setHeader('location', fix(loc));
      const onProxy = this.req?.socket?.localPort === proxyPortFix;
      if (onProxy) for (const k of FORCE_HTTPS) this.removeHeader(k);
      for (const h of rest) if (h && typeof h === 'object' && !Array.isArray(h)) for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'location') h[k] = fix(h[k]);
        if (onProxy && FORCE_HTTPS.includes(k.toLowerCase())) delete h[k];
      }
    } catch { /* never break a response */ }
    return orig.call(this, code, ...rest);
  };
}

const require = createRequire(import.meta.url);

export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.') && !a.address.startsWith('169.254')) return a.address;
    }
  }
  return '127.0.0.1';
}

export class AlexaBridge {
  constructor(app) {
    this.app = app;
    this.remote = null;
    this.ready = false;
    this.status = 'off';
    this.error = '';
    this.devices = [];
    this.nowPlaying = null;
    this.cookieFile = path.join(app.dataDir, 'alexa-cookie.json');
    this.pollTimer = null;
  }
  get cfg() { return this.app.config.alexa; }
  get vm() { return this.app.config.voiceMonkey || {}; }
  get vmReady() { return !!(this.vm.token && this.vm.speaker); }
  get device() { return this.cfg.device || this.devices[0]?.serial; }

  publicState() {
    return {
      status: this.status, error: this.error, ready: this.ready, voiceMonkey: this.vmReady,
      devices: this.devices, device: this.device || null, nowPlaying: this.nowPlaying,
      loginUrl: this.status === 'login' ? `http://${this.cfg.proxyIp || lanIp()}:${this.cfg.proxyPort || 47927}/` : null,
    };
  }
  push() { this.app.state.alexa = this.publicState(); this.app.changed(); }

  async start() {
    let Alexa;
    try { Alexa = require('alexa-remote2'); } catch { this.status = 'missing'; this.error = 'alexa-remote2 is not installed (npm install).'; this.push(); return; }
    if (this.remote) { try { this.remote.stop(); } catch { } }
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8')); } catch { }
    const remote = new Alexa();
    this.remote = remote;
    this.status = saved ? 'connecting' : 'login';
    this.error = '';
    this.push();
    remote.on('cookie', () => {
      try { fs.writeFileSync(this.cookieFile, JSON.stringify(remote.cookieData, null, 1)); } catch (e) { this.app.log('alexa cookie save', e.message); }
    });
    const opts = {
      cookie: saved || undefined,
      formerRegistrationData: saved || undefined,
      proxyOnly: true,
      proxyOwnIp: this.cfg.proxyIp || lanIp(),
      proxyPort: this.cfg.proxyPort || 47927,
      proxyLogLevel: 'warn',
      alexaServiceHost: this.cfg.serviceHost || 'pitangui.amazon.com',
      amazonPage: this.cfg.amazonPage || 'amazon.com',
      acceptLanguage: 'en-US',
      useWsMqtt: false,
      usePushConnection: false,
      cookieRefreshInterval: 7 * 24 * 60 * 60 * 1000,
      // sign-in proxy redirects and errors go to the Pi's log (no cookies or passwords are in these lines)
      // only redirect targets and proxy failures: never account data, emails or tokens
      logger: (...a) => { const s = a.join(' '); if (/^(Redirect: Final|Proxy-Error|ERROR:)/.test(s) && !/@|"email"|cookie|token/i.test(s)) this.app.log('[alexa login]', s.replace(/\?.*$/, '').slice(0, 160)); },
    };
    fixProxyRedirects(`http://${opts.proxyOwnIp}:${opts.proxyPort}/`);
    remote.init(opts, err => {
      if (err) {
        const msg = String(err.message || err);
        // While waiting for the user to sign in, alexa-remote2 reports the proxy URL as an "error".
        if (/proxy|open http/i.test(msg)) { this.status = 'login'; this.error = ''; }
        else { this.status = 'error'; this.error = msg.slice(0, 200); }
        this.push();
        return;
      }
      this.ready = true;
      this.status = 'ready';
      this.loadDevices();
      this.push();
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.pollPlayer(), 8000);
    });
  }
  stop() {
    clearInterval(this.pollTimer);
    try { this.remote?.stop?.(); } catch { }
    this.remote = null; this.ready = false; this.status = 'off'; this.push();
  }
  signOut() { this.stop(); try { fs.unlinkSync(this.cookieFile); } catch { } }

  loadDevices() {
    const list = [];
    for (const [serial, d] of Object.entries(this.remote?.serialNumbers || {})) {
      const caps = d.capabilities || [];
      if (!caps.includes('VOLUME_SETTING') && !caps.includes('MUSIC_SKILL') && !caps.includes('AUDIO_PLAYER')) continue;
      list.push({ serial, name: d.accountName || serial, family: d.deviceFamily || '' });
    }
    this.devices = list;
  }

  pollPlayer() {
    if (!this.ready || !this.device) return;
    try {
      this.remote.getPlayerInfo(this.device, (err, res) => {
        if (err || !res?.playerInfo) return;
        const p = res.playerInfo;
        const np = p.infoText ? { title: p.infoText.title || '', artist: p.infoText.subText1 || '', state: p.state || '', art: p.mainArt?.url || '' } : null;
        if (JSON.stringify(np) !== JSON.stringify(this.nowPlaying)) { this.nowPlaying = np; this.push(); }
      });
    } catch { }
  }

  call(fn) {
    return new Promise((resolve, reject) => {
      try { fn((err, res) => (err ? reject(new Error(String(err.message || err))) : resolve(res))); } catch (e) { reject(e); }
    });
  }

  // "Alexa, <cmd>" without saying it out loud.
  async text(cmd, serial) {
    if (this.ready) return this.call(cb => this.remote.sendSequenceCommand(serial || this.device, 'textCommand', String(cmd).toLowerCase(), cb));
    const trig = this.vm.triggers?.[/play/.test(cmd) ? 'music' : ''];
    if (this.vm.token && trig) return this.voiceMonkey('trigger', { device: trig });
    throw new Error('Alexa is not connected.');
  }
  async speak(text, { announce = false, serial } = {}) {
    if (this.ready) return this.call(cb => this.remote.sendSequenceCommand(serial || this.device, announce ? 'announcement' : 'speak', String(text).slice(0, 250), cb));
    if (this.vmReady) return this.voiceMonkey('announce', { device: this.vm.speaker, speech: String(text).slice(0, 400) });
    throw new Error('Alexa is not connected.');
  }
  async command(cmd, value) {
    if (!this.ready) {
      if (cmd === 'pause' || cmd === 'play') return null;
      throw new Error('Alexa is not connected.');
    }
    if (cmd === 'volume') return this.call(cb => this.remote.sendSequenceCommand(this.device, 'volume', Math.max(0, Math.min(100, value | 0)), cb));
    return this.call(cb => this.remote.sendCommand(this.device, cmd, value ?? null, cb));
  }

  async voiceMonkey(kind, params) {
    const url = `https://api-v3.voicemonkey.io/${kind}`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.vm.token}` }, body: JSON.stringify(params) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Voice Monkey: ${j.error || r.status}`);
    return j;
  }
}
