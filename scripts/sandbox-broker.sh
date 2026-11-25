#!/usr/bin/env bash
# Run the local sandbox-broker CLI from this checkout.
#
# `serve` starts the long-lived host-local Unix-socket service. Other commands
# are thin clients for that same socket; they never accept raw Docker flags.
# This wrapper builds lib/ once if this is a fresh checkout. The user-service
# installer sets NODE_BIN to an absolute Node.js path so systemd does not rely
# on a shell-specific PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_BIN="${NODE_BIN:-node}"
if [ ! -f lib/secretary/broker.js ] || [ ! -f lib/secretary/broker-server.js ]; then
  if [ ! -x node_modules/.bin/tsc ]; then
    echo "Node dependencies are not installed; run: pnpm install --frozen-lockfile" >&2
    exit 1
  fi
  node_modules/.bin/tsc -b --pretty false
fi
exec "$NODE_BIN" scripts/sandbox-broker.mjs "$@"
