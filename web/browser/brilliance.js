/* Coups brillants (!!) et grands coups (!), à la manière de chess.com, calculés à partir de l'analyse déjà faite.

- Brillant (!!) : un des meilleurs coups, qui sacrifie du matériel (pièce laissée en prise ou perte nette dans la
  meilleure suite), sans que la position soit déjà totalement gagnée, et qui tient la route ensuite.
- Grand coup (!) : l'adversaire vient de gaffer et tu trouves LE coup qui le punit (le meilleur, avec un vrai gain
  derrière), et ce n'est pas la simple prise de la pièce qui vient de bouger.

Pas besoin de relancer Stockfish : on se sert des évaluations et des meilleures suites gardées en base. */
import * as db from './sqldb.js';
import { Board, PIECE_VALUES, opposite, uciTo } from './pychess.js';
import { materialBalance } from './analysis.js';

const GOOD = ['best', 'excellent'];
const GREAT_PREV_DROP = 30;   // l'adversaire vient de faire une gaffe

/** La pièce sur `sq` est-elle laissée en prise (attaquée par moins cher, ou attaquée et pas défendue) ? */
function enPrise(board, sq, color) {
  const piece = board.pieceAt(sq);
  if (!piece) return false;
  const attackers = board.attackers(opposite(color), sq);
  if (!attackers.length) return false;
  const cheapest = Math.min(...attackers.map((s) => PIECE_VALUES[board.pieceAt(s).type] || 100));
  if (cheapest < PIECE_VALUES[piece.type]) return true;
  return !board.attackers(color, sq).length;
}

export function isSacrifice(before, uci, pvAfter) {
  const me = before.turn;
  const m = before.find(uci);
  const piece = before.pieceAt(m.from);
  if (!piece || piece.type === 'p' || piece.type === 'k' || m.promotion) return false;
  const captured = before.pieceAt(m.to);
  let gained = captured ? PIECE_VALUES[captured.type] : 0;
  if (before.isEnPassant(uci)) gained = 1;
  const after = before.copy();
  after.push(uci);
  if (after.isCheckmate()) return false;
  // 1) La pièce jouée reste en prise et vaut plus que ce qu'elle vient de prendre.
  if (PIECE_VALUES[piece.type] - gained >= 2 && enPrise(after, m.to, me)) return true;
  // 2) Dans la meilleure suite, l'adversaire prend la pièce jouée et je reste en retard de matériel après ma réponse.
  if (!pvAfter.length || uciTo(pvAfter[0]) !== m.to) return false;
  const start = materialBalance(before, me);
  const b = after.copy();
  const bals = [];
  for (const u of pvAfter.slice(0, 4)) {
    if (!b.isLegal(u)) break;
    b.push(u);
    bals.push(materialBalance(b, me));
  }
  if (bals.length >= 2) {
    const mine = bals.filter((_, i) => i % 2 === 1);   // après chacun de mes coups suivants
    return mine.every((x) => start - x >= 2);
  }
  return false;
}

export function scanGame(gameId) {
  const rows = db.all(`SELECT ply, uci, fen_before, mine, cls, wp_before, wp_after, "drop", pv
                       FROM moves WHERE game_id=? ORDER BY ply`, [gameId]);
  const updates = [];
  const found = { brilliant: 0, great: 0 };
  rows.forEach((r, i) => {
    let special = null;
    if (GOOD.includes(r.cls) && r.wp_before !== null) {
      const nxt = i + 1 < rows.length ? rows[i + 1] : null;
      const pvAfter = nxt && nxt.pv ? nxt.pv.split(' ') : [];
      const before = new Board(r.fen_before);
      if (r.wp_before <= 90 && r.wp_after >= 45 && isSacrifice(before, r.uci, pvAfter)) {
        special = 'brilliant';
      } else if (i > 0 && r.cls === 'best' && (rows[i - 1].drop || 0) >= GREAT_PREV_DROP && r.wp_after >= 70
        && uciTo(r.uci) !== uciTo(rows[i - 1].uci)) {
        // Pas la simple prise de la pièce qui vient de bouger : il fallait voir plus loin.
        special = 'great';
      }
    }
    if (special) found[special] += 1;
    updates.push([special, gameId, r.ply]);
  });
  db.transaction(() => {
    db.runMany('UPDATE moves SET special=? WHERE game_id=? AND ply=?', updates);
    db.run('UPDATE games SET specials_done=1, uploaded=0 WHERE id=?', [gameId]);
  });
  return found;
}

/** Calcule les coups spéciaux des parties analysées qui ne l'ont pas encore été (une fois pour toutes). */
export function scanPending(username) {
  const ids = db.all('SELECT id FROM games WHERE username=? AND analyzed=1 AND COALESCE(specials_done, 0)=0',
    [username.toLowerCase()]).map((r) => r.id);
  for (const id of ids) scanGame(id);
  return ids.length;
}
