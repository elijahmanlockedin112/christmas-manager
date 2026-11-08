// Plays the real-song preview clip for a Name That Song round on the TV.
// Call syncPreview(state.game, net.now) on every state change.
let audio = null;
let curUrl = null;
let startTimer = null;
let fadeTimer = null;
let wasPaused = false;

function el() {
  if (!audio) { audio = document.createElement('audio'); audio.preload = 'auto'; audio.style.display = 'none'; document.body.appendChild(audio); }
  return audio;
}

function fadeIn(a) {
  clearInterval(fadeTimer);
  a.volume = 0;
  const t0 = performance.now();
  fadeTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / 300);
    a.volume = k;
    if (k >= 1) clearInterval(fadeTimer);
  }, 30);
}

function play(a) {
  fadeIn(a);
  const p = a.play();
  if (p && p.catch) p.catch(() => { });
}

export function stopPreview() {
  clearTimeout(startTimer); startTimer = null;
  clearInterval(fadeTimer);
  curUrl = null; wasPaused = false;
  if (audio) { try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { } }
}

export function syncPreview(game, now = () => Date.now()) {
  const pv = game && game.kind === 'name-that-song' && game.source === 'preview' && (game.phase === 'playing' || game.phase === 'buzzed') ? game.preview : null;
  if (!pv || !pv.url) { if (curUrl || audio?.src) stopPreview(); return; }
  const a = el();
  const fresh = curUrl !== pv.url || curUrl + '|' + pv.startsAt !== a.dataset.key;
  if (fresh) {
    stopPreview();
    curUrl = pv.url;
    a.dataset.key = pv.url + '|' + pv.startsAt;
    a.src = pv.url;
    a.load();
    wasPaused = !!pv.paused;
    if (pv.paused) return;
    const wait = pv.startsAt - now();
    const begin = () => { startTimer = null; if (curUrl === pv.url) play(a); };
    if (wait > 0) startTimer = setTimeout(begin, wait);
    else {
      // joined late: seek to where the clip should be
      const skip = Math.max(0, -wait / 1000);
      a.addEventListener('loadedmetadata', () => { try { a.currentTime = Math.min(skip, (a.duration || 30) - 0.1); } catch { } }, { once: true });
      begin();
    }
    return;
  }
  if (pv.paused && !wasPaused) {
    wasPaused = true;
    clearTimeout(startTimer); startTimer = null;
    clearInterval(fadeTimer);
    a.pause();
  } else if (!pv.paused && wasPaused) {
    wasPaused = false;
    try { a.currentTime = pv.offset || 0; } catch { }
    play(a);
  }
}
