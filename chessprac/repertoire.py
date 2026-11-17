"""Mon arbre d'ouvertures (tiré de mes parties), mon répertoire choisi et son entraînement."""
import random
import threading
import time

import chess

from . import db
from .engine import score_cp, shared, wp_for
from .exercises import schedule

MAX_PLY = 24          # profondeur de l'arbre : 12 coups
RECENT_DAYS = 180     # pour remplir le répertoire, ce que je joue ces derniers mois compte d'abord
LEAK_DROP = 8         # un coup d'ouverture qui perd en moyenne ça (points de % de gain) est une fuite
_cache: dict = {}
_cache_lock = threading.Lock()


def key_of(board: chess.Board) -> str:
    return board.epd()


def _turn_is_mine(board: chess.Board, color: str) -> bool:
    return (board.turn == chess.WHITE) == (color == "w")


def fen_key(fen: str) -> str:
    """Même clé que board.epd(), sans recréer d'échiquier (les FEN stockées ont déjà la prise en passant « légale »)."""
    return " ".join(fen.split()[:4])


def tree(username: str, color: str) -> dict:
    conn = db.connect()
    sig = conn.execute("""SELECT COUNT(*) n, SUM(analyzed=1) a FROM games WHERE username=? AND my_color=?""",
                       (username.lower(), color)).fetchone()
    with _cache_lock:
        for c, (built_at, nodes) in _cache.items():
            # Pendant l'analyse de fond, on ne reconstruit pas l'arbre à chaque partie : au plus toutes les 3 minutes.
            if c[:3] == (username.lower(), color, sig["n"]) and (c[3] == sig["a"] or time.time() - built_at < 180):
                return nodes
    ck = (username.lower(), color, sig["n"], sig["a"])
    nodes: dict[str, dict] = {}
    rows = conn.execute(
        """SELECT m.game_id, m.ply, m.uci, m.san, m.fen_before, m."drop", m.cp_before, m.best_uci, g.result, g.end_time
           FROM moves m JOIN games g ON g.id=m.game_id
           WHERE g.username=? AND g.my_color=? AND m.ply<=? ORDER BY m.game_id, m.ply""",
        (username.lower(), color, MAX_PLY)).fetchall()
    score_of = {"win": 1.0, "draw": 0.5, "loss": 0.0}
    recent_since = time.time() - RECENT_DAYS * 86400
    for i, r in enumerate(rows):
        k = fen_key(r["fen_before"])
        node = nodes.get(k)
        if node is None:
            node = nodes[k] = {"n": 0, "score": 0.0, "moves": {}, "cp": None, "best": None, "fen": r["fen_before"]}
        node["n"] += 1
        node["score"] += score_of[r["result"]]
        if r["cp_before"] is not None and node["cp"] is None:
            node["cp"], node["best"] = r["cp_before"], r["best_uci"]
        mv = node["moves"].get(r["uci"])
        if mv is None:
            nxt = rows[i + 1] if i + 1 < len(rows) else None
            if nxt is not None and nxt["game_id"] == r["game_id"] and nxt["ply"] == r["ply"] + 1:
                child = fen_key(nxt["fen_before"])
            else:
                board = chess.Board(r["fen_before"])
                board.push(chess.Move.from_uci(r["uci"]))
                child = key_of(board)
            mv = node["moves"][r["uci"]] = {"uci": r["uci"], "san": r["san"], "n": 0, "score": 0.0, "drop_sum": 0.0,
                                            "drop_n": 0, "child": child, "recent": 0}
        mv["n"] += 1
        if (r["end_time"] or 0) >= recent_since:
            mv["recent"] += 1
        mv["score"] += score_of[r["result"]]
        if r["drop"] is not None:
            mv["drop_sum"] += r["drop"]
            mv["drop_n"] += 1
    with _cache_lock:
        for old in [c for c in _cache if c[:2] == ck[:2]]:
            del _cache[old]
        _cache[ck] = (time.time(), nodes)
    return nodes


def _mv_json(mv: dict) -> dict:
    return {"uci": mv["uci"], "san": mv["san"], "n": mv["n"], "score": round(100 * mv["score"] / mv["n"]),
            "drop": round(mv["drop_sum"] / mv["drop_n"], 1) if mv["drop_n"] else None}


