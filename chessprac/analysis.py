"""Analyse Stockfish d'une partie : évaluation de chaque position et classement de chaque coup."""
import time

import chess
import chess.engine

from . import db
from .engine import move_accuracy, score_cp, terminal_eval, wp_for

# Seuils de Lichess, en points de pourcentage de gain perdus par le coup.
INACCURACY, MISTAKE, BLUNDER = 10, 20, 30
PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def classify(drop: float, is_best: bool) -> str:
    if is_best:
        return "best"
    if drop < 2:
        return "excellent"
    if drop < INACCURACY:
        return "good"
    if drop < MISTAKE:
        return "inaccuracy"
    if drop < BLUNDER:
        return "mistake"
    return "blunder"


def non_pawn_material(board: chess.Board) -> int:
    return sum(PIECE_VALUES[p.piece_type] for p in board.piece_map().values() if p.piece_type != chess.PAWN)


def material_balance(board: chess.Board, color: chess.Color) -> int:
    total = 0
    for p in board.piece_map().values():
        total += PIECE_VALUES[p.piece_type] * (1 if p.color == color else -1)
    return total


def phase_of(board: chess.Board, ply: int) -> str:
    if non_pawn_material(board) <= 20:
        return "finale"
    if ply <= 20:
        return "ouverture"
    return "milieu"


def evaluate_positions(engine: chess.engine.SimpleEngine, fens: list[str], nodes: int) -> list[dict]:
    out = []
    for fen in fens:
        board = chess.Board(fen)
        term = terminal_eval(board)
        if term is not None:
            out.append({"cp": term[0], "mate": term[1], "best": None, "pv": []})
            continue
        info = engine.analyse(board, chess.engine.Limit(nodes=nodes))
        cp, mate = score_cp(info["score"], chess.WHITE)
        pv = info.get("pv") or []
        out.append({"cp": cp, "mate": mate, "best": pv[0] if pv else None, "pv": pv[:8]})
    return out


def game_accuracy(xs: list[float]) -> float | None:
    """Comme Lichess : moitié moyenne, moitié moyenne harmonique (une grosse gaffe pèse plus qu'une simple moyenne)."""
    if not xs:
        return None
    arith = sum(xs) / len(xs)
    harm = len(xs) / sum(1 / max(x, 1.0) for x in xs)
    return round((arith + harm) / 2, 1)


def analyse_game(engine: chess.engine.SimpleEngine, game_id: str, nodes: int) -> None:
    conn = db.connect()
    rows = conn.execute("SELECT ply, uci, fen_before, color FROM moves WHERE game_id=? ORDER BY ply",
                        (game_id,)).fetchall()
    if not rows:
        conn.execute("UPDATE games SET analyzed=-1 WHERE id=?", (game_id,))
        return
    last = chess.Board(rows[-1]["fen_before"])
    last.push(chess.Move.from_uci(rows[-1]["uci"]))
    fens = [r["fen_before"] for r in rows] + [last.fen()]
    evals = evaluate_positions(engine, fens, nodes)

    updates = []
    acc = {"w": [], "b": []}
    counts = {"inaccuracy": 0, "mistake": 0, "blunder": 0}
    my_color = conn.execute("SELECT my_color FROM games WHERE id=?", (game_id,)).fetchone()["my_color"]
    prev_drop = 0.0
    for i, r in enumerate(rows):
        board = chess.Board(r["fen_before"])
        color = board.turn
        before, after = evals[i], evals[i + 1]
        wpb, wpa = wp_for(before["cp"], color), wp_for(after["cp"], color)
        drop = max(0.0, wpb - wpa)
        best = before["best"]
        is_best = best is not None and best.uci() == r["uci"]
        cls = classify(drop, is_best)
        missed = int(prev_drop >= MISTAKE and drop >= 15)
        a = move_accuracy(drop)
        acc[r["color"]].append(a)
        if r["color"] == my_color and cls in counts:
            counts[cls] += 1
        best_san = board.san(best) if best is not None else None
        pv_uci = " ".join(m.uci() for m in before["pv"])
        updates.append((before["cp"], before["mate"], after["cp"], after["mate"],
                        best.uci() if best else None, best_san, pv_uci,
                        round(wpb, 2), round(wpa, 2), round(drop, 2), round(a, 1), cls, missed,
                        phase_of(board, r["ply"]), game_id, r["ply"]))
        prev_drop = drop

    opp_color = "b" if my_color == "w" else "w"
    with db.transaction() as tx:
        tx.executemany(
            """UPDATE moves SET cp_before=?, mate_before=?, cp_after=?, mate_after=?, best_uci=?, best_san=?, pv=?,
               wp_before=?, wp_after=?, "drop"=?, accuracy=?, cls=?, missed=?, phase=? WHERE game_id=? AND ply=?""",
            updates)
        tx.execute("""UPDATE games SET analyzed=1, analyzed_at=?, acc_me=?, acc_opp=?, n_inacc=?, n_mistakes=?,
                      n_blunders=?, uploaded=0 WHERE id=?""",
                   (time.time(), game_accuracy(acc[my_color]), game_accuracy(acc[opp_color]), counts["inaccuracy"], counts["mistake"],
                    counts["blunder"], game_id))
