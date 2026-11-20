#!/usr/bin/env bash
set -euo pipefail

# cowbell — the terminal-config deploy chain.
#
# Trigger: .githooks/post-commit (execs this with --from-hook after its
# four gates: opt-out, chain-executable, on-main, built-surface diff).
# Manual: npm run deploy [-- --dry-run].
#
# Phases:
#   push   dev main -> origin, skipped when already current — the deploy
#          copy fetches from GitHub, so nothing downstream works until
#          main is pushed
#   sync   terminal-config/cowbell -> origin/main: fetch, checkout main,
#          ff-only merge (the copy lives ON main; non-ff fails loudly)
#   build  dist/ inside the deploy copy — the deployed artifact is
#          gitignored, so a gitlink bump alone deploys nothing; building
#          BEFORE recording the pointer is the whole point (a stale dist
#          once served old tools under a fresh gitlink)
#   bump   the parent gitlink: one single-purpose commit, gitlink-only,
#          "bump cowbell (<short-sha>: <subject>[, +N])", then push
#   hint   the reload stays manual — it kills in-flight tool calls
#
# Guards refuse loudly and never mutate the parent (no stash, no add -A
# — git add cowbell only). In --from-hook mode guard failures exit 0: a
# post-commit hook must never mask the commit it follows. Every git
# call runs env-scrubbed — git injects GIT_DIR/GIT_INDEX_FILE/
# GIT_WORK_TREE/GIT_PREFIX into hooks, and those would redirect every
# -C target back into this repo.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
TERMINAL_CONFIG_DIR="${TERMINAL_CONFIG_DIR:-$ROOT/../terminal-config}"
DEPLOY="$TERMINAL_CONFIG_DIR/cowbell"

usage() {
  cat <<EOF
Usage: npm run deploy [-- --dry-run]   (or: scripts/deploy.sh [OPTIONS])

Runs the terminal-config deploy chain from a cowbell main checkout:
push dev main, sync + rebuild the terminal-config/cowbell deploy copy,
bump the parent gitlink, push the parent. Prints the reload hint.

Options:
  --from-hook  invoked by .githooks/post-commit: guard failures exit 0
               (never mask the commit); phases run for real
  --dry-run    resolve and print the plan (SHAs, would-be commit
               message); touch nothing
  --help       show this help

Environment:
  TERMINAL_CONFIG_DIR  deploy parent checkout
                       (default: <this repo>/../terminal-config)
EOF
}

FROM_HOOK=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-hook) FROM_HOOK=1 ; shift ;;
    --dry-run)   DRY_RUN=1   ; shift ;;
    --help)      usage; exit 0 ;;
    *)           echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# env-scrubbed git (see header): parent-side and deploy-copy calls must
# never see this repo's GIT_* context
g() {
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_PREFIX \
    git "$@"
}

# loud refusal: hook mode exits 0 (the commit already happened — never
# mask it), manual mode exits 1
fail() {
  echo "  ✗  $1"
  if [[ "$FROM_HOOK" -eq 1 ]]; then
    echo "     hook mode: chain aborted, the commit above is unaffected"
    exit 0
  fi
  exit 1
}

echo ""
echo "cowbell — terminal-config deploy chain"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  dry-run: resolve + print the plan, touch nothing"
fi

# ---- guards (read-only) ----

if [[ ! -d "$TERMINAL_CONFIG_DIR" || ! -e "$TERMINAL_CONFIG_DIR/.git" ]]; then
  fail "terminal-config is not a git checkout: $TERMINAL_CONFIG_DIR (override with TERMINAL_CONFIG_DIR)"
fi

if [[ -e "$TERMINAL_CONFIG_DIR/.git/index.lock" ]]; then
  fail "terminal-config has an index.lock — another git operation is running"
fi

for marker in MERGE_HEAD rebase-merge rebase-apply; do
  if [[ -e "$TERMINAL_CONFIG_DIR/.git/$marker" ]]; then
    fail "terminal-config is mid-operation ($marker present)"
  fi
done

PARENT_STATUS="$(g -C "$TERMINAL_CONFIG_DIR" status --porcelain)"
case "$PARENT_STATUS" in
  "")
    ;;
  " M cowbell")
    # the drift state is VALID input: the deploy copy checked out ahead
    # of the recorded gitlink — the bump below absorbs it
    ;;
  *)
    echo "     terminal-config status:"
    printf '%s\n' "$PARENT_STATUS" | sed 's/^/       /'
    fail "terminal-config is dirty beyond the cowbell gitlink — refusing (never stashes, never adds -A)"
    ;;
esac

if [[ ! -d "$DEPLOY" || ! -e "$DEPLOY/.git" ]]; then
  fail "deploy copy missing: $DEPLOY"
fi

DEPLOY_STATUS="$(g -C "$DEPLOY" status --porcelain)"
if [[ -n "$DEPLOY_STATUS" ]]; then
  echo "     deploy copy status:"
  printf '%s\n' "$DEPLOY_STATUS" | sed 's/^/       /'
  fail "deploy copy is dirty — refusing to clobber it (dist/ and node_modules are gitignored, they never count)"
fi

