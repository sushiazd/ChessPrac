/* La base de données : le même SQLite que la version Windows (sql.js, SQLite compilé en WebAssembly), gardée en
   mémoire et sauvegardée dans IndexedDB. Les requêtes du moteur Python se portent donc telles quelles. */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS archives (url TEXT PRIMARY KEY, username TEXT, fetched_at REAL, complete INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY, username TEXT, url TEXT, end_time INTEGER, time_class TEXT, time_control TEXT, rated INTEGER,
    my_color TEXT, my_rating INTEGER, opp_name TEXT, opp_rating INTEGER, result TEXT, my_code TEXT, opp_code TEXT,
    opening TEXT, eco_url TEXT, pgn TEXT, n_plies INTEGER, cc_acc_me REAL, cc_acc_opp REAL,
    analyzed INTEGER DEFAULT 0, acc_me REAL, acc_opp REAL, n_inacc INTEGER, n_mistakes INTEGER, n_blunders INTEGER,
    reviewed INTEGER DEFAULT 0, analyzed_at REAL
);
CREATE INDEX IF NOT EXISTS games_time ON games(username, end_time DESC);
CREATE TABLE IF NOT EXISTS moves (
    game_id TEXT, ply INTEGER, san TEXT, uci TEXT, fen_before TEXT, color TEXT, mine INTEGER, clock REAL, think REAL,
    cp_before INTEGER, mate_before INTEGER, cp_after INTEGER, mate_after INTEGER,
    best_uci TEXT, best_san TEXT, pv TEXT,
    wp_before REAL, wp_after REAL, "drop" REAL, accuracy REAL,
    cls TEXT, missed INTEGER DEFAULT 0, tag TEXT, phase TEXT,
    PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS moves_fen ON moves(fen_before);
CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, game_id TEXT, ply INTEGER,
    fen TEXT, solution TEXT, accept TEXT, followup TEXT,
    played_san TEXT, best_san TEXT, gain REAL, tag TEXT, note TEXT, created_at REAL,
    box INTEGER DEFAULT 0, due REAL, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0,
    last_ok INTEGER, last_seen REAL, suspended INTEGER DEFAULT 0,
    UNIQUE (kind, game_id, ply)
);
CREATE INDEX IF NOT EXISTS exercises_due ON exercises(suspended, due);
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, exercise_id INTEGER, ts REAL, ok INTEGER);
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
`;

const MIGRATIONS = [
  'ALTER TABLE activity ADD COLUMN conversions INTEGER DEFAULT 0',
  'ALTER TABLE attempts ADD COLUMN secs REAL',
  'ALTER TABLE exercises ADD COLUMN last_secs REAL',
  'ALTER TABLE moves ADD COLUMN special TEXT',
  'ALTER TABLE games ADD COLUMN specials_done INTEGER DEFAULT 0',
  'ALTER TABLE games ADD COLUMN uploaded INTEGER DEFAULT 0',      // 1 = déjà envoyée en ligne dans cet état
  'ALTER TABLE games ADD COLUMN pending_ex INTEGER DEFAULT 0',    // analyse reprise d'en ligne, exercices à faire
];

/* Les réglages par défaut. Le moteur tourne en WebAssembly (plus lent que Stockfish natif) : on regarde moins de
   nœuds par position que sur Windows. */
const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
export const DEFAULTS = {
  username: '',
  analysis_nodes: '50000',
  deep_nodes: '250000',
  new_per_day: '15',
  workers: String(Math.max(1, Math.min(4, Math.floor(cores / 2)))),
  lichess_token: '',
  cloud_key: '',
  auto_sync_minutes: '30',
};

const IDB_NAME = 'chessprac';
const IDB_STORE = 'files';
const IDB_KEY = 'db';
const SAVE_DELAY = 4000;    // regroupe les écritures
const SAVE_MAX_WAIT = 30000;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(bytes, key = IDB_KEY) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const dbState = { notice: '', persistent: false, lastSave: 0, saveError: null };

let SQL = null;
let conn = null;
let depth = 0;
let dirty = false;
let firstDirtyAt = 0;
let timer = null;
let saving = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Impossible de charger ${url}`));
    document.head.appendChild(s);
  });
}

