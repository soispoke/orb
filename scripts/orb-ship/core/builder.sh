#!/bin/bash
# Runs INSIDE the builder container (rust:1.91-bookworm) with the source at /work.
# Builds sandboxed-sh, runs all library tests, and reruns each failure alone.
set -o pipefail
cd /work
# The runtime image has jq; some workspace hook tests need it.
apt-get update -qq && apt-get install -y -qq jq >/dev/null
cargo build --locked --bin sandboxed-sh -j 24 2>&1 | tee build.log || exit 1
cp "$CARGO_TARGET_DIR/debug/sandboxed-sh" /work/sandboxed-sh
cargo test --locked --lib -j 24 2>&1 | tee tests.log
: > rerun.log
for t in $(grep -E '^    [a-z0-9_:]+$' tests.log | sort -u); do
  cargo test --locked --lib -j 24 -- --exact "$t" 2>&1 | tee -a rerun.log
done
exit 0
