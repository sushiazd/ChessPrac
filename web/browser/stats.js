/* Le diagnostic : où et comment je perds des points. */
import * as db from './sqldb.js';
import { BLUNDER, MISTAKE, round } from './analysis.js';

const THINK_BUCKETS = [[0, 2, '< 2 s'], [2, 5, '2–5 s'], [5, 15, '5–15 s'], [15, 45, '15–45 s'], [45, 1e9, '> 45 s']];
const CLOCK_BUCKETS = [[0, 15, '< 15 s'], [15, 30, '15–30 s'], [30, 60, '30–60 s'], [60, 180, '1–3 min'], [180, 1e9, '> 3 min']];
const TAG_LABELS = { menace: 'Menace adverse pas vue', piece: 'Pièce laissée en prise', mat: 'Mat encaissé',
  'mat-rate': 'Mat raté', occasion: 'Erreur adverse pas punie', autre: 'Autre' };
const LOSS_LABELS = { checkmated: 'Maté', resigned: 'Abandon', timeout: 'Au temps', abandoned: 'Partie quittée', lose: 'Perdue' };
const SCORE = { win: 1, draw: 0.5, loss: 0 };

const pct = (a, b) => (b ? round(100 * a / b, 1) : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const qmarks = (n) => new Array(n).fill('?').join(',');
/** Comme max()/min() de Python : le premier élément extrême l'emporte. */
function best(arr, f, sign = 1) {
  let bi = null;
  let bv = null;
  for (const x of arr) {
    const v = sign * f(x);
    if (bv === null || v > bv) { bi = x; bv = v; }
  }
  return bi;
}
const byCount = (obj, mk) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => mk(k, v));

