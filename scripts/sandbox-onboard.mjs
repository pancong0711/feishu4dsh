#!/usr/bin/env node
/**
 * R65 terminal onboarding CLI.
 *
 * The CLI is intentionally not privileged: it only inspects the host and
 * writes a reviewable kit. Root setup, rootless init, and sandbox lifecycle
 * remain separate scripts that the operator executes explicitly.
 */
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { homedir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  SANDBOX_AGENT_PROFILES, SANDBOX_TOOL_BUNDLES, inspectSandboxHost, makeSandboxName,
} from '../lib/secretary/sandbox.js'
import { buildSandboxOnboarding } from '../lib/secretary/onboard.js'

function usage() {
  return `feishu4dsh sandbox onboarding

Usage:
  pnpm sandbox:onboard                 # interactive
  pnpm sandbox:onboard -- --yes --target dedicated-user --name demo --agent blank --tools core

Options:
  --target dedicated-user|current-user   Target mode (default: dedicated-user)
  --user <name>                         Dedicated account (default: feishu4dsh-sandbox)
  --name <name>                         Sandbox name (default: generated)
  --agent opencode|blank|hermes|deepseek-harness|custom
  --image <ref>                         Required for hermes/deepseek-harness/custom
  --tools core,node,python,build,data,search
  --output <dir>                        Onboarding root (default: ~/.local/share/feishu4dsh/onboarding)
  --yes                                  Non-interactive
  --help

The generated kit contains root-only bootstrap, target-user rootless init and
target-user create/verify/destroy scripts. Nothing is executed automatically.
`
}

