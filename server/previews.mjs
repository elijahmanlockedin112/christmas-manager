// Real 30-second song clips from Apple's free iTunes Search API (no key).
// previewFor(hit, { dataDir, log, fetch }) -> { url, artwork } | null. Never throws.
import fs from 'node:fs';
import path from 'node:path';

const MISS_RETRY_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 4000;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Higher is better; 0 = not a match.
export function scoreResult(hit, r) {
  if (!r || !r.previewUrl) return 0;
  const ht = norm(hit.title), rt = norm(r.trackName);
  const ha = norm(hit.artist), ra = norm(r.artistName);
  if (!ht || !rt) return 0;
  let s = 0;
  if (rt === ht) s += 4;
  else if (rt.includes(ht) || ht.includes(rt)) s += 2;
  else return 0;
  if (ha) {
    if (ra === ha) s += 4;
    else if (ra.includes(ha) || ha.includes(ra)) s += 3;
    else {
      const first = ha.split(' ')[0];
      if (first.length > 2 && ra.includes(first)) s += 1;
      else return 0;
    }
  }
  if (/karaoke|tribute|instrumental|made famous|originally performed|lullaby|cover/i.test(`${r.trackName} ${r.artistName} ${r.collectionName || ''}`)
    && !/karaoke|tribute|instrumental|cover/i.test(`${hit.title} ${hit.artist}`)) return 0;
  return s;
}

export function pickBest(hit, results) {
  let best = null, bs = 0;
  for (const r of results || []) { const s = scoreResult(hit, r); if (s > bs) { bs = s; best = r; } }
  return best;
}

function key(hit) { return norm(`${hit.artist} ${hit.title}`); }

function readCache(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }
function writeCache(file, c) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(c)); } catch { /* cache is best effort */ } }

export async function previewFor(hit, { dataDir, log = () => { }, fetch: fetchFn = globalThis.fetch, now = Date.now } = {}) {
  try {
    if (!hit || !hit.title) return null;
    const file = dataDir ? path.join(dataDir, 'previews.json') : null;
    const k = key(hit);
    const cache = file ? readCache(file) : {};
    const c = cache[k];
    if (c) {
      if (c.url) return { url: c.url, artwork: c.artwork || null };
      if (c.miss && now() - c.miss < MISS_RETRY_MS) return null;
    }
    let result = null, failed = false;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const term = encodeURIComponent(`${hit.artist || ''} ${hit.title}`.trim());
      const res = await fetchFn(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=5&country=US`, { signal: ac.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      result = pickBest(hit, data.results);
    } catch (e) { failed = true; log('previews', `${hit.title}: ${e.message}`); }
    finally { clearTimeout(t); }
    // network errors are not cached as misses, only real "no match" answers are
    if (failed) return null;
    if (result) {
      const out = { url: result.previewUrl, artwork: (result.artworkUrl100 || '').replace('100x100', '600x600') || null };
      if (file) { cache[k] = { ...out, at: now() }; writeCache(file, cache); }
      return out;
    }
    if (file) { cache[k] = { miss: now() }; writeCache(file, cache); }
    return null;
  } catch (e) { try { log('previews', e.message); } catch { } return null; }
}
