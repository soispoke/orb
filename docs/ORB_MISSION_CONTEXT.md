# Startup context helper identity

The optional Core startup helper `scripts/orb_mission_context.py` reports the
current mission and loads its project workflow. On the personal Core deployment
it is installed as `/root/workspaces/.orb-support/context.py`. Its database and
project-file roots are explicit constants; verify those paths for the deployment
before installing it. This helper is informational, not an authorization check.

Mission identity comes from the launcher environment: Claude provides
`SANDBOXED_SH_MISSION_ID`, and Codex provides `MISSION_ID`. If both are present,
they must identify the same UUID. Missing, malformed, conflicting, or unregistered
identity produces a nonzero exit and does not load a project workflow.

Never infer the current mission from an ancestor `.sandboxed-sh_context.json` or
`current_workspace.json`. On a host workspace, these can be shared and overwritten
by another mission. Changing the shell's working directory must not change its
mission identity. A legacy cwd argument is accepted but ignored.

Regression check:

```sh
python3 scripts/test_orb_mission_context.py
```

To update a deployed helper, preserve a private rollback copy, verify the current
file has not changed, then atomically replace it with the tested script. No Core
or harness restart is needed: subsequent helper invocations read the new file.
Do not rewrite shared runtime identity metadata to make a test pass.

For a live smoke test, invoke the helper with the unmodified launcher environment
in an isolated parent and two workers. Each must report its own full mission ID;
the parent must still report its own ID after the workers finish. Missing identity
is a failed test, not permission to inject a guessed ID. Do not change unrelated
missions, sessions, builds, or credentials during verification.

## Startup instructions and wrong project labels

The startup instructions that tell every agent to run the helper live at
`/root/workspaces/CLAUDE.md` on Core; the tracked copy is
`scripts/orb-ship/core/workspace-CLAUDE.md`. Install both files the same way
(backup in `/root/.sandboxed-sh/deployment-backups/`, then atomic replace).

A chat can be filed under the wrong project: a fork keeps its parent's project.
Both files therefore say the label only selects a workflow and never limits the
task. Without that, a helper agent whose brief names another project read the
mismatch as a prompt injection and refused (sig.golf chats filed under Hardness,
2026-10-22). Fix a wrong label by moving the chat (cut it, paste it into the
right project), not by rewording briefs.
