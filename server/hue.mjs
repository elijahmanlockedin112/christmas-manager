// Philips Hue v1 bridge emulation, so Echo devices discover the Christmas Manager's
// virtual lights ("Alexa, discover devices") with no skill and no cloud.
//
// Echo quirks (from emulated_hue / ha-bridge experience; not all re-verified here):
//  - Echo only talks to the bridge on TCP port 80. Port 80 on the Pi needs root or
//    `sudo setcap cap_net_bind_service=+ep $(which node)`. On Windows we default to disabled.
//  - Discovery is triggered by "Alexa, discover devices" (or the Alexa app > Add Device > Philips Hue).
//    The Echo sends an SSDP M-SEARCH, GETs /description.xml, POSTs /api, then GETs /api/<user>.
//  - Echo caches devices; if names change say "Alexa, forget all devices" in the app, then rediscover.
//  - The server must be on the same LAN/VLAN as the Echo. Tailscale/VPN addresses will not work.
//  - Unreachable/failed PUTs make Alexa say "device isn't responding", so errors are real Hue errors.
//
// Interface: install(app). Tests use createHueHandler(app, opts) which never binds a port.
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SERVER_HEADER = 'FreeRTOS/6.0.5, UPnP/1.0, IpBridge/1.17.0';

// ---------------------------------------------------------------- virtual lights
export const LIGHT_DEFS = [
  { id: '1', name: 'Christmas Tree', color: true },
  { id: '2', name: 'Light Show' },
  { id: '3', name: 'Yule Log' },
  { id: '4', name: 'Party Mode' },
  { id: '5', name: 'Christmas Radio' },
  { id: '6', name: 'Showtime' },
  { id: '7', name: 'Goodnight Tree' },
  // "switches" that put something on the TV: they flip back to off by themselves so they can be used again
  { id: '8', name: 'Santa Tracker', momentary: true },
  { id: '9', name: 'Countdown', momentary: true },
  { id: '10', name: 'Joke Time', momentary: true },
  { id: '11', name: 'Story Time', momentary: true },
  { id: '12', name: 'Trivia Night', momentary: true },
  { id: '13', name: 'Nice List', momentary: true },
  { id: '14', name: 'TV' },
];

export function uniqueIdFor(id) {
  return `00:17:88:01:00:ab:cd:${Number(id).toString(16).padStart(2, '0')}-0b`;
}

// ---------------------------------------------------------------- color conversion
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbToHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);

const gammaOut = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// CIE xy -> sRGB hex at full brightness (brightness is sent separately).
export function xyToHex(x, y) {
  if (!(y > 0)) return '#ffffff';
  const Y = 1, X = (Y / y) * x, Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const m = Math.max(r, g, b) || 1;
  return rgbToHex(gammaOut(r / m) * 255, gammaOut(g / m) * 255, gammaOut(b / m) * 255);
}

// Hue (0..65535) + sat (0..254) at full value -> hex.
export function hsToHex(hue, sat) {
  const h = ((hue / 65535) * 360) % 360, s = Math.max(0, Math.min(1, sat / 254)), v = 1;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Color temperature in mireds (153..500) -> hex (Tanner Helland approximation).
export function ctToHex(ct) {
  const k = 1e6 / Math.max(1, ct) / 100;
  const r = k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  return rgbToHex(r, g, b);
}

// ---------------------------------------------------------------- network helpers
const isTailscale = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
const VIRTUAL_NAME = /tailscale|docker|veth|br-|virbr|vmnet|vethernet|wsl|zerotier|vpn|utun|loopback/i;

// Pick the LAN IPv4: not loopback, not 100.x Tailscale, not link-local.
export function pickLanIp(ifaces = os.networkInterfaces()) {
  let best = null;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      if (a.address.startsWith('127.') || a.address.startsWith('169.254.') || isTailscale(a.address)) continue;
      let score = a.address.startsWith('192.168.') ? 3 : a.address.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0;
      if (VIRTUAL_NAME.test(name)) score -= 5;
      if (!best || score > best.score) best = { ip: a.address, mac: a.mac, netmask: a.netmask, score };
    }
  }
  return best && { ip: best.ip, mac: best.mac, netmask: best.netmask };
}

export function bridgeIdFromMac(mac) {
  let m = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (m.length !== 12 || /^0+$/.test(m)) m = crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 12);
  return (m.slice(0, 6) + 'fffe' + m.slice(6)).toUpperCase();
}