def engine_eval(board: chess.Board, nodes: int = 600000) -> dict:
    """Évaluation d'une position (gardée en cache) : cp vus par les Blancs, meilleur coup, ligne."""
    conn = db.connect()
    k = key_of(board)
    row = conn.execute("SELECT data FROM pos_cache WHERE key=? AND nodes>=?", (k, nodes)).fetchone()
    import json
    if row:
        return json.loads(row["data"])
    if board.is_game_over():
        return {"cp": 0, "mate": None, "lines": []}
    infos = shared.analyse(board, nodes, multipv=3)
    lines = []
    for info in infos:
        pv = info.get("pv") or []
        if not pv:
            continue
        cp, mate = score_cp(info["score"], chess.WHITE)
        b = board.copy()
        sans = []
        for m in pv[:10]:
            sans.append(b.san(m))
            b.push(m)
        lines.append({"cp": cp, "mate": mate, "uci": [m.uci() for m in pv[:10]], "san": sans})
    data = {"cp": lines[0]["cp"] if lines else 0, "mate": lines[0]["mate"] if lines else None, "lines": lines}
    conn.execute("INSERT OR REPLACE INTO pos_cache(key, nodes, data) VALUES(?,?,?)", (k, nodes, json.dumps(data)))
    return data


def node_info(username: str, color: str, fen: str, with_engine: bool = True) -> dict:
    board = chess.Board(fen)
    k = key_of(board)
    t = tree(username, color)
    node = t.get(k)
    conn = db.connect()
    rep = conn.execute("SELECT uci FROM rep_moves WHERE color=? AND key=?", (color, k)).fetchone()
    extra = [r["uci"] for r in conn.execute("SELECT uci FROM rep_opp WHERE color=? AND key=?", (color, k))]
    mine = _turn_is_mine(board, color)
    moves = []
    if node:
        moves = sorted((_mv_json(m) for m in node["moves"].values()), key=lambda m: -m["n"])
    for u in extra:
        if not any(m["uci"] == u for m in moves):
            mv = chess.Move.from_uci(u)
            if board.is_legal(mv):
                moves.append({"uci": u, "san": board.san(mv), "n": 0, "score": None, "drop": None, "added": True})
    out = {
        "key": k, "fen": fen, "mine": mine, "n": node["n"] if node else 0,
        "score": round(100 * node["score"] / node["n"]) if node and node["n"] else None,
        "moves": moves, "rep": rep["uci"] if rep else None,
        "rep_san": board.san(chess.Move.from_uci(rep["uci"])) if rep and board.is_legal(chess.Move.from_uci(rep["uci"])) else None,
    }
    if with_engine:
        ev = engine_eval(board)
        out["engine"] = ev
        if ev["lines"]:
            best_wp = wp_for(ev["lines"][0]["cp"], board.turn)
            for m in moves:
                for line in ev["lines"]:
                    if line["uci"][0] == m["uci"]:
                        m["engine_drop"] = round(best_wp - wp_for(line["cp"], board.turn), 1)
    return out


def set_move(color: str, fen: str, uci: str | None) -> None:
    board = chess.Board(fen)
    k = key_of(board)
    conn = db.connect()
    if _turn_is_mine(board, color):
        if uci:
            conn.execute("INSERT OR REPLACE INTO rep_moves(color, key, uci) VALUES(?,?,?)", (color, k, uci))
        else:
            conn.execute("DELETE FROM rep_moves WHERE color=? AND key=?", (color, k))
            conn.execute("DELETE FROM rep_cards WHERE color=? AND key=?", (color, k))
    elif uci:
        conn.execute("INSERT OR IGNORE INTO rep_opp(color, key, uci) VALUES(?,?,?)", (color, k, uci))


