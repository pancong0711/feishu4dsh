/**
 * `/she need`: read-only SHE attach-readiness checks (descriptor, password,
 * OpenCode health, runtime directories). R62 merged package generation into
 * `/she sandbox`; this module no longer emits Dockerfiles or install bundles.
 *
 * The channel-side username is always read from the running process; only the
 * dedicated sandbox user is a deployment constant (`opencode-she` by default).
 * This module never invokes sudo, Docker, or package managers.
 * @module feishu4dsh/secretary/need
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'

const execFileAsync = promisify(execFile)

export class SheNeedError extends Error {
  constructor(readonly code: 'descriptor_invalid', message: string) {
    super(message)
    this.name = 'SheNeedError'
  }
}

export interface SandboxDescriptor {
  readonly schema: 1
  readonly deploymentId?: string
  readonly service: {
    readonly url: string
    readonly username: string
    readonly passwordFile: string
  }
  readonly runtime: {
    readonly root: string
    readonly worktreeRoot: string
    readonly reposRoot: string
  }
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly container?: {
    readonly name?: string
    readonly image?: string
    readonly port?: number
  }
  readonly updatedAt?: string
}

export type SheNeedLevel = 'channel-user'|'host-root'|'sandbox-user'|'runtime'
export type SheNeedStatus = 'ok'|'missing'|'blocked'|'unknown'

export interface SheNeedItem {
  readonly id: string
  readonly label: string
  readonly level: SheNeedLevel
  readonly status: SheNeedStatus
  readonly detail: string
}

export interface SheNeedReport {
  readonly schema: 1
  readonly deploymentId: string
  readonly createdAt: string
  readonly channelUser: string
  readonly sandboxUser: string
  readonly sharedRoot: string
  readonly descriptorPath: string
  readonly opencodeUrl: string
  readonly passwordFile: string
  readonly items: readonly SheNeedItem[]
  readonly ready: boolean
}

export interface SheNeedProbeDeps {
  readonly channelUser?: string
  readonly probeOpenCode?: (url: string, username: string, credential: string) => Promise<{ ok: boolean; version?: string; detail?: string }>
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]')
  } catch {
    return false
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export async function readSandboxDescriptor(path: string): Promise<SandboxDescriptor | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SheNeedError('descriptor_invalid', `cannot read descriptor ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SheNeedError('descriptor_invalid', `descriptor ${path} is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null) throw new SheNeedError('descriptor_invalid', 'descriptor is not an object')
  const doc = value as Record<string, unknown>
  const service = doc.service as Record<string, unknown> | undefined
  const runtime = doc.runtime as Record<string, unknown> | undefined
  const model = doc.model as Record<string, unknown> | undefined
  if (doc.schema !== 1 || service === undefined || runtime === undefined || model === undefined) {
    throw new SheNeedError('descriptor_invalid', 'descriptor schema/service/runtime/model is invalid')
  }
  if (!nonEmpty(service.url) || !isLoopbackUrl(service.url)
    || !nonEmpty(service.username) || !nonEmpty(service.passwordFile) || !isAbsolute(service.passwordFile)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor service.url/username/passwordFile is invalid')
  }
  if (!nonEmpty(runtime.root) || !nonEmpty(runtime.worktreeRoot) || !nonEmpty(runtime.reposRoot)
    || !isAbsolute(runtime.root) || !isAbsolute(runtime.worktreeRoot) || !isAbsolute(runtime.reposRoot)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor runtime paths must be absolute')
  }
  if (!nonEmpty(model.providerID) || !nonEmpty(model.id)) {
    throw new SheNeedError('descriptor_invalid', 'descriptor model.providerID/id is invalid')
  }
  return {
    schema: 1,
    ...(nonEmpty(doc.deploymentId) ? { deploymentId: doc.deploymentId } : {}),
    service: {
      url: (service.url as string).replace(/\/+$/, ''),
      username: service.username as string,
      passwordFile: service.passwordFile as string,
    },
    runtime: {
      root: runtime.root as string,
      worktreeRoot: runtime.worktreeRoot as string,
      reposRoot: runtime.reposRoot as string,
    },
    model: {
      providerID: model.providerID as string,
      id: model.id as string,
      ...(nonEmpty(model.variant) ? { variant: model.variant } : {}),
    },
    ...(doc.updatedAt !== undefined ? { updatedAt: String(doc.updatedAt) } : {}),
  }
}

async function readCredentialFile(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { password?: unknown }
    const credential = parsed.password
    return nonEmpty(credential) ? credential : undefined
  } catch {
    return undefined
  }
}

export async function probeOpenCode(
  url: string,
  username: string,
  credential: string,
): Promise<{ ok: boolean; version?: string; detail?: string }> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/info`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' && body.version !== ''
      ? { ok: true, version: body.version }
      : { ok: false, detail: 'response has no version' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, 2)
    return true
  } catch {
    return false
  }
}

async function commandWorks(command: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { maxBuffer: 1024 * 1024, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** Read-only detection. No sudo, Docker socket access, or user switching. */
export async function inspectSheNeed(config: ResolvedConfig, deps: SheNeedProbeDeps = {}): Promise<SheNeedReport> {
  const channelUser = deps.channelUser ?? userInfo().username
  const sandboxUser = config.secretarySandboxUser
  const sharedRoot = resolve(config.secretarySandboxRoot)
  const descriptorPath = resolve(config.secretarySandboxDescriptor)
  const opencodeUrl = config.secretarySandboxOpencodeUrl
  const passwordFile = resolve(config.secretarySandboxPasswordFile)
  const items: SheNeedItem[] = []

  items.push({ id: 'channel-user', label: '频道侧用户', level: 'channel-user', status: 'ok', detail: channelUser })
  items.push({
    id: 'shared-root', label: '共享 worktrees 根', level: 'channel-user',
    status: await writable(sharedRoot) ? 'ok' : 'missing',
    detail: sharedRoot,
  })

  const sandboxUid = await commandWorks('id', ['-u', sandboxUser])
  items.push({
    id: 'sandbox-user', label: '沙箱用户', level: 'host-root',
    status: sandboxUid === undefined ? 'missing' : 'ok',
    detail: sandboxUid === undefined ? `${sandboxUser} 不存在` : `${sandboxUser} uid=${sandboxUid}`,
  })
  if (sandboxUid !== undefined) {
    const subuid = await commandWorks('grep', ['-s', `^${sandboxUser}:`, '/etc/subuid'])
    items.push({ id: 'subuid', label: 'subuid 映射', level: 'host-root', status: subuid === undefined ? 'missing' : 'ok', detail: subuid ?? `缺少 /etc/subuid:${sandboxUser}` })
    const subgid = await commandWorks('grep', ['-s', `^${sandboxUser}:`, '/etc/subgid'])
    items.push({ id: 'subgid', label: 'subgid 映射', level: 'host-root', status: subgid === undefined ? 'missing' : 'ok', detail: subgid ?? `缺少 /etc/subgid:${sandboxUser}` })
    const linger = await commandWorks('loginctl', ['show-user', sandboxUser])
    const lingerOk = linger?.split('\n').includes('Linger=yes') === true
    items.push({ id: 'linger', label: 'linger', level: 'host-root', status: linger === undefined ? 'unknown' : lingerOk ? 'ok' : 'missing', detail: lingerOk ? 'Linger=yes' : 'Linger=no 或无法读取' })
    const socket = `/run/user/${sandboxUid}/dockerd-rootless/api.sock`
    items.push({ id: 'rootless-docker', label: 'rootless Docker socket', level: 'sandbox-user', status: await exists(socket) ? 'ok' : 'unknown', detail: socket })
  } else {
    for (const [id, label] of [['subuid','subuid 映射'],['subgid','subgid 映射'],['linger','linger'],['rootless-docker','rootless Docker socket']] as const) {
      items.push({ id, label, level: 'host-root', status: 'unknown', detail: '需先创建沙箱用户' })
    }
  }

  let descriptor: SandboxDescriptor | undefined
  try {
    descriptor = await readSandboxDescriptor(descriptorPath)
    items.push({ id: 'descriptor', label: 'she-sandbox descriptor', level: 'runtime', status: descriptor === undefined ? 'missing' : 'ok', detail: descriptor === undefined ? descriptorPath : `${descriptorPath}（schema=1）` })
  } catch (error) {
    items.push({ id: 'descriptor', label: 'she-sandbox descriptor', level: 'runtime', status: 'blocked', detail: error instanceof Error ? error.message : String(error) })
  }

  const credential = await readCredentialFile(passwordFile)
  items.push({ id: 'password-file', label: 'HttpApi password 文件', level: 'runtime', status: credential === undefined ? 'missing' : 'ok', detail: credential === undefined ? passwordFile : passwordFile })
  let health: { ok: boolean; version?: string; detail?: string } = { ok: false, detail: '未执行（password 缺失）' }
  if (credential !== undefined) {
    health = await (deps.probeOpenCode ?? probeOpenCode)(descriptor?.service.url ?? opencodeUrl, descriptor?.service.username ?? 'opencode', credential)
    items.push({ id: 'opencode-health', label: 'OpenCode health', level: 'runtime', status: health.ok ? 'ok' : 'blocked', detail: health.ok ? `v${health.version ?? '?'}` : health.detail ?? 'unknown' })
  } else {
    items.push({ id: 'opencode-health', label: 'OpenCode health', level: 'runtime', status: 'unknown', detail: 'password 文件不可读' })
  }

  const expectedRuntime = descriptor?.runtime ?? {
    root: join(sharedRoot, 'she-runtime'),
    worktreeRoot: join(sharedRoot, 'she-runtime', 'worktrees'),
    reposRoot: join(sharedRoot, 'repos'),
  }
  const runtimeMissing = [
    !(await exists(expectedRuntime.root)) ? expectedRuntime.root : undefined,
    !(await exists(expectedRuntime.worktreeRoot)) ? expectedRuntime.worktreeRoot : undefined,
    !(await exists(expectedRuntime.reposRoot)) ? expectedRuntime.reposRoot : undefined,
  ].filter((v): v is string => v !== undefined)
  items.push({
    id: 'runtime-dirs', label: 'SHE runtime / repos 目录', level: 'runtime',
    status: runtimeMissing.length === 0 ? 'ok' : descriptor === undefined ? 'missing' : 'blocked',
    detail: runtimeMissing.length === 0 ? 'runtime/worktree/repos 均存在' : `缺少：${runtimeMissing.join(', ')}`,
  })

  const ready = items.every(item => item.status === 'ok' || item.status === 'unknown')
    && items.some(item => item.id === 'descriptor' && item.status === 'ok')
    && items.some(item => item.id === 'opencode-health' && item.status === 'ok')
  return {
    schema: 1,
    deploymentId: `she-sandbox-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    channelUser,
    sandboxUser,
    sharedRoot,
    descriptorPath,
    opencodeUrl,
    passwordFile,
    items,
    ready,
  }
}
