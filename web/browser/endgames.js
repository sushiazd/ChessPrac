/* Finales de base à jouer contre Stockfish, avec un objectif clair (mater, promouvoir, tenir la nulle). */
import * as db from './sqldb.js';
import { Board } from './pychess.js';
import { scoreCp, shared } from './engine.js';

const ENGINE_NODES = 200000;

export const ENDGAMES = [
  { id: 'kqk', title: 'Mat roi + dame', goal: 'mate', limit: 15, color: 'w', fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
    tip: 'Avec la dame, fais un « saut de cavalier » par rapport au roi adverse pour le repousser vers un bord, '
      + 'puis amène ton roi. Attention au pat : laisse-lui toujours une case tant que ton roi n\'est pas là.' },
  { id: 'krrk', title: "L'escalier aux deux tours", goal: 'mate', limit: 12, color: 'w', fen: '8/8/8/4k3/8/8/8/R3K2R w - - 0 1',
    tip: 'Une tour coupe une rangée, l\'autre donne échec sur la suivante, et on recommence. Si le roi s\'approche '
      + 'd\'une tour, envoie-la à l\'autre bout de la rangée.' },
  { id: 'krk', title: 'Mat roi + tour', goal: 'mate', limit: 30, color: 'w', fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1',
    tip: 'La tour coupe le roi adverse dans une boîte, que tu rétrécis. Ton roi vient en opposition, puis la tour '
      + 'donne échec. Coup d\'attente de la tour quand il le faut.' },
  { id: 'kpk6', title: 'Roi devant le pion (6e rangée)', goal: 'promote', limit: 20, color: 'w', fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
    tip: 'Roi sur la 6e rangée devant son pion : c\'est toujours gagnant. Garde l\'opposition et ne pousse le pion '
      + 'que lorsque ton roi contrôle la case devant lui.' },
  { id: 'opp-win', title: "L'opposition, en attaque", goal: 'promote', limit: 25, color: 'w', fen: '8/8/8/4k3/8/4K3/4P3/8 b - - 0 1',
    tip: 'Les Noirs doivent jouer et céder le passage. Avance ton roi avant le pion : le pion suit, le roi ouvre.' },
  { id: 'opp-draw', title: "L'opposition, en défense", goal: 'draw', limit: 20, color: 'b', fen: '8/8/8/4k3/8/4K3/4P3/8 w - - 0 1',
    tip: 'Reste face au roi blanc (opposition). Quand le pion arrive, recule tout droit devant lui, jamais sur le côté.' },
  { id: 'kpk-def', title: 'Roi + pion : tenir la nulle', goal: 'draw', limit: 20, color: 'b', fen: '8/8/8/8/4k3/8/4P3/4K3 b - - 0 1',
    tip: 'Bloque le pion avec ton roi. Quand tu dois reculer, reste sur la colonne du pion pour reprendre l\'opposition à la fin.' },
  { id: 'lucena', title: 'Position de Lucena (le pont)', goal: 'promote', limit: 30, color: 'w', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
    tip: 'D\'abord coupe le roi adverse avec ta tour, puis monte-la en 4e rangée (Td4), sors ton roi et construis '
      + 'le pont pour bloquer les échecs de côté.' },
  { id: 'philidor', title: 'Position de Philidor (défense)', goal: 'draw', limit: 25, color: 'b', fen: '3k4/R7/7r/3PK3/8/8/8/8 b - - 0 1',
    tip: 'Garde ta tour sur la 6e rangée pour empêcher le roi blanc d\'avancer. Dès que le pion avance en 6e, '
      + 'passe derrière et donne des échecs par l\'arrière.' },
  { id: 'kqkp', title: 'Dame contre pion en 7e', goal: 'win_material', limit: 25, color: 'w', fen: '8/1K6/8/8/8/8/3pk3/7Q w - - 0 1',
    tip: 'Échecs et clouages pour forcer le roi noir devant son pion : chaque fois qu\'il bloque la case de '
      + 'promotion, ton roi gagne un pas. Puis prends le pion.' },
];
const BY_ID = Object.fromEntries(ENDGAMES.map((e) => [e.id, e]));

export function listing() {
  return ENDGAMES.map((e) => {
    const r = db.get('SELECT COUNT(*) n, SUM(ok) ok, MAX(ts) last FROM endgame_results WHERE id=?', [e.id]);
    return { ...e, tries: r.n, wins: r.ok || 0, last: r.last };
  });
}

async function userEval(board, color) {
  const info = (await shared.analyse(board.fen(), ENGINE_NODES / 2, 1))[0];
  return scoreCp(info.score, board.turn, color)[0];
}

/** ['continue' | 'success' | 'fail', message] */
async function check(e, board, color, userMoves) {
  const goal = e.goal;
  if (board.isCheckmate()) {
    if (board.turn !== color) return ['success', ['mate', 'promote', 'win_material'].includes(goal) ? 'Échec et mat !' : 'Mat !'];
    return ['fail', "Tu t'es fait mater."];
  }
  if (board.isStalemate()) return goal === 'draw' ? ['success', 'Pat : nulle tenue !'] : ['fail', 'Pat ! La partie est nulle.'];
  if (board.isInsufficientMaterial() || board.canClaimDraw()) {
    return goal === 'draw' ? ['success', 'Nulle tenue !'] : ['fail', 'La partie est nulle.'];
  }
  const ev = await userEval(board, color);
  if (goal === 'draw') {
    if (ev <= -400) return ['fail', "La position est perdue : l'adversaire va gagner."];
    if (userMoves >= e.limit) return ['success', `Tu as tenu ${e.limit} coups : nulle !`];
    return ['continue', ''];
  }
  if (ev < 300) return ['fail', "Le gain s'est échappé : la position n'est plus gagnante."];
  if (goal === 'promote' && board.pieceMap().some((p) => p.type === 'q' && p.color === color) && ev >= 600) {
    return ['success', 'Pion promu, la partie est gagnée !'];
  }
  if (goal === 'win_material') {
    const opp = board.pieceMap().filter((p) => p.color !== color && p.type !== 'k');
    if (!opp.length) return ['success', 'Il ne reste que le roi adverse : gagné !'];
  }
  if (userMoves >= e.limit) return ['fail', `Objectif non atteint en ${e.limit} coups.`];
  return ['continue', ''];
}

export async function start(eid) {
  const e = BY_ID[eid];
  const board = new Board(e.fen);
  let reply = null;
  if (board.turn !== e.color) {
    const mv = await shared.play(board.fen(), ENGINE_NODES);
    reply = { uci: mv, san: board.san(mv) };
    board.push(mv);
  }
  return { fen: board.fen(), reply };
}

export async function step(eid, fen, uci, userMoves) {
  const e = BY_ID[eid];
  const color = e.color;
  const board = new Board(fen);
  if (!board.isLegal(uci)) return { error: 'coup illégal' };
  const san = board.san(uci);
  board.push(uci);
  userMoves += 1;
  let [status, msg] = await check(e, board, color, userMoves);
  let reply = null;
  if (status === 'continue') {
    const rmv = await shared.play(board.fen(), ENGINE_NODES);
    reply = { uci: rmv, san: board.san(rmv) };
    board.push(rmv);
    [status, msg] = await check(e, board, color, userMoves);
  }
  if (status !== 'continue') {
    db.run('INSERT INTO endgame_results(id, ts, ok) VALUES(?,?,?)', [eid, db.now(), Number(status === 'success')]);
    db.bumpActivity('endgames');
  }
  return { fen: board.fen(), san, reply, status, message: msg, user_moves: userMoves };
}
