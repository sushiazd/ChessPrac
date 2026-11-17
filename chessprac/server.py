"""Petit serveur local (127.0.0.1 seulement) : l'interface web et son API JSON."""
import json
import logging
import mimetypes
import os
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import chess

from . import __version__, chesscom, config, db, endgames, exercises, explorer, repertoire, stats
from .engine import EngineMissing
from .worker import worker

log = logging.getLogger("chessprac")
ROUTES: dict[tuple[str, str], callable] = {}


def route(method: str, path: str):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


class ApiError(Exception):
    def __init__(self, msg: str, code: int = 400):
        super().__init__(msg)
        self.code = code


def username() -> str:
    u = db.get_setting("username")
    if not u:
        raise ApiError("Aucun compte chess.com configuré.", 409)
    return u.lower()


# ---------------------------------------------------------------- positions

def position_info(board: chess.Board) -> dict:
    status = None
    if board.is_checkmate():
        status = "checkmate"
    elif board.is_stalemate():
        status = "stalemate"
    elif board.is_insufficient_material():
        status = "insufficient"
    king = board.king(board.turn)
    return {"fen": board.fen(), "turn": "w" if board.turn == chess.WHITE else "b",
            "legal": [m.uci() for m in board.legal_moves],
            "check": chess.square_name(king) if board.is_check() and king is not None else None,
            "status": status}


@route("POST", "/api/position")
def api_position(q, body):
    return position_info(chess.Board(body["fen"]))


@route("POST", "/api/move")
def api_move(q, body):
    board = chess.Board(body["fen"])
    mv = chess.Move.from_uci(body["uci"])
    if not board.is_legal(mv):
        raise ApiError("Coup illégal")
    san = board.san(mv)
    board.push(mv)
    return {**position_info(board), "san": san, "uci": mv.uci()}


@route("POST", "/api/analyse")
def api_analyse(q, body):
    board = chess.Board(body["fen"])
    return repertoire.engine_eval(board, int(body.get("nodes") or 600000))


# ---------------------------------------------------------------- état, réglages

@route("GET", "/api/status")
def api_status(q, body):
    u = db.get_setting("username")
    conn = db.connect()
    counts = None
    if u:
        r = conn.execute("""SELECT COUNT(*) n, SUM(analyzed=1) a, SUM(analyzed IN (0,2)) todo FROM games WHERE username=?""",
                         (u.lower(),)).fetchone()
        counts = {"games": r["n"], "analyzed": r["a"] or 0, "todo": r["todo"] or 0}
    return {"version": __version__, "username": u, "display_name": db.get_setting("display_name") or u,
            "worker": worker.status, "counts": counts, "exercises": exercises.counts(u) if u else None,
            "engine": bool(config.stockfish_path())}


@route("GET", "/api/settings")
def api_settings(q, body):
    keys = ["username", "analysis_nodes", "deep_nodes", "new_per_day", "workers", "auto_sync_minutes"]
    out = {k: db.get_setting(k) for k in keys}
    out["has_lichess_token"] = bool(db.get_setting("lichess_token"))
    out["db_path"] = str(config.DB_PATH)
    out["cpu_count"] = os.cpu_count() or 0
    return out


@route("POST", "/api/settings")
def api_settings_set(q, body):
    if "username" in body:
        name = body["username"].strip()
        prof = chesscom.player_profile(name) if name else None
        if not prof:
            raise ApiError(f"Le compte « {name} » est introuvable sur chess.com.")
        db.set_setting("username", prof.get("username", name).lower())
        db.set_setting("display_name", prof.get("username", name))
        worker.kick()
    for k in ("analysis_nodes", "deep_nodes", "new_per_day", "workers", "auto_sync_minutes"):
        if k in body:
            db.set_setting(k, int(body[k]))
    if "lichess_token" in body:
        db.set_setting("lichess_token", body["lichess_token"].strip())
    return api_settings(q, body)


@route("POST", "/api/sync")
def api_sync(q, body):
    worker.kick()
    return {"ok": True}


# ---------------------------------------------------------------- aujourd'hui

def streak() -> int:
    rows = db.connect().execute(
        "SELECT day FROM activity WHERE ex_done + drill_done + reviews + endgames > 0 ORDER BY day DESC").fetchall()
    days = {r["day"] for r in rows}
    t = time.time() - 4 * 3600
    if time.strftime("%Y-%m-%d", time.localtime(t)) not in days:
        t -= 86400
    n = 0
    while time.strftime("%Y-%m-%d", time.localtime(t)) in days:
        n += 1
        t -= 86400
    return n


