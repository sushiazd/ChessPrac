"""Le diagnostic : où et comment je perds des points."""
import time

from . import db
from .analysis import BLUNDER, MISTAKE

THINK_BUCKETS = [(0, 2, "< 2 s"), (2, 5, "2–5 s"), (5, 15, "5–15 s"), (15, 45, "15–45 s"), (45, 1e9, "> 45 s")]
CLOCK_BUCKETS = [(0, 15, "< 15 s"), (15, 30, "15–30 s"), (30, 60, "30–60 s"), (60, 180, "1–3 min"), (180, 1e9, "> 3 min")]
TAG_LABELS = {"menace": "Menace adverse pas vue", "piece": "Pièce laissée en prise", "mat": "Mat encaissé",
              "mat-rate": "Mat raté", "occasion": "Erreur adverse pas punie", "autre": "Autre"}
LOSS_LABELS = {"checkmated": "Maté", "resigned": "Abandon", "timeout": "Au temps", "abandoned": "Partie quittée",
               "lose": "Perdue"}


def _pct(a, b):
    return round(100 * a / b, 1) if b else None


def full(username: str, time_class: str | None = None, days: int | None = None) -> dict:
    conn = db.connect()
    u = username.lower()
    where = "g.username=?"
    args: list = [u]
    if time_class:
        where += " AND g.time_class=?"
        args.append(time_class)
    if days:
        where += " AND g.end_time>=?"
        args.append(int(time.time() - days * 86400))

    games = conn.execute(f"SELECT * FROM games g WHERE {where} ORDER BY end_time", args).fetchall()
    out: dict = {"games": len(games)}

    # Elo dans le temps (toujours toutes cadences, pour comparer).
    hist = {}
    for r in conn.execute("SELECT time_class, end_time, my_rating FROM games WHERE username=? AND rated=1 ORDER BY end_time",
                          (u,)):
        hist.setdefault(r["time_class"], []).append([r["end_time"], r["my_rating"]])
    out["ratings"] = hist

    res = {"win": 0, "draw": 0, "loss": 0}
    by_color = {"w": dict(res), "b": dict(res)}
    losses, wins = {}, {}
    for g in games:
        res[g["result"]] += 1
        by_color[g["my_color"]][g["result"]] += 1
        if g["result"] == "loss":
            losses[g["my_code"]] = losses.get(g["my_code"], 0) + 1
        elif g["result"] == "win":
            wins[g["opp_code"]] = wins.get(g["opp_code"], 0) + 1
    out["results"] = res
    out["by_color"] = by_color
    out["losses"] = [{"code": k, "label": LOSS_LABELS.get(k, k), "n": v} for k, v in sorted(losses.items(), key=lambda x: -x[1])]
    out["wins"] = [{"code": k, "label": LOSS_LABELS.get(k, k), "n": v} for k, v in sorted(wins.items(), key=lambda x: -x[1])]

    # Ouvertures : regroupées par les 3 premiers coups, de mon côté.
    ops = {}
    for g in games:
        first = conn.execute("SELECT san FROM moves WHERE game_id=? AND ply<=4 ORDER BY ply", (g["id"],)).fetchall()
        sans = [r["san"] for r in first]
        line = " ".join(f"{i // 2 + 1}.{s}" if i % 2 == 0 else s for i, s in enumerate(sans))
        k = (g["my_color"], line)
        o = ops.setdefault(k, {"color": g["my_color"], "line": line, "name": g["opening"], "n": 0, "score": 0.0,
                               "acc": [], "blunders": 0})
        o["n"] += 1
        o["score"] += {"win": 1, "draw": .5, "loss": 0}[g["result"]]
        if g["acc_me"] is not None:
            o["acc"].append(g["acc_me"])
            o["blunders"] += g["n_blunders"] or 0
    op_list = []
    for o in ops.values():
        if o["n"] < 2:
            continue
        op_list.append({"color": o["color"], "line": o["line"], "name": o["name"], "n": o["n"],
                        "score": round(100 * o["score"] / o["n"]),
                        "acc": round(sum(o["acc"]) / len(o["acc"]), 1) if o["acc"] else None,
                        "blunders": round(o["blunders"] / len(o["acc"]), 2) if o["acc"] else None})
    op_list.sort(key=lambda o: -o["n"])
    out["openings"] = op_list[:24]

    # Tout ce qui suit demande l'analyse Stockfish.
    analyzed = [g for g in games if g["analyzed"] == 1]
    out["analyzed"] = len(analyzed)
    if not analyzed:
        out["insights"] = []
        return out
    ids = [g["id"] for g in analyzed]
    ph = ",".join("?" * len(ids))
    mv = conn.execute(f'SELECT * FROM moves WHERE game_id IN ({ph}) AND mine=1 AND "drop" IS NOT NULL', ids).fetchall()

    phases = {p: {"moves": 0, "mistakes": 0, "blunders": 0, "acc": 0.0} for p in ("ouverture", "milieu", "finale")}
    for m in mv:
        p = phases[m["phase"]]
        p["moves"] += 1
        p["acc"] += m["accuracy"]
        if m["drop"] >= BLUNDER:
            p["blunders"] += 1
        elif m["drop"] >= MISTAKE:
            p["mistakes"] += 1
    out["phases"] = [{"phase": k, "moves": v["moves"], "acc": round(v["acc"] / v["moves"], 1) if v["moves"] else None,
                      "mistakes_per_game": round(v["mistakes"] / len(analyzed), 2),
                      "blunders_per_game": round(v["blunders"] / len(analyzed), 2),
                      "blunder_rate": _pct(v["blunders"], v["moves"])} for k, v in phases.items()]

    def buckets(field, spec):
        res = []
        for lo, hi, label in spec:
            sel = [m for m in mv if m[field] is not None and lo <= m[field] < hi]
            bl = sum(1 for m in sel if m["drop"] >= BLUNDER)
            res.append({"label": label, "moves": len(sel), "blunders": bl, "rate": _pct(bl, len(sel))})
        return res

    out["think"] = buckets("think", THINK_BUCKETS)
    out["clock"] = buckets("clock", CLOCK_BUCKETS)

    tags = {}
    for m in mv:
        if m["drop"] >= MISTAKE and m["tag"]:
            tags[m["tag"]] = tags.get(m["tag"], 0) + 1
    out["tags"] = [{"tag": k, "label": TAG_LABELS.get(k, k), "n": v} for k, v in sorted(tags.items(), key=lambda x: -x[1])]

    # Précision par semaine (moyenne glissante simple).
    weeks = {}
    for g in analyzed:
        if g["acc_me"] is None:
            continue
        w = g["end_time"] // (7 * 86400)
        weeks.setdefault(w, []).append(g["acc_me"])
    out["accuracy_weeks"] = [[w * 7 * 86400, round(sum(v) / len(v), 1), len(v)] for w, v in sorted(weeks.items())]

    # Parties gâchées : pas gagnées alors que j'ai eu au moins 85 % de chances de gain.
    best_wp: dict[str, float] = {}
    for m in mv:
        if m["wp_before"] is not None:
            best_wp[m["game_id"]] = max(best_wp.get(m["game_id"], 0), m["wp_before"])
    not_won = [g for g in analyzed if g["result"] != "win"]
    thrown = [g for g in not_won if best_wp.get(g["id"], 0) >= 85]
    out["thrown"] = {"n": len(thrown), "of": len(not_won)}

    n_bl = sum(1 for m in mv if m["drop"] >= BLUNDER)
    n_mi = sum(1 for m in mv if MISTAKE <= m["drop"] < BLUNDER)
    out["per_game"] = {"blunders": round(n_bl / len(analyzed), 2), "mistakes": round(n_mi / len(analyzed), 2),
                       "acc": round(sum(g["acc_me"] for g in analyzed if g["acc_me"]) / len(analyzed), 1)}
    out["insights"] = insights(out)
    return out


