# Changes to Orb's startup files on Core

Covers `/root/workspaces/CLAUDE.md`, `/root/workspaces/AGENTS.md` and
`/root/workspaces/.orb-support/context.py`. Tracked copies live in the Orb repo
(`scripts/orb-ship/core/workspace-CLAUDE.md`, `scripts/orb_mission_context.py`);
backups of every replaced version are in `/root/.sandboxed-sh/deployment-backups/`.
Changes are made by the owner's Orb maintenance session from their Mac, at the
owner's request, and recorded here.

## 2026-10-22

- 04:19 UTC: context.py and CLAUDE.md said the project label never limits the
  task. Requested by the owner after sig.golf chats, filed under Hardness by
  mistake, had their helpers refuse work. AGENTS.md (Codex) synced to CLAUDE.md.
- 04:38 UTC: CLAUDE.md/AGENTS.md gained the "Fast research pipeline" section
  pointing at /root/yukon-autoresearch.
- 05:30 UTC: the 04:19 wording was replaced with a neutral statement (the label
  selects the workflow; on a mismatch, tell the user, who can move the chat).
  The earlier text argued against treating the mismatch as prompt injection,
  which reads like an injection itself; an agent rightly flagged it. The root
  cause was fixed instead: the sig.golf chats now belong to the sig.golf project.
