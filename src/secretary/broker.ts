/**
 * Host-side sandbox broker domain model.
 *
 * The broker owns the rootless Docker control surface. Agents never receive a
 * Docker socket; they call narrow broker methods for status, lifecycle and
 * inbox/outbox routing. This module is transport-agnostic and injectable so
 * policy/registry behaviour can be tested without Docker.
 * @module feishu4dsh/secretary/broker
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nextSandboxName, type SandboxRole, type SandboxSpec } from './sandbox.js'

const execFileAsync = promisify(execFile)

export const BROKER_SCHEMA = 1
export const BROKER_DATA_ROOT_TEMPLATE = '$HOME/.local/share/feishu4dsh/broker'
export const BROKER_REGISTRY_FILE = 'registry.json'
export const BROKER_AUDIT_FILE = 'audit.jsonl'
export const BROKER_SOCKET_FILE = 'broker.sock'

export interface BrokerActor {
  readonly id: string
  readonly kind: 'control-plane' | 'sandbox'
  readonly role: SandboxRole
  readonly createdAt: string
}

export interface BrokerSandboxRecord {
  readonly name: string
  readonly role: SandboxRole
  readonly containerName: string
  readonly networkName: string
  readonly root: string
  readonly workspace: string
  readonly inbox: string
  readonly outbox: string
  readonly descriptor: string
  readonly allowedCallers: readonly string[]
  readonly allowedTargets: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly spec: SandboxSpec
}

export interface BrokerRegistry {
  readonly schema: 1
  mainActorId?: string
  readonly actors: readonly BrokerActor[]
  readonly sandboxes: readonly BrokerSandboxRecord[]
  readonly updatedAt: string
}

export type BrokerSandboxView = BrokerSandboxRecord & { status: BrokerDockerStatus }

export interface BrokerDockerStatus {
  readonly state: 'running' | 'stopped' | 'missing' | 'unknown'
  readonly startedAt?: string
  readonly detail?: string
}

export interface BrokerDockerStats {
  readonly cpuPercent?: string
  readonly memoryUsage?: string
  readonly memoryLimit?: string
  readonly pids?: string
  readonly networkRx?: string
  readonly networkTx?: string
  readonly blockRead?: string
  readonly blockWrite?: string
  readonly sampledAt: string
}

export interface BrokerDockerRuntime {
  inspect(containerName: string): Promise<BrokerDockerStatus>
  stats(containerName: string): Promise<BrokerDockerStats>
  start(containerName: string): Promise<void>
  stop(containerName: string): Promise<void>
  restart(containerName: string): Promise<void>
  removeContainer(containerName: string): Promise<void>
  removeNetwork(networkName: string): Promise<void>
}

export interface BrokerMessageArtifact {
  /** Relative destination path inside the target inbox input directory. */
  readonly path: string
  /** Source file relative to the sender sandbox outbox. */
  readonly fromOutbox?: string
  /** Inline UTF-8 text; intended for small control messages only. */
  readonly text?: string
  /** Inline base64 content; intended for small files only. */
  readonly base64?: string
}

export interface BrokerSendMessageInput {
  readonly from: string
  readonly to: string
  readonly rootTaskId: string
  readonly parentTaskId?: string
  readonly messageId?: string
  readonly ttlSeconds?: number
  readonly artifacts?: readonly BrokerMessageArtifact[]
}

export interface BrokerMessageResult {
  readonly messageId: string
  readonly to: string
  readonly inbox: string
  readonly manifestPath: string
  readonly artifacts: number
}

export interface BrokerServiceOptions {
  readonly registryPath: string
  readonly docker: BrokerDockerRuntime
  readonly mainActorId?: string
  readonly now?: () => number
}

export class BrokerError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'message_exists'
      | 'path_escape'
      | 'too_large'
      | 'docker_failed',
    message: string,
  ) {
    super(message)
    this.name = 'BrokerError'
  }
}

export function defaultBrokerRegistryPath(): string {
  return join(homedir(), '.local', 'share', 'feishu4dsh', 'broker', BROKER_REGISTRY_FILE)
}

