#!/usr/bin/env bash
# Install, inspect, enable or remove the single user-level service used by
# feishu4dsh. Run this as the Unix account that owns the user systemd manager.
#
# Service boundary:
#   dsh-feishu4dsh.service owns the Feishu/Lark channel process and connects it
#   to dsh. SHE agent-control-plane/sandbox/broker services are intentionally
#   not managed here; they belong to the separate 2611she project.
#
# Usage:
#   bash scripts/install-user-services.sh --dry-run
#   bash scripts/install-user-services.sh --check
#   bash scripts/install-user-services.sh --enable
#   bash scripts/install-user-services.sh --uninstall
#
# Modes (exactly one; default: --dry-run):
#   --dry-run    Print the desired unit and commands; write/start nothing.
#   --check      Read-only unit/env/systemd state check.
#   --enable     Write the unit if needed, daemon-reload, enable --now.
#   --uninstall  Disable/remove the unit; keep deployment files and data.
#
# Options:
#   --replace            Allow replacing a differing existing unit (backup kept).
#   --repo <path>        Deployment/source repo (default: script parent).
#   --profile <name>     dsh profile (default: feishu4dsh).
#   --dsh <path>         dsh executable (default: command -v dsh).
#   --env-file <path>    EnvironmentFile (default: ~/.config/feishu4dsh/feishu4dsh.env).
#   -h, --help           Show this help.
#
# The installer never creates or reads Feishu secrets, never installs Docker or
# agents, and never uses sudo.
set -euo pipefail

if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

MODE="dry-run"
WITH_REPLACE=0
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO="$(cd "$(dirname "$SELF_PATH")/.." && pwd)"
PROFILE="feishu4dsh"
DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
ENV_FILE="${FEISHU4DSH_ENV_FILE:-$HOME/.config/feishu4dsh/feishu4dsh.env}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="dsh-feishu4dsh.service"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"

usage() {
  awk 'NR >= 2 && /^set -euo pipefail$/ { exit } NR >= 2 { print }' "$0"
}
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --check) MODE="check"; shift ;;
    --enable) MODE="enable"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --replace) WITH_REPLACE=1; shift ;;
    --repo) [ "$#" -ge 2 ] || die "--repo requires a value"; REPO="$2"; shift 2 ;;
    --profile) [ "$#" -ge 2 ] || die "--profile requires a value"; PROFILE="$2"; shift 2 ;;
    --dsh) [ "$#" -ge 2 ] || die "--dsh requires a value"; DSH_BIN="$2"; shift 2 ;;
    --env-file) [ "$#" -ge 2 ] || die "--env-file requires a value"; ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
done

REPO="$(cd "$REPO" 2>/dev/null && pwd)" || die "repo not found: $REPO"
[ -n "$DSH_BIN" ] || die "dsh executable not found; pass --dsh /absolute/path/to/dsh"
[ -x "$DSH_BIN" ] || die "dsh executable is not executable: $DSH_BIN"

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

unit_content() {
  cat <<UNIT
[Unit]
Description=feishu4dsh — DeepSeek Harness Feishu/Lark channel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$HOME")
ExecStart=$(systemd_quote "$DSH_BIN") --profile $(systemd_quote "$PROFILE")
Environment=HOME=$(systemd_quote "$HOME")
EnvironmentFile=$(systemd_quote "$ENV_FILE")
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
}

unit_exists() { [ -e "$UNIT_PATH" ]; }
unit_enabled() { systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1; }
unit_active() { systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; }
systemd_reachable() { systemctl --user show-environment >/dev/null 2>&1; }
unit_fragment_path() {
  systemctl --user show -p FragmentPath --value "$UNIT_NAME" 2>/dev/null | head -n 1
}

