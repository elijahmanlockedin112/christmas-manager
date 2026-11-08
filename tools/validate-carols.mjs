// Validates every song in shared/carols/*.json. Run: node tools/validate-carols.mjs [file ...]
// Format (one file per song):
// {
//   "id": "jingle-bells", "title": "Jingle Bells", "by": "James Lord Pierpont", "year": 1857,
//   "bpm": 116, "meter": 4, "instrumental": false, "mood": "bright" | "gentle" | "grand" | "mysterious",
//   "lines": [
//     { "melody": "E4:1 E4:1 E4:2 | E4:1 E4:1 E4:2", "chords": "C:4 | C:4", "lyrics": "Jin-gle bells, jin-gle bells" }
//   ]
// }
// melody tokens: PITCH:BEATS  (PITCH = C4..C6 with # or b, e.g. F#4, Bb3; R = rest). BEATS may be 0.5, 1.5, 0.25, 0.75, 3 ...
//   "|" bar lines are optional and ignored by the player, but checked here: each full bar must sum to `meter` beats
//   (the first bar of a line may be a short pickup, the last bar may be short).
// chords tokens: NAME:BEATS where NAME is C, Cm, C7, Cmaj7, Cm7, Cdim, Csus4, F#m, Bb, ... or N (no chord). "|" allowed.
//   Sum of chord beats must equal sum of melody beats for the line.
// lyrics: syllables separated by spaces or hyphens; exactly one syllable per non-rest note.
//   Use "_" as a syllable for a held/slurred extra note (melisma). Punctuation stays attached to its syllable.
//   Instrumental songs use "" for lyrics on every line.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'shared', 'carols');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));

const PITCH = /^(R|[A-G](#|b)?[2-6])$/;
const CHORD = /^(N|[A-G](#|b)?(m|7|maj7|m7|dim|aug|sus2|sus4|6|m6|9|add9)?(\/[A-G](#|b)?)?)$/;
let bad = 0;
const ids = new Set();

function midi(p) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(p);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  return 12 * (Number(m[3]) + 1) + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

for (const f of files) {
  const errs = [];
  let song;
  try { song = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`FAIL ${path.basename(f)}: bad JSON ${e.message}`); bad++; continue; }
  for (const k of ['id', 'title', 'by', 'bpm', 'meter', 'lines', 'mood']) if (song[k] === undefined) errs.push(`missing ${k}`);
  if (ids.has(song.id)) errs.push(`duplicate id ${song.id}`);
  ids.add(song.id);
  if (path.basename(f) !== `${song.id}.json`) errs.push(`file name must be ${song.id}.json`);
  if (!(song.bpm >= 40 && song.bpm <= 220)) errs.push('bpm out of range');
  let totalBeats = 0, lo = 999, hi = 0;
  (song.lines || []).forEach((line, i) => {
    const where = `line ${i + 1}`;
    const mel = String(line.melody || '').trim().split(/\s+/).filter(Boolean);
    let bars = [[]];
    const notes = [];
    for (const t of mel) {
      if (t === '|') { bars.push([]); continue; }
      const [p, b] = t.split(':');
      const beats = Number(b);
      if (!PITCH.test(p) || !(beats > 0)) { errs.push(`${where}: bad melody token "${t}"`); continue; }
      if (p !== 'R') { const m = midi(p); lo = Math.min(lo, m); hi = Math.max(hi, m); }
      notes.push({ p, beats });
      bars[bars.length - 1].push(beats);
    }
    bars = bars.filter(b => b.length);
    bars.forEach((b, j) => {
      const s = b.reduce((a, x) => a + x, 0);
      const edge = j === 0 || j === bars.length - 1;
      if (Math.abs(s - song.meter) > 1e-6 && !(edge && s < song.meter)) errs.push(`${where}: bar ${j + 1} has ${s} beats (meter ${song.meter})`);
    });
    const melBeats = notes.reduce((a, n) => a + n.beats, 0);
    const ch = String(line.chords || '').trim().split(/\s+/).filter(t => t && t !== '|');
    let chBeats = 0;
    for (const t of ch) {
      const [n, b] = t.split(':');
      if (!CHORD.test(n) || !(Number(b) > 0)) errs.push(`${where}: bad chord token "${t}"`);
      chBeats += Number(b) || 0;
    }
    if (Math.abs(chBeats - melBeats) > 1e-6) errs.push(`${where}: chords ${chBeats} beats vs melody ${melBeats}`);
    const sung = notes.filter(n => n.p !== 'R').length;
    if (!song.instrumental) {
      const syl = String(line.lyrics || '').trim().split(/[\s-]+/).filter(Boolean);
      if (syl.length !== sung) errs.push(`${where}: ${syl.length} syllables vs ${sung} notes  [${line.lyrics}]`);
    }
    totalBeats += melBeats;
  });
  if (lo < midi('F3') || hi > midi('C6')) errs.push(`melody range ${lo}-${hi} outside F3..C6`);
  const secs = totalBeats * 60 / (song.bpm || 1);
  if (secs < 25) errs.push(`only ${secs.toFixed(0)} s long`);
  if (errs.length) { bad++; console.log(`FAIL ${path.basename(f)}\n  ` + errs.slice(0, 25).join('\n  ')); }
  else console.log(`ok   ${path.basename(f)}  ${song.lines.length} lines, ${secs.toFixed(0)} s`);
}
process.exit(bad ? 1 : 0);
