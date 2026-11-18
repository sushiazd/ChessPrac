/* L'API de ChessPrac, côté navigateur : les mêmes routes que server.py, appelées directement (sans serveur).
   `handle(méthode, chemin, requête, corps)` renvoie le JSON que renverrait le serveur local. */
import * as db from './sqldb.js';
import { Board, START_FEN } from './pychess.js';
import * as book from './book.js';
import * as chesscom from './chesscom.js';
import * as conversions from './conversions.js';
import * as endgames from './endgames.js';
import * as exercises from './exercises.js';
import * as explorer from './explorer.js';
import * as repertoire from './repertoire.js';
import * as stats from './stats.js';
import * as bg from './bg.js';
import { EngineError } from './engine.js';

export const VERSION = '1.0 (navigateur)';

export class ApiError extends Error {
  constructor(msg, code = 400) { super(msg); this.code = code; }
}

const ROUTES = new Map();
const route = (method, path, fn) => ROUTES.set(`${method} ${path}`, fn);

function username() {
  const u = db.getSetting('username');
  if (!u) throw new ApiError('Aucun compte chess.com configuré.', 409);
  return u.toLowerCase();
}

// ---------------------------------------------------------------- positions

function positionInfo(board) {
  let status = null;
  if (board.isCheckmate()) status = 'checkmate';
  else if (board.isStalemate()) status = 'stalemate';
  else if (board.isInsufficientMaterial()) status = 'insufficient';
  const king = board.king(board.turn);
  return { fen: board.fen(), turn: board.turn, legal: board.legalUci(), check: board.isCheck() && king ? king : null, status };
}

route('POST', '/api/position', (q, body) => positionInfo(new Board(body.fen)));

route('POST', '/api/move', (q, body) => {
  const board = new Board(body.fen);
  if (!board.isLegal(body.uci)) throw new ApiError('Coup illégal');
  const san = board.san(body.uci);
  board.push(body.uci);
  return { ...positionInfo(board), san, uci: body.uci };
});

route('POST', '/api/analyse', async (q, body) => repertoire.engineEval(new Board(body.fen), Number(body.nodes) || repertoire.ENGINE_NODES));

// ---------------------------------------------------------------- état, réglages

route('GET', '/api/status', () => {
  const u = db.getSetting('username');
  let counts = null;
  if (u) {
    const r = db.get('SELECT COUNT(*) n, SUM(analyzed=1) a, SUM(analyzed IN (0,2)) todo FROM games WHERE username=?', [u.toLowerCase()]);
    counts = { games: r.n, analyzed: r.a || 0, todo: r.todo || 0 };
  }
  let notice = db.dbState.notice;
  if (!db.dbState.persistent && !notice) {
    notice = "Ce navigateur n'autorise pas l'enregistrement des données : rien ne sera conservé à la fermeture.";
  }
  return { version: VERSION, mode: 'browser', username: u, display_name: db.getSetting('display_name') || u,
    worker: bg.status, counts, exercises: u ? exercises.counts(u) : null, engine: true, notice };
});

const SETTING_KEYS = ['username', 'analysis_nodes', 'deep_nodes', 'new_per_day', 'workers', 'auto_sync_minutes'];

function settingsOut() {
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, db.getSetting(k)]));
  out.has_lichess_token = !!db.getSetting('lichess_token');
  out.db_path = 'Dans ce navigateur (stockage du site)';
  out.backups = [];
  out.cpu_count = navigator.hardwareConcurrency || 0;
  out.mode = 'browser';
  out.last_save = db.dbState.lastSave || null;
  out.save_error = db.dbState.saveError;
  return out;
}

route('GET', '/api/settings', () => settingsOut());

route('POST', '/api/settings', async (q, body) => {
  if ('username' in body) {
    const name = String(body.username).trim();
    const prof = name ? await chesscom.playerProfile(name) : null;
    if (!prof) throw new ApiError(`Le compte « ${name} » est introuvable sur chess.com.`);
    db.setSetting('username', (prof.username || name).toLowerCase());
    // L'API renvoie le pseudo en minuscules ; l'adresse du profil garde les majuscules (Sush1_Chess).
    const shown = (prof.url || '').replace(/\/+$/, '').split('/').pop() || prof.username || name;
    db.setSetting('display_name', shown);
    bg.kick();
  }
  for (const k of ['analysis_nodes', 'deep_nodes', 'new_per_day', 'workers', 'auto_sync_minutes']) {
    if (k in body) db.setSetting(k, parseInt(body[k], 10));
  }
  if ('lichess_token' in body) db.setSetting('lichess_token', String(body.lichess_token).trim());
  return settingsOut();
});

route('POST', '/api/sync', () => { bg.kick(); return { ok: true }; });

// ---------------------------------------------------------------- aujourd'hui

