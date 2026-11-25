#!/usr/bin/env bash
# Check the local feishu4dsh development prerequisites.
# Optionally install pnpm locally without sudo. It does not install Docker,
# rootless Docker, agents, or sandbox containers.
#
# Usage:
#   bash scripts/bootstrap-dev-env.sh --check
#   bash scripts/bootstrap-dev-env.sh --install-pnpm
#
# Node.js itself is not installed automatically: installing a language runtime
# needs a distro/network-specific decision and should be reviewed by the operator.
set -euo pipefail

MODE="check"
case "${1:-}" in
  --check|"") MODE="check" ;;
  --install-pnpm|--install) MODE="install-pnpm" ;;
  -h|--help)
    sed -n '2,13p' "$0"
    exit 0
    ;;
  *)
    echo "usage: $0 [--check|--install-pnpm]" >&2
    exit 2
    ;;
esac

PKG_PNPM="pnpm@11.22.0"
if [ -f package.json ] && command -v node >/dev/null 2>&1; then
  PKG_PNPM="$(node -e "const p=require('./package.json'); const m=String(p.packageManager||'pnpm@11.22.0').replace(/\+\+.*$/,''); process.stdout.write(m)" 2>/dev/null || printf '%s' "$PKG_PNPM")"
fi

ok() { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }
bad() { printf '✗ %s\n' "$*"; }

NODE_BIN="$(command -v node 2>/dev/null || true)"
NODE_VERSION=""
NODE_OK=0
if [ -n "$NODE_BIN" ]; then
  NODE_VERSION="$(node --version 2>/dev/null || true)"
  if node -e "const v=process.versions.node.split('.').map(Number); process.exit((v[0]>=24 || (v[0]===22 && (v[1]>19 || (v[1]===19 && v[2]>=0))))?0:1)" 2>/dev/null; then
    NODE_OK=1
    ok "Node.js $NODE_VERSION (satisfies ^22.19 || >=24)"
  else
    bad "Node.js ${NODE_VERSION:-unknown} is too old; need ^22.19.0 || >=24.0.0"
  fi
else
  bad "Node.js not found; need ^22.19.0 || >=24.0.0"
fi

PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
PNPM_VERSION=""
PNPM_OK=0
if [ -n "$PNPM_BIN" ]; then
  PNPM_VERSION="$(pnpm --version 2>/dev/null || true)"
  if [ "$PNPM_VERSION" = "${PKG_PNPM#pnpm@}" ]; then
    PNPM_OK=1
    ok "pnpm $PNPM_VERSION (matches packageManager $PKG_PNPM)"
  else
    warn "pnpm ${PNPM_VERSION:-unknown} found, expected ${PKG_PNPM#pnpm@}"
  fi
else
  bad "pnpm not found"
fi

if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version 2>/dev/null || echo unknown)"; else warn "npm not found"; fi
if command -v corepack >/dev/null 2>&1; then ok "corepack $(corepack --version 2>/dev/null || echo unknown)"; else warn "corepack not found"; fi
if [ -d node_modules ]; then ok "node_modules present"; else warn "node_modules absent; run pnpm install --frozen-lockfile"; fi
if [ -f lib/index.js ]; then ok "compiled lib/index.js present"; else warn "compiled lib missing; run pnpm build"; fi

echo
if [ "$NODE_OK" -ne 1 ]; then
  echo "下一步：先安装 Node.js 22.19+ 或 24/26，再重新运行本脚本。"
  case "$( . /etc/os-release 2>/dev/null; printf '%s' "${ID:-unknown}" )" in
    debian|ubuntu)
      echo "Debian/Ubuntu 参考：使用 nvm/fnm，或按组织规范安装 NodeSource/Docker 外的 Node 包。"
      ;;
    *)
      echo "请按发行版/公司规范安装 Node.js；本脚本不会自动 curl | sh。"
      ;;
  esac
  exit 1
fi

if [ "$MODE" = "install-pnpm" ] && [ "$PNPM_OK" -ne 1 ]; then
  echo "尝试安装 $PKG_PNPM（非 root）..."
  if command -v corepack >/dev/null 2>&1; then
    if corepack prepare "$PKG_PNPM" --activate; then
      corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null || true
    fi
  fi
  if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version 2>/dev/null || true)" != "${PKG_PNPM#pnpm@}" ]; then
    if command -v npm >/dev/null 2>&1; then
      npm install --global --prefix "$HOME/.local" "$PKG_PNPM"
      export PATH="$HOME/.local/bin:$PATH"
    else
      bad "npm unavailable; cannot install pnpm automatically"
      exit 1
    fi
  fi
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version) installed"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) : ;;
      *) echo "注意：请把 $HOME/.local/bin 加入 PATH，或重新登录 shell。" ;;
    esac
  else
    bad "pnpm installation did not produce a usable pnpm"
    exit 1
  fi
else
  echo "检查完成；如需安装/修复 pnpm："
  echo "  bash scripts/bootstrap-dev-env.sh --install-pnpm"
  echo "安装仓库依赖请执行："
  echo "  pnpm install --frozen-lockfile"
  echo "然后运行："
  echo "  pnpm sandbox:onboard"
fi
