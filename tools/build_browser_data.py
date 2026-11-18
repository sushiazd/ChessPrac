"""Génère les deux petits fichiers de données de la version navigateur (web/browser/data/) :

- book.json  : les positions de théorie (data/ouvertures/*.tsv), regroupées par nom d'ouverture ;
- traps.json : les pièges d'ouverture de trapfinder (data/pieges/*.pgn), prêts à devenir des exercices.

À relancer seulement si ces données changent :  python tools/build_browser_data.py
"""
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import chess.pgn  # noqa: E402

from chessprac import book, config  # noqa: E402

OUT = ROOT / "web" / "browser" / "data"


def build_book() -> None:
    groups: dict[str, list[str]] = {}
    for key, name in book.positions().items():
        groups.setdefault(name, []).append(key)
    names = sorted(groups)
    data = {"names": names, "groups": [sorted(groups[n]) for n in names]}
    (OUT / "book.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"book.json : {sum(len(g) for g in data['groups'])} positions, {len(names)} noms")


def build_traps() -> None:
    """Même lecture que chessprac.exercises.import_traps, sans base de données."""
    traps = []
    for path in sorted(config.TRAPS_DIR.glob("*.pgn")):
        stream = io.StringIO(path.read_text(encoding="utf-8", errors="replace"))
        idx = 0
        while True:
            game = chess.pgn.read_game(stream)
            if game is None:
                break
            idx += 1
            moves = list(game.mainline_moves())
            if len(moves) < 2:
                continue
            board = game.board()
            for m in moves[:-1]:
                board.push(m)
            refutation = moves[-1]
            comment = ""
            for n in game.mainline():
                if n.move == moves[-2]:
                    comment = n.comment.strip()
            note = comment.split(";")[0].strip() if comment else ""
            err_board = board.copy()
            err_board.pop()
            traps.append({"gid": f"piege:{path.stem}:{idx}", "ply": len(moves) - 1, "fen": board.fen(),
                          "solution": refutation.uci(), "played_san": err_board.san(moves[-2]),
                          "best_san": board.san(refutation), "note": note})
    (OUT / "traps.json").write_text(json.dumps(traps, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"traps.json : {len(traps)} pièges")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build_book()
    build_traps()
