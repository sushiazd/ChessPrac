/* Réglages : compte, rythme des exercices, force de l'analyse, jeton Lichess. */
CP.pages.settings = async function (main) {
  const { h } = CP;
  const s = await CP.api('/api/settings');
  const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
  const web = s.mode === 'browser';   // version 100 % navigateur (GitHub Pages) ou appli Windows
  const depth = web
    ? `${opt(25000, s.analysis_nodes, 'Rapide (2× plus vite, un peu moins précise)')}${opt(50000, s.analysis_nodes, 'Normale (conseillé)')}${opt(120000, s.analysis_nodes, 'Profonde (2× plus lent)')}`
    : `${opt(100000, s.analysis_nodes, 'Rapide (2× plus vite, un peu moins précise)')}
          ${opt(200000, s.analysis_nodes, 'Normale (conseillé)')}${opt(500000, s.analysis_nodes, 'Profonde (2× plus lent)')}`;
  const nWorkers = (web ? [1, 2, 3, 4, 6, 8] : [1, 2, 3, 4, 6, 8, 12, 16]).map((v) => opt(v, s.workers, v)).join('');
  document.getElementById('main').className = 'narrow';
  main.innerHTML = `
    <div class="head"><div><p class="eyebrow">Réglages</p><h1>Réglages</h1></div></div>
    <form class="card" id="f">
      <label class="field"><span>Compte chess.com</span>
        <input class="input" name="username" value="${h(s.username)}" spellcheck="false" autocomplete="off">
        <small>Parties publiques uniquement, sans mot de passe.</small></label>
      <label class="field"><span>Nouveaux exercices par jour</span>
        <select class="input" name="new_per_day">${[5, 10, 15, 20, 30, 50].map((v) => opt(v, s.new_per_day, v)).join('')}</select>
        <small>Les révisions (exercices déjà vus) ne sont jamais limitées.</small></label>
      <label class="field"><span>Force de l'analyse de fond</span>
        <select class="input" name="analysis_nodes">${depth}</select>
        <small>Chaque erreur est de toute façon revérifiée plus en profondeur avant de devenir un exercice.</small></label>
      <label class="field"><span>Stockfish en parallèle</span>
        <select class="input" name="workers">${nWorkers}</select>
        <small>Plus = analyse plus rapide, mais le PC travaille plus (chaque Stockfish prend un cœur du processeur
          et ${web ? 32 : 64} Mo de mémoire). Ton PC a ${s.cpu_count} cœurs logiques. Le changement s'applique tout de suite.</small></label>
      <label class="field"><span>Synchro automatique</span>
        <select class="input" name="auto_sync_minutes">${opt(15, s.auto_sync_minutes, 'Toutes les 15 min')}${opt(30, s.auto_sync_minutes, 'Toutes les 30 min')}
          ${opt(60, s.auto_sync_minutes, 'Toutes les heures')}${opt(240, s.auto_sync_minutes, 'Toutes les 4 h')}</select></label>
      <label class="field"><span>Jeton Lichess (optionnel)</span>
        <input class="input" name="lichess_token" type="password" placeholder="${s.has_lichess_token ? 'Jeton enregistré (laisse vide pour le garder)' : 'lip_…'}" autocomplete="off">
        <small>Ajoute dans « Ouvertures » ce que jouent les joueurs de 1000 à 1600 sur Lichess. Crée-le sur
          <a href="https://lichess.org/account/oauth/token" target="_blank" rel="noopener">lichess.org/account/oauth/token</a>, sans cocher aucun droit.</small></label>
      <div class="row"><button class="btn btn-primary">Enregistrer</button><span id="msg" class="small"></span></div>
    </form>
    ${web ? `<div class="card" id="data"><h3>Tes données</h3>
      <p class="small ink2" style="margin-top:0">Tout reste dans ce navigateur (stockage du site) : rien n'est envoyé à un serveur.
        Vider les données du site, changer de navigateur ou d'appareil les efface. Pour les garder ou les déplacer,
        exporte un fichier de sauvegarde et réimporte-le ailleurs.
        ${s.last_save ? `Dernière écriture ${CP.fmt.rel(s.last_save)}.` : ''}
        ${s.save_error ? `<span class="bad">Écriture impossible : ${h(s.save_error)}</span>` : ''}</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn" id="exp" type="button">Exporter mes données</button>
        <button class="btn" id="imp" type="button">Importer une sauvegarde</button>
        <button class="btn" id="wipe" type="button">Tout effacer</button>
        <input type="file" id="impf" accept=".db,.sqlite,application/octet-stream" hidden>
        <span id="dmsg" class="small"></span></div></div>` : ''}
    <div class="card"><h3>À propos</h3>
      <p class="small ink2" style="margin:0">ChessPrac ${h(CP.status.version)} · tes données : <span class="mono">${h(s.db_path)}</span><br>
        ${web ? 'Stockfish tourne dans ton navigateur (WebAssembly, version « lite »).<br>' : `Sauvegarde automatique chaque jour (${s.backups.length} gardée${s.backups.length > 1 ? 's' : ''}${s.backups.length ? `, la dernière ${CP.fmt.rel(s.backups[0].at)}` : ''}),
        restaurée toute seule si la base s'abîme.<br>`}
        Moteur : Stockfish 19 (GPL v3). Pièces : cburnett (CC BY-SA 3.0).<br>
        Outil de préparation hors partie : il ne lit jamais une partie en cours.</p></div>`;
  if (web) {
    const dmsg = main.querySelector('#dmsg');
    main.querySelector('#exp').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(CP.local.exportData());
      a.download = `chessprac-${new Date().toISOString().slice(0, 10)}.db`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    const f = main.querySelector('#impf');
    main.querySelector('#imp').onclick = () => f.click();
    f.onchange = async () => {
      if (!f.files[0]) return;
      if (!confirm('Remplacer toutes les données de ce navigateur par cette sauvegarde ?')) return;
      dmsg.textContent = 'Import…';
      try {
        await CP.local.importData(f.files[0]);
        CP.status = null;
        location.hash = '#/';
        CP.render();
        CP.toast('Sauvegarde importée');
      } catch (err) {
        dmsg.innerHTML = `<span class="bad">Fichier refusé : ${h(err.message)}</span>`;
      }
    };
    main.querySelector('#wipe').onclick = async () => {
      if (!confirm('Effacer toutes les données de ce navigateur (parties, analyses, exercices) ? Tu peux les retélécharger depuis chess.com, mais pas les ré-analyser sans refaire le travail.')) return;
      await CP.local.eraseData();
      CP.status = null;
      location.hash = '#/';
      CP.render();
    };
  }
  main.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    if (!fd.lichess_token) delete fd.lichess_token;
    if (fd.username === s.username) delete fd.username;
    const msg = main.querySelector('#msg');
    msg.textContent = 'Enregistrement…';
    try {
      await CP.api('/api/settings', fd);
      await CP.refreshStatus();
      msg.innerHTML = '<span class="ok">Enregistré.</span>';
    } catch (err) {
      msg.innerHTML = `<span class="bad">${h(err.message)}</span>`;
    }
  };
};
