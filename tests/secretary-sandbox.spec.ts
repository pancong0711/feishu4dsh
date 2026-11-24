import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SANDBOX_AGENT_PROFILES, SANDBOX_TOOL_BUNDLES, SandboxError, buildSandboxPackage,
  buildSandboxSpec, inspectSandboxHost, isValidDockerImageRef, isValidSandboxName,
} from '../src/secretary/sandbox.js'

describe('SHE sandbox catalog and spec (R61)', () => {
  it('includes the built-in agent slots and tool bundles', () => {
    expect(SANDBOX_AGENT_PROFILES.map(profile => profile.id)).toEqual([
      'opencode', 'hermes', 'deepseek-harness', 'blank', 'custom',
    ])
    for (const id of ['core', 'node', 'python', 'build', 'data', 'search']) {
      expect(SANDBOX_TOOL_BUNDLES.some(bundle => bundle.id === id)).toBe(true)
    }
    expect(isValidSandboxName('sbx-demo')).toBe(true)
    expect(isValidSandboxName('../escape')).toBe(false)
    expect(isValidDockerImageRef('registry.example.com/team/agent@sha256:abc123')).toBe(true)
    expect(isValidDockerImageRef('alpine\nRUN touch /pwned')).toBe(false)
    expect(isValidDockerImageRef('--privileged')).toBe(false)
  })

  it('builds a fixed-path, closed-by-default sandbox spec', () => {
    const spec = buildSandboxSpec({
      name: 'demo-sbx',
      targetKind: 'dedicated-user',
      currentUser: 'alice',
      dedicatedUser: 'feishu4dsh-sandbox',
      agentId: 'opencode',
      tools: ['core', 'node', 'python', 'core'],
      now: 1_700_000_000_000,
      id: 'sandbox-test',
    })
    expect(spec.target).toEqual({ kind: 'dedicated-user', user: 'feishu4dsh-sandbox', requiresRootBootstrap: true })
    expect(spec.paths.root).toBe('$HOME/.local/share/feishu4dsh/sandboxes/demo-sbx')
    expect(spec.paths.workspace).toBe('$HOME/.local/share/feishu4dsh/sandboxes/demo-sbx/workspace')
    expect(spec.paths.containerWorkspace).toBe('/workspace')
    expect(spec.paths.inbox).toBe('$HOME/.local/share/feishu4dsh/sandboxes/demo-sbx/inbox')
    expect(spec.paths.outbox).toBe('$HOME/.local/share/feishu4dsh/sandboxes/demo-sbx/outbox')
    expect(spec.paths.containerInbox).toBe('/inbox')
    expect(spec.paths.containerOutbox).toBe('/outbox')
    expect(spec.role).toBe('standalone')
    expect(spec.mailbox.allowedCallers).toEqual(['main'])
    expect(spec.container.name).toBe('feishu4dsh-demo-sbx')
    expect(spec.security).toMatchObject({
      readOnlyRootfs: true,
      capDrop: ['ALL'],
      noNewPrivileges: true,
      noDockerSocket: true,
      noPrivileged: true,
      networkMode: 'egress',
    })
    expect(spec.tools).toEqual(['core', 'node', 'python'])
  })

  it('requires an explicit image for custom/Hermes/dsh slots and rejects path injection', () => {
    expect(() => buildSandboxSpec({
      currentUser: 'alice', agentId: 'custom',
    })).toThrow(SandboxError)
    const custom = buildSandboxSpec({
      currentUser: 'alice', agentId: 'custom', customImage: 'registry.example.com/team/agent:1.2.3',
    })
    expect(custom.agent.sourceImage).toBe('registry.example.com/team/agent:1.2.3')
    expect(() => buildSandboxSpec({
      currentUser: 'alice', agentId: 'custom', customImage: 'image\nRUN evil',
    })).toThrow(/unsupported characters/)
    expect(() => buildSandboxSpec({
      currentUser: 'alice', targetKind: 'dedicated-user', dedicatedUser: 'bad user', agentId: 'blank',
    })).toThrow(/invalid dedicated sandbox user/)
  })
})

