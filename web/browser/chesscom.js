/* Récupération des parties publiques via l'API de chess.com (aucun mot de passe, lecture seule).
   L'API publique accepte les requêtes directes depuis un navigateur (CORS ouvert). */
import * as db from './sqldb.js';
import { Board } from './pychess.js';

const API = 'https://api.chess.com/pub/player';
const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

export class ChessComError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Rend la main au navigateur (l'interface reste fluide pendant les gros traitements). Un MessageChannel plutôt
    qu'un setTimeout : les minuteries sont ralenties dans un onglet en arrière-plan, pas les messages. */
export const tick = () => new Promise((resolve) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); resolve(); };
  c.port2.postMessage(0);
});

export async function fetchJson(url, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      if (attempt < tries - 1) { await sleep(2000); continue; }
      throw new ChessComError(`chess.com injoignable (${(e && e.message) || e})`);
    }
    if (r.status === 404) return null;
    if (r.status === 429 && attempt < tries - 1) { await sleep(2000 + 3000 * attempt); continue; }
    if (!r.ok) throw new ChessComError(`chess.com a répondu ${r.status} pour ${url}`);
    try { return await r.json(); } catch (e) { throw new ChessComError('Réponse illisible de chess.com.'); }
  }
  return null;
}

export const playerProfile = (u) => fetchJson(`${API}/${u.toLowerCase()}`);
export const playerStats = (u) => fetchJson(`${API}/${u.toLowerCase()}/stats`);

/** '180+2' -> [180, 2] ; parties « daily » ('1/86400') -> [null, 0]. */
export function parseTimeControl(tc) {
  if (!tc || tc.includes('/')) return [null, 0];
  const [base, inc] = tc.split('+');
  const b = parseFloat(base);
  const i = parseFloat(inc || '0');
  if (Number.isNaN(b) || Number.isNaN(i)) return [null, 0];
  return [b, i];
}

export function outcome(code) {
  if (code === 'win') return 'win';
  if (DRAW_CODES.has(code)) return 'draw';
  return 'loss';
}

export function openingName(ecoUrl) {
  if (!ecoUrl) return '';
  const slug = ecoUrl.replace(/\/+$/, '').split('/').pop();
  const name = slug.replace(/-/g, ' ');
  // « Queens Pawn Opening Accelerated London System 2...c5 3.e3 » : on garde le nom, pas les coups.
  const words = [];
  for (const w of name.split(' ')) {
    if (/^\d/.test(w)) break;
    words.push(w);
  }
  const out = words.join(' ') || name;
  return out.replace('Queens', "Queen's").replace('Kings', "King's").replace('Petrovs', "Petrov's");
}

/** Lit un PGN de chess.com : les en-têtes et les coups avec leur pendule. */
export function parsePgn(pgn) {
  const headers = {};
  const body = [];
  for (const line of pgn.split(/\r?\n/)) {
    const m = /^\[(\w+)\s+"(.*)"\]\s*$/.exec(line);
    if (m && !body.length) headers[m[1]] = m[2]; else body.push(line);
  }
  const text = body.join('\n');
  const re = /\{[^}]*\}|;[^\n]*|\([^)]*\)|\$\d+|\d+\.(?:\.\.)?|1-0|0-1|1\/2-1\/2|\*|[^\s{}()]+/g;
  const moves = [];
  for (const tok of text.match(re) || []) {
    if (tok[0] === '{') {
      const c = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(tok);
      if (c && moves.length) moves[moves.length - 1].clock = +c[1] * 3600 + +c[2] * 60 + parseFloat(c[3]);
    } else if (/^(;|\(|\$|\d+\.|1-0|0-1|1\/2-1\/2|\*)/.test(tok)) {
      continue;
    } else {
      moves.push({ san: tok.replace(/[!?]+$/, ''), clock: null });
    }
  }
  return { headers, moves };
}

