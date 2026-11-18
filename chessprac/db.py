"""Base SQLite : une connexion par fil d'exécution (le serveur et l'analyse tournent en parallèle)."""
import logging
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS archives (
    url TEXT PRIMARY KEY, username TEXT, fetched_at REAL, complete INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    username TEXT,
    url TEXT,
    end_time INTEGER,
    time_class TEXT,
    time_control TEXT,
    rated INTEGER,
    my_color TEXT,              -- 'w' ou 'b'
    my_rating INTEGER,
    opp_name TEXT,
    opp_rating INTEGER,
    result TEXT,                -- 'win', 'loss', 'draw' (de mon point de vue)
    my_code TEXT,               -- code chess.com : win, checkmated, resigned, timeout...
    opp_code TEXT,
    opening TEXT,
    eco_url TEXT,
    pgn TEXT,
    n_plies INTEGER,
    cc_acc_me REAL,             -- précision donnée par chess.com (si dispo)
    cc_acc_opp REAL,
    analyzed INTEGER DEFAULT 0, -- 0 à faire, 1 fait, -1 erreur, 2 analyse demandée en priorité
    acc_me REAL,
    acc_opp REAL,
    n_inacc INTEGER, n_mistakes INTEGER, n_blunders INTEGER,
    reviewed INTEGER DEFAULT 0,
    analyzed_at REAL
);
CREATE INDEX IF NOT EXISTS games_time ON games(username, end_time DESC);

CREATE TABLE IF NOT EXISTS moves (
    game_id TEXT, ply INTEGER,      -- ply 1 = premier coup des Blancs
    san TEXT, uci TEXT, fen_before TEXT, color TEXT, mine INTEGER,
    clock REAL, think REAL,
    cp_before INTEGER, mate_before INTEGER, cp_after INTEGER, mate_after INTEGER,  -- vus par les Blancs
    best_uci TEXT, best_san TEXT, pv TEXT,
    wp_before REAL, wp_after REAL, "drop" REAL, accuracy REAL,                    -- vus par le joueur qui joue
    cls TEXT, missed INTEGER DEFAULT 0, tag TEXT, phase TEXT,
    PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS moves_fen ON moves(fen_before);

CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,                  -- best, threat, punish, trap
    game_id TEXT, ply INTEGER,
    fen TEXT, solution TEXT, accept TEXT, followup TEXT,
    played_san TEXT, best_san TEXT, gain REAL, tag TEXT, note TEXT,
    created_at REAL,
    box INTEGER DEFAULT 0, due REAL, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0,
    last_ok INTEGER, last_seen REAL, suspended INTEGER DEFAULT 0,
    UNIQUE (kind, game_id, ply)
);
CREATE INDEX IF NOT EXISTS exercises_due ON exercises(suspended, due);

CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, exercise_id INTEGER, ts REAL, ok INTEGER
);

CREATE TABLE IF NOT EXISTS rep_moves (color TEXT, key TEXT, uci TEXT, PRIMARY KEY (color, key));
CREATE TABLE IF NOT EXISTS rep_opp (color TEXT, key TEXT, uci TEXT, PRIMARY KEY (color, key, uci));
CREATE TABLE IF NOT EXISTS rep_cards (
    color TEXT, key TEXT, box INTEGER DEFAULT 0, due REAL, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0,
    PRIMARY KEY (color, key)
);

