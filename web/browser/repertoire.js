/* Mon arbre d'ouvertures (tiré de mes parties), mon répertoire choisi et son entraînement. */
import * as db from './sqldb.js';
import { Board, fenKey, START_FEN } from './pychess.js';
import { scoreCp, shared, wpFor } from './engine.js';
import { schedule } from './exercises.js';
import { round } from './analysis.js';

export const MAX_PLY = 24;          // profondeur de l'arbre : 12 coups
export const RECENT_DAYS = 180;     // pour remplir le répertoire, ce que je joue ces derniers mois compte d'abord
export const LEAK_DROP = 8;         // un coup d'ouverture qui perd en moyenne ça (points de % de gain) est une fuite
export const ENGINE_NODES = 300000;
const cache = new Map();            // (compte, couleur) -> {n, a, builtAt, nodes}
const SCORE_OF = { win: 1.0, draw: 0.5, loss: 0.0 };

export const keyOf = (board) => board.epd();
const turnIsMine = (board, color) => board.turn === color;

/** L'arbre de mes coups d'ouverture : position -> {n, score, moves{uci: {...}}, cp, best, fen}. */
export function tree(username, color) {
  const u = username.toLowerCase();
  const sig = db.get('SELECT COUNT(*) n, SUM(analyzed=1) a FROM games WHERE username=? AND my_color=?', [u, color]);
  const ck = `${u}|${color}`;
  const hit = cache.get(ck);
  // Pendant l'analyse de fond, on ne reconstruit pas l'arbre à chaque partie : au plus toutes les 3 minutes.
  if (hit && hit.n === sig.n && (hit.a === sig.a || Date.now() / 1000 - hit.builtAt < 180)) return hit.nodes;
  const nodes = new Map();
  const rows = db.all(`SELECT m.game_id, m.ply, m.uci, m.san, m.fen_before, m."drop", m.cp_before, m.best_uci, g.result, g.end_time
                       FROM moves m JOIN games g ON g.id=m.game_id
                       WHERE g.username=? AND g.my_color=? AND m.ply<=? ORDER BY m.game_id, m.ply`, [u, color, MAX_PLY]);
  const recentSince = db.now() - RECENT_DAYS * 86400;
  rows.forEach((r, i) => {
    const k = fenKey(r.fen_before);
    let node = nodes.get(k);
    if (!node) {
      node = { n: 0, score: 0, moves: {}, cp: null, best: null, fen: r.fen_before };
      nodes.set(k, node);
    }
    node.n += 1;
    node.score += SCORE_OF[r.result];
    if (r.cp_before !== null && node.cp === null) { node.cp = r.cp_before; node.best = r.best_uci; }
    let mv = node.moves[r.uci];
    if (!mv) {
      const nxt = i + 1 < rows.length ? rows[i + 1] : null;
      let child;
      if (nxt && nxt.game_id === r.game_id && nxt.ply === r.ply + 1) {
        child = fenKey(nxt.fen_before);
      } else {
        const b = new Board(r.fen_before);
        b.push(r.uci);
        child = keyOf(b);
      }
      mv = node.moves[r.uci] = { uci: r.uci, san: r.san, n: 0, score: 0, drop_sum: 0, drop_n: 0, child, recent: 0 };
    }
    mv.n += 1;
    if ((r.end_time || 0) >= recentSince) mv.recent += 1;
    mv.score += SCORE_OF[r.result];
    if (r.drop !== null) { mv.drop_sum += r.drop; mv.drop_n += 1; }
  });
  cache.set(ck, { n: sig.n, a: sig.a, builtAt: db.now(), nodes });
  return nodes;
}

export function clearCache() { cache.clear(); }

function mvJson(mv) {
  return { uci: mv.uci, san: mv.san, n: mv.n, score: Math.round(100 * mv.score / mv.n),
    drop: mv.drop_n ? round(mv.drop_sum / mv.drop_n, 1) : null };
}

