"""Ce que montre la revue d'une partie : les coups, leur analyse et leur type (comme sur chess.com).
Sert à l'interface locale et à la version en ligne."""
import chess

from . import book, db


def game_row(r) -> dict:
    d = dict(r)
    d.pop("pgn", None)
    return d


def _pv_san(fen: str, pv: str | None, n: int = 8) -> list[str]:
    if not pv:
        return []
    b = chess.Board(fen)
    out = []
    for u in pv.split()[:n]:
        m = chess.Move.from_uci(u)
        if not b.is_legal(m):
            break
        out.append(b.san(m))
        b.push(m)
    return out


def move_kind(p: dict, forced: bool, in_book: bool) -> str | None:
    """Le type affiché d'un coup (pas encore analysé : None)."""
    if forced:
        return "forced"
    if in_book:
        return "book"
    if p.get("special") in ("brilliant", "great"):
        return p["special"]
    if p.get("cls") is None:
        return None
    if p.get("missed") and p["cls"] != "blunder":
        return "miss"  # l'adversaire venait de se tromper et l'occasion est passée
    return p["cls"]


def payload(game_id: str) -> dict | None:
    """La partie et tous ses coups, prêts à afficher (sans les exercices, qui restent sur le PC)."""
    conn = db.connect()
    g = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if g is None:
        return None
    rows = conn.execute("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (game_id,)).fetchall()
    plies = []
    for r in rows:
        d = dict(r)
        d.pop("game_id", None)
        d["pv"] = d["pv"].split() if d["pv"] else []
        d["pv_san"] = _pv_san(r["fen_before"], r["pv"])
        plies.append(d)
    final = None
    if rows:
        b = chess.Board(rows[-1]["fen_before"])
        b.push(chess.Move.from_uci(rows[-1]["uci"]))
        final = b.fen()
    # Type de chaque coup, comme sur chess.com : forcé, théorie, brillant, grand coup, meilleur... gaffe.
    fens_after = [p["fen_before"] for p in plies[1:]] + ([final] if final else [])
    names = book.book_plies(fens_after, [p["drop"] for p in plies])
    for p, name in zip(plies, names):
        forced = chess.Board(p["fen_before"]).legal_moves.count() == 1
        p["book"] = name
        p["kind"] = move_kind(p, forced, name is not None)
    return {"game": game_row(g), "plies": plies, "final_fen": final, "exercises": [], "start_fen": chess.STARTING_FEN}
