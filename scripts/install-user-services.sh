#!/usr/bin/env bash
# Install, enable, inspect, or remove the two user-level services used by
# feishu4dsh. This script is intentionally non-root: run every invocation as
# the Unix account that owns the corresponding user systemd instance.
#
# Service boundary:
#   - dsh-feishu4dsh.service owns the Feishu channel/dsh process. It reads the
#     Feishu app credentials and talks to the local broker over a Unix socket.
#   - feishu4dsh-sandbox-broker.service owns the narrow sandbox-control API and
#     uses the *same account's* rootless Docker daemon. It never listens on LAN
#     and is independent from the dsh process lifecycle.
#
# Both services use fixed XDG paths under the current account's $HOME. The
# current broker client supports the same-account layout only: do not install
# the broker as one Unix user and expect the dsh service in another user to
# reach its 0600 socket. For a dedicated sandbox account, run the broker-only
# installation as that account after its rootless Docker is ready.
#
# Usage:
#   bash scripts/install-user-services.sh --dry-run
#   bash scripts/install-user-services.sh --enable
#   bash scripts/install-user-services.sh --check
#   bash scripts/install-user-services.sh --uninstall
#
# Modes (exactly one; default: --dry-run):
#   --dry-run       Discover the current service location, then print desired
#                   unit files and commands; write/start nothing.
#   --enable        Discover first; write/create units only when needed,
#                   daemon-reload, enable --now, then health-check.
#   --check         Read-only: reported service location, unit state, env file,
#                   socket and broker health.
#   --uninstall     Stop/disable and remove selected installer-managed units;
#                   keep registry/data.
#
# Options:
#   --only all|channel|broker   Select services (default: all).
#   --channel-only              Alias for --only channel.
#   --broker-only               Alias for --only broker.
#   --replace                   Allow replacing an existing differing unit (a
#                               timestamped backup is kept). Without it, the
#                               installer refuses to overwrite or shadow a
#                               service it did not generate identically.
#   --repo <path>               Deployment/source repo (default: script parent).
#   --profile <name>            dsh profile (default: feishu4dsh).
#   --dsh <path>                dsh executable (default: command -v dsh).
#   --env-file <path>           Channel EnvironmentFile
#                               (default: ~/.config/feishu4dsh/feishu4dsh.env).
#   --socket <path>             Broker Unix socket
#                               (default: ~/.local/share/feishu4dsh/broker/broker.sock).
#   --registry <path>           Broker registry JSON
#                               (default: ~/.local/share/feishu4dsh/broker/registry.json).
#   -h, --help                  Show this help.
#
# The installer never edits Docker/rootless settings, never creates Feishu
# secrets, and never deletes broker registry/sandbox data during --uninstall.
set -euo pipefail

# Non-login shells (CI, agent terminals, some SSH wrappers) often lack the
# environment needed to talk to the user systemd manager. Infer the standard
# per-UID runtime directory only when the caller did not provide one; never
# override an explicit XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

MODE="dry-run"
ONLY="all"
WITH_REPLACE=0
# Resolve symlinks so a stable launcher can point at this script from
# ~/.local/bin without changing the inferred deployment repo.
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO="$(cd "$(dirname "$SELF_PATH")/.." && pwd)"
PROFILE="feishu4dsh"
DSH_BIN="${DSH_BIN:-$(command -v dsh 2>/dev/null || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
ENV_FILE="${FEISHU4DSH_ENV_FILE:-${FEISHU4D_FDSH_ENV_FILE:-$HOME/.config/feishu4dsh/feishu4dsh.env}}"
# Respect XDG_CONFIG_HOME (systemd's user unit search path); do not assume the
# service is always at the legacy ~/.config location.
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DSH_UNIT="$UNIT_DIR/dsh-feishu4dsh.service"
BROKER_UNIT="$UNIT_DIR/feishu4dsh-sandbox-broker.service"
BROKER_SCRIPT=""
SOCKET_PATH="${FEISHU4DSH_BROKER_SOCKET:-$HOME/.local/share/feishu4dsh/broker/broker.sock}"
REGISTRY_PATH="${FEISHU4DSH_BROKER_REGISTRY:-$HOME/.local/share/feishu4dsh/broker/registry.json}"