export function movesFromPgn(pgn, timeControl, myColor) {
  const { moves } = parsePgn(pgn);
  const [base, inc] = parseTimeControl(timeControl);
  const board = new Board();
  const last = { w: base, b: base };
  const rows = [];
  let ply = 0;
  for (const m of moves) {
    const color = board.turn;
    const fen = board.fen();
    let uci;
    let san;
    try { ({ uci, san } = board.pushSan(m.san)); } catch { break; }   // coup illisible : on garde ce qui précède
    ply += 1;
    const clock = m.clock;
    let think = null;
    if (clock !== null && last[color] !== null) {
      think = Math.max(0, last[color] + inc - clock);
      if (ply <= 2) think = Math.max(0, last[color] - clock); // le premier coup ne profite pas de l'incrément
    }
    if (clock !== null) last[color] = clock;
    rows.push({ ply, san, uci, fen_before: fen, color, mine: Number((color === 'w') === (myColor === 'w')), clock, think });
  }
  return rows;
}

/** Ajoute une partie (et ses coups). Renvoie true si elle est nouvelle. */
export function storeGame(username, g) {
  if ((g.rules || 'chess') !== 'chess' || !g.pgn) return false;
  const gid = g.uuid || g.url;
  if (db.get('SELECT 1 AS x FROM games WHERE id=?', [gid])) return false;
  const me = username.toLowerCase();
  const white = g.white;
  const black = g.black;
  const myColor = white.username.toLowerCase() === me ? 'w' : 'b';
  const [mine, opp] = myColor === 'w' ? [white, black] : [black, white];
  const ecoUrl = parsePgn(g.pgn).headers.ECOUrl || null;
  const rows = movesFromPgn(g.pgn, g.time_control || '', myColor);
  if (!rows.length) return false;
  const acc = g.accuracies || {};
  db.transaction(() => {
    // Le texte du PGN n'est pas gardé : les coups, déjà décodés, suffisent (et la base reste plus légère).
    db.run(`INSERT INTO games(id, username, url, end_time, time_class, time_control, rated, my_color, my_rating,
            opp_name, opp_rating, result, my_code, opp_code, opening, eco_url, pgn, n_plies, cc_acc_me, cc_acc_opp)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [gid, me, g.url, g.end_time, g.time_class, g.time_control, Number(!!g.rated), myColor, mine.rating,
      opp.username, opp.rating, outcome(mine.result || ''), mine.result, opp.result, openingName(ecoUrl), ecoUrl, null,
      rows.length, myColor === 'w' ? acc.white : acc.black, myColor === 'w' ? acc.black : acc.white]);
    db.runMany('INSERT INTO moves(game_id, ply, san, uci, fen_before, color, mine, clock, think) VALUES(?,?,?,?,?,?,?,?,?)',
      rows.map((r) => [gid, r.ply, r.san, r.uci, r.fen_before, r.color, r.mine, r.clock, r.think]));
  });
  return true;
}

const pad = (n) => String(n).padStart(2, '0');

/** Télécharge les mois pas encore complets. Renvoie le nombre de nouvelles parties. */
export async function sync(username, progress = () => {}) {
  username = username.trim().toLowerCase();
  const data = await fetchJson(`${API}/${username}/games/archives`);
  if (data === null) throw new ChessComError(`Le compte « ${username} » est introuvable sur chess.com.`);
  const archives = data.archives || [];
  const doneRows = new Set(db.all('SELECT url FROM archives WHERE username=? AND complete=1', [username]).map((r) => r.url));
  const todo = archives.filter((u) => !doneRows.has(u));
  const d = new Date();
  const currentUtc = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}`;
  const currentLocal = `${d.getFullYear()}/${pad(d.getMonth() + 1)}`;
  let added = 0;
  // Les mois récents d'abord : l'analyse peut commencer sur les dernières parties sans attendre tout l'historique.
  const ordered = [...todo].reverse();
  for (let i = 0; i < ordered.length; i++) {
    const url = ordered[i];
    progress(i, ordered.length, `Téléchargement des parties (${url.slice(-7)})`);
    const month = (await fetchJson(url)) || {};
    let n = 0;
    for (const g of month.games || []) {
      if (storeGame(username, g)) added += 1;
      if (++n % 6 === 0) await tick();
    }
    // Un mois passé ne bouge plus : on ne le retélécharge pas. Le mois en cours, si.
    const complete = Number(!url.endsWith(currentUtc) && !url.endsWith(currentLocal));
    db.run(`INSERT INTO archives(url, username, fetched_at, complete) VALUES(?,?,?,?)
            ON CONFLICT(url) DO UPDATE SET fetched_at=excluded.fetched_at, complete=excluded.complete`,
    [url, username, db.now(), complete]);
  }
  progress(ordered.length, ordered.length, 'Parties à jour');
  return added;
}