function streak() {
  const days = new Set(db.all(`SELECT day FROM activity
                               WHERE ex_done + drill_done + reviews + endgames + COALESCE(conversions, 0) > 0 ORDER BY day DESC`)
    .map((r) => r.day));
  let t = Date.now() - 4 * 3600 * 1000;
  if (!days.has(db.ymd(new Date(t)))) t -= 86400000;
  let n = 0;
  while (days.has(db.ymd(new Date(t)))) { n += 1; t -= 86400000; }
  return n;
}

function gameRow(r) {
  const d = { ...r };
  delete d.pgn;
  return d;
}

route('GET', '/api/today', () => {
  const u = username();
  const cc = db.getSetting('cc_stats');
  const act = db.get('SELECT * FROM activity WHERE day=?', [db.today()]);
  // Vraiment la dernière partie jouée (analysée ou pas encore) : l'ouvrir la fait analyser en priorité.
  const last = db.get('SELECT * FROM games WHERE username=? ORDER BY end_time DESC LIMIT 1', [u]);
  const recent = db.all('SELECT * FROM games WHERE username=? ORDER BY end_time DESC LIMIT 8', [u]);
  return {
    username: db.getSetting('display_name') || u,
    ratings: cc ? JSON.parse(cc) : null,
    exercises: exercises.counts(u),
    drill: { w: repertoire.drillCounts(u, 'w'), b: repertoire.drillCounts(u, 'b') },
    activity: act || {},
    streak: streak(),
    last_game: last ? gameRow(last) : null,
    conversions: conversions.counts(u),
    recent: recent.map(gameRow),
  };
});

// ---------------------------------------------------------------- parties

