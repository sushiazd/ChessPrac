/* Une petite couche au-dessus de chess.js qui ressemble à python-chess : le reste du port
   (analyse, exercices, répertoire...) suit le code Python presque ligne à ligne.
   Les coups sont des chaînes UCI ('e2e4', 'e7e8q'), les cases des noms ('e4'). */
import { Chess } from './vendor/chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Les 4 premiers champs d'une FEN : la position sans les compteurs (équivaut à board.epd()). */
export const fenKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

export const uciFrom = (u) => u.slice(0, 2);
export const uciTo = (u) => u.slice(2, 4);

export class Board {
  constructor(fen = START_FEN, skipValidation = false) {
    this.c = new Chess(fen, { skipValidation });
    this._legal = null;
  }

  copy() { return new Board(this.c.fen(), true); }
  fen() { return this.c.fen(); }
  epd() { return fenKey(this.c.fen()); }
  get turn() { return this.c.turn(); } // 'w' | 'b'
  get fullmove() { return this.c.moveNumber(); }
  ply() { return 2 * (this.c.moveNumber() - 1) + (this.c.turn() === 'b' ? 1 : 0); }

  /** Coups légaux détaillés (mis en cache jusqu'au prochain coup). */
  legal() {
    if (!this._legal) {
      this._legal = this.c.moves({ verbose: true }).map((m) => ({
        uci: m.from + m.to + (m.promotion || ''), san: m.san, from: m.from, to: m.to, promotion: m.promotion || null,
        flags: m.flags, piece: m.piece, captured: m.captured || null,
      }));
    }
    return this._legal;
  }
  legalUci() { return this.legal().map((m) => m.uci); }
  legalCount() { return this.legal().length; }
  find(uci) { return this.legal().find((m) => m.uci === uci) || null; }
  isLegal(uci) { return !!this.find(uci); }
  san(uci) {
    const m = this.find(uci);
    if (!m) throw new Error(`Coup illégal : ${uci}`);
    return m.san;
  }
  isEnPassant(uci) { const m = this.find(uci); return !!m && m.flags.includes('e'); }

  push(uci) {
    const m = this.find(uci);
    if (!m) throw new Error(`Coup illégal : ${uci}`);
    this.c.move({ from: m.from, to: m.to, promotion: m.promotion || undefined });
    this._legal = null;
    return m;
  }
  /** Joue un coup en notation SAN (parties chess.com). Renvoie {uci, san} (SAN canonique). */
  pushSan(san) {
    const m = this.c.move(san);
    this._legal = null;
    return { uci: m.from + m.to + (m.promotion || ''), san: m.san };
  }

  isCheck() { return this.c.isCheck(); }
  isCheckmate() { return this.c.isCheckmate(); }
  isStalemate() { return this.c.isStalemate(); }
  isInsufficientMaterial() { return this.c.isInsufficientMaterial(); }
  isGameOver() { return this.isCheckmate() || this.isStalemate() || this.isInsufficientMaterial(); }
  canClaimDraw() { return this.c.isDrawByFiftyMoves() || this.c.isThreefoldRepetition(); }

  /** [{sq, type, color}] pour toutes les pièces. */
  pieceMap() {
    const out = [];
    for (const row of this.c.board()) for (const p of row) if (p) out.push({ sq: p.square, type: p.type, color: p.color });
    return out;
  }
  pieceAt(sq) { return this.c.get(sq) || null; }
  king(color) { const k = this.pieceMap().find((p) => p.type === 'k' && p.color === color); return k ? k.sq : null; }
  /** Cases des pièces de `color` qui attaquent `sq`. */
  attackers(color, sq) { return this.c.attackers(sq, color); }

  /** Même position, mais l'autre camp a le trait (coup « nul »). Null si la position est invalide. */
  nullMoveBoard() {
    if (this.isCheck()) return null;
    const f = this.c.fen().split(' ');
    f[1] = f[1] === 'w' ? 'b' : 'w';
    f[3] = '-';
    f[4] = String(Number(f[4]) + 1);
    if (f[1] === 'w') f[5] = String(Number(f[5]) + 1);
    try { return new Board(f.join(' ')); } catch { return null; }
  }
}

export const isWhite = (color) => color === 'w';
export const opposite = (color) => (color === 'w' ? 'b' : 'w');