usage() {
  # Print the comment block above `set -euo pipefail`, not implementation.
  awk 'NR >= 2 && /^set -euo pipefail$/ { exit } NR >= 2 { print }' "$0"
}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --enable) MODE="enable"; shift ;;
    --check) MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --replace) WITH_REPLACE=1; shift ;;
    --only)
      [ "$#" -ge 2 ] || die "--only requires a value: all|channel|broker"
      ONLY="$2"; shift 2 ;;
    --channel-only) ONLY="channel"; shift ;;
    --broker-only) ONLY="broker"; shift ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires a value"
      REPO="$2"; shift 2 ;;
    --profile)
      [ "$#" -ge 2 ] || die "--profile requires a value"
      PROFILE="$2"; shift 2 ;;
    --dsh)
      [ "$#" -ge 2 ] || die "--dsh requires a value"
      DSH_BIN="$2"; shift 2 ;;
    --env-file)
      [ "$#" -ge 2 ] || die "--env-file requires a value"
      ENV_FILE="$2"; shift 2 ;;
    --socket)
      [ "$#" -ge 2 ] || die "--socket requires a value"
      SOCKET_PATH="$2"; shift 2 ;;
    --registry)
      [ "$#" -ge 2 ] || die "--registry requires a value"
      REGISTRY_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (use --help)" ;;
  esac
done

case "$ONLY" in
  all|channel|broker) ;;
  *) die "--only must be all, channel or broker (got: $ONLY)" ;;
esac
[ "$(id -u)" -ne 0 ] || die "run as the target Unix user, not root (this is a user-level systemd installer)"

REPO="$(cd "$REPO" 2>/dev/null && pwd)" || die "repo path does not exist: $REPO"
BROKER_SCRIPT="$REPO/scripts/sandbox-broker.sh"
if [ "$ONLY" = "all" ] || [ "$ONLY" = "broker" ]; then
  [ -f "$BROKER_SCRIPT" ] || die "missing broker wrapper: $BROKER_SCRIPT"
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "node executable not found; pass NODE_BIN=/absolute/path/to/node"
fi
if [ "$ONLY" = "all" ] || [ "$ONLY" = "channel" ]; then
  [ -n "$DSH_BIN" ] || die "dsh executable not found; pass --dsh /absolute/path/to/dsh"
  [ -x "$DSH_BIN" ] || die "dsh executable is not executable: $DSH_BIN"
fi

channel_selected() { [ "$ONLY" = "all" ] || [ "$ONLY" = "channel" ]; }
broker_selected() { [ "$ONLY" = "all" ] || [ "$ONLY" = "broker" ]; }
NODE_PATH_PREFIX=""
if [ -n "$NODE_BIN" ]; then NODE_PATH_PREFIX="$(dirname "$NODE_BIN"):"; fi

# Quote a value for a systemd unit assignment. Paths with spaces are rare but
# silently truncating one in a generated unit is unacceptable.
systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

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
Environment=PATH=${NODE_PATH_PREFIX}$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=$(systemd_quote "$ENV_FILE")
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
}

