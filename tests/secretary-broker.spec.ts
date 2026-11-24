import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BrokerError, SandboxBrokerService, type BrokerDockerRuntime, type BrokerDockerStats,
} from '../src/secretary/broker.js'
import { SandboxBrokerClient } from '../src/secretary/broker-client.js'
import { listenBroker } from '../src/secretary/broker-server.js'
import { SandboxError, buildSandboxSpec, nextSandboxName, type SandboxSpec } from '../src/secretary/sandbox.js'

function tempSpec(dir: string, name: string, role: 'standalone' | 'main' | 'worker', allowedCallers: string[], allowedTargets: string[] = []): SandboxSpec {
  const base = buildSandboxSpec({
    name,
    targetKind: 'current-user',
    currentUser: 'alice',
    agentId: 'blank',
    tools: ['core'],
    role,
    allowedCallers,
    allowedTargets,
    now: 1_700_000_000_000,
    id: `id-${name}`,
  })
  const root = join(dir, 'sandboxes', name)
  return {
    ...base,
    paths: {
      ...base.paths,
      root,
      workspace: join(root, 'workspace'),
      inbox: join(root, 'inbox'),
      outbox: join(root, 'outbox'),
      home: join(root, 'home'),
      cache: join(root, 'cache'),
      logs: join(root, 'logs'),
      descriptor: join(root, 'sandbox.json'),
    },
  }
}

class FakeDocker implements BrokerDockerRuntime {
  readonly calls: string[] = []
  status: 'running' | 'stopped' | 'missing' = 'running'
  async inspect(name: string) { this.calls.push(`inspect:${name}`); return { state: this.status, startedAt: '2026-11-24T00:00:00Z' } }
  async stats(name: string): Promise<BrokerDockerStats> { this.calls.push(`stats:${name}`); return { cpuPercent: '1%', memoryUsage: '1MiB / 1GiB', pids: '2', sampledAt: 'now' } }
  async start(name: string) { this.calls.push(`start:${name}`) }
  async stop(name: string) { this.calls.push(`stop:${name}`) }
  async restart(name: string) { this.calls.push(`restart:${name}`) }
  async removeContainer(name: string) { this.calls.push(`remove:${name}`) }
  async removeNetwork(name: string) { this.calls.push(`network:${name}`) }
}

