/* ChessPrac en ligne (Cloudflare Worker + base D1).

Ce qu'il garde : pour chaque compte, la liste des parties, la revue coup par coup déjà analysée par Stockfish et les
statistiques. Tout le monde peut les lire (téléphone, tablette...). Seules les installations qui ont la clé
(secret WRITE_KEY) peuvent en envoyer. L'entraînement (exercices, révisions, répertoire) n'y est jamais : il reste
sur le PC.

Les pages viennent du dépôt GitHub public, à la version WEB_REF : ce sont les mêmes que dans l'appli, en lecture seule.
*/
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json; charset=utf-8',
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-chessprac-key, x-body' };
const ACCOUNT = /^[a-z0-9_-]{2,40}$/;

const raw = (text, status = 200) => new Response(text, {
  status, headers: { 'content-type': TYPES.json, 'cache-control': 'no-store', ...CORS },
});
const json = (obj, status = 200) => raw(JSON.stringify(obj), status);

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

async function readBody(req) {
  if (req.headers.get('x-body') === 'gzip') {
    return new Response(req.body.pipeThrough(new DecompressionStream('gzip'))).text();
  }
  return req.text();
}

async function api(req, env, url) {
  const p = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (req.method === 'GET' && p === '/api/accounts') {
    const r = await env.DB.prepare('SELECT name, display, ratings, n_games, updated FROM accounts ORDER BY updated DESC').all();
    return json(r.results.map((a) => ({ ...a, ratings: a.ratings ? JSON.parse(a.ratings) : null })));
  }

  const m = p.match(/^\/api\/a\/([^/]+)\/(info|games|game|stats)$/);
  if (req.method === 'GET' && m) {
    const acc = decodeURIComponent(m[1]).toLowerCase();
    if (!ACCOUNT.test(acc)) return json({ error: 'Compte invalide' }, 400);
    if (m[2] === 'info') {
      const a = await env.DB.prepare('SELECT name, display, ratings, n_games, updated FROM accounts WHERE name=?').bind(acc).first();
      if (!a) return json({ error: `Le compte « ${acc} » n'est pas encore en ligne.` }, 404);
      return json({ ...a, ratings: a.ratings ? JSON.parse(a.ratings) : null });
    }
    if (m[2] === 'games') {
      const r = await env.DB.prepare('SELECT row FROM account_games WHERE account=? ORDER BY end_time DESC').bind(acc).all();
      return raw('[' + r.results.map((x) => x.row).join(',') + ']');
    }
    if (m[2] === 'game') {
      const r = await env.DB.prepare('SELECT payload FROM account_games WHERE account=? AND game_id=?')
        .bind(acc, url.searchParams.get('id') || '').first();
      return r ? raw(r.payload) : json({ error: 'Partie introuvable' }, 404);
    }
    const r = await env.DB.prepare('SELECT data FROM account_stats WHERE account=? AND key=?')
      .bind(acc, url.searchParams.get('k') || '|').first();
    return r ? raw(r.data) : json({ error: 'Statistiques pas encore en ligne' }, 404);
  }

  // Pour ne pas réanalyser une partie déjà analysée ailleurs (même partie vue par l'autre joueur, autre appareil).
  if (req.method === 'POST' && (p === '/api/known' || p === '/api/analyses')) {
    const ids = (JSON.parse(await readBody(req)).ids || []).filter((x) => typeof x === 'string').slice(0, 400);
    if (p === '/api/known') {
      const found = [];
      for (const part of chunks(ids, 90)) {
        const r = await env.DB.prepare(`SELECT DISTINCT game_id FROM account_games WHERE game_id IN (${part.map(() => '?').join(',')})`)
          .bind(...part).all();
        found.push(...r.results.map((x) => x.game_id));
      }
      return json(found);
    }
    const parts = [];
    for (const part of chunks(ids.slice(0, 40), 40)) {
      const r = await env.DB.prepare(`SELECT game_id, MAX(payload) payload FROM account_games WHERE game_id IN (${part.map(() => '?').join(',')}) GROUP BY game_id`)
        .bind(...part).all();
      for (const x of r.results) parts.push(JSON.stringify(x.game_id) + ':' + x.payload);
    }
    return raw('{' + parts.join(',') + '}');
  }

  /* Envoi depuis l'appli (avec la clé). Corps : une ligne d'en-tête JSON, puis une ligne par partie
     « G<tab>id<tab>fin<tab>ligne JSON<tab>revue JSON » et par statistique « S<tab>clé<tab>JSON ».
     Le JSON n'a jamais de vraie tabulation ni de retour à la ligne : découper coûte presque rien. */
  if (req.method === 'POST' && p === '/api/push') {
    if (!env.WRITE_KEY || req.headers.get('x-chessprac-key') !== env.WRITE_KEY) return json({ error: 'Clé refusée' }, 403);
    const lines = (await readBody(req)).split('\n');
    const head = JSON.parse(lines[0]);
    const acc = String(head.account || '').toLowerCase();
    if (!ACCOUNT.test(acc)) return json({ error: 'Compte invalide' }, 400);
    const now = Date.now() / 1000;
    const stmts = [];
    let games = 0, stats = 0;
    for (const line of lines.slice(1)) {
      const f = line.split('\t');
      if (f[0] === 'G' && f.length === 5) {
        stmts.push(env.DB.prepare(`INSERT INTO account_games(account, game_id, end_time, row, payload, updated) VALUES(?,?,?,?,?,?)
          ON CONFLICT(account, game_id) DO UPDATE SET end_time=excluded.end_time, row=excluded.row, payload=excluded.payload, updated=excluded.updated`)
          .bind(acc, f[1], Number(f[2]) || 0, f[3], f[4], now));
        games++;
      } else if (f[0] === 'S' && f.length === 3) {
        stmts.push(env.DB.prepare(`INSERT INTO account_stats(account, key, data, updated) VALUES(?,?,?,?)
          ON CONFLICT(account, key) DO UPDATE SET data=excluded.data, updated=excluded.updated`).bind(acc, f[1], f[2], now));
        stats++;
      }
    }
    stmts.push(env.DB.prepare(`INSERT INTO accounts(name, display, ratings, n_games, updated) VALUES(?,?,?,0,?)
      ON CONFLICT(name) DO UPDATE SET display=excluded.display, ratings=COALESCE(excluded.ratings, accounts.ratings), updated=excluded.updated`)
      .bind(acc, head.display || acc, head.ratings ? JSON.stringify(head.ratings) : null, now));
    stmts.push(env.DB.prepare('UPDATE accounts SET n_games=(SELECT COUNT(*) FROM account_games WHERE account=?) WHERE name=?').bind(acc, acc));
    await env.DB.batch(stmts);
    return json({ ok: true, games, stats });
  }
  return json({ error: 'route inconnue' }, 404);
}

async function asset(req, env, url) {
  const path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) return Response.redirect(url.origin + path.replace(/\/+$/, '') + url.search, 301);
  const seg = path.split('/').filter(Boolean);
  // « / » : la liste des comptes ; « /pseudo » : les parties et stats de ce compte. Même page dans les deux cas.
  const file = seg.length === 0 || (seg.length === 1 && !seg[0].includes('.')) ? 'index.html' : seg.join('/');
  if (!/^[\w\-./]+$/.test(file) || file.includes('..')) return new Response('Introuvable', { status: 404 });
  const r = await fetch(`https://raw.githubusercontent.com/${env.REPO}/${env.WEB_REF}/web/${file}`,
    { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) return new Response('Introuvable', { status: 404 });
  const ext = file.split('.').pop();
  return new Response(r.body, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=300' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Méthode non permise', { status: 405 });
      return await asset(req, env, url);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
