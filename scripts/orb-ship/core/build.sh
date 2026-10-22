#!/bin/bash
# Build and test Core (sandboxed-sh) on the server from a committed revision of this repo.
# Usage: scripts/orb-ship/core/build.sh [rev]        (default HEAD; uncommitted changes are refused)
# Result: /home/thomas/orb-build-<shortrev>/{sandboxed-sh,build.log,tests.log}. Nothing is deployed.
set -euo pipefail
host="${ORB_CORE_HOST:-arch-fv-autoresearch-01}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
rev="$(git -C "$repo" rev-parse --short "${1:-HEAD}")"
if [ "${1:-HEAD}" = HEAD ] && ! git -C "$repo" diff --quiet HEAD -- src shared Cargo.toml Cargo.lock; then
  echo "Commit Core changes first; builds are only made from commits." >&2; exit 1
fi
dir="/home/thomas/orb-build-$rev"
ssh -o BatchMode=yes "$host" "test ! -e $dir && mkdir $dir"
git -C "$repo" archive "$rev" | ssh -o BatchMode=yes "$host" "tar x -C $dir && echo $rev > $dir/SOURCE_COMMIT"
# The cargo cache volume is shared by builds; CPU/RAM are capped so running agents keep the server.
ssh -o BatchMode=yes "$host" "cat > $dir/.orb-builder.sh" < "$(dirname "$0")/builder.sh"
ssh -o BatchMode=yes "$host" "docker run -d --name orb-core-builder-$rev --cpus 24 --memory 32g \
  -v $dir:/work -v orb-core-cargo-target:/target -w /work \
  -e CARGO_TARGET_DIR=/target -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_PROFILE_TEST_DEBUG=0 \
  rust:1.91-bookworm bash /work/.orb-builder.sh"
echo "Building $rev in $dir (container orb-core-builder-$rev). Then run: core/package.py on the server."
