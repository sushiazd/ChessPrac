-- Base en ligne (Cloudflare D1) : seulement ce qui se consulte. L'entraînement reste sur le PC.
CREATE TABLE IF NOT EXISTS accounts (
    name TEXT PRIMARY KEY,      -- pseudo chess.com en minuscules
    display TEXT,               -- pseudo avec ses majuscules
    ratings TEXT,               -- JSON : Elo chess.com par cadence
    n_games INTEGER DEFAULT 0,
    updated REAL
);

CREATE TABLE IF NOT EXISTS account_games (
    account TEXT,
    game_id TEXT,               -- uuid chess.com : le même pour les deux joueurs
    end_time INTEGER,
    row TEXT,                   -- JSON : la ligne de la liste des parties (point de vue du compte)
    payload TEXT,               -- JSON : la revue coup par coup (coups, évaluations, types de coups)
    updated REAL,
    PRIMARY KEY (account, game_id)
);
CREATE INDEX IF NOT EXISTS account_games_game ON account_games(game_id);

CREATE TABLE IF NOT EXISTS account_stats (
    account TEXT,
    key TEXT,                   -- « cadence|jours », ex. « blitz|90 », « | » pour tout
    data TEXT,
    updated REAL,
    PRIMARY KEY (account, key)
);
