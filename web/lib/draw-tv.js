// The TV side of the three drawing games. tv.js hands this module what it shares (state, avatars,
// confetti, sound, the tree) and calls update() whenever the game state changes. Each game keeps its own
// DOM here, so a reveal can animate without being rebuilt by the next state broadcast.
const CORNERS = ['tl', 'tr', 'bl', 'br'].map(c => `<svg class="gcorner ${c}" viewBox="0 0 40 40" aria-hidden="true"><path d="M2 2 H24 C24 13 13 24 2 24 Z" fill="#e9c66b" stroke="#7a4e10" stroke-width="1.3"/><path d="M2 2 H15 C15 9 9 15 2 15 Z" fill="#b8832a"/><circle cx="25" cy="25" r="3.4" fill="#f3d98f" stroke="#7a4e10" stroke-width="1"/></svg>`).join('');
const RIBBON = (txt, cls) => `<div class="ribbon ${cls}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="17" r="13" fill="#e8b23f" stroke="#7a4e10" stroke-width="1.5"/><circle cx="20" cy="17" r="8" fill="none" stroke="#7a4e10" stroke-width="1.2"/><path d="M12 28 L9 39 L20 34 L31 39 L28 28" fill="#c8202a" stroke="#7a4e10" stroke-width="1.2"/></svg><span>${txt}</span></div>`;

