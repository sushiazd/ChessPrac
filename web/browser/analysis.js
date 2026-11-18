/* Analyse Stockfish d'une partie : évaluation de chaque position et classement de chaque coup. */
import * as db from './sqldb.js';
import { Board, PIECE_VALUES } from './pychess.js';
import { moveAccuracy, scoreCp, terminalEval, wpFor, memoGet, memoSet } from './engine.js';

// Seuils de Lichess, en points de pourcentage de gain perdus par le coup.
export const INACCURACY = 10;
export const MISTAKE = 20;
export const BLUNDER = 30;

export const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };

export function classify(drop, isBest) {
  if (isBest) return 'best';
  if (drop < 2) return 'excellent';
  if (drop < INACCURACY) return 'good';
  if (drop < MISTAKE) return 'inaccuracy';
  if (drop < BLUNDER) return 'mistake';
  return 'blunder';
}

export function nonPawnMaterial(board) {
  return board.pieceMap().reduce((s, p) => s + (p.type === 'p' ? 0 : PIECE_VALUES[p.type]), 0);
}

export function materialBalance(board, color) {
  return board.pieceMap().reduce((s, p) => s + PIECE_VALUES[p.type] * (p.color === color ? 1 : -1), 0);
}

export function phaseOf(board, ply) {
  if (nonPawnMaterial(board) <= 20) return 'finale';
  if (ply <= 20) return 'ouverture';
  return 'milieu';
}

export async function evaluatePositions(engine, fens, nodes) {
  const out = [];
  for (const fen of fens) {
    const board = new Board(fen);
    const term = terminalEval(board);
    if (term) { out.push({ cp: term[0], mate: term[1], best: null, pv: [] }); continue; }
    let ev = memoGet(fen, nodes);
    if (!ev) {
      const lines = await engine.analyse(fen, nodes, 1);
      const info = lines[0];
      const [cp, mate] = scoreCp(info.score, board.turn, 'w');
      ev = { cp, mate, best: info.pv[0] || null, pv: info.pv.slice(0, 8) };
      memoSet(fen, nodes, ev);
    }
    out.push(ev);
  }
  return out;
}

// Comme Lichess : moitié moyenne, moitié moyenne harmonique (une grosse gaffe pèse plus qu'une simple moyenne).
export function mean(xs) {
  if (!xs.length) return null;
  const arith = xs.reduce((a, b) => a + b, 0) / xs.length;
  const harm = xs.length / xs.reduce((a, x) => a + 1 / Math.max(x, 1), 0);
  return round((arith + harm) / 2, 1);
}

export async function analyseGame(engine, gameId, nodes) {
  const rows = db.all('SELECT ply, uci, fen_before, color FROM moves WHERE game_id=? ORDER BY ply', [gameId]);
  if (!rows.length) { db.run('UPDATE games SET analyzed=-1 WHERE id=?', [gameId]); return; }
  const last = new Board(rows[rows.length - 1].fen_before);
  last.push(rows[rows.length - 1].uci);
  const fens = [...rows.map((r) => r.fen_before), last.fen()];
  const evals = await evaluatePositions(engine, fens, nodes);

  const updates = [];
  const acc = { w: [], b: [] };
  const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };
  const myColor = db.get('SELECT my_color FROM games WHERE id=?', [gameId]).my_color;
  let prevDrop = 0;
  rows.forEach((r, i) => {
    const board = new Board(r.fen_before);
    const color = board.turn;
    const before = evals[i];
    const after = evals[i + 1];
    const wpb = wpFor(before.cp, color);
    const wpa = wpFor(after.cp, color);
    const drop = Math.max(0, wpb - wpa);
    const isBest = before.best !== null && before.best === r.uci;
    const cls = classify(drop, isBest);
    const missed = Number(prevDrop >= MISTAKE && drop >= 15);
    const a = moveAccuracy(drop);
    acc[r.color].push(a);
    if (r.color === myColor && cls in counts) counts[cls] += 1;
    let bestSan = null;
    if (before.best) { try { bestSan = board.san(before.best); } catch { bestSan = null; } }
    updates.push([before.cp, before.mate, after.cp, after.mate, before.best, bestSan, before.pv.join(' '),
      round(wpb, 2), round(wpa, 2), round(drop, 2), round(a, 1), cls, missed, phaseOf(board, r.ply), gameId, r.ply]);
    prevDrop = drop;
  });

  const oppColor = myColor === 'w' ? 'b' : 'w';
  db.transaction(() => {
    db.runMany(`UPDATE moves SET cp_before=?, mate_before=?, cp_after=?, mate_after=?, best_uci=?, best_san=?, pv=?,
                wp_before=?, wp_after=?, "drop"=?, accuracy=?, cls=?, missed=?, phase=? WHERE game_id=? AND ply=?`, updates);
    db.run(`UPDATE games SET analyzed=1, analyzed_at=?, acc_me=?, acc_opp=?, n_inacc=?, n_mistakes=?, n_blunders=?, uploaded=0 WHERE id=?`,
      [db.now(), mean(acc[myColor]), mean(acc[oppColor]), counts.inaccuracy, counts.mistake, counts.blunder, gameId]);
  });
}
