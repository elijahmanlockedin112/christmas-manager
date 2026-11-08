// The Amazon sign-in proxy only speaks http; redirects to https://<pi>:47927/ must come back as http.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixProxyRedirects } from '../server/alexa.mjs';

test('sign-in proxy: Amazon headers that force https are dropped on the proxy port only', async () => {
  const mk = () => http.createServer((req, res) => { res.setHeader('content-security-policy', 'upgrade-insecure-requests'); res.writeHead(200, { 'Strict-Transport-Security': 'max-age=1' }); res.end('ok'); });
  const proxy = mk(), other = mk();
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  fixProxyRedirects(`http://127.0.0.1:${proxy.address().port}/`);
  try {
    const a = await fetch(`http://127.0.0.1:${proxy.address().port}/`);
    assert.equal(a.headers.get('content-security-policy'), null);
    assert.equal(a.headers.get('strict-transport-security'), null);
    const b = await fetch(`http://127.0.0.1:${other.address().port}/`);
    assert.equal(b.headers.get('content-security-policy'), 'upgrade-insecure-requests');
  } finally { proxy.close(); other.close(); }
});

test('https redirects to the sign-in proxy are rewritten to http, others untouched', async () => {
  fixProxyRedirects('http://127.0.0.1:47999/');
  const srv = http.createServer((req, res) => {
    if (req.url === '/a') { res.setHeader('location', 'https://127.0.0.1:47999/www.amazon.com/ap/signin?x=1'); res.writeHead(302); return res.end(); }
    if (req.url === '/b') { res.writeHead(302, { Location: 'https://127.0.0.1:47999/ax/claim' }); return res.end(); }
    res.writeHead(302, { location: 'https://www.amazon.com/ap/signin' }); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const loc = async p => (await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' })).headers.get('location');
  try {
    assert.equal(await loc('/a'), 'http://127.0.0.1:47999/www.amazon.com/ap/signin?x=1');
    assert.equal(await loc('/b'), 'http://127.0.0.1:47999/ax/claim');
    assert.equal(await loc('/c'), 'https://www.amazon.com/ap/signin');
  } finally { srv.close(); }
});
