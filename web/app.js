/* Le squelette de l'appli : API, navigation entre pages, statut de fond, petits utilitaires. */
(function () {
  const CP = (window.CP = {
    pages: {},
    status: null,
    cleanup: null,
    onKey: null,
    renderId: 0,
  });

  CP.api = async function (path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    let data = null;
    try { data = await r.json(); } catch (e) { /* réponse vide */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Erreur ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  };

  CP.h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  CP.qs = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  CP.fmt = {
    date(ts) {
      if (!ts) return '—';
      const d = new Date(ts * 1000);
      return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`;
    },
    rel(ts) {
      if (!ts) return '—';
      const s = Date.now() / 1000 - ts;
      if (s < 0) {
        const d = Math.ceil(-s / 86400);
        return d <= 1 ? 'demain' : `dans ${d} j`;
      }
      if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`;
      if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
      const d = Math.round(s / 86400);
      return d === 1 ? 'hier' : d < 31 ? `il y a ${d} j` : CP.fmt.date(ts);
    },
    tc(tc, cls) {
      const names = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapide', daily: 'Daily' };
      let t = '';
      if (tc && !tc.includes('/')) {
        const [b, inc] = tc.split('+');
        const m = +b / 60;
        const base = m >= 1 ? String(Math.round(m * 10) / 10).replace('.', ',') : `${b} s`;
        t = inc ? ` ${m >= 1 ? base : b + 's'}+${inc}` : ` ${m >= 1 ? base + ' min' : base}`;
      }
      return (names[cls] || cls || '') + t;
    },
    result(r) { return { win: 'Victoire', loss: 'Défaite', draw: 'Nulle' }[r] || r; },
    pct(v, d = 0) { return v === null || v === undefined ? '—' : `${Number(v).toFixed(d)} %`; },
    num(v) { return v === null || v === undefined ? '—' : Number(v).toLocaleString('fr-FR'); },
    clock(s) {
      if (s === null || s === undefined) return '';
      s = Math.max(0, s);
      if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      if (s < 20) return `0:${s.toFixed(1).padStart(4, '0')}`;
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    },
    think(s) { return s === null || s === undefined ? '' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`; },
  };

  CP.CLS = {
    best: { label: 'Meilleur coup', mark: '★' },
    excellent: { label: 'Excellent', mark: '' },
    good: { label: 'Bon', mark: '' },
    inaccuracy: { label: 'Imprécision', mark: '?!' },
    mistake: { label: 'Erreur', mark: '?' },
    blunder: { label: 'Gaffe', mark: '??' },
  };
  CP.TAGS = { menace: 'Menace pas vue', piece: 'Pièce en prise', mat: 'Mat encaissé', 'mat-rate': 'Mat raté',
    occasion: 'Erreur adverse pas punie', autre: 'Autre', piege: 'Piège d\'ouverture' };
  CP.KINDS = { best: 'Meilleur coup', threat: 'Menace', punish: 'Punir', trap: 'Piège' };

  CP.toast = function (msg, ms = 2600) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  };

  /* « 1.e4 e5 2.Nf3 » à partir d'une liste de SAN et du numéro de demi-coup de départ. */
  CP.sanLine = function (sans, startPly = 0) {
    return sans.map((s, i) => {
      const ply = startPly + i;
      if (ply % 2 === 0) return `${ply / 2 + 1}.${s}`;
      return i === 0 ? `${(ply + 1) / 2}…${s}` : s;
    }).join(' ');
  };
  CP.plyOfFen = function (fen) {
    const p = fen.split(' ');
    return (+p[5] - 1) * 2 + (p[1] === 'b' ? 1 : 0);
  };

  /* Charge une position (coups légaux, échec) et l'affiche sur un échiquier. */
  CP.showPosition = async function (board, fen, { lastMove = null, movable = true, animate = true } = {}) {
    const info = await CP.api('/api/position', { fen });
    board.set({ fen, lastMove, check: info.check, legal: movable ? info.legal : [], animate });
    return info;
  };
  CP.uciSquares = (u) => (u ? [u.slice(0, 2), u.slice(2, 4)] : null);

  // ---------------------------------------------------------------- navigation

  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    const q = {};
    new URLSearchParams(query || '').forEach((v, k) => (q[k] = v));
    const map = { '': 'today', parties: 'games', partie: 'review', erreurs: 'train', ouvertures: 'openings',
      diagnostic: 'diag', finales: 'endgames', finale: 'endgames', reglages: 'settings' };
    return { page: map[parts[0] || ''] || 'today', id: parts[1] ? decodeURIComponent(parts[1]) : null, q, parts };
  }
  CP.route = parseRoute;

  CP.render = async function () {
    const r = parseRoute();
    const id = ++CP.renderId;
    if (CP.cleanup) { try { CP.cleanup(); } catch (e) { console.error(e); } }
    CP.cleanup = null;
    CP.onKey = null;
    document.querySelectorAll('#nav a').forEach((a) => {
      const cur = a.dataset.page === r.page || (r.page === 'review' && a.dataset.page === 'games');
      a.toggleAttribute('aria-current', false);
      if (cur) a.setAttribute('aria-current', 'page');
    });
    const root = document.getElementById('main');
    root.className = '';
    // Chaque page dessine dans son propre conteneur : si on change de page avant la fin d'un chargement,
    // l'ancienne page écrit dans un conteneur détaché au lieu d'écraser la nouvelle.
    root.innerHTML = '';
    const main = document.createElement('div');
    root.appendChild(main);
    main.innerHTML = '<div class="spinner"></div>';
    window.scrollTo(0, 0);
    let page = r.page;
    if (!CP.status) await CP.refreshStatus();
    if (!CP.status) {
      // Serveur ou base illisible : surtout ne pas afficher « Bienvenue », on croirait avoir tout perdu.
      main.innerHTML = `<div class="welcome card"><p class="eyebrow">Problème</p><h1>ChessPrac ne répond pas</h1>
        <p class="lede">${CP.h(CP.statusError || 'Le serveur local ne répond pas.')} Tes données ne sont pas effacées.</p>
        <button class="btn btn-primary" onclick="CP.status=null;CP.render()">Réessayer</button></div>`;
      return;
    }
    if (!CP.status.username && page !== 'settings') page = 'welcome';
    try {
      const fn = CP.pages[page];
      const cleanup = await fn(main, r, () => id === CP.renderId);
      if (id === CP.renderId) CP.cleanup = cleanup || null;
      else if (cleanup) cleanup();
    } catch (e) {
      console.error(e);
      if (id === CP.renderId) main.innerHTML = `<div class="note bad">${CP.h(e.message)}</div>`;
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if (CP.onKey) CP.onKey(e);
  });

  // ---------------------------------------------------------------- statut de fond

  CP.refreshStatus = async function () {
    try {
      CP.status = await CP.api('/api/status');
      CP.statusError = null;
    } catch (e) {
      CP.statusError = e.message;
      return;
    }
    const s = CP.status;
    if (s.notice && !CP.noticeShown) { CP.noticeShown = true; CP.toast(s.notice, 8000); }
    const pill = document.getElementById('status');
    const w = s.worker || {};
    pill.classList.remove('hidden', 'err');
    if (w.error) {
      pill.classList.add('err');
      pill.innerHTML = `<span>${CP.h(w.error)}</span>`;
    } else if (w.phase === 'sync') {
      pill.innerHTML = `<i class="ring"></i><span>Synchro chess.com…</span>`;
    } else if (w.phase === 'analyse') {
      pill.innerHTML = `<i class="ring"></i><span>Analyse ${w.done} / ${w.total}</span>`;
    } else if (s.username && s.counts) {
      pill.innerHTML = `<span>${CP.fmt.num(s.counts.games)} parties · à jour</span>`;
    } else {
      pill.classList.add('hidden');
    }
    const badge = document.getElementById('nav-ex');
    const n = s.exercises ? s.exercises.due + s.exercises.new_today : 0;
    badge.textContent = n;
    badge.classList.toggle('hidden', !n);
    document.getElementById('brand-sub').textContent = s.display_name || 'progresser avec ses parties';
    return s;
  };

  CP.start = function () {
    window.addEventListener('hashchange', () => CP.render());
    document.getElementById('status').addEventListener('click', async () => {
      await CP.api('/api/sync', {});
      CP.toast('Synchronisation lancée');
      setTimeout(CP.refreshStatus, 600);
    });
    CP.render();
    const loop = async () => {
      const s = await CP.refreshStatus();
      const busy = s && s.worker && s.worker.phase !== 'idle';
      setTimeout(loop, busy ? 2500 : 15000);
    };
    setTimeout(loop, 2500);
  };

  // ---------------------------------------------------------------- bienvenue

  CP.pages.welcome = async function (main) {
    main.innerHTML = `
      <div class="welcome card">
        <p class="eyebrow">Bienvenue</p>
        <h1>ChessPrac</h1>
        <p class="lede">Écris ton pseudo chess.com. L'outil récupère tes parties publiques (sans mot de passe), les analyse
          avec Stockfish sur ton PC, puis transforme tes erreurs en exercices et ton jeu d'ouverture en répertoire à réviser.</p>
        <form id="wf" class="row">
          <input class="input" id="wu" style="flex:1" placeholder="Ton pseudo chess.com" required autocomplete="off" spellcheck="false">
          <button class="btn btn-primary">Commencer</button>
        </form>
        <p class="small muted" id="werr" style="margin:12px 0 0">La première analyse prend du temps (environ 1 h pour 1000 parties),
          mais tes parties les plus récentes sont prêtes en quelques minutes.</p>
      </div>`;
    main.querySelector('#wf').onsubmit = async (e) => {
      e.preventDefault();
      const btn = main.querySelector('button');
      btn.disabled = true;
      try {
        await CP.api('/api/settings', { username: main.querySelector('#wu').value });
        await CP.refreshStatus();
        location.hash = '#/';
        CP.render();
      } catch (err) {
        main.querySelector('#werr').innerHTML = `<span class="bad">${CP.h(err.message)}</span>`;
        btn.disabled = false;
      }
    };
  };
})();