export function createDrawTv(ctx) {
  const { esc, avatar, person, confetti, fmt } = ctx;
  const S = () => ctx.S();
  const name = id => person(id)?.name || '?';
  const wallN = n => (n > 5 ? Math.ceil(n / 2) : Math.max(1, n)); // frames per row on the wall
  const frame = (inner, cls = '') => `<div class="gframe ${cls}"><div class="gmat"><div class="gin">${inner}</div></div>${CORNERS}</div>`;
  const faceRow = (x, doneIds, currentId, label) => `<div class="ml-row dg-faces">${S().players.map(p => {
    const done = doneIds.includes(p.id), cur = p.id === currentId;
    return `<div class="ml-p ${done ? 'done' : ''} ${cur ? 'cur' : ''}">${avatar(p, { cls: 'md' })}${done ? ctx.CHK : ''}<b>${esc(p.name)}</b><span class="state">${done ? label[0] : cur ? label[1] : label[2]}</span></div>`;
  }).join('')}</div>`;

  let st = { kind: null, key: '' };
  let orn = null; // the ornament stage (its own DOM + tree)

  function reset() { orn?.destroy(); orn = null; st = { kind: null, key: '' }; }

  // ---------- Ornament Workshop ----------
  class OrnStage {
    constructor(el) {
      this.el = el;
      el.innerHTML = `${ctx.top}<div class="orn-stage"><div class="orn-left"><div class="orn-intro"><div class="ml-lead">Ornament Workshop</div><h1 class="orn-title">Make one for the tree</h1><p class="orn-sub">Tap your face on the iPad and draw a round ornament. It stays on the tree all season, on the home screen too.</p></div><div class="orn-credit" id="ornCredit"></div><div class="orn-count"><b class="num" id="ornN">0</b><span id="ornL">ornaments hung</span></div></div><div class="orn-tree"><canvas></canvas></div></div><div class="orn-fly-host" id="ornFly"></div>`;
      this.tree = ctx.makeTree(el.querySelector('.orn-tree canvas'));
      this.last = null; this.timers = [];
    }
    update(g) {
      const list = S().ornaments || [], m = g.x.moment;
      el_text(this.el, '#ornN', fmt(list.length));
      el_text(this.el, '#ornL', list.length === 1 ? 'ornament hung' : 'ornaments hung');
      if (m && m.id !== this.last) this.moment(m); else if (!m && this.last) { this.last = null; }
      this.tree.setOrnaments(list);
    }
    clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }
    moment(m) {
      this.clearTimers();
      if (this.last) this.tree.showOrnament(this.last);
      this.last = m.id;
      this.tree.hideOrnament(m.id); // it flies in; the tree draws it when it lands
      const host = this.el.querySelector('#ornFly'), p = person(m.pid) || { id: m.pid, name: m.name, color: m.color, photo: m.photo };
      host.innerHTML = `<div class="orn-fly"><div class="orn-wire"></div><div class="orn-cap"></div><img class="orn-ball" src="/api/ornament/${encodeURIComponent(m.id)}.png?v=${m.at}" alt=""></div>`;
      this.el.querySelector('#ornCredit').innerHTML = `<div class="orn-who">${avatar(p, { hat: true, cls: 'md' })}<div><b style="color:${p.color}">${esc(m.name)}</b><span>hung a new ornament on the tree!</span></div></div>`;
      this.el.querySelector('.orn-stage').classList.add('moment'); // the intro steps aside while the ornament swings
      ctx.sound.sfx('chime');
      this.timers.push(setTimeout(() => this.fly(m), 4600));
    }
    fly(m) {
      const fly = this.el.querySelector('.orn-fly'), ball = fly?.querySelector('.orn-ball');
      if (!ball) return;
      const t = this.tree.ornamentTarget(m.slot), b = ball.getBoundingClientRect();
      const dx = t.x - (b.left + b.width / 2), dy = t.y - (b.top + b.height / 2), k = (t.r * 2) / b.width;
      fly.classList.add('flying');
      const a = fly.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 1 }], { duration: 1300, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' });
      a.onfinish = () => {
        this.tree.showOrnament(m.id);
        fly.remove();
        this.el.querySelector('.orn-stage')?.classList.remove('moment');
        ctx.sound.sfx('correct');
        confetti(['#e3ad3a', '#f6eedc', m.color || '#d6312b'], 90);
      };
    }
    destroy() { this.clearTimers(); this.tree.destroy?.(); ctx.detachTree(this.tree); }
  }
  function el_text(root, sel, t) { const e = root.querySelector(sel); if (e && e.textContent !== t) e.textContent = t; }

  // ---------- Portrait Studio ----------
  const subjectFrame = p => `<div class="pframe">${p.photo ? `<img src="/api/player-photo/${encodeURIComponent(p.id)}?v=${p.photo}" alt="">` : avatar(p, { cls: 'lg' })}<div class="pcap">The real ${esc(p.name)}</div></div>`;
  function portraits(el, g, h) {
    const x = g.x;
    if (g.phase === 'draw') {
      const key = `d:${g.round}:${x.done.join()}:${x.current}`;
      if (st.key === key) return; st.key = key;
      const cur = x.current && person(x.current);
      el.innerHTML = h.top + `<div class="dg"><div class="ml-lead">Round ${g.round} of ${g.total}</div><h1 class="dg-h">${cur ? `${esc(cur.name)} is drawing…` : 'Everyone draws somebody else'}</h1><div class="dg-sub">${cur ? 'Someone in this room is being drawn right now. Eyes up here, no peeking at the iPad!' : x.done.length < S().players.length ? 'Tap your face on the iPad. It will secretly tell you who to draw.' : 'All portraits are in. The gallery opens in a moment…'}</div>${cur ? h.timer(x.endsAt) : ''}${faceRow(x, x.done, x.current, ['Handed in', 'Drawing…', 'Waiting'])}</div>` + h.foot;
      return;
    }
    if (g.phase === 'gallery') return gallery(el, g, h);
    if (g.phase === 'vote') {
      const key = `v:${g.round}:${x.voted.join()}`;
      if (st.key === key) return; st.key = key;
      el.innerHTML = h.top + `<div class="dg"><div class="ml-lead">Vote on the iPad</div><h1 class="dg-h sm">Most accurate. Funniest.</h1>${h.timer(g.endsAt)}<div class="wall" style="--n:${wallN(x.entries.length)}">${x.entries.map((e, i) => `<div class="wall-i" style="animation-delay:${i * 90}ms">${frame(`<img src="${e.art}" alt="">`, 'sm')}<div class="wall-n">No. ${e.n}</div></div>`).join('')}</div></div><div class="g-foot"><span class="votes-in">${S().players.map(p => `<i class="${x.voted.includes(p.id) ? 'on' : ''}" style="--c:${p.color}"></i>`).join('')}<em>${x.voted.length} of ${S().players.length} voted. Not for your own!</em></span>${h.teams}</div>`;
      return;
    }
    // reveal
    const key = `r:${g.round}`;
    if (st.key === key) return; st.key = key;
    const w = x.results?.winners || { accurate: [], funny: [] };
    if (!x.entries.length) { el.innerHTML = h.top + `<div class="dg"><h1 class="dg-h">No portraits this time</h1></div>` + h.foot; return; }
    el.innerHTML = h.top + `<div class="dg"><div class="ml-lead">The votes are in</div><div class="wall" style="--n:${wallN(x.entries.length)}">${x.entries.map((e, i) => {
      const acc = w.accurate.includes(e.n), fun = w.funny.includes(e.n), pts = x.gained[e.artist];
      return `<div class="wall-i ${acc || fun ? 'win' : ''}" style="animation-delay:${i * 160}ms">${acc ? RIBBON('Most accurate', 'a') : ''}${fun ? RIBBON('Funniest', 'f') : ''}${frame(`<img src="${e.art}" alt="">`, 'sm')}<div class="wall-n">${esc(name(e.artist))}${pts ? ` <b class="num">+${fmt(pts)}</b>` : ''}</div></div>`;
    }).join('')}</div></div>` + h.foot;
    const win = [...w.funny, ...w.accurate][0];
    if (win) { const e = x.entries.find(q => q.n === win); confetti([person(e.artist)?.color || '#e8b23f', '#f6eedc', '#e8b23f'], 120); }
  }
  function gallery(el, g, h) {
    const x = g.x, e = x.entries[Math.max(0, x.idx)];
    const key = `g:${g.round}:${x.idx}`;
    const sub = person(e.subject) || { id: e.subject, name: '?', color: '#888' }, art = person(e.artist) || { name: '?' };
    if (st.key !== key) {
      st.key = key;
      el.innerHTML = h.top + `<div class="gal"><div class="gal-art">${frame(`<img src="${e.art}" alt="">`, 'xl')}</div><div class="gal-side">${subjectFrame(sub)}<div class="placard"><div class="pl-title">${esc(e.title)}</div><div class="pl-by">${esc(art.name)}, ${esc(e.medium)}</div><div class="pl-k">The critic writes</div><p class="pl-rv" id="plRv"><em class="studying">Studying the work<i>.</i><i>.</i><i>.</i></em></p></div></div></div><div class="g-foot"><span>${x.idx + 1} of ${x.entries.length}</span>${h.teams}</div>`;
    }
    const rv = el.querySelector('#plRv');
    if (rv && e.review && !rv.dataset.on) { rv.dataset.on = '1'; rv.innerHTML = `“${esc(e.review)}”`; rv.classList.add('in'); }
  }

  // ---------- Sketch Telephone ----------
  const card = (step, owner) => {
    const by = person(step.by) || { name: '?' };
    const what = step.kind === 'draw' ? 'drew' : 'guessed';
    const body = step.kind === 'draw' ? (step.art ? `<img src="${step.art}" alt="">` : `<div class="tp-none">(skipped)</div>`) : `<div class="tp-text">${esc(step.text || '(skipped)')}</div>`;
    return `<div class="tp-card ${step.kind}">${body}<div class="tp-by">${avatar(person(step.by) || by, { cls: 'xs' })}<span>${esc(by.name)} ${what}</span></div></div>`;
  };
  function telephone(el, g, h) {
    const x = g.x;
    if (g.phase === 'step') {
      const key = `s:${g.round}:${x.done.join()}:${x.current}`;
      if (st.key === key) return; st.key = key;
      const cur = x.current && person(x.current);
      el.innerHTML = h.top + `<div class="dg"><div class="ml-lead">Step ${x.step} of ${x.of}</div><h1 class="dg-h">${x.kind === 'draw' ? (x.step === 1 ? 'Draw your phrase' : 'Draw what they guessed') : 'Guess the drawing'}</h1><div class="dg-sub">${cur ? `${esc(cur.name)} has the iPad. Everyone else, don't look!` : 'Pass the iPad. Tap your face to see only the step right before yours.'}</div>${cur ? h.timer(x.endsAt) : ''}${faceRow(x, x.done, x.current, ['Done', x.kind === 'draw' ? 'Drawing…' : 'Guessing…', 'Waiting'])}</div>` + h.foot;
      return;
    }
    if (g.phase === 'reveal') {
      const c = x.chains[x.ci], key = `r:${x.ci}:${x.show}:${x.cmp}`;
      if (st.key === key) return; st.key = key;
      const owner = person(c.owner) || { name: '?' };
      const head = `<div class="tp-head"><span class="ml-lead">Chain ${x.ci + 1} of ${x.chains.length}</span><span class="tp-own">${avatar(person(c.owner) || owner, { cls: 'xs' })} started by ${esc(owner.name)}</span></div>`;
      const shown = c.steps.slice(0, Math.max(0, x.show - 1));
      if (x.cmp) {
        const last = shown[shown.length - 1];
        el.innerHTML = h.top + `<div class="tp">${head}<div class="tp-cmp"><div class="tp-side"><div class="ml-lead">It started as</div><div class="tp-quote">“${esc(c.prompt)}”</div></div><div class="tp-vs">became</div><div class="tp-side end">${last ? `<div class="ml-lead">It ended as</div>${last.kind === 'draw' ? (last.art ? `<div class="tp-final"><img src="${last.art}" alt=""></div>` : '<div class="tp-quote">(a blank page)</div>') : `<div class="tp-quote">“${esc(last.text || '?')}”</div>`}<div class="tp-by">${avatar(person(last.by) || { name: '?' }, { cls: 'xs' })}<span>${esc(name(last.by))} ${last.kind === 'draw' ? 'drew' : 'guessed'}</span></div>` : ''}</div></div></div>` + h.foot;
        return;
      }
      const prev = x.show > 1 ? shown[shown.length - 1] : null;
      const cur = x.show === 1 ? null : prev;
      const stage = !cur
        ? `<div class="tp-stage first"><div class="ml-lead">It begins with</div><div class="tp-quote big">“${esc(c.prompt)}”</div></div>`
        : `<div class="tp-then">and then…</div><div class="tp-stage">${cur.kind === 'draw' ? (cur.art ? `<div class="tp-final"><img src="${cur.art}" alt=""></div>` : '<div class="tp-quote">(a blank page)</div>') : `<div class="tp-quote big">“${esc(cur.text || '?')}”</div>`}<div class="tp-by lg">${avatar(person(cur.by) || { name: '?' }, { cls: 'md' })}<span>${esc(name(cur.by))} ${cur.kind === 'draw' ? 'drew it' : 'guessed'}</span></div></div>`;
      const strip = `<div class="tp-strip"><div class="tp-mini start"><em>${esc(c.prompt)}</em></div>${shown.map((s, i) => `<div class="tp-mini ${i === shown.length - 1 ? 'now' : ''}">${s.kind === 'draw' ? (s.art ? `<img src="${s.art}" alt="">` : '<em>skipped</em>') : `<em>${esc(s.text || '?')}</em>`}</div>`).join('')}</div>`;
      el.innerHTML = h.top + `<div class="tp">${head}${stage}${strip}</div>` + h.foot;
      return;
    }
    if (g.phase === 'vote') {
      const key = `v:${x.voted.join()}`;
      if (st.key === key) return; st.key = key;
      el.innerHTML = h.top + `<div class="dg"><div class="ml-lead">Vote on the iPad</div><h1 class="dg-h sm">Which was your favourite moment?</h1>${h.timer(g.endsAt)}<div class="tp-recap">${x.chains.map(c => { const last = c.steps[c.steps.length - 1]; return `<div class="tp-line"><span class="a">“${esc(c.prompt)}”</span><i>→</i><span class="b">${last?.art ? `<img src="${last.art}" alt="">` : `“${esc(last?.text || '?')}”`}</span></div>`; }).join('')}</div></div><div class="g-foot"><span class="votes-in">${S().players.map(p => `<i class="${x.voted.includes(p.id) ? 'on' : ''}" style="--c:${p.color}"></i>`).join('')}<em>${x.voted.length} of ${S().players.length} voted.</em></span>${h.teams}</div>`;
      return;
    }
    // verdict
    const key = 'x:' + JSON.stringify(x.counts);
    if (st.key === key) return; st.key = key;
    const wm = x.winners[0], f = x.furthest;
    let win = '';
    if (wm) { const [ci, si] = wm.split('.').map(Number); const stp = x.chains[ci].steps[si]; win = `<div class="tp-win"><div class="ml-lead">Favourite moment, ${x.counts[wm]} ${x.counts[wm] === 1 ? 'vote' : 'votes'}</div>${card(stp)}</div>`; }
    el.innerHTML = h.top + `<div class="dg"><h1 class="dg-h">${wm ? 'The family has spoken' : 'No favourite this time'}</h1><div class="tp-verdict">${win}${f ? `<div class="tp-far"><div class="ml-lead">The chain that went the furthest</div><div class="tp-quote">“${esc(f.from)}”</div><div class="tp-vs">became</div><div class="tp-quote">“${esc(f.to)}”</div></div>` : ''}</div></div>` + h.foot;
    if (wm) confetti(['#e8b23f', '#f6eedc', person(x.chains[+wm.split('.')[0]].steps[+wm.split('.')[1]].by)?.color || '#d6312b'], 120);
  }

  // called by tv.js for every state change while a drawing game is on (any phase but lobby/final)
  function update(el, g, h) {
    if (st.kind !== g.kind) { reset(); st.kind = g.kind; el.innerHTML = ''; }
    if (g.kind === 'ornaments') {
      if (!orn) { ctx.top = h.top; orn = new OrnStage(el); ctx.attachTree(orn.tree); }
      return orn.update(g);
    }
    if (g.kind === 'portraits') return portraits(el, g, h);
    return telephone(el, g, h);
  }
  return { update, reset };
}
