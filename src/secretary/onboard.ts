/**
 * R65 terminal onboarding kit.
 *
 * This module is deliberately non-interactive: the CLI collects choices and
 * this module writes a self-contained, review-before-run kit. It never runs
 * sudo, calls Docker, or reads/writes credentials. The generated scripts keep
 * root setup, target-user rootless setup, and sandbox lifecycle strictly
 * separate.
 * @module feishu4dsh/secretary/onboard
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  buildSandboxPackage,
  buildSandboxSpec,
  type SandboxAgentId,
  type SandboxHostReport,
  type SandboxPackageResult,
  type SandboxTargetKind,
  type SandboxToolId,
} from './sandbox.js'

export interface SandboxOnboardingInput {
  /** Repository root; used only to copy static onboarding helper scripts. */
  readonly repoRoot: string
  /** Base directory for generated onboarding directories. */
  readonly outputRoot: string
  readonly sandboxName: string
  readonly targetKind: SandboxTargetKind
  readonly currentUser: string
  readonly dedicatedUser?: string
  readonly agentId: SandboxAgentId
  readonly customImage?: string
  readonly tools?: readonly SandboxToolId[]
  readonly host?: SandboxHostReport
  readonly now?: number
}

export interface SandboxOnboardingResult {
  readonly directory: string
  readonly manifestPath: string
  readonly readmePath: string
  readonly package: SandboxPackageResult
  readonly scripts: readonly string[]
  readonly commands: readonly string[]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function executable(name: string): string {
  return `"$HERE/${name}"`
}

function renderReadme(input: {
  readonly targetKind: SandboxTargetKind
  readonly targetUser: string
  readonly sandboxName: string
  readonly agentLabel: string
  readonly tools: readonly string[]
  readonly packageRel: string
  readonly host?: SandboxHostReport
  readonly directory: string
}): string {
  const checkLines = input.host === undefined
    ? ['- 未执行主机探测；请先运行 `00-preflight.sh`。']
    : input.host.checks.map(check => `- [${check.status}] ${check.label}: ${check.detail}`)
  const dedicated = input.targetKind === 'dedicated-user'
  const steps = dedicated
    ? [
        '`00-preflight.sh`（当前用户，只读）',
        '`10-bootstrap-host-root.sh`（root，一次性：创建账户、subuid/subgid、linger；若 Docker 缺失，先运行 `sudo INSTALL_DOCKER_CE=1 bash 10-bootstrap-host-root.sh --dry-run`）',
        '`20-init-rootless-target.sh`（目标用户，非 root：初始化 rootless Docker 并运行 hello-world）',
        '`30-create-sandbox-target.sh`（目标用户，非 root）',
        '`40-verify-sandbox-target.sh`（目标用户，非 root）',
        '`90-destroy-sandbox-target.sh`（目标用户，非 root；默认保留数据）',
      ]
    : [
        '`00-preflight.sh`（当前用户，只读）',
        '仅当 Docker/rootless 缺失时，才执行 root 侧安装脚本（不创建新账户）',
        '`20-init-rootless-target.sh`（当前用户，非 root，可选）',
        '`30-create-sandbox-target.sh`（当前用户，非 root）',
        '`40-verify-sandbox-target.sh`（当前用户，非 root）',
        '`90-destroy-sandbox-target.sh`（当前用户，非 root；默认保留数据）',
      ]
  return [
    `# feishu4dsh sandbox onboarding: ${input.sandboxName}`,
    '',
    '本目录由 `pnpm sandbox:onboard` 生成，**不包含真实密钥**。',
    '',
    '## 1. 这套东西是什么',
    '',
    '```text',
    '飞书 / SHE  →  控制面：任务、审批、状态',
    '             →  target-user Docker：创建 sandbox',
    '             →  容器内 agent：只看到自己的 workspace/home/cache',
    '```',
    '',
    'agent 不拿 Docker socket；sandbox 默认只挂载自己的 workspace/home/cache，不挂宿主 home、项目根目录或 `/srv` 根。',
    '',
    '## 2. 本次选择',
    '',
    `- sandbox: \`${input.sandboxName}\``,
    `- target: ${dedicated ? '专用 rootless 账户' : '当前用户'} (\`${input.targetUser}\`)`,
    `- agent: ${input.agentLabel}`,
    `- tools: ${input.tools.join(', ')}`,
    `- package: \`${input.packageRel}\``,
    '',
    '## 3. 执行顺序',
    '',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '### 脚本权限边界',
    '',
    '- `10-bootstrap-host-root.sh` 必须以 root 执行；它不会读取 provider key 或飞书 secret；',
    '- `00/20/30/40/90` 必须由目标用户执行，不能使用 sudo；',
    '- `20-init-rootless-target.sh` 只初始化目标用户的 rootless Docker；',
    '- `30/40/90` 只操作本 sandbox 的容器和固定目录；',
    '- Docker CLI 缺失时，先执行 `sudo INSTALL_DOCKER_CE=1 bash 10-bootstrap-host-root.sh --dry-run`，审查后再正式执行；',
    '- 执行任何脚本前先看 `manifest.json`、`plan.json`、`Dockerfile` 和脚本文本。',
    '',
    '## 4. 提醒',
    '',
    '- 不要把 sandbox 数据放在项目仓库或 `~/Projects`；',
    '- 当前用户模式下，用户仍可以直接访问并删除自己的 sandbox 数据；需要更强隔离时请用专用账户；',
    '- `destroy-sandbox-target.sh` 默认只删容器，数据保留；只有显式 `--purge` 才删数据目录；',
    '- 不把宿主 home、项目根、`/srv` 根或 Docker socket 挂进 agent 容器；',
    '- 状态/资源轮询本身不消耗模型 token；向 agent 提交 prompt 或唤醒 agent 才会消耗 token。',
    '',
    '## 5. 固定路径',
    '',
    '```text',
    '$HOME/.local/share/feishu4dsh/sandboxes/<sandbox-name>/',
    '  workspace/  # 业务数据',
    '  home/       # agent 用户态工具',
    '  cache/      # 包缓存',
    '  logs/       # 宿主侧日志，不挂入容器',
    '  sandbox.json',
    '```',
    '',
    '## 6. 本机预检快照',
    '',
    ...checkLines,
    '',
    '## 7. 后续',
    '',
    '完成创建和验证后，可以在飞书里用 SHE 管理任务；若要让不同 agent 协作，应先定义角色、任务预算和委派深度，不能允许无限转包。',
    '',
  ].join('\n')
}

function commonHeader(): string[] {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  ]
}

