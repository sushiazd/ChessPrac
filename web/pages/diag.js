/* Diagnostic : où et comment je perds des points. */
CP.pages.diag = async function (main, route) {
  const { h, fmt } = CP;
  const tc = route.q.tc || '';
  const days = route.q.days || '';
  const go = (p) => (location.hash = '#/diagnostic?' + CP.qs({ tc, days, ...p }));
  const s = await CP.api('/api/stats?' + CP.qs({ tc, days }));

  const tcPills = [['', 'Toutes'], ['rapid', 'Rapide'], ['blitz', 'Blitz'], ['bullet', 'Bullet']]
    .map(([v, l]) => `<button data-tc="${v}" aria-pressed="${tc === v}">${l}</button>`).join('');
  const dayPills = [['30', '30 j'], ['90', '3 mois'], ['365', '1 an'], ['', 'Tout']]
    .map(([v, l]) => `<button data-d="${v}" aria-pressed="${days === v}">${l}</button>`).join('');
  const res = s.results, tot = res.win + res.draw + res.loss;

  main.innerHTML = `
    <div class="head"><div><p class="eyebrow">Diagnostic</p><h1>Où tu perds des points</h1>
      <p class="lede">${fmt.num(s.games)} parties, dont ${fmt.num(s.analyzed)} analysées par Stockfish.
        ${s.analyzed < s.games ? 'Les chiffres se précisent au fil de l\'analyse.' : ''}</p></div>
      <div class="stack" style="gap:8px;align-items:flex-end"><div class="pills" id="tcp">${tcPills}</div><div class="pills" id="dp">${dayPills}</div></div></div>
    ${s.insights.length ? `<div class="card" style="margin-bottom:18px"><div class="card-title"><h2>À retenir</h2></div>
      <div class="insights">${s.insights.map((i) => `<div class="insight ${i.kind}"><i></i><div>${h(i.text)}</div></div>`).join('')}</div></div>` : ''}
    <div class="stats-row">
      <div class="stat"><div class="label">Score</div><div class="v">${tot ? Math.round((100 * (res.win + res.draw / 2)) / tot) : '—'} %</div>
        <div class="s">${res.win} V · ${res.draw} N · ${res.loss} D</div></div>
      <div class="stat"><div class="label">Précision</div><div class="v">${s.per_game ? fmt.pct(s.per_game.acc) : '—'}</div><div class="s">moyenne par partie</div></div>
      <div class="stat"><div class="label">Gaffes / partie</div><div class="v">${s.per_game ? String(s.per_game.blunders).replace('.', ',') : '—'}</div>
        <div class="s">${s.per_game ? `+ ${String(s.per_game.mistakes).replace('.', ',')} erreurs` : ''}</div></div>
      <div class="stat"><div class="label">Blancs / Noirs</div><div class="v">${scoreOf(s.by_color.w)} · ${scoreOf(s.by_color.b)}</div><div class="s">score selon la couleur</div></div>
    </div>
    <div class="card" style="margin-bottom:18px"><div class="card-title"><h2>Elo</h2></div><div id="ratings"></div></div>
    <div class="grid-2">
      <div class="card"><div class="card-title"><h3>Pourquoi tes erreurs</h3></div><div id="tags"></div>
        <p class="small muted" style="margin:10px 0 0">Erreurs et gaffes (−20 % de chances de gain ou plus), selon ce que l'adversaire pouvait faire ensuite.</p></div>
      <div class="card"><div class="card-title"><h3>Comment tu perds</h3></div><div id="losses"></div></div>
      <div class="card"><div class="card-title"><h3>Gaffes selon la phase</h3></div><div id="phases"></div></div>
      <div class="card"><div class="card-title"><h3>Gaffes selon le temps de réflexion</h3></div><div id="think"></div>
        <p class="small muted" style="margin:10px 0 0">Part des coups qui sont des gaffes, selon le temps passé sur le coup.</p></div>
      <div class="card"><div class="card-title"><h3>Gaffes selon la pendule</h3></div><div id="clock"></div>
        <p class="small muted" style="margin:10px 0 0">Part des coups qui sont des gaffes, selon le temps qu'il te restait.</p></div>
      <div class="card"><div class="card-title"><h3>Précision dans le temps</h3></div><div id="acc"></div></div>
    </div>
    <div class="card" style="margin-top:18px"><div class="card-title"><h2>Tes ouvertures</h2><span class="sp"></span>
      <a class="btn btn-sm" href="#/ouvertures">Travailler mes ouvertures</a></div>
      <div class="table-wrap"><table class="table"><thead><tr><th></th><th>Début de partie</th><th>Nom</th><th class="r">Parties</th>
        <th class="r">Score</th><th class="r">Précision</th><th class="r">Gaffes / partie</th></tr></thead><tbody>
      ${s.openings.map((o) => `<tr class="click" data-c="${o.color}"><td><span class="color-dot ${o.color}"></span></td><td class="mono">${h(o.line)}</td>
        <td class="small ink2">${h(o.name || '')}</td><td class="r num">${o.n}</td>
        <td class="r num ${o.score <= 40 ? 'bad' : o.score >= 60 ? 'ok' : ''}">${o.score} %</td>
        <td class="r num">${fmt.pct(o.acc)}</td><td class="r num">${o.blunders ?? '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`;

  function scoreOf(c) { const n = c.win + c.draw + c.loss; return n ? Math.round((100 * (c.win + c.draw / 2)) / n) + ' %' : '—'; }

  main.querySelectorAll('#tcp button').forEach((b) => (b.onclick = () => go({ tc: b.dataset.tc })));
  main.querySelectorAll('#dp button').forEach((b) => (b.onclick = () => go({ days: b.dataset.d })));
  main.querySelectorAll('tr[data-c]').forEach((tr) => (tr.onclick = () => (location.hash = '#/ouvertures?color=' + tr.dataset.c)));

  const colors = { rapid: 'var(--pen)', blitz: 'var(--warn)', bullet: 'var(--bad)', daily: 'var(--ok)' };
  const names = { rapid: 'Rapide', blitz: 'Blitz', bullet: 'Bullet', daily: 'Daily' };
  const since = days ? Date.now() / 1000 - days * 86400 : 0;
  const series = Object.entries(s.ratings).filter(([k]) => !tc || k === tc)
    .map(([k, pts]) => ({ name: names[k] || k, color: colors[k] || 'var(--ink-2)', points: pts.filter((p) => p[0] >= since) }))
    .filter((x) => x.points.length > 1);
  Charts.lineChart(main.querySelector('#ratings'), series);

  const n = s.analyzed;
  if (!n) {
    for (const id of ['tags', 'phases', 'think', 'clock', 'acc']) main.querySelector('#' + id).innerHTML = '<div class="empty">En attente de l\'analyse.</div>';
  } else {
    Charts.hbars(main.querySelector('#tags'), s.tags.map((t) => ({ label: t.label, value: t.n, text: t.n, bad: ['menace', 'piece', 'mat'].includes(t.tag) })));
    Charts.hbars(main.querySelector('#phases'), s.phases.map((p) => ({ label: p.phase[0].toUpperCase() + p.phase.slice(1), value: p.blunders_per_game,
      text: `${String(p.blunders_per_game).replace('.', ',')} / partie` })));
    const rate = (b) => ({ label: b.label, value: b.rate || 0, text: b.moves ? `${String(b.rate ?? 0).replace('.', ',')} %` : '—', bad: (b.rate || 0) >= 6 });
    Charts.hbars(main.querySelector('#think'), s.think.map(rate));
    Charts.hbars(main.querySelector('#clock'), s.clock.map(rate));
    Charts.lineChart(main.querySelector('#acc'), [{ name: 'Précision', color: 'var(--ok)', points: s.accuracy_weeks.map((w) => [w[0], w[1]]) }],
      { height: 190, fmtY: (v) => v + ' %' });
  }
  Charts.hbars(main.querySelector('#losses'), s.losses.map((l) => ({ label: l.label, value: l.n, text: l.n, bad: true })));
};
