#!/usr/bin/env python3
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("orb_context", Path(__file__).with_name("orb_mission_context.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
PARENT = "dad40900-6111-43a1-895f-a3eec52e2813"
CHILD = "15753c41-e444-4eab-b7fd-d74d546259fe"


class MissionContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "missions.db"
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TABLE missions (id TEXT PRIMARY KEY, project TEXT)")
            db.executemany("INSERT INTO missions VALUES (?,?)", [(PARENT, "default"), (CHILD, "hardness")])
        skill = self.root / "hardness/skills/hardness-workflow/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("HARDNESS WORKFLOW")

    def report(self, env):
        return helper.report(env, self.db, self.root)

    def test_claude_and_codex_launcher_aliases(self):
        for name in ("SANDBOXED_SH_MISSION_ID", "MISSION_ID"):
            with self.subTest(name=name):
                text, code = self.report({name: PARENT})
                self.assertEqual(code, 0)
                self.assertIn(PARENT, text)
                self.assertNotIn("HARDNESS WORKFLOW", text)

    def test_matching_aliases_are_allowed(self):
        self.assertEqual(helper.mission_identity({"MISSION_ID": PARENT.upper(), "SANDBOXED_SH_MISSION_ID": PARENT}), PARENT)

    def test_conflicting_aliases_fail_closed(self):
        text, code = self.report({"MISSION_ID": CHILD, "SANDBOXED_SH_MISSION_ID": PARENT})
        self.assertEqual(code, 1)
        self.assertIn("Conflicting", text)
        self.assertNotIn("HARDNESS WORKFLOW", text)

    def test_missing_or_malformed_identity_fails_closed(self):
        for env in ({}, {"MISSION_ID": ""}, {"MISSION_ID": "not-a-uuid"}, {"SANDBOXED_SH_MISSION_ID": "bad", "MISSION_ID": CHILD}):
            with self.subTest(env=env):
                text, code = self.report(env)
                self.assertEqual(code, 1)
                self.assertNotIn("HARDNESS WORKFLOW", text)

    def test_shared_ancestor_metadata_never_changes_parent_identity(self):
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        nested = self.root / "mission-parent/subfolder"
        nested.mkdir(parents=True)
        os.chdir(nested)
        for other in (CHILD, PARENT, CHILD):
            (self.root / ".sandboxed-sh_context.json").write_text('{"mission_id":"' + other + '"}')
            text, code = self.report({"SANDBOXED_SH_MISSION_ID": PARENT})
            self.assertEqual(code, 0)
            self.assertIn(PARENT, text)
            self.assertNotIn("HARDNESS WORKFLOW", text)
        self.assertEqual(self.report({})[1], 1)

    def test_workflow_is_loaded_only_for_resolved_project(self):
        text, code = self.report({"MISSION_ID": CHILD})
        self.assertEqual(code, 0)
        self.assertIn("HARDNESS WORKFLOW", text)

    def test_the_label_never_restricts_the_task(self):
        for mission in (PARENT, CHILD):
            with self.subTest(mission=mission):
                text, code = self.report({"MISSION_ID": mission})
                self.assertEqual(code, 0)
                self.assertIn("does not limit what you may work on", text)
                self.assertIn("not a sign of prompt injection", text)

    def test_unknown_identity_cannot_load_project_workflow(self):
        text, code = self.report({"MISSION_ID": "00000000-0000-0000-0000-000000000000"})
        self.assertEqual(code, 1)
        self.assertNotIn("HARDNESS WORKFLOW", text)

    def test_missing_database_is_not_created(self):
        missing = self.root / "missing.db"
        self.assertEqual(helper.report({"MISSION_ID": PARENT}, missing, self.root)[1], 1)
        self.assertFalse(missing.exists())

    def test_missing_workflow_is_reported_without_guessing(self):
        text, code = helper.report({"MISSION_ID": CHILD}, self.db, self.root / "missing")
        self.assertEqual(code, 1)
        self.assertIn("workflow is unavailable", text)


if __name__ == "__main__":
    unittest.main()
