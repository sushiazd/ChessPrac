"""ChessPrac en ligne : envoie les analyses et les stats du compte, et reprend les analyses déjà faites ailleurs.

- Envoi (il faut la clé) : chaque partie analysée part en ligne avec sa revue coup par coup, puis les statistiques.
  Elles se consultent ensuite depuis n'importe quel appareil, à l'adresse du compte.
- Reprise (sans clé) : avant d'analyser une partie, on regarde si elle est déjà en ligne (même partie vue par
  l'adversaire, ou analysée sur un autre appareil). Si oui, on reprend son analyse au lieu de relancer Stockfish.

L'entraînement (exercices, révisions, répertoire, finales) n'est jamais envoyé.
"""
import gzip
import json
import logging
import time
import urllib.error
import urllib.request

from . import analysis, config, db, gameview, stats

log = logging.getLogger("chessprac")

PUSH_BATCH = 10            # parties par envoi (le service gratuit limite le temps de calcul par requête)
PULL_BATCH = 20
STATS_EVERY = 10 * 60      # au plus souvent, les stats repartent toutes les 10 min
STATS_REFRESH = 12 * 3600  # et au moins deux fois par jour (les périodes « 30 j », « 3 mois » glissent)
STATS_TC = ["", "rapid", "blitz", "bullet"]
STATS_DAYS = ["30", "90", "365", ""]
IMPORTED = ["cp_before", "mate_before", "cp_after", "mate_after", "best_uci", "best_san", "wp_before", "wp_after",
            "drop", "accuracy", "cls", "missed", "phase", "special"]


class CloudError(Exception):
    pass


def base() -> str:
    return (db.get_setting("cloud_url") or config.CLOUD_URL or "").rstrip("/")


def key() -> str:
    k = db.get_setting("cloud_key")
    if not k and config.CLOUD_KEY_FILE.exists():
        k = config.CLOUD_KEY_FILE.read_text(encoding="utf-8").strip()
    return k or ""


def page_url(username: str) -> str:
    return f"{base()}/{username.lower()}" if base() else ""


