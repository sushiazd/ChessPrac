/* Statistiques Lichess par tranche d'Elo (optionnel : demande un jeton Lichess personnel, sans droits). */
import * as db from './sqldb.js';
import { Board } from './pychess.js';

const URL_EXPLORER = 'https://explorer.lichess.ovh/lichess';
const TTL = 30 * 86400;

export async function lookup(fen, ratings = '1000,1200,1400,1600', speeds = 'blitz,rapid') {
  const token = db.getSetting('lichess_token').trim();
  if (!token) return null;
  const board = new Board(fen);
  const key = `${board.epd()}|${ratings}|${speeds}`;
  const row = db.get('SELECT data, fetched_at FROM explorer_cache WHERE key=?', [key]);
  if (row && db.now() - row.fetched_at < TTL) return JSON.parse(row.data);
  const q = new URLSearchParams({ variant: 'standard', fen, ratings, speeds, moves: 8, topGames: 0, recentGames: 0 });
  let raw;
  try {
    const r = await fetch(`${URL_EXPLORER}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { error: r.status === 401 ? 'Jeton Lichess refusé (401).' : `Lichess a répondu ${r.status}.` };
    raw = await r.json();
  } catch (e) {
    return { error: 'Lichess injoignable.' };
  }
  const total = (raw.white || 0) + (raw.draws || 0) + (raw.black || 0);
  const moves = [];
  for (const m of raw.moves || []) {
    const n = m.white + m.draws + m.black;
    if (!n) continue;
    const moverWins = board.turn === 'w' ? m.white : m.black;
    moves.push({ uci: m.uci, san: m.san, n, pct: total ? Math.round(1000 * n / total) / 10 : 0,
      score: Math.round(100 * (moverWins + m.draws / 2) / n) });
  }
  const data = { total, moves };
  db.run('INSERT OR REPLACE INTO explorer_cache(key, fetched_at, data) VALUES(?,?,?)', [key, db.now(), JSON.stringify(data)]);
  return data;
}
