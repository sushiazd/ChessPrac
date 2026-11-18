/* Version en ligne (chessprac.….workers.dev/pseudo) : les mêmes pages, en lecture seule, nourries par les analyses
   envoyées depuis l'appli. Rien d'entraînement ici : exercices, révisions et répertoire restent sur le PC.
   Dans l'appli locale (127.0.0.1), ce fichier ne fait rien. */
(function () {
  const CP = window.CP;
  const params = new URLSearchParams(location.search);
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  if (local && !params.get('cloud')) return; // appli normale
  const seg = location.pathname.split('/').filter(Boolean);
  const base = (params.get('cloud') || '').replace(/\/$/, '');
  const account = seg.length === 1 && !seg[0].includes('.') ? seg[0].toLowerCase() : null;
  CP.online = { base, account };

  const fetchJson = async (path) => {
    const r = await fetch(base + path);
    let data = null;
    try { data = await r.json(); } catch (e) { /* vide */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Erreur ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  };
  const cache = {};
  const get = (path) => {
    if (!(path in cache)) cache[path] = fetchJson(path).catch((e) => { delete cache[path]; throw e; });
    return cache[path];
  };
  const acc = encodeURIComponent(account || '');

  CP.api = async function (path, body) {
    const [p, qs] = path.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs || ''));
    switch (p) {
      case '/api/status': {
        if (!account) return { online: true, username: null, version: 'en ligne' };
        const info = await get(`/api/a/${acc}/info`);
        return { online: true, version: 'en ligne', username: info.name, display_name: info.display || info.name,
          worker: { phase: 'idle' }, counts: { games: info.n_games }, ratings: info.ratings, updated: info.updated };
      }
      case '/api/games': {
        let list = await get(`/api/a/${acc}/games`);
        const s = (q.q || '').toLowerCase();
        list = list.filter((g) => (!q.tc || g.time_class === q.tc) && (!q.result || g.result === q.result)
          && (!q.color || g.my_color === q.color)
          && (!s || (g.opp_name || '').toLowerCase().includes(s) || (g.opening || '').toLowerCase().includes(s)));
        const off = +(q.offset || 0), lim = +(q.limit || 50);
        return { total: list.length, games: list.slice(off, off + lim) };
      }
      case '/api/game': return get(`/api/a/${acc}/game?id=${encodeURIComponent(q.id)}`);
      case '/api/stats': return get(`/api/a/${acc}/stats?k=${encodeURIComponent(`${q.tc || ''}|${q.days || ''}`)}`);
      case '/api/accounts': return get('/api/accounts');
      case '/api/position': return { fen: body.fen, legal: [], check: null };
      case '/api/move': return { fen: CP.applyUci(body.fen, body.uci), san: null };
      case '/api/game/reviewed': return { ok: true };
      default: throw new Error("Pas disponible en ligne : l'entraînement se fait dans l'appli, sur le PC.");
    }
  };

  /* Joue un coup (supposé légal, il vient de Stockfish) sur une FEN, sans moteur d'échecs. */
  CP.applyUci = function (fen, uci) {
    const [pl, turn, castle, ep, half, full] = fen.split(' ');
    const rows = pl.split('/').map((r) => r.replace(/\d/g, (d) => '.'.repeat(+d)).split(''));
    const at = (s) => [8 - +s[1], s.charCodeAt(0) - 97];
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const [fr, fc] = at(from), [tr, tc] = at(to);
    const piece = rows[fr][fc], target = rows[tr][tc];
    const white = piece === piece.toUpperCase(), kind = piece.toLowerCase();
    rows[fr][fc] = '.';
    if (kind === 'p' && to === ep && target === '.') rows[fr][tc] = '.';            // prise en passant
    if (kind === 'k' && Math.abs(tc - fc) === 2) {                                    // roque
      const rc = tc > fc ? 7 : 0, nc = tc > fc ? 5 : 3;
      rows[fr][nc] = rows[fr][rc];
      rows[fr][rc] = '.';
    }
    rows[tr][tc] = uci.length > 4 ? (white ? uci[4].toUpperCase() : uci[4]) : piece;
    let c = castle === '-' ? '' : castle;
    const lose = (chars) => { for (const ch of chars) c = c.replace(ch, ''); };
    if (piece === 'K') lose('KQ');
    if (piece === 'k') lose('kq');
    const corner = { a1: 'Q', h1: 'K', a8: 'q', h8: 'k' };
    [from, to].forEach((s) => corner[s] && lose(corner[s]));
    const newEp = kind === 'p' && Math.abs(tr - fr) === 2 ? from[0] + (white ? '3' : '6') : '-';
    const placement = rows.map((r) => r.join('').replace(/\.+/g, (m) => m.length)).join('/');
    return [placement, turn === 'w' ? 'b' : 'w', c || '-', newEp, kind === 'p' || target !== '.' ? 0 : +half + 1,
      turn === 'b' ? +full + 1 : +full].join(' ');
  };

  // ---------------------------------------------------------------- habillage : seulement Parties et Statistiques
  document.documentElement.classList.add('is-online');
  document.querySelectorAll('#nav a').forEach((a) => {
    if (!['games', 'diag'].includes(a.dataset.page)) a.remove();
  });
  const settings = document.querySelector('a[href="#/reglages"]');
  if (settings) settings.remove();
  const brand = document.querySelector('.brand');
  brand.href = base ? `/${location.search}` : '/';
  if (!account) document.getElementById('nav').classList.add('hidden');

  /* Accueil en ligne : les comptes déjà analysés. */
  CP.pages.accounts = async function (main) {
    const { h, fmt } = CP;
    const list = await CP.api('/api/accounts');
    const href = (name) => `/${encodeURIComponent(name)}${base ? location.search : ''}`;
    const rating = (r) => (r && r.rating ? r.rating : '—');
    main.innerHTML = `
      <div class="head"><div><p class="eyebrow">ChessPrac en ligne</p><h1>Les comptes analysés</h1>
        <p class="lede">Les parties et statistiques analysées par Stockfish dans ChessPrac, à consulter de partout.
          L'entraînement, lui, se fait dans l'appli.</p></div></div>
      ${list.length ? `<div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
        <thead><tr><th>Compte</th><th class="r">Parties</th><th class="r">Rapide</th><th class="r">Blitz</th><th class="r">Bullet</th><th class="r">Mis à jour</th></tr></thead>
        <tbody>${list.map((a) => `<tr class="click" data-href="${h(href(a.name))}"><td><b>${h(a.display || a.name)}</b></td>
          <td class="r num">${fmt.num(a.n_games)}</td><td class="r num">${rating(a.ratings && a.ratings.rapid)}</td>
          <td class="r num">${rating(a.ratings && a.ratings.blitz)}</td><td class="r num">${rating(a.ratings && a.ratings.bullet)}</td>
          <td class="r small muted">${fmt.rel(a.updated)}</td></tr>`).join('')}</tbody></table></div></div>`
        : '<div class="empty">Aucun compte en ligne pour l\'instant.</div>'}`;
    main.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.href = tr.dataset.href)));
  };
})();