def game_row(r) -> dict:
    d = dict(r)
    d.pop("pgn", None)
    return d


@route("GET", "/api/today")
def api_today(q, body):
    u = username()
    conn = db.connect()
    cc = db.get_setting("cc_stats")
    act = conn.execute("SELECT * FROM activity WHERE day=?", (db.today(),)).fetchone()
    unreviewed = conn.execute(
        """SELECT * FROM games WHERE username=? AND analyzed=1 AND reviewed=0 ORDER BY end_time DESC LIMIT 1""",
        (u,)).fetchone()
    recent = conn.execute("SELECT * FROM games WHERE username=? ORDER BY end_time DESC LIMIT 8", (u,)).fetchall()
    return {
        "username": db.get_setting("display_name") or u,
        "ratings": json.loads(cc) if cc else None,
        "exercises": exercises.counts(u),
        "drill": {"w": repertoire.drill_counts(u, "w"), "b": repertoire.drill_counts(u, "b")},
        "activity": dict(act) if act else {},
        "streak": streak(),
        "unreviewed": game_row(unreviewed) if unreviewed else None,
        "recent": [game_row(r) for r in recent],
    }


# ---------------------------------------------------------------- parties

@route("GET", "/api/games")
def api_games(q, body):
    u = username()
    where, args = ["username=?"], [u]
    if q.get("tc"):
        where.append("time_class=?"); args.append(q["tc"])
    if q.get("result"):
        where.append("result=?"); args.append(q["result"])
    if q.get("color"):
        where.append("my_color=?"); args.append(q["color"])
    if q.get("q"):
        where.append("(opp_name LIKE ? OR opening LIKE ?)"); args += [f"%{q['q']}%"] * 2
    w = " AND ".join(where)
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) n FROM games WHERE {w}", args).fetchone()["n"]
    limit, offset = int(q.get("limit", 50)), int(q.get("offset", 0))
    rows = conn.execute(f"SELECT * FROM games WHERE {w} ORDER BY end_time DESC LIMIT ? OFFSET ?",
                        args + [limit, offset]).fetchall()
    return {"total": total, "games": [game_row(r) for r in rows]}


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


