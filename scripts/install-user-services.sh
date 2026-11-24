#!/usr/bin/env bash
# Install/enable the two user-level services used by feishu4dsh:
#   1) dsh-feishu4dsh.service       (dsh channel process)
#   2) feishu4dsh-sandbox-broker.service (host-local Unix-socket broker)
#
# This script is intentionally non-root. Run it as the account that should own
# the services. For a dedicated sandbox account, run it as that account after
# root bootstrap and rootless Docker initialization.
#
# Usage:
#   bash scripts/install-user-services.sh --dry-run
#   bash scripts/install-user-services.sh --enable
#   bash scripts/install-user-services.sh --uninstall
#
# Optional:
#   --repo <path>       repository/deployment path (default: script parent)
#   --profile <name>    dsh profile (default: feishu4dsh)
#   --dsh <path>        dsh executable (default: command -v dsh)
#   --env-file <path>   feishu4dsh environment file (default: ~/.config/feishu4dsh/feishu4dsh.env)
set -euo pipefail

MODE="dry-run"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="feishu4dsh"
DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
ENV_FILE="${FEISHU4D_FDSH_ENV_FILE:-$HOME/.config/feishu4dsh/feishu4dsh.env}"
UNIT_DIR="$HOME/.config/systemd/user"
DSH_UNIT="$UNIT_DIR/dsh-feishu4dsh.service"
BROKER_UNIT="$UNIT_DIR/feishu4dsh-sandbox-broker.service"
BROKER_SCRIPT=""
SOCKET_PATH="$HOME/.local/share/feishu4dsh/broker/broker.sock"
REGISTRY_PATH="$HOME/.local/share/feishu4dsh/broker/registry.json"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --enable) MODE="enable"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --repo) [ "$#" -ge 2 ] || { echo "--repo requires a value" >&2; exit 2; }; REPO="$2"; shift 2 ;;
    --profile) [ "$#" -ge 2 ] || { echo "--profile requires a value" >&2; exit 2; }; PROFILE="$2"; shift 2 ;;
    --dsh) [ "$#" -ge 2 ] || { echo "--dsh requires a value" >&2; exit 2; }; DSH_BIN="$2"; shift 2 ;;
    --env-file) [ "$#" -ge 2 ] || { echo "--env-file requires a value" >&2; exit 2; }; ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$REPO" && pwd)"
BROKER_SCRIPT="$REPO/scripts/sandbox-broker.sh"
[ -f "$BROKER_SCRIPT" ] || { echo "missing $BROKER_SCRIPT" >&2; exit 1; }
[ -n "$DSH_BIN" ] || { echo "dsh executable not found; pass --dsh /absolute/path/to/dsh" >&2; exit 1; }
[ -x "$DSH_BIN" ] || { echo "dsh executable is not executable: $DSH_BIN" >&2; exit 1; }
if [ ! -f "$ENV_FILE" ]; then
  echo "warning: feishu4dsh env file not found: $ENV_FILE" >&2
  echo "Create it with FEISHU_APP_ID/FEISHU_APP_SECRET before enabling the channel." >&2
fi

dsh_unit_content() {
  cat <<UNIT
[Unit]
Description=feishu4dsh — DeepSeek Harness Feishu/Lark channel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
ExecStart=$DSH_BIN --profile $PROFILE
Environment=HOME=$HOME
Environment=PATH=$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
}

broker_unit_content() {
  cat <<UNIT
[Unit]
Description=feishu4dsh sandbox broker (Unix socket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=/usr/bin/env bash $BROKER_SCRIPT serve --socket $SOCKET_PATH --registry $REGISTRY_PATH
Environment=HOME=$HOME
Environment=PATH=$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
}

run() {
  if [ "$MODE" = "dry-run" ]; then
    printf '+ '; printf '%q ' "$@"; echo
  else
    "$@"
  fi
}

if [ "$MODE" = "uninstall" ]; then
  echo "Stopping/removing user services (data is retained):"
  run systemctl --user disable --now dsh-feishu4dsh.service || true
  run systemctl --user disable --now feishu4dsh-sandbox-broker.service || true
  run rm -f "$DSH_UNIT" "$BROKER_UNIT"
  run systemctl --user daemon-reload || true
  exit 0
fi

echo "== dsh unit =="
dsh_unit_content
echo
echo "== broker unit =="
broker_unit_content
echo

if [ "$MODE" = "dry-run" ]; then
  echo "Dry-run only. To write and enable:"
  echo "  bash $0 --enable --repo $REPO --profile $PROFILE --dsh $DSH_BIN --env-file $ENV_FILE"
  exit 0
fi

command -v systemctl >/dev/null 2>&1 || { echo "systemctl unavailable" >&2; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || {
  echo "user systemd bus unavailable; run this from the interactive user session (or configure XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS)" >&2
  exit 1
}

mkdir -p "$UNIT_DIR"
[ -f "$DSH_UNIT" ] && cp -a "$DSH_UNIT" "$DSH_UNIT.bak-$(date +%Y%m%d-%H%M%S)"
[ -f "$BROKER_UNIT" ] && cp -a "$BROKER_UNIT" "$BROKER_UNIT.bak-$(date +%Y%m%d-%H%M%S)"
dsh_unit_content > "$DSH_UNIT"
broker_unit_content > "$BROKER_UNIT"
chmod 0600 "$DSH_UNIT" "$BROKER_UNIT"
systemctl --user daemon-reload
systemctl --user enable --now feishu4dsh-sandbox-broker.service
systemctl --user enable --now dsh-feishu4dsh.service
sleep 2
echo "== broker status =="
systemctl --user --no-pager --full status feishu4dsh-sandbox-broker.service || true
echo "== dsh status =="
systemctl --user --no-pager --full status dsh-feishu4dsh.service || true
echo
echo "Next: check logs:"
echo "  journalctl --user -u feishu4dsh-sandbox-broker.service -n 50 --no-pager"
echo "  journalctl --user -u dsh-feishu4dsh.service -n 50 --no-pager"