// ---------------------------------------------------------------- SSDP
export function buildSsdpResponse({ ip, port, bridgeId, st, usn }) {
  return [
    'HTTP/1.1 200 OK',
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'EXT:',
    'CACHE-CONTROL: max-age=100',
    `LOCATION: http://${ip}:${port}/description.xml`,
    `SERVER: ${SERVER_HEADER}`,
    `hue-bridgeid: ${bridgeId}`,
    `ST: ${st}`,
    `USN: ${usn}`,
    '', '',
  ].join('\r\n');
}

export const bridgeUuid = (bridgeId) => `2f402f80-da50-11e1-9b23-${bridgeId.slice(0, 6).toLowerCase()}${bridgeId.slice(-6).toLowerCase()}`;

export function parseMSearch(text) {
  const lines = String(text).split(/\r?\n/);
  if (!/^M-SEARCH\s/i.test(lines[0] || '')) return null;
  const h = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if (!/ssdp:discover/i.test(h.man || '')) return null;
  return { st: h.st || '', mx: Number(h.mx) || 1 };
}

// All response datagrams (strings) to send for one M-SEARCH packet. [] = ignore.
export function ssdpReplies(text, { ip, port, bridgeId }) {
  const req = parseMSearch(text);
  if (!req) return [];
  const uuid = bridgeUuid(bridgeId), st = req.st, lc = st.toLowerCase();
  const mk = (s, usn) => buildSsdpResponse({ ip, port, bridgeId, st: s, usn });
  if (lc === 'ssdp:all') {
    return [
      mk('upnp:rootdevice', `uuid:${uuid}::upnp:rootdevice`),
      mk(`uuid:${uuid}`, `uuid:${uuid}`),
      mk('urn:schemas-upnp-org:device:basic:1', `uuid:${uuid}`),
    ];
  }
  if (lc === 'upnp:rootdevice') return [mk(st, `uuid:${uuid}::upnp:rootdevice`)];
  if (lc === 'urn:schemas-upnp-org:device:basic:1') return [mk(st, `uuid:${uuid}`)];
  return [];
}

// ---------------------------------------------------------------- handler (pure, testable)
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, '');
const hueError = (type, address, description) => [{ error: { type, address, description } }];

