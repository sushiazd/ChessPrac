/* Travail de fond, sur deux boucles indépendantes :
- la synchro chess.com, toutes les N minutes (et à la demande), même pendant une longue analyse ;
- l'analyse Stockfish, qui prend toujours la partie la plus récente pas encore analysée : une partie qui vient
  d'arriver passe donc devant les vieilles, sans attendre la fin du lot en cours. Une partie déjà analysée en ligne
  (par l'adversaire, ou sur un autre appareil) est reprise telle quelle : il ne reste qu'à en tirer les exercices ;
- l'envoi en ligne des parties analysées et des stats (s'il y a la clé), sur une troisième boucle.
Chaque Stockfish est un Web Worker : les calculs ne bloquent jamais l'interface. */
import * as db from './sqldb.js';
import * as chesscom from './chesscom.js';
import * as analysis from './analysis.js';
import * as exercises from './exercises.js';
import * as brilliance from './brilliance.js';
import * as cloud from './cloud.js';
import { UciEngine, EngineError } from './engine.js';

const FULL_ANALYSIS_DAYS = 180;      // au-delà, analyse rapide
const FAST_NODES = 25000;            // par position
const FAST_DEEP_NODES = 125000;      // vérification des erreurs
const PUSH_EVERY = 10;               // parties analysées entre deux envois en ligne

export const status = { phase: 'idle', done: 0, total: 0, message: '', error: null, last_sync: null, new_games: 0, syncing: false,
  cloud: { online: 0, pending: 0, error: null, last: null, sending: false } };
const set = (kw) => Object.assign(status, kw);

/** Un drapeau qu'on peut attendre (avec délai) : l'équivalent de threading.Event. */
class Signal {
  constructor() { this.flag = false; this.wake = null; }
  set() { this.flag = true; if (this.wake) this.wake(); }
  clear() { this.flag = false; }
  wait(ms) {
    if (this.flag) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }
}

const wakeSync = new Signal();
const wakeAnalysis = new Signal();
const wakeCloud = new Signal();
let started = false;
let stopped = false;
const priority = [];
const inProgress = new Set();
const engines = new Set();

export function start() {
  if (started) return;
  started = true;
  syncLoop();
  analysisLoop();
  cloudLoop();
}

export function stop() {
  stopped = true;
  wakeSync.set();
  wakeAnalysis.set();
  wakeCloud.set();
  for (const e of engines) e.close();
}

/** Sans partie : synchro tout de suite. Avec une partie : elle est analysée avant les autres. */
export function kickCloud() { wakeCloud.set(); }

export function kick(gameId = null) {
  if (gameId) {
    if (!priority.includes(gameId)) priority.unshift(gameId);
    wakeAnalysis.set();
  } else {
    wakeSync.set();
  }
}

// ---------------------------------------------------------------- synchro

async function syncLoop() {
  while (!stopped) {
    const username = db.getSetting('username');
    if (username) {
      set({ syncing: true });
      if (status.phase === 'idle') set({ phase: 'sync', message: 'Connexion à chess.com…' });
      try {
        await doSync(username);
        set({ error: null });
      } catch (e) {
        if (e instanceof chesscom.ChessComError) set({ error: e.message });
        else { console.error('synchro', e); set({ error: `Erreur : ${e.message}` }); }
      }
      set({ syncing: false });
      if (status.phase === 'sync') set({ phase: 'idle', message: '' });
      wakeAnalysis.set();
    }
    await wakeSync.wait(Math.max(5, db.getInt('auto_sync_minutes')) * 60000);
    wakeSync.clear();
  }
}

async function doSync(username) {
  const progress = (d, t, m) => { if (status.phase === 'idle' || status.phase === 'sync') set({ phase: 'sync', done: d, total: t, message: m }); };
  const added = await chesscom.sync(username, progress);
  set({ last_sync: db.now(), new_games: added });
  try {
    const st = (await chesscom.playerStats(username)) || {};
    const ratings = {};
    for (const [k, v] of Object.entries(st)) {
      if (k.startsWith('chess_') && v && typeof v === 'object' && v.last) {
        ratings[k.replace('chess_', '')] = { rating: v.last.rating, best: (v.best || {}).rating ?? null };
      }
    }
    if (st.tactics) ratings.puzzles = { rating: (st.tactics.highest || {}).rating ?? null, best: null };
    db.setSetting('cc_stats', JSON.stringify(ratings));
  } catch (e) {
    if (!(e instanceof chesscom.ChessComError)) throw e;
  }
  if (db.get("SELECT COUNT(*) n FROM exercises WHERE kind='trap'").n === 0) await exercises.importTraps();
  brilliance.scanPending(username);   // parties analysées avant l'arrivée des coups brillants
  await db.save();
}

// ---------------------------------------------------------------- analyse

const remaining = (username) =>
  db.get(`SELECT COUNT(*) n FROM games WHERE username=?
          AND (analyzed IN (0, 2) OR (analyzed=1 AND pending_ex=1))`, [username.toLowerCase()]).n;

/** [partie, demandée depuis l'interface ?] : la demande de l'interface, sinon la plus récente à faire. */
function nextGame(username) {
  while (priority.length) {
    const g = priority.shift();
    const row = db.get('SELECT analyzed FROM games WHERE id=?', [g]);
    if (row && row.analyzed !== 1 && !inProgress.has(g)) { inProgress.add(g); return [g, true]; }
  }
  const busy = [...inProgress];
  const ph = busy.map(() => '?').join(',') || "''";
  const row = db.get(`SELECT id, analyzed FROM games WHERE username=? AND id NOT IN (${ph})
                      AND (analyzed IN (0, 2) OR (analyzed=1 AND pending_ex=1))
                      ORDER BY analyzed = 2 DESC, end_time DESC LIMIT 1`, [username.toLowerCase(), ...busy]);
  if (!row) return [null, false];
  inProgress.add(row.id);
  return [row.id, row.analyzed === 2];
}

