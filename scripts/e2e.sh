#!/usr/bin/env bash
set -euo pipefail

# cowbell — end-to-end check (and benchmark).
#
# Verifies the full loop against a REAL herdr session: workspace ->
# pane -> command -> read -> teardown. Run inside the devcontainer for
# the hermetic variant (see .devcontainer/). --bench wraps the loop in
# hyperfine when available and prints a plain wall-clock otherwise.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BENCH="${1:-}"

command -v herdr >/dev/null 2>&1 || { echo "✗ herdr not on PATH"; exit 1; }
command -v node  >/dev/null 2>&1 || { echo "✗ node not on PATH";  exit 1; }

# Build fresh
cd "$ROOT"
npm run build >/dev/null

DRIVER="$ROOT/scripts/lib/e2e-driver.mjs"

if [[ "$BENCH" == "--bench" ]] && command -v hyperfine >/dev/null 2>&1; then
  hyperfine --warmup 1 "node $DRIVER" --export-json /tmp/cowbell-bench.json || true
  python3 -c "import json;d=json.load(open('/tmp/cowbell-bench.json'));r=d['results'][0];print(f\"BENCH mean={r['mean']*1000:.0f}ms min={r['min']*1000:.0f}ms\")" 2>/dev/null || true
else
  t0=$(date +%s%N)
  node "$DRIVER"
  t1=$(date +%s%N)
  echo "WALL_MS=$(( (t1 - t0) / 1000000 ))"
fi