@route("GET", "/api/game")
def api_game(q, body):
    conn = db.connect()
    g = conn.execute("SELECT * FROM games WHERE id=?", (q["id"],)).fetchone()
    if g is None:
        raise ApiError("Partie introuvable", 404)
    rows = conn.execute("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (q["id"],)).fetchall()
    plies = []
    for r in rows:
        d = dict(r)
        d["pv"] = d["pv"].split() if d["pv"] else []
        d["pv_san"] = _pv_san(r["fen_before"], r["pv"])
        plies.append(d)
    final = None
    if rows:
        b = chess.Board(rows[-1]["fen_before"])
        b.push(chess.Move.from_uci(rows[-1]["uci"]))
        final = b.fen()
    ex = conn.execute("SELECT id, kind, ply FROM exercises WHERE game_id=?", (q["id"],)).fetchall()
    return {"game": game_row(g), "plies": plies, "final_fen": final, "exercises": [dict(e) for e in ex],
            "start_fen": chess.STARTING_FEN}


@route("POST", "/api/game/reviewed")
def api_game_reviewed(q, body):
    conn = db.connect()
    r = conn.execute("UPDATE games SET reviewed=1 WHERE id=? AND reviewed=0", (body["id"],))
    if r.rowcount:
        db.bump_activity("reviews")
    return {"ok": True}


@route("POST", "/api/game/analyse")
def api_game_analyse(q, body):
    db.connect().execute("UPDATE games SET analyzed=2 WHERE id=? AND analyzed != 1", (body["id"],))
    worker.kick(body["id"])
    return {"ok": True}


# ---------------------------------------------------------------- exercices

@route("GET", "/api/exercises/queue")
def api_ex_queue(q, body):
    return {"exercises": exercises.queue(username(), game_id=q.get("game"), kind=q.get("kind")),
            "counts": exercises.counts(username())}


@route("GET", "/api/exercises/bank")
def api_ex_bank(q, body):
    return {"exercises": exercises.bank(username(), kind=q.get("kind"))}


@route("GET", "/api/exercises/one")
def api_ex_one(q, body):
    r = db.connect().execute("SELECT * FROM exercises WHERE id=?", (int(q["id"]),)).fetchone()
    if r is None:
        raise ApiError("Exercice introuvable", 404)
    return exercises.to_json(r)


@route("POST", "/api/exercises/answer")
def api_ex_answer(q, body):
    return exercises.answer(int(body["id"]), bool(body["ok"]), bool(body.get("first", True)))


@route("POST", "/api/exercises/suspend")
def api_ex_suspend(q, body):
    db.connect().execute("UPDATE exercises SET suspended=? WHERE id=?", (int(body.get("on", 1)), int(body["id"])))
    return {"ok": True}


# ---------------------------------------------------------------- ouvertures

@route("GET", "/api/rep/node")
def api_rep_node(q, body):
    u = username()
    out = repertoire.node_info(u, q["color"], q.get("fen") or chess.STARTING_FEN)
    out["explorer"] = explorer.lookup(q.get("fen") or chess.STARTING_FEN) if q.get("explorer") == "1" else None
    return out


@route("POST", "/api/rep/set")
def api_rep_set(q, body):
    repertoire.set_move(body["color"], body["fen"], body.get("uci"))
    return {"ok": True}


@route("POST", "/api/rep/auto")
def api_rep_auto(q, body):
    return {"added": repertoire.auto_build(username(), body["color"])}


@route("GET", "/api/rep/leaks")
def api_rep_leaks(q, body):
    return {"leaks": repertoire.leaks(username(), q["color"])}


@route("GET", "/api/rep/drill")
def api_rep_drill(q, body):
    u = username()
    return {**repertoire.drill_line(u, q["color"]), "counts": repertoire.drill_counts(u, q["color"])}


@route("POST", "/api/rep/result")
def api_rep_result(q, body):
    repertoire.drill_result(body["color"], body["key"], bool(body["ok"]))
    return {"ok": True}


# ---------------------------------------------------------------- diagnostic, finales

@route("GET", "/api/stats")
def api_stats(q, body):
    return stats.full(username(), time_class=q.get("tc") or None, days=int(q["days"]) if q.get("days") else None)


@route("GET", "/api/endgames")
def api_endgames(q, body):
    return {"endgames": endgames.listing()}


@route("POST", "/api/endgames/start")
def api_endgame_start(q, body):
    return endgames.start(body["id"])


@route("POST", "/api/endgames/step")
def api_endgame_step(q, body):
    return endgames.step(body["id"], body["fen"], body["uci"], int(body.get("user_moves", 0)))


# ---------------------------------------------------------------- HTTP

class Server(ThreadingHTTPServer):
    # Sous Windows, SO_REUSEADDR laisserait deux programmes écouter le même port : on veut une vraie erreur.
    allow_reuse_address = False
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ChessPrac"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, data: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _handle(self, method: str):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            fn = ROUTES.get((method, url.path))
            if fn is None:
                return self._json(404, {"error": "route inconnue"})
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            body = {}
            if method == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    body = json.loads(self.rfile.read(n).decode("utf-8"))
            try:
                return self._json(200, fn(q, body))
            except ApiError as e:
                return self._json(e.code, {"error": str(e)})
            except EngineMissing as e:
                return self._json(500, {"error": str(e)})
            except chesscom.ChessComError as e:
                return self._json(502, {"error": str(e)})
            except Exception as e:
                log.error("%s %s: %s", method, self.path, traceback.format_exc())
                return self._json(500, {"error": f"Erreur interne : {e}"})
        if method != "GET":
            return self._json(405, {"error": "méthode"})
        rel = url.path.lstrip("/") or "index.html"
        path = (config.WEB / rel).resolve()
        if not str(path).startswith(str(config.WEB.resolve())) or not path.is_file():
            path = config.WEB / "index.html"  # routes de l'appli (#/...) : toujours la même page
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def setup_logging():
    config.HOME.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(config.LOG_PATH, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger("chessprac")
    if not root.handlers:
        root.addHandler(handler)
    root.setLevel(logging.INFO)


def serve(port: int = config.PORT) -> tuple[ThreadingHTTPServer, int]:
    setup_logging()
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("image/svg+xml", ".svg")
    db.connect()
    for p in (port, 0):
        try:
            httpd = Server(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    threading.Thread(target=httpd.serve_forever, name="chessprac-http", daemon=True).start()
    worker.start()
    return httpd, httpd.server_address[1]
