/**
 * SHE build-sandbox: declarative agent-sandbox catalog, fixed path layout,
 * read-only host preflight, and a secret-free two-stage installation package.
 *
 * Security boundary:
 * - this module never invokes sudo and never starts/stops containers;
 * - generated scripts mount leaf paths only: workspace, inbox, outbox,
 *   agent home and cache (never a sandbox parent, host home or project root);
 * - Docker socket, host network, privileged mode and devices are forbidden;
 * - the host preflight is read-only (`docker info` only).
 *
 * The interactive card layer lives in card-menu.ts/bridge.ts; this module is
 * pure enough to be tested without Docker or a Feishu connection.
 * @module feishu4dsh/secretary/sandbox
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const SANDBOX_SCHEMA = 1
export const DEFAULT_DEDICATED_SANDBOX_USER = 'feishu4dsh-sandbox'
export const SANDBOX_DATA_ROOT_TEMPLATE = '$HOME/.local/share/feishu4dsh/sandboxes'
export const SANDBOX_PACKAGE_ROOT_TEMPLATE = '$HOME/.local/share/feishu4dsh/sandbox-packages'
export const SANDBOX_CONTAINER_PREFIX = 'feishu4dsh'
export const SANDBOX_PACKAGE_ROOT_NAME = 'sandbox-packages'

export type SandboxTargetKind = 'current-user' | 'dedicated-user'
export type SandboxRole = 'standalone' | 'main' | 'worker' | 'observer' | 'utility'
export type SandboxAgentId = 'opencode' | 'hermes' | 'deepseek-harness' | 'blank' | 'custom'
export type SandboxToolId = 'core' | 'node' | 'python' | 'build' | 'data' | 'search'
export type SandboxNetworkMode = 'none' | 'egress'
export type SandboxCheckStatus = 'ok' | 'warn' | 'missing' | 'unknown'

export interface SandboxAgentProfile {
  readonly id: SandboxAgentId
  readonly label: string
  readonly description: string
  readonly adapter: 'opencode-http' | 'hermes-http' | 'dsh-http' | 'shell' | 'custom'
  /** Base image used by the generated Dockerfile. Empty = caller must provide one. */
  readonly baseImage: string
  /** Fixed agent version; empty for caller-supplied/custom images. */
  readonly version: string
  /** True when the generated Dockerfile installs OpenCode from npm. */
  readonly installOpencode?: boolean
  /** Command appended after the image name; empty means "use image ENTRYPOINT/CMD". */
  readonly runCommand: readonly string[]
  /** Agent service port inside the container, when known. */
  readonly agentPort?: number
  readonly requiresImage: boolean
}

export interface SandboxToolBundle {
  readonly id: SandboxToolId
  readonly label: string
  readonly description: string
  readonly aptPackages: readonly string[]
  readonly npmGlobals?: readonly string[]
  readonly pipPackages?: readonly string[]
}

export const SANDBOX_AGENT_PROFILES: readonly SandboxAgentProfile[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    description: '固定版本 OpenCode coding agent（内置 Dockerfile）',
    adapter: 'opencode-http',
    baseImage: 'node:22-bookworm-slim',
    version: '2.3.2',
    installOpencode: true,
    runCommand: ['opencode', 'serve', '--hostname', '0.0.0.0', '--port', '49374'],
    agentPort: 49374,
    requiresImage: false,
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    description: '需提供已核验的 Hermes Agent 镜像；本版不猜测官方镜像名',
    adapter: 'hermes-http',
    baseImage: '',
    version: '',
    runCommand: [],
    requiresImage: true,
  },
  {
    id: 'deepseek-harness',
    label: 'DeepSeek Harness',
    description: '需提供已核验的 dsh 镜像；本版不猜测官方镜像名',
    adapter: 'dsh-http',
    baseImage: '',
    version: '',
    runCommand: [],
    requiresImage: true,
  },
  {
    id: 'blank',
    label: '空白基础沙箱',
    description: 'Debian 基础环境，只保留容器与所选工具，可作为后续手工装 agent 的起点',
    adapter: 'shell',
    baseImage: 'debian:bookworm-slim',
    version: 'bookworm',
    runCommand: ['sleep', 'infinity'],
    requiresImage: false,
  },
  {
    id: 'custom',
    label: '自定义 Agent 镜像',
    description: '必须显式提供镜像引用；镜像存在不等于 SHE 协议兼容',
    adapter: 'custom',
    baseImage: '',
    version: '',
    runCommand: [],
    requiresImage: true,
  },
]

export const SANDBOX_TOOL_BUNDLES: readonly SandboxToolBundle[] = [
  {
    id: 'core',
    label: '核心 CLI',
    description: 'git / curl / jq / ripgrep / tar / unzip 等基础工具',
    aptPackages: ['ca-certificates', 'curl', 'git', 'jq', 'less', 'ripgrep', 'tar', 'unzip', 'xz-utils'],
  },
  {
    id: 'node',
    label: 'Node.js + npm + pnpm',
    description: 'Node 环境；pnpm 固定版本',
    aptPackages: ['nodejs', 'npm'],
    npmGlobals: ['pnpm@11.22.0'],
  },
  {
    id: 'python',
    label: 'Python + pip/venv + uv',
    description: 'Python 3、venv、pip 与 uv 用户态包管理器',
    aptPackages: ['python3', 'python3-pip', 'python3-venv'],
    pipPackages: ['uv'],
  },
  {
    id: 'build',
    label: '构建工具链',
    description: 'gcc / make / pkg-config / cmake',
    aptPackages: ['build-essential', 'cmake', 'pkg-config'],
  },
  {
    id: 'data',
    label: '数据/文档工具',
    description: 'sqlite3、文件处理辅助工具',
    aptPackages: ['sqlite3'],
  },
  {
    id: 'search',
    label: '搜索辅助',
    description: 'fd-find、tree 等目录/文件搜索工具',
    aptPackages: ['fd-find', 'tree'],
  },
]

export const DEFAULT_SANDBOX_TOOLS: readonly SandboxToolId[] = ['core']

export interface SandboxPaths {
  /** Fixed host data root using `$HOME` template (resolved by generated script). */
  readonly dataRoot: string
  readonly root: string
  readonly workspace: string
  readonly inbox: string
  readonly outbox: string
  readonly home: string
  readonly cache: string
  readonly logs: string
  readonly descriptor: string
  readonly containerWorkspace: string
  readonly containerInbox: string
  readonly containerOutbox: string
  readonly containerHome: string
  readonly containerCache: string
}

