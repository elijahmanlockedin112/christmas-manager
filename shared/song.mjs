// Turns a carol JSON (see tools/validate-carols.mjs) into a timeline used by three things at once:
// the synth on the TV, the karaoke lyrics, and the light choreography on the server.
// Times are in seconds from the downbeat of the first line; `lead` seconds of count-in come before that.

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitchToMidi(p) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(p);
  if (!m) return null;
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const QUAL = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 14], add9: [0, 4, 7, 14],
};
export function parseChord(name) {
  if (name === 'N') return null;
  const m = /^([A-G])(#|b)?([a-z0-9]*)(?:\/([A-G])(#|b)?)?$/.exec(name);
  if (!m) return null;
  const root = (NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const bass = m[4] ? (NOTE[m[4]] + (m[5] === '#' ? 1 : m[5] === 'b' ? -1 : 0) + 12) % 12 : root;
  return { root, bass, tones: QUAL[m[3]] || QUAL[''], name };
}

// Christmas palette for chords, in order of first appearance (tonic first): red, green, gold, ice blue, rose, teal.
const CHORD_HUES = [0.995, 0.36, 0.12, 0.58, 0.93, 0.47];

export function buildTimeline(song) {
  const spb = 60 / song.bpm;
  const notes = [], chords = [], lines = [];
  let beat = 0;
  let lo = 999, hi = 0;
  const rootOrder = [];
  song.lines.forEach((line, li) => {
    const lineStart = beat;
    const syl = song.instrumental ? [] : String(line.lyrics || '').trim().split(/\s+/).flatMap(w => {
      const parts = w.split('-');
      return parts.map((p, k) => ({ text: p, joinNext: k < parts.length - 1 }));
    }).filter(s => s.text);
    let si = 0;
    const lineSyl = [];
    for (const tok of String(line.melody).trim().split(/\s+/)) {
      if (!tok || tok === '|') continue;
      const [p, b] = tok.split(':');
      const beats = Number(b);
      if (p !== 'R') {
        const midi = pitchToMidi(p);
        lo = Math.min(lo, midi); hi = Math.max(hi, midi);
        const s = syl[si++];
        const note = { t: beat * spb, dur: beats * spb, beat, beats, midi, line: li };
        if (s && s.text !== '_') {
          note.syl = lineSyl.length;
          lineSyl.push({ text: s.text, joinNext: s.joinNext, t: beat * spb, dur: beats * spb });
        } else if (s && s.text === '_' && lineSyl.length) {
          lineSyl[lineSyl.length - 1].dur += beats * spb;
        }
        notes.push(note);
      }
      beat += beats;
    }
    let cb = lineStart;
    for (const tok of String(line.chords).trim().split(/\s+/)) {
      if (!tok || tok === '|') continue;
      const [n, b] = tok.split(':');
      const beats = Number(b);
      const c = parseChord(n);
      if (c) {
        if (!rootOrder.includes(c.root)) rootOrder.push(c.root);
        chords.push({ t: cb * spb, dur: beats * spb, beat: cb, beats, ...c, hue: CHORD_HUES[rootOrder.indexOf(c.root) % CHORD_HUES.length] });
      }
      cb += beats;
    }
    lines.push({ t: lineStart * spb, end: beat * spb, syllables: lineSyl, text: song.instrumental ? '' : line.lyrics });
  });
  const total = beat * spb;
  return {
    id: song.id, title: song.title, by: song.by, year: song.year, mood: song.mood, instrumental: !!song.instrumental,
    bpm: song.bpm, meter: song.meter, spb, lead: song.meter * spb, total, notes, chords, lines, lo, hi,
  };
}

// What the lights should show at time `sec` (seconds from the first downbeat; negative during count-in).
export function lightCue(tl, sec) {
  const beat = Math.floor(sec / tl.spb);
  const cue = {
    active: false, pitch01: 0, vel: 0, chordHue: 0.995, beatPhase: 1, mood: tl.mood, finale: false,
    sec, beat, downbeat: ((beat % tl.meter) + tl.meter) % tl.meter === 0, spb: tl.spb,
    noteIdx: -1, noteStart: 0, chordIdx: -1, chordStart: 0, countIn: sec < 0, progress: Math.max(0, Math.min(1, sec / tl.total)),
  };
  if (sec < 0) {
    const ph = ((sec % tl.spb) + tl.spb) % tl.spb / tl.spb;
    cue.beatPhase = ph;
    cue.chordHue = 0.12;
    return cue;
  }
  cue.beatPhase = (sec / tl.spb) % 1;
  cue.finale = sec > tl.total - tl.spb * tl.meter * 2;
  cue.ended = sec > tl.total;
  // binary search for the sounding note
  let a = 0, b = tl.notes.length - 1, found = null;
  while (a <= b) {
    const m = (a + b) >> 1;
    const n = tl.notes[m];
    if (sec < n.t) b = m - 1;
    else if (sec >= n.t + n.dur) a = m + 1;
    else { found = n; break; }
  }
  if (found) {
    const span = Math.max(7, tl.hi - tl.lo);
    cue.active = true;
    cue.pitch01 = 0.08 + 0.84 * (found.midi - tl.lo) / span;
    const age = sec - found.t;
    cue.vel = Math.max(0.35, 1 - age / Math.max(0.25, found.dur * 1.5));
    cue.noteIdx = tl.notes.indexOf(found);
    cue.noteStart = found.t;
    cue.noteDur = found.dur;
  }
  for (let i = tl.chords.length - 1; i >= 0; i--) if (tl.chords[i].t <= sec) { cue.chordHue = tl.chords[i].hue; cue.chordIdx = i; cue.chordStart = tl.chords[i].t; break; }
  return cue;
}
