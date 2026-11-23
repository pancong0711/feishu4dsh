import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { inspectSheNeed } from '../src/secretary/need.js'

describe('SHE attach readiness', () => {
  it('reports missing descriptor/health without invoking Docker or generating packages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-need-'))
    const project = join(dir, 'project')
    const shared = join(dir, 'shared')
    try {
      mkdirSync(project, { recursive: true })
      mkdirSync(shared, { recursive: true })
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
      expect(report.items.some(item => item.id === 'opencode-health')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
