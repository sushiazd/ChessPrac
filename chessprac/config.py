"""Chemins et réglages par défaut."""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
TRAPS_DIR = DATA / "pieges"
# La base vit hors de OneDrive (sa synchro verrouille ou duplique les fichiers SQLite ouverts) et hors d'AppData :
# Windows y redirige en silence les écritures des applis « empaquetées » (Microsoft Store, MSIX) vers un dossier
# privé, ce qui donnait deux bases différentes selon d'où l'appli était lancée.
HOME = Path(os.environ.get("CHESSPRAC_HOME") or Path.home() / ".chessprac")
DB_PATH = HOME / "chessprac.db"
# Ancien emplacement (versions du 17/11/2026) : repris automatiquement au premier lancement.
LEGACY_DB_PATH = None if os.environ.get("CHESSPRAC_HOME") else \
    Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "ChessPrac" / "chessprac.db"
LOG_PATH = HOME / "chessprac.log"
PORT = int(os.environ.get("CHESSPRAC_PORT", "47820"))

# ChessPrac en ligne : les analyses et les stats de chaque compte, lisibles depuis n'importe quel appareil
# (cloud/worker.js). Lecture libre ; pour envoyer, il faut la clé (Réglages, ou le fichier cle-en-ligne.txt).
CLOUD_URL = os.environ.get("CHESSPRAC_CLOUD", "https://chessprac.sushi-adouane.workers.dev")
if CLOUD_URL.lower() in ("off", "0", "non"):  # CHESSPRAC_CLOUD=off : rien en ligne (tests)
    CLOUD_URL = ""
CLOUD_KEY_FILE = ROOT / "cle-en-ligne.txt"

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
    "cloud_key": "",
}


def stockfish_path() -> str | None:
    env = os.environ.get("CHESSPRAC_STOCKFISH")
    if env and Path(env).exists():
        return env
    local = ROOT / "engine" / "stockfish.exe"
    if local.exists():
        return str(local)
    return shutil.which("stockfish")
