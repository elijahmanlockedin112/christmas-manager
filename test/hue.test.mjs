import test from 'node:test';
import assert from 'node:assert/strict';
import { createHueHandler, ssdpReplies, buildSsdpResponse, parseMSearch, pickLanIp, xyToHex, hsToHex, ctToHex, LIGHT_DEFS, install } from '../server/hue.mjs';

function fakeApp() {
  const calls = [];
  const app = {
    calls, config: {}, onPi: false, saveConfig() {}, log() {}, route() {},
    async act(name, args) { calls.push([name, args]); return { ok: true }; },
  };
  return app;
}
const mk = (app) => createHueHandler(app, { ip: '192.168.1.50', port: 80, mac: 'b8:27:eb:12:34:56' });
const req = async (h, method, path, body) => {
  const r = await h.handle({ method, path, body: body === undefined ? '' : JSON.stringify(body) });
  return { ...r, json: JSON.parse(r.body.startsWith('<') ? 'null' : r.body) };
};

test('bridge id is derived from MAC with FFFE inserted', () => {
  assert.equal(mk(fakeApp()).bridgeId, 'B827EBFFFE123456');
});

test('SSDP: parse and reply to the three search targets', () => {
  const info = { ip: '192.168.1.50', port: 80, bridgeId: 'B827EBFFFE123456' };
  const ms = (st) => `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
  assert.deepEqual(parseMSearch(ms('ssdp:all')), { st: 'ssdp:all', mx: 2 });
  assert.equal(ssdpReplies(ms('ssdp:all'), info).length, 3);
  const root = ssdpReplies(ms('upnp:rootdevice'), info);
  assert.equal(root.length, 1);
  assert.match(root[0], /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(root[0], /LOCATION: http:\/\/192\.168\.1\.50:80\/description\.xml\r\n/);
  assert.match(root[0], /SERVER: FreeRTOS\/6\.0\.5, UPnP\/1\.0, IpBridge\/1\.17\.0\r\n/);
  assert.match(root[0], /hue-bridgeid: B827EBFFFE123456\r\n/);
  assert.match(root[0], /ST: upnp:rootdevice\r\n/);
  assert.match(root[0], /USN: uuid:[0-9a-f-]+::upnp:rootdevice\r\n/);
  assert.ok(root[0].endsWith('\r\n\r\n'));
  assert.equal(ssdpReplies(ms('urn:schemas-upnp-org:device:basic:1'), info).length, 1);
  assert.deepEqual(ssdpReplies(ms('urn:something:else'), info), []);
  assert.deepEqual(ssdpReplies('NOTIFY * HTTP/1.1\r\n\r\n', info), []);
  assert.deepEqual(ssdpReplies('M-SEARCH * HTTP/1.1\r\nMAN: "other"\r\nST: ssdp:all\r\n\r\n', info), []);
  assert.match(buildSsdpResponse({ ip: '1.2.3.4', port: 80, bridgeId: 'X', st: 'a', usn: 'b' }), /ST: a\r\nUSN: b/);
});

test('pickLanIp skips loopback, tailscale and link-local', () => {
  const r = pickLanIp({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false, mac: 'aa' }],
    eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false, mac: 'b8:27:eb:12:34:56', netmask: '255.255.255.0' }],
    bad: [{ address: '169.254.1.1', family: 'IPv4', internal: false }],
  });
  assert.equal(r.ip, '192.168.1.50');
  assert.equal(pickLanIp({ ts: [{ address: '100.64.0.1', family: 'IPv4', internal: false }] }), null);
});

test('description.xml', async () => {
  const r = await mk(fakeApp()).handle({ method: 'GET', path: '/description.xml' });
  assert.equal(r.status, 200);
  assert.match(r.body, /<URLBase>http:\/\/192\.168\.1\.50:80\/<\/URLBase>/);
  assert.match(r.body, /Philips hue/);
});

test('POST /api creates a user, GET /api/<user> returns full state', async () => {
  const h = mk(fakeApp());
  const c = await req(h, 'POST', '/api', { devicetype: 'alexa#echo' });
  assert.equal(c.json.length, 1);
  assert.match(c.json[0].success.username, /^[0-9a-f]{32}$/);
  const u = c.json[0].success.username;
  const full = (await req(h, 'GET', `/api/${u}`)).json;
  assert.equal(Object.keys(full.lights).length, LIGHT_DEFS.length);
  assert.equal(full.config.bridgeid, 'B827EBFFFE123456');
  assert.equal(full.config.apiversion, '1.17.0');
  assert.ok(full.config.whitelist[u]);
  // any username is accepted
  assert.equal((await req(h, 'GET', '/api/whatever/lights')).status, 200);
  assert.equal((await req(h, 'GET', '/api/config')).json.modelid, 'BSB002');
});

test('lights list and single light', async () => {
  const h = mk(fakeApp());
  const list = (await req(h, 'GET', '/api/u/lights')).json;
  assert.deepEqual(Object.values(list).map((l) => l.name), ['Christmas Tree', 'Light Show', 'Yule Log', 'Party Mode', 'Christmas Radio', 'Showtime', 'Goodnight Tree', 'Santa Tracker', 'Countdown', 'Joke Time', 'Story Time', 'Trivia Night', 'Nice List', 'TV']);
  // every unique id keeps the Hue format, including the two-digit ones (10 -> 0a)
  for (const l of Object.values(list)) assert.match(l.uniqueid, /^00:17:88:01:00:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}-0b$/);
  assert.equal(list[1].type, 'Extended color light');
  assert.equal(list[2].type, 'On/Off plug-in unit');
  assert.match(list[1].uniqueid, /^00:17:88:01:00:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}-0b$/);
  assert.equal(new Set(Object.values(list).map((l) => l.uniqueid)).size, LIGHT_DEFS.length);
  const one = (await req(h, 'GET', '/api/u/lights/1')).json;
  assert.equal(one.name, 'Christmas Tree');
  assert.equal(one.state.reachable, true);
  assert.equal((await req(h, 'GET', '/api/u/lights/99')).json[0].error.type, 3);
});

test('PUT tree on / off / bri / xy / hs / ct -> lights.set', async () => {
  const app = fakeApp(); const h = mk(app);
  let r = await req(h, 'PUT', '/api/u/lights/1/state', { on: true });
  assert.deepEqual(r.json, [{ success: { '/lights/1/state/on': true } }]);
  assert.deepEqual(app.calls.pop(), ['lights.set', { power: true }]);

  r = await req(h, 'PUT', '/api/u/lights/1/state', { on: true, bri: 127 });
  assert.deepEqual(r.json, [{ success: { '/lights/1/state/on': true } }, { success: { '/lights/1/state/bri': 127 } }]);
  assert.deepEqual(app.calls.pop(), ['lights.set', { power: true, brightness: 0.5 }]);

  await req(h, 'PUT', '/api/u/lights/1/state', { xy: [0.675, 0.322], bri: 254 });
  const [n, a] = app.calls.pop();
  assert.equal(n, 'lights.set');
  assert.match(a.color, /^#[0-9a-f]{6}$/);
  assert.ok(parseInt(a.color.slice(1, 3), 16) > 200 && parseInt(a.color.slice(3, 5), 16) < 90, 'red-ish ' + a.color);
  assert.equal(a.brightness, 1);

  await req(h, 'PUT', '/api/u/lights/1/state', { hue: 25500, sat: 254 });
  assert.match(app.calls.pop()[1].color, /^#[0-9a-f]{6}$/);
  await req(h, 'PUT', '/api/u/lights/1/state', { ct: 500 });
  assert.match(app.calls.pop()[1].color, /^#ff[0-9a-f]{4}$/);

  await req(h, 'PUT', '/api/u/lights/1/state', { on: false });
  assert.deepEqual(app.calls.pop(), ['lights.set', { power: false }]);
  assert.equal((await req(h, 'GET', '/api/u/lights/1')).json.state.on, false);
});

test('state is remembered for readback', async () => {
  const h = mk(fakeApp());
  await req(h, 'PUT', '/api/u/lights/1/state', { on: true, bri: 100, xy: [0.3, 0.3] });
  const s = (await req(h, 'GET', '/api/u/lights/1')).json.state;
  assert.equal(s.on, true); assert.equal(s.bri, 100); assert.deepEqual(s.xy, [0.3, 0.3]); assert.equal(s.colormode, 'xy');
});

test('virtual scene lights map to the right actions', async () => {
  const app = fakeApp(); const h = mk(app);
  const on = (id) => req(h, 'PUT', `/api/u/lights/${id}/state`, { on: true });
  const off = (id) => req(h, 'PUT', `/api/u/lights/${id}/state`, { on: false });
  const take = () => app.calls.splice(0);

  await on(2); assert.deepEqual(take(), [['show.play', { random: true }]]);
  await off(2); assert.deepEqual(take(), [['show.stop', {}]]);
  await on(3); assert.deepEqual(take(), [['tv.scene', { scene: 'yule' }], ['lights.set', { power: true, effect: 'fireplace' }]]);
  await off(3); assert.deepEqual(take(), [['tv.scene', { scene: 'home' }]]);
  await on(4); assert.deepEqual(take(), [['scene.party', {}]]);
  await on(5); assert.deepEqual(take(), [['radio.play', {}]]);
  await off(5); assert.deepEqual(take(), [['radio.stop', {}]]);
  await on(6); assert.deepEqual(take(), [['scene.showtime', {}]]);
  await on(7); assert.deepEqual(take(), [['scene.goodnight', {}]]);
  await on(8); assert.deepEqual(take(), [['tv.scene', { scene: 'santa' }]]);
  await on(9); assert.deepEqual(take(), [['tv.scene', { scene: 'countdown' }]]);
  await on(10); assert.deepEqual(take(), [['joke.tell', { say: false }]]);
  await on(12); assert.deepEqual(take(), [['game.start', { kind: 'trivia' }]]);
  await on(13); assert.deepEqual(take(), [['tv.scene', { scene: 'nicelist' }]]);
  await on(14); assert.deepEqual(take(), [['tv.power', { on: true }]]);
  await off(14); assert.deepEqual(take(), [['tv.power', { on: false }]]);
  assert.equal(LIGHT_DEFS.length, 14);
});

test('errors: bad value, unknown param, failing action, bad json', async () => {
  const app = fakeApp(); const h = mk(app);
  let r = await req(h, 'PUT', '/api/u/lights/1/state', { on: 'yes' });
  assert.equal(r.json[0].error.type, 7);
  r = await req(h, 'PUT', '/api/u/lights/1/state', { nope: 1 });
  assert.equal(r.json[0].error.type, 6);
  assert.equal(app.calls.length, 0);
  app.act = async () => { throw new Error('boom'); };
  r = await req(h, 'PUT', '/api/u/lights/2/state', { on: true });
  assert.equal(r.json[0].error.type, 901);
  r = await h.handle({ method: 'PUT', path: '/api/u/lights/1/state', body: '{bad' });
  assert.equal(JSON.parse(r.body)[0].error.type, 2);
});

test('color converters', () => {
  assert.equal(hsToHex(0, 254), '#ff0000');
  assert.equal(hsToHex(21845, 254), '#00ff00');
  assert.equal(hsToHex(43690, 254), '#0000ff');
  assert.equal(hsToHex(0, 0), '#ffffff');
  assert.match(xyToHex(0.3127, 0.329), /^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/);
  assert.equal(ctToHex(153).length, 7);
});

test('install is disabled with port 0 / config flag (no sockets opened)', async () => {
  const logs = []; const app = { ...fakeApp(), log: (...a) => logs.push(a.join(' ')) };
  delete process.env.XM_HUE_PORT;
  assert.equal(await install(app), null);
  assert.match(logs.join(), /disabled/);
  app.config.hue = { enabled: false };
  process.env.XM_HUE_PORT = '8081';
  assert.equal(await install(app), null);
  delete process.env.XM_HUE_PORT;
});
