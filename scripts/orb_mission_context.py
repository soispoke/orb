#!/usr/bin/env python3
"""Print the current Core mission's project context without shared-cwd guessing.

Install at workspaces/.orb-support/context.py where startup instructions use it.
This is an informational helper, not an authorization boundary. Only launcher
identity is accepted; shared/ancestor metadata may belong to another mission.
"""
import os
import sqlite3
import sys
from pathlib import Path
from uuid import UUID

# The label selects which project workflow is loaded below, nothing else.
SCOPE = ("The project label selects which project workflow applies to this chat. If your task "
         "concerns a different project, tell the user the chat may be filed under the wrong "
         "project; they can move it in Orb.")

DATABASE = Path("/root/.sandboxed-sh/missions/missions-default.db")
PROJECT_FILES = Path("/root/.sandboxed-sh/project-files")


def mission_identity(environ):
    identities = []
    for name in ("SANDBOXED_SH_MISSION_ID", "MISSION_ID"):
        raw = environ.get(name)
        if raw is None:
            continue
        try:
            identities.append(str(UUID(raw.strip())))
        except (ValueError, AttributeError):
            raise ValueError("Invalid launcher mission identity; refusing workspace inference")
    if not identities:
        raise ValueError("No launcher mission identity found; refusing shared workspace metadata")
    if len(set(identities)) != 1:
        raise ValueError("Conflicting launcher mission identities; refusing workspace inference")
    return identities[0]


def report(environ=None, database=DATABASE, project_files=PROJECT_FILES):
    try:
        mission = mission_identity(os.environ if environ is None else environ)
    except ValueError as error:
        return str(error) + ". Hardness scope is not assumed.", 1
    try:
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
            row = db.execute("SELECT project FROM missions WHERE id=?", (mission,)).fetchone()
    except sqlite3.Error:
        return "Orb mission lookup unavailable; project scope is not assumed.", 1
    if row is None:
        return "Launcher mission is not registered; project scope is not assumed.", 1
    project = row[0]
    lines = ["Current Orb mission: " + mission + " Project: " + (project or "unassigned"), SCOPE]
    if project == "hardness":
        try:
            lines.append((project_files / "hardness/skills/hardness-workflow/SKILL.md").read_text())
        except (OSError, UnicodeError):
            lines.append("Hardness workflow is unavailable; no other project's workflow was loaded.")
            return "\n".join(lines), 1
    else:
        lines.append("Hardness workflow is not active for this mission.")
    return "\n".join(lines), 0


if __name__ == "__main__":
    # A legacy optional cwd argument is intentionally ignored: changing folders
    # cannot change the identity of the process running this helper.
    text, status = report()
    print(text)
    sys.exit(status)