route('GET', '/api/games', (q) => {
  const u = username();
  const where = ['username=?'];
  const args = [u];
  if (q.tc) { where.push('time_class=?'); args.push(q.tc); }
  if (q.result) { where.push('result=?'); args.push(q.result); }
  if (q.color) { where.push('my_color=?'); args.push(q.color); }
  if (q.q) { where.push('(opp_name LIKE ? OR opening LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  const w = where.join(' AND ');
  const total = db.get(`SELECT COUNT(*) n FROM games WHERE ${w}`, args).n;
  const limit = parseInt(q.limit || '50', 10);
  const offset = parseInt(q.offset || '0', 10);
  const rows = db.all(`SELECT * FROM games WHERE ${w} ORDER BY end_time DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  return { total, games: rows.map(gameRow) };
});

function pvSan(fen, pv, n = 8) {
  if (!pv) return [];
  const b = new Board(fen);
  const out = [];
  for (const u of pv.split(' ').slice(0, n)) {
    if (!b.isLegal(u)) break;
    out.push(b.san(u));
    b.push(u);
  }
  return out;
}

/** Le type affiché d'un coup (pas encore analysé : null). */
function moveKind(p, forced, inBook) {
  if (forced) return 'forced';
  if (inBook) return 'book';
  if (p.special === 'brilliant' || p.special === 'great') return p.special;
  if (p.cls === null || p.cls === undefined) return null;
  if (p.missed && p.cls !== 'blunder') return 'miss';  // l'adversaire venait de se tromper et l'occasion est passée
  return p.cls;
}

route('GET', '/api/game', async (q) => {
  await book.load();
  const g = db.get('SELECT * FROM games WHERE id=?', [q.id]);
  if (!g) throw new ApiError('Partie introuvable', 404);
  const rows = db.all('SELECT * FROM moves WHERE game_id=? ORDER BY ply', [q.id]);
  const plies = rows.map((r) => ({ ...r, pv: r.pv ? r.pv.split(' ') : [], pv_san: pvSan(r.fen_before, r.pv) }));
  let final = null;
  if (rows.length) {
    const b = new Board(rows[rows.length - 1].fen_before);
    b.push(rows[rows.length - 1].uci);
    final = b.fen();
  }
  // Type de chaque coup, comme sur chess.com : forcé, théorie, brillant, grand coup, meilleur... gaffe.
  const fensAfter = [...plies.slice(1).map((p) => p.fen_before), ...(final ? [final] : [])];
  const names = book.bookPlies(fensAfter, plies.map((p) => p.drop));
  plies.forEach((p, i) => {
    const forced = new Board(p.fen_before).legalCount() === 1;
    p.book = names[i];
    p.kind = moveKind(p, forced, names[i] !== null);
  });
  const ex = db.all('SELECT id, kind, ply FROM exercises WHERE game_id=?', [q.id]);
  return { game: gameRow(g), plies, final_fen: final, exercises: ex, start_fen: START_FEN };
});

route('POST', '/api/game/reviewed', (q, body) => {
  if (db.run('UPDATE games SET reviewed=1 WHERE id=? AND reviewed=0', [body.id])) db.bumpActivity('reviews');
  return { ok: true };
});

route('POST', '/api/game/analyse', (q, body) => {
  db.run('UPDATE games SET analyzed=2 WHERE id=? AND analyzed != 1', [body.id]);
  bg.kick(body.id);
  return { ok: true };
});

// ---------------------------------------------------------------- exercices

route('GET', '/api/exercises/queue', (q) => ({
  exercises: exercises.queue(username(), q.game || null, q.kind || null), counts: exercises.counts(username()) }));

route('GET', '/api/exercises/bank', (q) => ({ exercises: exercises.bank(username(), q.kind || null) }));

route('GET', '/api/exercises/one', (q) => {
  const r = db.get('SELECT * FROM exercises WHERE id=?', [parseInt(q.id, 10)]);
  if (!r) throw new ApiError('Exercice introuvable', 404);
  return exercises.toJson(r);
});

route('POST', '/api/exercises/answer', (q, body) => {
  const secs = body.secs;
  return exercises.answer(parseInt(body.id, 10), !!body.ok, body.first === undefined ? true : !!body.first,
    secs !== undefined && secs !== null ? Number(secs) : null);
});

route('POST', '/api/exercises/suspend', (q, body) => {
  db.run('UPDATE exercises SET suspended=? WHERE id=?', [body.on === undefined ? 1 : Number(body.on), parseInt(body.id, 10)]);
  return { ok: true };
});

// ---------------------------------------------------------------- ouvertures

route('GET', '/api/rep/node', async (q) => {
  const u = username();
  const fen = q.fen || START_FEN;
  const out = await repertoire.nodeInfo(u, q.color, fen);
  out.explorer = q.explorer === '1' ? await explorer.lookup(fen) : null;
  return out;
});

route('POST', '/api/rep/set', (q, body) => { repertoire.setMove(body.color, body.fen, body.uci); return { ok: true }; });
route('POST', '/api/rep/auto', (q, body) => ({ added: repertoire.autoBuild(username(), body.color) }));
route('GET', '/api/rep/leaks', (q) => ({ leaks: repertoire.leaks(username(), q.color) }));

route('GET', '/api/rep/drill', (q) => {
  const u = username();
  return { ...repertoire.drillLine(u, q.color), counts: repertoire.drillCounts(u, q.color) };
});

route('POST', '/api/rep/result', (q, body) => { repertoire.drillResult(body.color, body.key, !!body.ok); return { ok: true }; });

// ---------------------------------------------------------------- diagnostic, finales

route('GET', '/api/stats', (q) => {
  const tc = q.tc || null;
  const days = q.days ? parseInt(q.days, 10) : null;
  const out = stats.full(username(), tc, days);
  out.fun = stats.fun(username(), tc, days);
  return out;
});

route('GET', '/api/endgames', () => ({ endgames: endgames.listing() }));
route('POST', '/api/endgames/start', (q, body) => endgames.start(body.id));
route('POST', '/api/endgames/step', (q, body) => endgames.step(body.id, body.fen, body.uci, parseInt(body.user_moves || 0, 10)));

route('GET', '/api/conversions', () => {
  const u = username();
  return { conversions: conversions.listing(u), counts: conversions.counts(u) };
});
route('POST', '/api/conversions/start', (q, body) => conversions.start(parseInt(body.id, 10)));
route('POST', '/api/conversions/step', (q, body) =>
  conversions.step(parseInt(body.id, 10), body.fen, body.uci, parseInt(body.user_moves || 0, 10)));

// ---------------------------------------------------------------- point d'entrée

/** Appelé par CP.api. Les erreurs ont un `code` (comme le statut HTTP du serveur). */
export async function handle(method, path, query = {}, body = {}) {
  const fn = ROUTES.get(`${method} ${path}`);
  if (!fn) throw new ApiError('route inconnue', 404);
  try {
    const out = await fn(query, body || {});
    return JSON.parse(JSON.stringify(out === undefined ? null : out));   // comme après un aller-retour HTTP
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof chesscom.ChessComError) { const err = new ApiError(e.message, 502); throw err; }
    if (e instanceof EngineError) throw new ApiError(e.message, 500);
    console.error(method, path, e);
    throw new ApiError(`Erreur interne : ${e.message}`, 500);
  }
}

// ---------------------------------------------------------------- données (spécifique au navigateur)

export async function init() {
  const base = new URL('./vendor/', import.meta.url);
  await db.init(new URL('sql-wasm.js', base).href, new URL('sql-wasm.wasm', base).href);
  await book.load();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* rien */ }
  bg.start();
}

export function exportData() {
  return new Blob([db.exportBytes()], { type: 'application/octet-stream' });
}

export async function importData(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await db.importBytes(bytes);
  repertoire.clearCache();
}

export async function eraseData() {
  await db.wipe();
  repertoire.clearCache();
}