describe('SHE sandbox host preflight (R61)', () => {
  it('is read-only and reports Docker/rootless/dedicated-user state', async () => {
    const calls: string[][] = []
    const report = await inspectSandboxHost('feishu4dsh-sandbox', {
      currentUser: 'alice',
      run: async (command, args) => {
        calls.push([command, ...args])
        if (command === 'docker' && args[0] === '--version') return { ok: true, stdout: 'Docker version 27' }
        if (command === 'docker' && args[0] === 'info' && args[1] === '--format' && args[2] === '{{.ServerVersion}}') {
          return { ok: true, stdout: '27.0.0' }
        }
        if (command === 'docker' && args[0] === 'info') return { ok: true, stdout: '["name=seccomp","name=rootless"]' }
        if (command === 'id') return { ok: true, stdout: '1001' }
        if (command === 'grep') return { ok: true, stdout: 'feishu4dsh-sandbox:100000:65536' }
        if (command === 'loginctl') return { ok: true, stdout: 'Linger=yes' }
        return { ok: false, detail: 'not used by this test' }
      },
    })
    expect(report.currentUser).toBe('alice')
    expect(report.currentDockerReady).toBe(true)
    expect(report.rootlessDocker).toBe(true)
    expect(report.checks.some(check => check.id === 'rootless-docker' && check.status === 'ok')).toBe(true)
    expect(calls.every(parts => parts[0] !== 'sudo')).toBe(true)
    expect(calls.some(parts => parts[0] === 'docker' && parts.includes('run'))).toBe(false)
  })
})

describe('SHE sandbox package (R61)', () => {
  it('emits a secret-free package with exact-mount, read-only container scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-sandbox-'))
    try {
      const spec = buildSandboxSpec({
        name: 'demo-sbx',
        targetKind: 'dedicated-user',
        currentUser: 'alice',
        dedicatedUser: 'feishu4dsh-sandbox',
        agentId: 'opencode',
        tools: ['core', 'node', 'python'],
        now: 1_700_000_000_000,
        id: 'sandbox-test',
      })
      const pkg = await buildSandboxPackage({ spec, outputRoot: dir })
      for (const file of [
        'README.md', 'plan.json', 'host-preflight.sh', 'bootstrap-host.sh',
        'create-sandbox.sh', 'verify-sandbox.sh', 'destroy-sandbox.sh', 'Dockerfile', 'CHECKSUMS',
      ]) {
        expect(existsSync(join(pkg.packageDir, file))).toBe(true)
      }
      expect(statSync(pkg.archivePath).size).toBeGreaterThan(0)
      expect(pkg.archiveBytes.byteLength).toBeGreaterThan(0)
      const create = readFileSync(join(pkg.packageDir, 'create-sandbox.sh'), 'utf8')
      expect(create).toContain('--read-only')
      expect(create).toContain('--cap-drop ALL')
      expect(create).toContain('no-new-privileges:true')
      expect(create).toContain('src=$WORKSPACE,dst=/workspace')
      expect(create).toContain('src=$AGENT_HOME,dst=/home/agent')
      expect(create).toContain('src=$INBOX,dst=/inbox,ro')
      expect(create).toContain('src=$OUTBOX,dst=/outbox,rw')
      expect(create).toContain('src=$CACHE,dst=/home/agent/.cache')
      expect(create).toContain('NPM_CONFIG_PREFIX=/home/agent/.npm-global')
      expect(create).not.toContain('docker.sock')
      const verify = readFileSync(join(pkg.packageDir, 'verify-sandbox.sh'), 'utf8')
      expect(verify).toContain('docker.sock')
      expect(verify).toContain('root filesystem write denied')
      expect(verify).toContain('no extra capabilities')
      expect(verify).toContain('host PID namespace not used')
      expect(verify).toContain('host IPC namespace not used')
      expect(verify).toContain('no host devices')
      const plan = JSON.parse(readFileSync(join(pkg.packageDir, 'plan.json'), 'utf8')) as Record<string, unknown>
      expect(JSON.stringify(plan)).toContain('$HOME/.local/share/feishu4dsh/sandboxes/demo-sbx')
      expect(JSON.stringify(plan)).not.toContain('bot2603')
      expect(JSON.stringify(plan).toLowerCase()).not.toContain('apikey')
      // Shell syntax is part of the delivery contract.
      for (const script of ['host-preflight.sh', 'bootstrap-host.sh', 'create-sandbox.sh', 'verify-sandbox.sh', 'destroy-sandbox.sh']) {
        execFileSync('bash', ['-n', join(pkg.packageDir, script)])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('sandbox onboarding scripts (R61)', () => {
  it('keeps the repository preflight/bootstrap scripts syntactically valid and JSON-readable', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    for (const script of ['scripts/sandbox-preflight.sh', 'scripts/sandbox-bootstrap-host.sh']) {
      execFileSync('bash', ['-n', join(root, script)])
    }
    const output = execFileSync('bash', [join(root, 'scripts/sandbox-preflight.sh'), '--json'], { encoding: 'utf8' })
    const parsed = JSON.parse(output) as { sandboxUser: string; checks: { id: string; status: string }[] }
    expect(parsed.sandboxUser).toBe('feishu4dsh-sandbox')
    expect(parsed.checks.length).toBeGreaterThan(5)
    expect(parsed.checks[0]?.id).toBe('current user')
  })
})
