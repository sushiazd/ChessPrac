/* ChessPrac en ligne, côté navigateur (même rôle que chessprac/cloud.py) :
- envoi (il faut la clé) : chaque partie analysée part en ligne avec sa revue coup par coup, puis les statistiques ;
- reprise (sans clé) : une partie déjà analysée en ligne (par l'adversaire, ou sur un autre appareil) est reprise
  au lieu d'être réanalysée.
L'entraînement (exercices, révisions, répertoire, finales) n'est jamais envoyé. */
import * as db from './sqldb.js';
import { mean } from './analysis.js';
import { gamePayload, statsPayload } from './api.js';

export const CLOUD_URL = 'https://chessprac.sushi-adouane.workers.dev';
const PUSH_BATCH = 10;
const PULL_BATCH = 20;
export const STATS_EVERY = 10 * 60;
export const STATS_REFRESH = 12 * 3600;
const STATS_TC = ['', 'rapid', 'blitz', 'bullet'];
const STATS_DAYS = ['30', '90', '365', ''];
const IMPORTED = ['cp_before', 'mate_before', 'cp_after', 'mate_after', 'best_uci', 'best_san', 'wp_before', 'wp_after',
  'drop', 'accuracy', 'cls', 'missed', 'phase', 'special'];

export class CloudError extends Error {}

export const base = () => (db.getSetting('cloud_url') || CLOUD_URL).replace(/\/+$/, '');
export const key = () => db.getSetting('cloud_key') || '';
export const pageUrl = (username) => `${base()}/${username.toLowerCase()}`;

async function request(path, body, headers = {}) {
  let r;
  try {
    r = await fetch(base() + path, body === undefined ? {} : { method: 'POST', body, headers });
  } catch (e) {
    throw new CloudError(`ChessPrac en ligne injoignable (${e.message})`);
  }
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  if (!r.ok) throw new CloudError((data && data.error) || `ChessPrac en ligne a répondu ${r.status}`);
  return data;
}
const postJson = (path, obj) => request(path, JSON.stringify(obj), { 'Content-Type': 'application/json' });

// ---------------------------------------------------------------- reprise des analyses déjà en ligne

const absent = new Set();   // parties déjà cherchées en ligne sans succès (depuis l'ouverture de la page)

/** Reprend l'analyse d'une partie déjà en ligne. Les exercices seront faits ici (pending_ex). */
export function importPayload(gameId, data) {
  const g = db.get('SELECT my_color, analyzed FROM games WHERE id=?', [gameId]);
  const rows = db.all('SELECT ply, uci FROM moves WHERE game_id=? ORDER BY ply', [gameId]);
  const plies = (data && data.plies) || [];
  if (!g || g.analyzed === 1 || !rows.length || rows.length !== plies.length) return false;
  if (rows.some((r, i) => r.uci !== plies[i].uci || r.ply !== plies[i].ply)) return false;   // pas les mêmes coups
  if (plies.some((p) => p.cls === null || p.cls === undefined || p.accuracy === null || p.accuracy === undefined)) return false;
  const my = g.my_color, opp = my === 'w' ? 'b' : 'w';
  const acc = { w: [], b: [] };
  const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };
  const updates = plies.map((p) => {
    acc[p.color].push(p.accuracy);
    if (p.color === my && p.cls in counts) counts[p.cls] += 1;
    const pv = Array.isArray(p.pv) ? p.pv.join(' ') : p.pv || '';
    return [...IMPORTED.map((k) => (p[k] === undefined ? null : p[k])), pv, gameId, p.ply];
  });
  db.transaction(() => {
    db.runMany(`UPDATE moves SET ${IMPORTED.map((k) => `"${k}"=?`).join(', ')}, pv=?, tag=NULL WHERE game_id=? AND ply=?`, updates);
    db.run(`UPDATE games SET analyzed=1, analyzed_at=?, acc_me=?, acc_opp=?, n_inacc=?, n_mistakes=?, n_blunders=?,
            specials_done=1, pending_ex=1, uploaded=0 WHERE id=? AND analyzed != 1`,
    [db.now(), mean(acc[my]), mean(acc[opp]), counts.inaccuracy, counts.mistake, counts.blunder, gameId]);
  });
  return true;
}

