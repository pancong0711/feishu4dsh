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
        const init = await runtime.init({ scopeKey: 'scope-a', workspacePath: source })
        expect(init.shadowRepo).toBe(join(shared, 'repos', 'source-shadow-repo'))
        expect(init.healthVersion).toBe('2.3.2')
        expect(runtime.workspaceFor('scope-a')).toBe(init.shadowRepo)
        await expect(runtime.init({ scopeKey: 'scope-a', workspacePath: source })).rejects.toThrow(/already initialized/)
        const updated = await runtime.update({ scopeKey: 'scope-a' })
        expect(updated.shadowRepo).toBe(init.shadowRepo)
        const state = await readBootstrapState(stateFile)
        expect(state?.scopes['scope-a']?.sourceRepo).toBe(init.sourceRepo)
        expect(state?.scopes['scope-a']?.shadowRepo).toBe(init.shadowRepo)
        const doctor = await runtime.doctor('scope-a')
        expect(doctor).toMatchObject({ ready: true, source: 'bootstrap', health: { ok: true, version: '2.3.2' } })
        expect(doctor.currentScopeShadowRepo).toBe(init.shadowRepo)
        const reset = await runtime.reset({ scopeKey: 'scope-a' })
        expect(reset.shadowRepo).toBe(init.shadowRepo)
        expect(runtime.workspaceFor('scope-a')).toBeUndefined()
      } finally {
        await runtime.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports service location/autostart without mutating systemd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-service-'))
    try {
      const config = resolveConfig({ appId: 'cli_test', appSecret: 'secret', workspace: dir })
      const calls: string[] = []
      const runtime = new SecretaryRuntime(config, () => undefined, {
        probeSystemdUserBus: async () => true,
        inspectLinger: async () => true,
        inspectServiceUnit: async unit => {
          calls.push(unit)
          return unit === 'dsh-feishu4dsh.service'
            ? { fragmentPath: '/home/alice/.config/systemd/user/dsh-feishu4dsh.service', loadState: 'loaded', unitFileState: 'enabled', activeState: 'active' }
            : { loadState: 'not-found', unitFileState: 'disabled', activeState: 'inactive' }
        },
      })
      const report = await runtime.serviceReport()
      expect(report).toMatchObject({
        systemdUserBusReachable: true,
        linger: true,
        installerPresent: true,
        units: [
          { name: 'dsh-feishu4dsh.service', role: 'channel', unitFileState: 'enabled', activeState: 'active' },
          { name: 'feishu4dsh-sandbox-broker.service', role: 'broker', loadState: 'not-found' },
        ],
      })
      expect(calls).toEqual(['dsh-feishu4dsh.service', 'feishu4dsh-sandbox-broker.service'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
