#!/usr/bin/env bash
set -euo pipefail

# cowbell — reference repository bootstrapper.
#
# Clones the upstream herdr source into .reference/ (gitignored) so
# upstream API deprecation is INSTANTLY visible: build it
# (COWBELL_REF_BIN) or diff its CLI definitions against our pinned
# surface fixture. A manifest records the exact commit + date; --update
# moves it and prints a loud warning to re-capture the surface.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
REF_DIR="$PROJECT_ROOT/.reference"

declare -A REPOS=(
  [herdr]="https://github.com/herdrdev/herdr.git"
)

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Downloads reference repositories into .reference/ (gitignored).

Options:
  --clean     Remove .reference/ and re-clone everything
  --update    Pull latest changes in existing clones
  --help      Show this help message
EOF
}

ACTION="clone"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)  ACTION="clean"  ; shift ;;
    --update) ACTION="update" ; shift ;;
    --help)   usage; exit 0         ;;
    *)        echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

manifest_write() {
  {
    echo "# cowbell reference manifest — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for name in "${!REPOS[@]}"; do
      local dest="$REF_DIR/$name"
      [[ -d "$dest/.git" ]] || continue
      local sha date
      sha="$(git -C "$dest" rev-parse HEAD)"
      date="$(git -C "$dest" log -1 --format=%cI)"
      echo "$name $sha $date ${REPOS[$name]}"
    done
  } > "$REF_DIR/manifest.txt"
}

manifest_diff_warning() {
  echo ""
  echo "  ⚠  REFERENCE MOVED — upstream may have deprecated CLI surface."
  echo "     Next steps:"
  echo "       1. cargo build --release inside .reference/herdr (or keep local herdr)"
  echo "       2. COWBELL_REF_BIN=<built-binary> npm run reference:surface"
  echo "       3. npm test — the drift suite names every broken builder"
  echo ""
}

clone_repo() {
  local name="$1" url="$2" dest="$REF_DIR/$name"

  if [[ -d "$dest" ]]; then
    echo "  ⊘  $name already exists, skipping (use --update to pull)"
    return
  fi

  echo "  ↓  Cloning $name..."
  git clone --depth 1 "$url" "$dest" 2>&1 | sed 's/^/     /'
  echo "  ✓  $name ready"
}

update_repo() {
  local name="$1" dest="$REF_DIR/$name"

  if [[ ! -d "$dest/.git" ]]; then
    echo "  ⊘  $name not cloned yet, cloning first..."
    clone_repo "$name" "${REPOS[$name]}"
    return
  fi

  echo "  ↻  Updating $name..."
  git -C "$dest" pull --ff-only 2>&1 | sed 's/^/     /'
  echo "  ✓  $name updated"
}

echo ""
echo "cowbell — reference setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$ACTION" in
  clean)
    echo "  🗑  Removing .reference/..."
    rm -rf "$REF_DIR"
    echo "  ✓  Cleaned"
    ACTION="clone"  # fall through to clone
    ;&
  clone)
    mkdir -p "$REF_DIR"
    for name in "${!REPOS[@]}"; do
      clone_repo "$name" "${REPOS[$name]}"
    done
    manifest_write
    ;;
  update)
    cp "$REF_DIR/manifest.txt" "$REF_DIR/manifest.txt.prev" 2>/dev/null || true
    for name in "${!REPOS[@]}"; do
      update_repo "$name"
    done
    manifest_write
    if ! diff -q "$REF_DIR/manifest.txt.prev" "$REF_DIR/manifest.txt" >/dev/null 2>&1; then
      manifest_diff_warning
    fi
    ;;
esac

echo ""
echo "  Reference repos in: $REF_DIR"
echo "  (gitignored — never committed)"
echo ""
