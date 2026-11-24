import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
