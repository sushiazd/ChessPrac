/* Parties : toutes mes parties chess.com, filtrables, avec précision et gaffes. */
CP.pages.games = async function (main, route) {
  const { h, fmt } = CP;
  const q = { tc: route.q.tc || '', result: route.q.result || '', color: route.q.color || '', q: route.q.q || '' };
  let offset = 0;
  const limit = 60;

  main.innerHTML = `
    <div class="head"><div><p class="eyebrow">Parties</p><h1>${CP.online ? `Les parties de ${h(CP.status.display_name)}` : 'Mes parties'}</h1>
      <p class="lede">Ouvre une partie pour la revoir coup par coup, avec Stockfish et le temps passé sur chaque coup.</p></div></div>
    <div class="row" style="margin-bottom:14px">
      <div class="pills" id="tc">${[['', 'Toutes'], ['rapid', 'Rapide'], ['blitz', 'Blitz'], ['bullet', 'Bullet'], ['daily', 'Daily']]
        .map(([v, l]) => `<button data-v="${v}" aria-pressed="${q.tc === v}">${l}</button>`).join('')}</div>
      <span class="sp"></span>
      <select class="input" id="res"><option value="">Tous résultats</option><option value="win">Victoires</option>
        <option value="loss">Défaites</option><option value="draw">Nulles</option></select>
      <select class="input" id="col"><option value="">Les deux couleurs</option><option value="w">Avec les Blancs</option><option value="b">Avec les Noirs</option></select>
      <input class="input" id="search" placeholder="Adversaire ou ouverture" value="${h(q.q)}">
    </div>
    <div class="card" style="padding:6px 8px"><div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>Adversaire</th><th>Résultat</th><th>Ouverture</th><th>Cadence</th><th class="r">Précision</th><th class="r">Gaffes</th><th class="r">Date</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
      <div class="row" style="justify-content:center;padding:10px"><span class="muted small" id="count"></span>
        <button class="btn btn-sm hidden" id="more">Voir plus</button></div></div>`;
  main.querySelector('#res').value = q.result;
  main.querySelector('#col').value = q.color;

  async function load(reset) {
    if (reset) { offset = 0; main.querySelector('#rows').innerHTML = ''; }
    const data = await CP.api('/api/games?' + CP.qs({ ...q, limit, offset }));
    offset += data.games.length;
    main.querySelector('#rows').insertAdjacentHTML('beforeend', data.games.map((g) => `
      <tr class="click" data-id="${h(g.id)}">
        <td><span class="color-dot ${g.my_color}" title="${g.my_color === 'w' ? 'Blancs' : 'Noirs'}"></span></td>
        <td><b>${h(g.opp_name)}</b> <span class="muted">${g.opp_rating ?? ''}</span></td>
        <td><span class="chip ${g.result}">${fmt.result(g.result)}</span></td>
        <td class="small ink2">${h(g.opening || '')}</td>
        <td class="small">${fmt.tc(g.time_control, g.time_class)}</td>
        <td class="r num">${g.analyzed === 1 ? fmt.pct(g.acc_me) : g.analyzed === -1 ? '<span class="bad">erreur</span>' : '<span class="muted small">en attente</span>'}</td>
        <td class="r num">${g.analyzed === 1 ? (g.n_blunders ? `<span class="cls-blunder">${g.n_blunders}</span>` : '0') : ''}</td>
        <td class="r small muted">${fmt.date(g.end_time)}</td></tr>`).join(''));
    main.querySelector('#count').textContent = `${offset} / ${data.total} parties`;
    main.querySelector('#more').classList.toggle('hidden', offset >= data.total);
    main.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = '#/partie/' + encodeURIComponent(tr.dataset.id))));
  }

  main.querySelectorAll('#tc button').forEach((b) => (b.onclick = () => {
    q.tc = b.dataset.v;
    main.querySelectorAll('#tc button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    load(true);
  }));
  main.querySelector('#res').onchange = (e) => { q.result = e.target.value; load(true); };
  main.querySelector('#col').onchange = (e) => { q.color = e.target.value; load(true); };
  let deb;
  main.querySelector('#search').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { q.q = e.target.value; load(true); }, 250); };
  main.querySelector('#more').onclick = () => load(false);
  await load(true);
};