function parseArgs(argv) {
  const options = {
    yes: false,
    targetKind: 'dedicated-user',
    dedicatedUser: 'feishu4dsh-sandbox',
    name: undefined,
    agentId: 'blank',
    image: undefined,
    tools: ['core'],
    outputRoot: join(homedir(), '.local', 'share', 'feishu4dsh', 'onboarding'),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--yes' || arg === '-y') { options.yes = true; continue }
    const take = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      i += 1
      return value
    }
    if (arg === '--target') {
      const value = take()
      if (value !== 'dedicated-user' && value !== 'current-user') throw new Error('invalid --target')
      options.targetKind = value
    } else if (arg === '--user') {
      options.dedicatedUser = take()
    } else if (arg === '--name') {
      options.name = take()
    } else if (arg === '--agent') {
      const value = take()
      if (!SANDBOX_AGENT_PROFILES.some(profile => profile.id === value)) throw new Error('invalid --agent')
      options.agentId = value
    } else if (arg === '--image') {
      options.image = take()
    } else if (arg === '--tools') {
      options.tools = take().split(',').map(item => item.trim()).filter(Boolean)
    } else if (arg === '--output') {
      options.outputRoot = take()
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function icon(status) {
  return status === 'ok' ? '✓' : status === 'missing' ? '✗' : status === 'warn' ? '!' : '?'
}

function printHostReport(report) {
  console.log('\n本机预检：')
  for (const check of report.checks) console.log(`  ${icon(check.status)} ${check.label}: ${check.detail}`)
  console.log(`  当前用户 Docker 可用: ${report.currentDockerReady ? 'yes' : 'no'}`)
  console.log(`  rootless Docker: ${report.rootlessDocker ? 'yes' : 'no/unknown'}`)
}

function printIntro() {
  console.log(`\nfeishu4dsh sandbox onboarding
================================

这套 onboarding 会生成一个可审查的本地工具包，不会自动 sudo、安装软件或创建容器。

核心模型：
  飞书 / SHE  = 控制面：任务、审批、状态
  sandbox     = agent 的独立执行空间
  broker      = 未来的受限容器管理面（当前未实现）

安全边界：
  - agent 不拿 Docker socket
  - 只挂载自己的 workspace/home/cache
  - root 脚本只做一次性主机/账户初始化
  - 创建、验证、销毁必须由目标用户非 root 执行
  - 不把 sandbox 数据放在项目仓库或 ~/Projects
`)
}

async function ask(rl, question, fallback) {
  const answer = (await rl.question(`${question}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim()
  return answer === '' && fallback !== undefined ? fallback : answer
}

async function askChoice(rl, question, choices, fallback) {
  console.log(question)
  choices.forEach((choice, i) => console.log(`  ${i + 1}) ${choice.label}`))
  const raw = await ask(rl, '选择', String(fallback))
  const index = Number(raw) - 1
  if (!Number.isInteger(index) || choices[index] === undefined) throw new Error('invalid choice')
  return choices[index].value
}

async function interactive(options) {
  const rl = createInterface({ input, output })
  try {
    printIntro()
    options.targetKind = await askChoice(rl, '\n目标账户：', [
      { label: '专用 rootless 账户（推荐）', value: 'dedicated-user' },
      { label: '当前用户（快速测试/同账户模式）', value: 'current-user' },
    ], 1)
    if (options.targetKind === 'dedicated-user') {
      options.dedicatedUser = await ask(rl, '专用账户名', options.dedicatedUser)
    }
    options.name = await ask(rl, 'Sandbox 名称（小写字母/数字/连字符）', options.name ?? makeSandboxName())
    const agentChoices = [
      { label: '空白基础沙箱（推荐首次测试）', value: 'blank' },
      { label: 'OpenCode（固定版本）', value: 'opencode' },
      { label: 'Hermes Agent（需自定义镜像）', value: 'hermes' },
      { label: 'DeepSeek Harness（需自定义镜像）', value: 'deepseek-harness' },
      { label: '自定义 Agent 镜像', value: 'custom' },
    ]
    options.agentId = await askChoice(rl, '\nAgent：', agentChoices, 1)
    if (options.agentId === 'hermes' || options.agentId === 'deepseek-harness' || options.agentId === 'custom') {
      options.image = await ask(rl, '镜像引用（必须已核验）')
      if (options.image === '') throw new Error('this agent requires --image')
    }
    const toolIds = SANDBOX_TOOL_BUNDLES.map(bundle => bundle.id).join(',')
    const rawTools = await ask(rl, `工具包（${toolIds}）`, options.tools.join(','))
    options.tools = rawTools.split(',').map(item => item.trim()).filter(Boolean)
    const host = await inspectSandboxHost(options.dedicatedUser)
    printHostReport(host)
    options.host = host
    const summary = [
      `target: ${options.targetKind}`,
      `user: ${options.targetKind === 'current-user' ? 'current user' : options.dedicatedUser}`,
      `sandbox: ${options.name}`,
      `agent: ${options.agentId}`,
      `tools: ${options.tools.join(',')}`,
      `output: ${options.outputRoot}`,
    ].join('\n')
    console.log(`\n即将生成：\n${summary}\n`)
    const ok = await ask(rl, '确认生成？(y/N)', 'n')
    if (!/^y(es)?$/i.test(ok)) {
      console.log('已取消。')
      return undefined
    }
    return options
  } finally {
    rl.close()
  }
}

async function nonInteractive(options) {
  if (options.agentId === 'hermes' || options.agentId === 'deepseek-harness' || options.agentId === 'custom') {
    if (options.image === undefined || options.image.trim() === '') throw new Error(`${options.agentId} requires --image`)
  }
  options.name = options.name ?? makeSandboxName()
  options.host = await inspectSandboxHost(options.dedicatedUser)
  printHostReport(options.host)
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }
  if (!options.yes && !process.stdin.isTTY) {
    console.error('non-interactive shell requires --yes\n')
    console.error(usage())
    process.exitCode = 2
    return
  }
  const selected = options.yes ? await nonInteractive(options) : await interactive(options)
  if (selected === undefined) return
  const result = await buildSandboxOnboarding({
    repoRoot: fileURLToPath(new URL('..', import.meta.url)),
    outputRoot: selected.outputRoot,
    sandboxName: selected.name,
    targetKind: selected.targetKind,
    currentUser: userInfo().username,
    dedicatedUser: selected.dedicatedUser,
    agentId: selected.agentId,
    customImage: selected.image,
    tools: selected.tools,
    host: selected.host,
  })
  console.log(`\n✅ onboarding 已生成：${result.directory}`)
  console.log(`   README: ${result.readmePath}`)
  console.log(`   manifest: ${result.manifestPath}`)
  console.log(`   package: ${result.package.archivePath}`)
  console.log('\n执行顺序：')
  for (const command of result.commands) console.log(`  ${command}`)
  console.log('\n注意：10-bootstrap-host-root.sh 是唯一的 root 脚本；其余生命周期脚本必须由目标用户非 root 执行。')
}

main().catch(error => {
  console.error(`onboarding failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
