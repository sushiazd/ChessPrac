"""Travail de fond : synchro chess.com puis analyse Stockfish des parties, des plus récentes aux plus anciennes."""
import logging
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import analysis, chesscom, db, exercises
from .engine import EngineMissing, open_engine

log = logging.getLogger("chessprac")


class Worker:
    def __init__(self):
        self.status = {"phase": "idle", "done": 0, "total": 0, "message": "", "error": None, "last_sync": None,
                       "new_games": 0}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self.priority: list[str] = []

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="chessprac-worker", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def kick(self, game_id: str | None = None):
        if game_id:
            with self._lock:
                if game_id not in self.priority:
                    self.priority.insert(0, game_id)
        self._wake.set()

    def _set(self, **kw):
        self.status.update(kw)

    def _run(self):
        while not self._stop.is_set():
            username = db.get_setting("username")
            if username:
                try:
                    self._cycle(username)
                    self._set(error=None)
                except chesscom.ChessComError as e:
                    self._set(error=str(e))
                except EngineMissing as e:
                    self._set(error=str(e))
                except Exception as e:  # on ne laisse jamais mourir le fil de fond
                    log.error("cycle: %s", traceback.format_exc())
                    self._set(error=f"Erreur : {e}")
                self._set(phase="idle", message="")
            wait = max(5, db.get_int("auto_sync_minutes")) * 60
            self._wake.wait(timeout=wait)
            self._wake.clear()

    def _cycle(self, username: str):
        conn = db.connect()
        self._set(phase="sync", done=0, total=0, message="Connexion à chess.com…")
        added = chesscom.sync(username, lambda d, t, m: self._set(done=d, total=t, message=m))
        self._set(last_sync=time.time(), new_games=added)
        try:
            st = chesscom.player_stats(username) or {}
            ratings = {k.replace("chess_", ""): {"rating": v["last"]["rating"], "best": (v.get("best") or {}).get("rating")}
                       for k, v in st.items() if k.startswith("chess_") and isinstance(v, dict) and "last" in v}
            if "tactics" in st:
                ratings["puzzles"] = {"rating": (st["tactics"].get("highest") or {}).get("rating"), "best": None}
            import json
            db.set_setting("cc_stats", json.dumps(ratings))
        except chesscom.ChessComError:
            pass
        if conn.execute("SELECT COUNT(*) n FROM exercises WHERE kind='trap'").fetchone()["n"] == 0:
            exercises.import_traps(username)
        self._analyse_all(username)

    def _todo(self, username: str) -> list[str]:
        rows = db.connect().execute(
            "SELECT id FROM games WHERE username=? AND analyzed IN (0, 2) ORDER BY analyzed DESC, end_time DESC",
            (username.lower(),)).fetchall()
        ids = [r["id"] for r in rows]
        with self._lock:
            pri = [g for g in self.priority if g in ids]
            self.priority = []
        return pri + [g for g in ids if g not in pri]

    def _analyse_all(self, username: str):
        """Analyse tout ce qui reste. Si le nombre de Stockfish change dans les réglages, on repart avec le nouveau."""
        todo = self._todo(username)
        total, done = len(todo), [0]
        while todo and not self._stop.is_set():
            self._analyse_batch(todo, total, done)
            todo = self._todo(username)
            total = max(total, done[0] + len(todo))

    def _analyse_batch(self, todo: list[str], total: int, done: list[int]):
        nodes = db.get_int("analysis_nodes")
        deep = db.get_int("deep_nodes")
        n_workers = max(1, db.get_int("workers"))
        self._set(phase="analyse", done=done[0], total=total,
                  message=f"Analyse Stockfish : {done[0]} / {total} parties")
        queue = list(todo)
        qlock = threading.Lock()

        def take():
            with qlock:
                # Une partie demandée depuis l'interface passe devant.
                with self._lock:
                    while self.priority:
                        g = self.priority.pop(0)
                        if g in queue:
                            queue.remove(g)
                            return g
                return queue.pop(0) if queue else None

        def run():
            eng = open_engine()
            try:
                while not self._stop.is_set():
                    if db.get_int("workers") != n_workers:
                        return  # réglage changé : _analyse_all relance avec le bon nombre
                    gid = take()
                    if gid is None:
                        return
                    try:
                        analysis.analyse_game(eng, gid, nodes)
                        exercises.generate_for_game(eng, gid, deep)
                    except Exception:
                        log.error("analyse %s: %s", gid, traceback.format_exc())
                        db.connect().execute("UPDATE games SET analyzed=-1 WHERE id=?", (gid,))
                    with qlock:
                        done[0] += 1
                        self._set(done=done[0], message=f"Analyse Stockfish : {done[0]} / {total} parties")
            finally:
                try:
                    eng.quit()
                except Exception:
                    pass

        with ThreadPoolExecutor(max_workers=n_workers) as pool:
            futures = [pool.submit(run) for _ in range(n_workers)]
            for f in futures:
                f.result()


worker = Worker()
