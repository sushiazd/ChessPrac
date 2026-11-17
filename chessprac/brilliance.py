"""Coups brillants (!!) et grands coups (!), à la manière de chess.com, calculés à partir de l'analyse déjà faite.

- Brillant (!!) : un des meilleurs coups, qui sacrifie du matériel (pièce laissée en prise ou perte nette dans la
  meilleure suite), sans que la position soit déjà totalement gagnée, et qui tient la route ensuite.
- Grand coup (!) : l'adversaire vient de gaffer et tu trouves LE coup qui le punit (le meilleur, avec un vrai gain
  derrière), et ce n'est pas la simple prise de la pièce qui vient de bouger. Le réflexe qui fait gagner à ce niveau.

Pas besoin de relancer Stockfish : on se sert des évaluations et des meilleures suites gardées en base.
"""
import chess

from . import db
from .analysis import PIECE_VALUES, material_balance

GOOD = ("best", "excellent")
GREAT_PREV_DROP = 30   # l'adversaire vient de faire une gaffe


def _en_prise(board: chess.Board, square: chess.Square, color: chess.Color) -> bool:
    """La pièce sur square est-elle laissée en prise (attaquée par moins cher, ou attaquée et pas défendue) ?"""
    piece = board.piece_at(square)
    if piece is None:
        return False
    attackers = board.attackers(not color, square)
    if not attackers:
        return False
    cheapest = min(PIECE_VALUES[board.piece_at(s).piece_type] or 100 for s in attackers)
    if cheapest < PIECE_VALUES[piece.piece_type]:
        return True
    return not board.attackers(color, square)


def is_sacrifice(before: chess.Board, move: chess.Move, pv_after: list[str]) -> bool:
    me = before.turn
    piece = before.piece_at(move.from_square)
    if piece is None or piece.piece_type in (chess.PAWN, chess.KING) or move.promotion:
        return False
    captured = before.piece_at(move.to_square)
    gained = PIECE_VALUES[captured.piece_type] if captured else 0
    if before.is_en_passant(move):
        gained = 1
    after = before.copy()
    after.push(move)
    if after.is_checkmate():
        return False
    # 1) La pièce jouée reste en prise et vaut plus que ce qu'elle vient de prendre.
    if PIECE_VALUES[piece.piece_type] - gained >= 2 and _en_prise(after, move.to_square, me):
        return True
    # 2) Dans la meilleure suite, l'adversaire prend la pièce jouée et je reste en retard de matériel après ma
    #    réponse. (Si c'est une autre pièce, déjà en prise avant, ce n'est pas un sacrifice, juste un oubli.)
    if not pv_after or chess.Move.from_uci(pv_after[0]).to_square != move.to_square:
        return False
    start = material_balance(before, me)
    b = after.copy()
    bals = []
    for u in pv_after[:4]:
        m = chess.Move.from_uci(u)
        if not b.is_legal(m):
            break
        b.push(m)
        bals.append(material_balance(b, me))
    if len(bals) >= 2:
        mine = bals[1::2]  # après chacun de mes coups suivants
        return all(start - x >= 2 for x in mine)
    return False


def scan_game(game_id: str) -> dict:
    conn = db.connect()
    rows = conn.execute("""SELECT ply, uci, fen_before, mine, cls, wp_before, wp_after, "drop", pv
                           FROM moves WHERE game_id=? ORDER BY ply""", (game_id,)).fetchall()
    updates = []
    found = {"brilliant": 0, "great": 0}
    for i, r in enumerate(rows):
        special = None
        if r["cls"] in GOOD and r["wp_before"] is not None:
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            pv_after = nxt["pv"].split() if nxt is not None and nxt["pv"] else []
            before = chess.Board(r["fen_before"])
            move = chess.Move.from_uci(r["uci"])
            if r["wp_before"] <= 90 and r["wp_after"] >= 45 and is_sacrifice(before, move, pv_after):
                special = "brilliant"
            elif i > 0 and r["cls"] == "best" and (rows[i - 1]["drop"] or 0) >= GREAT_PREV_DROP \
                    and r["wp_after"] >= 70 and move.to_square != chess.Move.from_uci(rows[i - 1]["uci"]).to_square:
                # Pas la simple prise de la pièce qui vient de bouger : il fallait voir plus loin.
                special = "great"
        if special:
            found[special] += 1
        updates.append((special, game_id, r["ply"]))
    with db.transaction() as tx:
        tx.executemany("UPDATE moves SET special=? WHERE game_id=? AND ply=?", updates)
        tx.execute("UPDATE games SET specials_done=1 WHERE id=?", (game_id,))
    return found


def scan_pending(username: str) -> int:
    """Calcule les coups spéciaux des parties analysées qui ne l'ont pas encore été (une fois pour toutes)."""
    ids = [r["id"] for r in db.connect().execute(
        "SELECT id FROM games WHERE username=? AND analyzed=1 AND COALESCE(specials_done, 0)=0", (username.lower(),))]
    for gid in ids:
        scan_game(gid)
    return len(ids)