export interface SandboxMailboxPolicy {
  /** Symbolic 'main' or a concrete sandbox name allowed to target this inbox via broker. */
  readonly allowedCallers: readonly string[]
  /** Sandbox names this sandbox may hand off to through the broker. */
  readonly allowedTargets: readonly string[]
}

export interface SandboxSecurity {
  readonly rootlessDockerPreferred: true
  readonly readOnlyRootfs: true
  readonly capDrop: readonly ['ALL']
  readonly noNewPrivileges: true
  readonly noHostNetwork: true
  readonly noDockerSocket: true
  readonly noPrivileged: true
  readonly pidsLimit: number
  readonly memory: string
  readonly cpus: string
  readonly tmpfs: readonly string[]
  readonly networkMode: SandboxNetworkMode
}

export interface SandboxSpec {
  readonly schema: 1
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly target: {
    readonly kind: SandboxTargetKind
    readonly user: string
    readonly requiresRootBootstrap: boolean
  }
  readonly agent: {
    readonly id: SandboxAgentId
    readonly label: string
    readonly adapter: SandboxAgentProfile['adapter']
    readonly sourceImage: string
    readonly version: string
    readonly runCommand: readonly string[]
    readonly agentPort?: number
  }
  readonly tools: readonly SandboxToolId[]
  readonly role: SandboxRole
  readonly mailbox: SandboxMailboxPolicy
  readonly paths: SandboxPaths
  readonly container: {
    readonly name: string
    readonly imageTag: string
    readonly networkName: string
    readonly hostPort: number
  }
  readonly security: SandboxSecurity
}

export interface BuildSandboxSpecInput {
  readonly name?: string
  readonly targetKind?: SandboxTargetKind
  readonly currentUser: string
  readonly dedicatedUser?: string
  readonly agentId: SandboxAgentId
  readonly customImage?: string
  readonly tools?: readonly SandboxToolId[]
  readonly role?: SandboxRole
  readonly allowedCallers?: readonly string[]
  readonly allowedTargets?: readonly string[]
  readonly networkMode?: SandboxNetworkMode
  readonly hostPort?: number
  readonly now?: number
  readonly id?: string
}

export interface SandboxHostCheck {
  readonly id: string
  readonly label: string
  readonly status: SandboxCheckStatus
  readonly detail: string
}

export interface SandboxHostReport {
  readonly schema: 1
  readonly checkedAt: string
  readonly currentUser: string
  readonly dedicatedUser: string
  readonly checks: readonly SandboxHostCheck[]
  readonly currentDockerReady: boolean
  readonly rootlessDocker: boolean
  readonly recommendedTarget: SandboxTargetKind
}

/** Server-side state of one interactive /she sandbox wizard (card values stay tiny). */
export interface SandboxWizardState {
  step: 'target' | 'role' | 'agent' | 'tools' | 'confirm'
  readonly name: string
  targetKind: SandboxTargetKind
  role: SandboxRole
  agentId: SandboxAgentId
  readonly tools: SandboxToolId[]
  readonly preflight?: SandboxHostReport
  customImage?: string
}

export interface SandboxHostProbeDeps {
  readonly currentUser?: string
  readonly run?: (command: string, args: readonly string[]) => Promise<{ ok: boolean; stdout?: string; detail?: string }>
}

export interface SandboxPackageBuildInput {
  readonly spec: SandboxSpec
  readonly preflight?: SandboxHostReport
  readonly outputRoot?: string
}

export interface SandboxPackageResult {
  readonly sandboxId: string
  readonly sandboxName: string
  readonly packageDir: string
  readonly archivePath: string
  readonly archiveName: string
  readonly archiveBytes: Buffer
}

