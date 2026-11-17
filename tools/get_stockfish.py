"""Télécharge Stockfish 19 (version officielle, GitHub) dans engine\\stockfish.exe.

Le moteur pèse ~100 Mo, trop lourd pour le dépôt GitHub : lancer.bat appelle ce script au premier lancement.
Usage : .venv\\Scripts\\python tools\\get_stockfish.py [chemin_de_sortie]
"""
import platform
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/"
# Les versions « universal » choisissent elles-mêmes les instructions du processeur (AVX2, AVX-512...).
ASSET = "stockfish-windows-arm64-universal.zip" if platform.machine().upper() == "ARM64" \
    else "stockfish-windows-x86-64-universal.zip"


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "engine" / "stockfish.exe"
    if out.exists():
        print("Stockfish est déjà là :", out)
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Téléchargement de Stockfish 19 (~80 Mo) depuis GitHub...")
    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / ASSET
        req = urllib.request.Request(BASE + ASSET, headers={"User-Agent": "ChessPrac"})
        with urllib.request.urlopen(req, timeout=60) as r, open(zpath, "wb") as f:
            size = int(r.headers.get("Content-Length") or 0)
            done = 0
            while chunk := r.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if size:
                    print(f"\r  {done * 100 // size} %", end="", flush=True)
        print()
        with zipfile.ZipFile(zpath) as z:
            exes = [i for i in z.infolist() if i.filename.lower().endswith(".exe")]
            if not exes:
                print("Archive inattendue : aucun .exe dedans.")
                return 1
            best = max(exes, key=lambda i: i.file_size)
            with z.open(best) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    print("OK ->", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
