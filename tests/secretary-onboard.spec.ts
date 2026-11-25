import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildSandboxOnboarding } from '../src/secretary/onboard.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const hostReport = {
  schema: 1 as const,
  checkedAt: '2026-11-23T00:00:00.000Z',
  currentUser: 'alice',
  dedicatedUser: 'feishu4dsh-sandbox',
  checks: [
    { id: 'docker-cli', label: 'Docker CLI', status: 'ok' as const, detail: 'Docker version 27' },
    { id: 'docker-daemon', label: 'Docker daemon', status: 'ok' as const, detail: 'server 27' },
    { id: 'rootless-docker', label: 'rootless Docker', status: 'ok' as const, detail: 'rootless' },
  ],
  currentDockerReady: true,
  rootlessDocker: true,
  recommendedTarget: 'current-user' as const,
}

describe('terminal sandbox onboarding (R65)', () => {
  it('renders a dry-run for both user services without touching systemd', () => {
    const script = join(repoRoot, 'scripts', 'install-user-services.sh')
    execFileSync('bash', ['-n', script])
    const output = execFileSync('bash', [
      script, '--dry-run', '--repo', repoRoot, '--dsh', '/bin/true',
      '--profile', 'feishu4dsh', '--env-file', '/tmp/feishu4dsh-test.env',
    ], { encoding: 'utf8' })
    expect(output).toContain('== current service discovery ==')
    expect(output).toContain('== desired dsh unit ==')
    expect(output).toContain('== desired broker unit ==')
    expect(output).toContain('installer-managed path:')
    expect(output).toContain('ExecStart=/bin/true --profile feishu4dsh')
    expect(output).toContain('sandbox-broker.sh')
    expect(output).toContain('--check')
  })

  it('discovers an existing service before creating a unit directory or shadowing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu4dsh-services-'))
    const bin = join(dir, 'bin')
    const xdg = join(dir, 'xdg')
    const envFile = join(dir, 'feishu4dsh.env')
    mkdirSync(bin, { recursive: true })
    writeFileSync(envFile, 'FEISHU_APP_ID=test\nFEISHU_APP_SECRET=test\n', { mode: 0o600 })
    const fakeSystemctl = join(bin, 'systemctl')
    writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--user" ] && shift
case "\${1:-}" in
  show-environment) exit 0 ;;
  show)
    prop="\${3:-}"; unit="\${5:-}"
    case "$prop" in
      FragmentPath) echo "/tmp/external-systemd/$unit" ;;
      LoadState) echo loaded ;;
      UnitFileState) echo enabled ;;
      ActiveState) echo active ;;
      WorkingDirectory) echo /tmp/external-repo ;;
      ExecStart) echo "{ path=/tmp/external-dsh ; argv[]=/tmp/external-dsh --profile feishu4dsh ; ignore_failure=no }" ;;
      EnvironmentFiles) echo "/tmp/external.env (ignore_errors=no)" ;;
      DropInPaths) echo "" ;;
      *) echo "" ;;
    esac ;;
  is-enabled) echo enabled ;;
  is-active) echo active ;;
  daemon-reload) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 })
    try {
      let failed = false
      let output = ''
      try {
        execFileSync('bash', [
          join(repoRoot, 'scripts', 'install-user-services.sh'),
          '--enable', '--only', 'channel', '--repo', repoRoot,
          '--dsh', '/bin/true', '--env-file', envFile,
        ], {
          encoding: 'utf8',
          env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdg, PATH: `${bin}:${process.env.PATH ?? ''}` },
        })
      } catch (error) {
        failed = true
        const e = error as { stdout?: string; stderr?: string }
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`
      }
      expect(failed).toBe(true)
      expect(output).toContain('/tmp/external-systemd/dsh-feishu4dsh.service')
      expect(output).toContain('refusing to create a duplicate/shadow unit')
      expect(existsSync(join(xdg, 'systemd', 'user'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('documents service separation, account boundary and check mode in help', () => {
    const script = join(repoRoot, 'scripts', 'install-user-services.sh')
    const output = execFileSync('bash', [script, '--help'], { encoding: 'utf8' })
    expect(output).toContain('dsh-feishu4dsh.service')
    expect(output).toContain('feishu4dsh-sandbox-broker.service')
    expect(output).toContain('--check')
    expect(output).toContain('--only all|channel|broker')
    expect(output).toContain('--replace')
    expect(output).toContain('same account')
  })

  it('shows broker CLI scope and same-account boundary in help', () => {
    const output = execFileSync('bash', [join(repoRoot, 'scripts', 'sandbox-broker.sh'), '--help'], { encoding: 'utf8' })
    expect(output).toContain('host-local control service')
    expect(output).toContain('no generic Docker command surface')
    expect(output).toContain('same-account only')
    expect(output).toContain('install-user-services.sh --check --only broker')
  })

  it('treats --help as read-only for target-user lifecycle helper scripts', () => {
    for (const file of ['sandbox-rootless-init.sh', 'sandbox-preflight.sh', 'sandbox-bootstrap-host.sh']) {
      const output = execFileSync('bash', [join(repoRoot, 'scripts', file), '--help'], { encoding: 'utf8' })
      expect(output.toLowerCase()).toContain('usage')
      expect(output).toContain('--help')
    }
  })

  it('checks development prerequisites and points to the non-root pnpm installer', () => {
    const script = join(repoRoot, 'scripts', 'bootstrap-dev-env.sh')
    execFileSync('bash', ['-n', script])
    const output = execFileSync('bash', [script, '--check'], { encoding: 'utf8' })
    expect(output).toContain('Node.js')
    expect(output).toContain('pnpm')
    expect(output).toContain('pnpm install --frozen-lockfile')
    expect(output).toContain('bootstrap-dev-env.sh --install-pnpm')
  })

  it('generates a self-contained current-user kit with ordered non-root scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-onboard-'))
    try {
      const result = await buildSandboxOnboarding({
        repoRoot,
        outputRoot: dir,
        sandboxName: 'onboard-demo',
        targetKind: 'current-user',
        currentUser: 'alice',
        agentId: 'blank',
        tools: ['core'],
        host: hostReport,
        now: 1_700_000_000_000,
      })
      expect(existsSync(result.readmePath)).toBe(true)
      expect(existsSync(result.manifestPath)).toBe(true)
      expect(existsSync(result.package.packageDir)).toBe(true)
      for (const script of result.scripts) {
        const path = join(result.directory, script)
        expect(existsSync(path)).toBe(true)
        execFileSync('bash', ['-n', path])
      }
      const readme = readFileSync(result.readmePath, 'utf8')
      expect(readme).toContain('这套东西是什么')
      expect(readme).toContain('当前用户')
      expect(readme).toContain('不要')
      expect(readme).toContain('destroy-sandbox-target.sh')
      expect(readme).toContain('命令逐行说明')
      expect(readme).toContain('# 只读检查 Docker/rootless/目标账户/镜像')
      expect(readme).toContain('# 构建镜像、创建独立网络并启动 sandbox 容器')
      expect(readme).toContain('交付方式')
      expect(readme).toContain('不通过飞书发送')
      expect(readme).toContain('install-user-services.sh')
      expect(readme).toContain('--only broker')
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
        target: { kind: string; user: string }
        scripts: { file: string; root: boolean }[]
      }
      expect(manifest.target).toEqual({ kind: 'current-user', user: 'alice', requiresRootBootstrap: false })
      expect(manifest.scripts.some(script => script.file === '10-bootstrap-host-root.sh' && script.root)).toBe(true)
      const create = readFileSync(join(result.directory, '30-create-sandbox-target.sh'), 'utf8')
      expect(create).toContain("TARGET_USER='alice'")
      expect(create).toContain('no sudo')
      expect(result.commands).not.toContain('sudo bash 10-bootstrap-host-root.sh --dry-run')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates dedicated-account root and target-user scripts without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-onboard-ded-'))
    try {
      const result = await buildSandboxOnboarding({
        repoRoot,
        outputRoot: dir,
        sandboxName: 'dedicated-demo',
        targetKind: 'dedicated-user',
        currentUser: 'alice',
        dedicatedUser: 'feishu4dsh-sandbox',
        agentId: 'blank',
        tools: ['core'],
        now: 1_700_000_000_000,
      })
      const rootScript = readFileSync(join(result.directory, '10-bootstrap-host-root.sh'), 'utf8')
      expect(rootScript).toContain('must run as root')
      expect(rootScript).toContain("TARGET_USER='feishu4dsh-sandbox'")
      expect(rootScript).not.toContain('apiKey')
      const readme = readFileSync(result.readmePath, 'utf8')
      expect(readme).toContain('专用 rootless 账户')
      expect(readme).toContain('10-bootstrap-host-root.sh')
      expect(readme).toContain('20-init-rootless-target.sh')
      expect(result.commands).toContain('sudo bash 10-bootstrap-host-root.sh --dry-run')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