export class SandboxError extends Error {
  constructor(
    readonly code: 'invalid_name' | 'invalid_user' | 'invalid_image' | 'invalid_tools' | 'invalid_target' | 'invalid_port' | 'package_failed',
    message: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/

export function isValidSandboxName(value: string): boolean {
  return SANDBOX_NAME_RE.test(value)
}

export function isValidDockerImageRef(value: string): boolean {
  if (!IMAGE_RE.test(value)) return false
  // Reject path traversal and Dockerfile-smuggling punctuation. The generated
  // Dockerfile uses FROM <image>, so newlines/spaces would be an injection.
  if (value.includes('..')) return false
  return !value.startsWith('-')
}

export function isValidSandboxUser(value: string): boolean {
  return USER_RE.test(value)
}

export function sandboxAgentProfile(id: SandboxAgentId): SandboxAgentProfile | undefined {
  return SANDBOX_AGENT_PROFILES.find(profile => profile.id === id)
}

export function sandboxToolBundle(id: SandboxToolId): SandboxToolBundle | undefined {
  return SANDBOX_TOOL_BUNDLES.find(bundle => bundle.id === id)
}

export function makeSandboxName(now = Date.now(), suffix = randomUUID().slice(0, 6)): string {
  return `sbx-${now.toString(36).slice(-6)}-${suffix.replace(/[^a-z0-9]/g, '').slice(0, 6)}`
}

/**
 * Resolve a user-supplied suffix into the fixed `sbx-<suffix>` namespace.
 * Empty suffix picks the next free numeric name (`sbx-0001`, `sbx-0002`, ...).
 * Existing names are compared case-sensitively; this is deliberate because
 * Docker names and fixed XDG paths should be unique as written.
 */
export function nextSandboxName(existingNames: readonly string[], suffix?: string): string {
  const raw = (suffix ?? '').trim().toLowerCase()
  if (raw !== '') {
    const stripped = raw.startsWith('sbx-') ? raw.slice(4) : raw
    if (!/^[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?$/.test(stripped)) {
      throw new SandboxError('invalid_name', 'sandbox suffix must use lowercase letters, digits and hyphens; max 28 chars')
    }
    const name = `sbx-${stripped}`
    if (existingNames.includes(name)) throw new SandboxError('invalid_name', `sandbox already exists: ${name}`)
    return name
  }
  const used = new Set(existingNames)
  let n = 1
  while (used.has(`sbx-${String(n).padStart(4, '0')}`)) n += 1
  return `sbx-${String(n).padStart(4, '0')}`
}

function uniqueTools(tools: readonly SandboxToolId[] | undefined): SandboxToolId[] {
  const input = tools === undefined || tools.length === 0 ? DEFAULT_SANDBOX_TOOLS : tools
  const seen = new Set<SandboxToolId>()
  const result: SandboxToolId[] = []
  for (const id of input) {
    if (sandboxToolBundle(id) === undefined) throw new SandboxError('invalid_tools', `unknown sandbox tool bundle: ${id}`)
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

/** Build the immutable sandbox spec shared by the card, plan.json and scripts. */
export function buildSandboxSpec(input: BuildSandboxSpecInput): SandboxSpec {
  const now = input.now ?? Date.now()
  const name = input.name?.trim() || makeSandboxName(now)
  if (!isValidSandboxName(name)) {
    throw new SandboxError('invalid_name', 'sandbox name must match ^[a-z0-9][a-z0-9-]{0,31}$')
  }
  const targetKind = input.targetKind ?? 'dedicated-user'
  const dedicatedUser = input.dedicatedUser?.trim() || DEFAULT_DEDICATED_SANDBOX_USER
  const role = input.role ?? 'standalone'
  if (!['standalone', 'main', 'worker', 'observer', 'utility'].includes(role)) {
    throw new SandboxError('invalid_target', `unknown sandbox role: ${role}`)
  }
  const allowedCallers = input.allowedCallers === undefined
    ? ['main']
    : [...new Set(input.allowedCallers.map(value => value.trim()).filter(value => value !== ''))]
  const allowedTargets = input.allowedTargets === undefined
    ? []
    : [...new Set(input.allowedTargets.map(value => value.trim()).filter(value => value !== ''))]
  for (const value of [...allowedCallers, ...allowedTargets]) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
      throw new SandboxError('invalid_name', `invalid mailbox peer: ${value}`)
    }
  }
  if (!isValidSandboxUser(input.currentUser)) throw new SandboxError('invalid_user', `invalid current user: ${input.currentUser}`)
  if (targetKind === 'dedicated-user' && !isValidSandboxUser(dedicatedUser)) {
    throw new SandboxError('invalid_user', `invalid dedicated sandbox user: ${dedicatedUser}`)
  }
  const so = input.tools === undefined ? [] : uniqueTools(input.tools)
  const tools = so.length === 0 ? [...DEFAULT_SANDBOX_TOOLS] : so
  const profile = sandboxAgentProfile(input.agentId)
  if (profile === undefined) throw new SandboxError('invalid_target', `unknown sandbox agent: ${input.agentId}`)
  const customImage = input.customImage?.trim() ?? ''
  if (customImage !== '' && !isValidDockerImageRef(customImage)) {
    throw new SandboxError('invalid_image', 'custom image reference contains unsupported characters')
  }
  if (profile.requiresImage && customImage === '') {
    throw new SandboxError('invalid_image', `${profile.label} requires an explicit --image reference`)
  }
  const hostPort = input.hostPort ?? 0
  if (!Number.isInteger(hostPort) || hostPort < 0 || hostPort > 65535) {
    throw new SandboxError('invalid_port', 'host port must be an integer between 0 and 65535')
  }
  if (hostPort > 0 && hostPort < 1024) {
    throw new SandboxError('invalid_port', 'refusing a privileged host port; use 1024-65535')
  }
  const networkMode = input.networkMode ?? 'egress'
  if (networkMode !== 'none' && networkMode !== 'egress') {
    throw new SandboxError('invalid_target', `unknown network mode: ${networkMode}`)
  }
  const sourceImage = customImage || profile.baseImage
  if (!isValidDockerImageRef(sourceImage)) {
    throw new SandboxError('invalid_image', `invalid image reference: ${sourceImage}`)
  }
  const user = targetKind === 'current-user' ? input.currentUser : dedicatedUser
  const root = `${SANDBOX_DATA_ROOT_TEMPLATE}/${name}`
  const containerName = `${SANDBOX_CONTAINER_PREFIX}-${name}`
  const digest = createHash('sha256')
    .update(JSON.stringify({ name, targetKind, user, agent: profile.id, sourceImage, tools, networkMode }))
    .digest('hex')
    .slice(0, 12)
  return {
    schema: 1,
    id: input.id ?? `sandbox-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
    name,
    createdAt: new Date(now).toISOString(),
    target: {
      kind: targetKind,
      user,
      requiresRootBootstrap: targetKind === 'dedicated-user',
    },
    agent: {
      id: profile.id,
      label: profile.label,
      adapter: profile.adapter,
      sourceImage,
      version: profile.version || (customImage === '' ? '' : 'custom'),
      runCommand: profile.runCommand,
      ...(profile.agentPort === undefined ? {} : { agentPort: profile.agentPort }),
    },
    tools,
    role,
    mailbox: { allowedCallers, allowedTargets },
    paths: {
      dataRoot: SANDBOX_DATA_ROOT_TEMPLATE,
      root,
      workspace: `${root}/workspace`,
      inbox: `${root}/inbox`,
      outbox: `${root}/outbox`,
      home: `${root}/home`,
      cache: `${root}/cache`,
      logs: `${root}/logs`,
      descriptor: `${root}/sandbox.json`,
      containerWorkspace: '/workspace',
      containerInbox: '/inbox',
      containerOutbox: '/outbox',
      containerHome: '/home/agent',
      containerCache: '/home/agent/.cache',
    },
    container: {
      name: containerName,
      imageTag: `feishu4dsh-sandbox-${name}:${digest}`,
      networkName: `${SANDBOX_CONTAINER_PREFIX}-${name}-net`,
      hostPort,
    },
    security: {
      rootlessDockerPreferred: true,
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      noNewPrivileges: true,
      noHostNetwork: true,
      noDockerSocket: true,
      noPrivileged: true,
      pidsLimit: 512,
      memory: '4g',
      cpus: '2',
      tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=1g', '/run:rw,noexec,nosuid,nodev,size=64m'],
      networkMode,
    },
  }
}

async function runCommand(command: string, args: readonly string[]): Promise<{ ok: boolean; stdout?: string; detail?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    })
    const text = stdout.trim()
    return { ok: true, ...(text === '' ? {} : { stdout: text }), ...(stderr.trim() === '' ? {} : { detail: stderr.trim() }) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, detail }
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

/**
 * Read-only host preflight. The current-user Docker probe runs `docker info`
 * only; no container is created and no Docker socket is opened by the plugin.
 */
export async function inspectSandboxHost(
  dedicatedUser = DEFAULT_DEDICATED_SANDBOX_USER,
  deps: SandboxHostProbeDeps = {},
): Promise<SandboxHostReport> {
  const currentUser = deps.currentUser ?? userInfo().username
  const run = deps.run ?? runCommand
  const checks: SandboxHostCheck[] = [
    { id: 'current-user', label: '当前用户', status: 'ok', detail: currentUser },
  ]
  const dockerCli = await run('docker', ['--version'])
  checks.push({
    id: 'docker-cli', label: 'Docker CLI', status: dockerCli.ok ? 'ok' : 'missing',
    detail: dockerCli.ok ? dockerCli.stdout ?? 'available' : dockerCli.detail ?? 'docker not found',
  })
  let dockerDaemon = false
  if (dockerCli.ok) {
    const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'])
    dockerDaemon = info.ok
    checks.push({
      id: 'docker-daemon', label: 'Docker daemon', status: info.ok ? 'ok' : 'missing',
      detail: info.ok ? `server ${info.stdout ?? '?'}` : info.detail ?? 'docker info failed',
    })
    if (info.ok) {
      const security = await run('docker', ['info', '--format', '{{json .SecurityOptions}}'])
      const rootless = security.ok && (security.stdout ?? '').toLowerCase().includes('rootless')
      checks.push({
        id: 'rootless-docker', label: 'rootless Docker', status: rootless ? 'ok' : 'warn',
        detail: rootless ? 'rootless security option detected' : '未检测到 rootless；rootful Docker 不提供同等隔离',
      })
    } else {
      checks.push({ id: 'rootless-docker', label: 'rootless Docker', status: 'unknown', detail: 'daemon 不可达，无法判断' })
    }
  } else {
    checks.push({ id: 'docker-daemon', label: 'Docker daemon', status: 'unknown', detail: 'Docker CLI 缺失' })
    checks.push({ id: 'rootless-docker', label: 'rootless Docker', status: 'unknown', detail: 'Docker CLI 缺失' })
  }

  const userProbe = await run('id', ['-u', dedicatedUser])
  checks.push({
    id: 'dedicated-user', label: '专用沙箱账户', status: userProbe.ok ? 'ok' : 'missing',
    detail: userProbe.ok ? `${dedicatedUser} uid=${userProbe.stdout ?? '?'}` : `${dedicatedUser} 不存在（root bootstrap 可创建）`,
  })
  if (userProbe.ok) {
    const subuid = await run('grep', ['-s', `^${dedicatedUser}:`, '/etc/subuid'])
    const subgid = await run('grep', ['-s', `^${dedicatedUser}:`, '/etc/subgid'])
    checks.push({
      id: 'subuid', label: 'subuid', status: subuid.ok && (subuid.stdout ?? '') !== '' ? 'ok' : 'missing',
      detail: subuid.stdout ?? `缺少 /etc/subuid:${dedicatedUser}`,
    })
    checks.push({
      id: 'subgid', label: 'subgid', status: subgid.ok && (subgid.stdout ?? '') !== '' ? 'ok' : 'missing',
      detail: subgid.stdout ?? `缺少 /etc/subgid:${dedicatedUser}`,
    })
    const linger = await run('loginctl', ['show-user', dedicatedUser])
    const lingerOk = linger.ok && (linger.stdout ?? '').split('\n').includes('Linger=yes')
    checks.push({ id: 'linger', label: 'linger', status: lingerOk ? 'ok' : 'warn', detail: lingerOk ? 'Linger=yes' : 'Linger=no 或无法读取' })
    const uid = userProbe.stdout ?? ''
    const socket = `/run/user/${uid}/dockerd-rootless/api.sock`
    checks.push({
      id: 'dedicated-docker', label: '专用账户 rootless Docker',
      status: await exists(socket) ? 'ok' : 'unknown',
      detail: await exists(socket) ? socket : `${socket}（当前进程可能无权确认；由目标用户执行 host-preflight.sh）`,
    })
  } else {
    checks.push({ id: 'subuid', label: 'subuid', status: 'unknown', detail: '需先创建专用账户' })
    checks.push({ id: 'subgid', label: 'subgid', status: 'unknown', detail: '需先创建专用账户' })
    checks.push({ id: 'linger', label: 'linger', status: 'unknown', detail: '需先创建专用账户' })
    checks.push({ id: 'dedicated-docker', label: '专用账户 rootless Docker', status: 'unknown', detail: '需先创建专用账户' })
  }

  const xdgParent = join(homedir(), '.local', 'share')
  checks.push({
    id: 'data-root-parent', label: '数据目录父路径', status: await exists(xdgParent) ? 'ok' : 'warn',
    detail: `${xdgParent}（create-sandbox.sh 会在需要时创建叶子目录）`,
  })
  const currentDockerReady = dockerCli.ok && dockerDaemon
  const rootlessDocker = checks.some(item => item.id === 'rootless-docker' && item.status === 'ok')
  return {
    schema: 1,
    checkedAt: new Date().toISOString(),
    currentUser,
    dedicatedUser,
    checks,
    currentDockerReady,
    rootlessDocker,
    recommendedTarget: rootlessDocker ? 'current-user' : 'dedicated-user',
  }
}

function aptPackagesFor(spec: SandboxSpec): string[] {
  const packages = new Set<string>()
  for (const id of spec.tools) {
    for (const pkg of sandboxToolBundle(id)?.aptPackages ?? []) packages.add(pkg)
  }
  // node:22-bookworm-slim already ships Node/npm; apt-installing Debian's
  // nodejs/npm on top of it risks version conflicts.
  if (spec.agent.sourceImage.startsWith('node:') && spec.tools.includes('node')) {
    packages.delete('nodejs')
    packages.delete('npm')
  }
  return [...packages]
}

function npmGlobalsFor(spec: SandboxSpec): string[] {
  const result = new Set<string>()
  for (const id of spec.tools) {
    for (const pkg of sandboxToolBundle(id)?.npmGlobals ?? []) result.add(pkg)
  }
  return [...result]
}

function pipPackagesFor(spec: SandboxSpec): string[] {
  const result = new Set<string>()
  for (const id of spec.tools) {
    for (const pkg of sandboxToolBundle(id)?.pipPackages ?? []) result.add(pkg)
  }
  return [...result]
}

function dockerfileFor(spec: SandboxSpec): string {
  const lines = [
    `# Generated by feishu4dsh /she sandbox for ${spec.name}`,
    '# Review this file before building. No credentials are baked into the image.',
    `FROM ${spec.agent.sourceImage}`,
    '',
    'ARG DEBIAN_FRONTEND=noninteractive',
  ]
  const apt = aptPackagesFor(spec)
  if (apt.length > 0) {
    lines.push(
      `RUN apt-get update \\`,
      ` && apt-get install -y --no-install-recommends ${apt.join(' ')} \\`,
      ' && rm -rf /var/lib/apt/lists/*',
    )
  }
  if (spec.agent.id === 'opencode') {
    const version = spec.agent.version === '' ? '2.3.2' : spec.agent.version
    lines.push(
      'RUN npm install -g --no-fund --no-audit ' + JSON.stringify(`@opencode/cli@${version}`)
      + ' && npm cache clean --force',
    )
  }
  const npmGlobals = npmGlobalsFor(spec)
  if (npmGlobals.length > 0) {
    lines.push(`RUN npm install -g --no-fund --no-audit ${npmGlobals.map(item => JSON.stringify(item)).join(' ')}`)
  }
  const pip = pipPackagesFor(spec)
  if (pip.length > 0) {
    lines.push(`RUN python3 -m pip install --no-cache-dir --break-system-packages ${pip.join(' ')}`)
  }
  lines.push(
    'RUN install -d -m 0755 /workspace /inbox /outbox /home/agent /home/agent/.cache /home/agent/.config /home/agent/.local/share /home/agent/.local/state /home/agent/.npm-global/bin /home/agent/.local/bin',
    'ENV HOME=/home/agent \\',
    '    XDG_CACHE_HOME=/home/agent/.cache \\',
    '    XDG_CONFIG_HOME=/home/agent/.config \\',
    '    XDG_DATA_HOME=/home/agent/.local/share \\',
    '    XDG_STATE_HOME=/home/agent/.local/state \\',
    '    NPM_CONFIG_PREFIX=/home/agent/.npm-global \\',
    '    PYTHONUSERBASE=/home/agent/.local \\',
    '    UV_CACHE_DIR=/home/agent/.cache/uv \\',
    '    UV_TOOL_DIR=/home/agent/.local/share/uv/tools \\',
    '    UV_TOOL_BIN_DIR=/home/agent/.local/bin \\',
    '    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:$PATH',
    'WORKDIR /workspace',
  )
  if (spec.agent.runCommand.length > 0) {
    lines.push(`CMD [${spec.agent.runCommand.map(item => JSON.stringify(item)).join(', ')}]`)
  }
  return `${lines.join('\n')}\n`
}

function hostPreflightScript(spec: SandboxSpec): string {
  return [
    '#!/usr/bin/env bash',
    '# Read-only host preflight for one feishu4dsh sandbox. Safe to run before install.',
    'set -euo pipefail',
    `SANDBOX_NAME='${spec.name}'`,
    `SANDBOX_USER='${spec.target.user}'`,
    'FAIL=0',
    'ok() { printf "✓ %s\\n" "$*"; }',
    'warn() { printf "! %s\\n" "$*"; }',
    'bad() { printf "✗ %s\\n" "$*"; FAIL=1; }',
    'echo "sandbox: $SANDBOX_NAME"',
    'echo "target user: $SANDBOX_USER"',
    'if [ "$(id -un)" = "$SANDBOX_USER" ]; then ok "running as target user"; else warn "当前用户 $(id -un) 不是目标用户 $SANDBOX_USER"; fi',
    'if command -v docker >/dev/null 2>&1; then ok "docker CLI: $(docker --version)"; else bad "docker CLI missing"; fi',
    'if command -v docker >/dev/null 2>&1; then',
    '  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; else bad "docker daemon unreachable"; fi',
    '  if docker info --format "{{json .SecurityOptions}}" 2>/dev/null | grep -qi rootless; then ok "rootless Docker detected"; else warn "rootless security option not detected"; fi',
    'fi',
    'if id -u "$SANDBOX_USER" >/dev/null 2>&1; then ok "target user exists"; else bad "target user missing"; fi',
    'if grep -qs "^$SANDBOX_USER:" /etc/subuid; then ok "subuid mapped"; else warn "subuid mapping missing (needed by rootless Docker)"; fi',
    'if grep -qs "^$SANDBOX_USER:" /etc/subgid; then ok "subgid mapped"; else warn "subgid mapping missing (needed by rootless Docker)"; fi',
    'if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$SANDBOX_USER" 2>/dev/null | grep -q "Linger=yes"; then ok "linger enabled"; else warn "linger not confirmed"; fi',
    '[ "$FAIL" -eq 0 ] && echo "HOST_PREFLIGHT_OK" || { echo "HOST_PREFLIGHT_FAILED" >&2; exit 1; }',
  ].join('\n') + '\n'
}

function bootstrapHostScript(spec: SandboxSpec): string {
  if (!spec.target.requiresRootBootstrap) {
    return [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "当前用户模式不需要 root bootstrap。"',
      'echo "如 Docker 尚未安装，请先在仓库根目录执行 scripts/sandbox-bootstrap-host.sh 并按其提示完成 rootless Docker 初始化。"',
      'exit 0',
    ].join('\n') + '\n'
  }
  return [
    '#!/usr/bin/env bash',
    '# One-time root bootstrap for a dedicated rootless sandbox account.',
    '# Review this file before running. It never installs binaries from curl|sh.',
    'set -euo pipefail',
    '[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }',
    'DRY_RUN=0',
    '[ "${1:-}" = "--dry-run" ] && DRY_RUN=1',
    'run() { if [ "$DRY_RUN" = 1 ]; then printf "+ "; printf "%q " "$@"; echo; else "$@"; fi; }',
    `SANDBOX_USER='${spec.target.user}'`,
    'SUBUID_START="${SUBUID_START:-100000}"',
    'SUBUID_COUNT="${SUBUID_COUNT:-65536}"',
    'SUBUID_END="$((SUBUID_START + SUBUID_COUNT - 1))"',
    'if id -u "$SANDBOX_USER" >/dev/null 2>&1; then',
    '  echo "user $SANDBOX_USER already exists"',
    'else',
    '  run useradd --create-home --shell /bin/bash "$SANDBOX_USER"',
    'fi',
    'if grep -qs "^$SANDBOX_USER:" /etc/subuid; then',
    '  echo "subuid already configured for $SANDBOX_USER"',
    'else',
    '  run usermod --add-subuids "${SUBUID_START}-${SUBUID_END}" "$SANDBOX_USER"',
    'fi',
    'if grep -qs "^$SANDBOX_USER:" /etc/subgid; then',
    '  echo "subgid already configured for $SANDBOX_USER"',
    'else',
    '  run usermod --add-subgids "${SUBUID_START}-${SUBUID_END}" "$SANDBOX_USER"',
    'fi',
    'run loginctl enable-linger "$SANDBOX_USER"',
    'if command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then',
    '  UID_NUM="$(id -u "$SANDBOX_USER")"',
    '  if [ -S "/run/user/$UID_NUM/docker.sock" ] || [ -S "/run/user/$UID_NUM/dockerd-rootless/api.sock" ]; then',
    '    echo "rootless Docker socket already present for $SANDBOX_USER"',
    '  else',
    '    run runuser -u "$SANDBOX_USER" -- env XDG_RUNTIME_DIR="/run/user/$UID_NUM" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_NUM/bus" dockerd-rootless-setuptool.sh install',
    '  fi',
    'else',
    '  echo "WARN: dockerd-rootless-setuptool.sh not found; install rootless Docker packages first." >&2',
    '  echo "Run scripts/sandbox-bootstrap-host.sh from the repository for distro-specific guidance." >&2',
    'fi',
    'echo "bootstrap done. Copy this package into the sandbox account home and run create-sandbox.sh as $SANDBOX_USER."',
  ].join('\n') + '\n'
}

function createSandboxScript(spec: SandboxSpec): string {
  const runCommand = spec.agent.runCommand
  return [
    '#!/usr/bin/env bash',
    '# Run as the target non-root user after reviewing plan.json and Dockerfile.',
    'set -euo pipefail',
    'umask 077',
    `SANDBOX_NAME='${spec.name}'`,
    `TARGET_USER='${spec.target.user}'`,
    `CONTAINER='${spec.container.name}'`,
    `IMAGE_TAG='${spec.container.imageTag}'`,
    `SOURCE_IMAGE='${spec.agent.sourceImage}'`,
    `NETWORK_NAME='${spec.container.networkName}'`,
    `NETWORK_MODE='${spec.security.networkMode}'`,
    `HOST_PORT='${spec.container.hostPort}'`,
    `AGENT_PORT='${spec.agent.agentPort ?? ''}'`,
    'if [ "$(id -u)" -eq 0 ]; then echo "refusing to run as root; run as $TARGET_USER" >&2; exit 1; fi',
    'if [ "$(id -un)" != "$TARGET_USER" ]; then echo "run as $TARGET_USER, current=$(id -un)" >&2; exit 1; fi',
    'command -v docker >/dev/null || { echo "docker CLI missing" >&2; exit 1; }',
    'docker info >/dev/null || { echo "docker daemon unreachable for $TARGET_USER" >&2; exit 1; }',
    'if ! docker info --format "{{json .SecurityOptions}}" | grep -qi rootless; then',
    '  echo "WARN: rootless Docker not detected; this is not the recommended isolation profile." >&2',
    'fi',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'ROOT="$HOME/.local/share/feishu4dsh/sandboxes/$SANDBOX_NAME"',
    'WORKSPACE="$ROOT/workspace"',
    'INBOX="$ROOT/inbox"',
    'OUTBOX="$ROOT/outbox"',
    'AGENT_HOME="$ROOT/home"',
    'CACHE="$ROOT/cache"',
    'LOGS="$ROOT/logs"',
    'if docker container inspect "$CONTAINER" >/dev/null 2>&1; then',
    '  echo "container $CONTAINER already exists; use destroy-sandbox.sh --keep-data before recreating" >&2',
    '  exit 1',
    'fi',
    'install -d -m 0700 "$ROOT" "$WORKSPACE" "$AGENT_HOME" "$CACHE" "$LOGS"',
    'install -d -m 0700 "$INBOX" "$OUTBOX"',
    'if [ "$SOURCE_IMAGE" != "" ] && ! docker image inspect "$SOURCE_IMAGE" >/dev/null 2>&1; then',
    '  if command -v docker >/dev/null 2>&1 && docker manifest inspect "$SOURCE_IMAGE" >/dev/null 2>&1; then',
    '    echo "image manifest found remotely: $SOURCE_IMAGE"',
    '  else',
    '    echo "image not found locally or remotely: $SOURCE_IMAGE" >&2',
    '    echo "check the image reference, registry auth, platform and network; do not silently fall back to a blank sandbox." >&2',
    '    exit 1',
    '  fi',
    'fi',
    'docker build --pull=false -t "$IMAGE_TAG" -f "$HERE/Dockerfile" "$HERE"',
    'if [ "$NETWORK_MODE" = none ]; then',
    '  DOCKER_NETWORK_ARGS=(--network none)',
    'else',
    '  docker network inspect "$NETWORK_NAME" >/dev/null 2>&1 || docker network create "$NETWORK_NAME" >/dev/null',
    '  DOCKER_NETWORK_ARGS=(--network "$NETWORK_NAME")',
    'fi',
    'ARGS=(run -d --name "$CONTAINER"',
    '  --hostname feishu4dsh',
    '  --label "feishu4dsh.managed=true"',
    `  --label "feishu4dsh.sandbox.name=$SANDBOX_NAME"`,
    `  --label "feishu4dsh.sandbox.agent=${spec.agent.id}"`,
    '  --read-only',
    '  --cap-drop ALL',
    '  --security-opt no-new-privileges:true',
    '  --ulimit nofile=1024:1024',
    '  --pids-limit 512',
    '  --memory 4g',
    '  --cpus 2',
    '  --init',
    '  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g',
    '  --tmpfs /run:rw,noexec,nosuid,nodev,size=64m',
    '  --mount "type=bind,src=$WORKSPACE,dst=/workspace,rw,bind-propagation=rprivate"',
    '  --mount "type=bind,src=$INBOX,dst=/inbox,ro,bind-propagation=rprivate"',
    '  --mount "type=bind,src=$OUTBOX,dst=/outbox,rw,bind-propagation=rprivate"',
    '  --mount "type=bind,src=$AGENT_HOME,dst=/home/agent,rw,bind-propagation=rprivate"',
    '  --mount "type=bind,src=$CACHE,dst=/home/agent/.cache,rw,bind-propagation=rprivate"',
    '  --env HOME=/home/agent',
    '  --env XDG_CACHE_HOME=/home/agent/.cache',
    '  --env XDG_CONFIG_HOME=/home/agent/.config',
    '  --env XDG_DATA_HOME=/home/agent/.local/share',
    '  --env XDG_STATE_HOME=/home/agent/.local/state',
    '  --env NPM_CONFIG_PREFIX=/home/agent/.npm-global',
    '  --env PYTHONUSERBASE=/home/agent/.local',
    '  --env UV_CACHE_DIR=/home/agent/.cache/uv',
    '  --env UV_TOOL_DIR=/home/agent/.local/share/uv/tools',
    '  --env UV_TOOL_BIN_DIR=/home/agent/.local/bin',
    '  --env PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '  --workdir /workspace',
    '  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3',
    ')',
    'if [ "$HOST_PORT" != "0" ] && [ "$AGENT_PORT" != "" ]; then',
    '  ARGS+=(-p "127.0.0.1:$HOST_PORT:$AGENT_PORT")',
    'fi',
    'ARGS+=("${DOCKER_NETWORK_ARGS[@]}")',
    'ARGS+=("$IMAGE_TAG")',
    runCommand.length === 0 ? ':' : `ARGS+=(${runCommand.map(item => `'${item.replace(/'/g, `'\\''`)}'`).join(' ')})`,
    'docker "${ARGS[@]}" >/dev/null',
    'install -m 0600 "$HERE/plan.json" "$ROOT/sandbox.json"',
    'echo "sandbox created: $CONTAINER"',
    'echo "workspace: $WORKSPACE"',
    'echo "next: $HERE/verify-sandbox.sh"',
  ].join('\n') + '\n'
}

function verifySandboxScript(spec: SandboxSpec): string {
  return [
    '#!/usr/bin/env bash',
    '# Verify the actual Docker configuration, then probe write confinement.',
    'set -euo pipefail',
    `CONTAINER='${spec.container.name}'`,
    `SANDBOX_NAME='${spec.name}'`,
    'FAIL=0',
    'ok() { printf "✓ %s\\n" "$*"; }',
    'bad() { printf "✗ %s\\n" "$*"; FAIL=1; }',
    'docker container inspect "$CONTAINER" >/dev/null 2>&1 || { echo "container missing: $CONTAINER" >&2; exit 1; }',
    'ROOT="$HOME/.local/share/feishu4dsh/sandboxes/$SANDBOX_NAME"',
    '[ "$(docker inspect -f "{{.State.Running}}" "$CONTAINER")" = true ] && ok "container running" || bad "container not running"',
    '[ "$(docker inspect -f "{{.HostConfig.Privileged}}" "$CONTAINER")" = false ] && ok "privileged=false" || bad "privileged container"',
    '[ "$(docker inspect -f "{{.HostConfig.ReadonlyRootfs}}" "$CONTAINER")" = true ] && ok "read-only rootfs" || bad "rootfs is writable"',
    'CAPS="$(docker inspect -f "{{json .HostConfig.CapDrop}}" "$CONTAINER")"',
    'case "$CAPS" in *ALL*) ok "cap-drop includes ALL" ;; *) bad "cap-drop does not include ALL" ;; esac',
    'CAPADD="$(docker inspect -f "{{json .HostConfig.CapAdd}}" "$CONTAINER")"',
    'case "$CAPADD" in null|"[]") ok "no extra capabilities" ;; *) bad "extra capabilities: $CAPADD" ;; esac',
    'SECOPT="$(docker inspect -f "{{json .HostConfig.SecurityOpt}}" "$CONTAINER")"',
    'case "$SECOPT" in *no-new-privileges*) ok "no-new-privileges" ;; *) bad "no-new-privileges missing" ;; esac',
    'NET="$(docker inspect -f "{{.HostConfig.NetworkMode}}" "$CONTAINER")"',
    '[ "$NET" != host ] && ok "host network not used ($NET)" || bad "host network enabled"',
    'PIDMODE="$(docker inspect -f "{{.HostConfig.PidMode}}" "$CONTAINER")"',
    '[ "$PIDMODE" != host ] && ok "host PID namespace not used ($PIDMODE)" || bad "host PID namespace enabled"',
    'IPCMODE="$(docker inspect -f "{{.HostConfig.IpcMode}}" "$CONTAINER")"',
    '[ "$IPCMODE" != host ] && ok "host IPC namespace not used ($IPCMODE)" || bad "host IPC namespace enabled"',
    'DEVICES="$(docker inspect -f "{{json .HostConfig.Devices}}" "$CONTAINER")"',
    'case "$DEVICES" in null|"[]") ok "no host devices" ;; *) bad "host devices passed through: $DEVICES" ;; esac',
    'MOUNTS="$(docker inspect -f "{{range .Mounts}}{{println .Source}}{{end}}" "$CONTAINER")"',
    'while IFS= read -r src; do',
    '  [ -z "$src" ] && continue',
    '  case "$src" in',
    '    "$ROOT/workspace"|"$ROOT/inbox"|"$ROOT/outbox"|"$ROOT/home"|"$ROOT/cache") ok "allowed mount: $src" ;;',
    '    *) bad "unexpected host mount: $src" ;;',
    '  esac',
    'done <<< "$MOUNTS"',
    'if docker inspect -f "{{json .Mounts}}" "$CONTAINER" | grep -q docker.sock; then bad "Docker socket mounted"; else ok "docker socket not mounted"; fi',
    'if docker exec "$CONTAINER" sh -lc "touch /workspace/.feishu4dsh-verify && rm -f /workspace/.feishu4dsh-verify" >/dev/null 2>&1; then ok "workspace is writable"; else bad "workspace write probe failed"; fi',
    'if docker exec "$CONTAINER" sh -lc "touch /etc/.feishu4dsh-escape" >/dev/null 2>&1; then bad "root filesystem write unexpectedly succeeded"; else ok "root filesystem write denied"; fi',
    '[ "$FAIL" -eq 0 ] && echo "SANDBOX_VERIFY_OK" || { echo "SANDBOX_VERIFY_FAILED" >&2; exit 1; }',
  ].join('\n') + '\n'
}

function destroySandboxScript(spec: SandboxSpec): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'DRY_RUN=0; PURGE=0',
    'for arg in "$@"; do',
    '  case "$arg" in --dry-run) DRY_RUN=1 ;; --purge) PURGE=1 ;; *) echo "usage: $0 [--dry-run] [--purge]" >&2; exit 2 ;; esac',
    'done',
    'run() { if [ "$DRY_RUN" = 1 ]; then printf "+ "; printf "%q " "$@"; echo; else "$@"; fi; }',
    `CONTAINER='${spec.container.name}'`,
    `NETWORK_NAME='${spec.container.networkName}'`,
    `SANDBOX_NAME='${spec.name}'`,
    'if docker container inspect "$CONTAINER" >/dev/null 2>&1; then run docker rm -f "$CONTAINER"; fi',
    'if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then run docker network rm "$NETWORK_NAME"; fi',
    'ROOT="$HOME/.local/share/feishu4dsh/sandboxes/$SANDBOX_NAME"',
    'if [ "$PURGE" = 1 ]; then run rm -rf "$ROOT"; else echo "data retained: $ROOT (use --purge to delete)"; fi',
  ].join('\n') + '\n'
}