async function analysisLoop() {
  while (!stopped) {
    const username = db.getSetting('username');
    if (username) {
      try {
        if (await cloud.pull(username, () => stopped)) wakeCloud.set();
      } catch (e) {
        console.warn('reprise en ligne', e);
      }
    }
    if (username && remaining(username)) {
      try {
        await analyseAll(username);
      } catch (e) {
        if (e instanceof EngineError) set({ error: e.message });
        else { console.error('analyse', e); set({ error: `Erreur : ${e.message}` }); }
      }
      if (status.phase === 'analyse') set({ phase: 'idle', message: '' });
    }
    await wakeAnalysis.wait(60000);
    wakeAnalysis.clear();
  }
}

/** Analyse tout ce qui reste. Si le nombre de Stockfish change dans les réglages, on repart avec le nouveau. */
async function analyseAll(username) {
  const done = [0];
  while (remaining(username) && !stopped) {
    const before = done[0];
    await analyseBatch(username, done);
    if (done[0] === before) await new Promise((r) => setTimeout(r, 500));   // rien n'avance : pas de boucle folle
  }
}

async function analyseBatch(username, done) {
  const nodes = db.getInt('analysis_nodes');
  const deep = db.getInt('deep_nodes');
  const nWorkers = Math.max(1, db.getInt('workers'));
  const oldBefore = db.now() - FULL_ANALYSIS_DAYS * 86400;

  const show = () => {
    const total = done[0] + remaining(username);
    set({ phase: 'analyse', done: done[0], total, message: `Analyse Stockfish : ${done[0]} / ${total} parties` });
  };

  /** Les vieilles parties sont analysées en mode rapide : elles comptent moins pour le niveau actuel.
      Une partie ouverte dans l'interface a toujours droit à l'analyse complète. */
  const limits = (gid, asked) => {
    if (asked) return [nodes, deep];
    const row = db.get('SELECT end_time FROM games WHERE id=?', [gid]);
    if (row && (row.end_time || 0) < oldBefore) return [Math.min(nodes, FAST_NODES), Math.min(deep, FAST_DEEP_NODES)];
    return [nodes, deep];
  };

  const run = async () => {
    if (stopped) return;
    const eng = new UciEngine(32);
    engines.add(eng);
    try {
      await eng.start();
      while (!stopped) {
        if (db.getInt('workers') !== nWorkers) return;   // réglage changé : analyseAll relance avec le bon nombre
        const [gid, asked] = nextGame(username);
        if (gid === null) return;
        const reused = !!db.get('SELECT analyzed=1 AND pending_ex=1 r FROM games WHERE id=?', [gid]).r;
        try {
          const [n, d] = limits(gid, asked);
          if (!reused) await analysis.analyseGame(eng, gid, n);
          await exercises.generateForGame(eng, gid, d);
          if (reused) db.run('UPDATE games SET pending_ex=0, uploaded=0 WHERE id=?', [gid]);
          else brilliance.scanGame(gid);
        } catch (e) {
          if (stopped || e instanceof EngineError) {
            // à refaire : ce n'est pas la partie qui est en cause (une analyse reprise reste bonne)
            if (!reused) db.run('UPDATE games SET analyzed=0 WHERE id=?', [gid]);
            throw e;
          }
          console.error('analyse', gid, e);
          if (reused) db.run('UPDATE games SET pending_ex=0 WHERE id=?', [gid]);
          else db.run('UPDATE games SET analyzed=-1 WHERE id=?', [gid]);
        } finally {
          inProgress.delete(gid);
        }
        done[0] += 1;
        show();
        if (done[0] % PUSH_EVERY === 0) wakeCloud.set();
      }
    } finally {
      engines.delete(eng);
      eng.close();
    }
  };

  show();
  const results = await Promise.allSettled(Array.from({ length: nWorkers }, run));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

// ---------------------------------------------------------------- en ligne

async function cloudLoop() {
  let lastStatsTry = 0;
  while (!stopped) {
    const username = db.getSetting('username');
    const st = status.cloud;
    if (username && cloud.base() && cloud.key()) {
      try {
        const ids = cloud.pending(username, inProgress);
        Object.assign(st, { pending: ids.length, sending: ids.length > 0 });
        if (ids.length) {
          await cloud.pushGames(username, ids, () => stopped);
          db.setSetting('cloud_dirty', 1);
        }
        // Les stats repartent quand des parties ont changé (pas plus d'une fois par 10 min), et au moins 2 fois par jour.
        const t = db.now();
        const age = t - parseFloat(db.getSetting('cloud_stats_at') || '0');
        if (!stopped && t - lastStatsTry >= cloud.STATS_EVERY
            && ((db.getSetting('cloud_dirty') === '1' && age >= cloud.STATS_EVERY) || age >= cloud.STATS_REFRESH)) {
          lastStatsTry = t;
          st.sending = true;
          await cloud.pushStats(username);
          db.setSetting('cloud_dirty', 0);
        }
        Object.assign(st, { error: null, last: db.now() });
        await db.save();
      } catch (e) {
        if (!(e instanceof cloud.CloudError)) console.error('envoi en ligne', e);
        st.error = e instanceof cloud.CloudError ? e.message : `Erreur : ${e.message}`;
      }
      Object.assign(st, { online: cloud.onlineCount(username), sending: false, pending: cloud.pending(username).length });
    }
    await wakeCloud.wait(120000);
    wakeCloud.clear();
  }
}
