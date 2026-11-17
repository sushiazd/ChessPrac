/* Revue d'une partie : échiquier, barre d'évaluation, courbe, coups classés, meilleur coup, variantes à explorer. */
CP.pages.review = async function (main, route, alive) {
  const { h, fmt } = CP;
  const data = await CP.api('/api/game?id=' + encodeURIComponent(route.id));
  const g = data.game, plies = data.plies, N = plies.length;
  const analyzed = g.analyzed === 1;
  const fens = plies.map((p) => p.fen_before).concat([data.final_fen]);
  const evalAt = (i) => (i < N ? { cp: plies[i].cp_before, mate: plies[i].mate_before } : { cp: plies[N - 1].cp_after, mate: plies[N - 1].mate_after });
  const mine = g.my_color;
  let idx = route.q.ply ? Math.min(N, +route.q.ply) : 0;
  let variation = null; // {fen, base, sans:[], lastMove}
  let showArrow = true;
  let deep = null;

  const me = { name: CP.status.display_name || g.username, rating: g.my_rating };
  const opp = { name: g.opp_name, rating: g.opp_rating };
  const nEx = data.exercises.length;

  main.innerHTML = `
    <div class="head"><div>
      <p class="eyebrow"><a href="#/parties">Parties</a> · ${fmt.tc(g.time_control, g.time_class)} · ${fmt.date(g.end_time)}</p>
      <h1>${h(me.name)} contre ${h(opp.name)}</h1>
      <p class="lede"><span class="chip ${g.result}">${fmt.result(g.result)}</span>
        <span class="ink2">${h(g.opening || '')}</span>
        ${g.url ? ` · <a href="${h(g.url)}" target="_blank" rel="noopener">voir sur chess.com</a>` : ''}</p>
    </div>
      <div class="row">${nEx ? `<a class="btn btn-primary" href="#/erreurs?game=${encodeURIComponent(g.id)}">S'entraîner sur cette partie (${nEx})</a>` : ''}</div>
    </div>
    ${analyzed ? '' : `<div class="note info" style="margin-bottom:16px" id="pending">Cette partie n'est pas encore analysée.
      <button class="btn btn-sm" id="prio" style="margin-left:8px">L'analyser maintenant</button></div>`}
    <div class="review">
      <div class="left">
        <div class="player-line" id="top-player"></div>
        <div class="board-area"><div id="evalbar"></div><div class="board-col"><div id="board"></div></div></div>
        <div class="player-line" id="bottom-player"></div>
        <div class="board-controls">
          <button class="icon-btn" id="first" title="Début (Origine)">⏮</button>
          <button class="icon-btn" id="prev" title="Coup précédent (←)">◀</button>
          <button class="icon-btn" id="next" title="Coup suivant (→)">▶</button>
          <button class="icon-btn" id="last" title="Fin (Fin)">⏭</button>
          <button class="icon-btn" id="flip" title="Retourner (F)">⇅</button>
          <button class="icon-btn" id="arrow" title="Flèche de Stockfish (A)">➚</button>
        </div>
        <div class="chart-box ${analyzed ? '' : 'hidden'}" id="chart"></div>
      </div>
      <div class="stack">
        <div class="card move-info" id="info"></div>
        <div class="card" id="moments-card"><div class="card-title"><h3>Tes moments clés</h3></div><div class="key-moments" id="moments"></div></div>
        <div class="moves" id="moves"></div>
        <div class="card"><div class="card-title"><h3>Analyse de la position</h3><span class="sp"></span>
          <button class="btn btn-sm" id="deep">Analyser</button></div><div id="deep-out" class="small muted">Stockfish plus profond, 3 meilleures suites.</div></div>
      </div>
    </div>`;

  const board = new Board(main.querySelector('#board'), { orientation: mine, movable: 'both', onMove: onUserMove });
  const bar = new EvalBar(main.querySelector('#evalbar'));

  // ------------------------------------------------ liste des coups
  const movesEl = main.querySelector('#moves');
  let html = '';
  for (let i = 0; i < N; i += 2) {
    html += `<div class="no">${i / 2 + 1}.</div>`;
    for (const j of [i, i + 1]) {
      const p = plies[j];
      if (!p) { html += '<div class="mv"></div>'; continue; }
      const c = CP.CLS[p.cls] || {};
      const mk = c.mark && ['inaccuracy', 'mistake', 'blunder'].includes(p.cls) ? `<span class="mark ${p.cls}">${c.mark}</span>` : '';
      html += `<div class="mv" data-i="${j + 1}"><span>${h(p.san)}</span>${mk}</div>`;
    }
  }
  movesEl.innerHTML = html;
  movesEl.querySelectorAll('.mv[data-i]').forEach((el) => (el.onclick = () => go(+el.dataset.i)));

  // ------------------------------------------------ moments clés
  const moments = plies.map((p, i) => ({ p, i: i + 1 })).filter(({ p }) => p.mine && (['mistake', 'blunder'].includes(p.cls) || p.missed));
  const mEl = main.querySelector('#moments');
  if (!analyzed) main.querySelector('#moments-card').classList.add('hidden');
  else if (!moments.length) mEl.innerHTML = '<span class="muted small">Aucune erreur nette de ta part. Belle partie.</span>';
  else mEl.innerHTML = moments.map(({ p, i }) => `
      <button data-i="${i}"><span class="mark ${p.cls === 'blunder' ? 'blunder' : 'mistake'}">${p.cls === 'blunder' ? '??' : '?'}</span>
        <span class="num">${Math.ceil(i / 2)}${i % 2 ? '.' : '…'} ${h(p.san)}</span>
        <span class="muted">−${Math.round(p.drop)} %</span><span class="sp"></span>
        <span class="small muted">${p.tag ? h(CP.TAGS[p.tag] || p.tag) : p.missed ? 'Occasion manquée' : ''}</span></button>`).join('');
  mEl.querySelectorAll('button').forEach((b) => (b.onclick = () => go(+b.dataset.i, true)));

  // ------------------------------------------------ affichage
  function clocksAt(i) {
    const c = { w: null, b: null };
    for (let j = 0; j < i && j < N; j++) if (plies[j].clock !== null) c[plies[j].color] = plies[j].clock;
    return c;
  }

  function players() {
    const c = clocksAt(variation ? variation.base : idx);
    const line = (who, color) => `<span class="color-dot ${color}"></span>${h(who.name)} <span class="muted">${who.rating ?? ''}</span>
      ${c[color] !== null ? `<span class="clock">${fmt.clock(c[color])}</span>` : ''}`;
    const oppColor = mine === 'w' ? 'b' : 'w';
    const bottomIsMe = board.orientation === mine;
    main.querySelector('#bottom-player').innerHTML = bottomIsMe ? line(me, mine) : line(opp, oppColor);
    main.querySelector('#top-player').innerHTML = bottomIsMe ? line(opp, oppColor) : line(me, mine);
  }

  function infoHtml() {
    if (variation) {
      return `<p class="label">Variante</p><p class="big">${h(CP.sanLine(variation.sans, variation.startPly)) || 'Joue des coups pour explorer'}</p>
        <p class="small muted" id="var-eval">…</p>
        <button class="btn btn-sm" id="back">Retour à la partie</button>`;
    }
    if (idx === 0) return `<p class="label">Début de partie</p><p class="big">Utilise ← → pour avancer, ou clique un coup.</p>
      <p class="small muted">Tu peux aussi déplacer les pièces pour explorer une variante.</p>`;
    const p = plies[idx - 1];
    const who = p.mine ? 'Tu as joué' : `${h(opp.name)} a joué`;
    const num = `${Math.ceil(idx / 2)}${idx % 2 ? '.' : '…'}`;
    if (!analyzed) return `<p class="label">${num}</p><p class="big">${who} ${h(p.san)}</p>
      <p class="small muted">${p.think !== null ? 'Temps : ' + fmt.think(p.think) : ''}</p>`;
    const c = CP.CLS[p.cls] || { label: '' };
    const bad = ['inaccuracy', 'mistake', 'blunder'].includes(p.cls);
    let out = `<p class="label">${num} ${p.mine ? 'Ton coup' : 'Coup adverse'}${p.think !== null ? ' · ' + fmt.think(p.think) : ''}</p>
      <p class="big">${who} ${h(p.san)} <span class="cls-${p.cls}">· ${c.label}</span></p>`;
    if (p.drop >= 2) out += `<p class="small ink2" style="margin:2px 0 8px">Chances de gain : ${Math.round(p.wp_before)} % → ${Math.round(p.wp_after)} % (−${Math.round(p.drop)} %)</p>`;
    if (p.missed) out += `<p class="small warn" style="margin:2px 0 8px">L'adversaire venait de se tromper : il y avait une occasion à saisir.</p>`;
    if (p.tag && bad) out += `<p style="margin:0 0 8px"><span class="chip warnc">${h(CP.TAGS[p.tag] || p.tag)}</span></p>`;
    if (p.cls !== 'best' && p.best_san) {
      out += `<p class="small" style="margin:0 0 4px">Stockfish préférait <b>${h(p.best_san)}</b> :</p>
        <div class="pv" data-from="${idx - 1}">${pvTokens(p.pv_san, CP.plyOfFen(p.fen_before))}</div>`;
    }
    return out;
  }

  function pvTokens(sans, startPly) {
    return sans.map((s, k) => {
      const ply = startPly + k;
      const pre = ply % 2 === 0 ? `${ply / 2 + 1}.` : k === 0 ? `${(ply + 1) / 2}…` : '';
      return `<span data-k="${k}">${pre}${h(s)}</span>`;
    }).join(' ');
  }

  function bindInfo() {
    const info = main.querySelector('#info');
    const back = info.querySelector('#back');
    if (back) back.onclick = () => { variation = null; render(); };
    info.querySelectorAll('.pv span').forEach((sp) => (sp.onclick = () => playPv(+sp.parentElement.dataset.from, +sp.dataset.k)));
  }

  async function playPv(fromIdx, k) {
    const p = plies[fromIdx];
    let fen = p.fen_before, last = null;
    const sans = [];
    for (let j = 0; j <= k && j < p.pv.length; j++) {
      const r = await CP.api('/api/move', { fen, uci: p.pv[j] });
      fen = r.fen; last = CP.uciSquares(p.pv[j]); sans.push(r.san);
    }
    variation = { fen, base: fromIdx, sans, startPly: CP.plyOfFen(p.fen_before), lastMove: last };
    render();
  }

  async function onUserMove(uci) {
    const from = variation ? variation.fen : fens[idx];
    const r = await CP.api('/api/move', { fen: from, uci });
    if (!variation) variation = { fen: from, base: idx, sans: [], startPly: CP.plyOfFen(from) };
    variation.fen = r.fen;
    variation.sans.push(r.san);
    variation.lastMove = CP.uciSquares(uci);
    render();
  }

  let evalTimer;
  async function render() {
    deep = null;
    main.querySelector('#deep-out').innerHTML = 'Stockfish plus profond, 3 meilleures suites.';
    const fen = variation ? variation.fen : fens[idx];
    const last = variation ? variation.lastMove : idx > 0 ? CP.uciSquares(plies[idx - 1].uci) : null;
    await CP.showPosition(board, fen, { lastMove: last });
    if (!alive()) return;
    // Flèche : meilleur coup dans la position affichée.
    const arrows = [];
    if (!variation && analyzed && showArrow && idx < N && plies[idx].best_uci) {
      const [a, b] = CP.uciSquares(plies[idx].best_uci);
      arrows.push({ from: a, to: b, color: 'pen', opacity: 0.55 });
    }
    board.setArrows(arrows);
    if (!variation && analyzed) { const e = evalAt(idx); bar.set(e.cp, e.mate, board.orientation); }
    else if (!analyzed && !variation) bar.set(null);
    main.querySelector('#info').innerHTML = infoHtml();
    bindInfo();
    players();
    movesEl.querySelectorAll('.mv').forEach((m) => m.classList.toggle('cur', !variation && +m.dataset.i === idx));
    // On fait défiler la liste des coups seulement, jamais la page (scrollIntoView faisait descendre toute la page).
    const cur = movesEl.querySelector('.mv.cur');
    if (cur) {
      const top = cur.offsetTop - movesEl.offsetTop, bottom = top + cur.offsetHeight;
      if (top < movesEl.scrollTop) movesEl.scrollTop = top - 4;
      else if (bottom > movesEl.scrollTop + movesEl.clientHeight) movesEl.scrollTop = bottom - movesEl.clientHeight + 4;
    }
    if (analyzed) drawChart();
    if (variation) {
      clearTimeout(evalTimer);
      evalTimer = setTimeout(async () => {
        const ev = await CP.api('/api/analyse', { fen: variation.fen, nodes: 400000 });
        if (!alive() || !variation || variation.fen !== fen) return;
        bar.set(ev.cp, ev.mate, board.orientation);
        const l = ev.lines[0];
        const el = main.querySelector('#var-eval');
        if (el) el.innerHTML = l ? `Stockfish : ${ev.cp >= 0 ? '+' : '−'}${evalText(ev.cp, ev.mate)} · suite : ${h(CP.sanLine(l.san.slice(0, 6), CP.plyOfFen(variation.fen)))}` : 'Partie terminée';
      }, 150);
    }
  }

  function drawChart() {
    const cps = fens.map((_, i) => evalAt(i).cp);
    const marks = {};
    plies.forEach((p, i) => { if (p.mine && ['mistake', 'blunder'].includes(p.cls)) marks[i + 1] = p.cls; });
    Charts.evalChart(main.querySelector('#chart'), cps, { current: variation ? variation.base : idx, marks, onClick: (i) => go(i), orientation: board.orientation });
  }

  function go(i, before) {
    variation = null;
    idx = Math.max(0, Math.min(N, i));
    render();
  }

  main.querySelector('#first').onclick = () => go(0);
  main.querySelector('#prev').onclick = () => (variation ? (variation = null, render()) : go(idx - 1));
  main.querySelector('#next').onclick = () => go(idx + 1);
  main.querySelector('#last').onclick = () => go(N);
  main.querySelector('#flip').onclick = () => { board.flip(); render(); };
  main.querySelector('#arrow').onclick = () => { showArrow = !showArrow; render(); };
  main.querySelector('#deep').onclick = async () => {
    const out = main.querySelector('#deep-out');
    out.innerHTML = '<span class="muted">Stockfish réfléchit…</span>';
    const fen = variation ? variation.fen : fens[idx];
    const ev = await CP.api('/api/analyse', { fen, nodes: 2500000 });
    const ply = CP.plyOfFen(fen);
    out.innerHTML = ev.lines.length ? ev.lines.map((l) => `<div style="margin:4px 0"><b class="num">${l.cp >= 0 ? '+' : '−'}${evalText(l.cp, l.mate)}</b>
      <span class="pv">${h(CP.sanLine(l.san.slice(0, 8), ply))}</span></div>`).join('') : 'Partie terminée.';
  };
  CP.onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); main.querySelector('#prev').click(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(N);
    else if (e.key === 'f') main.querySelector('#flip').click();
    else if (e.key === 'a') main.querySelector('#arrow').click();
  };

  let poll;
  if (!analyzed) {
    main.querySelector('#prio').onclick = async () => {
      await CP.api('/api/game/analyse', { id: g.id });
      main.querySelector('#pending').innerHTML = 'Analyse demandée : elle passe devant les autres. La page se mettra à jour toute seule.';
    };
    poll = setInterval(async () => {
      const d = await CP.api('/api/games?' + CP.qs({ q: g.opp_name, limit: 200 }));
      const me2 = d.games.find((x) => x.id === g.id);
      if (me2 && me2.analyzed === 1 && alive()) CP.render();
    }, 6000);
  } else {
    CP.api('/api/game/reviewed', { id: g.id });
  }
  await render();
  return () => { board.destroy(); clearInterval(poll); clearTimeout(evalTimer); };
};
