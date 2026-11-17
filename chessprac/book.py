"""Coups de théorie : les positions des ouvertures répertoriées (base « chess-openings » de Lichess, domaine public,
data/ouvertures/*.tsv). Un coup est « Théorie » tant que la partie reste dans ces lignes connues."""
import csv
import io
import threading

import chess
import chess.pgn

from . import config

_lock = threading.Lock()
_positions: dict[str, str] | None = None  # position (EPD) -> nom de l'ouverture la plus précise qui y passe


def positions() -> dict[str, str]:
    global _positions
    with _lock:
        if _positions is not None:
            return _positions
        found: dict[str, tuple[int, str]] = {}
        for path in sorted((config.DATA / "ouvertures").glob("*.tsv")):
            with open(path, encoding="utf-8") as f:
                for row in csv.DictReader(f, delimiter="\t"):
                    game = chess.pgn.read_game(io.StringIO(row["pgn"]))
                    if game is None:
                        continue
                    board = game.board()
                    moves = list(game.mainline_moves())
                    for i, mv in enumerate(moves):
                        board.push(mv)
                        key = board.epd()
                        # Le nom retenu pour une position : celui de la ligne qui s'y arrête (le plus précis).
                        depth = len(moves) if i == len(moves) - 1 else 10_000 + len(moves)
                        if key not in found or depth < found[key][0]:
                            found[key] = (depth, row["name"])
        _positions = {k: v[1] for k, v in found.items()}
        return _positions


EARLY_PLIES = 8      # les 4 premiers coups de chaque camp : un coup sain y est « de la théorie »
EARLY_MAX_DROP = 6   # ... s'il ne perd presque rien selon Stockfish


def book_plies(fens_after: list[str], drops: list[float | None] | None = None) -> list[str | None]:
    """Pour chaque coup de la partie (position après le coup) : le nom d'ouverture si c'est encore de la théorie,
    sinon None. La théorie s'arrête au premier coup qui en sort.

    La base ne contient que les lignes qui portent un nom : pour ne pas sortir de la théorie dès le 2e coup sur une
    simple inversion, un coup sain des 4 premiers coups compte aussi (le nom reste celui de la dernière ligne connue).
    """
    known = positions()
    out: list[str | None] = []
    inside, last_name = True, None
    for i, fen in enumerate(fens_after):
        if not inside:
            out.append(None)
            continue
        name = known.get(" ".join(fen.split()[:4]))
        drop = drops[i] if drops is not None and i < len(drops) else None
        if name is None and i < EARLY_PLIES and drop is not None and drop < EARLY_MAX_DROP:
            name = last_name or "Début de partie"
        if name is None:
            inside = False
        else:
            last_name = name
        out.append(name)
    return out