/** Évaluation d'une position (gardée en cache) : cp vus par les Blancs, meilleur coup, lignes. */
export async function engineEval(board, nodes = ENGINE_NODES) {
  const k = keyOf(board);
  const row = db.get('SELECT data FROM pos_cache WHERE key=? AND nodes>=?', [k, nodes]);
  if (row) return JSON.parse(row.data);
  if (board.isGameOver()) return { cp: 0, mate: null, lines: [] };
  const infos = await shared.analyse(board.fen(), nodes, 3);
  const lines = [];
  for (const info of infos) {
    if (!info.pv.length) continue;
    const [cp, mate] = scoreCp(info.score, board.turn, 'w');
    const b = board.copy();
    const sans = [];
    for (const u of info.pv.slice(0, 10)) {
      if (!b.isLegal(u)) break;
      sans.push(b.san(u));
      b.push(u);
    }
    lines.push({ cp, mate, uci: info.pv.slice(0, sans.length), san: sans });
  }
  const data = { cp: lines.length ? lines[0].cp : 0, mate: lines.length ? lines[0].mate : null, lines };
  db.run('INSERT OR REPLACE INTO pos_cache(key, nodes, data) VALUES(?,?,?)', [k, nodes, JSON.stringify(data)]);
  return data;
}

export async function nodeInfo(username, color, fen, withEngine = true) {
  const board = new Board(fen);
  const k = keyOf(board);
  const t = tree(username, color);
  const node = t.get(k);
  const rep = db.get('SELECT uci FROM rep_moves WHERE color=? AND key=?', [color, k]);
  const extra = db.all('SELECT uci FROM rep_opp WHERE color=? AND key=?', [color, k]).map((r) => r.uci);
  const mine = turnIsMine(board, color);
  let moves = [];
  if (node) moves = Object.values(node.moves).map(mvJson).sort((a, b) => b.n - a.n);
  for (const u of extra) {
    if (!moves.some((m) => m.uci === u) && board.isLegal(u)) {
      moves.push({ uci: u, san: board.san(u), n: 0, score: null, drop: null, added: true });
    }
  }
  const out = {
    key: k, fen, mine, n: node ? node.n : 0,
    score: node && node.n ? Math.round(100 * node.score / node.n) : null,
    moves, rep: rep ? rep.uci : null,
    rep_san: rep && board.isLegal(rep.uci) ? board.san(rep.uci) : null,
  };
  if (withEngine) {
    const ev = await engineEval(board);
    out.engine = ev;
    if (ev.lines.length) {
      const bestWp = wpFor(ev.lines[0].cp, board.turn);
      for (const m of moves) {
        for (const line of ev.lines) {
          if (line.uci[0] === m.uci) m.engine_drop = round(bestWp - wpFor(line.cp, board.turn), 1);
        }
      }
    }
  }
  return out;
}

export function setMove(color, fen, uci) {
  const board = new Board(fen);
  const k = keyOf(board);
  if (turnIsMine(board, color)) {
    if (uci) {
      db.run('INSERT OR REPLACE INTO rep_moves(color, key, uci) VALUES(?,?,?)', [color, k, uci]);
    } else {
      db.run('DELETE FROM rep_moves WHERE color=? AND key=?', [color, k]);
      db.run('DELETE FROM rep_cards WHERE color=? AND key=?', [color, k]);
    }
  } else if (uci) {
    db.run('INSERT OR IGNORE INTO rep_opp(color, key, uci) VALUES(?,?,?)', [color, k, uci]);
  }
}

/** Les coups d'ouverture que je joue souvent et qui me coûtent, du plus coûteux au moins coûteux. */
export function leaks(username, color) {
  const t = tree(username, color);
  const out = [];
  for (const [k, node] of t) {
    const board = new Board(node.fen);
    if (!turnIsMine(board, color)) continue;
    for (const mv of Object.values(node.moves)) {
      if (mv.n < 2 || !mv.drop_n) continue;
      const drop = mv.drop_sum / mv.drop_n;
      if (drop < LEAK_DROP) continue;
      let bestSan = null;
      if (node.best) { try { bestSan = board.san(node.best); } catch { bestSan = null; } }
      out.push({ fen: node.fen, key: k, uci: mv.uci, san: mv.san, n: mv.n, score: Math.round(100 * mv.score / mv.n),
        drop: round(drop, 1), best_uci: node.best, best_san: bestSan, line: lineTo(t, k), cost: round(mv.n * drop, 1) });
    }
  }
  out.sort((a, b) => b.cost - a.cost);
  return out.slice(0, 40);
}