export function createHueHandler(app, opts = {}) {
  const ip = opts.ip || '127.0.0.1';
  const port = opts.port || 80;
  const mac = opts.mac || '00:00:00:00:00:00';
  const bridgeId = opts.bridgeId || bridgeIdFromMac(mac);
  const log = (...a) => (app.log ? app.log('[hue]', ...a) : undefined);
  const users = new Map();

  // In-memory last-known state per light so Alexa reads back what it set.
  const states = {};
  for (const d of LIGHT_DEFS) {
    states[d.id] = d.color
      ? { on: false, bri: 254, hue: 8418, sat: 140, effect: 'none', xy: [0.4573, 0.41], ct: 366, alert: 'none', colormode: 'ct', mode: 'homeautomation', reachable: true }
      : { on: false, alert: 'none', mode: 'homeautomation', reachable: true };
  }

  function lightJson(d) {
    const base = {
      state: { ...states[d.id] },
      swupdate: { state: 'noupdates', lastinstall: null },
      name: d.name,
      uniqueid: uniqueIdFor(d.id),
      swversion: '1.46.13_r26312',
    };
    if (d.color) {
      return {
        ...base,
        type: 'Extended color light',
        modelid: 'LCT015',
        manufacturername: 'Signify Netherlands B.V.',
        productname: 'Hue color lamp',
        capabilities: {
          certified: true,
          control: { mindimlevel: 1000, maxlumen: 800, colorgamuttype: 'C', colorgamut: [[0.6915, 0.3083], [0.17, 0.7], [0.1532, 0.0475]], ct: { min: 153, max: 500 } },
          streaming: { renderer: false, proxy: false },
        },
        config: { archetype: 'sultanbulb', function: 'mixed', direction: 'omni' },
      };
    }
    return {
      ...base,
      type: 'On/Off plug-in unit',
      modelid: 'LOM001',
      manufacturername: 'Signify Netherlands B.V.',
      productname: 'Hue smart plug',
      capabilities: { certified: true, control: {}, streaming: { renderer: false, proxy: false } },
      config: { archetype: 'classicbulb', function: 'functional', direction: 'omni' },
    };
  }

  const allLights = () => Object.fromEntries(LIGHT_DEFS.map((d) => [d.id, lightJson(d)]));
  const publicConfig = () => ({ name: 'North Pole Hue', datastoreversion: '60', swversion: '1941132040', apiversion: '1.17.0', mac, bridgeid: bridgeId, factorynew: false, replacesbridgeid: null, modelid: 'BSB002' });
  const fullConfig = (user) => ({
    ...publicConfig(),
    zigbeechannel: 15,
    dhcp: true,
    ipaddress: ip,
    netmask: opts.netmask || '255.255.255.0',
    gateway: opts.gateway || ip.replace(/\.\d+$/, '.1'),
    proxyaddress: 'none',
    proxyport: 0,
    UTC: nowIso(),
    localtime: nowIso(),
    timezone: 'UTC',
    whitelist: Object.fromEntries([...users].concat([[user, 'alexa']]).map(([k, v]) => [k, { 'last use date': nowIso(), 'create date': nowIso(), name: typeof v === 'string' ? v : v }])),
    swupdate: { updatestate: 0, checkforupdate: false, devicetypes: { bridge: false, lights: [], sensors: [] }, notify: false, url: '', text: '' },
    swupdate2: { checkforupdate: false, lastchange: nowIso(), bridge: { state: 'noupdates', lastinstall: nowIso() }, state: 'noupdates', autoinstall: { updatetime: 'T14:00:00', on: false } },
    linkbutton: true,
    portalservices: false,
    portalconnection: 'disconnected',
    portalstate: { signedon: false, incoming: false, outgoing: false, communication: 'disconnected' },
    internetservices: { internet: 'connected', remoteaccess: 'disconnected', time: 'connected', swupdate: 'disconnected' },
    backup: { status: 'idle', errorcode: 0 },
  });
  const fullState = (user) => ({ lights: allLights(), groups: {}, config: fullConfig(user), schedules: {}, scenes: {}, rules: {}, sensors: {}, resourcelinks: {} });

  function descriptionXml() {
    const udn = `uuid:${bridgeUuid(bridgeId)}`;
    return `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<URLBase>http://${ip}:${port}/</URLBase>
<device>
<deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType>
<friendlyName>Philips hue (${ip})</friendlyName>
<manufacturer>Royal Philips Electronics</manufacturer>
<manufacturerURL>http://www.philips.com</manufacturerURL>
<modelDescription>Philips hue Personal Wireless Lighting</modelDescription>
<modelName>Philips hue bridge 2015</modelName>
<modelNumber>BSB002</modelNumber>
<modelURL>http://www.meethue.com</modelURL>
<serialNumber>${bridgeId.slice(0, 6).toLowerCase()}${bridgeId.slice(-6).toLowerCase()}</serialNumber>
<UDN>${udn}</UDN>
<presentationURL>index.html</presentationURL>
</device>
</root>
`;
  }

  // Validate + normalise a PUT body; returns {success:[...], changes} or {errors}.
  function parseStateBody(d, body) {
    const success = [], errors = [], c = {};
    const base = `/lights/${d.id}/state/`;
    for (const [k, v] of Object.entries(body || {})) {
      const addr = base + k;
      const num = (lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
      if (k === 'on') {
        if (typeof v !== 'boolean') { errors.push(hueError(7, addr, `invalid value, ${v}, for parameter, on`)[0]); continue; }
        c.on = v;
      } else if (k === 'transitiontime' || k === 'alert' || k === 'effect') {
        // accepted and ignored
      } else if (d.color && k === 'bri') {
        if (typeof v !== 'number') { errors.push(hueError(7, addr, `invalid value, ${v}, for parameter, bri`)[0]); continue; }
        c.bri = Math.max(1, Math.min(254, Math.round(v)));
      } else if (d.color && k === 'bri_inc') {
        if (typeof v !== 'number') continue;
        c.briInc = v;
      } else if (d.color && k === 'hue') {
        if (!num(0, 65535)) { errors.push(hueError(7, addr, `invalid value, ${v}, for parameter, hue`)[0]); continue; }
        c.hue = Math.round(v);
      } else if (d.color && k === 'sat') {
        if (!num(0, 254)) { errors.push(hueError(7, addr, `invalid value, ${v}, for parameter, sat`)[0]); continue; }
        c.sat = Math.round(v);
      } else if (d.color && k === 'xy') {
        if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) { errors.push(hueError(7, addr, `invalid value, ${JSON.stringify(v)}, for parameter, xy`)[0]); continue; }
        c.xy = v;
      } else if (d.color && k === 'ct') {
        if (typeof v !== 'number') { errors.push(hueError(7, addr, `invalid value, ${v}, for parameter, ct`)[0]); continue; }
        c.ct = Math.max(153, Math.min(500, Math.round(v)));
      } else {
        errors.push(hueError(6, addr, `parameter, ${k}, not available`)[0]);
        continue;
      }
      success.push({ success: { [addr]: v } });
    }
    return { success, errors, c };
  }

  async function dispatch(d, c) {
    const st = states[d.id];
    if (d.color) {
      if (c.briInc != null) c.bri = Math.max(1, Math.min(254, (c.bri ?? st.bri) + c.briInc));
      if (c.on !== undefined) st.on = c.on;
      if (c.bri !== undefined) { st.bri = c.bri; }
      let hex;
      if (c.xy) { st.xy = c.xy; st.colormode = 'xy'; hex = xyToHex(c.xy[0], c.xy[1]); }
      else if (c.hue !== undefined || c.sat !== undefined) {
        if (c.hue !== undefined) st.hue = c.hue;
        if (c.sat !== undefined) st.sat = c.sat;
        st.colormode = 'hs'; hex = hsToHex(st.hue, st.sat);
      } else if (c.ct !== undefined) { st.ct = c.ct; st.colormode = 'ct'; hex = ctToHex(c.ct); }
      const args = {};
      if (c.on !== undefined) args.power = c.on;
      if (c.on !== false) {
        if (hex) { args.color = hex; args.effect = 'solid'; }
        if (c.bri !== undefined) args.brightness = Math.round((c.bri / 254) * 1000) / 1000;
      }
      if (Object.keys(args).length) await app.act('lights.set', args);
      return;
    }
    if (c.on === undefined) return;
    st.on = c.on;
    const on = c.on;
    switch (d.id) {
      case '2': await (on ? app.act('show.play', { random: true }) : app.act('show.stop', {})); break;
      case '3':
        if (on) { await app.act('tv.scene', { scene: 'yule' }); await app.act('lights.set', { power: true, effect: 'fireplace' }); }
        else await app.act('tv.scene', { scene: 'home' });
        break;
      case '4': await (on ? app.act('scene.party', {}) : app.act('show.stop', {})); break;
      case '5': await (on ? app.act('radio.play', {}) : app.act('radio.stop', {})); break;
      case '6': await (on ? app.act('scene.showtime', {}) : app.act('show.stop', {})); break;
      case '7': if (on) await app.act('scene.goodnight', {}); break;
      case '8': await app.act(on ? 'tv.scene' : 'tv.scene', { scene: on ? 'santa' : 'home' }); break;
      case '9': await app.act('tv.scene', { scene: on ? 'countdown' : 'home' }); break;
      case '10': if (on) await app.act('joke.tell', { say: false }); break;
      // AI takes a couple of seconds: answer Alexa right away and let the story land on the TV
      case '11': if (on) app.act('ai.story', { read: true }).catch((e) => app.act('tv.message', { text: e.message, from: 'The elves' }).catch(() => { })); break;
      case '12': await (on ? app.act('game.start', { kind: 'trivia' }) : app.act('game.end', {})); break;
      case '13': await app.act('tv.scene', { scene: on ? 'nicelist' : 'home' }); break;
      case '14': await app.act('tv.power', { on }); break;
    }
    if (d.momentary && on) setTimeout(() => { st.on = false; }, 4000);
  }

  const J = (status, obj) => ({ status, type: 'application/json', body: JSON.stringify(obj) });

  // handle({method, path, body}) -> {status, type, body}
  async function handle({ method = 'GET', path = '/', body = '' }) {
    method = method.toUpperCase();
    path = path.split('?')[0].replace(/\/+$/, '') || '/';
    if (method === 'GET' && path === '/description.xml') return { status: 200, type: 'text/xml', body: descriptionXml() };
    const seg = path.split('/').filter(Boolean);
    if (seg[0] !== 'api') return J(404, hueError(1, path, 'unauthorized user'));

    let json;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    if (text.trim()) { try { json = JSON.parse(text); } catch { return J(200, hueError(2, path, 'body contains invalid json')); } }

    if (seg.length === 1) {
      if (method === 'POST') {
        const dt = String(json?.devicetype || 'alexa');
        const username = crypto.createHash('sha1').update(dt).digest('hex').slice(0, 32);
        users.set(username, dt);
        log('paired', dt);
        return J(200, [{ success: { username } }]);
      }
      return J(200, hueError(4, path, 'method, GET, not available for resource, /'));
    }
    const user = seg[1];
    if (seg.length === 2 && user === 'config' && method === 'GET') return J(200, publicConfig());
    if (!users.has(user)) users.set(user, 'alexa');   // accept any user
    const rest = seg.slice(2);
    if (rest.length === 0) return method === 'GET' ? J(200, fullState(user)) : J(200, hueError(4, path, `method, ${method}, not available for resource, /`));
    const res = rest[0];
    if (res === 'config' && method === 'GET') return J(200, fullConfig(user));
    if (['groups', 'schedules', 'scenes', 'rules', 'sensors', 'resourcelinks'].includes(res)) {
      if (method === 'GET' && rest.length === 1) return J(200, {});
      if (res === 'groups' && rest[1] === '0' && method === 'GET') return J(200, { name: 'Group 0', lights: LIGHT_DEFS.map((d) => d.id), type: 'LightGroup', state: { all_on: false, any_on: false }, action: { on: false } });
      return J(200, hueError(3, path, `resource, ${path}, not available`));
    }
    if (res !== 'lights') return J(200, hueError(3, path, `resource, ${path}, not available`));

    if (rest.length === 1) {
      if (method === 'GET') {
        // an Echo listing the lights means "Alexa, discover devices" found us: tick it on the setup checklist
        if (app.state && !app.state.hueSeenAt) {
          app.state.hueSeenAt = Date.now();
          if (app.config && !app.config.setupDone?.hue) { app.config.setupDone = { ...(app.config.setupDone || {}), hue: true }; app.saveConfig?.(); }
          app.changed?.();
        }
        return J(200, allLights());
      }
      if (method === 'POST') return J(200, [{ success: { '/lights': 'Searching for new devices' } }]);
    }
    if (rest.length === 2 && rest[1] === 'new' && method === 'GET') return J(200, { lastscan: 'none' });
    const d = LIGHT_DEFS.find((x) => x.id === rest[1]);
    if (!d) return J(200, hueError(3, path, `resource, ${path}, not available`));
    if (rest.length === 2 && method === 'GET') return J(200, lightJson(d));
    if (rest.length === 2 && method === 'PUT') return J(200, [{ success: { [`/lights/${d.id}/name`]: json?.name || d.name } }]);
    if (rest.length === 3 && rest[2] === 'state' && method === 'PUT') {
      const { success, errors, c } = parseStateBody(d, json);
      try { await dispatch(d, c); }
      catch (e) {
        log('action failed for', d.name, e.message);
        return J(200, hueError(901, path, `internal error, ${e.message}`));
      }
      return J(200, [...success, ...errors]);
    }
    return J(200, hueError(4, path, `method, ${method}, not available for resource, ${path}`));
  }

  return { handle, states, bridgeId, ip, port, mac, descriptionXml };
}

