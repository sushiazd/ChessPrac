/* « Gagner les parties gagnées » : les positions où j'avais l'avantage décisif mais où je n'ai pas gagné.
   On les rejoue contre Stockfish à pleine force jusqu'à transformer l'avantage en gain net. */
import * as db from './sqldb.js';
import { Board } from './pychess.js';
import { scoreCp, shared } from './engine.js';
import { DAY } from './exercises.js';

const WINNING_WP = 85;       // chances de gain à partir desquelles je « gagnais »
const ENGINE_NODES = 150000;
const LIMIT = 25;            // coups pour finir le travail
const WON_CP = 900;          // avantage net : on considère la partie gagnée
const LOST_CP = 150;         // en dessous, l'avantage est perdu

/** Ajoute les nouvelles positions : la première où j'étais gagnant, dans chaque partie que je n'ai pas gagnée. */
export function refresh(username) {
  const rows = db.all(`SELECT m.game_id, MIN(m.ply) AS ply FROM moves m JOIN games g ON g.id = m.game_id
                       WHERE g.username=? AND g.analyzed=1 AND g.result != 'win' AND g.time_class != 'daily'
                         AND m.mine=1 AND m.wp_before >= ? AND (m.mate_before IS NULL OR ABS(m.mate_before) > 3)
                         AND g.id NOT IN (SELECT game_id FROM conversions)
                       GROUP BY m.game_id`, [username.toLowerCase(), WINNING_WP]);
  if (!rows.length) return;
  db.transaction(() => {
    for (const r of rows) {
      const m = db.get('SELECT fen_before, wp_before FROM moves WHERE game_id=? AND ply=?', [r.game_id, r.ply]);
      const now = db.now();
      db.run('INSERT OR IGNORE INTO conversions(game_id, ply, fen, wp, created_at, due) VALUES(?,?,?,?,?,?)',
        [r.game_id, r.ply, m.fen_before, m.wp_before, now, now]);
    }
  });
}

export function counts(username) {
  refresh(username);
  const r = db.get(`SELECT COUNT(*) total, SUM(c.due <= ?) due, SUM(c.wins > 0) won FROM conversions c
                    JOIN games g ON g.id = c.game_id WHERE g.username=?`, [db.now(), username.toLowerCase()]);
  return { total: r.total || 0, due: r.due || 0, won: r.won || 0 };
}

export function listing(username) {
  refresh(username);
  return db.all(`SELECT c.*, g.opp_name, g.opp_rating, g.end_time, g.time_class, g.time_control, g.result, g.my_code,
                        g.my_color FROM conversions c JOIN games g ON g.id = c.game_id WHERE g.username=?
                 ORDER BY (c.due > ?), g.end_time DESC`, [username.toLowerCase(), db.now()]);
}

async function evalFor(board, color) {
  const info = (await shared.analyse(board.fen(), ENGINE_NODES / 2, 1))[0];
  return scoreCp(info.score, board.turn, color)[0];
}

async function check(board, color, userMoves) {
  if (board.isCheckmate()) {
    return board.turn !== color ? ['success', 'Échec et mat, partie gagnée !'] : ['fail', "Tu t'es fait mater."];
  }
  if (board.isStalemate()) return ['fail', 'Pat ! La partie gagnée finit en nulle.'];
  if (board.isInsufficientMaterial() || board.canClaimDraw()) return ['fail', "Nulle : l'avantage s'est envolé."];
  const ev = await evalFor(board, color);
  if (ev >= WON_CP) return ['success', 'Avantage décisif atteint : cette fois, la partie est gagnée.'];
  if (ev < LOST_CP) return ['fail', "L'avantage s'est envolé : regarde ce que Stockfish menaçait."];
  if (userMoves >= LIMIT) return ['fail', `Toujours pas gagné après ${LIMIT} coups : il faut simplifier et avancer plus vite.`];
  return ['continue', ''];
}

const getConv = (cid) => db.get('SELECT c.*, g.my_color FROM conversions c JOIN games g ON g.id=c.game_id WHERE c.id=?', [cid]);

export function start(cid) {
  const c = getConv(cid);
  return { fen: c.fen, color: c.my_color, limit: LIMIT };
}

export async function step(cid, fen, uci, userMoves) {
  const c = getConv(cid);
  const color = c.my_color;
  const board = new Board(fen);
  if (!board.isLegal(uci)) return { error: 'coup illégal' };
  const san = board.san(uci);
  board.push(uci);
  userMoves += 1;
  let [status, msg] = await check(board, color, userMoves);
  let reply = null;
  if (status === 'continue') {
    const rmv = await shared.play(board.fen(), ENGINE_NODES);
    reply = { uci: rmv, san: board.san(rmv) };
    board.push(rmv);
    [status, msg] = await check(board, color, userMoves);
  }
  if (status !== 'continue') {
    const ok = status === 'success';
    const now = db.now();
    // Réussie : on la revoit dans 3 semaines pour s'assurer que c'est acquis. Ratée : dès demain.
    const due = now + (ok ? 21 : 1) * DAY;
    db.run('UPDATE conversions SET tries=tries+1, wins=wins+?, last_ok=?, due=? WHERE id=?', [Number(ok), Number(ok), due, cid]);
    db.bumpActivity('conversions');
  }
  return { fen: board.fen(), san, reply, status, message: msg, user_moves: userMoves, limit: LIMIT };
}
