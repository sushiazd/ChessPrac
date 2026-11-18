/* Transforme les erreurs de mes parties en exercices, et les fait revenir avec la répétition espacée. */
import * as db from './sqldb.js';
import { Board, uciTo } from './pychess.js';
import { MISTAKE, materialBalance, round } from './analysis.js';
import { scoreCp, winPct } from './engine.js';

const ACCEPT_MARGIN = 4;    // un autre coup est accepté s'il garde presque autant de chances de gain que le meilleur
const MIN_GAIN = 15;        // l'erreur doit coûter au moins ça, vérifiée en profondeur
const THREAT_GAIN = 25;     // « menace » : si on passait son tour, l'adversaire gagnerait au moins ça
const UNIQUE_GAP = 20;      // pour prolonger la solution, le coup suivant doit être nettement le seul
export const DAY = 86400;
export const INTERVALS = [0, 1, 3, 7, 16, 35, 80];  // jours, selon la boîte (0 = nouveau)

// ---------------------------------------------------------------- génération

async function lines(engine, board, nodes, multipv) {
  const infos = await engine.analyse(board.fen(), nodes, multipv);
  const out = [];
  for (const info of infos) {
    if (!info.pv.length) continue;
    const [cp, mate] = scoreCp(info.score, board.turn, board.turn);
    out.push({ move: info.pv[0], pv: info.pv, wp: winPct(cp), cp, mate });
  }
  return out;
}

/** Chances de gain du joueur qui joue `move`, après ce coup. */
async function wpAfter(engine, board, move, nodes) {
  const b = board.copy();
  b.push(move);
  if (b.isCheckmate()) return [100, null];
  if (b.isGameOver()) return [50, null];
  const ls = await lines(engine, b, nodes, 1);
  if (!ls.length) return [50, null];
  return [100 - ls[0].wp, ls[0]];
}

/** La solution continue tant que chaque coup suivant est clairement le seul bon (vrai calcul tactique). */
async function extendSolution(engine, board, first, nodes) {
  const line = [first];
  const b = board.copy();
  b.push(first);
  for (let i = 0; i < 2; i++) {
    if (b.isGameOver()) break;
    const reply = await lines(engine, b, nodes, 1);
    if (!reply.length) break;
    b.push(reply[0].move);
    if (b.isGameOver()) break;
    const mine = await lines(engine, b, nodes, 2);
    if (!mine.length) break;
    const unique = mine.length === 1 || mine[0].wp - mine[1].wp >= UNIQUE_GAP;
    if (!unique) break;
    line.push(reply[0].move, mine[0].move);
    b.push(mine[0].move);
  }
  return line;
}

/** Pourquoi l'erreur : mat, pièce perdue, occasion manquée, ou autre. */
function tagOf(board, played, best, oppLine, missed) {
  if (missed) return 'occasion';
  if (best.mate !== null && best.mate > 0) return 'mat-rate';
  if (oppLine && oppLine.mate !== null && oppLine.mate > 0) return 'mat';
  if (oppLine) {
    const me = board.turn;
    const b = board.copy();
    b.push(played);
    const start = materialBalance(board, me);
    for (const m of oppLine.pv.slice(0, 3)) {
      if (!b.isLegal(m)) break;
      b.push(m);
    }
    if (start - materialBalance(b, me) >= 2) return 'piece';
  }
  return 'autre';
}

/** Si je passais mon tour, que jouerait l'adversaire ? Exercice seulement si c'est ce qui m'a puni. */
async function threatOf(engine, board, best, oppLine, nodes) {
  const nb = board.nullMoveBoard();   // sans historique : un « coup nul » ne s'envoie pas à Stockfish
  if (!nb || nb.isGameOver()) return null;
  const ls = await lines(engine, nb, Math.floor(nodes / 2), 2);
  if (!ls.length || !oppLine) return null;
  const t = ls[0];
  const gain = t.wp - (100 - best.wp);
  if (gain < THREAT_GAIN) return null;
  const punished = oppLine.move === t.move || uciTo(oppLine.move) === uciTo(t.move);
  if (!punished) return null;
  return { fen: nb.fen(), move: t.move, accept: ls.filter((l) => l.wp >= t.wp - ACCEPT_MARGIN).map((l) => l.move) };
}

