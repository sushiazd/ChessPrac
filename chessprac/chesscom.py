"""Récupération des parties publiques via l'API de chess.com (aucun mot de passe, lecture seule)."""
import io
import json
import time
import urllib.error
import urllib.request

import chess
import chess.pgn

from . import config, db

API = "https://api.chess.com/pub/player"
DRAW_CODES = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}


class ChessComError(Exception):
    pass


def fetch_json(url: str, tries: int = 3):
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT, "Accept": "application/json"})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 and attempt < tries - 1:
                time.sleep(2 + 3 * attempt)
                continue
            raise ChessComError(f"chess.com a répondu {e.code} pour {url}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(2)
                continue
            raise ChessComError(f"chess.com injoignable ({e})") from e
    return None


def player_profile(username: str) -> dict | None:
    return fetch_json(f"{API}/{username.lower()}")


def player_stats(username: str) -> dict | None:
    return fetch_json(f"{API}/{username.lower()}/stats")


def parse_time_control(tc: str) -> tuple[float | None, float]:
    """'180+2' -> (180, 2) ; parties « daily » ('1/86400') -> (None, 0)."""
    if not tc or "/" in tc:
        return None, 0.0
    base, _, inc = tc.partition("+")
    try:
        return float(base), float(inc or 0)
    except ValueError:
        return None, 0.0


def outcome(code: str) -> str:
    if code == "win":
        return "win"
    if code in DRAW_CODES:
        return "draw"
    return "loss"


def opening_name(eco_url: str | None) -> str:
    if not eco_url:
        return ""
    slug = eco_url.rstrip("/").rsplit("/", 1)[-1]
    name = slug.replace("-", " ")
    # « Queens Pawn Opening Accelerated London System 2...c5 3.e3 » : on garde le nom, pas les coups.
    words = []
    for w in name.split(" "):
        if w[:1].isdigit():
            break
        words.append(w)
    name = " ".join(words) or name
    return name.replace("Queens", "Queen's").replace("Kings", "King's").replace("Petrovs", "Petrov's")


def moves_from_pgn(pgn: str, time_control: str, my_color: str) -> list[dict]:
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return []
    base, inc = parse_time_control(time_control)
    board = game.board()
    last_clock = {chess.WHITE: base, chess.BLACK: base}
    rows = []
    ply = 0
    for node in game.mainline():
        move = node.move
        ply += 1
        color = board.turn
        fen = board.fen()
        san = board.san(move)
        clock = node.clock()
        think = None
        if clock is not None and last_clock[color] is not None:
            think = max(0.0, last_clock[color] + inc - clock)
            if ply <= 2:  # le premier coup ne profite pas de l'incrément sur chess.com
                think = max(0.0, last_clock[color] - clock)
        if clock is not None:
            last_clock[color] = clock
        rows.append({
            "ply": ply, "san": san, "uci": move.uci(), "fen_before": fen,
            "color": "w" if color == chess.WHITE else "b",
            "mine": int((color == chess.WHITE) == (my_color == "w")),
            "clock": clock, "think": think,
        })
        board.push(move)
    return rows


def store_game(conn, username: str, g: dict) -> bool:
    """Ajoute une partie (et ses coups). Renvoie True si elle est nouvelle."""
    if g.get("rules", "chess") != "chess" or not g.get("pgn"):
        return False
    gid = g.get("uuid") or g.get("url")
    if conn.execute("SELECT 1 FROM games WHERE id=?", (gid,)).fetchone():
        return False
    me = username.lower()
    white, black = g["white"], g["black"]
    my_color = "w" if white["username"].lower() == me else "b"
    mine, opp = (white, black) if my_color == "w" else (black, white)
    eco_url = None
    for line in g["pgn"].splitlines():
        if line.startswith("[ECOUrl "):
            eco_url = line.split('"')[1]
            break
    rows = moves_from_pgn(g["pgn"], g.get("time_control", ""), my_color)
    if not rows:
        return False
    acc = g.get("accuracies") or {}
    conn.execute(
        """INSERT INTO games(id, username, url, end_time, time_class, time_control, rated, my_color, my_rating,
           opp_name, opp_rating, result, my_code, opp_code, opening, eco_url, pgn, n_plies, cc_acc_me, cc_acc_opp)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (gid, me, g.get("url"), g.get("end_time"), g.get("time_class"), g.get("time_control"), int(bool(g.get("rated"))),
         my_color, mine.get("rating"), opp.get("username"), opp.get("rating"), outcome(mine.get("result", "")),
         mine.get("result"), opp.get("result"), opening_name(eco_url), eco_url, g["pgn"], len(rows),
         acc.get("white" if my_color == "w" else "black"), acc.get("black" if my_color == "w" else "white")))
    conn.executemany(
        "INSERT INTO moves(game_id, ply, san, uci, fen_before, color, mine, clock, think) VALUES(?,?,?,?,?,?,?,?,?)",
        [(gid, r["ply"], r["san"], r["uci"], r["fen_before"], r["color"], r["mine"], r["clock"], r["think"])
         for r in rows])
    return True


def sync(username: str, progress=lambda done, total, msg: None) -> int:
    """Télécharge les mois pas encore complets. Renvoie le nombre de nouvelles parties."""
    conn = db.connect()
    username = username.strip().lower()
    data = fetch_json(f"{API}/{username}/games/archives")
    if data is None:
        raise ChessComError(f"Le compte « {username} » est introuvable sur chess.com.")
    archives = data.get("archives", [])
    done_rows = {r["url"] for r in conn.execute(
        "SELECT url FROM archives WHERE username=? AND complete=1", (username,))}
    todo = [u for u in archives if u not in done_rows]
    current = time.strftime("%Y/%m", time.gmtime())
    added = 0
    # Les mois récents d'abord : l'analyse peut commencer sur les dernières parties sans attendre tout l'historique.
    for i, url in enumerate(reversed(todo)):
        progress(i, len(todo), f"Téléchargement des parties ({url[-7:]})")
        month = fetch_json(url) or {}
        with db.transaction() as tx:
            for g in month.get("games", []):
                if store_game(tx, username, g):
                    added += 1
            # Un mois passé ne bouge plus : on ne le retélécharge pas. Le mois en cours, si.
            complete = int(not url.endswith(current) and not url.endswith(time.strftime("%Y/%m")))
            tx.execute("INSERT INTO archives(url, username, fetched_at, complete) VALUES(?,?,?,?) "
                       "ON CONFLICT(url) DO UPDATE SET fetched_at=excluded.fetched_at, complete=excluded.complete",
                       (url, username, time.time(), complete))
    progress(len(todo), len(todo), "Parties à jour")
    return added