broker_unit_content() {
  cat <<UNIT
[Unit]
Description=feishu4dsh sandbox broker (host-local Unix socket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$REPO")
ExecStart=$(systemd_quote "$BROKER_SCRIPT") serve --socket $(systemd_quote "$SOCKET_PATH") --registry $(systemd_quote "$REGISTRY_PATH")
Environment=HOME=$HOME
Environment=NODE_BIN=$NODE_BIN
Environment=PATH=${NODE_PATH_PREFIX}$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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

systemctl_user_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

unit_exists() { [ -f "$1" ]; }
unit_enabled() { systemctl --user is-enabled "$1" 2>/dev/null || true; }
unit_active() { systemctl --user is-active "$1" 2>/dev/null || true; }
systemd_user_show() {
  systemctl --user show -p "$2" --value "$1" 2>/dev/null || true
}
file_matches() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }

# Print both the location this installer would use and the location the user
# systemd manager actually loaded. This is deliberately read-only and is useful
# even when the systemd user bus is unavailable.
describe_service_location() {
  local unit="$1" label="$2" expected="$3"
  say "== $label =="
  say "  unit: $unit"
  say "  installer-managed path: $expected"
  if [ -f "$expected" ]; then
    say "  file: present ($expected)"
  else
    say "  file: absent"
  fi
  if systemctl_user_available; then
    local fragment load unit_file_state active working_directory exec_start env_files drop_ins
    fragment="$(systemd_user_show "$unit" FragmentPath)"
    load="$(systemd_user_show "$unit" LoadState)"
    unit_file_state="$(systemd_user_show "$unit" UnitFileState)"
    active="$(systemd_user_show "$unit" ActiveState)"
    working_directory="$(systemd_user_show "$unit" WorkingDirectory)"
    exec_start="$(systemd_user_show "$unit" ExecStart)"
    env_files="$(systemd_user_show "$unit" EnvironmentFiles)"
    drop_ins="$(systemd_user_show "$unit" DropInPaths)"
    say "  systemd LoadState: ${load:-unknown}"
    say "  systemd loaded from: ${fragment:-（未找到 loaded unit）}"
    say "  enabled: ${unit_file_state:-unknown}"
    say "  active: ${active:-unknown}"
    [ -n "$working_directory" ] && say "  WorkingDirectory: $working_directory"
    [ -n "$exec_start" ] && say "  ExecStart: $exec_start"
    [ -n "$env_files" ] && say "  EnvironmentFiles: $env_files"
    [ -n "$drop_ins" ] && say "  DropInPaths: $drop_ins"
    if [ -n "$fragment" ] && [ "$fragment" != "$expected" ]; then
      say "  ! systemd is using a unit outside the installer-managed path"
    fi
  else
    say "  systemd user bus: unavailable (file-only inspection)"
    say "  set XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS or run from the target account"
  fi
}

# Refuse to silently overwrite a differing unit or create a same-name user unit
# that would shadow a unit loaded from another location. --replace is explicit
# and always backs up the installer-managed file before rewriting it.
assert_service_plan_safe() {
  local unit="$1" label="$2" expected="$3" desired="$4"
  if systemctl_user_available; then
    local fragment
    fragment="$(systemd_user_show "$unit" FragmentPath)"
    if [ -n "$fragment" ] && [ "$fragment" != "$expected" ]; then
      if [ "$WITH_REPLACE" -ne 1 ]; then
        say "✗ $label is currently loaded from: $fragment"
        say "  expected installer-managed path: $expected"
        say "  refusing to create a duplicate/shadow unit; inspect with: systemctl --user cat $unit"
        say "  re-run with --replace only after reviewing the existing unit"
        return 1
      fi
      say "! --replace: systemd currently loads $fragment; the user unit at"
      say "  $expected will shadow it after daemon-reload"
    fi
  fi
  if [ -f "$expected" ] && ! file_matches "$expected" "$desired"; then
    if [ "$WITH_REPLACE" -ne 1 ]; then
      say "✗ existing unit differs from the desired generated unit: $expected"
      say "  inspect: systemctl --user cat $unit"
      say "  re-run with --replace to keep a timestamped backup and overwrite"
      return 1
    fi
  fi
  return 0
}

check_env_file() {
  local ok=0
  if [ -f "$ENV_FILE" ]; then
    say "✓ env file: $ENV_FILE"
    local mode
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
    if [ -n "$mode" ] && [ $((8#$mode & 8#077)) -ne 0 ]; then
      say "! env file is readable by group/other (mode $mode); use chmod 600"
      ok=1
    fi
    if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?FEISHU_APP_ID=' "$ENV_FILE"; then
      say "! env file does not contain FEISHU_APP_ID (systemd EnvironmentFile syntax: KEY=value)"
      ok=1
    fi
    if ! grep -Eq '^[[:space:]]*(export[[:space:]]+)?FEISHU_APP_SECRET=' "$ENV_FILE"; then
      say "! env file does not contain FEISHU_APP_SECRET"
      ok=1
    fi
  else
    say "✗ env file missing: $ENV_FILE"
    say "  create it with FEISHU_APP_ID=... and FEISHU_APP_SECRET=..., then chmod 600 it"
    return 1
  fi
  return "$ok"
}

check_broker_health() {
  if [ ! -S "$SOCKET_PATH" ]; then
    say "✗ broker socket missing: $SOCKET_PATH"
    return 1
  fi
  if [ ! -x "$BROKER_SCRIPT" ]; then
    say "✗ broker wrapper is not executable: $BROKER_SCRIPT"
    return 1
  fi
  if [ ! -f "$REPO/scripts/sandbox-broker.mjs" ]; then
    say "✗ broker CLI missing: $REPO/scripts/sandbox-broker.mjs"
    return 1
  fi
  if "$NODE_BIN" "$REPO/scripts/sandbox-broker.mjs" health --socket "$SOCKET_PATH" >/dev/null 2>&1; then
    say "✓ broker health: $SOCKET_PATH"
    return 0
  fi
  say "✗ broker socket exists but health check failed: $SOCKET_PATH"
  return 1
}

check_one_service() {
  local unit="$1" label="$2" expected="$3" failures=0
  describe_service_location "$unit" "$label" "$expected"
  if [ ! -f "$expected" ]; then
    say "  ✗ installer-managed unit file missing"
    failures=$((failures + 1))
  fi
  if systemctl_user_available; then
    local fragment active enabled
    fragment="$(systemd_user_show "$unit" FragmentPath)"
    active="$(unit_active "$unit")"
    enabled="$(unit_enabled "$unit")"
    if [ -n "$fragment" ] && [ "$fragment" != "$expected" ]; then
      say "  ✗ loaded unit is outside installer-managed path: $fragment"
      failures=$((failures + 1))
    fi
    if [ "$active" != "active" ]; then
      say "  ✗ service is not active (active=$active)"
      failures=$((failures + 1))
    fi
    if [ "$enabled" != "enabled" ] && [ "$enabled" != "enabled-runtime" ]; then
      say "  ! service is not enabled (UnitFileState=$enabled)"
      failures=$((failures + 1))
    fi
  else
    say "  ✗ user systemd bus unavailable; cannot verify service state"
    failures=$((failures + 1))
  fi
  return "$failures"
}

if [ "$MODE" = "uninstall" ]; then
  say "Stopping/removing selected installer-managed user services (registry/sandbox data is retained):"
  say "== service discovery before removal =="
  say "  account: $(id -un)"
  say "  user unit directory: $UNIT_DIR"
  if channel_selected; then
    describe_service_location "dsh-feishu4dsh.service" "channel service" "$DSH_UNIT"
  fi
  if broker_selected; then
    describe_service_location "feishu4dsh-sandbox-broker.service" "broker service" "$BROKER_UNIT"
  fi
  if systemctl_user_available; then
    if channel_selected; then run systemctl --user disable --now dsh-feishu4dsh.service || true; fi
    if broker_selected; then run systemctl --user disable --now feishu4dsh-sandbox-broker.service || true; fi
  else
    say "! user systemd bus unavailable; skipping stop/disable and removing installer-managed unit files only"
  fi
  if channel_selected; then
    fragment="$(systemd_user_show "dsh-feishu4dsh.service" FragmentPath)"
    if [ -n "$fragment" ] && [ "$fragment" != "$DSH_UNIT" ]; then
      say "! channel service is loaded from $fragment; not removing $DSH_UNIT"
    else
      run rm -f "$DSH_UNIT"
    fi
  fi
  if broker_selected; then
    fragment="$(systemd_user_show "feishu4dsh-sandbox-broker.service" FragmentPath)"
    if [ -n "$fragment" ] && [ "$fragment" != "$BROKER_UNIT" ]; then
      say "! broker service is loaded from $fragment; not removing $BROKER_UNIT"
    else
      run rm -f "$BROKER_UNIT"
    fi
  fi
  if systemctl_user_available; then run systemctl --user daemon-reload || true; fi
  exit 0
fi

if [ "$MODE" = "check" ]; then
  say "feishu4dsh user-service check (account: $(id -un), only: $ONLY)"
  failures=0
  if channel_selected; then
    check_one_service "dsh-feishu4dsh.service" "channel service" "$DSH_UNIT" || failures=$((failures + 1))
    check_env_file || failures=$((failures + 1))
  fi
  if broker_selected; then
    check_one_service "feishu4dsh-sandbox-broker.service" "broker service" "$BROKER_UNIT" || failures=$((failures + 1))
    check_broker_health || failures=$((failures + 1))
  fi
  say ""
  if [ "$failures" -eq 0 ]; then
    say "SERVICE_CHECK_OK"
    exit 0
  fi
  say "SERVICE_CHECK_FAILED ($failures issue(s))"
  exit 1
fi

if [ "$MODE" = "dry-run" ]; then
  say "== current service discovery =="
  say "  account: $(id -un)"
  say "  user unit directory: $UNIT_DIR"
  if channel_selected; then
    describe_service_location "dsh-feishu4dsh.service" "channel service" "$DSH_UNIT"
  fi
  if broker_selected; then
    describe_service_location "feishu4dsh-sandbox-broker.service" "broker service" "$BROKER_UNIT"
  fi
  say ""
  if channel_selected; then
    say "== desired dsh unit =="
    dsh_unit_content
    say ""
  fi
  if broker_selected; then
    say "== desired broker unit =="
    broker_unit_content
    say ""
  fi
  if channel_selected && [ ! -f "$ENV_FILE" ]; then
    say "! warning: channel env file not found: $ENV_FILE"
    say "  create it before --enable; systemd EnvironmentFile does not expand shell exports."
  fi
  say "Dry-run only. To inspect current state (read-only):"
  say "  bash $0 --check --only $ONLY"
  say "To write and enable selected services:"
  say "  bash $0 --enable --only $ONLY --repo $REPO --profile $PROFILE --dsh $DSH_BIN --env-file $ENV_FILE"
  exit 0
fi

# --enable
if channel_selected && [ ! -f "$ENV_FILE" ]; then
  die "channel env file not found: $ENV_FILE (create it with FEISHU_APP_ID/FEISHU_APP_SECRET and chmod 600, or pass --env-file)"
fi
systemctl_user_available || die "user systemd bus unavailable; run from the target account's interactive session or configure XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS"

# Discover before creating directories or touching units. If a service is
# already loaded from another path or an existing unit differs, stop and ask
# for --replace instead of silently adding a second/shadowing unit.
say "== current service discovery before apply =="
say "  account: $(id -un)"
say "  user unit directory: $UNIT_DIR"
CHANNEL_DESIRED=""
BROKER_DESIRED=""
WRITE_DSH=0
WRITE_BROKER=0
if channel_selected; then
  describe_service_location "dsh-feishu4dsh.service" "channel service" "$DSH_UNIT"
  CHANNEL_DESIRED="$(dsh_unit_content)"
  assert_service_plan_safe "dsh-feishu4dsh.service" "channel service" "$DSH_UNIT" "$CHANNEL_DESIRED" || exit 1
  if ! file_matches "$DSH_UNIT" "$CHANNEL_DESIRED"; then WRITE_DSH=1; fi
fi
if broker_selected; then
  describe_service_location "feishu4dsh-sandbox-broker.service" "broker service" "$BROKER_UNIT"
  BROKER_DESIRED="$(broker_unit_content)"
  assert_service_plan_safe "feishu4dsh-sandbox-broker.service" "broker service" "$BROKER_UNIT" "$BROKER_DESIRED" || exit 1
  if ! file_matches "$BROKER_UNIT" "$BROKER_DESIRED"; then WRITE_BROKER=1; fi
fi

if [ "$WRITE_DSH" -eq 0 ] && [ "$WRITE_BROKER" -eq 0 ]; then
  say "== unit files already match desired content; no unit rewrite needed =="
else
  # Only now create the user unit directory, after discovery and safety checks.
  mkdir -p "$UNIT_DIR"
fi
if [ "$WRITE_DSH" -eq 1 ]; then
  if [ -f "$DSH_UNIT" ]; then
    cp -a "$DSH_UNIT" "$DSH_UNIT.bak-$(date +%Y%m%d-%H%M%S)"
    say "backed up existing channel unit: $DSH_UNIT.bak-*"
  fi
  printf '%s\n' "$CHANNEL_DESIRED" > "$DSH_UNIT"
  chmod 0600 "$DSH_UNIT"
  say "wrote channel unit: $DSH_UNIT"
fi
if [ "$WRITE_BROKER" -eq 1 ]; then
  if [ -f "$BROKER_UNIT" ]; then
    cp -a "$BROKER_UNIT" "$BROKER_UNIT.bak-$(date +%Y%m%d-%H%M%S)"
    say "backed up existing broker unit: $BROKER_UNIT.bak-*"
  fi
  printf '%s\n' "$BROKER_DESIRED" > "$BROKER_UNIT"
  chmod 0600 "$BROKER_UNIT"
  say "wrote broker unit: $BROKER_UNIT"
fi
if [ "$WRITE_DSH" -eq 1 ] || [ "$WRITE_BROKER" -eq 1 ]; then
  systemctl --user daemon-reload
fi

if broker_selected; then
  systemctl --user enable --now feishu4dsh-sandbox-broker.service
  for _ in $(seq 1 20); do
    [ -S "$SOCKET_PATH" ] && break
    sleep 0.25
  done
  if check_broker_health; then
    :
  else
    say "Broker failed its health check. Inspect:"
    say "  journalctl --user -u feishu4dsh-sandbox-broker.service -n 80 --no-pager"
    exit 1
  fi
fi
if channel_selected; then
  systemctl --user enable --now dsh-feishu4dsh.service
fi

say ""
if channel_selected; then
  say "== dsh status =="
  systemctl --user --no-pager --full status dsh-feishu4dsh.service || true
fi
if broker_selected; then
  say "== broker status =="
  systemctl --user --no-pager --full status feishu4dsh-sandbox-broker.service || true
fi
say ""
say "Check again at any time:"
say "  bash $0 --check --only $ONLY"
say "Logs:"
if channel_selected; then say "  journalctl --user -u dsh-feishu4dsh.service -n 50 --no-pager"; fi
if broker_selected; then say "  journalctl --user -u feishu4dsh-sandbox-broker.service -n 50 --no-pager"; fi
say ""
say "Find this installer again from the deployed dsh profile (no file transfer):"
printf '  PLUGIN_DIR="$(readlink -f "${DSH_HOME:-$HOME/.dsh}/profiles/%s/node_modules/feishu4dsh")"\n' "$PROFILE"
printf '  bash "$PLUGIN_DIR/scripts/install-user-services.sh" --check --repo "$PLUGIN_DIR"\n'
