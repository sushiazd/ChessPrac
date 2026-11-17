"""Statistiques Lichess par tranche d'Elo (optionnel : demande un jeton Lichess personnel, sans droits)."""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

import chess

from . import config, db

URL = "https://explorer.lichess.ovh/lichess"
TTL = 30 * 86400


def lookup(fen: str, ratings: str = "1000,1200,1400,1600", speeds: str = "blitz,rapid") -> dict | None:
    token = db.get_setting("lichess_token").strip()
    if not token:
        return None
    board = chess.Board(fen)
    key = f"{board.epd()}|{ratings}|{speeds}"
    conn = db.connect()
    row = conn.execute("SELECT data, fetched_at FROM explorer_cache WHERE key=?", (key,)).fetchone()
    if row and time.time() - row["fetched_at"] < TTL:
        return json.loads(row["data"])
    q = urllib.parse.urlencode({"variant": "standard", "fen": fen, "ratings": ratings, "speeds": speeds,
                                "moves": 8, "topGames": 0, "recentGames": 0})
    req = urllib.request.Request(f"{URL}?{q}", headers={"Authorization": f"Bearer {token}",
                                                       "User-Agent": config.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": "Jeton Lichess refusé (401)." if e.code == 401 else f"Lichess a répondu {e.code}."}
    except (urllib.error.URLError, TimeoutError):
        return {"error": "Lichess injoignable."}
    total = raw.get("white", 0) + raw.get("draws", 0) + raw.get("black", 0)
    moves = []
    for m in raw.get("moves", []):
        n = m["white"] + m["draws"] + m["black"]
        if not n:
            continue
        mover_wins = m["white"] if board.turn == chess.WHITE else m["black"]
        moves.append({"uci": m["uci"], "san": m["san"], "n": n, "pct": round(100 * n / total, 1) if total else 0,
                      "score": round(100 * (mover_wins + m["draws"] / 2) / n)})
    data = {"total": total, "moves": moves}
    conn.execute("INSERT OR REPLACE INTO explorer_cache(key, fetched_at, data) VALUES(?,?,?)",
                 (key, time.time(), json.dumps(data)))
    return data
