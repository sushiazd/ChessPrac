"""« Gagner les parties gagnées » : les positions où j'avais l'avantage décisif mais où je n'ai pas gagné.
On les rejoue contre Stockfish à pleine force jusqu'à transformer l'avantage en gain net.

À ce niveau, beaucoup de points se perdent après avoir pris l'avantage (gaffe pour finir, pat, temps...).
Savoir finir une partie gagnée est une compétence à part, qui s'entraîne comme ça.
"""
import time

import chess

from . import db
from .engine import score_cp, shared

WINNING_WP = 85        # chances de gain à partir desquelles je « gagnais »
ENGINE_NODES = 300000
LIMIT = 25             # coups pour finir le travail
WON_CP = 900           # avantage net : on considère la partie gagnée (pièce lourde de plus, mat en vue...)
LOST_CP = 150          # en dessous, l'avantage est perdu
DAY = 86400.0


def refresh(username: str) -> None:
    """Ajoute les nouvelles positions : la première où j'étais gagnant, dans chaque partie que je n'ai pas gagnée."""
    conn = db.connect()
    rows = conn.execute(
        """SELECT m.game_id, MIN(m.ply) AS ply FROM moves m JOIN games g ON g.id = m.game_id
           WHERE g.username=? AND g.analyzed=1 AND g.result != 'win' AND g.time_class != 'daily'
             AND m.mine=1 AND m.wp_before >= ? AND (m.mate_before IS NULL OR ABS(m.mate_before) > 3)
             AND g.id NOT IN (SELECT game_id FROM conversions)
           GROUP BY m.game_id""", (username.lower(), WINNING_WP)).fetchall()
    if not rows:
        return
    with db.transaction() as tx:
        for r in rows:
            m = tx.execute("SELECT fen_before, wp_before FROM moves WHERE game_id=? AND ply=?",
                           (r["game_id"], r["ply"])).fetchone()
            tx.execute("""INSERT OR IGNORE INTO conversions(game_id, ply, fen, wp, created_at, due)
                          VALUES(?,?,?,?,?,?)""", (r["game_id"], r["ply"], m["fen_before"], m["wp_before"],
                                                    time.time(), time.time()))


def counts(username: str) -> dict:
    refresh(username)
    conn = db.connect()
    r = conn.execute(
        """SELECT COUNT(*) total, SUM(c.due <= ?) due, SUM(c.wins > 0) won FROM conversions c
           JOIN games g ON g.id = c.game_id WHERE g.username=?""", (time.time(), username.lower())).fetchone()
    return {"total": r["total"] or 0, "due": r["due"] or 0, "won": r["won"] or 0}


def listing(username: str) -> list[dict]:
    refresh(username)
    rows = db.connect().execute(
        """SELECT c.*, g.opp_name, g.opp_rating, g.end_time, g.time_class, g.time_control, g.result, g.my_code,
                  g.my_color FROM conversions c JOIN games g ON g.id = c.game_id WHERE g.username=?
           ORDER BY (c.due > ?), g.end_time DESC""", (username.lower(), time.time())).fetchall()
    return [dict(r) for r in rows]


def _eval_for(board: chess.Board, color: chess.Color) -> int:
    info = shared.analyse(board, ENGINE_NODES // 2)[0]
    return score_cp(info["score"], color)[0]


def _check(board: chess.Board, color: chess.Color, user_moves: int) -> tuple[str, str]:
    if board.is_checkmate():
        return ("success", "Échec et mat, partie gagnée !") if board.turn != color else ("fail", "Tu t'es fait mater.")
    if board.is_stalemate():
        return "fail", "Pat ! La partie gagnée finit en nulle."
    if board.is_insufficient_material() or board.can_claim_draw():
        return "fail", "Nulle : l'avantage s'est envolé."
    ev = _eval_for(board, color)
    if ev >= WON_CP:
        return "success", "Avantage décisif atteint : cette fois, la partie est gagnée."
    if ev < LOST_CP:
        return "fail", "L'avantage s'est envolé : regarde ce que Stockfish menaçait."
    if user_moves >= LIMIT:
        return "fail", f"Toujours pas gagné après {LIMIT} coups : il faut simplifier et avancer plus vite."
    return "continue", ""


def start(cid: int) -> dict:
    c = db.connect().execute("SELECT c.*, g.my_color FROM conversions c JOIN games g ON g.id=c.game_id WHERE c.id=?",
                             (cid,)).fetchone()
    return {"fen": c["fen"], "color": c["my_color"], "limit": LIMIT}


def step(cid: int, fen: str, uci: str, user_moves: int) -> dict:
    c = db.connect().execute("SELECT c.*, g.my_color FROM conversions c JOIN games g ON g.id=c.game_id WHERE c.id=?",
                             (cid,)).fetchone()
    color = chess.WHITE if c["my_color"] == "w" else chess.BLACK
    board = chess.Board(fen)
    mv = chess.Move.from_uci(uci)
    if not board.is_legal(mv):
        return {"error": "coup illégal"}
    san = board.san(mv)
    board.push(mv)
    user_moves += 1
    status, msg = _check(board, color, user_moves)
    reply = None
    if status == "continue":
        rmv = shared.play(board, ENGINE_NODES)
        reply = {"uci": rmv.uci(), "san": board.san(rmv)}
        board.push(rmv)
        status, msg = _check(board, color, user_moves)
    if status != "continue":
        ok = status == "success"
        now = time.time()
        # Réussie : on la revoit dans 3 semaines pour s'assurer que c'est acquis. Ratée : dès demain.
        due = now + (21 if ok else 1) * DAY
        with db.transaction() as tx:
            tx.execute("""UPDATE conversions SET tries=tries+1, wins=wins+?, last_ok=?, due=? WHERE id=?""",
                       (int(ok), int(ok), due, cid))
        db.bump_activity("conversions")
    return {"fen": board.fen(), "san": san, "reply": reply, "status": status, "message": msg,
            "user_moves": user_moves, "limit": LIMIT}
