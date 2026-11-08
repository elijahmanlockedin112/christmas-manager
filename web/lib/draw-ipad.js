// The iPad side of the three drawing games (Ornament Workshop, Portrait Studio, Sketch Telephone).
// app.js hands this module the pieces it shares (state, act, face, ...) and calls host() to fill the
// game panel. While a pad is on screen, live() tells app.js not to rebuild the panel under a pencil.
import { makePad, THIN, THICK } from '/web/lib/pad.js';
import { icon } from '/web/lib/icons.js';

const PAL = ['#14281d', '#d6312b', '#1f9a52', '#d4a21f', '#3a7be0', '#e8743b', '#8a5a2b', '#d94f8c'];
const ORN_PAL = ['#d6312b', '#1f9a52', '#d4a21f', '#aeb8c0', '#3a7be0', '#14281d', '#f6efe0', '#d94f8c'];
const BALLS = [['Cream', '#f6efe0'], ['Midnight', '#1b2745'], ['Cranberry', '#8f1d24'], ['Pine', '#18402b']];
const dateOf = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function createDrawIpad(ctx) {
  const { ui, act, toast, face, facePick, esc, net, personOf, redo } = ctx;
  const S = () => ctx.S();
  const q = s => document.querySelector(s);
  ui.dd = { active: false };
  ui.dv = { acc: null, fun: null, moment: null };
  ui.ddKey = '';

  function leave() {
    const d = ui.dd;
    d?.pad?.destroy(); clearTimeout(d?.clock); clearTimeout(d?.peekT);
    ui.dd = { active: false };
    document.body.classList.remove('dd-on');
  }
  // true while a pad (or a guess box) is on screen for the current round: do not rebuild the panel
  function live(g) {
    const d = ui.dd;
    if (!d?.active || !q('#ddLive')) return false; // nothing mounted yet: a render is about to mount it
    const ok = g && g.kind === d.kind && g.round === d.round && ['workshop', 'draw', 'step'].includes(g.phase) && q('#ddLive');
    if (!ok) { leave(); return false; }
    return true;
  }

  // ---------- pieces ----------
  const timerBar = endsAt => (endsAt ? `<div class="seat-timer"><i style="animation-duration:${Math.max(0, endsAt - net.now())}ms"></i></div>` : '');
  const toolsHtml = (pal, col, w) => `<div class="dd-tools">
    <div class="dd-chips">${pal.map(k => `<button class="chip${k === col ? ' on' : ''}" data-k="${k}" style="background:${k}" aria-label="Colour ${k}"></button>`).join('')}</div>
    <div class="dd-sizes"><button class="dd-size${w === THIN ? ' on' : ''}" data-w="${THIN}" aria-label="Thin brush"><i style="width:7px;height:7px"></i></button><button class="dd-size${w === THICK ? ' on' : ''}" data-w="${THICK}" aria-label="Thick brush"><i style="width:20px;height:20px"></i></button></div>
    <button class="btn" id="ddUndo">Undo</button><button class="btn" id="ddClear">Clear</button></div>`;

  // Mounts a pad inside the panel and wires its tools. opts: round, paper, pal, onTime (called when the clock runs out).
  function mountPad(body, { round = false, paper = '#fbf5e9', pal = PAL, color = pal[0], endsAt = 0, onTime }) {
    document.body.classList.add('dd-on');
    const host = body.querySelector('#padHost');
    const pad = makePad(host, { round, paper, color, width: THIN, sawPen: () => ui.sawPen, onPen: () => (ui.sawPen = true) });
    ui.dd.pad = pad;
    const tools = body.querySelector('#ddTools');
    let col = color, w = THIN;
    const paint = () => { tools.innerHTML = toolsHtml(pal, col, w); };
    paint();
    tools.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'ddUndo') return pad.undo();
      if (b.id === 'ddClear') return pad.clear();
      if (b.dataset.k) { col = b.dataset.k; pad.setColor(col); }
      if (b.dataset.w) { w = +b.dataset.w; pad.setWidth(w); }
      paint();
    };
    if (endsAt) ui.dd.clock = setTimeout(() => onTime?.(), Math.max(0, endsAt - net.now()));
    return pad;
  }

  const whoLine = (p, label, extra = '') => `<div class="dd-head">${face(p, 52)}<div class="grow"><div class="host-meta">${label}</div><b class="dd-name" style="color:${p.color}">${esc(p.name)}</b></div>${extra}</div>`;
  const padFrame = (head, mid = '') => `<div id="ddLive" class="dd-live">${head}${mid}<div id="padHost" class="dd-padhost"></div><div id="ddTools"></div>`; // the caller adds its buttons and closes the root
  const waitLine = (n, of, what = 'done') => `<div class="host-meta" style="text-align:center;margin-top:14px">${n} of ${of} ${what}</div>`;

  // ---------- Ornament Workshop ----------
  function ornamentManager() {
    const list = [...(S().ornaments || [])].reverse();
    return `<div class="orn-list"><div class="sec-head" style="margin-top:22px"><h2>On the tree</h2><span class="aside">${list.length} hung${list.length >= 40 ? ' (the latest 40 are drawn)' : ''}</span></div>
      ${list.length ? `<div class="rows">${list.map(o => `<div class="row" style="min-height:64px"><img class="orn-thumb" src="/api/ornament/${encodeURIComponent(o.id)}.png?v=${o.at}" alt=""><div class="grow"><div class="t">${esc(o.name)}'s ornament</div><div class="s">Hung ${dateOf(o.at)}</div></div><button class="px" data-orn-del="${esc(o.id)}" aria-label="Take ${esc(o.name)}'s ornament off the tree">${icon('x')}</button></div>`).join('')}</div>` : '<p class="hint">Nothing hung yet. Ornaments stay on the tree all season.</p>'}</div>`;
  }
  function bindOrnaments(root) {
    root.querySelectorAll('[data-orn-del]').forEach(b => (b.onclick = () => {
      const o = (S().ornaments || []).find(x => x.id === b.dataset.ornDel);
      if (!confirm(`Take ${o ? o.name + "'s" : 'this'} ornament off the tree for good?`)) return;
      act('ornament.remove', { id: b.dataset.ornDel }, 'Ornament removed').catch(() => { });
    }));
  }

  function ornaments(g, title, body, btns) {
    title.textContent = 'Ornament Workshop';
    btns.innerHTML = '<button class="btn" id="gEnd">Finish</button>';
    q('#gEnd').onclick = () => { leave(); act('game.end'); };
    const d = ui.dd;
    if (d.active && d.kind === 'ornaments') {
      const p = personOf(d.pid);
      body.innerHTML = padFrame(whoLine(p, 'Draw your ornament', `<div class="dd-balls" id="ddBalls">${BALLS.map(([n, k], i) => `<button class="ball${i === 0 ? ' on' : ''}" data-ball="${k}" style="--c:${k}" aria-label="${n} ball"></button>`).join('')}</div>`)) +
        `<div class="dd-go"><button class="btn primary big" id="ddDone">Hang it on the tree</button><button class="btn ghost big" id="ddBack">Back</button></div></div>`;
      const pad = mountPad(body, { round: true, paper: BALLS[0][1], pal: ORN_PAL, color: ORN_PAL[0] });
      body.querySelectorAll('[data-ball]').forEach(b => (b.onclick = () => { pad.setPaper(b.dataset.ball); body.querySelectorAll('[data-ball]').forEach(x => x.classList.toggle('on', x === b)); }));
      q('#ddBack').onclick = () => { leave(); redo(); };
      q('#ddDone').onclick = async () => {
        if (pad.blank()) return toast('Draw something first', true);
        q('#ddDone').disabled = true;
        try { await act('game.ornamentHang', { pid: d.pid, png: pad.toPng(256) }); leave(); toast('Hung! Look at the TV.'); redo(); }
        catch { q('#ddDone') && (q('#ddDone').disabled = false); }
      };
      return;
    }
    const busy = g.x.moment ? `<p class="host-meta" style="margin:0 0 10px">${esc(g.x.moment.name)}'s ornament is going up on the TV…</p>` : '';
    body.innerHTML = `${busy}<div class="plead">A keepsake, not a contest</div><div class="host-q big">Make an ornament for the tree.</div><div class="host-meta" style="margin:6px 0 14px">Tap your face, then draw on the round ornament. It hangs on the tree all season.</div><div class="pgrid">${S().players.map(p => facePick(p, 'data-orn')).join('')}</div>${ornamentManager()}`;
    body.querySelectorAll('[data-orn]').forEach(b => (b.onclick = () => { ui.dd = { active: true, kind: 'ornaments', pid: b.dataset.orn, round: g.round }; redo(); }));
    bindOrnaments(body);
  }

  // ---------- Portrait Studio ----------
  function portraitPad(g, body, r) {
    const p = personOf(ui.dd.pid), sub = r.subject;
    ui.dd.endsAt = r.endsAt;
    const ghost = { ...sub, photo: 0 };
    const hint = r.canHint ? `<button class="btn" id="ddHint"${r.hinted ? ' disabled' : ''}>Peek at their photo</button>` : '';
    body.innerHTML = padFrame(`<div class="dd-head">${face(ghost, 52)}<div class="grow"><div class="host-meta">${esc(p.name)}, draw</div><b class="dd-name" style="color:${sub.color}">${esc(sub.name)}</b></div>${hint}</div>`, timerBar(r.endsAt)) +
      `<div class="dd-go"><button class="btn primary big" id="ddDone">I'm done</button></div></div>`;
    const send = async skip => {
      const pad = ui.dd.pad; if (!pad) return;
      const png = skip || pad.blank() ? null : pad.toPng(720);
      try { await act('game.drawSubmit', png ? { pid: p.id, png } : { pid: p.id, skip: true }); leave(); toast('Handed in. Pass the iPad on.'); redo(); }
      catch { redo(); }
    };
    const pad = mountPad(body, { endsAt: r.endsAt, onTime: () => send(false) });
    // the pad is sized by CSS; the photo peek sits over it
    q('#ddDone').onclick = () => { if (pad.blank()) return toast('Draw something first, or wait for the clock', true); send(false); };
    const hb = q('#ddHint');
    if (hb) hb.onclick = async () => {
      hb.disabled = true;
      try {
        const h = await act('game.portraitHint', { pid: p.id });
        const wrap = body.querySelector('.dpad');
        const img = document.createElement('img'); img.className = 'dd-peek'; img.alt = ''; img.src = `/api/player-photo/${encodeURIComponent(h.id)}?v=${h.photo}`;
        wrap.appendChild(img);
        ui.dd.peekT = setTimeout(() => img.remove(), 3000);
      } catch { }
    };
  }
  function portraits(g, title, body, scoreline) {
    const x = g.x || {};
    title.textContent = 'Portrait Studio';
    const d = ui.dd;
    if (g.phase === 'draw') {
      if (d.active && d.kind === 'portraits' && d.sub) return portraitPad(g, body, d.sub);
      const left = S().players.filter(p => !x.done.includes(p.id));
      if (d.confirm && left.some(p => p.id === d.confirm)) {
        const p = personOf(d.confirm);
        body.innerHTML = `<div class="seat">${face(p, 140)}<div class="seat-name" style="color:${p.color}">${esc(p.name)}, you draw in secret</div><div class="host-meta">Pass the iPad to ${esc(p.name)}. Everyone else, look at the TV. You get ${x.secs} seconds.</div><button class="btn primary seat-go" id="ddShow">Show me who</button><button class="btn ghost" id="ddNot">Not me</button></div>`;
        q('#ddNot').onclick = () => { ui.dd = { active: false }; redo(); };
        q('#ddShow').onclick = async () => {
          try { const r = await act('game.drawStart', { pid: p.id }); ui.dd = { active: true, kind: 'portraits', pid: p.id, round: g.round, sub: r }; redo(); }
          catch { ui.dd = { active: false }; redo(); }
        };
        return;
      }
      body.innerHTML = `<div class="plead">Round ${g.round} of ${g.total}</div><div class="host-q big">Everyone draws somebody else.</div><div class="host-meta" style="margin:6px 0 14px">${left.length ? 'Tap your face. You will secretly be told who to draw, then get 75 seconds. One person at a time.' : 'Everyone has drawn. The gallery opens on the TV…'}</div><div class="pgrid">${left.map(p => facePick(p, 'data-pdraw')).join('')}</div>${waitLine(x.done.length, S().players.length)}`;
      body.querySelectorAll('[data-pdraw]').forEach(b => (b.onclick = () => { ui.dd = { active: false, confirm: b.dataset.pdraw }; redo(); }));
      return;
    }
    if (g.phase === 'gallery') {
      const e = x.entries[Math.max(0, x.idx)];
      title.textContent = e ? `${e.title}` : 'The gallery';
      body.innerHTML = `<div class="seat"><div class="seat-name">The gallery is open</div><div class="host-meta">Look at the TV. Painting ${Math.max(1, x.idx + 1)} of ${x.entries.length}. Next skips ahead.</div></div>`;
      return;
    }
    if (g.phase === 'vote') {
      const left = S().players.filter(p => !x.voted.includes(p.id));
      const v = ui.dv;
      if (v.voter && !left.some(p => p.id === v.voter)) v.voter = null;
      if (v.voter) {
        const me = personOf(v.voter);
        const pool = x.entries.filter(e => e.artist !== me.id);
        const row = (key, label) => `<div class="plead" style="margin-top:14px">${label}</div><div class="vgrid">${pool.map(e => `<button class="vthumb${v[key] === e.n ? ' on' : ''}" data-${key}="${e.n}"><img src="${e.art}" alt=""><span>No. ${e.n}</span></button>`).join('')}</div>`;
        body.innerHTML = `<div class="voting-as">${face(me, 44)}<div class="grow"><div class="host-meta">Voting as</div><b style="color:${me.color}">${esc(me.name)}</b></div><button class="btn sm ghost" id="notMe">Not me</button></div>${row('acc', 'Most accurate portrait')}${row('fun', 'Funniest portrait')}<button class="btn primary big mt" id="vLock"${v.acc && v.fun ? '' : ' disabled'}>Lock in my votes</button>`;
        q('#notMe').onclick = () => { ui.dv = { acc: null, fun: null }; redo(); };
        body.querySelectorAll('[data-acc]').forEach(b => (b.onclick = () => { v.acc = +b.dataset.acc; redo(); }));
        body.querySelectorAll('[data-fun]').forEach(b => (b.onclick = () => { v.fun = +b.dataset.fun; redo(); }));
        q('#vLock').onclick = () => { const id = v.voter; act('game.portraitVote', { pid: id, accurate: v.acc, funny: v.fun }).then(() => { toast('Votes locked. Pass the iPad on.'); }).catch(() => { }); ui.dv = { acc: null, fun: null }; redo(); };
        return;
      }
      body.innerHTML = `<div class="plead">Vote</div><div class="host-q big">Most accurate and funniest.</div><div class="host-meta" style="margin:6px 0 14px">${left.length ? 'Tap your face. You cannot vote for your own.' : 'All votes are in. Look at the TV…'}</div><div class="pgrid">${left.map(p => facePick(p, 'data-pvote')).join('')}</div>${waitLine(x.voted.length, S().players.length, 'voted')}`;
      body.querySelectorAll('[data-pvote]').forEach(b => (b.onclick = () => { ui.dv = { acc: null, fun: null, voter: b.dataset.pvote }; redo(); }));
      return;
    }
    // reveal
    const w = x.results?.winners;
    const nm = ns => (ns || []).map(n => x.entries.find(e => e.n === n)).filter(Boolean).map(e => `${e.title} by ${personOf(e.artist)?.name || '?'}`).join(' & ');
    title.textContent = 'The votes are in';
    body.innerHTML = `<div class="rank"><div class="win"><span class="grow">Most accurate</span><b>${esc(nm(w?.accurate) || 'no votes')}</b></div><div class="win"><span class="grow">Funniest</span><b>${esc(nm(w?.funny) || 'no votes')}</b></div></div>${scoreline}`;
  }

  // ---------- Sketch Telephone ----------
  function telephonePad(g, body, r) {
    const p = personOf(ui.dd.pid);
    ui.dd.endsAt = r.endsAt;
    const finish = async skip => {
      const pad = ui.dd.pad;
      let args;
      if (r.kind === 'draw') args = skip || !pad || pad.blank() ? { pid: p.id, skip: true } : { pid: p.id, png: pad.toPng(720) };
      else { const t = (q('#tpGuess')?.value || '').trim(); args = skip || !t ? { pid: p.id, skip: true } : { pid: p.id, text: t }; }
      try { await act('game.drawSubmit', args); leave(); toast('Handed in. Pass the iPad on.'); redo(); } catch { redo(); }
    };
    if (r.kind === 'draw') {
      body.innerHTML = padFrame(`<div class="dd-head">${face(p, 52)}<div class="grow"><div class="host-meta">${esc(p.name)}, draw this</div><b class="dd-phrase">${esc(r.text || 'a mystery')}</b></div></div>`, timerBar(r.endsAt)) +
        `<div class="dd-go"><button class="btn primary big" id="ddDone">I'm done</button><button class="btn ghost big" id="ddSkip">Skip me</button></div></div>`;
      mountPad(body, { endsAt: r.endsAt, onTime: () => finish(false) });
      q('#ddDone').onclick = () => { if (ui.dd.pad.blank()) return toast('Draw something first, or wait for the clock', true); finish(false); };
    } else {
      const pic = r.type === 'art' ? `<img class="dd-art" src="${r.url}" alt="">` : '<div class="dd-art blank">They skipped their drawing. Make a wild guess anyway!</div>';
      body.innerHTML = `<div id="ddLive" class="dd-live">${`<div class="dd-head">${face(p, 52)}<div class="grow"><div class="host-meta">${esc(p.name)}, what is this?</div><b class="dd-name" style="color:${p.color}">Guess the drawing</b></div>`}</div>${timerBar(r.endsAt)}<div class="dd-artbox">${pic}</div>
        <input type="text" id="tpGuess" class="cap-input" maxlength="60" placeholder="Type what you think it is" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" style="min-height:0;height:64px">
        <div class="dd-go"><button class="btn primary big" id="ddDone">Lock it in</button><button class="btn ghost big" id="ddSkip">Skip me</button></div></div>`;
      document.body.classList.add('dd-on');
      ui.dd.clock = setTimeout(() => finish(false), Math.max(0, r.endsAt - net.now()));
      q('#ddDone').onclick = () => { if (!(q('#tpGuess').value || '').trim()) return toast('Type a guess first', true); finish(false); };
      q('#tpGuess').onkeydown = e => { if (e.key === 'Enter') q('#ddDone').click(); };
    }
    q('#ddSkip').onclick = () => finish(true);
  }
  function telephone(g, title, body, scoreline) {
    const x = g.x || {};
    title.textContent = 'Sketch Telephone';
    const d = ui.dd;
    if (g.phase === 'step') {
      if (d.active && d.kind === 'telephone' && d.sub) return telephonePad(g, body, d.sub);
      const left = S().players.filter(p => !x.done.includes(p.id));
      if (d.confirm && left.some(p => p.id === d.confirm)) {
        const p = personOf(d.confirm);
        body.innerHTML = `<div class="seat">${face(p, 140)}<div class="seat-name" style="color:${p.color}">${esc(p.name)}, you're next</div><div class="host-meta">Pass the iPad to ${esc(p.name)}. You will ${x.kind === 'draw' ? 'draw a phrase' : 'guess a drawing'} in ${x.secs} seconds.</div><button class="btn primary seat-go" id="ddShow">${x.kind === 'draw' ? 'Show me my phrase' : 'Show me the drawing'}</button><button class="btn ghost" id="ddNot">Not me</button></div>`;
        q('#ddNot').onclick = () => { ui.dd = { active: false }; redo(); };
        q('#ddShow').onclick = async () => {
          try { const r = await act('game.drawStart', { pid: p.id }); ui.dd = { active: true, kind: 'telephone', pid: p.id, round: g.round, sub: r }; redo(); }
          catch { ui.dd = { active: false }; redo(); }
        };
        return;
      }
      body.innerHTML = `<div class="plead">Step ${x.step} of ${x.of} · ${x.kind === 'draw' ? 'draw' : 'guess'}</div><div class="host-q big">${x.kind === 'draw' ? 'Draw what you are told.' : 'Guess what the drawing is.'}</div><div class="host-meta" style="margin:6px 0 14px">${left.length ? 'Tap your face. You only ever see the step right before yours.' : 'Everyone is done. Next step…'}</div><div class="pgrid">${left.map(p => facePick(p, 'data-tstep')).join('')}</div>${waitLine(x.done.length, S().players.length)}`;
      body.querySelectorAll('[data-tstep]').forEach(b => (b.onclick = () => { ui.dd = { active: false, confirm: b.dataset.tstep }; redo(); }));
      return;
    }
    if (g.phase === 'reveal') {
      const n = x.chains.length, c = x.chains[x.ci];
      title.textContent = 'The big reveal';
      body.innerHTML = `<div class="seat"><div class="seat-name">Chain ${x.ci + 1} of ${n}</div><div class="host-meta">${x.cmp ? 'Where it started and where it ended up. Next goes to the next chain.' : `Showing step ${Math.max(0, x.show - 1)} of ${n}. Tap Next for the next laugh.`}</div><button class="btn primary seat-go" id="tpNext">Next</button>${x.cmp ? '' : '<button class="btn ghost" id="tpSkip">Skip to the end of this chain</button>'}</div>`;
      q('#tpNext').onclick = () => act('game.next', { round: g.round, phase: g.phase });
      q('#tpSkip') && (q('#tpSkip').onclick = () => act('game.tpSkipChain'));
      return;
    }
    if (g.phase === 'vote') {
      const left = S().players.filter(p => !x.voted.includes(p.id));
      const v = ui.dv;
      if (v.voter && !left.some(p => p.id === v.voter)) v.voter = null;
      if (v.voter) {
        const me = personOf(v.voter);
        const tiles = x.chains.map((ch, ci) => `<div class="plead" style="margin-top:14px">Chain ${ci + 1}: ${esc(ch.prompt)}</div><div class="vgrid">${ch.steps.map((st, si) => (st.by === me.id ? '' : `<button class="vthumb tp${v.moment === `${ci}.${si}` ? ' on' : ''}" data-moment="${ci}.${si}">${st.art ? `<img src="${st.art}" alt="">` : `<em>${esc(st.text || '(skipped)')}</em>`}<span>${esc(personOf(st.by)?.name || '?')}</span></button>`)).join('')}</div>`).join('');
        body.innerHTML = `<div class="voting-as">${face(me, 44)}<div class="grow"><div class="host-meta">Voting as</div><b style="color:${me.color}">${esc(me.name)}</b></div><button class="btn sm ghost" id="notMe">Not me</button></div><div class="host-meta" style="margin-top:10px">Tap your favourite moment from any chain.</div>${tiles}<button class="btn primary big mt" id="vLock"${v.moment ? '' : ' disabled'}>Lock in my vote</button>`;
        q('#notMe').onclick = () => { ui.dv = { moment: null }; redo(); };
        body.querySelectorAll('[data-moment]').forEach(b => (b.onclick = () => { v.moment = b.dataset.moment; redo(); }));
        q('#vLock').onclick = () => { const id = v.voter; act('game.tpVote', { pid: id, moment: v.moment }).then(() => toast('Vote locked. Pass the iPad on.')).catch(() => { }); ui.dv = { moment: null }; redo(); };
        return;
      }
      body.innerHTML = `<div class="plead">Vote</div><div class="host-q big">Your favourite moment.</div><div class="host-meta" style="margin:6px 0 14px">${left.length ? 'Tap your face, then tap the funniest step from any chain.' : 'All votes are in. Look at the TV…'}</div><div class="pgrid">${left.map(p => facePick(p, 'data-tvote')).join('')}</div>${waitLine(x.voted.length, S().players.length, 'voted')}`;
      body.querySelectorAll('[data-tvote]').forEach(b => (b.onclick = () => { ui.dv = { moment: null, voter: b.dataset.tvote }; redo(); }));
      return;
    }
    // verdict
    title.textContent = 'Favourite moment';
    const f = x.furthest;
    body.innerHTML = `<div class="seat"><div class="seat-name">${f ? 'The chain that went the furthest' : 'What a chain'}</div>${f ? `<div class="host-meta">${esc(f.from)} became ${esc(f.to)}</div>` : ''}</div>${scoreline}`;
  }

  function host(g, title, body, scoreline, btns) {
    // a new phase or round drops any unfinished pad
    const key = `${g.kind}:${g.round}:${g.phase}`;
    if (ui.ddKey !== key) { ui.ddKey = key; if (ui.dd?.active && !live(g)) leave(); }
    // Next means "move the show along" here; Reveal is not needed
    btns.querySelector('#gReveal')?.remove();
    const nx = btns.querySelector('#gNext');
    if (nx && g.kind !== 'ornaments') nx.textContent = ({ draw: 'Skip the rest', step: 'Skip the rest', gallery: 'Next painting', vote: 'Show results', verdict: 'Final scores' })[g.phase] || (g.phase === 'reveal' && g.kind === 'portraits' ? (g.round >= g.total ? 'Final scores' : 'Next round') : 'Next');
    // "Skip the rest" is for the grown-up running the game, never a button to hit by accident with a pencil in hand
    if (nx && nx.textContent === 'Skip the rest') { nx.classList.remove('primary'); nx.classList.add('ghost'); if (ui.dd?.active) nx.remove(); }
    if (g.kind === 'ornaments') return ornaments(g, title, body, btns);
    if (g.kind === 'portraits') return portraits(g, title, body, scoreline);
    return telephone(g, title, body, scoreline);
  }
  return { host, live, leave, ornamentManager, bindOrnaments };
}
