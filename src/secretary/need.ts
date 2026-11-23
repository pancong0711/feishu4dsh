/**
 * `/she need`: detect SHE execution-plane prerequisites and emit a portable,
 * secret-free handoff package for a host admin / opencode-she operator.
 *
 * The channel-side username is always read from the running process; only the
 * dedicated sandbox user is a deployment constant (`opencode-she` by default).
 * This module never invokes sudo, Docker, or package managers.
 * @module feishu4dsh/secretary/need
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'

const execFileAsync = promisify(execFile)

export class SheNeedError extends Error {
  constructor(readonly code: 'project_invalid'|'descriptor_invalid'|'package_failed', message: string) {
    super(message)
    this.name = 'SheNeedError'
  }
}

export interface SandboxDescriptor {
  readonly schema: 1
  readonly deploymentId?: string
  readonly service: {
    readonly url: string
    readonly username: string
    readonly passwordFile: string
  }
  readonly runtime: {
    readonly root: string
    readonly worktreeRoot: string
    readonly reposRoot: string
  }
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly container?: {
    readonly name?: string
    readonly image?: string
    readonly port?: number
  }
  readonly updatedAt?: string
}

export type SheNeedLevel = 'channel-user'|'host-root'|'sandbox-user'|'runtime'
export type SheNeedStatus = 'ok'|'missing'|'blocked'|'unknown'

export interface SheNeedItem {
  readonly id: string
  readonly label: string
  readonly level: SheNeedLevel
  readonly status: SheNeedStatus
  readonly detail: string
}

export interface SheNeedReport {
  readonly schema: 1
  readonly deploymentId: string
  readonly createdAt: string
  readonly channelUser: string
  readonly sandboxUser: string
  readonly sharedRoot: string
  readonly descriptorPath: string
  readonly opencodeUrl: string
  readonly passwordFile: string
  readonly items: readonly SheNeedItem[]
  readonly ready: boolean
}

export interface SheNeedPackageResult {
  readonly deploymentId: string
  readonly packageDir: string
  readonly archivePath: string
  readonly archiveName: string
  readonly archiveBytes: Buffer
}

export interface SheNeedProbeDeps {
  readonly channelUser?: string
  readonly probeOpenCode?: (url: string, username: string, credential: string) => Promise<{ ok: boolean; version?: string; detail?: string }>
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]')
  } catch {
    return false
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export async function readSandboxDescriptor(path: string): Promise<SandboxDescriptor | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SheNeedError('descriptor_invalid', `cannot read descriptor ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SheNeedError('descriptor_invalid', `descriptor ${path} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null) throw new SheNeedError('descriptor_invalid', 'descriptor is not an object')
  const doc = value as Record<string, unknown>
  const service = doc.service as Record<string, unknown> | undefined
  const runtime = doc.runtime as Record<string, unknown> | undefined
  const model = doc.model as Record<string, unknown> | undefined
  if (doc.schema !== 1 || service === undefined || runtime === undefined || model === undefined) {
    throw new SheNeedError('descriptor_invalid', 'descriptor schema/service/runtime/model is invalid')
  }
  if (!nonEmpty(service.url) || !isLoopbackUrl(service.url)
    || !nonEmpty(service.username) || !nonEmpty(service.passwordFile) || !isAbsolute(service.passwordFile)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor service.url/username/passwordFile is invalid')
  }
  if (!nonEmpty(runtime.root) || !nonEmpty(runtime.worktreeRoot) || !nonEmpty(runtime.reposRoot)
    || !isAbsolute(runtime.root) || !isAbsolute(runtime.worktreeRoot) || !isAbsolute(runtime.reposRoot)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor runtime paths must be absolute')
  }
  if (!nonEmpty(model.providerID) || !nonEmpty(model.id)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor model.providerID/id is invalid')
  }
  return {
    schema: 1,
    ...(nonEmpty(doc.deploymentId) ? { deploymentId: doc.deploymentId } : {}),
    service: {
      url: (service.url as string).replace(/\/+$/, ''),
      username: service.username as string,
      passwordFile: service.passwordFile as string,
    },
    runtime: {
      root: runtime.root as string,
      worktreeRoot: runtime.worktreeRoot as string,
      reposRoot: runtime.reposRoot as string,
    },
    model: {
      providerID: model.providerID as string,
      id: model.id as string,
      ...(nonEmpty(model.variant) ? { variant: model.variant } : {}),
    },
    ...(doc.updatedAt !== undefined ? { updatedAt: String(doc.updatedAt) } : {}),
  }
}

async function readCredentialFile(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { password?: unknown }
    const credential = parsed.password
    return nonEmpty(credential) ? credential : undefined
  } catch {
    return undefined
  }
}

export async function probeOpenCode(
  url: string,
  username: string,
  credential: string,
): Promise<{ ok: boolean; version?: string; detail?: string }> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/info`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' && body.version !== ''
      ? { ok: true, version: body.version }
      : { ok: false, detail: 'response has no version' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, 2)
    return true
  } catch {
    return false
  }
}

async function commandWorks(command: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { maxBuffer: 1024 * 1024, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** Read-only detection. No sudo, Docker socket access, or user switching. */
export async function inspectSheNeed(config: ResolvedConfig, deps: SheNeedProbeDeps = {}): Promise<SheNeedReport> {
  const channelUser = deps.channelUser ?? userInfo().username
  const sandboxUser = config.secretarySandboxUser
  const sharedRoot = resolve(config.secretarySandboxRoot)
  const descriptorPath = resolve(config.secretarySandboxDescriptor)
  const opencodeUrl = config.secretarySandboxOpencodeUrl
  const passwordFile = resolve(config.secretarySandboxPasswordFile)
  const items: SheNeedItem[] = []

  items.push({ id: 'channel-user', label: '频道侧用户', level: 'channel-user', status: 'ok', detail: channelUser })
  items.push({
    id: 'shared-root', label: '共享 worktrees 根', level: 'channel-user',
    status: await writable(sharedRoot) ? 'ok' : 'missing',
    detail: sharedRoot,
  })

  const sandboxUid = await commandWorks('id', ['-u', sandboxUser])
  items.push({
    id: 'sandbox-user', label: '沙箱用户', level: 'host-root',
    status: sandboxUid === undefined ? 'missing' : 'ok',
    detail: sandboxUid === undefined ? `${sandboxUser} 不存在` : `${sandboxUser} uid=${sandboxUid}`,
  })
  if (sandboxUid !== undefined) {
    const subuid = await commandWorks('grep', ['-s', `^${sandboxUser}:`, '/etc/subuid'])
    items.push({ id: 'subuid', label: 'subuid 映射', level: 'host-root', status: subuid === undefined ? 'missing' : 'ok', detail: subuid ?? `缺少 /etc/subuid:${sandboxUser}` })
    const subgid = await commandWorks('grep', ['-s', `^${sandboxUser}:`, '/etc/subgid'])
    items.push({ id: 'subgid', label: 'subgid 映射', level: 'host-root', status: subgid === undefined ? 'missing' : 'ok', detail: subgid ?? `缺少 /etc/subgid:${sandboxUser}` })
    const linger = await commandWorks('loginctl', ['show-user', sandboxUser])
    const lingerOk = linger?.split('\n').includes('Linger=yes') === true
    items.push({ id: 'linger', label: 'linger', level: 'host-root', status: linger === undefined ? 'unknown' : lingerOk ? 'ok' : 'missing', detail: lingerOk ? 'Linger=yes' : 'Linger=no 或无法读取' })
    const socket = `/run/user/${sandboxUid}/dockerd-rootless/api.sock`
    items.push({ id: 'rootless-docker', label: 'rootless Docker socket', level: 'sandbox-user', status: await exists(socket) ? 'ok' : 'unknown', detail: socket })
  } else {
    for (const [id, label] of [['subuid','subuid 映射'],['subgid','subgid 映射'],['linger','linger'],['rootless-docker','rootless Docker socket']] as const) {
      items.push({ id, label, level: 'host-root', status: 'unknown', detail: '需先创建沙箱用户' })
    }
  }

  let descriptor: SandboxDescriptor | undefined
  try {
    descriptor = await readSandboxDescriptor(descriptorPath)
    items.push({ id: 'descriptor', label: 'she-sandbox descriptor', level: 'runtime', status: descriptor === undefined ? 'missing' : 'ok', detail: descriptor === undefined ? descriptorPath : `${descriptorPath}（schema=1）` })
  } catch (error) {
    items.push({ id: 'descriptor', label: 'she-sandbox descriptor', level: 'runtime', status: 'blocked', detail: error instanceof Error ? error.message : String(error) })
  }

  const credential = await readCredentialFile(passwordFile)
  items.push({ id: 'password-file', label: 'HttpApi password 文件', level: 'runtime', status: credential === undefined ? 'missing' : 'ok', detail: credential === undefined ? passwordFile : passwordFile })
  let health: { ok: boolean; version?: string; detail?: string } = { ok: false, detail: '未执行（password 缺失）' }
  if (credential !== undefined) {
    health = await (deps.probeOpenCode ?? probeOpenCode)(descriptor?.service.url ?? opencodeUrl, descriptor?.service.username ?? 'opencode', credential)
    items.push({ id: 'opencode-health', label: 'OpenCode health', level: 'runtime', status: health.ok ? 'ok' : 'blocked', detail: health.ok ? `v${health.version ?? '?'}` : health.detail ?? 'unknown' })
  } else {
    items.push({ id: 'opencode-health', label: 'OpenCode health', level: 'runtime', status: 'unknown', detail: 'password 文件不可读' })
  }

  const expectedRuntime = descriptor?.runtime ?? {
    root: join(sharedRoot, 'she-runtime'),
    worktreeRoot: join(sharedRoot, 'she-runtime', 'worktrees'),
    reposRoot: join(sharedRoot, 'repos'),
  }
  const runtimeMissing = [
    !(await exists(expectedRuntime.root)) ? expectedRuntime.root : undefined,
    !(await exists(expectedRuntime.worktreeRoot)) ? expectedRuntime.worktreeRoot : undefined,
    !(await exists(expectedRuntime.reposRoot)) ? expectedRuntime.reposRoot : undefined,
  ].filter((v): v is string => v !== undefined)
  items.push({
    id: 'runtime-dirs', label: 'SHE runtime / repos 目录', level: 'runtime',
    status: runtimeMissing.length === 0 ? 'ok' : descriptor === undefined ? 'missing' : 'blocked',
    detail: runtimeMissing.length === 0 ? 'runtime/worktree/repos 均存在' : `缺少：${runtimeMissing.join(', ')}`,
  })

  const ready = items.every(item => item.status === 'ok' || item.status === 'unknown')
    && items.some(item => item.id === 'descriptor' && item.status === 'ok')
    && items.some(item => item.id === 'opencode-health' && item.status === 'ok')
  return {
    schema: 1,
    deploymentId: `she-sandbox-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    channelUser,
    sandboxUser,
    sharedRoot,
    descriptorPath,
    opencodeUrl,
    passwordFile,
    items,
    ready,
  }
}

function needMarkdown(report: SheNeedReport): string {
  const lines = [
    '# SHE Sandbox Need',
    '',
    `- deploymentId: ${report.deploymentId}`,
    `- channel user: ${report.channelUser}`,
    `- sandbox user: ${report.sandboxUser}`,
    `- shared root: ${report.sharedRoot}`,
    `- descriptor: ${report.descriptorPath}`,
    `- OpenCode: ${report.opencodeUrl}`,
    '',
    '## Checks',
    '',
  ]
  for (const item of report.items) lines.push(`- [${item.status}] ${item.label} (${item.level}): ${item.detail}`)
  lines.push('', '## Handoff', '', '1. 宿主管理员审查并执行 `bootstrap-host.sh`；', '2. opencode-she 运维执行 `install-sandbox.sh`；', '3. 执行 `verify.sh`；', '4. 回飞书执行 `/she need verify` 和 `/she init`。', '')
  return lines.join('\n')
}

function rootBootstrapScript(report: SheNeedReport): string {
  return [
    '#!/usr/bin/env bash',
    '# One-time root bootstrap for SHE sandbox. Review before execution.',
    'set -euo pipefail',
    '[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }',
    `CHANNEL_USER="\${CHANNEL_USER:-${report.channelUser}}"`,
    `SANDBOX_USER="\${SANDBOX_USER:-${report.sandboxUser}}"`,
    `SHARED_ROOT="\${SHARED_ROOT:-${report.sharedRoot}}"`,
    'SHE_SHARED_GROUP="${SHE_SHARED_GROUP:-she-shared}"',
    'SUBUID_START="${SUBUID_START:?set SUBUID_START to a free subordinate UID range}"',
    'SUBUID_COUNT="${SUBUID_COUNT:-65536}"',
    'DRY_RUN=0',
    '[ "${1:-}" = "--dry-run" ] && DRY_RUN=1',
    'run() { if [ "$DRY_RUN" = 1 ]; then printf "+ "; printf "%q " "$@"; echo; else "$@"; fi; }',
    'getent group "$SHE_SHARED_GROUP" >/dev/null || run groupadd "$SHE_SHARED_GROUP"',
    'id -u "$SANDBOX_USER" >/dev/null 2>&1 || run useradd -m -s /bin/bash "$SANDBOX_USER"',
    'run usermod -aG "$SHE_SHARED_GROUP" "$CHANNEL_USER"',
    'run usermod -aG "$SHE_SHARED_GROUP" "$SANDBOX_USER"',
    'grep -q "^${SANDBOX_USER}:" /etc/subuid || run usermod --add-subuids "${SUBUID_START}-$((SUBUID_START + SUBUID_COUNT - 1))" "$SANDBOX_USER"',
    'grep -q "^${SANDBOX_USER}:" /etc/subgid || run usermod --add-subgids "${SUBUID_START}-$((SUBUID_START + SUBUID_COUNT - 1))" "$SANDBOX_USER"',
    'run loginctl enable-linger "$SANDBOX_USER"',
    'run install -d -m 2770 -o "$SANDBOX_USER" -g "$SHE_SHARED_GROUP" "$SHARED_ROOT"',
    'echo "bootstrap done. Re-login channel user or refresh supplementary groups."',
    'echo "next: sudo -iu ${SANDBOX_USER} bash install-sandbox.sh"',
  ].join('\n') + '\n'
}

function sandboxInstallScript(report: SheNeedReport): string {
  return [
    '#!/usr/bin/env bash',
    '# Run as the dedicated sandbox user (no root required). Review before execution.',
    'set -euo pipefail',
    `CHANNEL_USER="\${CHANNEL_USER:-${report.channelUser}}"`,
    `SHARED_ROOT="\${SHARED_ROOT:-${report.sharedRoot}}"`,
    `SANDBOX_USER="\${SANDBOX_USER:-${report.sandboxUser}}"`,
    `DESCRIPTOR="\${DESCRIPTOR:-${report.descriptorPath}}"`,
    `OPENCODE_URL="\${OPENCODE_URL:-${report.opencodeUrl}}"`,
    'HOME_DIR="$HOME"',
    'SECRETS_DIR="$HOME/.local/share/she-sandbox/secrets"',
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"',
    'id -un',
    'command -v docker >/dev/null || { echo "docker CLI missing" >&2; exit 1; }',
    'docker info >/dev/null || { echo "rootless docker not reachable" >&2; exit 1; }',
    'install -d -m 2700 "$SECRETS_DIR"',
    'install -d -m 2770 "$SHARED_ROOT/she-runtime" "$SHARED_ROOT/she-runtime/worktrees" "$SHARED_ROOT/repos"',
    'setfacl -m u:${SANDBOX_USER:-opencode-she}:rwx,u:${CHANNEL_USER}:rwx "$SHARED_ROOT/she-runtime" "$SHARED_ROOT/she-runtime/worktrees" "$SHARED_ROOT/repos"',
    'setfacl -d -m u:${SANDBOX_USER:-opencode-she}:rwx,u:${CHANNEL_USER}:rwx "$SHARED_ROOT/she-runtime" "$SHARED_ROOT/she-runtime/worktrees" "$SHARED_ROOT/repos"',
    'if [ ! -f "$SECRETS_DIR/opencode-service.json" ]; then PASS="$(openssl rand -base64 32)"; printf \'{"password":"%s"}\\n\' "$PASS" > "$SECRETS_DIR/opencode-service.json"; chmod 600 "$SECRETS_DIR/opencode-service.json"; fi',
    'echo "Build image from the included Dockerfile and authenticate the provider before starting the container."',
    'echo "Use read-only container flags, loopback port 49375, and mount $SHARED_ROOT RW."',
    'echo "After health check, write descriptor $DESCRIPTOR (see NEED.md/need.json) and ACL it for $CHANNEL_USER."',
  ].join('\n') + '\n'
}

function verifyScript(report: SheNeedReport): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `DESCRIPTOR="\${DESCRIPTOR:-${report.descriptorPath}}"`,
    'python3 - "$DESCRIPTOR" <<\'PY\'',
    'import json,sys',
    'd=json.load(open(sys.argv[1]))',
    'assert d.get("schema")==1',
    'print(d["service"]["url"])',
    'PY',
    `PASS="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[\"password\"])' '${report.passwordFile}' 2>/dev/null || true)"`,
    '[ -n "$PASS" ] || { echo "password file not readable; verify path manually" >&2; exit 1; }',
    'URL="$(python3 - "$DESCRIPTOR" <<\'PY\'',
    'import json,sys',
    'print(json.load(open(sys.argv[1]))["service"]["url"])',
    'PY',
    ')"',
    'curl -fsS -u "opencode:$PASS" "$URL/api/info" >/dev/null',
    'echo SHE_SANDBOX_READY',
  ].join('\n') + '\n'
}

function dockerfile(): string {
  return [
    'FROM node:22-bookworm-slim',
    'ARG OPENCODE_VERSION=2.3.2',
    'ARG PNPM_VERSION=11.22.0',
    'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*',
    'RUN npm install -g --no-fund --no-audit "@opencode/cli@${OPENCODE_VERSION}" "pnpm@${PNPM_VERSION}" && npm cache clean --force',
    'ENV HOME=/home/opencode XDG_CONFIG_HOME=/home/opencode/.config XDG_STATE_HOME=/home/opencode/.local/state XDG_DATA_HOME=/home/opencode/.local/share OPENCODE_DISABLE_AUTOUPDATE=1',
    'RUN mkdir -p /home/opencode/.config/opencode /home/opencode/.local/share/opencode /home/opencode/.local/state/opencode',
    'WORKDIR /home/opencode',
    'EXPOSE 49374',
    'ENTRYPOINT ["opencode","serve","--hostname","0.0.0.0","--port","49374"]',
  ].join('\n') + '\n'
}

function compose(report: SheNeedReport): string {
  return [
    'services:',
    '  opencode-she:',
    '    image: opencode-she:2.3.2',
    '    container_name: opencode-she',
    '    restart: unless-stopped',
    '    read_only: true',
    '    cap_drop: ["ALL"]',
    '    security_opt: ["no-new-privileges:true"]',
    '    tmpfs: ["/tmp:rw,noexec,nosuid,size=1g"]',
    '    env_file:',
    '      - /srv/opencode-she/secrets/opencode-password.env',
    '    ports:',
    '      - "127.0.0.1:49375:49374"',
    '    volumes:',
    '      - /srv/opencode-she/opencode/home:/home/opencode',
    '      - /srv/opencode-she/secrets/auth.json:/home/opencode/.local/share/opencode/auth.json:ro',
    `      - ${report.sharedRoot}:/srv/opencode-she/worktrees:rw`,
  ].join('\n') + '\n'
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Generate a secret-free handoff package under the current project. */
export async function buildSheNeedPackage(input: {
  readonly report: SheNeedReport
  readonly projectRoot: string
}): Promise<SheNeedPackageResult> {
  const projectRoot = resolve(input.projectRoot)
  if (!(await exists(projectRoot))) throw new SheNeedError('project_invalid', `project root not found: ${projectRoot}`)
  const root = join(projectRoot, 'she_setup')
  const dirName = `she-sandbox-need-${input.report.deploymentId.replace(/[^A-Za-z0-9._-]/g, '-')}`
  const packageDir = join(root, dirName)
  const archivePath = join(root, `${dirName}.tar.gz`)
  await mkdir(packageDir, { recursive: true, mode: 0o700 })
  try {
    const files: Record<string, string> = {
      'NEED.md': needMarkdown(input.report),
      'need.json': `${JSON.stringify(input.report, null, 2)}\n`,
      'bootstrap-host.sh': rootBootstrapScript(input.report),
      'install-sandbox.sh': sandboxInstallScript(input.report),
      'verify.sh': verifyScript(input.report),
      'Dockerfile': dockerfile(),
      'compose.yaml': compose(input.report),
    }
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(packageDir, name), content, { mode: name.endsWith('.sh') ? 0o700 : 0o600 })
    }
    const checksums: string[] = []
    for (const name of Object.keys(files).sort()) checksums.push(`${await sha256(join(packageDir, name))}  ${name}`)
    await writeFile(join(packageDir, 'CHECKSUMS'), `${checksums.join('\n')}\n`, { mode: 0o600 })
    await execFileAsync('tar', ['-czf', archivePath, '-C', root, dirName], { maxBuffer: 8 * 1024 * 1024 })
    const bytes = await readFile(archivePath)
    return {
      deploymentId: input.report.deploymentId,
      packageDir,
      archivePath,
      archiveName: `${dirName}.tar.gz`,
      archiveBytes: bytes,
    }
  } catch (error) {
    throw error instanceof SheNeedError
      ? error
      : new SheNeedError('package_failed', error instanceof Error ? error.message : String(error))
  }
}
