/* Erreurs : mes erreurs devenues exercices, avec répétition espacée. Et la banque de tous les exercices. */
CP.pages.train = async function (main, route, alive) {
  const { h, fmt } = CP;
  const tab = route.q.tab || 'session';
  main.innerHTML = `
    <div class="head"><div><p class="eyebrow">Erreurs</p><h1>${tab === 'bank' ? 'Tous mes exercices' : tab === 'convert' ? 'Gagner les parties gagnées' : route.q.game ? 'Les erreurs de cette partie' : 'Séance d\'erreurs'}</h1>
      <p class="lede">${tab === 'convert'
        ? 'Les positions où tu avais l\'avantage décisif mais où tu n\'as pas gagné. Rejoue-les contre Stockfish à pleine force jusqu\'à obtenir un gain net : finir une partie gagnée, ça s\'entraîne.'
        : 'Chaque erreur de tes parties devient un exercice. Réussi vite, il revient plus tard (1, 3, 7, 16 jours…) ; trouvé lentement, il revient plus tôt ; raté, il revient demain. Ta cause d\'erreur la plus fréquente passe en premier.'}</p></div>
      <div class="seg" id="tabs"><button data-t="session" aria-pressed="${tab === 'session'}">Séance</button>
        <button data-t="convert" aria-pressed="${tab === 'convert'}">Convertir</button>
        <button data-t="bank" aria-pressed="${tab === 'bank'}">Banque</button></div></div>
    <div id="body"></div>`;
  main.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => (location.hash = '#/erreurs?tab=' + b.dataset.t)));
  const body = main.querySelector('#body');
  if (tab === 'bank') return bank(body);
  if (tab === 'convert') return convert(body);
  return session(body);

  // ================================================================ convertir
  async function convert(el) {
    const d = await CP.api('/api/conversions');
    const list = d.conversions;
    if (!list.length) {
      el.innerHTML = `<div class="card empty" style="padding:40px"><h2>Aucune partie gâchée pour l'instant</h2>
        <p>Elles apparaissent au fil de l'analyse : une partie que tu n'as pas gagnée alors que tu avais au moins
        ${85} % de chances de gain.</p></div>`;
      return;
    }
    const now = Date.now() / 1000;
    const pick = route.q.cid ? list.find((c) => c.id === +route.q.cid) : null;
    if (!pick) {
      el.innerHTML = `<p class="ink2" style="margin-top:-6px">${list.length} partie${list.length > 1 ? 's' : ''} où tu gagnais sans gagner,
        ${d.counts.due} à jouer maintenant. Réussie, une position revient dans 3 semaines ; ratée, demain.</p>
        <div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr><th></th><th>Partie</th>
        <th>Fin réelle</th><th class="r">Tu avais</th><th>Essais</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr class="${c.due > now ? 'muted' : ''}"><td><span class="color-dot ${c.my_color}"></span></td>
          <td>${h(c.opp_name)} <span class="muted small">${c.opp_rating ?? ''} · ${fmt.tc(c.time_control, c.time_class)} · ${fmt.date(c.end_time)}</span></td>
          <td><span class="chip ${c.result}">${fmt.result(c.result)}</span> <span class="small muted">${h({ checkmated: 'maté', resigned: 'abandon', timeout: 'au temps', stalemate: 'pat', repetition: 'répétition', insufficient: 'matériel', agreed: 'accord', abandoned: 'quittée', timevsinsufficient: 'temps / matériel' }[c.my_code] || c.my_code || '')}</span></td>
          <td class="r num">${Math.round(c.wp)} %</td>
          <td class="small">${c.tries ? `${c.wins} / ${c.tries}` : '—'}</td>
          <td class="r"><a class="btn btn-sm ${c.due <= now ? 'btn-primary' : ''}" href="#/erreurs?tab=convert&cid=${c.id}">${c.due <= now ? 'Jouer' : 'Rejouer'}</a></td></tr>`).join('')}
        </tbody></table></div></div>`;
      return;
    }
    const next = list.find((c) => c.due <= now && c.id !== pick.id);
    el.innerHTML = `
      <div class="trainer">
        <div class="left"><div class="board-area"><div id="evalbar"></div><div class="board-col"><div id="board"></div></div></div></div>
        <div class="stack"><div class="card" id="panel"></div>
          <div class="card"><div class="card-title"><h3>La méthode</h3></div><p class="ink2 small" style="margin:0">
            Avec une pièce de plus, échange les pièces (pas les pions) et simplifie. Avant chaque coup, regarde les
            échecs, prises et menaces de l'adversaire : c'est là que les parties gagnées se perdent. Pas de coup
            spectaculaire : la sécurité d'abord.</p></div></div>
      </div>`;
    const board = new Board(el.querySelector('#board'), { orientation: pick.my_color, movable: pick.my_color, onMove });
    const bar = new EvalBar(el.querySelector('#evalbar'));
    const panel = el.querySelector('#panel');
    let fen, moves, userMoves, status, busy, limit;

    function draw(fb = '') {
      panel.innerHTML = `<p class="label">Contre ${h(pick.opp_name)} · ${fmt.date(pick.end_time)} · coup ${userMoves} / ${limit}</p>
        <p class="prompt">Tu avais ${Math.round(pick.wp)} % de chances de gain. Cette fois, gagne.</p>
        <p class="ink2 small" style="margin:0">Objectif : mater, ou atteindre un avantage décisif (+9) sans jamais
          laisser filer l'avantage.</p>
        <p class="pv" style="min-height:20px;margin-top:10px">${h(moves.join(' '))}</p><div id="fb">${fb}</div>
        <div class="row" style="margin-top:14px">
          ${status !== 'continue' && next ? `<a class="btn btn-primary" href="#/erreurs?tab=convert&cid=${next.id}">Suivante</a>` : ''}
          <button class="btn" id="restart">Recommencer</button>
          <a class="btn btn-ghost" href="#/partie/${encodeURIComponent(pick.game_id)}?ply=${pick.ply - 1}">Voir la partie</a>
          <a class="btn btn-ghost" href="#/erreurs?tab=convert">Liste</a></div>`;
      panel.querySelector('#restart').onclick = start;
    }

    async function evalBar() {
      const ev = await CP.api('/api/analyse', { fen, nodes: 150000 });
      if (alive()) bar.set(ev.cp, ev.mate, pick.my_color);
    }

    async function start() {
      busy = true;
      const r = await CP.api('/api/conversions/start', { id: pick.id });
      fen = r.fen; limit = r.limit; moves = []; userMoves = 0; status = 'continue';
      await CP.showPosition(board, fen, { animate: false });
      draw();
      evalBar();
      busy = false;
    }

    async function onMove(uci) {
      if (busy || status !== 'continue') return;
      busy = true;
      const mid = await CP.api('/api/move', { fen, uci });
      board.set({ fen: mid.fen, lastMove: CP.uciSquares(uci), check: mid.check, legal: [] });
      const r = await CP.api('/api/conversions/step', { id: pick.id, fen, uci, user_moves: userMoves });
      if (!alive()) return;
      userMoves = r.user_moves;
      moves.push(r.san);
      fen = r.fen;
      status = r.status;
      if (r.reply) moves.push(r.reply.san);
      await CP.showPosition(board, fen, { lastMove: r.reply ? CP.uciSquares(r.reply.uci) : CP.uciSquares(uci), movable: status === 'continue' });
      const kind = status === 'success' ? 'ok' : status === 'fail' ? 'bad' : '';
      draw(kind ? `<div class="feedback ${kind}">${h(r.message)}</div>` : '');
      if (kind) board.flash(kind);
      evalBar();
      busy = false;
    }

    await start();
    return () => board.destroy();
  }

  // ================================================================ banque
  async function bank(el) {
    let kind = route.q.kind || '';
    el.innerHTML = `<div class="row" style="margin-bottom:14px"><div class="pills" id="kinds">
      ${[['', 'Tous'], ['best', 'Meilleur coup'], ['threat', 'Menaces'], ['punish', 'Punir'], ['trap', 'Pièges']]
        .map(([v, l]) => `<button data-v="${v}" aria-pressed="${kind === v}">${l}</button>`).join('')}</div></div>
      <div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table"><thead><tr>
      <th>Type</th><th>Partie</th><th>Joué → mieux</th><th>Cause</th><th>Maîtrise</th><th>Prochaine</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div></div>`;
    async function load() {
      const d = await CP.api('/api/exercises/bank?' + CP.qs({ kind }));
      el.querySelector('#rows').innerHTML = d.exercises.length ? d.exercises.map((e) => `
        <tr class="${e.suspended ? 'muted' : ''}">
          <td><span class="chip ${e.kind === 'threat' ? 'warnc' : e.kind === 'trap' ? 'pen' : ''}">${CP.KINDS[e.kind]}</span></td>
          <td class="small">${e.opp_name ? `${h(e.opp_name)} · ${fmt.date(e.end_time)}` : h(e.note || 'trapfinder')}</td>
          <td class="small"><span class="cls-mistake">${h(e.played_san || '')}</span> → <b>${h(e.best_san || '')}</b></td>
          <td class="small ink2">${h(CP.TAGS[e.tag] || '')}</td>
          <td><span class="boxes">${[1, 2, 3, 4, 5, 6].map((i) => `<i class="${e.box >= i ? 'on' : ''}"></i>`).join('')}</span></td>
          <td class="small muted">${e.suspended ? 'en pause' : e.reps ? fmt.rel(e.due) : 'nouveau'}</td>
          <td class="r"><a class="btn btn-sm" href="#/erreurs?id=${e.id}">Faire</a>
            <button class="btn btn-sm btn-ghost" data-s="${e.id}" data-on="${e.suspended ? 0 : 1}">${e.suspended ? 'Reprendre' : 'Pause'}</button></td>
        </tr>`).join('') : '<tr><td colspan="7"><div class="empty">Aucun exercice pour l\'instant : ils arrivent avec l\'analyse de tes parties.</div></td></tr>';
      el.querySelectorAll('[data-s]').forEach((b) => (b.onclick = async () => {
        await CP.api('/api/exercises/suspend', { id: +b.dataset.s, on: +b.dataset.on });
        load();
      }));
    }
    el.querySelectorAll('#kinds button').forEach((b) => (b.onclick = () => {
      kind = b.dataset.v;
      el.querySelectorAll('#kinds button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      load();
    }));
    await load();
  }

  // ================================================================ séance
  async function session(el) {
    let queue;
    if (route.q.id) queue = [await CP.api('/api/exercises/one?id=' + route.q.id)];
    else queue = (await CP.api('/api/exercises/queue?' + CP.qs({ game: route.q.game, kind: route.q.kind }))).exercises;
    if (!queue.length) {
      const c = CP.status.exercises || {};
      el.innerHTML = `<div class="card empty" style="padding:40px">
        <h2>Rien à revoir pour l'instant</h2>
        <p>${c.total ? 'Tu as fait tes révisions du jour. Les prochaines arrivent demain.' : 'Les exercices sont créés au fil de l\'analyse de tes parties. Reviens dans quelques minutes.'}</p>
        <p class="row" style="justify-content:center"><a class="btn" href="#/erreurs?tab=bank">Voir la banque</a>
        <a class="btn" href="#/ouvertures?tab=drill">Réviser les ouvertures</a></p></div>`;
      return;
    }
    el.innerHTML = `
      <div class="session-bar"><span class="small muted num" id="sc"></span><div class="progress"><div id="sp" style="width:0"></div></div>
        <span class="small num" id="sres"></span></div>
      <div class="trainer">
        <div class="left"><div class="board-area"><div class="board-col"><div id="board"></div></div></div></div>
        <div class="stack"><div class="card" id="panel"></div></div>
      </div>`;
    const board = new Board(el.querySelector('#board'), { onMove });
    const panel = el.querySelector('#panel');
    let pos = 0, total = queue.length, okCount = 0, doneCount = 0;
    let ex, phase, fen, sol, accept, k, failed, finished, busy, t0 = 0;

    function progress() {
      el.querySelector('#sc').textContent = `${Math.min(doneCount + 1, total)} / ${total}`;
      el.querySelector('#sp').style.width = `${(100 * doneCount) / total}%`;
      el.querySelector('#sres').innerHTML = doneCount ? `<span class="ok">${okCount}</span> / ${doneCount} réussis` : '';
    }

    const sideName = (f) => (f.split(' ')[1] === 'w' ? 'les Blancs' : 'les Noirs');
    const turnText = (f) => (f.split(' ')[1] === 'w' ? 'Aux Blancs de jouer' : 'Aux Noirs de jouer');
    function prompt() {
      const g = ex.game;
      const opp = g ? h(g.opp_name) : 'l\'adversaire';
      if (ex.kind === 'threat' && phase === 'threat') return [`Que menace ${opp} ?`, `Avant de jouer, mets-toi à sa place : joue le coup que l'adversaire veut faire (${sideName(fen)}).`];
      if (ex.kind === 'threat') return ['Bien vu. Et maintenant ?', 'Trouve le meilleur coup, en tenant compte de cette menace.'];
      if (ex.kind === 'punish') return [`${opp} vient de se tromper`, `Comment le punir ? ${turnText(fen)}.`];
      if (ex.kind === 'trap') return [`Piège : l'adversaire a joué ${h(ex.played_san)}`, `Comment en profiter ? ${ex.note ? h(ex.note) + '.' : ''}`];
      return [`Tu as joué ${h(ex.played_san)} ici`, `Il y avait mieux. ${turnText(fen)}.`];
    }

    function meta() {
      const g = ex.game;
      const bits = [`<span class="chip ${ex.kind === 'threat' ? 'warnc' : ex.kind === 'trap' ? 'pen' : ''}">${CP.KINDS[ex.kind]}</span>`];
      if (ex.tag && ex.tag !== 'autre' && ex.kind !== 'trap') bits.push(`<span class="chip">${h(CP.TAGS[ex.tag] || ex.tag)}</span>`);
      bits.push(`<span class="boxes" title="Maîtrise">${[1, 2, 3, 4, 5, 6].map((i) => `<i class="${ex.box >= i ? 'on' : ''}"></i>`).join('')}</span>`);
      return `<div class="row" style="margin-bottom:10px">${bits.join('')}</div>
        ${g ? `<p class="small muted" style="margin:0 0 6px">Contre ${h(g.opp_name)} · ${fmt.tc('', g.time_class)} · ${fmt.date(g.end_time)}</p>` : ''}`;
    }

    function drawPanel(feedback = '') {
      const [title, sub] = prompt();
      panel.innerHTML = `${meta()}<p class="prompt">${title}</p><p class="ink2" style="margin:0">${sub}</p>
        <p class="small muted num" id="clock" style="margin:8px 0 0"></p>
        <div id="fb">${feedback}</div>
        <div class="row" style="margin-top:16px" id="actions">
          ${finished ? `<button class="btn btn-primary" id="nextb">Suivant <span class="kbd">Entrée</span></button>
              ${ex.game ? `<a class="btn" href="#/partie/${encodeURIComponent(ex.game_id)}?ply=${ex.ply}">Voir dans la partie</a>` : ''}`
            : `<button class="btn" id="hint">Indice</button><button class="btn btn-ghost" id="solb">Solution</button>`}
        </div>`;
      tick();
      const n = panel.querySelector('#nextb');
      if (n) n.onclick = next;
      const s = panel.querySelector('#solb');
      if (s) s.onclick = showSolution;
      const hi = panel.querySelector('#hint');
      if (hi) hi.onclick = () => {
        const sq = sol[k].slice(0, 2);
        board.mark(sq, 'good');
        fail();
      };
    }

    async function load() {
      ex = queue[pos];
      failed = false; finished = false; busy = false;
      phase = ex.kind === 'threat' ? 'threat' : 'main';
      fen = ex.fen; sol = ex.solution; accept = ex.accept; k = 0;
      const orient = ex.game ? ex.game.my_color : fen.split(' ')[1];
      board.setOrientation(orient);
      board.setArrows([]);
      board.clearMarks();
      board.movable = fen.split(' ')[1];
      await CP.showPosition(board, fen, { lastMove: CP.uciSquares(ex.last_uci), animate: false });
      t0 = performance.now();
      drawPanel();
      progress();
    }

    // Chrono : en révision, il faut trouver vite (comme en partie). La première fois, aucun objectif de temps.
    const secs = () => (performance.now() - t0) / 1000;
    function tick() {
      const c = panel.querySelector('#clock');
      if (!c || !ex) return;
      if (finished) { c.textContent = ''; return; }
      const s = Math.floor(secs());
      c.innerHTML = ex.reps > 0 && !ex._retry
        ? `<span class="${s > ex.target ? 'warn' : ''}">${s} s</span> · objectif : moins de ${ex.target} s`
        : `${s} s`;
    }
    const clockTimer = setInterval(tick, 1000);

    function fail() {
      if (failed) return;
      failed = true;
      if (!ex._retry) CP.api('/api/exercises/answer', { id: ex.id, ok: false, first: true });
    }

    async function apply(uci) {
      const r = await CP.api('/api/move', { fen, uci });
      fen = r.fen;
      board.set({ fen, lastMove: CP.uciSquares(uci), check: r.check, legal: r.legal });
      return r;
    }

    async function onMove(uci) {
      if (busy || finished) return;
      busy = true;
      const expected = sol[k];
      const okFirst = k === 0 && accept.includes(uci);
      const r0 = await CP.api('/api/move', { fen, uci });
      const mates = r0.status === 'checkmate';
      if (uci === expected || okFirst || mates) {
        board.clearMarks();
        await apply(uci);
        board.flash('ok');
        const alt = k === 0 && uci !== expected && !mates;
        k++;
        if (alt || mates || k >= sol.length) return phaseDone(alt);
        // L'adversaire répond, puis c'est de nouveau à toi.
        panel.querySelector('#fb').innerHTML = '<div class="feedback ok">Oui ! Continue…</div>';
        await new Promise((res) => setTimeout(res, 450));
        if (!alive()) return;
        await apply(sol[k]);
        k++;
        if (k >= sol.length) return phaseDone(false);
        busy = false;
        return;
      }
      board.flash('bad');
      const sq = CP.uciSquares(uci);
      board.set({ fen, lastMove: null, legal: [] , animate: true });
      await CP.showPosition(board, fen, { lastMove: k === 0 ? CP.uciSquares(ex.last_uci) : null });
      board.mark(sq[1], 'wrong');
      setTimeout(() => board.clearMarks(), 700);
      fail();
      panel.querySelector('#fb').innerHTML = `<div class="feedback bad">${h(r0.san)} ne marche pas. Réessaie, ou regarde la solution.</div>`;
      busy = false;
    }

    async function phaseDone(alt) {
      if (ex.kind === 'threat' && phase === 'threat' && ex.followup) {
        phase = 'main';
        const threatSan = (await CP.api('/api/move', { fen: ex.fen, uci: ex.solution[0] })).san;
        fen = ex.followup.fen; sol = ex.followup.solution; accept = ex.followup.accept; k = 0;
        await new Promise((res) => setTimeout(res, 500));
        if (!alive()) return;
        await CP.showPosition(board, fen, { lastMove: CP.uciSquares(ex.last_uci) });
        board.movable = fen.split(' ')[1];
        const [a, b] = CP.uciSquares(ex.solution[0]);
        board.setArrows([{ from: a, to: b, color: 'bad', opacity: 0.55 }]);
        drawPanel(`<div class="feedback ok">Exact : la menace, c'était ${h(threatSan)}.</div>`);
        busy = false;
        return;
      }
      finish(!failed, alt);
    }

    async function showSolution() {
      fail();
      busy = true;
      while (k < sol.length) {
        const [a, b] = CP.uciSquares(sol[k]);
        board.setArrows([{ from: a, to: b, color: 'ok' }]);
        await new Promise((res) => setTimeout(res, 700));
        if (!alive()) return;
        await apply(sol[k]);
        k++;
      }
      board.setArrows([]);
      if (ex.kind === 'threat' && phase === 'threat') { busy = false; return phaseDone(false); }
      finish(false, false, true);
    }

    async function finish(ok, alt, shown = false) {
      finished = true;
      board.setLegal([]);
      doneCount++;
      if (ok) okCount++;
      const took = secs();
      let slow = false;
      if (ok && !ex._retry) {
        const r = await CP.api('/api/exercises/answer', { id: ex.id, ok: true, first: true, secs: took });
        slow = r.grade === 'slow';
      }
      if (!ok && !ex._retry) queue.push({ ...ex, _retry: true }), total++;
      const best = ex.kind === 'threat' ? '' : ex.best_san;
      let msg;
      if (ok && slow) msg = `Juste, mais en ${Math.round(took)} s (objectif ${ex.target} s). En blitz, ce motif doit sauter aux yeux : il revient plus tôt.`;
      else if (ok) msg = alt ? `Bon coup, ça marche aussi. Stockfish préférait ${h(best)}.` : `Bravo, c'est ça (${Math.round(took)} s).`;
      else if (!shown) msg = ex._retry ? 'Trouvé, mais pas du premier coup : à revoir demain.' : 'Trouvé, mais pas du premier coup : il revient en fin de séance, puis demain.';
      else msg = ex._retry ? 'Toujours pas : il reviendra demain.' : 'Pas trouvé cette fois : il revient en fin de séance, puis demain.';
      let extra = '';
      if (ex.game && ex.played_san && ex.kind !== 'trap') extra = `<p class="small ink2" style="margin:10px 0 0">Dans ta partie : ${h(ex.played_san)}, qui t'a coûté ${Math.round(ex.gain)} % de chances de gain.</p>`;
      drawPanel(`<div class="feedback ${ok && !slow ? 'ok' : ok ? 'info' : 'bad'}">${msg}</div>${extra}`);
      progress();
    }

    async function next() {
      pos++;
      if (pos >= queue.length) return summary();
      await load();
    }

    function summary() {
      el.querySelector('#sp').style.width = '100%';
      const first = queue.filter((e) => !e._retry).length;
      el.innerHTML = `<div class="card" style="max-width:560px;margin:20px auto;text-align:center;padding:34px">
        <p class="eyebrow">Séance terminée</p><h1>${okCount} / ${doneCount}</h1>
        <p class="ink2">${first} exercice${first > 1 ? 's' : ''} vu${first > 1 ? 's' : ''}. Ceux que tu as ratés reviendront demain.</p>
        <p class="row" style="justify-content:center;margin-top:18px"><a class="btn btn-primary" href="#/">Retour à aujourd'hui</a>
          <a class="btn" href="#/ouvertures?tab=drill">Réviser les ouvertures</a></p></div>`;
      CP.refreshStatus();
    }

    CP.onKey = (e) => {
      if (e.key === 'Enter' && finished) { e.preventDefault(); next(); }
    };
    await load();
    return () => { board.destroy(); clearInterval(clockTimer); };
  }
};