export async function generateForGame(engine, gameId, nodes) {
  const rows = db.all(`SELECT * FROM moves WHERE game_id=? AND mine=1 AND ("drop" >= ? OR missed=1) ORDER BY ply`,
    [gameId, MISTAKE]);
  let made = 0;
  for (const r of rows) {
    const board = new Board(r.fen_before);
    const played = r.uci;
    const ls = await lines(engine, board, nodes, 3);
    if (!ls.length) continue;
    const best = ls[0];
    const accepted = ls.filter((l) => l.wp >= best.wp - ACCEPT_MARGIN).map((l) => l.move);
    const [playedWp, oppLine] = await wpAfter(engine, board, played, nodes);
    const gain = best.wp - playedWp;
    let tag = tagOf(board, played, best, oppLine, !!r.missed);
    let threat = null;
    if (!r.missed && !board.isCheck()) {
      threat = await threatOf(engine, board, best, oppLine, nodes);
      if (threat) tag = 'menace';
    }
    db.run('UPDATE moves SET tag=? WHERE game_id=? AND ply=?', [tag, gameId, r.ply]);
    if (accepted.includes(played) || gain < MIN_GAIN || accepted.length >= 3) continue;
    if (best.wp < 12 || playedWp > 88) continue;  // partie déjà jouée : chercher le meilleur coup n'apprend pas grand-chose
    const solution = await extendSolution(engine, board, best.move, Math.floor(nodes / 2));
    const bestSan = board.san(best.move);
    let kind, fen, sol, acc, followup;
    if (threat) {
      kind = 'threat'; fen = threat.fen; sol = [threat.move]; acc = threat.accept;
      followup = JSON.stringify({ fen: r.fen_before, solution, accept: accepted });
    } else {
      kind = r.missed ? 'punish' : 'best'; fen = r.fen_before; sol = solution; acc = accepted; followup = null;
    }
    const t = db.now();
    made += db.run(`INSERT OR IGNORE INTO exercises(kind, game_id, ply, fen, solution, accept, followup, played_san,
                    best_san, gain, tag, created_at, due) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [kind, gameId, r.ply, fen, JSON.stringify(sol), JSON.stringify(acc), followup, r.san, bestSan, round(gain, 1), tag, t, t]);
  }
  return made;
}

// ---------------------------------------------------------------- pièges d'ouverture (trapfinder)

let trapsPromise = null;
function loadTraps() {
  if (!trapsPromise) trapsPromise = fetch(new URL('./data/traps.json', import.meta.url)).then((r) => r.json());
  return trapsPromise;
}

/** Les pièges repérés par trapfinder deviennent des exercices : l'adversaire se trompe, à toi de punir. */
export async function importTraps() {
  const traps = await loadTraps();
  let made = 0;
  db.transaction(() => {
    for (const t of traps) {
      const now = db.now();
      made += db.run(`INSERT OR IGNORE INTO exercises(kind, game_id, ply, fen, solution, accept, played_san, best_san,
                      gain, tag, note, created_at, due) VALUES('trap',?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.gid, t.ply, t.fen, JSON.stringify([t.solution]), JSON.stringify([t.solution]), t.played_san, t.best_san, null,
        'piege', t.note, now, now]);
    }
  });
  return made;
}

// ---------------------------------------------------------------- répétition espacée

export function schedule(box, ok, now, slow = false) {
  if (ok && slow) {
    // Trouvé, mais trop lentement : en blitz ça n'aurait pas suffi. La boîte n'avance pas, il revient plus tôt.
    box = Math.max(box, 1);
    return [box, now + Math.max(1, Math.floor(INTERVALS[box] / 2)) * DAY];
  }
  if (ok) {
    box = Math.min(box + 1, INTERVALS.length - 1);
    return [box, now + INTERVALS[box] * DAY];
  }
  return [1, now + INTERVALS[1] * DAY];
}