export function full(username, timeClass = null, days = null) {
  const u = username.toLowerCase();
  let where = 'g.username=?';
  const args = [u];
  if (timeClass) { where += ' AND g.time_class=?'; args.push(timeClass); }
  if (days) { where += ' AND g.end_time>=?'; args.push(Math.floor(db.now() - days * 86400)); }

  const games = db.all(`SELECT * FROM games g WHERE ${where} ORDER BY end_time`, args);
  const out = { games: games.length };

  // Elo dans le temps (toujours toutes cadences, pour comparer).
  const hist = {};
  for (const r of db.all('SELECT time_class, end_time, my_rating FROM games WHERE username=? AND rated=1 ORDER BY end_time', [u])) {
    (hist[r.time_class] = hist[r.time_class] || []).push([r.end_time, r.my_rating]);
  }
  out.ratings = hist;

  const res = { win: 0, draw: 0, loss: 0 };
  const byColor = { w: { ...res }, b: { ...res } };
  const losses = {};
  const wins = {};
  for (const g of games) {
    res[g.result] += 1;
    byColor[g.my_color][g.result] += 1;
    if (g.result === 'loss') losses[g.my_code] = (losses[g.my_code] || 0) + 1;
    else if (g.result === 'win') wins[g.opp_code] = (wins[g.opp_code] || 0) + 1;
  }
  out.results = res;
  out.by_color = byColor;
  out.losses = byCount(losses, (k, v) => ({ code: k, label: LOSS_LABELS[k] || k, n: v }));
  out.wins = byCount(wins, (k, v) => ({ code: k, label: LOSS_LABELS[k] || k, n: v }));

  // Ouvertures : regroupées par les 3 premiers coups, de mon côté.
  const ops = new Map();
  const first4 = new Map();
  for (const r of db.all('SELECT game_id, san FROM moves WHERE ply<=4 ORDER BY game_id, ply')) {
    if (!first4.has(r.game_id)) first4.set(r.game_id, []);
    first4.get(r.game_id).push(r.san);
  }
  for (const g of games) {
    const sans = first4.get(g.id) || [];
    const line = sans.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${s}` : s)).join(' ');
    const k = `${g.my_color}|${line}`;
    let o = ops.get(k);
    if (!o) { o = { color: g.my_color, line, name: g.opening, n: 0, score: 0, acc: [], blunders: 0 }; ops.set(k, o); }
    o.n += 1;
    o.score += SCORE[g.result];
    if (g.acc_me !== null) { o.acc.push(g.acc_me); o.blunders += g.n_blunders || 0; }
  }
  const opList = [];
  for (const o of ops.values()) {
    if (o.n < 2) continue;
    opList.push({ color: o.color, line: o.line, name: o.name, n: o.n, score: Math.round(100 * o.score / o.n),
      acc: o.acc.length ? round(sum(o.acc) / o.acc.length, 1) : null,
      blunders: o.acc.length ? round(o.blunders / o.acc.length, 2) : null });
  }
  opList.sort((a, b) => b.n - a.n);
  out.openings = opList.slice(0, 24);

  // Tout ce qui suit demande l'analyse Stockfish.
  const analyzed = games.filter((g) => g.analyzed === 1);
  out.analyzed = analyzed.length;
  if (!analyzed.length) { out.insights = []; return out; }
  const ids = analyzed.map((g) => g.id);
  const mv = db.all(`SELECT * FROM moves WHERE game_id IN (${qmarks(ids.length)}) AND mine=1 AND "drop" IS NOT NULL`, ids);

  const phases = {};
  for (const p of ['ouverture', 'milieu', 'finale']) phases[p] = { moves: 0, mistakes: 0, blunders: 0, acc: 0 };
  for (const m of mv) {
    const p = phases[m.phase];
    p.moves += 1;
    p.acc += m.accuracy;
    if (m.drop >= BLUNDER) p.blunders += 1;
    else if (m.drop >= MISTAKE) p.mistakes += 1;
  }
  out.phases = Object.entries(phases).map(([k, v]) => ({
    phase: k, moves: v.moves, acc: v.moves ? round(v.acc / v.moves, 1) : null,
    mistakes_per_game: round(v.mistakes / analyzed.length, 2), blunders_per_game: round(v.blunders / analyzed.length, 2),
    blunder_rate: pct(v.blunders, v.moves) }));

  const buckets = (field, spec) => spec.map(([lo, hi, label]) => {
    const sel = mv.filter((m) => m[field] !== null && lo <= m[field] && m[field] < hi);
    const bl = sel.filter((m) => m.drop >= BLUNDER).length;
    return { label, moves: sel.length, blunders: bl, rate: pct(bl, sel.length) };
  });
  out.think = buckets('think', THINK_BUCKETS);
  out.clock = buckets('clock', CLOCK_BUCKETS);

  const tags = {};
  for (const m of mv) if (m.drop >= MISTAKE && m.tag) tags[m.tag] = (tags[m.tag] || 0) + 1;
  out.tags = byCount(tags, (k, v) => ({ tag: k, label: TAG_LABELS[k] || k, n: v }));

  // Précision par semaine (moyenne glissante simple).
  const weeks = new Map();
  for (const g of analyzed) {
    if (g.acc_me === null) continue;
    const w = Math.floor(g.end_time / (7 * 86400));
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(g.acc_me);
  }
  out.accuracy_weeks = [...weeks.entries()].sort((a, b) => a[0] - b[0])
    .map(([w, v]) => [w * 7 * 86400, round(sum(v) / v.length, 1), v.length]);

  // Parties gâchées : pas gagnées alors que j'ai eu au moins 85 % de chances de gain.
  const bestWp = {};
  for (const m of mv) if (m.wp_before !== null) bestWp[m.game_id] = Math.max(bestWp[m.game_id] || 0, m.wp_before);
  const notWon = analyzed.filter((g) => g.result !== 'win');
  const thrown = notWon.filter((g) => (bestWp[g.id] || 0) >= 85);
  out.thrown = { n: thrown.length, of: notWon.length };

  const nBl = mv.filter((m) => m.drop >= BLUNDER).length;
  const nMi = mv.filter((m) => m.drop >= MISTAKE && m.drop < BLUNDER).length;
  out.per_game = { blunders: round(nBl / analyzed.length, 2), mistakes: round(nMi / analyzed.length, 2),
    acc: round(sum(analyzed.filter((g) => g.acc_me).map((g) => g.acc_me)) / analyzed.length, 1) };
  out.insights = insights(out);
  return out;
}

const PHASE_IN = { ouverture: "dans l'ouverture", milieu: 'en milieu de partie', finale: 'en finale' };
const fr = (x, d = 1) => x.toFixed(d).replace('.', ',');

/** Quelques phrases simples, les plus utiles d'abord. */
export function insights(s) {
  const out = [];
  const pg = s.per_game;
  if (pg) {
    out.push({ kind: 'info', text: `Tu fais en moyenne ${fr(pg.blunders)} gaffe(s) et ${fr(pg.mistakes)} erreur(s) par partie, `
      + `pour ${pg.acc.toFixed(0)} % de précision.` });
  }
  const th = s.thrown;
  if (th && th.of >= 5 && th.n / th.of >= 0.15) {
    out.push({ kind: 'bad', text: `${th.n} de tes ${th.of} défaites et nulles analysées étaient gagnées (85 % de chances de gain `
      + `ou plus) : c'est ${Math.round(100 * th.n / th.of)} % de points laissés en route. Entraîne-toi dans « Erreurs > Convertir ».` });
  }
  const tags = s.tags || [];
  const total = sum(tags.map((t) => t.n));
  if (total >= 5) {
    const top = tags[0];
    if (top.tag !== 'autre') {
      out.push({ kind: 'bad', text: `Ta première cause d'erreur : « ${top.label.toLowerCase()} » (${Math.round(100 * top.n / total)} % `
        + 'de tes erreurs). Les exercices « Erreurs » de ce type passent en premier.' });
    }
    const threat = tags.find((t) => t.tag === 'menace');
    if (threat && threat !== top && threat.n / total >= 0.15) {
      out.push({ kind: 'bad', text: `${Math.round(100 * threat.n / total)} % de tes erreurs viennent d'une menace adverse pas vue. `
        + "Avant chaque coup, demande-toi : « qu'est-ce que l'adversaire veut faire ? »" });
    }
  }
  const think = (s.think || []).filter((b) => b.moves >= 30 && b.rate !== null);
  if (think.length >= 2) {
    const fast = think[0];
    const slow = best(think.slice(1), (b) => b.moves);
    if (fast.rate && slow.rate && fast.rate >= 1.5 * slow.rate) {
      out.push({ kind: 'warn', text: `Quand tu joues en ${fast.label}, tu gaffes ${fr(fast.rate)} % du temps, contre `
        + `${fr(slow.rate)} % en ${slow.label} : ×${fr(fast.rate / slow.rate)}.` });
    }
  }
  const phases = (s.phases || []).filter((p) => p.moves >= 30);
  if (phases.length) {
    const worst = best(phases, (p) => p.blunders_per_game);
    out.push({ kind: 'info', text: `C'est ${PHASE_IN[worst.phase]} que tu gaffes le plus : ${fr(worst.blunders_per_game, 2)} `
      + `gaffe par partie (précision ${worst.acc.toFixed(0)} %).` });
  }
  const losses = s.losses || [];
  const nl = sum(losses.map((l) => l.n));
  if (nl >= 5) {
    const mated = losses.find((l) => l.code === 'checkmated');
    if (mated && mated.n / nl >= 0.35) {
      out.push({ kind: 'warn', text: `${Math.round(100 * mated.n / nl)} % de tes défaites finissent par un mat : `
        + 'regarde la sécurité de ton roi et les échecs adverses à chaque coup.' });
    }
    const timeout = losses.find((l) => l.code === 'timeout');
    if (timeout && timeout.n / nl >= 0.25) {
      out.push({ kind: 'warn', text: `${Math.round(100 * timeout.n / nl)} % de tes défaites sont au temps : joue plus vite `
        + "les coups évidents de l'ouverture." });
    }
  }
  const weak = (s.openings || []).filter((o) => o.n >= 5 && o.score <= 40);
  if (weak.length) {
    const o = best(weak, (x) => x.score, -1);
    const side = o.color === 'w' ? 'Blancs' : 'Noirs';
    out.push({ kind: 'bad', text: `Avec les ${side}, après ${o.line}, tu ne marques que ${o.score} % (${o.n} parties). `
      + 'À travailler dans « Ouvertures ».' });
  }
  return out;
}

