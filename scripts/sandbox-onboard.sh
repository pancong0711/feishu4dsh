#!/usr/bin/env bash
# Run the terminal onboarding CLI from a fresh clone.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f lib/secretary/onboard.js ] || [ ! -f lib/secretary/sandbox.js ]; then
  if [ ! -x node_modules/.bin/tsc ]; then
    echo "dependencies are not installed; run: pnpm install" >&2
    exit 1
  fi
  echo "building feishu4dsh for onboarding..."
  node_modules/.bin/tsc -b --pretty false
fi
exec node scripts/sandbox-onboard.mjs "$@"
