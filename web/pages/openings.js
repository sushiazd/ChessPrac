/* Ouvertures : l'arbre de mes parties, mon répertoire, mes fuites, et l'entraînement des lignes. */
CP.pages.openings = async function (main, route, alive) {
  const { h, fmt } = CP;
  const color = route.q.color || 'w';
  const tab = route.q.tab || 'tree';
  const go = (p) => (location.hash = '#/ouvertures?' + CP.qs({ color, tab, ...p }));
  const settings = await CP.api('/api/settings');

  main.innerHTML = `
    <div class="head"><div><p class="eyebrow">Ouvertures</p><h1>Mon répertoire ${color === 'w' ? 'avec les Blancs' : 'avec les Noirs'}</h1>
      <p class="lede">Construit à partir de tes vraies parties : ce que tu joues, ce que ça te rapporte, ce que Stockfish
        conseille. Choisis un coup par position, puis rejoue tes lignes jusqu'à les connaître par cœur.</p></div>
      <div class="stack" style="gap:8px;align-items:flex-end">
        <div class="seg" id="col"><button data-c="w" aria-pressed="${color === 'w'}">Blancs</button><button data-c="b" aria-pressed="${color === 'b'}">Noirs</button></div>
        <div class="seg" id="tabs"><button data-t="tree" aria-pressed="${tab === 'tree'}">Explorer</button>
          <button data-t="leaks" aria-pressed="${tab === 'leaks'}">Fuites</button>
          <button data-t="drill" aria-pressed="${tab === 'drill'}">Entraînement</button></div>
      </div></div>
    <div id="body"></div>`;
  main.querySelectorAll('#col button').forEach((b) => (b.onclick = () => go({ color: b.dataset.c, fen: null })));
  main.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => go({ tab: b.dataset.t, fen: null })));
  const body = main.querySelector('#body');
  if (tab === 'leaks') return leaks();
  if (tab === 'drill') return drill();
  return tree();

  // ================================================================ explorer
  async function tree() {
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const baseFen = route.q.fen || START;
    let path = []; // [{uci, san, fen}]
    body.innerHTML = `
      <div class="trainer">
        <div class="left">
          <div class="crumbs" id="crumbs"></div>
          <div class="board-area"><div id="evalbar"></div><div class="board-col"><div id="board"></div></div></div>
          <div class="board-controls"><button class="icon-btn" id="start" title="Début">⏮</button>
            <button class="icon-btn" id="back" title="Retour (←)">◀</button></div>
        </div>
        <div class="stack">
          <div class="card" id="pos"><div class="spinner"></div></div>
          <div class="card"><div class="card-title"><h3>Remplir automatiquement</h3></div>
            <p class="small ink2" style="margin:0 0 10px">Pour chaque position que tu as eue au moins 2 fois : ton coup habituel
              s'il tient la route, sinon celui de Stockfish. Tes choix déjà faits ne bougent pas.</p>
            <button class="btn" id="auto">Construire mon répertoire</button> <span class="small muted" id="auto-out"></span></div>
        </div>
      </div>`;
    const board = new Board(body.querySelector('#board'), { orientation: color, movable: 'both', onMove: (u) => play(u) });
    const bar = new EvalBar(body.querySelector('#evalbar'));
    const curFen = () => (path.length ? path[path.length - 1].fen : baseFen);

    async function play(uci) {
      const r = await CP.api('/api/move', { fen: curFen(), uci });
      path.push({ uci, san: r.san, fen: r.fen });
      load();
    }

    async function load() {
      const fen = curFen();
      const last = path.length ? CP.uciSquares(path[path.length - 1].uci) : null;
      await CP.showPosition(board, fen, { lastMove: last });
      const startPly = CP.plyOfFen(baseFen);
      body.querySelector('#crumbs').innerHTML = `<button data-k="-1" class="${path.length ? '' : 'cur'}">${baseFen === START ? 'Début' : 'Position'}</button>` +
        path.map((p, k) => {
          const ply = startPly + k;
          const pre = ply % 2 === 0 ? `${ply / 2 + 1}.` : k === 0 ? `${(ply + 1) / 2}…` : '';
          return `<button data-k="${k}" class="${k === path.length - 1 ? 'cur' : ''}">${pre}${h(p.san)}</button>`;
        }).join('');
      body.querySelectorAll('#crumbs button').forEach((b) => (b.onclick = () => { path = path.slice(0, +b.dataset.k + 1); load(); }));
      const pos = body.querySelector('#pos');
      pos.innerHTML = '<div class="spinner"></div>';
      const n = await CP.api('/api/rep/node?' + CP.qs({ color, fen, explorer: settings.has_lichess_token ? 1 : '' }));
      if (!alive() || fen !== curFen()) return;
      const ev = n.engine || {};
      bar.set(ev.cp, ev.mate, color);
      const best = ev.lines && ev.lines[0];
      if (best) board.setArrows([{ ...Object.fromEntries([['from', best.uci[0].slice(0, 2)], ['to', best.uci[0].slice(2, 4)]]), color: 'pen', opacity: 0.45 }]);
      else board.setArrows([]);
      const lich = n.explorer && !n.explorer.error ? Object.fromEntries(n.explorer.moves.map((m) => [m.uci, m])) : {};
      const rows = [...n.moves];
      for (const m of (n.explorer && n.explorer.moves) || []) if (!rows.some((r) => r.uci === m.uci)) rows.push({ uci: m.uci, san: m.san, n: 0, score: null, drop: null });
      if (best && !rows.some((r) => r.uci === best.uci[0])) rows.push({ uci: best.uci[0], san: best.san[0], n: 0, score: null, drop: null, engine_drop: 0 });
      const dropCell = (d) => (d === null || d === undefined ? '<span class="muted">—</span>'
        : `<span class="${d >= 8 ? 'cls-mistake' : d >= 3 ? 'cls-inaccuracy' : 'cls-best'}">${d < 1 ? '0' : '−' + Math.round(d)} %</span>`);
      pos.innerHTML = `
        <p class="label">${n.mine ? 'À toi de jouer' : 'Coup adverse'}</p>
        <p class="prompt" style="font-size:19px">${n.n ? `Atteinte dans ${n.n} de tes parties · score ${n.score} %` : 'Jamais atteinte dans tes parties'}</p>
        <p class="small ink2" style="margin:0 0 12px">${best ? `Stockfish : <b>${ev.cp >= 0 ? '+' : '−'}${evalText(ev.cp, ev.mate)}</b>, meilleur coup <b>${h(best.san[0])}</b>` : 'Partie terminée'}
          ${n.mine ? ` · ton répertoire : ${n.rep_san ? `<b class="ok">${h(n.rep_san)}</b>` : '<span class="warn">pas encore choisi</span>'}` : ''}</p>
        ${n.explorer && n.explorer.error ? `<p class="small bad">${h(n.explorer.error)}</p>` : ''}
        <div class="table-wrap"><table class="table"><thead><tr>${n.mine ? '<th title="Mon coup de répertoire"></th>' : ''}<th>Coup</th><th class="r">Parties</th><th class="r">Score</th>
          <th class="r" title="Chances de gain perdues en moyenne dans tes parties">Perte</th><th class="r" title="Écart avec le meilleur coup de Stockfish">Stockfish</th>
          ${settings.has_lichess_token ? '<th class="r" title="Joueurs 1000-1600 sur Lichess">Lichess</th>' : ''}</tr></thead><tbody>
          ${rows.map((m) => `<tr class="click" data-u="${m.uci}">
            ${n.mine ? `<td><button class="radio ${n.rep === m.uci ? 'on' : ''}" data-rep="${m.uci}" title="Choisir pour mon répertoire"></button></td>` : ''}
            <td><b>${h(m.san)}</b>${m.added ? ' <span class="chip pen">ajouté</span>' : ''}</td>
            <td class="r num">${m.n || '<span class="muted">0</span>'}</td>
            <td class="r num">${m.score === null || m.score === undefined ? '' : m.score + ' %'}</td>
            <td class="r num">${m.n ? dropCell(m.drop) : ''}</td>
            <td class="r num">${dropCell(m.engine_drop)}</td>
            ${settings.has_lichess_token ? `<td class="r num small">${lich[m.uci] ? `${lich[m.uci].pct} % <span class="muted">(${lich[m.uci].score} %)</span>` : ''}</td>` : ''}
          </tr>`).join('') || `<tr><td colspan="7" class="muted">Aucune donnée : joue un coup sur l'échiquier pour continuer.</td></tr>`}
        </tbody></table></div>
        ${!n.mine && path.length && !rows.length ? '' : ''}
        ${n.mine && n.rep ? `<button class="btn btn-sm btn-ghost" id="unset" style="margin-top:8px">Retirer ce coup du répertoire</button>` : ''}
        ${!n.mine && path.length ? `<p class="small muted" style="margin:10px 0 0">Joue un coup adverse sur l'échiquier qui n'est pas dans la liste pour l'ajouter à ton entraînement.</p>` : ''}`;
      pos.querySelectorAll('tr[data-u]').forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest('.radio')) play(tr.dataset.u); }));
      pos.querySelectorAll('[data-rep]').forEach((b) => (b.onclick = async () => {
        await CP.api('/api/rep/set', { color, fen, uci: b.dataset.rep });
        CP.toast('Ajouté à ton répertoire');
        load();
      }));
      const un = pos.querySelector('#unset');
      if (un) un.onclick = async () => { await CP.api('/api/rep/set', { color, fen, uci: null }); load(); };
      // Coup adverse joué à la main, absent de mes parties : on le garde pour l'entraînement.
      if (path.length) {
        const prev = path.length > 1 ? path[path.length - 2].fen : baseFen;
        const lastMv = path[path.length - 1];
        const prevMine = (prev.split(' ')[1] === 'w') === (color === 'w');
        if (!prevMine) CP.api('/api/rep/set', { color, fen: prev, uci: lastMv.uci });
      }
    }

    body.querySelector('#start').onclick = () => { path = []; load(); };
    body.querySelector('#back').onclick = () => { path.pop(); load(); };
    body.querySelector('#auto').onclick = async () => {
      const out = body.querySelector('#auto-out');
      out.textContent = 'Construction…';
      const r = await CP.api('/api/rep/auto', { color });
      out.textContent = r.added ? `${r.added} position${r.added > 1 ? 's' : ''} ajoutée${r.added > 1 ? 's' : ''}.` : 'Rien à ajouter.';
      load();
    };
    CP.onKey = (e) => { if (e.key === 'ArrowLeft' && path.length) { path.pop(); load(); } };
    await load();
    return () => board.destroy();
  }

  // ================================================================ fuites
  async function leaks() {
    const d = await CP.api('/api/rep/leaks?color=' + color);
    if (!d.leaks.length) {
      body.innerHTML = `<div class="card empty" style="padding:40px"><h2>Aucune fuite repérée</h2>
        <p>Aucun coup d'ouverture joué au moins 2 fois ne te coûte plus de 8 % de chances de gain en moyenne${CP.status.counts && CP.status.counts.todo ? ' (l\'analyse de tes parties continue)' : ''}.</p></div>`;
      return;
    }
    body.innerHTML = `<p class="ink2" style="margin-top:-6px">Les coups que tu joues souvent dans l'ouverture et qui te coûtent le plus, classés par coût total
      (nombre de parties × perte moyenne).</p>
      <div class="stack">${d.leaks.map((l, i) => `
        <div class="card leak"><div style="flex:1;min-width:0">
          <p class="line">${h(l.line) || 'Position de départ'}</p>
          <p style="margin:4px 0 2px">Tu joues <b class="cls-mistake">${h(l.san)}</b> (${l.n} fois, score ${l.score} %) :
            en moyenne <b>−${Math.round(l.drop)} %</b> de chances de gain.</p>
          ${l.best_san ? `<p class="small ink2" style="margin:0">Stockfish conseille <b class="ok">${h(l.best_san)}</b>.</p>` : ''}
        </div>
        <div class="row"><button class="btn btn-sm" data-see="${i}">Voir</button>
          ${l.best_uci ? `<button class="btn btn-sm btn-primary" data-adopt="${i}">Adopter ${h(l.best_san)}</button>` : ''}</div></div>`).join('')}</div>`;
    body.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => go({ tab: 'tree', fen: d.leaks[+b.dataset.see].fen })));
    body.querySelectorAll('[data-adopt]').forEach((b) => (b.onclick = async () => {
      const l = d.leaks[+b.dataset.adopt];
      await CP.api('/api/rep/set', { color, fen: l.fen, uci: l.best_uci });
      b.outerHTML = '<span class="chip win">Dans ton répertoire</span>';
    }));
  }

  // ================================================================ entraînement
  async function drill() {
    let line, k, errors, busy, done, firstFail;
    body.innerHTML = `
      <div class="trainer">
        <div class="left"><div class="board-area"><div class="board-col"><div id="board"></div></div></div></div>
        <div class="stack"><div class="card" id="panel"><div class="spinner"></div></div></div>
      </div>`;
    const board = new Board(body.querySelector('#board'), { orientation: color, movable: color, onMove });
    const panel = body.querySelector('#panel');

    function draw(fb = '') {
      const c = line.counts;
      const played = line.steps.slice(0, k).map((s) => s.san);
      panel.innerHTML = `<p class="label">${c.positions} positions · ${c.due} à revoir · ${c.learned} maîtrisées</p>
        <p class="prompt">${done ? 'Ligne terminée' : line.steps[k] && line.steps[k].mine ? 'À toi : ton coup de répertoire ?' : 'L\'adversaire joue…'}</p>
        <p class="pv" style="min-height:20px">${h(CP.sanLine(played, 0))}</p>
        <div id="fb">${fb}</div>
        <div class="row" style="margin-top:14px">${done ? '<button class="btn btn-primary" id="again">Ligne suivante <span class="kbd">Entrée</span></button>'
          : '<button class="btn btn-ghost" id="show">Je ne sais plus</button>'}
          <a class="btn btn-ghost" href="#/ouvertures?${CP.qs({ color, tab: 'tree' })}">Modifier le répertoire</a></div>`;
      const a = panel.querySelector('#again');
      if (a) a.onclick = start;
      const s = panel.querySelector('#show');
      if (s) s.onclick = reveal;
    }

    async function start() {
      line = await CP.api('/api/rep/drill?color=' + color);
      if (!alive()) return;
      if (!line.steps.some((s) => s.mine)) {
        panel.innerHTML = `<h2>Ton répertoire est vide</h2><p class="ink2">Remplis-le d'un clic à partir de tes parties, puis reviens ici.</p>
          <button class="btn btn-primary" id="build">Construire mon répertoire</button>`;
        panel.querySelector('#build').onclick = async () => {
          const r = await CP.api('/api/rep/auto', { color });
          CP.toast(`${r.added} positions ajoutées`);
          start();
        };
        await CP.showPosition(board, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', { movable: false, animate: false });
        return;
      }
      k = 0; errors = 0; done = false; busy = false;
      await CP.showPosition(board, line.steps[0].fen, { animate: false, movable: false });
      board.setArrows([]);
      draw();
      advance();
    }

    async function advance() {
      while (k < line.steps.length && !line.steps[k].mine) {
        await new Promise((r) => setTimeout(r, 380));
        if (!alive()) return;
        const s = line.steps[k];
        const r = await CP.api('/api/move', { fen: s.fen, uci: s.uci });
        k++;
        board.set({ fen: r.fen, lastMove: CP.uciSquares(s.uci), check: r.check, legal: [] });
        draw();
      }
      if (k >= line.steps.length) return end();
      firstFail = false;
      const s = line.steps[k];
      const info = await CP.api('/api/position', { fen: s.fen });
      board.setLegal(info.legal);
      draw();
    }

    async function onMove(uci) {
      if (busy || done) return;
      const s = line.steps[k];
      busy = true;
      if (uci === s.uci) {
        if (!firstFail) CP.api('/api/rep/result', { color, key: s.key, ok: true });
        const r = await CP.api('/api/move', { fen: s.fen, uci });
        board.set({ fen: r.fen, lastMove: CP.uciSquares(uci), check: r.check, legal: [] });
        board.setArrows([]);
        k++;
        busy = false;
        return advance();
      }
      board.flash('bad');
      errors++;
      if (!firstFail) { firstFail = true; CP.api('/api/rep/result', { color, key: s.key, ok: false }); }
      await CP.showPosition(board, s.fen, { lastMove: k ? CP.uciSquares(line.steps[k - 1].uci) : null });
      const [a, b] = CP.uciSquares(s.uci);
      board.setArrows([{ from: a, to: b, color: 'ok' }]);
      draw(`<div class="feedback bad">Ton coup ici, c'est ${h(s.san)}. Joue-le pour continuer.</div>`);
      busy = false;
    }

    async function reveal() {
      const s = line.steps[k];
      if (!s) return;
      if (!firstFail) { firstFail = true; CP.api('/api/rep/result', { color, key: s.key, ok: false }); }
      const [a, b] = CP.uciSquares(s.uci);
      board.setArrows([{ from: a, to: b, color: 'ok' }]);
      draw(`<div class="feedback info">C'est ${h(s.san)}. Joue-le pour continuer.</div>`);
    }

    function end() {
      done = true;
      board.setLegal([]);
      draw(errors ? `<div class="feedback bad">${errors} erreur${errors > 1 ? 's' : ''} sur cette ligne : ces positions reviendront demain.</div>`
        : '<div class="feedback ok">Sans faute.</div>');
    }

    CP.onKey = (e) => { if (e.key === 'Enter' && done) { e.preventDefault(); start(); } };
    await start();
    return () => board.destroy();
  }
};
