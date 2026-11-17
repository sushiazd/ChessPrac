"""Finales de base à jouer contre Stockfish, avec un objectif clair (mater, promouvoir, tenir la nulle)."""
import time

import chess

from . import db
from .engine import score_cp, shared

ENGINE_NODES = 400000

ENDGAMES = [
    {"id": "kqk", "title": "Mat roi + dame", "goal": "mate", "limit": 15, "color": "w",
     "fen": "8/8/8/4k3/8/8/8/3QK3 w - - 0 1",
     "tip": "Avec la dame, fais un « saut de cavalier » par rapport au roi adverse pour le repousser vers un bord, "
            "puis amène ton roi. Attention au pat : laisse-lui toujours une case tant que ton roi n'est pas là."},
    {"id": "krrk", "title": "L'escalier aux deux tours", "goal": "mate", "limit": 12, "color": "w",
     "fen": "8/8/8/4k3/8/8/8/R3K2R w - - 0 1",
     "tip": "Une tour coupe une rangée, l'autre donne échec sur la suivante, et on recommence. Si le roi s'approche "
            "d'une tour, envoie-la à l'autre bout de la rangée."},
    {"id": "krk", "title": "Mat roi + tour", "goal": "mate", "limit": 30, "color": "w",
     "fen": "8/8/8/4k3/8/8/8/R3K3 w - - 0 1",
     "tip": "La tour coupe le roi adverse dans une boîte, que tu rétrécis. Ton roi vient en opposition, puis la tour "
            "donne échec. Coup d'attente de la tour quand il le faut."},
    {"id": "kpk6", "title": "Roi devant le pion (6e rangée)", "goal": "promote", "limit": 20, "color": "w",
     "fen": "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
     "tip": "Roi sur la 6e rangée devant son pion : c'est toujours gagnant. Garde l'opposition et ne pousse le pion "
            "que lorsque ton roi contrôle la case devant lui."},
    {"id": "opp-win", "title": "L'opposition, en attaque", "goal": "promote", "limit": 25, "color": "w",
     "fen": "8/8/8/4k3/8/4K3/4P3/8 b - - 0 1",
     "tip": "Les Noirs doivent jouer et céder le passage. Avance ton roi avant le pion : le pion suit, le roi ouvre."},
    {"id": "opp-draw", "title": "L'opposition, en défense", "goal": "draw", "limit": 20, "color": "b",
     "fen": "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1",
     "tip": "Reste face au roi blanc (opposition). Quand le pion arrive, recule tout droit devant lui, "
            "jamais sur le côté."},
    {"id": "kpk-def", "title": "Roi + pion : tenir la nulle", "goal": "draw", "limit": 20, "color": "b",
     "fen": "8/8/8/8/4k3/8/4P3/4K3 b - - 0 1",
     "tip": "Bloque le pion avec ton roi. Quand tu dois reculer, reste sur la colonne du pion pour reprendre "
            "l'opposition à la fin."},
    {"id": "lucena", "title": "Position de Lucena (le pont)", "goal": "promote", "limit": 30, "color": "w",
     "fen": "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
     "tip": "D'abord coupe le roi adverse avec ta tour, puis monte-la en 4e rangée (Td4), sors ton roi et construis "
            "le pont pour bloquer les échecs de côté."},
    {"id": "philidor", "title": "Position de Philidor (défense)", "goal": "draw", "limit": 25, "color": "b",
     "fen": "3k4/R7/7r/3PK3/8/8/8/8 b - - 0 1",
     "tip": "Garde ta tour sur la 6e rangée pour empêcher le roi blanc d'avancer. Dès que le pion avance en 6e, "
            "passe derrière et donne des échecs par l'arrière."},
    {"id": "kqkp", "title": "Dame contre pion en 7e", "goal": "win_material", "limit": 25, "color": "w",
     "fen": "8/1K6/8/8/8/8/3pk3/7Q w - - 0 1",
     "tip": "Échecs et clouages pour forcer le roi noir devant son pion : chaque fois qu'il bloque la case de "
            "promotion, ton roi gagne un pas. Puis prends le pion."},
]
BY_ID = {e["id"]: e for e in ENDGAMES}


