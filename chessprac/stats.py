"""Le diagnostic : où et comment je perds des points."""
import json
import math
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


# ---------------------------------------------------------------- statistiques « pour le plaisir »

CLASS_ORDER = ["brilliant", "great", "best", "excellent", "good", "inaccuracy", "mistake", "blunder", "missed"]
PERIODS = [(6, 12, "Le matin"), (12, 18, "L'après-midi"), (18, 23, "Le soir"), (23, 30, "La nuit")]


def fun(username: str, time_class: str | None = None, days: int | None = None) -> dict:
    conn = db.connect()
    where, args = "g.username=?", [username.lower()]
    if time_class:
        where += " AND g.time_class=?"
        args.append(time_class)
    if days:
        where += " AND g.end_time>=?"
        args.append(int(time.time() - days * 86400))
    games = conn.execute(f"SELECT * FROM games g WHERE {where} ORDER BY end_time", args).fetchall()
    out: dict = {}

    # Mes coups, classés comme sur chess.com.
    counts = {k: 0 for k in CLASS_ORDER}
    for r in conn.execute(f"""SELECT m.cls, m.special, m.missed FROM moves m JOIN games g ON g.id=m.game_id
                              WHERE {where} AND m.mine=1 AND m.cls IS NOT NULL""", args):
        if r["special"] in ("brilliant", "great"):
            counts[r["special"]] += 1
        elif r["cls"] in counts:
            counts[r["cls"]] += 1
        if r["missed"]:
            counts["missed"] += 1
    out["classes"] = counts

    # Mes coups brillants, les plus récents d'abord.
    out["brilliants"] = [dict(r) for r in conn.execute(
        f"""SELECT m.game_id, m.ply, m.san, m.uci, m.fen_before, g.opp_name, g.opp_rating, g.end_time, g.time_class,
                   g.time_control, g.result, g.my_color
            FROM moves m JOIN games g ON g.id=m.game_id
            WHERE {where} AND m.mine=1 AND m.special='brilliant' ORDER BY g.end_time DESC LIMIT 40""", args)]

    # Records.
    rec = {}
    played = [g for g in games]
    rec["games"] = len(played)
    t = conn.execute(f"""SELECT COUNT(*) n, SUM(m.think) s, MAX(m.think) mx FROM moves m JOIN games g ON g.id=m.game_id
                         WHERE {where} AND m.mine=1 AND g.time_class != 'daily'""", args).fetchone()
    rec["moves"], rec["think_hours"] = t["n"], round((t["s"] or 0) / 3600, 1)
    rec["longest_think"] = round(t["mx"] or 0)

    def game_brief(g, **extra):
        return {"id": g["id"], "opp_name": g["opp_name"], "opp_rating": g["opp_rating"], "end_time": g["end_time"],
                "time_class": g["time_class"], "time_control": g["time_control"], "result": g["result"], **extra}

    wins = [g for g in played if g["result"] == "win"]
    rated_wins = [g for g in wins if g["rated"] and g["opp_rating"]]
    if rated_wins:
        g = max(rated_wins, key=lambda g: g["opp_rating"])
        rec["best_win"] = game_brief(g)
    mates = [g for g in wins if g["opp_code"] == "checkmated"]
    if mates:
        g = min(mates, key=lambda g: g["n_plies"])
        rec["fastest_mate"] = game_brief(g, moves=(g["n_plies"] + 1) // 2)
    if played:
        g = max(played, key=lambda g: g["n_plies"] or 0)
        rec["longest"] = game_brief(g, moves=((g["n_plies"] or 0) + 1) // 2)
    accurate = [g for g in played if g["acc_me"] is not None and (g["n_plies"] or 0) >= 30]
    if accurate:
        g = max(accurate, key=lambda g: g["acc_me"])
        rec["most_accurate"] = game_brief(g, acc=g["acc_me"])
    rec["clean_games"] = sum(1 for g in played if g["analyzed"] == 1 and (g["n_plies"] or 0) >= 30
                             and not (g["n_blunders"] or 0) and not (g["n_mistakes"] or 0))

    # Plus belle remontée : victoire après être tombé le plus bas.
    win_ids = [g["id"] for g in wins]
    if win_ids:
        ph = ",".join("?" * len(win_ids))
        row = conn.execute(f"""SELECT game_id, MIN(wp_before) low FROM moves WHERE mine=1 AND game_id IN ({ph})
                               AND wp_before IS NOT NULL GROUP BY game_id ORDER BY low LIMIT 1""", win_ids).fetchone()
        if row:
            g = next(g for g in wins if g["id"] == row["game_id"])
            rec["comeback"] = game_brief(g, low=round(row["low"], 1))

    # Plus longue série de victoires.
    best = cur = 0
    for g in played:
        cur = cur + 1 if g["result"] == "win" else 0
        best = max(best, cur)
    rec["win_streak"] = best

    # Adversaire le plus rencontré.
    faced: dict[str, list] = {}
    for g in played:
        faced.setdefault(g["opp_name"], []).append(g["result"])
    if faced:
        name, res = max(faced.items(), key=lambda kv: len(kv[1]))
        if len(res) >= 2:
            rec["rival"] = {"name": name, "n": len(res), "wins": res.count("win"), "losses": res.count("loss")}

    # Meilleur moment de la journée pour jouer.
    periods = []
    for lo, hi, label in PERIODS:
        sel = [g for g in played if lo <= (time.localtime(g["end_time"]).tm_hour + (24 if time.localtime(g["end_time"]).tm_hour < 6 else 0)) < hi]
        if sel:
            score = sum({"win": 1, "draw": .5, "loss": 0}[g["result"]] for g in sel) / len(sel)
            periods.append({"label": label, "n": len(sel), "score": round(100 * score)})
    out["periods"] = periods
    out["records"] = rec
    return out


# ---------------------------------------------------------------- Elo potentiel

POT_GAMES = 50        # les 50 dernières parties classées de la cadence...
POT_HALF_LIFE = 20    # ... les plus récentes comptent plus (poids divisé par 2 tous les 20 parties)
POT_MIN_GAMES = 15
POT_WIN_WP = 85       # « position gagnante » : au moins 85 % de chances de gain...
POT_WIN_MOVES = 2     # ... sur au moins 2 de mes coups (pas juste un éclair)
POT_CONVERSION = 0.7  # part réaliste de ces positions qu'on gagne (100 % surestimait d'environ 40 Elo)
POT_NEAR = 150        # « joueurs de ton niveau » : à 150 Elo près
POT_PRIOR = 2.0       # une nulle fictive contre son propre Elo : évite les chiffres absurdes sur peu de parties
POT_HORIZON = 100     # le potentiel vise l'Elo atteint ~100 parties classées plus tard
POT_BT_STEP = 5       # vérification sur l'historique : un point toutes les 5 parties
POT_BT_MIN = 8        # points de vérification nécessaires pour annoncer une marge mesurée
POT_UNRELIABLE = 100  # marge au-delà de laquelle l'estimation est dite peu fiable


def _expected(diff: float) -> float:
    return 1 / (1 + 10 ** (-diff / 400))


def performance(opps: list[float], scores: list[float], weights: list[float], prior: float) -> float:
    """L'Elo R pour lequel le score attendu contre ces adversaires égale le score obtenu (pondéré)."""
    goal = sum(w * s for w, s in zip(weights, scores)) + POT_PRIOR * 0.5
    lo, hi = -500.0, 4000.0
    for _ in range(40):
        mid = (lo + hi) / 2
        e = sum(w * _expected(mid - o) for w, o in zip(weights, opps)) + POT_PRIOR * _expected(mid - prior)
        lo, hi = (mid, hi) if e < goal else (lo, mid)
    return (lo + hi) / 2


def _estimate(games: list, winning: dict, cur: float) -> dict:
    """games : les parties analysées de la fenêtre, de la plus récente à la plus ancienne."""
    opps = [g["opp_rating"] for g in games]
    w = [0.5 ** (i / POT_HALF_LIFE) for i in range(len(games))]
    sc = [{"win": 1.0, "draw": 0.5}.get(g["result"], 0.0) for g in games]
    thrown = {i for i, g in enumerate(games) if g["result"] != "win" and winning.get(g["id"], 0) >= POT_WIN_MOVES}
    gifts = {i for i, g in enumerate(games) if g["result"] != "win" and winning.get(g["id"], 0) == 1}
    conv = lambda s: s + POT_CONVERSION * (1 - s)
    return {
        "w": w, "thrown": thrown, "gifts": gifts,
        "level": performance(opps, sc, w, cur),
        "potential": performance(opps, [conv(s) if i in thrown else s for i, s in enumerate(sc)], w, cur),
        "max": performance(opps, [conv(s) if i in thrown or i in gifts else s for i, s in enumerate(sc)], w, cur),
    }


def _winning_moves(conn, ids: list[str]) -> dict:
    out = {}
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        for r in conn.execute(f"""SELECT game_id, COUNT(*) n FROM moves WHERE mine=1 AND wp_before >= ?
                                  AND game_id IN ({",".join("?" * len(part))}) GROUP BY game_id""", [POT_WIN_WP, *part]):
            out[r["game_id"]] = r["n"]
    return out


def _backtest(games: list, winning: dict) -> list[float]:
    """Sur l'historique : à chaque instant passé, l'écart entre l'Elo réel POT_HORIZON parties plus tard et le
    potentiel qu'on aurait annoncé. games : toutes les parties classées, de la plus ancienne à la plus récente."""
    errors = []
    for t in range(POT_GAMES, len(games) - POT_HORIZON + 1, POT_BT_STEP):
        win = [g for g in games[t - POT_GAMES:t] if g["analyzed"] == 1][::-1]
        if len(win) < 30:
            continue
        cur = games[t - 1]["my_rating"]
        errors.append(games[t - 1 + POT_HORIZON]["my_rating"] - _estimate(win, winning, cur)["potential"])
    return errors


def potential(username: str) -> dict:
    """Elo potentiel par cadence, d'après les 50 dernières parties classées analysées :
    - niveau actuel : la performance (Elo des adversaires + résultats, les récentes comptent plus) ;
    - potentiel : la même performance en gagnant 70 % des parties où l'on a eu une position gagnante. C'est une
      prévision de l'Elo ~100 parties plus tard ; sa marge d'erreur est mesurée sur l'historique du compte ;
    - potentiel max : en punissant aussi les cadeaux adverses (une seule fois à 85 %, pas vu).
    Plus la précision face à des joueurs de son Elo, pour voir si le jeu est meilleur que les résultats."""
    conn = db.connect()
    u = username.lower()
    cc = db.get_setting("cc_stats")
    ratings = json.loads(cc) if cc and db.get_setting("username") == u else {}
    r10 = lambda x: int(math.floor(x / 10 + 0.5) * 10)  # comme Math.round en JS
    out = {}
    for tc in ("rapid", "blitz", "bullet"):
        hist = conn.execute("""SELECT id, end_time, my_rating, opp_rating, result, my_code, acc_me, acc_opp, analyzed
                               FROM games WHERE username=? AND time_class=? AND rated=1 AND opp_rating > 0
                               ORDER BY end_time""", (u, tc)).fetchall()
        games = [g for g in hist if g["analyzed"] == 1][::-1][:POT_GAMES]
        if len(games) < POT_MIN_GAMES:
            continue
        winning = _winning_moves(conn, [g["id"] for g in hist if g["analyzed"] == 1])
        cur = (ratings.get(tc) or {}).get("rating") or games[0]["my_rating"]
        est = _estimate(games, winning, cur)
        w = est["w"]
        # Marge : l'erreur moyenne mesurée sur l'historique ; sinon l'incertitude statistique de la performance.
        n_eff = sum(w) ** 2 / sum(x * x for x in w)
        stat_margin = 400 / math.log(10) / math.sqrt(n_eff * 0.25)
        errors = _backtest(hist, winning)
        measured = len(errors) >= POT_BT_MIN
        margin = max(stat_margin, sum(abs(e) for e in errors) / len(errors)) if measured else max(stat_margin, 80)
        near = [g for g in games if g["acc_me"] is not None and g["acc_opp"] is not None
                and abs(g["opp_rating"] - g["my_rating"]) <= POT_NEAR]
        thrown = est["thrown"]
        out[tc] = {
            "current": cur, "n": len(games), "since": games[-1]["end_time"], "last": games[0]["end_time"],
            "level": r10(est["level"]), "potential": r10(est["potential"]), "max": r10(est["max"]),
            "margin": r10(margin), "measured": measured, "checks": len(errors),
            "bias": r10(sum(errors) / len(errors)) if measured else None,
            "reliable": measured and margin < POT_UNRELIABLE,
            "horizon": POT_HORIZON, "conversion": POT_CONVERSION,
            "thrown": len(thrown), "thrown_timeout": sum(1 for i in thrown if games[i]["my_code"] == "timeout"),
            "gifts": len(est["gifts"]),
            "acc": {"me": round(sum(g["acc_me"] for g in near) / len(near), 1),
                    "opp": round(sum(g["acc_opp"] for g in near) / len(near), 1), "n": len(near)} if near else None,
        }
    return out
