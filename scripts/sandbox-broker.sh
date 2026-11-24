#!/usr/bin/env bash
# Run the R69 broker CLI; builds lib/ once if this is a fresh checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f lib/secretary/broker.js ] || [ ! -f lib/secretary/broker-server.js ]; then
  if [ ! -x node_modules/.bin/tsc ]; then
    echo "Node dependencies are not installed; run: pnpm install --frozen-lockfile" >&2
    exit 1
  fi
  node_modules/.bin/tsc -b --pretty false
fi
exec node scripts/sandbox-broker.mjs "$@"