def leaks(username: str, color: str) -> list[dict]:
    """Les coups d'ouverture que je joue souvent et qui me coûtent, du plus coûteux au moins coûteux."""
    t = tree(username, color)
    out = []
    for k, node in t.items():
        board = chess.Board(node["fen"])
        if not _turn_is_mine(board, color):
            continue
        for mv in node["moves"].values():
            if mv["n"] < 2 or not mv["drop_n"]:
                continue
            drop = mv["drop_sum"] / mv["drop_n"]
            if drop < LEAK_DROP:
                continue
            best_san = None
            if node["best"]:
                try:
                    best_san = board.san(chess.Move.from_uci(node["best"]))
                except ValueError:
                    pass
            out.append({"fen": node["fen"], "key": k, "uci": mv["uci"], "san": mv["san"], "n": mv["n"],
                        "score": round(100 * mv["score"] / mv["n"]), "drop": round(drop, 1),
                        "best_uci": node["best"], "best_san": best_san, "line": _line_to(t, k, color),
                        "cost": round(mv["n"] * drop, 1)})
    out.sort(key=lambda x: -x["cost"])
    return out[:40]


def _line_to(t: dict, key: str, color: str) -> str:
    """La suite de coups la plus jouée qui mène à cette position (pour l'afficher)."""
    board = chess.Board()
    parents = {}
    queue = [key_of(board)]
    seen = {queue[0]}
    while queue:
        k = queue.pop(0)
        if k == key:
            break
        node = t.get(k)
        if not node:
            continue
        for mv in sorted(node["moves"].values(), key=lambda m: -m["n"]):
            if mv["child"] not in seen:
                seen.add(mv["child"])
                parents[mv["child"]] = (k, mv)
                queue.append(mv["child"])
    path = []
    k = key
    while k in parents:
        k, mv = parents[k]
        path.append(mv)
    path.reverse()
    b = chess.Board()
    parts = []
    for mv in path:
        prefix = f"{b.fullmove_number}." if b.turn == chess.WHITE else ("" if parts else f"{b.fullmove_number}...")
        parts.append(f"{prefix}{mv['san']}" if prefix else mv["san"])
        b.push(chess.Move.from_uci(mv["uci"]))
    return " ".join(parts)


def auto_build(username: str, color: str) -> int:
    """Construit le répertoire là où il manque : mon coup habituel s'il tient la route, sinon celui de Stockfish."""
    t = tree(username, color)
    conn = db.connect()
    have = {r["key"]: r["uci"] for r in conn.execute("SELECT key, uci FROM rep_moves WHERE color=?", (color,))}
    added = 0
    stack = [(chess.Board(), 0)]
    seen = set()
    while stack:
        board, depth = stack.pop()
        k = key_of(board)
        if k in seen or depth > MAX_PLY:
            continue
        seen.add(k)
        node = t.get(k)
        if _turn_is_mine(board, color):
            choice = have.get(k)
            if choice is None:
                if not node or not node["moves"] or node["n"] < 2:
                    continue
                top = max(node["moves"].values(), key=lambda m: (m["recent"], m["n"]))
                drop = top["drop_sum"] / top["drop_n"] if top["drop_n"] else 0
                if drop < LEAK_DROP or not node["best"]:
                    choice = top["uci"]
                else:
                    choice = node["best"]
                conn.execute("INSERT OR IGNORE INTO rep_moves(color, key, uci) VALUES(?,?,?)", (color, k, choice))
                added += 1
            b = board.copy()
            b.push(chess.Move.from_uci(choice))
            stack.append((b, depth + 1))
        else:
            if not node:
                continue
            for mv in node["moves"].values():
                if mv["n"] >= 2:
                    b = board.copy()
                    b.push(chess.Move.from_uci(mv["uci"]))
                    stack.append((b, depth + 1))
    return added


# ---------------------------------------------------------------- entraînement des lignes

def _rep(color: str) -> dict:
    return {r["key"]: r["uci"] for r in db.connect().execute("SELECT key, uci FROM rep_moves WHERE color=?", (color,))}


def _cards(color: str) -> dict:
    return {r["key"]: dict(r) for r in db.connect().execute("SELECT * FROM rep_cards WHERE color=?", (color,))}


def _opp_moves(t, conn, color, board, k):
    node = t.get(k)
    cands = {}
    if node:
        for mv in node["moves"].values():
            cands[mv["uci"]] = mv["n"]
    for r in conn.execute("SELECT uci FROM rep_opp WHERE color=? AND key=?", (color, k)):
        cands.setdefault(r["uci"], 1)
    return {u: n for u, n in cands.items() if board.is_legal(chess.Move.from_uci(u))}