CREATE TABLE IF NOT EXISTS pos_cache (key TEXT PRIMARY KEY, nodes INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS explorer_cache (key TEXT PRIMARY KEY, fetched_at REAL, data TEXT);

CREATE TABLE IF NOT EXISTS endgame_results (id TEXT, ts REAL, ok INTEGER);

CREATE TABLE IF NOT EXISTS activity (
    day TEXT PRIMARY KEY, ex_done INTEGER DEFAULT 0, ex_ok INTEGER DEFAULT 0,
    drill_done INTEGER DEFAULT 0, drill_ok INTEGER DEFAULT 0, reviews INTEGER DEFAULT 0, endgames INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT UNIQUE, ply INTEGER, fen TEXT, wp REAL,
    created_at REAL, due REAL, tries INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, last_ok INTEGER
);
"""

# Colonnes ajoutées après la première version : ajoutées aux bases existantes au démarrage.
MIGRATIONS = [
    "ALTER TABLE activity ADD COLUMN conversions INTEGER DEFAULT 0",
    "ALTER TABLE attempts ADD COLUMN secs REAL",       # temps mis pour trouver
    "ALTER TABLE exercises ADD COLUMN last_secs REAL",
    "ALTER TABLE moves ADD COLUMN special TEXT",                     # brilliant (!!) ou great (!)
    "ALTER TABLE games ADD COLUMN specials_done INTEGER DEFAULT 0",
    "ALTER TABLE games ADD COLUMN uploaded INTEGER DEFAULT 0",      # 1 = déjà envoyée en ligne dans cet état
    "ALTER TABLE games ADD COLUMN pending_ex INTEGER DEFAULT 0",    # analyse reprise d'en ligne, exercices à faire
]

_local = threading.local()
_init_lock = threading.Lock()
_write_lock = threading.RLock()
_initialized = False
notice = ""  # message pour l'interface (base réparée, données déplacées...)
log = logging.getLogger("chessprac")
BACKUPS_KEPT = 7
BACKUP_EVERY = 20 * 3600


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=60, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def connect() -> sqlite3.Connection:
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    config.HOME.mkdir(parents=True, exist_ok=True)
    conn = _open(config.DB_PATH)
    with _init_lock:
        if not _initialized:
            conn.executescript(SCHEMA)
            for sql in MIGRATIONS:
                try:
                    conn.execute(sql)
                except sqlite3.OperationalError:
                    pass  # colonne déjà là
            _initialized = True
    _local.conn = conn
    return conn


@contextmanager
def transaction():
    """Écriture groupée : une seule à la fois dans l'appli, annulée proprement en cas d'erreur."""
    conn = connect()
    with _write_lock:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def reset_for_tests() -> None:
    """Oublie les connexions (les tests changent de base)."""
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _initialized = False


# ---------------------------------------------------------------- santé de la base, sauvegardes

def _healthy(path: Path) -> bool:
    try:
        c = sqlite3.connect(path, timeout=60)
        try:
            return c.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        finally:
            c.close()
    except sqlite3.DatabaseError:
        return False


def _copy(src: Path, dst: Path) -> None:
    """Copie cohérente d'une base SQLite ouverte (API de sauvegarde, journal WAL compris)."""
    a, b = sqlite3.connect(src, timeout=60), sqlite3.connect(dst)
    try:
        a.backup(b)
    finally:
        a.close()
        b.close()


def _set_aside(path: Path, why: str) -> Path:
    folder = config.HOME / f"{why}-{time.strftime('%Y%m%d-%H%M%S')}"
    folder.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(path) + suffix)
        if f.exists():
            shutil.move(str(f), folder / f.name)
    return folder


def backups() -> list[Path]:
    return sorted((config.HOME / "sauvegardes").glob("chessprac-*.db"), reverse=True)


def backup_now() -> Path | None:
    if not config.DB_PATH.exists():
        return None
    folder = config.HOME / "sauvegardes"
    folder.mkdir(parents=True, exist_ok=True)
    dst = folder / f"chessprac-{time.strftime('%Y%m%d-%H%M%S')}.db"
    with _write_lock:
        _copy(config.DB_PATH, dst)
    for old in backups()[BACKUPS_KEPT:]:
        old.unlink(missing_ok=True)
    return dst


def backup_if_due() -> None:
    last = backups()
    if not last or time.time() - last[0].stat().st_mtime > BACKUP_EVERY:
        try:
            backup_now()
        except (sqlite3.Error, OSError) as e:
            log.error("sauvegarde impossible : %s", e)


def prepare() -> None:
    """Au démarrage : reprend les anciennes données, vérifie la base, la répare depuis une sauvegarde si besoin."""
    global notice
    config.HOME.mkdir(parents=True, exist_ok=True)
    legacy = config.LEGACY_DB_PATH
    if not config.DB_PATH.exists() and legacy and legacy.exists() and legacy != config.DB_PATH:
        if _healthy(legacy):
            _copy(legacy, config.DB_PATH)
            notice = "Tes données ont été déplacées dans un dossier plus sûr."
            log.info("base reprise depuis %s", legacy)
    if config.DB_PATH.exists() and not _healthy(config.DB_PATH):
        aside = _set_aside(config.DB_PATH, "abimee")
        log.error("base abîmée, mise de côté dans %s", aside)
        for b in backups():
            if _healthy(b):
                _copy(b, config.DB_PATH)
                when = time.strftime("%d/%m à %H:%M", time.localtime(b.stat().st_mtime))
                notice = f"La base était abîmée : elle a été restaurée depuis la sauvegarde du {when}."
                break
        else:
            notice = "La base était abîmée et aucune sauvegarde n'était utilisable : tes parties vont être re-téléchargées."
    connect()
    backup_if_due()


def checkpoint() -> None:
    """Avant de quitter : tout est écrit dans le fichier principal, le journal WAL est vidé."""
    with _write_lock:
        try:
            connect().execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error as e:
            log.error("checkpoint : %s", e)


def get_setting(key: str) -> str:
    row = connect().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is not None and row["value"] is not None:
        return row["value"]
    return config.DEFAULTS.get(key, "")


def get_int(key: str) -> int:
    try:
        return int(float(get_setting(key)))
    except ValueError:
        return int(config.DEFAULTS[key])


def set_setting(key: str, value) -> None:
    connect().execute("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (key, str(value)))


def today() -> str:
    # La journée d'entraînement bascule à 4 h du matin, comme les applis de révision.
    return time.strftime("%Y-%m-%d", time.localtime(time.time() - 4 * 3600))


def bump_activity(field: str, n: int = 1) -> None:
    assert field in {"ex_done", "ex_ok", "drill_done", "drill_ok", "reviews", "endgames", "conversions"}
    connect().execute(f"INSERT INTO activity(day, {field}) VALUES(?, ?) "
                      f"ON CONFLICT(day) DO UPDATE SET {field} = {field} + excluded.{field}", (today(), n))
