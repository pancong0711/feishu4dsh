import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildSheNeedPackage, inspectSheNeed } from '../src/secretary/need.js'

describe('SHE sandbox need', () => {
  it('reports missing descriptor/health without invoking Docker and packages a secret-free handoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-need-'))
    const project = join(dir, 'project')
    const shared = join(dir, 'shared')
    try {
      execFileSync('mkdir', ['-p', project, shared])
      const config = resolveConfig({
        appId: 'cli_test',
        appSecret: 'secret',
        workspace: project,
        secretarySandboxRoot: shared,
        secretarySandboxDescriptor: join(shared, '.she', 'sandbox.json'),
        secretarySandboxPasswordFile: join(dir, 'missing-password.json'),
        secretarySandboxOpencodeUrl: 'http://127.0.0.1:1',
      })
      const report = await inspectSheNeed(config, {
        channelUser: 'runtime-user',
        probeOpenCode: async () => ({ ok: false, detail: 'test refused' }),
      })
      expect(report.channelUser).toBe('runtime-user')
      expect(report.ready).toBe(false)
      expect(report.items.some(item => item.id === 'descriptor' && item.status === 'missing')).toBe(true)

      const pkg = await buildSheNeedPackage({ report, projectRoot: project })
      expect(existsSync(join(pkg.packageDir, 'NEED.md'))).toBe(true)
      expect(existsSync(join(pkg.packageDir, 'need.json'))).toBe(true)
      expect(existsSync(join(pkg.packageDir, 'bootstrap-host.sh'))).toBe(true)
      expect(existsSync(join(pkg.packageDir, 'install-sandbox.sh'))).toBe(true)
      expect(existsSync(join(pkg.packageDir, 'verify.sh'))).toBe(true)
      expect(existsSync(join(pkg.packageDir, 'CHECKSUMS'))).toBe(true)
      expect(statSync(pkg.archivePath).size).toBeGreaterThan(0)
      expect(pkg.archiveName).toMatch(/\.tar\.gz$/)
      const bootstrap = execFileSync('cat', [join(pkg.packageDir, 'bootstrap-host.sh')], { encoding: 'utf8' })
      expect(bootstrap).toContain('runtime-user')
      expect(bootstrap).toContain('opencode-she')
      expect(bootstrap).not.toContain('bot2603')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