def reachable(username: str, color: str) -> list[str]:
    """Les positions de mon répertoire où c'est à moi de jouer, accessibles depuis le début."""
    t = tree(username, color)
    conn = db.connect()
    rep = _rep(color)
    out, seen = [], set()
    stack = [chess.Board()]
    while stack:
        board = stack.pop()
        k = key_of(board)
        if k in seen or board.ply() > MAX_PLY + 8:
            continue
        seen.add(k)
        if _turn_is_mine(board, color):
            u = rep.get(k)
            if not u:
                continue
            out.append(k)
            b = board.copy()
            b.push(chess.Move.from_uci(u))
            stack.append(b)
        else:
            for u in _opp_moves(t, conn, color, board, k):
                b = board.copy()
                b.push(chess.Move.from_uci(u))
                if rep.get(key_of(b)):
                    stack.append(b)
    return out


def drill_counts(username: str, color: str) -> dict:
    keys = reachable(username, color)
    cards = _cards(color)
    now = time.time()
    due = sum(1 for k in keys if k not in cards or (cards[k]["due"] or 0) <= now)
    learned = sum(1 for k in keys if k in cards and cards[k]["box"] >= 3)
    return {"positions": len(keys), "due": due, "learned": learned}


def drill_line(username: str, color: str) -> dict:
    """Une ligne à rejouer : l'adversaire joue ses coups habituels, en visant les positions à revoir."""
    t = tree(username, color)
    conn = db.connect()
    rep = _rep(color)
    cards = _cards(color)
    now = time.time()
    keys = set(reachable(username, color))
    due = {k for k in keys if k not in cards or (cards[k]["due"] or 0) <= now}

    memo: dict[str, int] = {}

    def due_below(board, depth=0) -> int:
        k = key_of(board)
        if k in memo:
            return memo[k]
        if depth > 30:
            return 0
        memo[k] = 0
        total = 0
        if _turn_is_mine(board, color):
            u = rep.get(k)
            if u:
                total += 1 if k in due else 0
                b = board.copy()
                b.push(chess.Move.from_uci(u))
                total += due_below(b, depth + 1)
        else:
            for u in _opp_moves(t, conn, color, board, k):
                b = board.copy()
                b.push(chess.Move.from_uci(u))
                total += due_below(b, depth + 1)
        memo[k] = total
        return total

    board = chess.Board()
    steps = []
    while board.ply() < MAX_PLY + 8:
        k = key_of(board)
        if _turn_is_mine(board, color):
            u = rep.get(k)
            if not u:
                break
            mv = chess.Move.from_uci(u)
            steps.append({"fen": board.fen(), "uci": u, "san": board.san(mv), "mine": True, "key": k,
                          "due": k in due})
        else:
            cands = _opp_moves(t, conn, color, board, k)
            weighted = []
            for u, n in cands.items():
                b = board.copy()
                b.push(chess.Move.from_uci(u))
                if not rep.get(key_of(b)):
                    continue
                d = due_below(b)
                weighted.append((u, n * (1 + 4 * d) if d else n * 0.25))
            if not weighted:
                break
            total = sum(w for _, w in weighted)
            pick = random.uniform(0, total)
            u = weighted[-1][0]
            for cand, w in weighted:
                pick -= w
                if pick <= 0:
                    u = cand
                    break
            mv = chess.Move.from_uci(u)
            steps.append({"fen": board.fen(), "uci": u, "san": board.san(mv), "mine": False, "key": k})
        board.push(mv)
    return {"color": color, "steps": steps}


def drill_result(color: str, key: str, ok: bool) -> None:
    conn = db.connect()
    card = conn.execute("SELECT * FROM rep_cards WHERE color=? AND key=?", (color, key)).fetchone()
    now = time.time()
    box = card["box"] if card else 0
    is_due = card is None or (card["due"] or 0) <= now
    if ok and not is_due:
        return  # déjà su et pas encore à revoir : on ne l'avance pas plus vite
    box, due = schedule(box, ok, now)
    conn.execute("""INSERT INTO rep_cards(color, key, box, due, reps, lapses) VALUES(?,?,?,?,1,?)
                    ON CONFLICT(color, key) DO UPDATE SET box=excluded.box, due=excluded.due, reps=reps+1,
                    lapses=lapses+excluded.lapses""", (color, key, box, due, 0 if ok else 1))
    db.bump_activity("drill_done")
    if ok:
        db.bump_activity("drill_ok")
