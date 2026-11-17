"""Tests rapides, sans réseau ni Stockfish : calculs, découpage des parties, répétition espacée, répertoire."""
import json
import time

import chess
import pytest

from chessprac import analysis, chesscom, config, db, exercises, repertoire
from chessprac.engine import move_accuracy, win_pct

PGN = """[Event "Live Chess"]
[TimeControl "180+2"]

1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:58]} 2. Nf3 {[%clk 0:02:55]} 2... Nc6 {[%clk 0:02:50]}
3. Bc4 {[%clk 0:02:50]} 3... Nd4 {[%clk 0:02:40]} 4. Nxe5 {[%clk 0:02:45]} 4... Qg5 {[%clk 0:02:30]} 1-0
"""


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HOME", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.reset_for_tests()
    repertoire._cache.clear()
    yield
    db.reset_for_tests()


def test_win_pct_and_accuracy():
    assert win_pct(0) == pytest.approx(50)
    assert win_pct(1000) > 97 and win_pct(-1000) < 3
    assert move_accuracy(0) == 100
    assert move_accuracy(30) < 30


def test_classify():
    assert analysis.classify(0, True) == "best"
    assert analysis.classify(12, False) == "inaccuracy"
    assert analysis.classify(25, False) == "mistake"
    assert analysis.classify(45, False) == "blunder"


def test_time_control_and_outcome():
    assert chesscom.parse_time_control("180+2") == (180, 2)
    assert chesscom.parse_time_control("1/86400") == (None, 0)
    assert chesscom.outcome("repetition") == "draw"
    assert chesscom.outcome("checkmated") == "loss"
    assert chesscom.opening_name("https://www.chess.com/openings/Queens-Pawn-Opening-Accelerated-London-System-2...c5") \
        == "Queen's Pawn Opening Accelerated London System"


def test_moves_from_pgn_clocks():
    rows = chesscom.moves_from_pgn(PGN, "180+2", "w")
    assert [r["san"] for r in rows] == ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4", "Nxe5", "Qg5"]
    assert rows[0]["mine"] == 1 and rows[1]["mine"] == 0
    assert rows[2]["think"] == pytest.approx(7)  # 180 + 2 - 175
    assert rows[5]["think"] == pytest.approx(12)  # 170 + 2 - 160


def store(gid="g1", color="w", result="win", end=None):
    g = {"uuid": gid, "url": "u", "end_time": end or int(time.time()), "time_class": "blitz", "time_control": "180+2",
         "rated": True, "rules": "chess", "pgn": PGN,
         "white": {"username": "me" if color == "w" else "x", "rating": 800, "result": "win" if result == "win" else "checkmated"},
         "black": {"username": "x" if color == "w" else "me", "rating": 800, "result": "checkmated" if result == "win" else "win"}}
    if color == "b":
        g["white"]["result"], g["black"]["result"] = ("checkmated", "win") if result == "win" else ("win", "checkmated")
    return chesscom.store_game(db.connect(), "me", g)


def test_store_and_tree_and_drill():
    assert store("g1") and store("g2", end=int(time.time()) - 10)
    assert not store("g1")  # pas de doublon
    t = repertoire.tree("me", "w")
    root = t[chess.Board().epd()]
    assert root["n"] == 2 and root["moves"]["e2e4"]["n"] == 2
    added = repertoire.auto_build("me", "w")
    assert added >= 3
    line = repertoire.drill_line("me", "w")
    assert [s["san"] for s in line["steps"]][:4] == ["e4", "e5", "Nf3", "Nc6"]
    key = line["steps"][0]["key"]
    repertoire.drill_result("w", key, True)
    card = db.connect().execute("SELECT * FROM rep_cards WHERE key=?", (key,)).fetchone()
    assert card["box"] == 1 and card["due"] > time.time()


def test_schedule_and_answer():
    box, due = exercises.schedule(0, True, 0)
    assert box == 1 and due == exercises.DAY
    box, due = exercises.schedule(4, False, 0)
    assert box == 1
    conn = db.connect()
    conn.execute("INSERT INTO exercises(kind, game_id, ply, fen, solution, accept, created_at, due) "
                 "VALUES('trap','piege:x:1',3,?,?,?,0,0)", (chess.STARTING_FEN, json.dumps(["e2e4"]), json.dumps(["e2e4"])))
    ex_id = conn.execute("SELECT id FROM exercises").fetchone()["id"]
    exercises.answer(ex_id, True)
    r = conn.execute("SELECT box, reps FROM exercises WHERE id=?", (ex_id,)).fetchone()
    assert r["box"] == 1 and r["reps"] == 1
    assert exercises.new_done_today() == 1


def test_import_traps():
    n = exercises.import_traps("me")
    assert n > 0
    ex = exercises.queue("me", kind="trap")
    assert ex and ex[0]["solution"]
    b = chess.Board(ex[0]["fen"])
    assert b.is_legal(chess.Move.from_uci(ex[0]["solution"][0]))


def test_slow_review_does_not_advance():
    conn = db.connect()
    conn.execute("INSERT INTO exercises(kind, game_id, ply, fen, solution, accept, created_at, due, box, reps) "
                 "VALUES('trap','piege:x:2',3,?,?,?,0,0,3,2)", (chess.STARTING_FEN, json.dumps(["e2e4"]), json.dumps(["e2e4"])))
    ex_id = conn.execute("SELECT id FROM exercises WHERE game_id='piege:x:2'").fetchone()["id"]
    r = exercises.answer(ex_id, True, secs=60)  # objectif : 15 s
    assert r["grade"] == "slow" and r["box"] == 3
    r = exercises.answer(ex_id, True, secs=5)
    assert r["grade"] == "ok" and r["box"] == 4