function renderPreflight(targetUser: string, packageDirName: string): string {
  return [
    ...commonHeader(),
    `TARGET_USER=${shellQuote(targetUser)}`,
    'if [ -x "$HERE/tools/sandbox-preflight.sh" ]; then',
    '  "$HERE/tools/sandbox-preflight.sh" --user "$TARGET_USER"',
    'fi',
    `if [ -x "$HERE/package/${packageDirName}/host-preflight.sh" ]; then`,
    `  ( cd "$HERE/package/${packageDirName}" && env TARGET_USER="$TARGET_USER" ./host-preflight.sh )`,
    'fi',
    '',
    'echo "PREFLIGHT_DONE"',
  ].join('\n') + '\n'
}

function renderRootBootstrap(targetUser: string): string {
  return [
    ...commonHeader(),
    '[ "$(id -u)" -eq 0 ] || { echo "must run as root: sudo bash 10-bootstrap-host-root.sh --dry-run" >&2; exit 1; }',
    `TARGET_USER=${shellQuote(targetUser)}`,
    'if [ ! -x "$HERE/tools/sandbox-bootstrap-host.sh" ]; then',
    '  echo "missing tools/sandbox-bootstrap-host.sh" >&2',
    '  exit 1',
    'fi',
    'echo "root bootstrap target: $TARGET_USER"',
    'echo "review this script; it does not read provider keys or Feishu secrets"',
    'if [ "${INSTALL_DOCKER_CE:-0}" = "1" ]; then',
    '  exec "$HERE/tools/sandbox-bootstrap-host.sh" --user "$TARGET_USER" --install-docker-ce "$@"',
    'else',
    '  exec "$HERE/tools/sandbox-bootstrap-host.sh" --user "$TARGET_USER" "$@"',
    'fi',
  ].join('\n') + '\n'
}

function renderRootlessInit(targetUser: string): string {
  return [
    ...commonHeader(),
    `TARGET_USER=${shellQuote(targetUser)}`,
    'if [ "$(id -un)" != "$TARGET_USER" ]; then',
    '  echo "run as $TARGET_USER (no sudo): sudo -iu $TARGET_USER then execute this script" >&2',
    '  exit 1',
    'fi',
    'if [ ! -x "$HERE/tools/sandbox-rootless-init.sh" ]; then',
    '  echo "missing tools/sandbox-rootless-init.sh" >&2',
    '  exit 1',
    'fi',
    'exec "$HERE/tools/sandbox-rootless-init.sh"',
  ].join('\n') + '\n'
}

function renderPackageScript(targetUser: string, packageDirName: string, file: string): string {
  return [
    ...commonHeader(),
    `TARGET_USER=${shellQuote(targetUser)}`,
    'if [ "$(id -un)" != "$TARGET_USER" ]; then',
    '  echo "run as $TARGET_USER (no sudo): sudo -iu $TARGET_USER then execute this script" >&2',
    '  exit 1',
    'fi',
    `if [ ! -x "$HERE/package/${packageDirName}/${file}" ]; then`,
    `  echo "missing package/${packageDirName}/${file}" >&2`,
    '  exit 1',
    'fi',
    `exec "$HERE/package/${packageDirName}/${file}" "$@"`,
  ].join('\n') + '\n'
}

async function copyTool(repoRoot: string, targetDir: string, name: string): Promise<void> {
  const source = join(repoRoot, 'scripts', name)
  const target = join(targetDir, name)
  await copyFile(source, target)
}

