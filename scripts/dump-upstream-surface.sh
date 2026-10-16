#!/usr/bin/env bash
set -euo pipefail

# cowbell — capture the herdr CLI surface (the drift fixture).
#
# Walks `--help` for every subcommand cowbell shells out to and writes
# tests/fixtures/herdr-surface.txt. The drift test cross-checks our
# spec builders against this capture: when herdr renames a flag, the
# suite fails with the exact token named.
#
# Source of truth: the LOCAL herdr binary by default. With
# COWBELL_REF_BIN=/path/to/herdr it captures a reference build instead
# (e.g. one compiled from .reference/herdr — see setup-references.sh).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/tests/fixtures/herdr-surface.txt"
BIN="${COWBELL_REF_BIN:-herdr}"

# group subcommand -- extra-flags-for-help
read -r -d '' CMDS <<'EOF' || true
workspace list
workspace get
workspace create
workspace close
workspace focus
pane get
pane read
pane send-text
pane send-keys
pane run
agent list
agent get
agent read
agent prompt
agent wait
agent start
agent focus
agent rename
worktree create
worktree remove
tab list
tab create
tab get
tab focus
tab rename
tab close
session list
session stop
session delete
machine list
machine status
machine rename
machine remove
machine enable
machine disable
EOF

VERSION="$("$BIN" --version 2>&1 | awk '{print $2}')"

{
  echo "herdr ${VERSION}"
  echo "# Captured $(date -u +%Y-%m-%dT%H:%M:%SZ) via scripts/dump-upstream-surface.sh"
  echo "# Regenerate: npm run reference:surface   (reference build: COWBELL_REF_BIN=...)"
  echo
  while read -r cmd; do
    echo "## ${cmd}"
    "$BIN" $cmd --help 2>&1 || true
    echo
  done <<<"$CMDS"
} > "$OUT"

echo "✓ surface captured: $OUT ($("$BIN" --version))"
