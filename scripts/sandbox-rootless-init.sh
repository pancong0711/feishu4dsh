#!/usr/bin/env bash
# Initialize rootless Docker for the current (non-root) user.
# This script must NOT be run with sudo.
set -euo pipefail

[ "$(id -u)" -ne 0 ] || { echo "must run as the target user, not root (do not use sudo)" >&2; exit 1; }
TARGET_USER="$(id -un)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

command -v docker >/dev/null 2>&1 || { echo "docker CLI missing; run the root onboarding/bootstrap script first" >&2; exit 1; }

if [ -S "$XDG_RUNTIME_DIR/docker.sock" ] || [ -S "$XDG_RUNTIME_DIR/dockerd-rootless/api.sock" ]; then
  echo "rootless Docker socket already present for $TARGET_USER"
else
  command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1 || {
    echo "dockerd-rootless-setuptool.sh missing; install docker-ce-rootless-extras via the root onboarding script" >&2
    exit 1
  }
  dockerd-rootless-setuptool.sh install
fi

echo "verifying rootless Docker for $TARGET_USER"
docker info --format 'server={{.ServerVersion}} security={{json .SecurityOptions}}'
if docker info --format '{{json .SecurityOptions}}' | grep -qi rootless; then
  echo "ROOTLESS_DOCKER_OK"
else
  echo "WARNING: rootless security option not detected; refusing to claim rootless readiness" >&2
  exit 1
fi

echo "smoke test:"
docker run --rm hello-world >/dev/null
echo "ROOTLESS_SMOKE_OK"
