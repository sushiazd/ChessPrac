/* Stockfish 19 (WebAssembly, version « lite » à un seul fil : aucun réglage serveur nécessaire) dans des Web Workers,
   et les calculs d'évaluation (pourcentage de gain, précision) — le pendant de engine.py. */
import { Board, opposite } from './pychess.js';

export const MATE_CP = 10000;
const ENGINE_URL = new URL('./vendor/stockfish-19-lite-single.js', import.meta.url).href;

export class EngineError extends Error {}

/** Chances de gain (0-100) du joueur qui a l'avantage cp, formule de Lichess. */
export function winPct(cp) {
  cp = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Précision d'un coup selon la perte de chances de gain (formule de Lichess). */
export function moveAccuracy(drop) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669 + 1));
}

/** (centipions, mat) d'un score UCI {cp}|{mate}, vus par `pov` ; `turn` = camp qui a le trait dans la position. */
export function scoreCp(score, turn, pov = 'w') {
  const sign = turn === pov ? 1 : -1;
  if (score.mate !== undefined && score.mate !== null) {
    const mate = score.mate * sign;
    if (mate === 0) return [-MATE_CP, 0];
    const cp = MATE_CP - 10 * Math.abs(mate);
    return [mate > 0 ? cp : -cp, mate];
  }
  return [Math.trunc(score.cp * sign), null];
}

/** Évaluation (vue par les Blancs) d'une position finie, sinon null. */
export function terminalEval(board) {
  if (board.isCheckmate()) return [board.turn === 'w' ? -MATE_CP : MATE_CP, 0];
  if (board.isStalemate() || board.isInsufficientMaterial()) return [0, null];
  return null;
}

export function wpFor(cpWhite, color) {
  return winPct(color === 'w' ? cpWhite : -cpWhite);
}

/** Un Stockfish dans un Worker. Une recherche à la fois ; les demandes suivantes attendent leur tour. */
export class UciEngine {
  constructor(hashMb = 32) {
    this.hashMb = hashMb;
    this.worker = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.multipv = 1;
    this.ready = null;
    this.closed = false;
  }

  _send(cmd) { this.worker.postMessage(cmd); }

  _waitFor(pred, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners.delete(fn); reject(new EngineError('Stockfish ne répond plus.')); }, timeout);
      const fn = (line) => {
        if (line instanceof Error) { clearTimeout(t); this.listeners.delete(fn); reject(line); }
        else if (pred(line)) { clearTimeout(t); this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
    });
  }

  start() {
    if (!this.ready) {
      this.ready = (async () => {
        this.worker = new Worker(ENGINE_URL);
        this.worker.onmessage = (e) => {
          const line = typeof e.data === 'string' ? e.data : '';
          for (const fn of [...this.listeners]) fn(line);
        };
        this.worker.onerror = (e) => {
          const err = new EngineError(`Stockfish n'a pas pu démarrer (${e.message || 'erreur de chargement'}).`);
          for (const fn of [...this.listeners]) fn(err);
        };
        const uok = this._waitFor((l) => l === 'uciok', 60000);
        this._send('uci');
        await uok;
        this._send(`setoption name Hash value ${this.hashMb}`);
        const rok = this._waitFor((l) => l === 'readyok');
        this._send('isready');
        await rok;
      })();
    }
    return this.ready;
  }

  /** Recherche limitée en nœuds. Renvoie une liste (une ligne par multipv) : {score:{cp|mate}, pv:[uci], depth}. */
  analyse(fen, nodes, multipv = 1) {
    const job = this.queue.then(() => this._search(fen, nodes, multipv));
    this.queue = job.catch(() => {});
    return job;
  }

  async _search(fen, nodes, multipv) {
    if (this.closed) throw new EngineError('Moteur arrêté.');
    await this.start();
    if (multipv !== this.multipv) {
      this._send(`setoption name MultiPV value ${multipv}`);
      this.multipv = multipv;
    }
    const lines = new Map();
    const onInfo = (line) => {
      if (typeof line !== 'string') return false;
      if (!line.startsWith('info ') || !line.includes(' score ') || !line.includes(' pv ')) return false;
      const t = line.split(' ');
      const g = (k) => { const i = t.indexOf(k); return i < 0 ? null : t[i + 1]; };
      const kind = t[t.indexOf('score') + 1];
      const val = parseInt(t[t.indexOf('score') + 2], 10);
      if (t[t.indexOf('score') + 3] === 'lowerbound' || t[t.indexOf('score') + 3] === 'upperbound') return false;
      lines.set(parseInt(g('multipv') || '1', 10), {
        score: kind === 'mate' ? { mate: val } : { cp: val }, depth: parseInt(g('depth') || '0', 10),
        pv: t.slice(t.indexOf('pv') + 1),
      });
      return false;
    };
    this.listeners.add(onInfo);
    try {
      const done = this._waitFor((l) => l.startsWith('bestmove'), 600000);
      this._send(`position fen ${fen}`);
      this._send(`go nodes ${Math.max(1, Math.round(nodes))}`);
      await done;
    } finally {
      this.listeners.delete(onInfo);
    }
    return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }

  /** Le meilleur coup (UCI) d'une position. */
  async play(fen, nodes) {
    const lines = await this.analyse(fen, nodes, 1);
    if (!lines.length || !lines[0].pv.length) throw new EngineError('Stockfish n\'a trouvé aucun coup.');
    return lines[0].pv[0];
  }

  close() {
    this.closed = true;
    if (this.worker) { try { this.worker.terminate(); } catch { /* rien */ } this.worker = null; }
    for (const fn of [...this.listeners]) fn(new EngineError('Moteur arrêté.'));
    this.listeners.clear();
  }
}

/** Le Stockfish de l'interface (analyse à la demande, adversaire des finales), utilisé chacun son tour. */
export const shared = new UciEngine(64);

/** Petite mémoire des évaluations : les positions d'ouverture reviennent dans presque toutes les parties. */
const evalMemo = new Map();
const MEMO_MAX = 30000;
export function memoGet(fen, nodes) {
  const e = evalMemo.get(fen.split(' ').slice(0, 4).join(' '));
  return e && e.nodes >= nodes ? e.value : null;
}
export function memoSet(fen, nodes, value) {
  if (evalMemo.size >= MEMO_MAX) evalMemo.delete(evalMemo.keys().next().value);
  evalMemo.set(fen.split(' ').slice(0, 4).join(' '), { nodes, value });
}

export { Board, opposite };
