"""Exercise the live compatibility guard against legacy and explicit updates."""
from pathlib import Path
import sqlite3
import unittest

SQL = (Path(__file__).parent / 'orb-disable-legacy-auto-archive.sql').read_text()

class ManualArchive(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.addCleanup(self.db.close)
        self.db.executescript('''
        CREATE TABLE missions(id TEXT PRIMARY KEY, status TEXT, updated_at TEXT,
          first_viewed_at TEXT, last_status_change_at TEXT, history TEXT);
        CREATE TABLE mission_runs(mission_id TEXT, execution_state TEXT);
        INSERT INTO missions VALUES('chat','awaiting_user','2000','2000',NULL,'keep');
        INSERT INTO missions VALUES('build','active','2000',NULL,'2000','keep');
        INSERT INTO mission_runs VALUES('build','running');
        ''')
        self.db.executescript(SQL)

    def test_legacy_sweep_rolls_back_instead_of_reporting_false_archives(self):
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'Automatic chat archiving disabled'):
            self.db.execute("""UPDATE missions SET status='acknowledged', updated_at=?
                WHERE status='awaiting_user' AND first_viewed_at IS NOT NULL
                AND first_viewed_at <= ? AND NOT EXISTS
                (SELECT 1 FROM mission_runs r WHERE r.mission_id=missions.id
                 AND r.execution_state <> 'terminal')""", ('2026','2026'))
        self.assertEqual(list(self.db.iterdump()), before)

    def test_explicit_archive_and_restore_still_work(self):
        self.db.execute("UPDATE missions SET status='acknowledged', updated_at='2026', last_status_change_at='2026' WHERE id='chat'")
        self.assertEqual(self.db.execute("SELECT status FROM missions WHERE id='chat'").fetchone()[0], 'acknowledged')
        self.db.execute("UPDATE missions SET status='paused', last_status_change_at='2027' WHERE id='chat'")
        self.assertEqual(self.db.execute("SELECT status,history FROM missions WHERE id='chat'").fetchone(), ('paused','keep'))

    def test_opening_chat_keeps_read_receipts_without_changing_status(self):
        self.db.execute("UPDATE missions SET first_viewed_at='2026' WHERE id='chat'")
        self.assertEqual(self.db.execute("SELECT status,first_viewed_at FROM missions WHERE id='chat'").fetchone(), ('awaiting_user','2026'))

    def test_install_is_idempotent_and_leaves_jobs_and_history_unchanged(self):
        before = list(self.db.iterdump())
        self.db.executescript(SQL)
        self.assertEqual(list(self.db.iterdump()), before)

if __name__ == '__main__':
    unittest.main()
