#!/usr/bin/env bash
set -euo pipefail

# cowbell — hand running sessions the freshly deployed tools.
#
# Contract: scripts/deploy-reload.sh [--dry-run]  (npm run deploy:reload)
#
# After scripts/deploy.sh lands a new dist, every OPEN opencode location
# still serves the OLD cowbell stdio process: dead processes never
# auto-respawn, and sessions re-read the tool list every step — so one
# experimental.mcp.connect per location (a full in-place restart:
# stop+start under the per-server lock, fresh tools/list; a preceding
# disconnect is redundant) is what hands ALL running sessions the new
# tools.
#
# WHY this is a separate script, never wired into the commit hook: a
# reconnect stops the old cowbell process MID-SERVING — any in-flight
# cowbell tool call (a fleet orchestrator's wait, a prompt) dies with
# it. Deliberately manual; an operator picks the moment.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # house-style anchor; this script is cwd-independent
ROOT="$(dirname "$SCRIPT_DIR")"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Reconnects the cowbell MCP server in every open opencode location so
running sessions pick up the freshly deployed dist.

Options:
  --dry-run    Print the locations and the exact commands; touch nothing
  --help       Show this help message
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ; shift ;;
    --help)    usage; exit 0 ;;
    *)         echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

command -v opencode >/dev/null 2>&1 || { echo "✗ opencode not on PATH"; exit 1; }
command -v jq        >/dev/null 2>&1 || { echo "✗ jq not on PATH";        exit 1; }

echo ""
echo "cowbell — deploy reload${DRY_RUN:+ (dry run)}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${DRY_RUN:+━━━━━━━━━━}"

# Phase 1 — enumerate every open location (read-only).
if ! LOCATIONS="$(opencode api debug.location.list | jq -r '.[].directory')"; then
  echo "✗ could not enumerate locations — is the opencode background service running?"
  exit 1
fi
mapfile -t LOCS < <(printf '%s\n' "$LOCATIONS")

if [[ "${#LOCS[@]}" -eq 0 ]] || { [[ "${#LOCS[@]}" -eq 1 ]] && [[ -z "${LOCS[0]}" ]]; }; then
  echo "  ⚠  no open locations — nothing to reload"
  echo ""
  exit 0
fi

echo "  Open locations (${#LOCS[@]}):"
printf '%s\n' "${LOCS[@]}" | sed 's/^/     /'

# Phase 2 (dry-run) — show the exact plan; debug.location.list and
# mcp.list are read-only and were the only calls made. NO connect.
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo ""
  echo "  Would run, per location (connect = full in-place restart: stop+start, fresh tools/list):"
  for dir in "${LOCS[@]}"; do
    echo "opencode api experimental.mcp.connect --param server=cowbell --param 'location[directory]=$dir'" | sed 's/^/     /'
  done
  echo ""
  echo "  Then the summary (read-only), per location:"
  for dir in "${LOCS[@]}"; do
    echo "opencode api mcp.list --param 'location[directory]=$dir' | jq '.data[] | select(.name==\"cowbell\")'" | sed 's/^/     /'
  done
  echo ""
  echo "  Dry run — nothing touched (no connect calls issued)."
  echo ""
  exit 0
fi

# Phase 2 — reconnect cowbell in every location. A single failure never
# kills the loop (failures are collected for the summary); the
# not-configured case is a ⚠, not a ✗.
echo ""
echo "  Reconnecting cowbell in every location:"
FAILED=()
WARNED=()
for dir in "${LOCS[@]}"; do
  echo ""
  echo "  ↻  $dir"
  if out="$(opencode api experimental.mcp.connect \
      --param server=cowbell \
      --param "location[directory]=$dir" 2>&1)"; then
    echo "     ✓  reconnected"
    if [[ -n "$out" ]]; then printf '%s\n' "$out" | sed 's/^/     /'; fi
  elif grep -qiE 'server .*not (found|configured)|not configured' <<<"$out"; then
    echo "     ⚠  cowbell not configured for this location — harmless, skipped"
    if [[ -n "$out" ]]; then printf '%s\n' "$out" | sed 's/^/     /'; fi
    WARNED+=("$dir")
  else
    echo "     ✗  connect failed"
    if [[ -n "$out" ]]; then printf '%s\n' "$out" | sed 's/^/     /'; fi
    FAILED+=("$dir")
  fi
done

# Phase 3 — per-location status via the read-only mcp.list.
echo ""
echo "  Summary — cowbell status per location:"
for dir in "${LOCS[@]}"; do
  if body="$(opencode api mcp.list --param "location[directory]=$dir" 2>/dev/null)"; then
    status="$(jq -r '.data[] | select(.name=="cowbell") | .status.status' <<<"$body" 2>/dev/null || true)"
    echo "${status:-absent}  —  $dir" | sed 's/^/     /'
  else
    echo "?  —  $dir" | sed 's/^/     /'
  fi
done

echo ""
if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "  ✗  ${#FAILED[@]} of ${#LOCS[@]} connects failed:"
  printf '%s\n' "${FAILED[@]}" | sed 's/^/     /'
  echo ""
  echo "  ⚠  stale herdr-worktree locations may legitimately fail (checkout"
  echo "     gone but the location still holds a connection) — close the"
  echo "     location in that session, or ignore it."
  echo ""
  exit 1
fi
echo "  ✓  cowbell reconnected in all ${#LOCS[@]} locations"
if [[ "${#WARNED[@]}" -gt 0 ]]; then
  echo "  ⚠  ${#WARNED[@]} location(s) have no cowbell entry — nothing to reload there:"
  printf '%s\n' "${WARNED[@]}" | sed 's/^/     /'
fi
echo ""