/** Temps visé pour une révision : le motif doit sauter aux yeux, pas se calculer péniblement. */
export function targetSecs(ex) {
  const sol = typeof ex.solution === 'string' ? JSON.parse(ex.solution) : ex.solution;
  let secs = 15 + 10 * Math.floor(sol.length / 2);
  if (ex.kind === 'threat') secs += 15;  // deux temps : la menace, puis la parade
  return secs;
}

export function answer(exId, ok, firstTry = true, secs = null) {
  const ex = db.get('SELECT * FROM exercises WHERE id=?', [exId]);
  if (!ex) return {};
  const now = db.now();
  const target = targetSecs(ex);
  // Le chrono ne compte qu'en révision : la première fois, on prend le temps de comprendre.
  const slow = !!(ok && ex.reps > 0 && secs !== null && secs > target);
  const grade = !ok ? 'fail' : slow ? 'slow' : 'ok';
  db.transaction(() => {
    db.run('INSERT INTO attempts(exercise_id, ts, ok, secs) VALUES(?,?,?,?)', [exId, now, Number(ok), secs]);
    if (firstTry) {  // une 2e tentative dans la même séance ne change pas le planning
      const [box, due] = schedule(ex.box, ok, now, slow);
      db.run(`UPDATE exercises SET box=?, due=?, reps=reps+1, lapses=lapses+?, last_ok=?, last_seen=?, last_secs=? WHERE id=?`,
        [box, due, ok ? 0 : 1, Number(ok), now, secs, exId]);
    }
  });
  if (firstTry) {
    db.bumpActivity('ex_done');
    if (ok && !slow) db.bumpActivity('ex_ok');
  }
  const out = db.get('SELECT box, due FROM exercises WHERE id=?', [exId]);
  return { ...out, grade, target };
}

/** Part de chaque cause dans mes erreurs récentes : la cause la plus fréquente est travaillée en premier. */
export function weaknessWeights(username, days = 90) {
  const rows = db.all(`SELECT m.tag, COUNT(*) n FROM moves m JOIN games g ON g.id = m.game_id
                       WHERE g.username=? AND g.end_time >= ? AND m.mine=1 AND m."drop" >= ? AND m.tag IS NOT NULL
                       GROUP BY m.tag`, [username.toLowerCase(), Math.floor(db.now() - days * DAY), MISTAKE]);
  const total = rows.reduce((s, r) => s + r.n, 0) || 1;
  const out = {};
  // « autre » n'est pas un motif qu'on peut travailler : il ne passe jamais devant les causes identifiées.
  for (const r of rows) if (r.tag !== 'autre') out[r.tag] = r.n / total;
  return out;
}

function dayStart() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0).getTime() / 1000;
}

export function newDoneToday() {
  const start = dayStart();
  return db.get(`SELECT COUNT(DISTINCT exercise_id) AS n FROM attempts a WHERE ts >= ?
                 AND NOT EXISTS (SELECT 1 FROM attempts b WHERE b.exercise_id=a.exercise_id AND b.ts < ?)`,
  [start, start]).n;
}

const mineFilter = (username) => ["(e.kind='trap' OR e.game_id IN (SELECT id FROM games WHERE username=?))", [username.toLowerCase()]];

export function counts(username) {
  const [flt, args] = mineFilter(username);
  const now = db.now();
  const due = db.get(`SELECT COUNT(*) n FROM exercises e WHERE ${flt} AND suspended=0 AND reps>0 AND due<=?`, [...args, now]).n;
  const nw = db.get(`SELECT COUNT(*) n FROM exercises e WHERE ${flt} AND suspended=0 AND reps=0`, args).n;
  const total = db.get(`SELECT COUNT(*) n FROM exercises e WHERE ${flt}`, args).n;
  const newLeft = Math.max(0, db.getInt('new_per_day') - newDoneToday());
  return { due, new: nw, new_today: Math.min(nw, newLeft), total };
}

