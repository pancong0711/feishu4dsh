import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { SecretaryRuntime } from '../src/secretary/runtime.js'
import { SHE_BOOTSTRAP_SCHEMA, readBootstrapState, writeBootstrapState, withBootstrapScope, type SecretaryBootstrapState } from '../src/secretary/bootstrap.js'

describe('SHE runtime bootstrap restore', () => {
  it('starts SHE from the 0600 state file when manual config is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-runtime-'))
    const stateFile = join(dir, 'she-bootstrap.json')
    const passwordFile = join(dir, 'opencode-service.json')
    const runtimeRoot = join(dir, 'runtime')
    writeFileSync(passwordFile, '{"password":"test"}', { mode: 0o600 })
    const base: SecretaryBootstrapState = {
      schema: SHE_BOOTSTRAP_SCHEMA,
      initializedAt: 1,
      updatedAt: 1,
      runtime: {
        root: runtimeRoot,
        worktreeRoot: join(runtimeRoot, 'worktrees'),
        reposRoot: join(dir, 'repos'),
      },
      opencode: { url: 'http://127.0.0.1:49375', username: 'opencode', passwordFile },
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
      scopes: {},
    }
    try {
      await writeBootstrapState(stateFile, withBootstrapScope(base, 'scope-a', '/src/repo', '/shared/repo', 2))
      const config = resolveConfig({
        appId: 'cli_test',
        appSecret: 'secret',
        workspace: dir,
        secretaryEnabled: false,
        secretaryAutoRestore: true,
        secretaryBootstrapFile: stateFile,
      })
      const reports: string[] = []
      const runtime = new SecretaryRuntime(config, line => reports.push(line))
      try {
        const service = await runtime.start()
        expect(service).toBeDefined()
        expect(runtime.workspaceFor('scope-a')).toBe('/shared/repo')
        expect(reports.some(line => line.includes('source=bootstrap'))).toBe(true)
      } finally {
        await runtime.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed and reports a malformed state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-runtime-'))
    const stateFile = join(dir, 'she-bootstrap.json')
    try {
      writeFileSync(stateFile, '{"schema":1}')
      const config = resolveConfig({
        appId: 'cli_test',
        appSecret: 'secret',
        workspace: dir,
        secretaryEnabled: false,
        secretaryAutoRestore: true,
        secretaryBootstrapFile: stateFile,
      })
      const reports: string[] = []
      const runtime = new SecretaryRuntime(config, line => reports.push(line))
      try {
        expect(await runtime.start()).toBeUndefined()
        expect(reports.some(line => line.includes('bootstrap restore failed'))).toBe(true)
      } finally {
        await runtime.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('initializes a shadow repo/runtime/state and maps the current scope in-process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-runtime-init-'))
    const source = join(dir, 'source')
    const shared = join(dir, 'shared')
    const stateFile = join(dir, 'she-bootstrap.json')
    const passwordFile = join(dir, 'opencode-service.json')
    writeFileSync(passwordFile, '{"password":"test"}', { mode: 0o600 })
    try {
      execFileSync('git', ['init', '-q', source])
      writeFileSync(join(source, 'README.md'), 'hello\n')
      execFileSync('git', ['-C', source, 'add', 'README.md'])
      execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'])
      const config = resolveConfig({
        appId: 'cli_test',
        appSecret: 'secret',
        workspace: source,
        secretaryEnabled: false,
        secretaryAutoRestore: true,
        secretaryBootstrapFile: stateFile,
        secretarySandboxRoot: shared,
        secretarySandboxOpencodeUrl: 'http://127.0.0.1:49375',
        secretarySandboxPasswordFile: passwordFile,
      })
      const runtime = new SecretaryRuntime(config, () => undefined, {
        setAcl: async () => undefined,
        setDefaultAcl: async () => undefined,
        probeOpenCode: async () => ({ ok: true, version: '2.3.2' }),
      })
      try {
        const init = await runtime.init({ scopeKey: 'scope-a', workspacePath: source, repoName: 'demo' })
        expect(init.shadowRepo).toBe(join(shared, 'repos', 'demo'))
        expect(init.healthVersion).toBe('2.3.2')
        expect(runtime.workspaceFor('scope-a')).toBe(init.shadowRepo)
        const state = await readBootstrapState(stateFile)
        expect(state?.scopes['scope-a']?.sourceRepo).toBe(init.sourceRepo)
        expect(state?.scopes['scope-a']?.shadowRepo).toBe(init.shadowRepo)
        const doctor = await runtime.doctor('scope-a')
        expect(doctor).toMatchObject({ ready: true, source: 'bootstrap', health: { ok: true, version: '2.3.2' } })
        expect(doctor.currentScopeShadowRepo).toBe(init.shadowRepo)
      } finally {
        await runtime.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