describe('sandbox naming and broker registry (R69)', () => {
  it('resolves sbx-<suffix> and numeric defaults without collisions', () => {
    expect(nextSandboxName([], undefined)).toBe('sbx-0001')
    expect(nextSandboxName(['sbx-0001'], undefined)).toBe('sbx-0002')
    expect(nextSandboxName([], 'dev')).toBe('sbx-dev')
    expect(nextSandboxName([], 'sbx-dev')).toBe('sbx-dev')
    expect(() => nextSandboxName(['sbx-dev'], 'dev')).toThrow(SandboxError)
    expect(() => nextSandboxName([], '../bad')).toThrow(SandboxError)
  })

  it('registers, reports and controls a sandbox with broker policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-reg-'))
    try {
      const docker = new FakeDocker()
      const service = new SandboxBrokerService({ registryPath: join(dir, 'broker', 'registry.json'), docker, mainActorId: 'main:test', now: () => 1_700_000_000_000 })
      await service.init()
      const spec = tempSpec(dir, 'sbx-0001', 'worker', ['main'])
      const record = await service.registerSandbox(spec)
      expect(record.role).toBe('worker')
      expect(record.inbox).toContain('/inbox')
      const listing = await service.list()
      expect(listing).toHaveLength(1)
      expect(listing[0]?.status.state).toBe('running')
      expect(await service.stats('sbx-0001')).toMatchObject({ cpuPercent: '1%' })
      await service.start('sbx-0001')
      await service.stop('sbx-0001')
      await service.restart('sbx-0001')
      await service.destroy('sbx-0001')
      expect(docker.calls).toContain('start:feishu4dsh-sbx-0001')
      expect(docker.calls).toContain('stop:feishu4dsh-sbx-0001')
      expect(docker.calls).toContain('restart:feishu4dsh-sbx-0001')
      expect(docker.calls).toContain('remove:feishu4dsh-sbx-0001')
      expect(service.registryView.sandboxes[0]?.name).toBe('sbx-0001')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes main and worker messages only through broker allowlists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-msg-'))
    try {
      const docker = new FakeDocker()
      const service = new SandboxBrokerService({ registryPath: join(dir, 'broker', 'registry.json'), docker, mainActorId: 'main:test', now: () => 1_700_000_000_000 })
      await service.init()
      const worker1 = await service.registerSandbox(tempSpec(dir, 'sbx-0001', 'worker', ['main'], ['sbx-0002']))
      const worker2 = await service.registerSandbox(tempSpec(dir, 'sbx-0002', 'worker', ['main', 'sbx-0001']))

      const first = await service.sendMessage({
        from: 'main:test',
        to: 'sbx-0001',
        rootTaskId: 'task-root',
        artifacts: [{ path: 'hello.txt', text: 'hello worker' }],
      })
      expect(first.artifacts).toBe(1)
      const manifest1 = JSON.parse(readFileSync(join(worker1.inbox, first.messageId, 'manifest.json'), 'utf8')) as { from: string; artifacts: { sha256: string }[] }
      expect(manifest1.from).toBe('main:test')
      expect(manifest1.artifacts[0]?.sha256).toHaveLength(64)
      expect(readFileSync(join(worker1.inbox, first.messageId, 'input', 'hello.txt'), 'utf8')).toBe('hello worker')

      writeFileSync(join(worker1.outbox, 'result.txt'), 'worker result')
      const second = await service.sendMessage({
        from: 'sbx-0001',
        to: 'sbx-0002',
        rootTaskId: 'task-root',
        parentTaskId: 'task-1',
        artifacts: [{ path: 'from-worker/result.txt', fromOutbox: 'result.txt' }],
      })
      expect(second.artifacts).toBe(1)
      expect(readFileSync(join(worker2.inbox, second.messageId, 'input', 'from-worker', 'result.txt'), 'utf8')).toBe('worker result')

      await expect(service.sendMessage({
        from: 'sbx-0002',
        to: 'sbx-0001',
        rootTaskId: 'task-root',
        artifacts: [{ path: 'x.txt', text: 'no' }],
      })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(service.sendMessage({
        from: 'main:test',
        to: 'sbx-0001',
        rootTaskId: 'task-root',
        artifacts: [{ path: '../escape.txt', text: 'no' }],
      })).rejects.toMatchObject({ code: 'path_escape' })
      await expect(service.sendMessage({
        from: 'sbx-0002',
        to: 'sbx-0001',
        rootTaskId: 'task-root',
        artifacts: [{ path: 'x.txt', fromOutbox: '../outside.txt' }],
      })).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves the broker over a Unix socket and accepts a client request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'broker-socket-'))
    const socket = join(dir, 'broker.sock')
    const docker = new FakeDocker()
    const service = new SandboxBrokerService({ registryPath: join(dir, 'broker', 'registry.json'), docker, mainActorId: 'main:test', now: () => 1_700_000_000_000 })
    await service.init()
    await service.registerSandbox(tempSpec(dir, 'sbx-0001', 'worker', ['main']))
    const server = await listenBroker(service, socket)
    try {
      const client = new SandboxBrokerClient({ socketPath: socket })
      expect(await client.health()).toMatchObject({ ok: true, schema: 1 })
      const list = await client.list() as { sandboxes: { name: string; status: { state: string } }[] }
      expect(list.sandboxes[0]).toMatchObject({ name: 'sbx-0001', status: { state: 'running' } })
      const result = await client.sendMessage('sbx-0001', {
        from: 'main:test', rootTaskId: 'task-socket', artifacts: [{ path: 'ping.txt', text: 'pong' }],
      }) as { message: { messageId: string } }
      expect(result.message.messageId).toMatch(/^msg-/)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