export async function init(sqlJsUrl, sqlWasmUrl) {
  if (conn) return conn;
  if (!globalThis.initSqlJs) await loadScript(sqlJsUrl);   // sql.js est un script classique (UMD)
  SQL = await globalThis.initSqlJs({ locateFile: () => sqlWasmUrl });
  let bytes = null;
  try { bytes = await idbGet(); dbState.persistent = true; } catch (e) { dbState.persistent = false; }
  if (bytes) {
    try {
      conn = new SQL.Database(bytes);
      conn.exec('SELECT COUNT(*) FROM sqlite_master');
    } catch (e) {
      conn = null;
      dbState.notice = 'La base enregistrée dans ce navigateur était illisible : elle a été mise de côté et tout repart de zéro.';
      try { await idbPut(bytes, `${IDB_KEY}-illisible-${Date.now()}`); } catch { /* rien */ }
    }
  }
  if (!conn) conn = new SQL.Database();
  conn.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try { conn.exec(sql); } catch (e) { /* colonne déjà là */ }
  }
  window.addEventListener('pagehide', () => { save(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  return conn;
}

function bind(params) {
  return (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
}

function touch() {
  if (!dirty) firstDirtyAt = Date.now();
  dirty = true;
  if (timer) clearTimeout(timer);
  const wait = Math.max(0, Math.min(SAVE_DELAY, SAVE_MAX_WAIT - (Date.now() - firstDirtyAt)));
  timer = setTimeout(save, wait);
}

/** Écrit la base dans IndexedDB (si elle a changé). */
export function save() {
  if (!conn || !dirty) return saving || Promise.resolve();
  if (timer) { clearTimeout(timer); timer = null; }
  if (depth) { touch(); return Promise.resolve(); }
  dirty = false;
  const bytes = conn.export();
  saving = (saving || Promise.resolve()).then(() => idbPut(bytes)).then(() => {
    dbState.lastSave = Date.now() / 1000;
    dbState.saveError = null;
  }).catch((e) => {
    dbState.saveError = String((e && e.message) || e);
    dirty = true;
  });
  return saving;
}

export function exportBytes() {
  return conn.export();
}

/** Remplace toute la base (import d'une sauvegarde). */
export async function importBytes(bytes) {
  const next = new SQL.Database(bytes);
  next.exec('SELECT COUNT(*) FROM games');   // refuse un fichier qui n'est pas une base ChessPrac
  next.exec(SCHEMA);
  for (const sql of MIGRATIONS) { try { next.exec(sql); } catch (e) { /* déjà là */ } }
  conn.close();
  conn = next;
  dirty = true;
  await save();
}

export async function wipe() {
  conn.close();
  conn = new SQL.Database();
  conn.exec(SCHEMA);
  dirty = true;
  await save();
}

// ---------------------------------------------------------------- requêtes

export function all(sql, params) {
  const stmt = conn.prepare(sql);
  try {
    stmt.bind(bind(params));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}
export function get(sql, params) {
  return all(sql, params)[0] || null;
}
/** Écriture : renvoie le nombre de lignes modifiées. */
export function run(sql, params) {
  conn.run(sql, bind(params));
  touch();
  return conn.getRowsModified();
}
export function runMany(sql, rows) {
  const stmt = conn.prepare(sql);
  try {
    for (const p of rows) { stmt.run(bind(p)); }
  } finally {
    stmt.free();
  }
  touch();
}
export function lastId() {
  return get('SELECT last_insert_rowid() AS id').id;
}

/** Écriture groupée, annulée en cas d'erreur. `fn` est synchrone : aucun `await` dedans. */
export function transaction(fn) {
  if (depth > 0) return fn();
  conn.run('BEGIN');
  depth++;
  try {
    const r = fn();
    conn.run('COMMIT');
    depth--;
    touch();
    return r;
  } catch (e) {
    depth--;
    try { conn.run('ROLLBACK'); } catch { /* rien */ }
    throw e;
  }
}

// ---------------------------------------------------------------- réglages, activité

export function getSetting(key) {
  const r = get('SELECT value FROM settings WHERE key=?', [key]);
  if (r && r.value !== null && r.value !== undefined) return r.value;
  return DEFAULTS[key] || '';
}
export function getInt(key) {
  const v = parseInt(parseFloat(getSetting(key)), 10);
  return Number.isNaN(v) ? parseInt(DEFAULTS[key], 10) : v;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const now = () => Date.now() / 1000;
/** La journée d'entraînement bascule à 4 h du matin, comme les applis de révision. */
export function today() { return ymd(new Date(Date.now() - 4 * 3600 * 1000)); }

const ACTIVITY_FIELDS = new Set(['ex_done', 'ex_ok', 'drill_done', 'drill_ok', 'reviews', 'endgames', 'conversions']);
export function bumpActivity(field, n = 1) {
  if (!ACTIVITY_FIELDS.has(field)) throw new Error(field);
  run(`INSERT INTO activity(day, ${field}) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    [today(), n]);
}