export function queue(username, gameId = null, kind = null, limit = 40) {
  const now = db.now();
  if (gameId) {
    return db.all('SELECT * FROM exercises WHERE game_id=? AND suspended=0 ORDER BY ply', [gameId]).map(toJson);
  }
  const [flt, args] = mineFilter(username);
  const [kindSql, kindArgs] = kind ? [' AND e.kind=?', [kind]] : ['', []];
  const due = db.all(`SELECT e.* FROM exercises e WHERE ${flt} AND suspended=0 AND reps>0 AND due<=? ${kindSql}
                      ORDER BY due LIMIT ?`, [...args, now, ...kindArgs, limit]);
  const nNew = Math.max(0, Math.min(limit - due.length, db.getInt('new_per_day') - newDoneToday()));
  // Nouveaux : les erreurs des 2 derniers mois d'abord, et parmi elles la cause d'erreur la plus fréquente chez
  // moi en tête (si je rate surtout des menaces, je fais surtout des menaces). Les pièges d'ouverture en dernier.
  const weights = weaknessWeights(username);
  const clauses = Object.entries(weights).filter(([t]) => /^[a-z-]+$/.test(t))
    .map(([t, w]) => `WHEN '${t}' THEN ${w.toFixed(4)}`);
  const tagCase = clauses.length ? `CASE e.tag ${clauses.join(' ')} ELSE 0 END` : 'NULL';
  const fresh = db.all(`SELECT e.* FROM exercises e LEFT JOIN games g ON g.id=e.game_id
                        WHERE ${flt} AND e.suspended=0 AND e.reps=0 ${kindSql}
                        ORDER BY (e.kind='trap'), (COALESCE(g.end_time, 0) >= ?) DESC, ${tagCase} DESC, g.end_time DESC,
                                 e.gain DESC
                        LIMIT ?`, [...args, ...kindArgs, Math.floor(now - 60 * DAY), nNew]);
  // Mélange simple : on alterne révisions et nouveautés pour ne pas finir la séance sur les plus dures.
  const out = [];
  let i = 0;
  let j = 0;
  while (i < due.length || j < fresh.length) {
    if (i < due.length) out.push(due[i++]);
    if (j < fresh.length) out.push(fresh[j++]);
  }
  return out.map(toJson);
}

export function toJson(r) {
  const d = { ...r };
  d.target = targetSecs(r);
  for (const k of ['solution', 'accept']) d[k] = d[k] ? JSON.parse(d[k]) : [];
  d.followup = d.followup ? JSON.parse(d.followup) : null;
  if (d.game_id && !d.game_id.startsWith('piege:')) {
    d.game = db.get('SELECT opp_name, end_time, time_class, my_color, opening FROM games WHERE id=?', [d.game_id]);
    const prev = db.get('SELECT uci FROM moves WHERE game_id=? AND ply=?', [d.game_id, d.ply - 1]);
    // Pour une menace, le dernier coup affiché est celui que l'adversaire vient de jouer (avant le mien).
    d.last_uci = prev ? prev.uci : null;
  } else {
    d.game = null;
    d.last_uci = null;
  }
  return d;
}

export function bank(username, kind = null, limit = 300) {
  const [flt, args] = mineFilter(username);
  const [kindSql, kindArgs] = kind ? [' AND e.kind=?', [kind]] : ['', []];
  return db.all(`SELECT e.id, e.kind, e.game_id, e.ply, e.fen, e.played_san, e.best_san, e.gain, e.tag, e.box, e.due, e.reps,
                        e.lapses, e.last_ok, e.suspended, e.note, g.end_time, g.opp_name, g.time_class
                 FROM exercises e LEFT JOIN games g ON g.id=e.game_id WHERE ${flt} ${kindSql}
                 ORDER BY e.suspended, g.end_time DESC LIMIT ?`, [...args, ...kindArgs, limit]);
}
