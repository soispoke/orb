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
# Mirror tauri.macos.conf.json's beforeBuildCommand: stage the MCP companion and
# compile the native app icon (both are generated, untracked build inputs).
step=mcp-build; CARGO_TARGET_DIR="$target" python3 orb/scripts/build-mcp.py >"$logs/$step.log" 2>&1
cd "$repo/orb"
# Same actool call as orb/scripts/build-macos-icon.mjs (Node cannot spawn it in some shells).
tauri="$repo/orb/src-tauri"
step=icon-build; mkdir -p "$tauri/gen/app-icon"; xcrun actool "$tauri/icons/Orb.icon" --compile "$tauri/gen/app-icon" \
  --output-format human-readable-text --notices --warnings --errors \
  --output-partial-info-plist "$tauri/gen/app-icon/partial.plist" --app-icon Orb --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en --target-device mac \
  --minimum-deployment-target 11.0 --platform macosx >"$logs/$step.log" 2>&1
step=frontend-install; pnpm install --frozen-lockfile >"$logs/$step.log" 2>&1
step=typecheck; pnpm exec tsc --noEmit >"$logs/$step.log" 2>&1
# Gates: a failing test stops the build. The native set covers the local runner
# (including the after-reboot recovery), live input and the saved connection.
step=app-tests; NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run >"$logs/$step.log" 2>&1
step=native-tests; cargo test --offline --manifest-path "$tauri/Cargo.toml" -- local_runtime live_input connection_store >"$logs/$step.log" 2>&1
step=frontend-build; pnpm exec vite build >"$logs/$step.log" 2>&1
cd "$repo"
step=native-build; CARGO_TARGET_DIR="$target" CARGO_PROFILE_DEV_DEBUG=0 \
  cargo build --offline --manifest-path orb/src-tauri/Cargo.toml --features tauri/custom-protocol --bin orb -j 8 \
  >"$logs/$step.log" 2>&1
step=""
echo "built $target/debug/orb from $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- orb src shared || echo ' + uncommitted changes')"
