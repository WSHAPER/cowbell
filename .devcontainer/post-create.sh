#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm install

# Capture the surface from the container's herdr (the hermetic pin).
bash scripts/dump-upstream-surface.sh

# Full gate run.
npm run format:check
npm run lint
npm run typecheck
npm test

# End-to-end against a real herdr session inside the container,
# then the benchmark loop.
npm run e2e
npm run bench

echo ""
echo "✓ devcontainer gates + e2e + bench all green"