export function defaultMainActorId(): string {
  const user = userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '-')
  const host = hostname().replace(/[^a-zA-Z0-9._-]/g, '-')
  return `main:${host}:${user}`
}

function emptyRegistry(now = Date.now()): BrokerRegistry {
  return { schema: 1, actors: [], sandboxes: [], updatedAt: new Date(now).toISOString() }
}

function actorIdForSandbox(name: string): string {
  return `sandbox:${name}`
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function asAbsolute(path: string): string {
  return resolve(expandHome(path))
}

function assertSafeRelative(value: string, label: string): string {
  if (value.trim() === '' || isAbsolute(value)) throw new BrokerError('path_escape', `${label} must be relative`)
  const normalized = value.replace(/\\/g, '/')
  const pieces = normalized.split('/')
  if (pieces.some(piece => piece === '..' || piece === '')) throw new BrokerError('path_escape', `${label} contains an unsafe segment`)
  return pieces.join('/')
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}

async function pathIsInside(parent: string, child: string): Promise<boolean> {
  const [root, target] = await Promise.all([realpath(parent), realpath(child)])
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Atomic JSON registry on the target account's fixed XDG path. */
export class BrokerRegistryStore {
  constructor(readonly path: string) {}

  async load(): Promise<BrokerRegistry> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<BrokerRegistry>
      if (parsed.schema !== 1 || !Array.isArray(parsed.actors) || !Array.isArray(parsed.sandboxes)) {
        throw new BrokerError('invalid_request', `broker registry is invalid: ${this.path}`)
      }
      return {
        schema: 1,
        ...(typeof parsed.mainActorId === 'string' && parsed.mainActorId !== '' ? { mainActorId: parsed.mainActorId } : {}),
        actors: parsed.actors,
        sandboxes: parsed.sandboxes,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
      throw error instanceof BrokerError
        ? error
        : new BrokerError('invalid_request', `cannot read broker registry ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async save(registry: BrokerRegistry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.path)
  }
}

/**
 * Policy-enforcing broker service. No method here accepts arbitrary Docker
 * flags or arbitrary host paths.
 */
export class SandboxBrokerService {
  private registry: BrokerRegistry
  private readonly now: () => number
  private readonly mainActorId: string
  private readonly store: BrokerRegistryStore

  constructor(private readonly options: BrokerServiceOptions) {
    this.now = options.now ?? (() => Date.now())
    this.mainActorId = options.mainActorId ?? defaultMainActorId()
    this.store = new BrokerRegistryStore(options.registryPath)
    this.registry = emptyRegistry(this.now())
  }

  async init(): Promise<void> {
    this.registry = await this.store.load()
    await this.setMainActor(this.mainActorId)
  }

  get mainId(): string {
    return this.mainActorId
  }

  get registryView(): BrokerRegistry {
    return this.registry
  }

  async setMainActor(actorId = this.mainActorId): Promise<BrokerActor> {
    if (!/^[a-z0-9][a-zA-Z0-9:._-]{0,127}$/.test(actorId)) throw new BrokerError('invalid_request', 'invalid main actor id')
    const now = new Date(this.now()).toISOString()
    const existing = this.registry.actors.find(actor => actor.id === actorId)
    const actor: BrokerActor = existing === undefined
      ? { id: actorId, kind: 'control-plane', role: 'main', createdAt: now }
      : { ...existing, kind: 'control-plane', role: 'main', createdAt: existing.createdAt }
    const actors = this.registry.actors.filter(item => item.id !== actorId).concat(actor)
    this.registry = { ...this.registry, mainActorId: actorId, actors, updatedAt: now }
    await this.store.save(this.registry)
    await this.audit('main.register', { actorId })
    return actor
  }

  async nextName(suffix?: string): Promise<string> {
    return nextSandboxName(this.registry.sandboxes.map(item => item.name), suffix)
  }

  async registerSandbox(input: SandboxSpec): Promise<BrokerSandboxRecord> {
    const existing = this.registry.sandboxes.find(item => item.name === input.name)
    if (existing !== undefined) throw new BrokerError('conflict', `sandbox already registered: ${input.name}`)
    // Accept descriptors produced before R69 but normalize them to the current
    // role/mailbox/path contract. Old descriptors never gain write access to
    // another sandbox: they default to one-way main -> sandbox delivery.
    const role = input.role ?? 'standalone'
    const mailbox = input.mailbox ?? { allowedCallers: ['main'], allowedTargets: [] }
    const spec: SandboxSpec = {
      ...input,
      role,
      mailbox,
      paths: {
        ...input.paths,
        inbox: input.paths.inbox ?? `${input.paths.root}/inbox`,
        outbox: input.paths.outbox ?? `${input.paths.root}/outbox`,
        containerInbox: input.paths.containerInbox ?? '/inbox',
        containerOutbox: input.paths.containerOutbox ?? '/outbox',
      },
    }
    const root = asAbsolute(spec.paths.root)
    const record: BrokerSandboxRecord = {
      name: spec.name,
      role,
      containerName: spec.container.name,
      networkName: spec.container.networkName,
      root,
      workspace: asAbsolute(spec.paths.workspace),
      inbox: asAbsolute(spec.paths.inbox),
      outbox: asAbsolute(spec.paths.outbox),
      descriptor: asAbsolute(spec.paths.descriptor),
      allowedCallers: mailbox.allowedCallers,
      allowedTargets: mailbox.allowedTargets,
      createdAt: spec.createdAt,
      updatedAt: new Date(this.now()).toISOString(),
      spec,
    }
    await Promise.all([
      mkdir(record.root, { recursive: true, mode: 0o700 }),
      mkdir(record.workspace, { recursive: true, mode: 0o700 }),
      mkdir(record.inbox, { recursive: true, mode: 0o700 }),
      mkdir(record.outbox, { recursive: true, mode: 0o700 }),
    ])
    const sandboxActor: BrokerActor = {
      id: actorIdForSandbox(spec.name),
      kind: 'sandbox',
      role: spec.role,
      createdAt: record.createdAt,
    }
    const now = new Date(this.now()).toISOString()
    this.registry = {
      schema: 1,
      ...(this.registry.mainActorId === undefined ? {} : { mainActorId: this.registry.mainActorId }),
      actors: this.registry.actors.filter(actor => actor.id !== sandboxActor.id).concat(sandboxActor),
      sandboxes: this.registry.sandboxes.concat(record),
      updatedAt: now,
    }
    await this.store.save(this.registry)
    await this.audit('sandbox.register', { name: record.name, role: record.role })
    return record
  }

  async registerDescriptor(path: string): Promise<BrokerSandboxRecord> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      throw new BrokerError('not_found', `cannot read descriptor ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BrokerError('invalid_request', `descriptor is not JSON: ${path}`)
    }
    const plan = parsed as { schema?: unknown; spec?: unknown }
    if (plan.schema !== 1 || typeof plan.spec !== 'object' || plan.spec === null) {
      throw new BrokerError('invalid_request', 'descriptor must be a schema=1 plan with spec')
    }
    return this.registerSandbox(plan.spec as SandboxSpec)
  }

  async list(): Promise<readonly (BrokerSandboxRecord & { status: BrokerDockerStatus })[]> {
    const result: (BrokerSandboxRecord & { status: BrokerDockerStatus })[] = []
    for (const record of this.registry.sandboxes) {
      result.push({ ...record, status: await this.safeInspect(record.containerName) })
    }
    return result
  }

  async info(name: string): Promise<(BrokerSandboxRecord & { status: BrokerDockerStatus }) | undefined> {
    const record = this.findSandbox(name)
    if (record === undefined) return undefined
    return { ...record, status: await this.safeInspect(record.containerName) }
  }

  async stats(name: string): Promise<BrokerDockerStats> {
    const record = this.findSandbox(name)
    if (record === undefined) throw new BrokerError('not_found', `sandbox not found: ${name}`)
    try {
      return await this.options.docker.stats(record.containerName)
    } catch (error) {
      throw new BrokerError('docker_failed', `docker stats failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async start(name: string): Promise<void> {
    const record = this.requireSandbox(name)
    await this.runDocker(() => this.options.docker.start(record.containerName), `start ${name}`)
    await this.audit('sandbox.start', { name })
  }

  async stop(name: string): Promise<void> {
    const record = this.requireSandbox(name)
    await this.runDocker(() => this.options.docker.stop(record.containerName), `stop ${name}`)
    await this.audit('sandbox.stop', { name })
  }

  async restart(name: string): Promise<void> {
    const record = this.requireSandbox(name)
    await this.runDocker(() => this.options.docker.restart(record.containerName), `restart ${name}`)
    await this.audit('sandbox.restart', { name })
  }

  /** Remove runtime objects only; persistent sandbox data is retained. */
  async destroy(name: string): Promise<void> {
    const record = this.requireSandbox(name)
    await this.runDocker(async () => {
      await this.options.docker.removeContainer(record.containerName)
      await this.options.docker.removeNetwork(record.networkName)
    }, `destroy ${name}`)
    await this.audit('sandbox.destroy', { name, dataRetained: record.root })
  }

  /**
   * Broker-mediated mailbox delivery. The sender never receives a writable
   * host path: files come from its own outbox or inline small payloads, and
   * only the target inbox is written by the broker.
   */
  async sendMessage(input: BrokerSendMessageInput): Promise<BrokerMessageResult> {
    const target = this.findSandbox(input.to)
    if (target === undefined) throw new BrokerError('not_found', `target sandbox not found: ${input.to}`)
    if (input.from.trim() === '') throw new BrokerError('invalid_request', 'from is required')
    const main = this.registry.mainActorId === input.from || input.from === 'main'
    const source = this.findSandbox(input.from)
    if (!main && source === undefined) throw new BrokerError('forbidden', `sender is not a registered actor: ${input.from}`)
    const allowedByTarget = target.allowedCallers.includes('main')
      || target.allowedCallers.includes(input.from)
      || (this.registry.mainActorId !== undefined && target.allowedCallers.includes(this.registry.mainActorId))
    if (!allowedByTarget) throw new BrokerError('forbidden', `${input.from} may not send to ${input.to}`)
    if (!main && source !== undefined) {
      if (!source.allowedTargets.includes(target.name)) {
        throw new BrokerError('forbidden', `${source.name} has no handoff target ${target.name}`)
      }
    }
    if (typeof input.rootTaskId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(input.rootTaskId)) {
      throw new BrokerError('invalid_request', 'rootTaskId is invalid')
    }
    const messageId = input.messageId ?? `msg-${this.now().toString(36)}-${randomUUID().slice(0, 8)}`
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(messageId)) throw new BrokerError('invalid_request', 'messageId is invalid')
    const targetDir = join(target.inbox, messageId)
    try {
      await stat(targetDir)
      throw new BrokerError('message_exists', `message already exists: ${messageId}`)
    } catch (error) {
      if (error instanceof BrokerError) throw error
    }
    await mkdir(target.inbox, { recursive: true, mode: 0o700 })
    const tempDir = join(target.inbox, `.tmp-${randomUUID()}`)
    await mkdir(tempDir, { recursive: true, mode: 0o700 })
    const artifacts: { path: string; sha256: string; bytes: number }[] = []
    try {
      for (const artifact of input.artifacts ?? []) {
        const path = assertSafeRelative(artifact.path, 'artifact.path')
        let bytes: Buffer
        if (artifact.fromOutbox !== undefined) {
          if (source === undefined) throw new BrokerError('forbidden', 'fromOutbox is only allowed for a registered sandbox')
          const sourcePath = resolve(source.outbox, artifact.fromOutbox)
          if (!(await pathIsInside(source.outbox, sourcePath))) throw new BrokerError('path_escape', 'fromOutbox escapes sender outbox')
          bytes = await readFile(sourcePath)
        } else if (artifact.base64 !== undefined) {
          bytes = Buffer.from(artifact.base64, 'base64')
        } else if (artifact.text !== undefined) {
          bytes = Buffer.from(artifact.text, 'utf8')
        } else {
          throw new BrokerError('invalid_request', 'artifact needs fromOutbox, text or base64')
        }
        if (bytes.byteLength > 16 * 1024 * 1024) throw new BrokerError('too_large', `artifact too large: ${path}`)
        const targetPath = join(tempDir, 'input', path)
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
        await writeFile(targetPath, bytes, { mode: 0o600 })
        artifacts.push({ path: `input/${path}`, sha256: await sha256Bytes(bytes), bytes: bytes.byteLength })
      }
      const ttl = Math.max(60, Math.min(7 * 24 * 3600, Math.floor(input.ttlSeconds ?? 3600)))
      const manifest = {
        schema: 1,
        messageId,
        from: input.from,
        to: target.name,
        rootTaskId: input.rootTaskId,
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        role: target.role,
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + ttl * 1000).toISOString(),
        artifacts,
      }
      const manifestPath = join(tempDir, 'manifest.json')
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await rename(tempDir, targetDir)
      await this.audit('message.deliver', { messageId, from: input.from, to: target.name, artifacts: artifacts.length })
      return { messageId, to: target.name, inbox: target.inbox, manifestPath: join(targetDir, 'manifest.json'), artifacts: artifacts.length }
    } catch (error) {
      await import('node:fs/promises').then(fs => fs.rm(tempDir, { recursive: true, force: true })).catch(() => undefined)
      throw error
    }
  }

  private findSandbox(name: string): BrokerSandboxRecord | undefined {
    return this.registry.sandboxes.find(item => item.name === name)
  }

  private requireSandbox(name: string): BrokerSandboxRecord {
    const record = this.findSandbox(name)
    if (record === undefined) throw new BrokerError('not_found', `sandbox not found: ${name}`)
    return record
  }

  private async safeInspect(containerName: string): Promise<BrokerDockerStatus> {
    try {
      return await this.options.docker.inspect(containerName)
    } catch (error) {
      return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
    }
  }

  private async runDocker(action: () => Promise<void>, label: string): Promise<void> {
    try {
      await action()
    } catch (error) {
      throw new BrokerError('docker_failed', `${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async audit(action: string, detail: Record<string, unknown>): Promise<void> {
    const path = join(dirname(this.options.registryPath), BROKER_AUDIT_FILE)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify({ at: new Date(this.now()).toISOString(), action, ...detail })}\n`, { mode: 0o600 })
  }
}

/** Docker CLI adapter used by the host broker process. */
export function createDockerCliRuntime(): BrokerDockerRuntime {
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 15_000, encoding: 'utf8' })
    return stdout.trim()
  }
  return {
    async inspect(containerName) {
      try {
        const running = await run(['inspect', '-f', '{{.State.Running}}', containerName])
        const startedAt = await run(['inspect', '-f', '{{.State.StartedAt}}', containerName]).catch(() => '')
        return { state: running === 'true' ? 'running' : 'stopped', ...(startedAt === '' ? {} : { startedAt }) }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return detail.includes('No such object') || detail.includes('No such container')
          ? { state: 'missing', detail }
          : { state: 'unknown', detail }
      }
    },
    async stats(containerName) {
      const raw = await run(['stats', '--no-stream', '--format', '{{json .}}', containerName])
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return {
        ...(typeof parsed.CPUPerc === 'string' ? { cpuPercent: parsed.CPUPerc } : {}),
        ...(typeof parsed.MemUsage === 'string' ? { memoryUsage: parsed.MemUsage } : {}),
        ...(typeof parsed.MemPerc === 'string' ? { memoryLimit: parsed.MemPerc } : {}),
        ...(typeof parsed.PIDs === 'string' ? { pids: parsed.PIDs } : {}),
        ...(typeof parsed.NetIO === 'string' ? { networkRx: parsed.NetIO } : {}),
        ...(typeof parsed.BlockIO === 'string' ? { blockRead: parsed.BlockIO } : {}),
        sampledAt: new Date().toISOString(),
      }
    },
    async start(containerName) { await run(['start', containerName]) },
    async stop(containerName) { await run(['stop', containerName]) },
    async restart(containerName) { await run(['restart', containerName]) },
    async removeContainer(containerName) { await run(['rm', '-f', containerName]) },
    async removeNetwork(networkName) { await run(['network', 'rm', networkName]) },
  }
}