/** Generate a self-contained terminal onboarding kit and sandbox package. */
export async function buildSandboxOnboarding(input: SandboxOnboardingInput): Promise<SandboxOnboardingResult> {
  const now = input.now ?? Date.now()
  const targetUser = input.targetKind === 'current-user' ? input.currentUser : (input.dedicatedUser ?? 'feishu4dsh-sandbox')
  const spec = buildSandboxSpec({
    name: input.sandboxName,
    targetKind: input.targetKind,
    currentUser: input.currentUser,
    dedicatedUser: input.dedicatedUser,
    agentId: input.agentId,
    customImage: input.customImage,
    tools: input.tools,
    now,
  })
  const directory = resolve(input.outputRoot, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${spec.name}`)
  const packageRoot = join(directory, 'package')
  const toolsDir = join(directory, 'tools')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(toolsDir, { recursive: true, mode: 0o700 })
  await Promise.all([
    copyTool(input.repoRoot, toolsDir, 'sandbox-preflight.sh'),
    copyTool(input.repoRoot, toolsDir, 'sandbox-bootstrap-host.sh'),
    copyTool(input.repoRoot, toolsDir, 'sandbox-rootless-init.sh'),
  ])
  const pkg = await buildSandboxPackage({ spec, preflight: input.host, outputRoot: packageRoot })
  const packageDirName = basename(pkg.packageDir)
  const packageRel = `package/${packageDirName}`
  const readme = renderReadme({
    targetKind: spec.target.kind,
    targetUser,
    sandboxName: spec.name,
    agentLabel: spec.agent.label,
    tools: spec.tools,
    packageRel,
    host: input.host,
    directory,
  })
  const scripts: Record<string, string> = {
    '00-preflight.sh': renderPreflight(targetUser, packageDirName),
    '10-bootstrap-host-root.sh': renderRootBootstrap(targetUser),
    '20-init-rootless-target.sh': renderRootlessInit(targetUser),
    '30-create-sandbox-target.sh': renderPackageScript(targetUser, packageDirName, 'create-sandbox.sh'),
    '40-verify-sandbox-target.sh': renderPackageScript(targetUser, packageDirName, 'verify-sandbox.sh'),
    '90-destroy-sandbox-target.sh': renderPackageScript(targetUser, packageDirName, 'destroy-sandbox.sh'),
  }
  const manifest = {
    schema: 1,
    createdAt: new Date(now).toISOString(),
    sandboxName: spec.name,
    target: spec.target,
    agent: spec.agent,
    tools: spec.tools,
    directory,
    packageDir: pkg.packageDir,
    archive: pkg.archivePath,
    scripts: [
      { file: '00-preflight.sh', user: 'current-user', root: false },
      { file: '10-bootstrap-host-root.sh', user: 'root', root: true },
      { file: '20-init-rootless-target.sh', user: targetUser, root: false },
      { file: '30-create-sandbox-target.sh', user: targetUser, root: false },
      { file: '40-verify-sandbox-target.sh', user: targetUser, root: false },
      { file: '90-destroy-sandbox-target.sh', user: targetUser, root: false },
    ],
    warnings: [
      'Do not put sandbox data in the project repository or ~/Projects.',
      'Current-user mode cannot protect the user from deleting the sandbox data themselves.',
      '10-bootstrap-host-root.sh is the only root script; it must never receive provider keys or Feishu secrets.',
      'Lifecycle scripts are non-root and must be run as the target user.',
    ],
  }
  const files = [
    'README.md', 'manifest.json',
    ...Object.keys(scripts),
    'tools/sandbox-preflight.sh', 'tools/sandbox-bootstrap-host.sh', 'tools/sandbox-rootless-init.sh',
  ]
  await writeFile(join(directory, 'README.md'), readme, { mode: 0o600 })
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  for (const [name, content] of Object.entries(scripts)) {
    await writeFile(join(directory, name), content, { mode: 0o700 })
  }
  const rootlessReady = input.host?.currentDockerReady === true && input.host?.rootlessDocker === true
  const needsRootBootstrap = spec.target.kind === 'dedicated-user' || !rootlessReady
  const commands = [
    'cd ' + shellQuote(directory),
    'cat README.md',
    './00-preflight.sh',
    ...(needsRootBootstrap
      ? [
          '# Review root bootstrap first; add INSTALL_DOCKER_CE=1 in front if Docker is missing:',
          'sudo bash 10-bootstrap-host-root.sh --dry-run',
          'sudo bash 10-bootstrap-host-root.sh',
          `# Then as ${targetUser}:`,
          './20-init-rootless-target.sh',
        ]
      : ['# Current-user rootless Docker is already reachable; skip root bootstrap and rootless init.']),
    './30-create-sandbox-target.sh',
    './40-verify-sandbox-target.sh',
  ]
  return {
    directory,
    manifestPath: join(directory, 'manifest.json'),
    readmePath: join(directory, 'README.md'),
    package: pkg,
    scripts: Object.keys(scripts),
    commands,
  }
}
