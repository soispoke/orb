# Upgrading Orb on this Mac and on Core

This repository (`~/src/orb`, branch `orb-live`) is the single source of truth for
the Orb desktop app installed in `~/Applications/Orb.app` and for Core
(`sandboxed-sh`) running on the server. Change code here, commit, then ship.
Do not build from copies in `/private/tmp`: macOS deletes them after a few days.

## Where things are

| What | Where |
| --- | --- |
| Desktop app | `~/Applications/Orb.app` (UI process); the execution worker runs from `~/.orb/runtime/image-*/Orb.app` and is upgraded separately |
| Desktop install records | `~/Applications/Orb-<name>-stage/` (`VERIFIED.json` names the source commit; `ui-rollback.app` is the previous app) |
| Desktop logs | `~/.orb/logs/orb-YYYY-MM-DD.jsonl` |
| Core | Docker container `orb-sandboxed-sh-1` on `arch-fv-autoresearch-01` (SSH through Warpgate, as `thomas`), image pinned in `/home/thomas/orb/docker-compose.override.yml` |
| Core build records | `/home/thomas/orb-build-<rev>/` (source, build and test logs) and `/home/thomas/orb-stage-<rev>/` (`VERIFIED.json`, `ACTIVATED.json`, rollback override) |
| How Orb reaches Core | SSH tunnel `127.0.0.1:13000` → Core's `127.0.0.1:3000`, kept up by `~/Library/LaunchAgents/md.thomas.orb-core-tunnel.plist` (log `~/Library/Logs/orb-core-tunnel.log`). Devops policy: no Tailscale, all access through Warpgate. |
| Core database backups | `/root/.sandboxed-sh/deployment-backups/` inside the container's data volume |

## History

- `48234d6` — upstream `Th0rgal/orb` (#1086, 2026-10-14), where this branch starts.
- `Recovered Orb state as installed on 2026-10-20` — everything fixed on this machine
  from 10-14 to 10-20 (recovered on 10-18, then shipped in ~25 installs). Verified on
  2026-10-21: every source file shipped since the recovery is identical in this commit.
- Later commits — one per fix, with tests.

Core in this repository is newer than older Core snapshots (`/home/thomas/orb`, the
`orb-build-upgrade-158fc507` image): it contains all of their fixes. The checkout in
`/home/thomas/orb` is stale; keep it only for `scripts/compose-core.py` and the
Compose files, which the deploy script uses.

## Desktop app

```bash
scripts/orb-ship/build_desktop.sh
python3 -I scripts/orb-ship/stage.py <short-name> "<what changed>"
python3 -I scripts/orb-ship/activate.py ~/Applications/Orb-<short-name>-stage
```

`activate.py` refuses if the installed app changed since staging or a message is
mid-delivery, backs up composer drafts, quits only the Orb window process (never
the execution worker or its agents), swaps the bundle and reopens Orb. To roll back,
quit Orb and move `ui-rollback.app` from the stage folder back to `~/Applications/Orb.app`.

Before shipping, run the checks from `orb/AGENTS.md` (`pnpm exec tsc --noEmit`,
`pnpm exec vitest run`, `pnpm exec playwright test`). On Node 26, set
`NODE_OPTIONS=--no-experimental-webstorage` for vitest.

## Core

```bash
scripts/orb-ship/core/build.sh                         # builds + runs all lib tests on the server
ssh arch-fv-autoresearch-01 'python3 - <rev>' < scripts/orb-ship/core/package.py
ssh arch-fv-autoresearch-01 'python3 - <rev> [--resume-live]' < scripts/orb-ship/core/deploy.py
```

`package.py` refuses unless the build and every library test passed, then health-checks
the new image in an isolated container. `deploy.py` refuses while any mission runs,
a delivery is queued or a machine transfer is open; backs up the database; restarts
Core and its proxy together; and restores the previous image on any failure.
By default the deploy refuses while chats run. With `--resume-live`, it restarts anyway:
Core's startup recovery marks running chats "Interrupted: server restarted" and resumes
them with a prompt to check the workspace and background jobs before continuing (a
Codex goal chat is resumed with its `/goal`). Builds and proofs running inside the
container stop with the restart, so pick a moment when no long, non-resumable job is
running. The script waits up to five minutes and reports any chat that did not resume.

## Rules that keep upgrades safe

- Build only from commits in this repository; never from another copy.
- Never kill the execution worker or another session's job; quit only the UI.
- Check memory with `memguard admit <GB>` before heavy builds on this Mac.
- After an install, read `~/.orb/logs` for new failure loops
  (`python3 -I scripts/orb-ship/logcheck.py`).