describe() {
  say "unit: $UNIT_PATH"
  say "repo: $REPO"
  say "profile: $PROFILE"
  say "dsh: $DSH_BIN"
  say "env: $ENV_FILE"
  if unit_exists; then
    say "units state: present"
  else
    say "units state: missing at $UNIT_PATH"
  fi
  if systemd_reachable; then
    say "systemd --user: reachable"
    say "enabled: $(unit_enabled && echo yes || echo no)"
    say "active: $(unit_active && echo yes || echo no)"
    local loaded
    loaded="$(unit_fragment_path)"
    if [ -n "$loaded" ]; then
      say "loaded unit: $loaded"
      [ "$loaded" = "$UNIT_PATH" ] || say "WARNING: loaded unit path differs from target: $UNIT_PATH"
    fi
  else
    say "systemd --user: unreachable (run in the target account's login shell)"
  fi
}

write_unit() {
  mkdir -p "$UNIT_DIR"
  local tmp="$UNIT_PATH.tmp"
  unit_content > "$tmp"
  if unit_exists; then
    if cmp -s "$tmp" "$UNIT_PATH"; then
      rm -f "$tmp"
      say "unit unchanged: $UNIT_PATH"
      return
    fi
    if [ "$WITH_REPLACE" != "1" ]; then
      rm -f "$tmp"
      die "existing unit differs: $UNIT_PATH (rerun with --replace after review)"
    fi
    cp "$UNIT_PATH" "$UNIT_PATH.bak.$(date +%Y%m%d-%H%M%S)"
  fi
  local loaded
  loaded="$(unit_fragment_path 2>/dev/null || true)"
  if [ -n "$loaded" ] && [ "$loaded" != "$UNIT_PATH" ] && [ "$WITH_REPLACE" != "1" ]; then
    rm -f "$tmp"
    die "systemd is loading this service from another path: $loaded (review it, then rerun with --replace)"
  fi
  mv "$tmp" "$UNIT_PATH"
  say "wrote $UNIT_PATH"
}

check_env() {
  if [ ! -f "$ENV_FILE" ]; then
    say "env file missing: $ENV_FILE"
    return 1
  fi
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  if [ "$mode" != "600" ]; then
    say "env file permissions are $mode, expected 600: $ENV_FILE"
    return 1
  fi
  if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?FEISHU_APP_ID=' "$ENV_FILE"; then
    say "env file does not define FEISHU_APP_ID: $ENV_FILE"
    return 1
  fi
  if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?FEISHU_APP_SECRET=' "$ENV_FILE"; then
    say "env file does not define FEISHU_APP_SECRET: $ENV_FILE"
    return 1
  fi
  say "env file: OK ($ENV_FILE, mode 600)"
}

case "$MODE" in
  dry-run)
    describe
    say ""
    say "== desired unit =="
    unit_content
    say ""
    say "commands:"
    say "  mkdir -p $UNIT_DIR"
    say "  # write the unit above to $UNIT_PATH"
    say "  systemctl --user daemon-reload"
    say "  systemctl --user enable --now $UNIT_NAME"
    say "  journalctl --user -u $UNIT_NAME -f"
    ;;
  check)
    describe
    failures=0
    check_env || failures=$((failures + 1))
    [ "$failures" -eq 0 ] || exit 1
    systemd_reachable || exit 1
    unit_enabled || { say "unit is not enabled: $UNIT_NAME"; failures=$((failures + 1)); }
    unit_active || { say "unit is not active: $UNIT_NAME"; failures=$((failures + 1)); }
    loaded="$(unit_fragment_path)"
    if [ -n "$loaded" ] && [ "$loaded" != "$UNIT_PATH" ]; then
      say "unit is loaded from a different path: $loaded (expected $UNIT_PATH)"
      failures=$((failures + 1))
    fi
    [ "$failures" -eq 0 ] || exit 1
    say "✅ feishu4dsh channel service is ready"
    ;;
  enable)
    describe
    check_env || die "fix the env file before enabling the service"
    write_unit
    systemd_reachable || die "systemd --user is unreachable"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    systemctl --user --no-pager --full status "$UNIT_NAME" || true
    say ""
    say "logs: journalctl --user -u $UNIT_NAME -f"
    ;;
  uninstall)
    describe
    if systemd_reachable; then
      systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
      systemctl --user daemon-reload
    fi
    if unit_exists; then
      rm -f "$UNIT_PATH"
      say "removed $UNIT_PATH"
    else
      say "unit not present: $UNIT_PATH"
    fi
    say "kept deployment repo and runtime data."
    ;;
esac
