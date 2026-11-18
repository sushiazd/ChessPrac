"""Travail de fond, sur deux fils indépendants :
- la synchro chess.com, toutes les N minutes (et à la demande), même pendant une longue analyse ;
- l'analyse Stockfish, qui prend toujours la partie la plus récente pas encore analysée : une partie qui vient
  d'arriver passe donc devant les vieilles, sans attendre la fin du lot en cours. Une partie déjà analysée en ligne
  (par l'adversaire, ou sur un autre appareil) est reprise telle quelle : il ne reste qu'à en tirer les exercices ;
- l'envoi en ligne des parties analysées et des stats (s'il y a la clé), sur un troisième fil.
"""
import json
import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import analysis, brilliance, chesscom, cloud, db, exercises
from .engine import EngineMissing, open_engine

log = logging.getLogger("chessprac")

FULL_ANALYSIS_DAYS = 180      # au-delà, analyse rapide
FAST_NODES = 80000            # par position (au lieu de 200 000)
FAST_DEEP_NODES = 400000      # vérification des erreurs (au lieu de 1 000 000)
PUSH_EVERY = 10               # parties analysées entre deux envois en ligne


class Worker:
    def __init__(self):
        self.status = {"phase": "idle", "done": 0, "total": 0, "message": "", "error": None, "last_sync": None,
                       "new_games": 0, "syncing": False,
                       "cloud": {"online": 0, "pending": 0, "error": None, "last": None, "sending": False}}
        self._wake_sync = threading.Event()
        self._wake_analysis = threading.Event()
        self._wake_cloud = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._threads: list[threading.Thread] = []
        self.priority: list[str] = []
        self._engines: set = set()
        self._in_progress: set[str] = set()

    def start(self):
        if not self._threads:
            for target, name in ((self._sync_loop, "chessprac-sync"), (self._analysis_loop, "chessprac-analyse"),
                                 (self._cloud_loop, "chessprac-en-ligne")):
                t = threading.Thread(target=target, name=name, daemon=True)
                t.start()
                self._threads.append(t)

    def stop(self):
        self._stop.set()
        self._wake_sync.set()
        self._wake_analysis.set()
        self._wake_cloud.set()

    def shutdown(self, timeout: float = 20) -> None:
        """Arrêt propre : on coupe les Stockfish (l'analyse en cours s'interrompt), puis on attend que les écritures
        en base soient finies. La partie interrompue sera simplement réanalysée au prochain lancement."""
        self.stop()
        with self._lock:
            engines = list(self._engines)
        for eng in engines:
            try:
                eng.close()
            except Exception:
                pass
        end = time.time() + timeout
        for t in self._threads:
            t.join(max(0.1, end - time.time()))

    def kick(self, game_id: str | None = None):
        """Sans partie : synchro tout de suite. Avec une partie : elle est analysée avant les autres."""
        if game_id:
            with self._lock:
                if game_id not in self.priority:
                    self.priority.insert(0, game_id)
            self._wake_analysis.set()
        else:
            self._wake_sync.set()

    def _set(self, **kw):
        self.status.update(kw)

    # ------------------------------------------------------------ synchro

    def _sync_loop(self):
        while not self._stop.is_set():
            username = db.get_setting("username")
            if username:
                self._set(syncing=True)
                if self.status["phase"] == "idle":
                    self._set(phase="sync", message="Connexion à chess.com…")
                try:
                    self._sync(username)
                    self._set(error=None)
                except chesscom.ChessComError as e:
                    self._set(error=str(e))
                except Exception as e:  # on ne laisse jamais mourir le fil de fond
                    log.error("synchro : %s", traceback.format_exc())
                    self._set(error=f"Erreur : {e}")
                self._set(syncing=False)
                if self.status["phase"] == "sync":
                    self._set(phase="idle", message="")
                self._wake_analysis.set()
            wait = max(5, db.get_int("auto_sync_minutes")) * 60
            self._wake_sync.wait(timeout=wait)
            self._wake_sync.clear()

    def _sync(self, username: str):
        conn = db.connect()

        def progress(d, t, m):
            if self.status["phase"] in ("idle", "sync"):
                self._set(phase="sync", done=d, total=t, message=m)

        added = chesscom.sync(username, progress)
        self._set(last_sync=time.time(), new_games=added)
        try:
            st = chesscom.player_stats(username) or {}
            ratings = {k.replace("chess_", ""): {"rating": v["last"]["rating"], "best": (v.get("best") or {}).get("rating")}
                       for k, v in st.items() if k.startswith("chess_") and isinstance(v, dict) and "last" in v}
            if "tactics" in st:
                ratings["puzzles"] = {"rating": (st["tactics"].get("highest") or {}).get("rating"), "best": None}
            db.set_setting("cc_stats", json.dumps(ratings))
        except chesscom.ChessComError:
            pass
        if conn.execute("SELECT COUNT(*) n FROM exercises WHERE kind='trap'").fetchone()["n"] == 0:
            exercises.import_traps(username)
        brilliance.scan_pending(username)  # parties analysées avant l'arrivée des coups brillants
        db.backup_if_due()

    # ------------------------------------------------------------ analyse

    def _remaining(self, username: str) -> int:
        return db.connect().execute("""SELECT COUNT(*) n FROM games WHERE username=?
                                       AND (analyzed IN (0, 2) OR (analyzed=1 AND pending_ex=1))""",
                                    (username.lower(),)).fetchone()["n"]

    def _next_game(self, username: str) -> tuple[str | None, bool]:
        """(partie, demandée depuis l'interface ?) : la demande de l'interface, sinon la plus récente à faire."""
        with self._lock:
            while self.priority:
                g = self.priority.pop(0)
                row = db.connect().execute("SELECT analyzed FROM games WHERE id=?", (g,)).fetchone()
                if row and row["analyzed"] != 1 and g not in self._in_progress:
                    self._in_progress.add(g)
                    return g, True
            busy = list(self._in_progress)
            ph = ",".join("?" * len(busy)) or "''"
            row = db.connect().execute(
                f"""SELECT id, analyzed FROM games WHERE username=? AND id NOT IN ({ph})
                    AND (analyzed IN (0, 2) OR (analyzed=1 AND pending_ex=1))
                    ORDER BY analyzed = 2 DESC, end_time DESC LIMIT 1""", [username.lower(), *busy]).fetchone()
            if row is None:
                return None, False
            self._in_progress.add(row["id"])
            return row["id"], row["analyzed"] == 2

    def _analysis_loop(self):
        while not self._stop.is_set():
            username = db.get_setting("username")
            if username:
                try:
                    if cloud.pull(username, self._stop):
                        self._wake_cloud.set()
                except cloud.CloudError as e:
                    log.info("reprise en ligne : %s", e)
                except Exception:
                    log.error("reprise en ligne : %s", traceback.format_exc())
            if username and self._remaining(username):
                try:
                    self._analyse_all(username)
                except EngineMissing as e:
                    self._set(error=str(e))
                except Exception as e:
                    log.error("analyse : %s", traceback.format_exc())
                    self._set(error=f"Erreur : {e}")
                if self.status["phase"] == "analyse":
                    self._set(phase="idle", message="")
            self._wake_analysis.wait(timeout=60)
            self._wake_analysis.clear()

    def _analyse_all(self, username: str):
        """Analyse tout ce qui reste. Si le nombre de Stockfish change dans les réglages, on repart avec le nouveau."""
        done = [0]
        while self._remaining(username) and not self._stop.is_set():
            self._analyse_batch(username, done)

    def _analyse_batch(self, username: str, done: list[int]):
        nodes = db.get_int("analysis_nodes")
        deep = db.get_int("deep_nodes")
        n_workers = max(1, db.get_int("workers"))
        lock = threading.Lock()
        old_before = time.time() - FULL_ANALYSIS_DAYS * 86400

        def show():
            total = done[0] + self._remaining(username)
            self._set(phase="analyse", done=done[0], total=total,
                      message=f"Analyse Stockfish : {done[0]} / {total} parties")

        def limits(gid: str, asked: bool) -> tuple[int, int]:
            """Les vieilles parties sont analysées en mode rapide (≈ 2,5× plus vite) : elles comptent moins pour le
            niveau actuel. Une partie ouverte dans l'interface a toujours droit à l'analyse complète."""
            if asked:
                return nodes, deep
            row = db.connect().execute("SELECT end_time FROM games WHERE id=?", (gid,)).fetchone()
            if row and (row["end_time"] or 0) < old_before:
                return min(nodes, FAST_NODES), min(deep, FAST_DEEP_NODES)
            return nodes, deep

        def run():
            if self._stop.is_set():
                return
            eng = open_engine()
            with self._lock:
                self._engines.add(eng)
            try:
                while not self._stop.is_set():
                    if db.get_int("workers") != n_workers:
                        return  # réglage changé : _analyse_all relance avec le bon nombre
                    gid, asked = self._next_game(username)
                    if gid is None:
                        return
                    reused = db.connect().execute("SELECT analyzed=1 AND pending_ex=1 r FROM games WHERE id=?",
                                                  (gid,)).fetchone()["r"]
                    try:
                        n, d = limits(gid, asked)
                        if not reused:
                            analysis.analyse_game(eng, gid, n)
                        exercises.generate_for_game(eng, gid, d)
                        if reused:
                            db.connect().execute("UPDATE games SET pending_ex=0, uploaded=0 WHERE id=?", (gid,))
                        else:
                            brilliance.scan_game(gid)
                    except Exception:
                        with db.transaction() as tx:
                            if self._stop.is_set():  # appli fermée en pleine analyse : à refaire la prochaine fois
                                if not reused:
                                    tx.execute("UPDATE games SET analyzed=0 WHERE id=?", (gid,))
                                return
                            log.error("analyse %s: %s", gid, traceback.format_exc())
                            if reused:  # l'analyse reprise reste bonne : seuls les exercices manquent
                                tx.execute("UPDATE games SET pending_ex=0 WHERE id=?", (gid,))
                            else:
                                tx.execute("UPDATE games SET analyzed=-1 WHERE id=?", (gid,))
                    finally:
                        with self._lock:
                            self._in_progress.discard(gid)
                    with lock:
                        done[0] += 1
                        show()
                    if done[0] % PUSH_EVERY == 0:
                        self._wake_cloud.set()
            finally:
                with self._lock:
                    self._engines.discard(eng)
                try:
                    eng.quit()
                except Exception:
                    pass

        show()
        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = [pool.submit(run) for _ in range(n_workers)]
            for f in futures:
                f.result()


    # ------------------------------------------------------------ en ligne

    def _cloud_loop(self):
        last_stats_try = 0.0
        while not self._stop.is_set():
            username = db.get_setting("username")
            st = self.status["cloud"]
            if username and cloud.base() and cloud.key():
                try:
                    with self._lock:
                        busy = set(self._in_progress)
                    ids = cloud.pending(username, busy)
                    st.update(pending=len(ids), sending=bool(ids))
                    if ids:
                        cloud.push_games(username, ids, self._stop)
                        db.set_setting("cloud_dirty", 1)
                    # Les stats repartent quand des parties ont changé (pas plus d'une fois par 10 min),
                    # et au moins deux fois par jour.
                    now = time.time()
                    age = now - float(db.get_setting("cloud_stats_at") or 0)
                    if not self._stop.is_set() and now - last_stats_try >= cloud.STATS_EVERY and (
                            (db.get_setting("cloud_dirty") == "1" and age >= cloud.STATS_EVERY)
                            or age >= cloud.STATS_REFRESH):
                        last_stats_try = now
                        st.update(sending=True)
                        cloud.push_stats(username)
                        db.set_setting("cloud_dirty", 0)
                    st.update(error=None, last=time.time())
                except cloud.CloudError as e:
                    st.update(error=str(e))
                except Exception as e:
                    log.error("envoi en ligne : %s", traceback.format_exc())
                    st.update(error=f"Erreur : {e}")
                st.update(online=cloud.online_count(username), sending=False,
                          pending=len(cloud.pending(username)))
            self._wake_cloud.wait(timeout=120)
            self._wake_cloud.clear()


worker = Worker()
