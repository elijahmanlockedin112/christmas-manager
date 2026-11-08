import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewFor, pickBest } from '../server/previews.mjs';

const hit = { title: 'White Christmas', artist: 'Bing Crosby' };
const good = { trackName: 'White Christmas', artistName: 'Bing Crosby', previewUrl: 'https://x/good.m4a', artworkUrl100: 'https://x/a/100x100bb.jpg' };
const karaoke = { trackName: 'White Christmas (Karaoke)', artistName: 'Bing Crosby', previewUrl: 'https://x/k.m4a' };
const wrongArtist = { trackName: 'White Christmas', artistName: 'Someone Else', previewUrl: 'https://x/w.m4a' };

function fakeFetch(results, counter = { n: 0 }) {
  return async () => { counter.n++; return { ok: true, json: async () => ({ results }) }; };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prev-'));

test('pickBest prefers exact match and rejects karaoke and wrong artist', () => {
  assert.equal(pickBest(hit, [karaoke, wrongArtist, good]), good);
  assert.equal(pickBest(hit, [karaoke, wrongArtist]), null);
  assert.equal(pickBest({ title: "I'll Be Home for Christmas", artist: 'Bing Crosby' }, [{ trackName: "I'll Be Home for Christmas (Remastered)", artistName: 'Bing Crosby', previewUrl: 'u' }]).previewUrl, 'u');
});

test('previewFor returns url and big artwork, then serves from cache', async () => {
  const dir = tmp(), c = { n: 0 };
  const a = await previewFor(hit, { dataDir: dir, fetch: fakeFetch([good], c) });
  assert.deepEqual(a, { url: 'https://x/good.m4a', artwork: 'https://x/a/600x600bb.jpg' });
  const b = await previewFor(hit, { dataDir: dir, fetch: fakeFetch([], c) });
  assert.equal(b.url, a.url);
  assert.equal(c.n, 1);
});

test('misses are cached for a day, then retried', async () => {
  const dir = tmp(), c = { n: 0 };
  let t = 1000;
  assert.equal(await previewFor(hit, { dataDir: dir, fetch: fakeFetch([wrongArtist], c), now: () => t }), null);
  assert.equal(await previewFor(hit, { dataDir: dir, fetch: fakeFetch([good], c), now: () => t + 1000 }), null);
  assert.equal(c.n, 1);
  const r = await previewFor(hit, { dataDir: dir, fetch: fakeFetch([good], c), now: () => t + 25 * 3600 * 1000 });
  assert.equal(r.url, 'https://x/good.m4a');
});

test('network errors never throw and are not cached', async () => {
  const dir = tmp();
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await previewFor(hit, { dataDir: dir, fetch: boom }), null);
  assert.equal(fs.existsSync(path.join(dir, 'previews.json')), false);
  assert.equal(await previewFor(null, {}), null);
});