function packageReadme(spec: SandboxSpec, preflight: SandboxHostReport | undefined): string {
  const preflightLines = preflight === undefined
    ? ['- 未附预检快照；先执行 `host-preflight.sh`。']
    : preflight.checks.map(check => `- [${check.status}] ${check.label}: ${check.detail}`)
  return [
    `# feishu4dsh sandbox: ${spec.name}`,
    '',
    '本包由 `/she sandbox` 生成，不包含任何真实 API key、飞书 secret 或 Docker socket。',
    '',
    '## 规格',
    '',
    `- agent: ${spec.agent.label} (${spec.agent.id})`,
    `- adapter: ${spec.agent.adapter}`,
    `- target user: ${spec.target.user}`,
    `- source image: ${spec.agent.sourceImage}`,
    `- tools: ${spec.tools.join(', ')}`,
    `- network: ${spec.security.networkMode}`,
    '',
    '## 固定路径',
    '',
    '目标用户执行时固定使用：',
    '',
    '```text',
    '$HOME/.local/share/feishu4dsh/sandboxes/<sandbox-name>/',
    '  workspace/   # agent 私有业务工作树 RW → /workspace',
    '  inbox/       # 控制面/broker 写，容器只读 → /inbox',
    '  outbox/      # agent 写，控制面收集 → /outbox',
    '  home/        # agent HOME RW → /home/agent',
    '  cache/       # 包缓存 RW → /home/agent/.cache',
    '  logs/        # 宿主侧日志，不挂入容器',
    '  sandbox.json # 0600 descriptor',
    '```',
    '',
    '## 执行顺序（每行命令前的注释说明用途）',
    '',
    `- target mode: ${spec.target.requiresRootBootstrap ? '专用 rootless 账户' : '当前用户'}`,
    `- target user: ${spec.target.user}`,
    '',
    '```sh',
    '# 进入解压后的安装包目录（路径按实际下载位置替换）',
    'cd /path/to/package',
    '# 给当前目录下的脚本增加执行权限；不会执行它们',
    'chmod +x *.sh',
    '# 只读检查 Docker/rootless/目标用户/镜像；不会创建容器',
    './host-preflight.sh',
    '# 校验包内文件未在传输中损坏；必须看到所有行都是 OK',
    'sha256sum -c CHECKSUMS',
    ...(spec.target.requiresRootBootstrap
      ? [
          '# 仅当需要安装 Docker 或缺少 rootless 依赖时，可选执行 dry-run 审查',
          'sudo INSTALL_DOCKER_CE=1 ./bootstrap-host.sh --dry-run',
          '# 专用账户模式：root 一次性创建账户、subuid/subgid、linger 和 rootless 初始化',
          'sudo ./bootstrap-host.sh',
          '# 切换到目标账户；之后的创建/验证/销毁都不能使用 sudo',
          `sudo -iu ${spec.target.user}`,
          '# 切换账户后重新进入同一个安装包目录（路径按实际位置替换）',
          'cd /path/to/package',
        ]
      : [
          '# 当前用户模式不需要 root bootstrap；确认在目标用户 shell 中继续',
          '',
        ]),
    '# 构建镜像、创建独立网络并启动 sandbox 容器；不挂 Docker socket',
    './create-sandbox.sh',
    '# 检查实际容器安全边界并执行工作区/根文件系统写探针；应输出 SANDBOX_VERIFY_OK',
    './verify-sandbox.sh',
    '# 只删除容器和网络，保留 workspace/home/cache/logs；先看将执行什么',
    './destroy-sandbox.sh --dry-run',
    '# 真正删除容器和网络；数据默认保留',
    './destroy-sandbox.sh',
    '# 确认不再需要数据后，才删除固定 sandbox 根目录；不可恢复',
    './destroy-sandbox.sh --purge',
    '```',
    '',
    '当前用户模式不执行 `bootstrap-host.sh` 的建用户部分；若 Docker 缺失，先按仓库',
    '`scripts/sandbox-bootstrap-host.sh` 的提示安装 rootless Docker。',
    '',
    '> 所有命令请按顺序执行；不要对 `create-sandbox.sh`、`verify-sandbox.sh`、',
    '> `destroy-sandbox.sh` 使用 sudo。',
    '',
    '## 安全边界',
    '',
    '- 容器根文件系统只读；',
    '- `--cap-drop ALL`；',
    '- `no-new-privileges`；',
    '- 不挂 Docker socket、不使用 host network、不启用 privileged；',
    '- 只挂载 workspace/home/cache 三个叶子目录，不挂父目录或 `/srv` 根；',
    '- rootless Docker 未检测到时只告警，不宣称同等隔离；',
    '- 自定义镜像必须先通过 `docker image inspect` 或 `docker manifest inspect` 检查；',
    '- 镜像存在不代表 SHE/agent 协议兼容；自定义 agent 需要后续 adapter 验证；',
    '- 用户态安装写入 `/home/agent`（npm prefix、pip --user、uv tool/cache）；系统包需重建镜像，不能在只读 rootfs 上 apt 安装。',
    '',
    '## 生成时预检快照',
    '',
    ...preflightLines,
    '',
  ].join('\n')
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Generate a secret-free sandbox package. No Docker command is executed here. */
export async function buildSandboxPackage(input: SandboxPackageBuildInput): Promise<SandboxPackageResult> {
  const spec = input.spec
  const outputRoot = resolve(input.outputRoot
    ?? join(homedir(), '.local', 'share', 'feishu4dsh', SANDBOX_PACKAGE_ROOT_NAME))
  const deployment = spec.id.replace(/[^A-Za-z0-9._-]/g, '-')
  const dirName = `sandbox-${spec.name}-${deployment}`
  const packageDir = join(outputRoot, dirName)
  const archivePath = join(outputRoot, `${dirName}.tar.gz`)
  await mkdir(packageDir, { recursive: true, mode: 0o700 })
  try {
    const files: Record<string, string> = {
      'README.md': packageReadme(spec, input.preflight),
      'plan.json': `${JSON.stringify({ schema: 1, spec }, null, 2)}\n`,
      'host-preflight.sh': hostPreflightScript(spec),
      'bootstrap-host.sh': bootstrapHostScript(spec),
      'create-sandbox.sh': createSandboxScript(spec),
      'verify-sandbox.sh': verifySandboxScript(spec),
      'destroy-sandbox.sh': destroySandboxScript(spec),
      'Dockerfile': dockerfileFor(spec),
    }
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(packageDir, name), content, { mode: name.endsWith('.sh') ? 0o700 : 0o600 })
    }
    const checksums: string[] = []
    for (const name of Object.keys(files).sort()) checksums.push(`${await sha256(join(packageDir, name))}  ${name}`)
    await writeFile(join(packageDir, 'CHECKSUMS'), `${checksums.join('\n')}\n`, { mode: 0o600 })
    await execFileAsync('tar', ['-czf', archivePath, '-C', outputRoot, dirName], { maxBuffer: 8 * 1024 * 1024 })
    const bytes = await readFile(archivePath)
    return {
      sandboxId: spec.id,
      sandboxName: spec.name,
      packageDir,
      archivePath,
      archiveName: `${dirName}.tar.gz`,
      archiveBytes: bytes,
    }
  } catch (error) {
    throw error instanceof SandboxError
      ? error
      : new SandboxError('package_failed', error instanceof Error ? error.message : String(error))
  }
}
