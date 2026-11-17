"""La base ne doit jamais « disparaître » : reprise de l'ancien dossier, sauvegardes, réparation automatique."""
import os
import sqlite3

import pytest

from chessprac import config, db


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HOME", tmp_path / "home")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "home" / "chessprac.db")
    monkeypatch.setattr(config, "LEGACY_DB_PATH", tmp_path / "legacy" / "chessprac.db")
    monkeypatch.setattr(db, "notice", "")
    db.reset_for_tests()
    yield tmp_path
    db.reset_for_tests()


def test_transaction_rolls_back(home):
    db.connect()
    with pytest.raises(RuntimeError):
        with db.transaction() as tx:
            tx.execute("INSERT INTO settings(key, value) VALUES('a', '1')")
            raise RuntimeError("boum")
    assert db.get_setting("a") == ""
    with db.transaction() as tx:
        tx.execute("INSERT INTO settings(key, value) VALUES('a', '2')")
    assert db.get_setting("a") == "2"


def test_legacy_database_is_taken_over(home):
    legacy = config.LEGACY_DB_PATH
    legacy.parent.mkdir(parents=True)
    c = sqlite3.connect(legacy)
    c.executescript(db.SCHEMA)
    c.execute("INSERT INTO settings VALUES('username', 'sush1_chess')")
    c.commit()
    c.close()
    db.prepare()
    assert db.get_setting("username") == "sush1_chess"
    assert "déplacées" in db.notice
    assert db.backups(), "une sauvegarde est faite dès le premier lancement"


def test_corrupt_database_is_restored_from_backup(home):
    db.prepare()
    db.set_setting("username", "sush1_chess")
    db.backup_now()
    db.set_setting("username", "plus-recent")
    db.checkpoint()
    db.reset_for_tests()
    # On abîme le fichier : l'en-tête de chaque page (après la première) est écrasé.
    with open(config.DB_PATH, "r+b") as f:
        size = os.path.getsize(config.DB_PATH)
        for pos in range(4096, size, 4096):
            f.seek(pos)
            f.write(bytes([0xFF]) * 12)
    db.prepare()
    assert db.get_setting("username") == "sush1_chess"
    assert "restaurée" in db.notice
    assert list(config.HOME.glob("abimee-*/chessprac.db")), "la base abîmée est gardée de côté, pas effacée"
