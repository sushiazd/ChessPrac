/* Réglages : compte, rythme des exercices, force de l'analyse, jeton Lichess. */
CP.pages.settings = async function (main) {
  const { h } = CP;
  const s = await CP.api('/api/settings');
  const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
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
        <select class="input" name="analysis_nodes">${opt(100000, s.analysis_nodes, 'Rapide (2× plus vite, un peu moins précise)')}
          ${opt(200000, s.analysis_nodes, 'Normale (conseillé)')}${opt(500000, s.analysis_nodes, 'Profonde (2× plus lent)')}</select>
        <small>Chaque erreur est de toute façon revérifiée plus en profondeur avant de devenir un exercice.</small></label>
      <label class="field"><span>Stockfish en parallèle</span>
        <select class="input" name="workers">${[1, 2, 3, 4, 6, 8, 12, 16].map((v) => opt(v, s.workers, v)).join('')}</select>
        <small>Plus = analyse plus rapide, mais le PC travaille plus (chaque Stockfish prend un cœur du processeur
          et 64 Mo de mémoire). Ton PC a ${s.cpu_count} cœurs logiques. Le changement s'applique tout de suite.</small></label>
      <label class="field"><span>Synchro automatique</span>
        <select class="input" name="auto_sync_minutes">${opt(15, s.auto_sync_minutes, 'Toutes les 15 min')}${opt(30, s.auto_sync_minutes, 'Toutes les 30 min')}
          ${opt(60, s.auto_sync_minutes, 'Toutes les heures')}${opt(240, s.auto_sync_minutes, 'Toutes les 4 h')}</select></label>
      <label class="field"><span>Jeton Lichess (optionnel)</span>
        <input class="input" name="lichess_token" type="password" placeholder="${s.has_lichess_token ? 'Jeton enregistré (laisse vide pour le garder)' : 'lip_…'}" autocomplete="off">
        <small>Ajoute dans « Ouvertures » ce que jouent les joueurs de 1000 à 1600 sur Lichess. Crée-le sur
          <a href="https://lichess.org/account/oauth/token" target="_blank" rel="noopener">lichess.org/account/oauth/token</a>, sans cocher aucun droit.</small></label>
      <div class="row"><button class="btn btn-primary">Enregistrer</button><span id="msg" class="small"></span></div>
    </form>
    <form class="card" id="cf"><h3>En ligne</h3>
      <p class="small ink2" style="margin:0 0 12px">Tes parties analysées et tes statistiques sont aussi consultables de partout
        (téléphone, tablette), sans rien réanalyser${s.cloud.page ? ` : <a href="${h(s.cloud.page)}" target="_blank" rel="noopener">${h(s.cloud.page.replace(/^https?:\/\//, ''))}</a>` : ''}.
        Tout le monde peut les voir. L'entraînement (exercices, révisions, répertoire) reste sur ce PC.<br>
        Une partie déjà analysée en ligne (par ton adversaire, ou sur un autre appareil) est reprise au lieu d'être réanalysée.</p>
      <div id="cloud-state" class="small" style="margin-bottom:12px"></div>
      <label class="field"><span>Clé d'envoi</span>
        <input class="input" name="cloud_key" type="password" autocomplete="off" placeholder="${s.cloud.has_key ? (s.cloud.key_in_file ? 'Clé lue dans cle-en-ligne.txt' : 'Clé enregistrée (laisse vide pour la garder)') : 'Colle la clé ici'}">
        <small>Sans clé, l'appli reprend les analyses en ligne mais n'envoie rien.</small></label>
      <div class="row"><button class="btn">Enregistrer la clé</button><span id="cmsg" class="small"></span></div>
    </form>
    <div class="card"><h3>À propos</h3>
      <p class="small ink2" style="margin:0">ChessPrac ${h(CP.status.version)} · tes données : <span class="mono">${h(s.db_path)}</span><br>
        Sauvegarde automatique chaque jour (${s.backups.length} gardée${s.backups.length > 1 ? 's' : ''}${s.backups.length ? `, la dernière ${CP.fmt.rel(s.backups[0].at)}` : ''}),
        restaurée toute seule si la base s'abîme.<br>
        Moteur : Stockfish 19 (GPL v3). Pièces : cburnett (CC BY-SA 3.0).<br>
        Outil de préparation hors partie : il ne lit jamais une partie en cours.</p></div>`;
  const cloudState = () => {
    const c = (CP.status.worker || {}).cloud || {};
    const el = main.querySelector('#cloud-state');
    if (!el) return;
    if (!s.cloud.home) el.innerHTML = '<span class="muted">Désactivé sur ce PC.</span>';
    else if (!s.cloud.has_key) el.innerHTML = '<span class="muted">Pas de clé : rien n’est envoyé.</span>';
    else if (c.error) el.innerHTML = `<span class="bad">${h(c.error)}</span>`;
    else el.innerHTML = `<b>${CP.fmt.num(c.online)}</b> partie${c.online > 1 ? 's' : ''} en ligne${c.pending ? ` · ${CP.fmt.num(c.pending)} à envoyer` : ''}${c.sending ? ' · envoi en cours…' : c.last ? ` · dernier envoi ${CP.fmt.rel(c.last)}` : ''}`;
  };
  cloudState();
  const cloudTimer = setInterval(async () => { await CP.refreshStatus(); cloudState(); }, 4000);
  main.querySelector('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.cloud_key.value.trim();
    const msg = main.querySelector('#cmsg');
    if (!v) { msg.textContent = ''; return; }
    await CP.api('/api/settings', { cloud_key: v });
    s.cloud.has_key = true;
    e.target.cloud_key.value = '';
    msg.innerHTML = '<span class="ok">Clé enregistrée, l’envoi démarre.</span>';
  };
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
  return () => clearInterval(cloudTimer);
};
