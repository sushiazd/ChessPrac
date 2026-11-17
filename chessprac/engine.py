"""Stockfish local et calculs d'évaluation (pourcentage de gain, précision)."""
import math
import threading

import chess
import chess.engine

from . import config

MATE_CP = 10000


class EngineMissing(Exception):
    pass


def open_engine(threads: int = 1, hash_mb: int = 64) -> chess.engine.SimpleEngine:
    path = config.stockfish_path()
    if not path:
        raise EngineMissing("Stockfish est introuvable (dossier engine\\stockfish.exe).")
    import subprocess
    kwargs = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    eng = chess.engine.SimpleEngine.popen_uci(path, **kwargs)
    eng.configure({"Threads": threads, "Hash": hash_mb})
    return eng


def win_pct(cp: float) -> float:
    """Chances de gain (0-100) du joueur qui a l'avantage cp, formule de Lichess."""
    cp = max(-1000.0, min(1000.0, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(drop: float) -> float:
    """Précision d'un coup selon la perte de chances de gain (formule de Lichess)."""
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * max(0.0, drop)) - 3.1669 + 1))


def score_cp(score: chess.engine.PovScore | chess.engine.Score, pov: chess.Color = chess.WHITE) -> tuple[int, int | None]:
    """(centipions, mat) vus par pov. Un mat devient ±10000 moins sa distance."""
    s = score.pov(pov) if isinstance(score, chess.engine.PovScore) else score
    mate = s.mate()
    if mate is not None:
        if mate == 0:  # déjà maté : celui qui doit jouer a perdu
            return -MATE_CP, 0
        cp = MATE_CP - 10 * abs(mate)
        return (cp if mate > 0 else -cp), mate
    return int(s.score()), None


def terminal_eval(board: chess.Board) -> tuple[int, int | None] | None:
    """Évaluation (vue par les Blancs) d'une position finie, sinon None."""
    if board.is_checkmate():
        return (-MATE_CP if board.turn == chess.WHITE else MATE_CP), 0
    if board.is_stalemate() or board.is_insufficient_material():
        return 0, None
    return None


def wp_for(cp_white: int, color: chess.Color) -> float:
    return win_pct(cp_white if color == chess.WHITE else -cp_white)


class SharedEngine:
    """Un Stockfish pour l'interface (analyse à la demande, adversaire des finales), utilisé chacun son tour."""

    def __init__(self):
        self._lock = threading.Lock()
        self._eng = None

    def _get(self):
        if self._eng is None:
            self._eng = open_engine(threads=2, hash_mb=128)
        return self._eng

    def analyse(self, board: chess.Board, nodes: int, multipv: int = 1):
        with self._lock:
            try:
                return self._get().analyse(board, chess.engine.Limit(nodes=nodes), multipv=multipv)
            except chess.engine.EngineTerminatedError:
                self._eng = None
                return self._get().analyse(board, chess.engine.Limit(nodes=nodes), multipv=multipv)

    def play(self, board: chess.Board, nodes: int) -> chess.Move:
        with self._lock:
            try:
                return self._get().play(board, chess.engine.Limit(nodes=nodes)).move
            except chess.engine.EngineTerminatedError:
                self._eng = None
                return self._get().play(board, chess.engine.Limit(nodes=nodes)).move

    def close(self):
        with self._lock:
            if self._eng is not None:
                try:
                    self._eng.quit()
                except Exception:
                    pass
                self._eng = None


shared = SharedEngine()
