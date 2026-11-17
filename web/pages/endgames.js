/* Finales : les finales de base à jouer contre Stockfish, avec un objectif. */
CP.pages.endgames = async function (main, route, alive) {
  const { h } = CP;
  const { endgames } = await CP.api('/api/endgames');
  const GOALS = { mate: 'Mater', promote: 'Promouvoir et gagner', draw: 'Tenir la nulle', win_material: 'Gagner le pion' };

  if (!route.id) {
    main.innerHTML = `
      <div class="head"><div><p class="eyebrow">Finales</p><h1>Les finales à connaître</h1>
        <p class="lede">Joue chaque position contre Stockfish à pleine force, avec un objectif et une limite de coups.
          Ce sont les finales qui reviennent tout le temps à ton niveau.</p></div></div>
      <div class="grid">${endgames.map((e) => `
        <div class="card tile" data-id="${e.id}">
          <div class="mini" data-fen="${h(e.fen)}" data-o="${e.color}"></div>
          <h3 style="margin-top:6px">${h(e.title)}</h3>
          <p>${GOALS[e.goal]} en ${e.limit} coups max, avec les ${e.color === 'w' ? 'Blancs' : 'Noirs'}.</p>
          <p class="small muted">${e.tries ? `${e.wins} réussite${e.wins > 1 ? 's' : ''} sur ${e.tries} essai${e.tries > 1 ? 's' : ''}` : 'Pas encore essayé'}</p>
        </div>`).join('')}</div>`;
    main.querySelectorAll('.mini').forEach((m) => new Board(m, { fen: m.dataset.fen, orientation: m.dataset.o, interactive: false, coords: false }));
    main.querySelectorAll('.tile').forEach((t) => (t.onclick = () => (location.hash = '#/finale/' + t.dataset.id)));
    return;
  }

  const e = endgames.find((x) => x.id === route.id);
  if (!e) { main.innerHTML = '<div class="note bad">Finale introuvable.</div>'; return; }
  main.innerHTML = `
    <div class="head"><div><p class="eyebrow"><a href="#/finales">Finales</a></p><h1>${h(e.title)}</h1>
      <p class="lede">${GOALS[e.goal]} en ${e.limit} coups maximum. Tu as les ${e.color === 'w' ? 'Blancs' : 'Noirs'}.</p></div></div>
    <div class="trainer">
      <div class="left"><div class="board-area"><div class="board-col"><div id="board"></div></div></div></div>
      <div class="stack"><div class="card" id="panel"></div>
        <div class="card"><div class="card-title"><h3>L'idée</h3></div><p class="ink2" style="margin:0">${h(e.tip)}</p></div></div>
    </div>`;
  const board = new Board(main.querySelector('#board'), { orientation: e.color, movable: e.color, onMove });
  const panel = main.querySelector('#panel');
  let fen, moves, userMoves, status, busy;

  function draw(fb = '') {
    panel.innerHTML = `<p class="label">Coup ${userMoves} / ${e.limit}</p>
      <p class="pv" style="min-height:20px">${h(moves.join(' '))}</p><div id="fb">${fb}</div>
      <div class="row" style="margin-top:14px"><button class="btn ${status !== 'continue' ? 'btn-primary' : ''}" id="restart">Recommencer</button>
        <a class="btn btn-ghost" href="#/finales">Autres finales</a></div>`;
    panel.querySelector('#restart').onclick = start;
  }

  async function start() {
    busy = true;
    const r = await CP.api('/api/endgames/start', { id: e.id });
    fen = r.fen; moves = []; userMoves = 0; status = 'continue';
    if (r.reply) moves.push(r.reply.san);
    await CP.showPosition(board, fen, { lastMove: r.reply ? CP.uciSquares(r.reply.uci) : null, animate: false });
    draw();
    busy = false;
  }

  async function onMove(uci) {
    if (busy || status !== 'continue') return;
    busy = true;
    const r = await CP.api('/api/endgames/step', { id: e.id, fen, uci, user_moves: userMoves });
    if (!alive()) return;
    userMoves = r.user_moves;
    moves.push(r.san);
    // D'abord mon coup, puis la réponse de Stockfish.
    const mid = await CP.api('/api/move', { fen, uci });
    board.set({ fen: mid.fen, lastMove: CP.uciSquares(uci), check: mid.check, legal: [] });
    fen = r.fen;
    status = r.status;
    if (r.reply) {
      moves.push(r.reply.san);
      await new Promise((res) => setTimeout(res, 300));
    }
    await CP.showPosition(board, fen, { lastMove: r.reply ? CP.uciSquares(r.reply.uci) : CP.uciSquares(uci), movable: status === 'continue' });
    const kind = status === 'success' ? 'ok' : status === 'fail' ? 'bad' : '';
    draw(kind ? `<div class="feedback ${kind}">${h(r.message)}</div>` : '');
    if (kind) board.flash(kind === 'ok' ? 'ok' : 'bad');
    busy = false;
  }

  await start();
  return () => board.destroy();
};