// ---------------------------------------------------------------- statistiques « pour le plaisir »

const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'missed'];
const PERIODS = [[6, 12, 'Le matin'], [12, 18, "L'après-midi"], [18, 23, 'Le soir'], [23, 30, 'La nuit']];

export function fun(username, timeClass = null, days = null) {
  let where = 'g.username=?';
  const args = [username.toLowerCase()];
  if (timeClass) { where += ' AND g.time_class=?'; args.push(timeClass); }
  if (days) { where += ' AND g.end_time>=?'; args.push(Math.floor(db.now() - days * 86400)); }
  const games = db.all(`SELECT * FROM games g WHERE ${where} ORDER BY end_time`, args);
  const out = {};

  // Mes coups, classés comme sur chess.com.
  const counts = Object.fromEntries(CLASS_ORDER.map((k) => [k, 0]));
  for (const r of db.all(`SELECT m.cls, m.special, m.missed FROM moves m JOIN games g ON g.id=m.game_id
                          WHERE ${where} AND m.mine=1 AND m.cls IS NOT NULL`, args)) {
    if (r.special === 'brilliant' || r.special === 'great') counts[r.special] += 1;
    else if (r.cls in counts) counts[r.cls] += 1;
    if (r.missed) counts.missed += 1;
  }
  out.classes = counts;

  // Mes coups brillants, les plus récents d'abord.
  out.brilliants = db.all(`SELECT m.game_id, m.ply, m.san, m.uci, m.fen_before, g.opp_name, g.opp_rating, g.end_time, g.time_class,
                                  g.time_control, g.result, g.my_color
                           FROM moves m JOIN games g ON g.id=m.game_id
                           WHERE ${where} AND m.mine=1 AND m.special='brilliant' ORDER BY g.end_time DESC LIMIT 40`, args);

  // Records.
  const rec = {};
  const played = games;
  rec.games = played.length;
  const t = db.get(`SELECT COUNT(*) n, SUM(m.think) s, MAX(m.think) mx FROM moves m JOIN games g ON g.id=m.game_id
                    WHERE ${where} AND m.mine=1 AND g.time_class != 'daily'`, args);
  rec.moves = t.n;
  rec.think_hours = round((t.s || 0) / 3600, 1);
  rec.longest_think = Math.round(t.mx || 0);

  const brief = (g, extra = {}) => ({ id: g.id, opp_name: g.opp_name, opp_rating: g.opp_rating, end_time: g.end_time,
    time_class: g.time_class, time_control: g.time_control, result: g.result, ...extra });

  const winsList = played.filter((g) => g.result === 'win');
  const ratedWins = winsList.filter((g) => g.rated && g.opp_rating);
  if (ratedWins.length) rec.best_win = brief(best(ratedWins, (g) => g.opp_rating));
  const mates = winsList.filter((g) => g.opp_code === 'checkmated');
  if (mates.length) {
    const g = best(mates, (x) => x.n_plies, -1);
    rec.fastest_mate = brief(g, { moves: Math.floor((g.n_plies + 1) / 2) });
  }
  if (played.length) {
    const g = best(played, (x) => x.n_plies || 0);
    rec.longest = brief(g, { moves: Math.floor(((g.n_plies || 0) + 1) / 2) });
  }
  const accurate = played.filter((g) => g.acc_me !== null && (g.n_plies || 0) >= 30);
  if (accurate.length) {
    const g = best(accurate, (x) => x.acc_me);
    rec.most_accurate = brief(g, { acc: g.acc_me });
  }
  rec.clean_games = played.filter((g) => g.analyzed === 1 && (g.n_plies || 0) >= 30 && !(g.n_blunders || 0) && !(g.n_mistakes || 0)).length;

  // Plus belle remontée : victoire après être tombé le plus bas.
  const winIds = winsList.map((g) => g.id);
  if (winIds.length) {
    const row = db.get(`SELECT game_id, MIN(wp_before) low FROM moves WHERE mine=1 AND game_id IN (${qmarks(winIds.length)})
                        AND wp_before IS NOT NULL GROUP BY game_id ORDER BY low LIMIT 1`, winIds);
    if (row) {
      const g = winsList.find((x) => x.id === row.game_id);
      rec.comeback = brief(g, { low: round(row.low, 1) });
    }
  }

  // Plus longue série de victoires.
  let bestRun = 0;
  let cur = 0;
  for (const g of played) {
    cur = g.result === 'win' ? cur + 1 : 0;
    bestRun = Math.max(bestRun, cur);
  }
  rec.win_streak = bestRun;

  // Adversaire le plus rencontré.
  const faced = new Map();
  for (const g of played) {
    if (!faced.has(g.opp_name)) faced.set(g.opp_name, []);
    faced.get(g.opp_name).push(g.result);
  }
  if (faced.size) {
    const [name, res] = best([...faced.entries()], ([, r]) => r.length);
    if (res.length >= 2) {
      rec.rival = { name, n: res.length, wins: res.filter((x) => x === 'win').length, losses: res.filter((x) => x === 'loss').length };
    }
  }

  // Meilleur moment de la journée pour jouer.
  const periods = [];
  for (const [lo, hi, label] of PERIODS) {
    const sel = played.filter((g) => {
      const h = new Date(g.end_time * 1000).getHours();
      const hh = h + (h < 6 ? 24 : 0);
      return lo <= hh && hh < hi;
    });
    if (sel.length) {
      const score = sum(sel.map((g) => SCORE[g.result])) / sel.length;
      periods.push({ label, n: sel.length, score: Math.round(100 * score) });
    }
  }
  out.periods = periods;
  out.records = rec;
  return out;
}
