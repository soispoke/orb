#!/bin/bash
# Build the Orb desktop binary from this repository (debug profile, as installed).
# Usage: scripts/orb-ship/build_desktop.sh      (then stage.py, then activate.py)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
target="${ORB_TARGET:-$HOME/.cache/orb-target}"
logs="${ORB_SHIP_LOGS:-$HOME/.cache/orb-ship-logs}"
mkdir -p "$target" "$logs"
command -v memguard >/dev/null && memguard admit 12
cd "$repo/orb"
pnpm install --frozen-lockfile >/dev/null
pnpm exec tsc --noEmit
pnpm exec vite build >"$logs/frontend-build.log" 2>&1
cd "$repo"
CARGO_TARGET_DIR="$target" CARGO_PROFILE_DEV_DEBUG=0 \
  cargo build --offline --manifest-path orb/src-tauri/Cargo.toml --features tauri/custom-protocol --bin orb -j 8 \
  >"$logs/native-build.log" 2>&1
echo "built $target/debug/orb from $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- orb src shared || echo ' + uncommitted changes')"
