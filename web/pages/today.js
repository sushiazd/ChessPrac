/* Aujourd'hui : la séance du jour, mon niveau, l'état de l'analyse et mes dernières parties. */
CP.pages.today = async function (main) {
  const { h, fmt } = CP;
  const t = await CP.api('/api/today');
  const s = CP.status || {};
  const ex = t.exercises, act = t.activity || {};
  const drillDue = t.drill.w.due + t.drill.b.due;
  const drillPos = t.drill.w.positions + t.drill.b.positions;
  const exTodo = ex.due + ex.new_today;
  const hour = new Date().getHours();
  const hello = hour < 5 || hour >= 18 ? 'Bonsoir' : 'Salut';

  const ratingTile = (key, label) => {
    const r = t.ratings && t.ratings[key];
    if (!r || !r.rating) return '';
    return `<div class="stat"><div class="label">${label}</div><div class="v num">${r.rating}</div>
      <div class="s">${r.best ? 'record ' + r.best : '&nbsp;'}</div></div>`;
  };

  const step = (n, done, title, sub, btn) => `
    <div class="step ${done ? 'done' : ''}"><span class="n">${done ? '✓' : n}</span>
      <div class="t"><b>${title}</b><span>${sub}</span></div>${btn}</div>`;

  const exDone = act.ex_done || 0;
  const step1 = step(1, exTodo === 0 && exDone > 0, 'Revoir tes erreurs',
    exTodo ? `${exTodo} exercice${exTodo > 1 ? 's' : ''} : ${ex.due} à réviser, ${ex.new_today} nouveau${ex.new_today > 1 ? 'x' : ''} tiré${ex.new_today > 1 ? 's' : ''} de tes parties`
      : exDone ? `${exDone} faits aujourd'hui, ${act.ex_ok || 0} réussis` : ex.total ? 'Rien à revoir pour l\'instant' : 'Les exercices arrivent avec l\'analyse de tes parties',
    `<a class="btn ${exTodo ? 'btn-primary' : ''}" href="#/erreurs">${exTodo ? 'Commencer' : 'Ouvrir'}</a>`);
  const step2 = step(2, drillPos > 0 && drillDue === 0, 'Réviser tes ouvertures',
    drillPos ? (drillDue ? `${drillDue} position${drillDue > 1 ? 's' : ''} de ton répertoire à revoir` : 'Répertoire à jour')
      : 'Construis ton répertoire à partir de tes parties (1 clic)',
    `<a class="btn ${drillPos && drillDue ? 'btn-primary' : ''}" href="#/ouvertures?tab=${drillPos ? 'drill' : 'tree'}">${drillPos ? 'S\'entraîner' : 'Construire'}</a>`);
  const u = t.unreviewed;
  const step3 = step(3, !u && (act.reviews || 0) > 0, 'Revoir ta dernière partie',
    u ? `${fmt.result(u.result)} contre ${h(u.opp_name)} (${u.opp_rating}), ${fmt.tc(u.time_control, u.time_class)}, ${fmt.rel(u.end_time)}`
      : (act.reviews ? 'Fait' : 'Tes parties analysées apparaîtront ici'),
    u ? `<a class="btn" href="#/partie/${encodeURIComponent(u.id)}">Revoir</a>` : '<a class="btn" href="#/parties">Parties</a>');

  const w = s.worker || {};
  const c = s.counts || { games: 0, analyzed: 0, todo: 0 };
  const pct = c.games ? Math.round((100 * c.analyzed) / c.games) : 0;

  main.innerHTML = `
    <div class="head"><div>
      <p class="eyebrow">Aujourd'hui${t.streak ? ` · série de ${t.streak} jour${t.streak > 1 ? 's' : ''}` : ''}</p>
      <h1>${hello} ${h(t.username)}</h1>
      <p class="lede">Une séance courte chaque jour vaut mieux qu'une longue de temps en temps : tes erreurs, tes ouvertures, ta dernière partie.</p>
    </div></div>
    <div class="stats-row">${ratingTile('rapid', 'Rapide')}${ratingTile('blitz', 'Blitz')}${ratingTile('bullet', 'Bullet')}${ratingTile('puzzles', 'Puzzles (record)')}</div>
    <div class="grid-2" style="align-items:start">
      <div class="card"><div class="card-title"><h2>Séance du jour</h2></div><div class="steps">${step1}${step2}${step3}</div></div>
      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>Analyse Stockfish</h3><span class="sp"></span>
            <button class="btn btn-sm" id="sync">Synchroniser</button></div>
          <div class="progress"><div id="an-bar" style="width:${pct}%"></div></div>
          <p class="small muted" style="margin:8px 0 0" id="an-text"></p>
        </div>
        <div class="card"><div class="card-title"><h3>Dernières parties</h3><span class="sp"></span><a class="small" href="#/parties">Tout voir</a></div>
          <div id="recent"></div></div>
      </div>
    </div>`;

  main.querySelector('#recent').innerHTML = t.recent.length ? `<table class="table"><tbody>${t.recent.map((g) => `
      <tr class="click" data-id="${h(g.id)}">
        <td><span class="color-dot ${g.my_color}"></span></td>
        <td><b>${h(g.opp_name)}</b> <span class="muted">${g.opp_rating}</span><div class="small muted">${fmt.tc(g.time_control, g.time_class)} · ${fmt.rel(g.end_time)}</div></td>
        <td><span class="chip ${g.result}">${fmt.result(g.result)}</span></td>
        <td class="r small">${g.analyzed === 1 ? `${fmt.pct(g.acc_me)}` : '<span class="muted">…</span>'}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">Synchro en cours…</div>';
  main.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = '#/partie/' + encodeURIComponent(tr.dataset.id))));
  main.querySelector('#sync').onclick = async () => {
    await CP.api('/api/sync', {});
    CP.toast('Synchronisation lancée');
    setTimeout(CP.refreshStatus, 800);
  };
  // Pendant l'analyse, seule la barre de progression se met à jour (la page ne bouge pas).
  function progress() {
    const st = CP.status || {}, wk = st.worker || {}, cc = st.counts || c;
    const p = cc.games ? Math.round((100 * cc.analyzed) / cc.games) : 0;
    main.querySelector('#an-bar').style.width = p + '%';
    main.querySelector('#an-text').innerHTML = `${fmt.num(cc.analyzed)} / ${fmt.num(cc.games)} parties analysées
      ${wk.phase === 'analyse' ? ` · en cours (${wk.done}/${wk.total})` : ''}${wk.error ? ` · <span class="bad">${h(wk.error)}</span>` : ''}.
      ${cc.todo ? 'Les plus récentes d\'abord : ouvre une partie pour la faire passer devant.' : ''}`;
  }
  progress();
  const timer = setInterval(progress, 3000);
  return () => clearInterval(timer);
};
