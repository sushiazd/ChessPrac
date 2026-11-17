"""Base SQLite : une connexion par fil d'exécution (le serveur et l'analyse tournent en parallèle)."""
import sqlite3
import threading
import time

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
"""

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def connect() -> sqlite3.Connection:
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    config.HOME.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    with _init_lock:
        if not _initialized:
            conn.executescript(SCHEMA)
            _initialized = True
    _local.conn = conn
    return conn


def reset_for_tests() -> None:
    """Oublie les connexions (les tests changent de base)."""
    global _initialized
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _initialized = False


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
    assert field in {"ex_done", "ex_ok", "drill_done", "drill_ok", "reviews", "endgames"}
    connect().execute(f"INSERT INTO activity(day, {field}) VALUES(?, ?) "
                      f"ON CONFLICT(day) DO UPDATE SET {field} = {field} + excluded.{field}", (today(), n))