PHASE_IN = {"ouverture": "dans l'ouverture", "milieu": "en milieu de partie", "finale": "en finale"}


def fr(x: float, d: int = 1) -> str:
    return f"{x:.{d}f}".replace(".", ",")


def insights(s: dict) -> list[dict]:
    """Quelques phrases simples, les plus utiles d'abord."""
    out = []
    pg = s.get("per_game")
    if pg:
        out.append({"kind": "info", "text": f"Tu fais en moyenne {fr(pg['blunders'])} gaffe(s) et {fr(pg['mistakes'])} erreur(s) "
                                            f"par partie, pour {pg['acc']:.0f} % de précision."})
    th = s.get("thrown")
    if th and th["of"] >= 5 and th["n"] / th["of"] >= 0.15:
        out.append({"kind": "bad", "text": f"{th['n']} de tes {th['of']} défaites et nulles analysées étaient gagnées "
                                           f"(85 % de chances de gain ou plus) : c'est {round(100 * th['n'] / th['of'])} % "
                                           "de points laissés en route. Entraîne-toi dans « Erreurs > Convertir »."})
    tags = s.get("tags") or []
    total = sum(t["n"] for t in tags)
    if total >= 5:
        top = tags[0]
        if top["tag"] != "autre":
            out.append({"kind": "bad", "text": f"Ta première cause d'erreur : « {top['label'].lower()} » "
                                               f"({round(100 * top['n'] / total)} % de tes erreurs). Les exercices "
                                               f"« Erreurs » de ce type passent en premier."})
        threat = next((t for t in tags if t["tag"] == "menace"), None)
        if threat and threat is not top and threat["n"] / total >= 0.15:
            out.append({"kind": "bad", "text": f"{round(100 * threat['n'] / total)} % de tes erreurs viennent d'une menace "
                                               "adverse pas vue. Avant chaque coup, demande-toi : « qu'est-ce que l'adversaire veut faire ? »"})
    think = [b for b in s.get("think", []) if b["moves"] >= 30 and b["rate"] is not None]
    if len(think) >= 2:
        fast, slow = think[0], max(think[1:], key=lambda b: b["moves"])
        if fast["rate"] and slow["rate"] and fast["rate"] >= 1.5 * slow["rate"]:
            out.append({"kind": "warn", "text": f"Quand tu joues en {fast['label']}, tu gaffes {fr(fast['rate'])} % du temps, "
                                                f"contre {fr(slow['rate'])} % en {slow['label']} : ×{fr(fast['rate'] / slow['rate'])}."})
    phases = [p for p in s.get("phases", []) if p["moves"] >= 30]
    if phases:
        worst = max(phases, key=lambda p: p["blunders_per_game"])
        out.append({"kind": "info", "text": f"C'est {PHASE_IN[worst['phase']]} que tu gaffes le plus : {fr(worst['blunders_per_game'], 2)} "
                                            f"gaffe par partie (précision {worst['acc']:.0f} %)."})
    losses = s.get("losses") or []
    nl = sum(l["n"] for l in losses)
    if nl >= 5:
        mated = next((l for l in losses if l["code"] == "checkmated"), None)
        if mated and mated["n"] / nl >= 0.35:
            out.append({"kind": "warn", "text": f"{round(100 * mated['n'] / nl)} % de tes défaites finissent par un mat : "
                                                "regarde la sécurité de ton roi et les échecs adverses à chaque coup."})
        timeout = next((l for l in losses if l["code"] == "timeout"), None)
        if timeout and timeout["n"] / nl >= 0.25:
            out.append({"kind": "warn", "text": f"{round(100 * timeout['n'] / nl)} % de tes défaites sont au temps : joue plus "
                                                "vite les coups évidents de l'ouverture."})
    weak = [o for o in s.get("openings", []) if o["n"] >= 5 and o["score"] <= 40]
    if weak:
        o = min(weak, key=lambda o: o["score"])
        side = "Blancs" if o["color"] == "w" else "Noirs"
        out.append({"kind": "bad", "text": f"Avec les {side}, après {o['line']}, tu ne marques que {o['score']} % "
                                           f"({o['n']} parties). À travailler dans « Ouvertures »."})
    return out
