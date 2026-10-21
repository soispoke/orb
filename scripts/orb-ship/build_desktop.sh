#!/bin/bash
# Build the Orb desktop binary from this repository (debug profile, as installed).
# Usage: scripts/orb-ship/build_desktop.sh      (then stage.py, then activate.py)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
target="${ORB_TARGET:-$HOME/.cache/orb-target}"
logs="${ORB_SHIP_LOGS:-$HOME/.cache/orb-ship-logs}"
mkdir -p "$target" "$logs"
step=""
trap '[ -n "$step" ] && { echo "FAILED: $step (last lines of $logs/$step.log):" >&2; tail -20 "$logs/$step.log" >&2; }' ERR
command -v memguard >/dev/null && memguard admit 12
cd "$repo"
# Tauri bundles the MCP companion; tauri.conf.json's beforeBuildCommand normally stages it.
step=mcp-build; CARGO_TARGET_DIR="$target" python3 orb/scripts/build-mcp.py >"$logs/$step.log" 2>&1
cd "$repo/orb"
step=frontend-install; pnpm install --frozen-lockfile >"$logs/$step.log" 2>&1
step=typecheck; pnpm exec tsc --noEmit >"$logs/$step.log" 2>&1
step=frontend-build; pnpm exec vite build >"$logs/$step.log" 2>&1
cd "$repo"
step=native-build; CARGO_TARGET_DIR="$target" CARGO_PROFILE_DEV_DEBUG=0 \
  cargo build --offline --manifest-path orb/src-tauri/Cargo.toml --features tauri/custom-protocol --bin orb -j 8 \
  >"$logs/$step.log" 2>&1
step=""
echo "built $target/debug/orb from $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- orb src shared || echo ' + uncommitted changes')"