// ---------------------------------------------------------------- install
export async function install(app) {
  if (app.config?.hue?.enabled === false) { app.log('[hue] disabled in config'); return null; }
  const port = Number(process.env.XM_HUE_PORT || (app.onPi ? 80 : 0));
  if (!port) { app.log('[hue] emulation disabled (set XM_HUE_PORT, it is 80 on the Pi)'); return null; }
  const lan = pickLanIp();
  if (!lan) { app.log('[hue] no LAN IPv4 found, emulation disabled'); return null; }

  const h = createHueHandler(app, { ip: lan.ip, port, mac: lan.mac, netmask: lan.netmask });
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size < 65536) chunks.push(c); });
    req.on('end', async () => {
      try {
        const r = await h.handle({ method: req.method, path: new URL(req.url, 'http://x').pathname, body: Buffer.concat(chunks) });
        res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
        res.end(r.body);
      } catch (e) {
        app.log('[hue] request error', e.message);
        res.writeHead(500); res.end();
      }
    });
  });
  server.on('error', (e) => app.log(`[hue] HTTP server error on :${port}: ${e.message}${e.code === 'EACCES' ? ' (port 80 needs root or setcap)' : ''}`));
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  app.log(`[hue] bridge ${h.bridgeId} at http://${lan.ip}:${port}/description.xml`);

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => app.log('[hue] SSDP error:', e.message));
  sock.on('message', (msg, rinfo) => {
    const replies = ssdpReplies(msg.toString('utf8'), { ip: lan.ip, port, bridgeId: h.bridgeId });
    replies.forEach((r, i) => setTimeout(() => sock.send(r, rinfo.port, rinfo.address), 20 + i * 10));
  });
  sock.bind(SSDP_PORT, () => {
    try { sock.addMembership(SSDP_ADDR, lan.ip); app.log('[hue] SSDP listening on 1900'); }
    catch (e) { app.log('[hue] SSDP multicast join failed:', e.message); }
  });

  return { close() { try { server.close(); } catch {} try { sock.close(); } catch {} } };
}
