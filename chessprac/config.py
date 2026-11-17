"""Chemins et réglages par défaut."""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
TRAPS_DIR = DATA / "pieges"
# La base vit hors de OneDrive : la synchro de OneDrive verrouille ou duplique les fichiers SQLite ouverts.
HOME = Path(os.environ.get("CHESSPRAC_HOME") or Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "ChessPrac")
DB_PATH = HOME / "chessprac.db"
LOG_PATH = HOME / "chessprac.log"
PORT = int(os.environ.get("CHESSPRAC_PORT", "47820"))

# L'API publique de chess.com demande un User-Agent qui identifie l'outil (sans données perso).
USER_AGENT = "ChessPrac/1.0 (outil perso d'entrainement hors ligne)"

DEFAULTS = {
    "username": "",
    "analysis_nodes": "200000",   # par position, pour l'analyse de fond de chaque partie
    "deep_nodes": "1000000",      # pour vérifier chaque erreur avant d'en faire un exercice
    "new_per_day": "15",          # nouveaux exercices par jour
    "workers": str(max(1, min(6, (os.cpu_count() or 4) // 2))),
    "lichess_token": "",
    "auto_sync_minutes": "30",
}


def stockfish_path() -> str | None:
    env = os.environ.get("CHESSPRAC_STOCKFISH")
    if env and Path(env).exists():
        return env
    local = ROOT / "engine" / "stockfish.exe"
    if local.exists():
        return str(local)
    return shutil.which("stockfish")
