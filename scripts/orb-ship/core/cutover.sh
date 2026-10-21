#!/bin/bash
# Package a finished Core build and deploy it while chats run, at a moment that loses
# little work. Usage: scripts/orb-ship/core/cutover.sh <rev> [protected-mission-prefix...]
# Waits until no heavy job (over HEAVY_KB of memory) under a protected mission's workspace
# has run longer than GRACE_SECONDS, at most MAX_WAIT_SECONDS. Lane driver scripts and
# monitors are light and ignored; resumable jobs belong to unprotected missions.
set -euo pipefail
host="${ORB_CORE_HOST:-thomas@hardness-agent.taile0aa99.ts.net}"
here="$(cd "$(dirname "$0")" && pwd)"
rev="$1"; shift
grace="${GRACE_SECONDS:-180}"; max_wait="${MAX_WAIT_SECONDS:-5400}"; heavy="${HEAVY_KB:-1000000}"
ssh_() { ssh -o BatchMode=yes "$host" "$@"; }
say() { echo "$(date '+%H:%M:%S') $*"; }

say "waiting for build orb-core-builder-$rev"
until ssh_ "docker ps -a --filter name=orb-core-builder-$rev --format '{{.Status}}'" | grep -q Exited; do sleep 30; done
say "packaging"
ssh_ "python3 - $rev" < "$here/package.py"

if [ "$#" -gt 0 ]; then
  pattern="$(printf '/root/workspaces/mission-%s|' "$@")"; pattern="${pattern%|}"
  start=$(date +%s)
  while :; do
    oldest=$(ssh_ "docker exec orb-sandboxed-sh-1 ps -eo etimes=,rss=,args=" | grep -E "$pattern" | awk -v h="$heavy" '$2 > h {print $1}' | sort -n | tail -1)
    oldest=${oldest:-0}
    [ "$oldest" -le "$grace" ] && { say "protected missions have no job older than ${grace}s (oldest ${oldest}s)"; break; }
    [ $(( $(date +%s) - start )) -ge "$max_wait" ] && { say "waited ${max_wait}s; deploying with a ${oldest}s-old job running"; break; }
    sleep 20
  done
fi
say "deploying"
ssh_ "python3 - $rev --resume-live" < "$here/deploy.py"
say "done"