def _request(path: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 60):
    req = urllib.request.Request(base() + path, data=data, method="GET" if data is None else "POST")
    req.add_header("User-Agent", config.USER_AGENT)
    req.add_header("Accept-Encoding", "gzip")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error")
        except Exception:
            msg = None
        raise CloudError(msg or f"ChessPrac en ligne a répondu {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise CloudError(f"ChessPrac en ligne injoignable ({getattr(e, 'reason', e)})") from None
    return json.loads(raw.decode("utf-8"))


def _post_json(path: str, obj) -> object:
    return _request(path, json.dumps(obj).encode("utf-8"), {"Content-Type": "application/json"})


def _dumps(obj) -> str:
    # json.dumps échappe toujours les tabulations et retours à la ligne : le format ligne / tabulation reste sûr.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ------------------------------------------------------------------ reprise des analyses déjà en ligne

_absent: set[str] = set()  # parties déjà cherchées en ligne sans succès (depuis le lancement)


def import_payload(game_id: str, data: dict) -> bool:
    """Reprend l'analyse d'une partie déjà en ligne. Les exercices seront faits ici (pending_ex)."""
    conn = db.connect()
    g = conn.execute("SELECT my_color, analyzed FROM games WHERE id=?", (game_id,)).fetchone()
    rows = conn.execute("SELECT ply, uci FROM moves WHERE game_id=? ORDER BY ply", (game_id,)).fetchall()
    plies = data.get("plies") or []
    if g is None or g["analyzed"] == 1 or not rows or len(rows) != len(plies):
        return False
    if any(r["uci"] != p.get("uci") or r["ply"] != p.get("ply") for r, p in zip(rows, plies)):
        return False  # pas les mêmes coups : on ne prend pas le risque
    if any(p.get("cls") is None or p.get("accuracy") is None for p in plies):
        return False
    my_color = g["my_color"]
    acc = {"w": [], "b": []}
    counts = {"inaccuracy": 0, "mistake": 0, "blunder": 0}
    updates = []
    for p in plies:
        acc[p["color"]].append(p["accuracy"])
        if p["color"] == my_color and p["cls"] in counts:
            counts[p["cls"]] += 1
        pv = p.get("pv") or []
        updates.append(tuple(p.get(k) for k in IMPORTED) + (" ".join(pv) if isinstance(pv, list) else pv,
                                                            game_id, p["ply"]))
    opp = "b" if my_color == "w" else "w"
    with db.transaction() as tx:
        tx.executemany(
            f"""UPDATE moves SET {", ".join(f'"{k}"=?' for k in IMPORTED)}, pv=?, tag=NULL
                WHERE game_id=? AND ply=?""", updates)
        tx.execute("""UPDATE games SET analyzed=1, analyzed_at=?, acc_me=?, acc_opp=?, n_inacc=?, n_mistakes=?,
                      n_blunders=?, specials_done=1, pending_ex=1, uploaded=0 WHERE id=? AND analyzed != 1""",
                   (time.time(), analysis.game_accuracy(acc[my_color]), analysis.game_accuracy(acc[opp]),
                    counts["inaccuracy"], counts["mistake"], counts["blunder"], game_id))
    return True


def pull(username: str, stop=None) -> int:
    """Reprend toutes les analyses déjà en ligne pour les parties pas encore analysées ici."""
    if not base():
        return 0
    todo = [r["id"] for r in db.connect().execute(
        "SELECT id FROM games WHERE username=? AND analyzed IN (0, 2) ORDER BY end_time DESC", (username.lower(),))
        if r["id"] not in _absent]
    imported = 0
    for i in range(0, len(todo), 400):
        part = todo[i:i + 400]
        found = set(_post_json("/api/known", {"ids": part}))
        _absent.update(g for g in part if g not in found)
        found_list = [g for g in part if g in found]
        for j in range(0, len(found_list), PULL_BATCH):
            if stop is not None and stop.is_set():
                return imported
            got = _post_json("/api/analyses", {"ids": found_list[j:j + PULL_BATCH]})
            for gid, data in got.items():
                try:
                    if import_payload(gid, data):
                        imported += 1
                    else:
                        _absent.add(gid)
                except Exception as e:
                    log.warning("reprise de %s impossible : %s", gid, e)
                    _absent.add(gid)
    if imported:
        log.info("analyses reprises d'en ligne : %d", imported)
    return imported


# ------------------------------------------------------------------ envoi

def _head(username: str) -> dict:
    cc = db.get_setting("cc_stats")
    return {"account": username.lower(), "display": db.get_setting("display_name") or username,
            "ratings": json.loads(cc) if cc else None}


def _send(lines: list[str]) -> dict:
    body = gzip.compress("\n".join(lines).encode("utf-8"))
    return _request("/api/push", body, {"Content-Type": "text/plain; charset=utf-8", "X-Body": "gzip",
                                        "X-ChessPrac-Key": key()}, timeout=120)


def pending(username: str, busy: set[str] | None = None) -> list[str]:
    rows = db.connect().execute(
        """SELECT id FROM games WHERE username=? AND analyzed=1 AND COALESCE(uploaded, 0)=0
           AND COALESCE(pending_ex, 0)=0 ORDER BY end_time DESC""", (username.lower(),)).fetchall()
    return [r["id"] for r in rows if not busy or r["id"] not in busy]


def push_games(username: str, ids: list[str], stop=None) -> int:
    head = _dumps(_head(username))
    sent = 0
    for i in range(0, len(ids), PUSH_BATCH):
        if stop is not None and stop.is_set():
            break
        part = ids[i:i + PUSH_BATCH]
        lines = [head]
        for gid in part:
            data = gameview.payload(gid)
            if data is None:
                continue
            g = data["game"]
            lines.append("\t".join(["G", gid, str(g.get("end_time") or 0), _dumps(g), _dumps(data)]))
        _send(lines)
        with db.transaction() as tx:
            tx.executemany("UPDATE games SET uploaded=1 WHERE id=?", [(g,) for g in part])
        sent += len(part)
    return sent


def push_stats(username: str) -> int:
    lines = [_dumps(_head(username))]
    pot = stats.potential(username)
    for tc in STATS_TC:
        for days in STATS_DAYS:
            out = stats.full(username, time_class=tc or None, days=int(days) if days else None)
            out["fun"] = stats.fun(username, time_class=tc or None, days=int(days) if days else None)
            out["potential"] = pot
            lines.append("\t".join(["S", f"{tc}|{days}", _dumps(out)]))
    _send(lines)
    db.set_setting("cloud_stats_at", time.time())
    return len(lines) - 1


def online_count(username: str) -> int:
    return db.connect().execute("SELECT COUNT(*) n FROM games WHERE username=? AND uploaded=1",
                                (username.lower(),)).fetchone()["n"]