def listing() -> list[dict]:
    conn = db.connect()
    out = []
    for e in ENDGAMES:
        r = conn.execute("SELECT COUNT(*) n, SUM(ok) ok, MAX(ts) last FROM endgame_results WHERE id=?", (e["id"],)).fetchone()
        out.append({**e, "tries": r["n"], "wins": r["ok"] or 0, "last": r["last"]})
    return out


def _user_eval(board: chess.Board, color: chess.Color) -> int:
    info = shared.analyse(board, ENGINE_NODES // 2)[0]  # toujours une liste (une ligne par multipv)
    return score_cp(info["score"], color)[0]


def _check(e: dict, board: chess.Board, color: chess.Color, user_moves: int) -> tuple[str, str]:
    """('continue' | 'success' | 'fail', message)."""
    goal = e["goal"]
    if board.is_checkmate():
        if board.turn != color:
            return ("success", "Échec et mat !") if goal in ("mate", "promote", "win_material") else ("success", "Mat !")
        return "fail", "Tu t'es fait mater."
    if board.is_stalemate():
        return ("success", "Pat : nulle tenue !") if goal == "draw" else ("fail", "Pat ! La partie est nulle.")
    if board.is_insufficient_material() or board.can_claim_draw():
        return ("success", "Nulle tenue !") if goal == "draw" else ("fail", "La partie est nulle.")
    ev = _user_eval(board, color)
    if goal == "draw":
        if ev <= -400:
            return "fail", "La position est perdue : l'adversaire va gagner."
        if user_moves >= e["limit"]:
            return "success", f"Tu as tenu {e['limit']} coups : nulle !"
        return "continue", ""
    if ev < 300:
        return "fail", "Le gain s'est échappé : la position n'est plus gagnante."
    if goal == "promote" and any(p.piece_type == chess.QUEEN and p.color == color for p in board.piece_map().values()) \
            and ev >= 600:
        return "success", "Pion promu, la partie est gagnée !"
    if goal == "win_material":
        opp_pieces = [p for p in board.piece_map().values() if p.color != color and p.piece_type != chess.KING]
        if not opp_pieces:
            return "success", "Il ne reste que le roi adverse : gagné !"
    if user_moves >= e["limit"]:
        return "fail", f"Objectif non atteint en {e['limit']} coups."
    return "continue", ""


def start(eid: str) -> dict:
    e = BY_ID[eid]
    board = chess.Board(e["fen"])
    color = chess.WHITE if e["color"] == "w" else chess.BLACK
    reply = None
    if board.turn != color:
        mv = shared.play(board, ENGINE_NODES)
        reply = {"uci": mv.uci(), "san": board.san(mv)}
        board.push(mv)
    return {"fen": board.fen(), "reply": reply}


def step(eid: str, fen: str, uci: str, user_moves: int) -> dict:
    e = BY_ID[eid]
    color = chess.WHITE if e["color"] == "w" else chess.BLACK
    board = chess.Board(fen)
    mv = chess.Move.from_uci(uci)
    if not board.is_legal(mv):
        return {"error": "coup illégal"}
    san = board.san(mv)
    board.push(mv)
    user_moves += 1
    status, msg = _check(e, board, color, user_moves)
    reply = None
    if status == "continue":
        rmv = shared.play(board, ENGINE_NODES)
        reply = {"uci": rmv.uci(), "san": board.san(rmv)}
        board.push(rmv)
        status, msg = _check(e, board, color, user_moves)
    if status != "continue":
        db.connect().execute("INSERT INTO endgame_results(id, ts, ok) VALUES(?,?,?)",
                             (eid, time.time(), int(status == "success")))
        db.bump_activity("endgames")
    return {"fen": board.fen(), "san": san, "reply": reply, "status": status, "message": msg, "user_moves": user_moves}
