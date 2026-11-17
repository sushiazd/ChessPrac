"""Transforme les erreurs de mes parties en exercices, et les fait revenir avec la répétition espacée."""
import io
import json
import time

import chess
import chess.engine
import chess.pgn

from . import config, db
from .analysis import MISTAKE, material_balance
from .engine import score_cp, win_pct

ACCEPT_MARGIN = 4      # un autre coup est accepté s'il garde presque autant de chances de gain que le meilleur
MIN_GAIN = 15          # l'erreur doit coûter au moins ça, vérifiée en profondeur
THREAT_GAIN = 25       # « menace » : si on passait son tour, l'adversaire gagnerait au moins ça
UNIQUE_GAP = 20        # pour prolonger la solution, le coup suivant doit être nettement le seul
DAY = 86400.0
INTERVALS = [0, 1, 3, 7, 16, 35, 80]  # jours, selon la boîte (0 = nouveau)


# ---------------------------------------------------------------- génération

def _lines(engine, board, nodes, multipv):
    infos = engine.analyse(board, chess.engine.Limit(nodes=nodes), multipv=multipv)
    out = []
    for info in infos:
        pv = info.get("pv") or []
        if not pv:
            continue
        cp, _ = score_cp(info["score"], board.turn)
        out.append({"move": pv[0], "pv": pv, "wp": win_pct(cp), "cp": cp, "mate": info["score"].pov(board.turn).mate()})
    return out


def _wp_after(engine, board, move, nodes):
    """Chances de gain du joueur qui joue move, après ce coup."""
    b = board.copy()
    b.push(move)
    if b.is_checkmate():
        return 100.0, None
    if b.is_game_over():
        return 50.0, None
    lines = _lines(engine, b, nodes, 1)
    if not lines:
        return 50.0, None
    return 100 - lines[0]["wp"], lines[0]


def _extend_solution(engine, board, first, nodes) -> list[str]:
    """La solution continue tant que chaque coup suivant est clairement le seul bon (vrai calcul tactique)."""
    line = [first]
    b = board.copy()
    b.push(first)
    for _ in range(2):
        if b.is_game_over():
            break
        reply = _lines(engine, b, nodes, 1)
        if not reply:
            break
        b.push(reply[0]["move"])
        if b.is_game_over():
            break
        mine = _lines(engine, b, nodes, 2)
        if not mine:
            break
        unique = len(mine) == 1 or mine[0]["wp"] - mine[1]["wp"] >= UNIQUE_GAP
        if not unique:
            b.pop()
            break
        line += [reply[0]["move"], mine[0]["move"]]
        b.push(mine[0]["move"])
    return [m.uci() for m in line]