export async function pull(username, isStopped = () => false) {
  if (!base()) return 0;
  const todo = db.all('SELECT id FROM games WHERE username=? AND analyzed IN (0, 2) ORDER BY end_time DESC',
    [username.toLowerCase()]).map((r) => r.id).filter((id) => !absent.has(id));
  let imported = 0;
  for (let i = 0; i < todo.length; i += 400) {
    const part = todo.slice(i, i + 400);
    const found = new Set(await postJson('/api/known', { ids: part }));
    part.filter((g) => !found.has(g)).forEach((g) => absent.add(g));
    const list = part.filter((g) => found.has(g));
    for (let j = 0; j < list.length; j += PULL_BATCH) {
      if (isStopped()) return imported;
      const got = await postJson('/api/analyses', { ids: list.slice(j, j + PULL_BATCH) });
      for (const [gid, data] of Object.entries(got)) {
        try {
          if (importPayload(gid, data)) imported += 1;
          else absent.add(gid);
        } catch (e) {
          console.warn('reprise impossible', gid, e);
          absent.add(gid);
        }
      }
    }
  }
  if (imported) await db.save();
  return imported;
}

// ---------------------------------------------------------------- envoi

function head(username) {
  const cc = db.getSetting('cc_stats');
  return { account: username.toLowerCase(), display: db.getSetting('display_name') || username, ratings: cc ? JSON.parse(cc) : null };
}

async function send(lines) {
  const text = lines.join('\n');
  let body = text, headers = { 'Content-Type': 'text/plain; charset=utf-8', 'X-ChessPrac-Key': key() };
  if (typeof CompressionStream !== 'undefined') {
    body = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    headers = { ...headers, 'X-Body': 'gzip' };
  }
  return request('/api/push', body, headers);
}

export function pending(username, busy = null) {
  return db.all(`SELECT id FROM games WHERE username=? AND analyzed=1 AND COALESCE(uploaded, 0)=0
                 AND COALESCE(pending_ex, 0)=0 ORDER BY end_time DESC`, [username.toLowerCase()])
    .map((r) => r.id).filter((id) => !busy || !busy.has(id));
}

export async function pushGames(username, ids, isStopped = () => false) {
  const h = JSON.stringify(head(username));
  let sent = 0;
  for (let i = 0; i < ids.length; i += PUSH_BATCH) {
    if (isStopped()) break;
    const part = ids.slice(i, i + PUSH_BATCH);
    const lines = [h];
    for (const gid of part) {
      const data = await gamePayload(gid);
      if (!data) continue;
      // JSON.stringify échappe les tabulations et retours à la ligne : le format ligne / tabulation reste sûr.
      lines.push(['G', gid, String(data.game.end_time || 0), JSON.stringify(data.game), JSON.stringify(data)].join('\t'));
    }
    await send(lines);
    db.transaction(() => db.runMany('UPDATE games SET uploaded=1 WHERE id=?', part.map((g) => [g])));
    sent += part.length;
  }
  return sent;
}

export async function pushStats(username) {
  const lines = [JSON.stringify(head(username))];
  for (const tc of STATS_TC) {
    for (const days of STATS_DAYS) {
      const out = statsPayload(username.toLowerCase(), tc || null, days ? parseInt(days, 10) : null);
      lines.push(['S', `${tc}|${days}`, JSON.stringify(out)].join('\t'));
    }
  }
  await send(lines);
  db.setSetting('cloud_stats_at', db.now());
  return lines.length - 1;
}

export const onlineCount = (username) =>
  db.get('SELECT COUNT(*) n FROM games WHERE username=? AND uploaded=1', [username.toLowerCase()]).n;