DEPLOY_GITDIR="$(g -C "$DEPLOY" rev-parse --git-dir)"
case "$DEPLOY_GITDIR" in
  /*) ;;
  *)  DEPLOY_GITDIR="$DEPLOY/$DEPLOY_GITDIR" ;;
esac
if [[ -e "$DEPLOY_GITDIR/rebase-merge" || -e "$DEPLOY_GITDIR/rebase-apply" ]]; then
  fail "deploy copy is mid-rebase"
fi

# ---- phase a: push (dev main -> origin) ----

LOCAL_MAIN="$(g -C "$ROOT" rev-parse -q --verify main || true)"
if [[ -z "$LOCAL_MAIN" ]]; then
  fail "no main branch in $ROOT — the chain deploys the dev clone's main, never a feature branch"
fi
ORIGIN_MAIN="$(g -C "$ROOT" rev-parse -q --verify origin/main || true)"

if [[ -n "$ORIGIN_MAIN" && "$ORIGIN_MAIN" == "$LOCAL_MAIN" ]]; then
  echo "  ⊘  push: skip (origin/main == $(g -C "$ROOT" rev-parse --short main))"
else
  ORIGIN_NOTE="$(g -C "$ROOT" rev-parse --short "$ORIGIN_MAIN" 2>/dev/null || echo '<unset>')"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  ↓  push: would run: git -C $ROOT push origin main"
    echo "     local main $(g -C "$ROOT" rev-parse --short main) -> origin/main $ORIGIN_NOTE"
  else
    echo "  ↓  push: dev main -> origin"
    g -C "$ROOT" push origin main 2>&1 | sed 's/^/     /'
  fi
fi

# ---- phase b: sync (deploy copy -> origin/main) ----

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  ↓  sync: would run: fetch origin main + checkout main + merge --ff-only origin/main in $DEPLOY"
  echo "     deploy HEAD $(g -C "$DEPLOY" rev-parse --short HEAD), origin/main as-last-fetched $(g -C "$DEPLOY" rev-parse --short origin/main 2>/dev/null || echo '<unset>')"
else
  echo "  ↓  sync: deploy copy -> origin/main"
  g -C "$DEPLOY" fetch origin main 2>&1 | sed 's/^/     /'
  g -C "$DEPLOY" checkout -q main
  g -C "$DEPLOY" merge -q --ff-only origin/main
  echo "  ✓  sync: deploy copy at $(g -C "$DEPLOY" rev-parse --short HEAD)"
fi

# ---- phase c: build (dist/ in the deploy copy) ----

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  ↓  build: would run: (cd $DEPLOY && npm install --silent --no-audit --no-fund && npm run build) + dist/bin/stdio.js check"
else
  echo "  ↓  build: npm install + npm run build in the deploy copy"
  (cd "$DEPLOY" && npm install --silent --no-audit --no-fund && npm run build >/dev/null)
  if [[ ! -f "$DEPLOY/dist/bin/stdio.js" ]]; then
    fail "build produced no $DEPLOY/dist/bin/stdio.js — refusing to bump the gitlink to an unbuilt state"
  fi
  echo "  ✓  build: dist/bin/stdio.js present"
fi

# ---- phase d: bump (parent gitlink) ----

OLD="$(g -C "$TERMINAL_CONFIG_DIR" ls-tree HEAD cowbell | awk '{print $3}')"
if [[ -z "$OLD" ]]; then
  fail "cowbell gitlink not recorded in $TERMINAL_CONFIG_DIR HEAD — refusing to invent a submodule entry"
fi
NEW="$(g -C "$DEPLOY" rev-parse HEAD)"

if [[ "$OLD" == "$NEW" ]]; then
  echo "  ✓  bump: already recorded ($(g -C "$DEPLOY" rev-parse --short "$NEW"))"
else
  N=$(( $(g -C "$DEPLOY" rev-list --count "$OLD..$NEW") - 1 ))
  SUBJECT="$(g -C "$DEPLOY" log -1 --format=%s "$NEW")"
  OLD_SHORT="$(g -C "$TERMINAL_CONFIG_DIR" rev-parse --short "$OLD")"
  NEW_SHORT="$(g -C "$DEPLOY" rev-parse --short "$NEW")"
  MESSAGE="bump cowbell ($NEW_SHORT: $SUBJECT"
  if [[ "$N" -gt 0 ]]; then
    MESSAGE="$MESSAGE, +$N)"
  else
    MESSAGE="$MESSAGE)"
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  ↓  bump: would run: git add cowbell + commit + push in $TERMINAL_CONFIG_DIR"
    echo "     gitlink $OLD_SHORT -> $NEW_SHORT"
    echo "     message: $MESSAGE"
  else
    echo "  ↓  bump: gitlink $OLD_SHORT -> $NEW_SHORT"
    g -C "$TERMINAL_CONFIG_DIR" add cowbell
    g -C "$TERMINAL_CONFIG_DIR" commit -m "$MESSAGE" 2>&1 | sed 's/^/     /'
    g -C "$TERMINAL_CONFIG_DIR" push 2>&1 | sed 's/^/     /'
    echo "  ✓  bump: $MESSAGE"
  fi
fi

# ---- phase e: reload hint (explicit by design — never automatic) ----

echo ""
echo "  ⚠  run \`npm run deploy:reload\` to hand running sessions the new tools — it reconnects"
echo "     cowbell per opencode location and kills in-flight tool calls mid-flight; pick your moment."
echo ""