def generate_for_game(engine: chess.engine.SimpleEngine, game_id: str, nodes: int) -> int:
    conn = db.connect()
    rows = conn.execute(
        """SELECT * FROM moves WHERE game_id=? AND mine=1 AND ("drop" >= ? OR missed=1) ORDER BY ply""",
        (game_id, MISTAKE)).fetchall()
    made = 0
    for r in rows:
        board = chess.Board(r["fen_before"])
        played = chess.Move.from_uci(r["uci"])
        lines = _lines(engine, board, nodes, 3)
        if not lines:
            continue
        best = lines[0]
        accepted = [l["move"] for l in lines if l["wp"] >= best["wp"] - ACCEPT_MARGIN]
        played_wp, opp_line = _wp_after(engine, board, played, nodes)
        gain = best["wp"] - played_wp
        tag = _tag(board, played, best, opp_line, bool(r["missed"]))
        threat = None
        if not r["missed"] and not board.is_check():
            threat = _threat(engine, board, best, opp_line, nodes)
            if threat:
                tag = "menace"
        with db.transaction() as tx:
            tx.execute("UPDATE moves SET tag=? WHERE game_id=? AND ply=?", (tag, game_id, r["ply"]))
        if played in accepted or gain < MIN_GAIN or len(accepted) >= 3:
            continue
        if best["wp"] < 12 or played_wp > 88:
            continue  # partie déjà jouée : chercher le meilleur coup n'apprend pas grand-chose
        solution = _extend_solution(engine, board, best["move"], nodes // 2)
        base = {
            "game_id": game_id, "ply": r["ply"], "played_san": r["san"], "best_san": board.san(best["move"]),
            "gain": round(gain, 1), "tag": tag,
        }
        if threat:
            kind, fen = "threat", threat["fen"]
            sol, acc = [threat["move"]], threat["accept"]
            followup = json.dumps({"fen": r["fen_before"], "solution": solution,
                                   "accept": [m.uci() for m in accepted]})
        else:
            kind, fen = ("punish" if r["missed"] else "best"), r["fen_before"]
            sol, acc, followup = solution, [m.uci() for m in accepted], None
        with db.transaction() as tx:
            cur = tx.execute(
                """INSERT OR IGNORE INTO exercises(kind, game_id, ply, fen, solution, accept, followup, played_san,
                   best_san, gain, tag, created_at, due) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (kind, game_id, r["ply"], fen, json.dumps(sol), json.dumps(acc), followup, base["played_san"],
                 base["best_san"], base["gain"], tag, time.time(), time.time()))
        made += cur.rowcount
    return made


def _tag(board, played, best, opp_line, missed) -> str:
    """Pourquoi l'erreur : mat, pièce perdue, occasion manquée, ou autre."""
    if missed:
        return "occasion"
    if best["mate"] is not None and best["mate"] > 0:
        return "mat-rate"
    if opp_line and opp_line["mate"] is not None and opp_line["mate"] > 0:
        return "mat"
    if opp_line:
        me = board.turn
        b = board.copy()
        b.push(played)
        start = material_balance(board, me)
        for m in opp_line["pv"][:3]:
            if not b.is_legal(m):
                break
            b.push(m)
        if start - material_balance(b, me) >= 2:
            return "piece"
    return "autre"


def _threat(engine, board, best, opp_line, nodes):
    """Si je passais mon tour, que jouerait l'adversaire ? Exercice seulement si c'est ce qui m'a puni."""
    nb = board.copy()
    nb.push(chess.Move.null())
    nb = chess.Board(nb.fen())  # sans historique : un « coup nul » ne s'envoie pas à Stockfish
    if not nb.is_valid() or nb.is_game_over():
        return None
    lines = _lines(engine, nb, nodes // 2, 2)
    if not lines or not opp_line:
        return None
    t = lines[0]
    gain = t["wp"] - (100 - best["wp"])
    if gain < THREAT_GAIN:
        return None
    punished = opp_line["move"] == t["move"] or opp_line["move"].to_square == t["move"].to_square
    if not punished:
        return None
    return {"fen": nb.fen(), "move": t["move"].uci(),
            "accept": [l["move"].uci() for l in lines if l["wp"] >= t["wp"] - ACCEPT_MARGIN]}


# ---------------------------------------------------------------- pièges d'ouverture (trapfinder)

def import_traps(username: str) -> int:
    """Les pièges repérés par trapfinder deviennent des exercices : l'adversaire se trompe, à toi de punir."""
    conn = db.connect()
    made = 0
    for path in sorted(config.TRAPS_DIR.glob("*.pgn")):
        text = path.read_text(encoding="utf-8", errors="replace")
        stream = io.StringIO(text)
        idx = 0
        while True:
            game = chess.pgn.read_game(stream)
            if game is None:
                break
            idx += 1
            moves = list(game.mainline_moves())
            if len(moves) < 2:
                continue
            board = game.board()
            for m in moves[:-1]:
                board.push(m)
            refutation = moves[-1]
            node = game
            comment = ""
            for n in game.mainline():
                if n.move == moves[-2]:
                    comment = n.comment.strip()
            note = comment.split(";")[0].strip() if comment else ""
            err_board = board.copy()
            err_board.pop()
            err_san = err_board.san(moves[-2])
            gid = f"piege:{path.stem}:{idx}"
            cur = conn.execute(
                """INSERT OR IGNORE INTO exercises(kind, game_id, ply, fen, solution, accept, played_san, best_san,
                   gain, tag, note, created_at, due) VALUES('trap',?,?,?,?,?,?,?,?,?,?,?,?)""",
                (gid, len(moves) - 1, board.fen(), json.dumps([refutation.uci()]), json.dumps([refutation.uci()]),
                 err_san, board.san(refutation), None, "piege", note, time.time(), time.time()))
            made += cur.rowcount
    return made


# ---------------------------------------------------------------- répétition espacée

def schedule(box: int, ok: bool, now: float, slow: bool = False) -> tuple[int, float]:
    if ok and slow:
        # Trouvé, mais trop lentement : en blitz ça n'aurait pas suffi. La boîte n'avance pas, il revient plus tôt.
        box = max(box, 1)
        return box, now + max(1, INTERVALS[box] // 2) * DAY
    if ok:
        box = min(box + 1, len(INTERVALS) - 1)
        return box, now + INTERVALS[box] * DAY
    return 1, now + INTERVALS[1] * DAY


def target_secs(ex) -> int:
    """Temps visé pour une révision : le motif doit sauter aux yeux, pas se calculer péniblement."""
    sol = json.loads(ex["solution"]) if isinstance(ex["solution"], str) else ex["solution"]
    secs = 15 + 10 * (len(sol) // 2)
    if ex["kind"] == "threat":
        secs += 15  # deux temps : la menace, puis la parade
    return secs


def answer(ex_id: int, ok: bool, first_try: bool = True, secs: float | None = None) -> dict:
    conn = db.connect()
    ex = conn.execute("SELECT * FROM exercises WHERE id=?", (ex_id,)).fetchone()
    if ex is None:
        return {}
    now = time.time()
    target = target_secs(ex)
    # Le chrono ne compte qu'en révision : la première fois, on prend le temps de comprendre.
    slow = bool(ok and ex["reps"] > 0 and secs is not None and secs > target)
    grade = "fail" if not ok else "slow" if slow else "ok"
    with db.transaction() as tx:
        tx.execute("INSERT INTO attempts(exercise_id, ts, ok, secs) VALUES(?,?,?,?)", (ex_id, now, int(ok), secs))
        if first_try:  # une 2e tentative dans la même séance ne change pas le planning
            box, due = schedule(ex["box"], ok, now, slow)
            tx.execute("""UPDATE exercises SET box=?, due=?, reps=reps+1, lapses=lapses+?, last_ok=?, last_seen=?,
                          last_secs=? WHERE id=?""", (box, due, 0 if ok else 1, int(ok), now, secs, ex_id))
    if first_try:
        db.bump_activity("ex_done")
        if ok and not slow:
            db.bump_activity("ex_ok")
    out = dict(conn.execute("SELECT box, due FROM exercises WHERE id=?", (ex_id,)).fetchone())
    return {**out, "grade": grade, "target": target}


def weakness_weights(username: str, days: int = 90) -> dict[str, float]:
    """Part de chaque cause dans mes erreurs récentes : la cause la plus fréquente est travaillée en premier."""
    rows = db.connect().execute(
        """SELECT m.tag, COUNT(*) n FROM moves m JOIN games g ON g.id = m.game_id
           WHERE g.username=? AND g.end_time >= ? AND m.mine=1 AND m."drop" >= ? AND m.tag IS NOT NULL
           GROUP BY m.tag""", (username.lower(), int(time.time() - days * DAY), MISTAKE)).fetchall()
    total = sum(r["n"] for r in rows) or 1
    # « autre » n'est pas un motif qu'on peut travailler : il ne passe jamais devant les causes identifiées.
    return {r["tag"]: r["n"] / total for r in rows if r["tag"] != "autre"}


def new_done_today() -> int:
    start = _day_start()
    row = db.connect().execute(
        """SELECT COUNT(DISTINCT exercise_id) AS n FROM attempts a WHERE ts >= ?
           AND NOT EXISTS (SELECT 1 FROM attempts b WHERE b.exercise_id=a.exercise_id AND b.ts < ?)""",
        (start, start)).fetchone()
    return row["n"]


def _day_start() -> float:
    t = time.localtime(time.time() - 4 * 3600)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 4, 0, 0, 0, 0, -1))


def _mine_filter(username: str) -> tuple[str, list]:
    return ("(e.kind='trap' OR e.game_id IN (SELECT id FROM games WHERE username=?))", [username.lower()])


def counts(username: str) -> dict:
    conn = db.connect()
    flt, args = _mine_filter(username)
    now = time.time()
    due = conn.execute(f"SELECT COUNT(*) n FROM exercises e WHERE {flt} AND suspended=0 AND reps>0 AND due<=?",
                       args + [now]).fetchone()["n"]
    new = conn.execute(f"SELECT COUNT(*) n FROM exercises e WHERE {flt} AND suspended=0 AND reps=0",
                       args).fetchone()["n"]
    total = conn.execute(f"SELECT COUNT(*) n FROM exercises e WHERE {flt}", args).fetchone()["n"]
    new_left = max(0, db.get_int("new_per_day") - new_done_today())
    return {"due": due, "new": new, "new_today": min(new, new_left), "total": total}


def queue(username: str, game_id: str | None = None, kind: str | None = None, limit: int = 40) -> list[dict]:
    conn = db.connect()
    now = time.time()
    if game_id:
        rows = conn.execute("SELECT * FROM exercises WHERE game_id=? AND suspended=0 ORDER BY ply", (game_id,)).fetchall()
        return [to_json(r) for r in rows]
    flt, args = _mine_filter(username)
    kind_sql, kind_args = ("", []) if not kind else (" AND e.kind=?", [kind])
    due = conn.execute(
        f"""SELECT e.* FROM exercises e WHERE {flt} AND suspended=0 AND reps>0 AND due<=? {kind_sql}
            ORDER BY due LIMIT ?""", args + [now] + kind_args + [limit]).fetchall()
    n_new = max(0, min(limit - len(due), db.get_int("new_per_day") - new_done_today()))
    # Nouveaux : les erreurs des 2 derniers mois d'abord, et parmi elles la cause d'erreur la plus fréquente chez
    # moi en tête (si je rate surtout des menaces, je fais surtout des menaces). Les pièges d'ouverture en dernier.
    weights = weakness_weights(username)
    tag_case = "CASE e.tag " + " ".join(f"WHEN '{t}' THEN {w:.4f}" for t, w in weights.items()
                                        if t.replace("-", "").isalpha()) + " ELSE 0 END" if weights else "NULL"
    new = conn.execute(
        f"""SELECT e.* FROM exercises e LEFT JOIN games g ON g.id=e.game_id
            WHERE {flt} AND e.suspended=0 AND e.reps=0 {kind_sql}
            ORDER BY (e.kind='trap'), (COALESCE(g.end_time, 0) >= ?) DESC, {tag_case} DESC, g.end_time DESC,
                     e.gain DESC
            LIMIT ?""", args + kind_args + [int(now - 60 * DAY), n_new]).fetchall()
    # Mélange simple : on alterne révisions et nouveautés pour ne pas finir la séance sur les plus dures.
    out, i, j = [], 0, 0
    while i < len(due) or j < len(new):
        if i < len(due):
            out.append(due[i]); i += 1
        if j < len(new):
            out.append(new[j]); j += 1
    return [to_json(r) for r in out]


def to_json(r) -> dict:
    d = dict(r)
    d["target"] = target_secs(r)
    for k in ("solution", "accept"):
        d[k] = json.loads(d[k]) if d.get(k) else []
    d["followup"] = json.loads(d["followup"]) if d.get("followup") else None
    if d["game_id"] and not d["game_id"].startswith("piege:"):
        g = db.connect().execute("SELECT opp_name, end_time, time_class, my_color, opening FROM games WHERE id=?",
                                 (d["game_id"],)).fetchone()
        d["game"] = dict(g) if g else None
        prev = db.connect().execute("SELECT uci FROM moves WHERE game_id=? AND ply=?",
                                    (d["game_id"], d["ply"] - 1)).fetchone()
        # Pour une menace, le dernier coup affiché est celui que l'adversaire vient de jouer (avant le mien).
        d["last_uci"] = prev["uci"] if prev else None
    else:
        d["game"] = None
        d["last_uci"] = None
    return d


def bank(username: str, kind: str | None = None, limit: int = 300) -> list[dict]:
    conn = db.connect()
    flt, args = _mine_filter(username)
    kind_sql, kind_args = ("", []) if not kind else (" AND e.kind=?", [kind])
    rows = conn.execute(
        f"""SELECT e.id, e.kind, e.game_id, e.ply, e.fen, e.played_san, e.best_san, e.gain, e.tag, e.box, e.due, e.reps,
                   e.lapses, e.last_ok, e.suspended, e.note, g.end_time, g.opp_name, g.time_class
            FROM exercises e LEFT JOIN games g ON g.id=e.game_id WHERE {flt} {kind_sql}
            ORDER BY e.suspended, g.end_time DESC LIMIT ?""", args + kind_args + [limit]).fetchall()
    return [dict(r) for r in rows]
