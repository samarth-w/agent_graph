#!/usr/bin/env bash
# Build the current branch and link it as the global `cgraph` for
# hands-on testing. Replaces any existing global install for as long
# as the symlink is in place.
#
# Usage:
#   ./scripts/local-install.sh          # build + link
#   ./scripts/local-install.sh --undo   # unlink

set -euo pipefail

cd "$(dirname "$0")/.."

PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")

if [ "${1:-}" = "--undo" ]; then
  echo "→ unlinking ${PKG}"
  npm unlink -g "${PKG}" >/dev/null 2>&1 || true
  echo "done: cgraph unlinked"
  exit 0
fi

echo "→ building ${PKG} ${VERSION} (${BRANCH})"
npm run build

echo "→ linking globally"
npm link

LINKED=$(command -v cgraph || echo "(not on PATH)")
echo
echo "✓ global cgraph now points to this branch"
echo "  binary:  ${LINKED}"
echo "  branch:  ${BRANCH}"
echo "  version: ${VERSION}"
echo
echo "To undo:"
echo "  ./scripts/local-install.sh --undo"