/** La suite de coups la plus jouée qui mène à cette position (pour l'afficher). */
function lineTo(t, key) {
  const parents = new Map();
  const start = keyOf(new Board());
  const queue = [start];
  const seen = new Set([start]);
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    if (k === key) break;
    const node = t.get(k);
    if (!node) continue;
    for (const mv of Object.values(node.moves).sort((a, b) => b.n - a.n)) {
      if (!seen.has(mv.child)) {
        seen.add(mv.child);
        parents.set(mv.child, [k, mv]);
        queue.push(mv.child);
      }
    }
  }
  const path = [];
  let k = key;
  while (parents.has(k)) {
    const [pk, mv] = parents.get(k);
    path.push(mv);
    k = pk;
  }
  path.reverse();
  const b = new Board();
  const parts = [];
  for (const mv of path) {
    const prefix = b.turn === 'w' ? `${b.fullmove}.` : (parts.length ? '' : `${b.fullmove}...`);
    parts.push(prefix ? `${prefix}${mv.san}` : mv.san);
    b.push(mv.uci);
  }
  return parts.join(' ');
}

/** Construit le répertoire là où il manque : mon coup habituel s'il tient la route, sinon celui de Stockfish. */
export function autoBuild(username, color) {
  const t = tree(username, color);
  const have = new Map(db.all('SELECT key, uci FROM rep_moves WHERE color=?', [color]).map((r) => [r.key, r.uci]));
  let added = 0;
  const stack = [[new Board(), 0]];
  const seen = new Set();
  while (stack.length) {
    const [board, depth] = stack.pop();
    const k = keyOf(board);
    if (seen.has(k) || depth > MAX_PLY) continue;
    seen.add(k);
    const node = t.get(k);
    if (turnIsMine(board, color)) {
      let choice = have.get(k);
      if (choice === undefined) {
        if (!node || !Object.keys(node.moves).length || node.n < 2) continue;
        let top = null;
        for (const m of Object.values(node.moves)) {
          if (!top || m.recent > top.recent || (m.recent === top.recent && m.n > top.n)) top = m;
        }
        const drop = top.drop_n ? top.drop_sum / top.drop_n : 0;
        choice = drop < LEAK_DROP || !node.best ? top.uci : node.best;
        db.run('INSERT OR IGNORE INTO rep_moves(color, key, uci) VALUES(?,?,?)', [color, k, choice]);
        added += 1;
      }
      const b = board.copy();
      b.push(choice);
      stack.push([b, depth + 1]);
    } else {
      if (!node) continue;
      for (const mv of Object.values(node.moves)) {
        if (mv.n >= 2) {
          const b = board.copy();
          b.push(mv.uci);
          stack.push([b, depth + 1]);
        }
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------- entraînement des lignes

const repOf = (color) => new Map(db.all('SELECT key, uci FROM rep_moves WHERE color=?', [color]).map((r) => [r.key, r.uci]));
const cardsOf = (color) => new Map(db.all('SELECT * FROM rep_cards WHERE color=?', [color]).map((r) => [r.key, r]));

function oppMoves(t, color, board, k) {
  const node = t.get(k);
  const cands = new Map();
  if (node) for (const mv of Object.values(node.moves)) cands.set(mv.uci, mv.n);
  for (const r of db.all('SELECT uci FROM rep_opp WHERE color=? AND key=?', [color, k])) if (!cands.has(r.uci)) cands.set(r.uci, 1);
  return new Map([...cands].filter(([u]) => board.isLegal(u)));
}

/** Les positions de mon répertoire où c'est à moi de jouer, accessibles depuis le début. */
export function reachable(username, color) {
  const t = tree(username, color);
  const rep = repOf(color);
  const out = [];
  const seen = new Set();
  const stack = [new Board()];
  while (stack.length) {
    const board = stack.pop();
    const k = keyOf(board);
    if (seen.has(k) || board.ply() > MAX_PLY + 8) continue;
    seen.add(k);
    if (turnIsMine(board, color)) {
      const u = rep.get(k);
      if (!u) continue;
      out.push(k);
      const b = board.copy();
      b.push(u);
      stack.push(b);
    } else {
      for (const u of oppMoves(t, color, board, k).keys()) {
        const b = board.copy();
        b.push(u);
        if (rep.get(keyOf(b))) stack.push(b);
      }
    }
  }
  return out;
}

export function drillCounts(username, color) {
  const keys = reachable(username, color);
  const cards = cardsOf(color);
  const now = db.now();
  const due = keys.filter((k) => !cards.has(k) || (cards.get(k).due || 0) <= now).length;
  const learned = keys.filter((k) => cards.has(k) && cards.get(k).box >= 3).length;
  return { positions: keys.length, due, learned };
}

/** Une ligne à rejouer : l'adversaire joue ses coups habituels, en visant les positions à revoir. */
export function drillLine(username, color) {
  const t = tree(username, color);
  const rep = repOf(color);
  const cards = cardsOf(color);
  const now = db.now();
  const keys = new Set(reachable(username, color));
  const due = new Set([...keys].filter((k) => !cards.has(k) || (cards.get(k).due || 0) <= now));
  const memo = new Map();

  function dueBelow(board, depth = 0) {
    const k = keyOf(board);
    if (memo.has(k)) return memo.get(k);
    if (depth > 30) return 0;
    memo.set(k, 0);
    let total = 0;
    if (turnIsMine(board, color)) {
      const u = rep.get(k);
      if (u) {
        total += due.has(k) ? 1 : 0;
        const b = board.copy();
        b.push(u);
        total += dueBelow(b, depth + 1);
      }
    } else {
      for (const u of oppMoves(t, color, board, k).keys()) {
        const b = board.copy();
        b.push(u);
        total += dueBelow(b, depth + 1);
      }
    }
    memo.set(k, total);
    return total;
  }

  const board = new Board();
  const steps = [];
  while (board.ply() < MAX_PLY + 8) {
    const k = keyOf(board);
    let u;
    if (turnIsMine(board, color)) {
      u = rep.get(k);
      if (!u) break;
      steps.push({ fen: board.fen(), uci: u, san: board.san(u), mine: true, key: k, due: due.has(k) });
    } else {
      const cands = oppMoves(t, color, board, k);
      const weighted = [];
      for (const [cu, n] of cands) {
        const b = board.copy();
        b.push(cu);
        if (!rep.get(keyOf(b))) continue;
        const d = dueBelow(b);
        weighted.push([cu, d ? n * (1 + 4 * d) : n * 0.25]);
      }
      if (!weighted.length) break;
      const total = weighted.reduce((s, [, w]) => s + w, 0);
      let pick = Math.random() * total;
      u = weighted[weighted.length - 1][0];
      for (const [cand, w] of weighted) {
        pick -= w;
        if (pick <= 0) { u = cand; break; }
      }
      steps.push({ fen: board.fen(), uci: u, san: board.san(u), mine: false, key: k });
    }
    board.push(u);
  }
  return { color, steps };
}

export function drillResult(color, key, ok) {
  const card = db.get('SELECT * FROM rep_cards WHERE color=? AND key=?', [color, key]);
  const now = db.now();
  let box = card ? card.box : 0;
  const isDue = !card || (card.due || 0) <= now;
  if (ok && !isDue) return;  // déjà su et pas encore à revoir : on ne l'avance pas plus vite
  let due;
  [box, due] = schedule(box, ok, now);
  db.run(`INSERT INTO rep_cards(color, key, box, due, reps, lapses) VALUES(?,?,?,?,1,?)
          ON CONFLICT(color, key) DO UPDATE SET box=excluded.box, due=excluded.due, reps=reps+1,
          lapses=lapses+excluded.lapses`, [color, key, box, due, ok ? 0 : 1]);
  db.bumpActivity('drill_done');
  if (ok) db.bumpActivity('drill_ok');
}

export { START_FEN };
