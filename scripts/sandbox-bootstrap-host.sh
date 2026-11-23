#!/usr/bin/env bash
# One-time root bootstrap for a dedicated rootless sandbox account.
# Review before running. Supports Debian/Ubuntu for --install-docker-ce.
#
# Usage:
#   sudo ./scripts/sandbox-bootstrap-host.sh [--user feishu4dsh-sandbox] [--dry-run]
#   sudo ./scripts/sandbox-bootstrap-host.sh --install-docker-ce
#
# Environment overrides:
#   SUBUID_START=100000 SUBUID_COUNT=65536
set -euo pipefail

SANDBOX_USER="feishu4dsh-sandbox"
DRY_RUN=0
INSTALL_DOCKER_CE=0
SUBUID_START="${SUBUID_START:-100000}"
SUBUID_COUNT="${SUBUID_COUNT:-65536}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$#" -ge 2 ] || { echo "--user requires a value" >&2; exit 2; }
      SANDBOX_USER="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --install-docker-ce)
      INSTALL_DOCKER_CE=1
      shift
      ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! printf '%s' "$SANDBOX_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$'; then
  echo "invalid sandbox user: $SANDBOX_USER" >&2
  exit 2
fi
if ! printf '%s' "$SUBUID_START" | grep -Eq '^[0-9]+$' || ! printf '%s' "$SUBUID_COUNT" | grep -Eq '^[0-9]+$'; then
  echo "SUBUID_START and SUBUID_COUNT must be numeric" >&2
  exit 2
fi

[ "$(id -u)" -eq 0 ] || { echo "must run as root (review with --dry-run first)" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ '; printf '%q ' "$@"; echo
  else
    "$@"
  fi
}

install_docker_ce() {
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu)
      run apt-get update
      run apt-get install -y ca-certificates curl gnupg
      run install -m 0755 -d /etc/apt/keyrings
      if [ "$DRY_RUN" = 0 ]; then
        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
      else
        echo "+ curl -fsSL https://download.docker.com/linux/${ID}/gpg -o /etc/apt/keyrings/docker.asc"
      fi
      run chmod a+r /etc/apt/keyrings/docker.asc
      ARCH="$(dpkg --print-architecture)"
      CODENAME="${VERSION_CODENAME:-}"
      [ -n "$CODENAME" ] || { echo "VERSION_CODENAME missing; unsupported distro" >&2; exit 1; }
      if [ "$DRY_RUN" = 1 ]; then
        echo "+ write /etc/apt/sources.list.d/docker.list"
      else
        printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
          "$ARCH" "$ID" "$CODENAME" > /etc/apt/sources.list.d/docker.list
      fi
      run apt-get update
      run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras uidmap slirp4netns fuse-overlayfs dbus-user-session
      ;;
    *)
      echo "automatic Docker CE install is only implemented for Debian/Ubuntu." >&2
      echo "Install docker-ce, docker-ce-rootless-extras, uidmap, slirp4netns and fuse-overlayfs manually." >&2
      exit 1
      ;;
  esac
}

if [ "$INSTALL_DOCKER_CE" = 1 ]; then
  install_docker_ce
elif ! command -v docker >/dev/null 2>&1 || ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
  echo "Docker/rootless extras not found." >&2
  echo "Review then re-run with --install-docker-ce on Debian/Ubuntu, or install docker-ce-rootless-extras manually." >&2
  exit 1
fi

if id -u "$SANDBOX_USER" >/dev/null 2>&1; then
  echo "user $SANDBOX_USER already exists"
else
  run useradd --create-home --shell /bin/bash "$SANDBOX_USER"
fi

SUBUID_END=$((SUBUID_START + SUBUID_COUNT - 1))
if grep -qs "^$SANDBOX_USER:" /etc/subuid; then
  echo "subuid already configured for $SANDBOX_USER"
else
  run usermod --add-subuids "${SUBUID_START}-${SUBUID_END}" "$SANDBOX_USER"
fi
if grep -qs "^$SANDBOX_USER:" /etc/subgid; then
  echo "subgid already configured for $SANDBOX_USER"
else
  run usermod --add-subgids "${SUBUID_START}-${SUBUID_END}" "$SANDBOX_USER"
fi

run loginctl enable-linger "$SANDBOX_USER"
UID_NUM="$(id -u "$SANDBOX_USER")"

if [ -S "/run/user/$UID_NUM/docker.sock" ] || [ -S "/run/user/$UID_NUM/dockerd-rootless/api.sock" ]; then
  echo "rootless Docker socket already present for $SANDBOX_USER"
elif command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
  run runuser -u "$SANDBOX_USER" -- env \
    XDG_RUNTIME_DIR="/run/user/$UID_NUM" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_NUM/bus" \
    dockerd-rootless-setuptool.sh install
else
  echo "WARN: dockerd-rootless-setuptool.sh missing; rootless Docker was not initialized." >&2
fi

if [ "$DRY_RUN" = 0 ]; then
  echo "smoke test (as $SANDBOX_USER):"
  if runuser -u "$SANDBOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_NUM" docker run --rm hello-world >/dev/null 2>&1; then
    echo "SANDBOX_BOOTSTRAP_OK"
  else
    echo "bootstrap finished, but hello-world smoke test failed; inspect rootless Docker logs." >&2
    exit 1
  fi
fi
