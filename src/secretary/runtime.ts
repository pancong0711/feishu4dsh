/**
 * Runtime assembly and `/she init` controller for the optional SHE submodule.
 *
 * Responsibilities:
 * - manual startup from profile config (`secretaryEnabled: true`);
 * - automatic startup from the 0600 bootstrap state written by `/she init`;
 * - one-shot B-side initialization of shadow repo/runtime/ACL/open-code health;
 * - scope→shadow-repo mapping used by `/she submit`.
 *
 * This module never starts/stops containers and never touches Docker sockets.
 * The OpenCode execution plane remains owned by the `opencode-she` user.
 * @module feishu4dsh/secretary/runtime
 */

import { execFile } from 'node:child_process'
import { availableParallelism, homedir, userInfo } from 'node:os'
import { access, chmod, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ResolvedConfig } from '../config.js'
import { sanitizeFileName } from '../util.js'
import { OpenCodeClient, OpenCodeExecutor } from './opencode.js'
import { GitWorktreeAllocator } from './worktree.js'
import { SecretaryService } from './service.js'
import { SHE_PERMISSION_RULES } from './permissions.js'
import { acceptTaskReturn, buildTaskReturn, SecretaryReturnError, type TaskAcceptResult, type TaskReturnResult } from './returns.js'
import { inspectSheNeed, readSandboxDescriptor, type SandboxDescriptor, type SheNeedReport } from './need.js'
import { buildSandboxPackage, inspectSandboxHost, nextSandboxName, type SandboxHostReport, type SandboxPackageResult, type SandboxSpec } from './sandbox.js'
import { SandboxBrokerClient } from './broker-client.js'
import { defaultMainActorId, type BrokerDockerStats, type BrokerSandboxView } from './broker.js'
import type { SecretaryTask, SecretaryTopic } from './types.js'
import {
  bootstrapWorkspaceOf,
  readBootstrapState,
  resolveBootstrapPath,
  withBootstrapScope,
  writeBootstrapState,
  type SecretaryBootstrapState,
} from './bootstrap.js'

const execFileAsync = promisify(execFile)

export interface SecretaryRuntimeInitInput {
  /** Bridge scope whose `/she submit` should use the resulting shadow repo. */
  readonly scopeKey: string
  /** Existing git workspace selected in the chat; cloned as committed HEAD. */
  readonly workspacePath: string
}

export interface SecretaryRuntimeUpdateResult {
  readonly shadowRepo: string
  readonly sourceRepo: string
  readonly previousHead: string
  readonly head: string
}

export interface SecretaryRuntimeResetResult {
  readonly shadowRepo: string
  readonly sourceRepo: string
}

export interface SecretaryRuntimeInitResult {
  /** Live service installed into the bridge after successful initialization. */
  readonly service: SecretaryService
  /** Shared clone used by SHE instead of the original dsh workspace. */
  readonly shadowRepo: string
  /** Canonical git root of the source workspace. */
  readonly sourceRepo: string
  /** `secretaryRoot` containing relay.db and worktrees. */
  readonly runtimeRoot: string
  /** Root under which per-Topic git worktrees are created. */
  readonly worktreeRoot: string
  /** Version reported by OpenCode `/api/info` during init. */
  readonly healthVersion: string
}

export type SecretaryRuntimeSource = 'manual' | 'bootstrap' | 'none'

/** Injection seam for filesystem/health operations; production uses the concrete helpers below. */
export interface SecretaryRuntimeDeps {
  readonly setAcl?: (path: string, recursive: boolean) => Promise<void>
  readonly setDefaultAcl?: (path: string, recursiveDirs: boolean) => Promise<void>
  readonly probeOpenCode?: (url: string, username: string, credential: string) => Promise<{ ok: boolean; version?: string; detail?: string }>
}

export interface SecretaryDoctorReport {
  /** True when a live service exists and the loopback OpenCode probe succeeds. */
  readonly ready: boolean
  /** Which source activated the current service. */
  readonly source: SecretaryRuntimeSource
  /** Configured 0600 bootstrap state path. */
  readonly stateFile: string
  /** Whether the state file was found (valid or malformed). */
  readonly statePresent: boolean
  readonly runtimeRoot?: string
  readonly worktreeRoot?: string
  readonly reposRoot?: string
  readonly opencodeUrl?: string
  /** Live `/api/info` probe result; detail never contains credentials. */
  readonly health: { readonly ok: boolean; readonly version?: string; readonly detail?: string }
  /** Shadow repo mapped to the requesting chat scope, when initialized. */
  readonly currentScopeShadowRepo?: string
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readPasswordJson(file: string, report: (line: string) => void): Promise<string> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read OpenCode password file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const mode = (await stat(file)).mode & 0o777
    if ((mode & 0o077) !== 0) report(`feishu4dsh: secretary password file ${file} is mode ${mode.toString(8)}; 0600 is recommended`)
  } catch {
    // Best effort: the file was readable.
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`OpenCode password file ${file} is not valid JSON`)
  }
  const credential = (parsed as { password?: unknown } | null)?.password
  if (typeof credential !== 'string' || credential === '') throw new Error(`OpenCode credential file ${file} has no password field`)
  return credential
}

async function resolveOpenCodePassword(config: ResolvedConfig, report: (line: string) => void): Promise<string> {
  const fromEnv = process.env.OPENCODE_SERVICE_PASSWORD
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (config.secretaryOpencodePassword !== '') return config.secretaryOpencodePassword
  return readPasswordJson(absolutePath(expandHome(config.secretaryOpencodePasswordFile)), report)
}

async function probeOpenCode(url: string, username: string, credential: string): Promise<{ ok: boolean; version?: string; detail?: string }> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/info`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    const payload = await response.json() as { version?: unknown }
    if (typeof payload.version !== 'string' || payload.version === '') {
      return { ok: false, detail: 'response has no version' }
    }
    return { ok: true, version: payload.version }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function maxConcurrentOf(config: ResolvedConfig): number {
  return config.secretaryMaxConcurrent > 0
    ? config.secretaryMaxConcurrent
    : Math.max(1, Math.min(4, availableParallelism() - 4))
}

async function setAcl(path: string, recursive: boolean): Promise<void> {
  const user = userInfo().username
  const accessSpec = recursive
    ? `u:opencode-she:rwX,u:${user}:rwX`
    : `u:opencode-she:rwx,u:${user}:rwx`
  try {
    const args = recursive ? ['-R', '-m', accessSpec, path] : ['-m', accessSpec, path]
    await execFileAsync('setfacl', args)
  } catch (error) {
    throw new Error(`setfacl failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function setDefaultAcl(path: string, recursiveDirs: boolean): Promise<void> {
  const user = userInfo().username
  const spec = `d:u:opencode-she:rwx,d:u:${user}:rwx`
  try {
    if (recursiveDirs) {
      await execFileAsync('find', [path, '-type', 'd', '-exec', 'setfacl', '-m', spec, '{}', '+'])
    } else {
      await execFileAsync('setfacl', ['-m', spec, path])
    }
  } catch (error) {
    throw new Error(`default ACL failed for ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function ensureGitRepo(path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

async function shadowOriginPath(shadowRepo: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', shadowRepo, 'remote', 'get-url', 'origin'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 1024 * 1024,
    })
    const origin = stdout.trim()
    if (origin.startsWith('file://')) return fileURLToPath(origin)
    return origin
  } catch {
    return ''
  }
}

async function shadowMatchesSource(shadowRepo: string, sourceRepo: string): Promise<boolean> {
  try {
    const [origin, source] = await Promise.all([shadowOriginPath(shadowRepo), realpath(sourceRepo)])
    return origin !== '' && await realpath(origin).then(path => path === source).catch(() => false)
  } catch {
    return false
  }
}

async function cloneShadowRepo(sourceRepo: string, shadowRepo: string): Promise<void> {
  if (await pathExists(shadowRepo)) {
    const root = await ensureGitRepo(shadowRepo)
    if (root !== (await realpath(shadowRepo))) throw new Error(`shadow path exists but is not its own git root: ${shadowRepo}`)
    if (!(await shadowMatchesSource(shadowRepo, sourceRepo))) {
      throw new Error(`shadow repo name collision: ${shadowRepo} belongs to a different source repo`)
    }
    return
  }
  await mkdir(dirname(shadowRepo), { recursive: true, mode: 0o2770 })
  await execFileAsync('git', ['clone', '--depth', '1', `file://${sourceRepo}`, shadowRepo], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 8 * 1024 * 1024,
  })
}

async function gitHead(path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', 'HEAD'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

function stateFromDescriptor(config: ResolvedConfig, descriptor: SandboxDescriptor, now: number): SecretaryBootstrapState {
  return {
    schema: 1,
    initializedAt: now,
    updatedAt: now,
    runtime: descriptor.runtime,
    opencode: descriptor.service,
    model: descriptor.model,
    scopes: {},
  }
}

function defaultState(config: ResolvedConfig, now: number): SecretaryBootstrapState {
  const sharedRoot = absolutePath(expandHome(config.secretarySandboxRoot))
  const runtimeRoot = join(sharedRoot, 'she-runtime')
  return {
    schema: 1,
    initializedAt: now,
    updatedAt: now,
    runtime: {
      root: runtimeRoot,
      worktreeRoot: join(runtimeRoot, 'worktrees'),
      reposRoot: join(sharedRoot, 'repos'),
    },
    opencode: {
      url: config.secretarySandboxOpencodeUrl.replace(/\/+$/, ''),
      username: 'opencode',
      passwordFile: absolutePath(expandHome(config.secretarySandboxPasswordFile)),
    },
    model: {
      providerID: config.secretaryModelProviderID,
      id: config.secretaryModelID,
      ...(config.secretaryModelVariant === '' ? {} : { variant: config.secretaryModelVariant }),
    },
    scopes: {},
  }
}

/**
 * Long-lived controller around SecretaryService. It can be constructed once,
 * start in manual or bootstrap mode, and later be activated by `/she init`
 * without restarting dsh.
 */
export class SecretaryRuntime {
  private service: SecretaryService | undefined
  private bootstrap: SecretaryBootstrapState | undefined
  private source: SecretaryRuntimeSource = 'none'
  private disposed = false
  readonly stateFile: string

  constructor(
    private readonly config: ResolvedConfig,
    private readonly report: (line: string) => void,
    private readonly deps: SecretaryRuntimeDeps = {},
  ) {
    this.stateFile = resolveBootstrapPath(config.secretaryBootstrapFile)
  }

  get current(): SecretaryService | undefined {
    return this.service
  }

  workspaceFor(scopeKey: string): string | undefined {
    return bootstrapWorkspaceOf(this.bootstrap, scopeKey)
  }

  /** Best-effort startup: manual profile config wins over bootstrap restore. */
  async start(): Promise<SecretaryService | undefined> {
    if (this.disposed) return undefined
    if (this.config.secretaryEnabled) {
      try {
        const credential = await resolveOpenCodePassword(this.config, this.report)
        this.service = this.createService({
          root: absolutePath(expandHome(this.config.secretaryRoot)),
          worktreeRoot: join(absolutePath(expandHome(this.config.secretaryRoot)), 'worktrees'),
          url: this.config.secretaryOpencodeUrl,
          username: this.config.secretaryOpencodeUsername,
          credential,
          model: {
            providerID: this.config.secretaryModelProviderID,
            id: this.config.secretaryModelID,
            ...(this.config.secretaryModelVariant === '' ? {} : { variant: this.config.secretaryModelVariant }),
          },
        })
        this.source = 'manual'
        this.report(`feishu4dsh: secretary (SHE) enabled — source=manual, OpenCode ${this.config.secretaryOpencodeUrl}`)
        return this.service
      } catch (error) {
        this.report(`feishu4dsh: secretary enabled but unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    if (!this.config.secretaryAutoRestore) return undefined
    try {
      const state = await readBootstrapState(this.stateFile)
      if (state === undefined) return undefined
      const credential = await readPasswordJson(state.opencode.passwordFile, this.report)
      this.bootstrap = state
      this.service = this.createService({
        root: state.runtime.root,
        worktreeRoot: state.runtime.worktreeRoot,
        url: state.opencode.url,
        username: state.opencode.username,
        credential,
        model: state.model,
      })
      this.source = 'bootstrap'
      this.report(`feishu4dsh: secretary (SHE) enabled — source=bootstrap, OpenCode ${state.opencode.url}`)
      return this.service
    } catch (error) {
      this.report(`feishu4dsh: secretary bootstrap restore failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Initialize B-side SHE state and activate the service in the current process. */
  async init(input: SecretaryRuntimeInitInput): Promise<SecretaryRuntimeInitResult> {
    if (this.disposed) throw new Error('secretary runtime is disposed')
    const now = Date.now()
    let state = this.bootstrap ?? await readBootstrapState(this.stateFile)
    if (state === undefined) {
      // Prefer the she-sandbox descriptor when present. Invalid descriptors are
      // fail-closed; a missing descriptor falls back to local defaults.
      const descriptor = await readSandboxDescriptor(resolve(this.config.secretarySandboxDescriptor))
      state = descriptor === undefined ? defaultState(this.config, now) : stateFromDescriptor(this.config, descriptor, now)
    }
    const existing = state.scopes[input.scopeKey]
    if (existing !== undefined) {
      throw new Error(`current scope is already initialized: shadow=${existing.shadowRepo}; use /she init update or /she init reset`)
    }

    const credential = await readPasswordJson(state.opencode.passwordFile, this.report)
    const health = await (this.deps.probeOpenCode ?? probeOpenCode)(state.opencode.url, state.opencode.username, credential)
    if (!health.ok) throw new Error(`OpenCode health check failed at ${state.opencode.url}: ${health.detail ?? 'unknown error'}`)

    const sourceRepo = await realpath(absolutePath(expandHome(input.workspacePath)))
    let sourceRoot: string
    try {
      sourceRoot = await ensureGitRepo(sourceRepo)
    } catch {
      throw new Error(`SHE init requires a git workspace; current path is not a git repository: ${sourceRepo}`)
    }
    const repoName = `${sanitizeFileName(basename(sourceRoot), 'project')}-shadow-repo`
    const shadowRepo = join(state.runtime.reposRoot, repoName)

    await mkdir(state.runtime.root, { recursive: true, mode: 0o2770 })
    await chmod(state.runtime.root, 0o2770)
    await mkdir(state.runtime.worktreeRoot, { recursive: true, mode: 0o2770 })
    await chmod(state.runtime.worktreeRoot, 0o2770)
    await mkdir(state.runtime.reposRoot, { recursive: true, mode: 0o2770 })
    await chmod(state.runtime.reposRoot, 0o2770)
    const applyAcl = this.deps.setAcl ?? setAcl
    const applyDefaultAcl = this.deps.setDefaultAcl ?? setDefaultAcl
    await applyAcl(state.runtime.root, false)
    await applyDefaultAcl(state.runtime.root, false)
    await applyAcl(state.runtime.worktreeRoot, false)
    await applyDefaultAcl(state.runtime.worktreeRoot, false)
    await cloneShadowRepo(sourceRoot, shadowRepo)
    await applyAcl(shadowRepo, true)
    await applyDefaultAcl(shadowRepo, true)

    const next = withBootstrapScope(state, input.scopeKey, sourceRoot, shadowRepo, now)
    await writeBootstrapState(this.stateFile, next)
    this.bootstrap = next
    if (this.service === undefined) {
      this.service = this.createService({
        root: next.runtime.root,
        worktreeRoot: next.runtime.worktreeRoot,
        url: next.opencode.url,
        username: next.opencode.username,
        credential,
        model: next.model,
      })
      this.source = 'bootstrap'
      this.report(`feishu4dsh: secretary (SHE) enabled — source=bootstrap, OpenCode ${next.opencode.url}`)
    }
    return {
      service: this.service,
      shadowRepo,
      sourceRepo: sourceRoot,
      runtimeRoot: next.runtime.root,
      worktreeRoot: next.runtime.worktreeRoot,
      healthVersion: health.version ?? 'unknown',
    }
  }

  /** Read-only `/she need` diagnosis; usable before SHE initialization. */
  async needStatus(): Promise<SheNeedReport> {
    return inspectSheNeed(this.config)
  }

  /** Read-only `/she sandbox status` preflight; no sudo and no container create. */
  async sandboxPreflight(): Promise<SandboxHostReport> {
    return inspectSandboxHost(this.config.secretarySandboxBuilderUser)
  }

  /** Generate a secret-free build-sandbox package outside the chat process. */
  async sandboxPackage(input: { readonly spec: SandboxSpec; readonly preflight?: SandboxHostReport }): Promise<SandboxPackageResult> {
    return buildSandboxPackage(input)
  }

  private brokerClient(): SandboxBrokerClient {
    const socketPath = join(homedir(), '.local', 'share', 'feishu4dsh', 'broker', 'broker.sock')
    return new SandboxBrokerClient({ socketPath })
  }

  /** Register the dsh/Feishu control plane as the broker's main actor. */
  private async registerBrokerMain(): Promise<void> {
    await this.brokerClient().registerMain(defaultMainActorId())
  }

  /** Next fixed sbx-<suffix> / sbx-000N name; prefer broker registry, then local scan. */
  async sandboxNextName(suffix?: string): Promise<string> {
    try {
      await this.registerBrokerMain()
      const result = await this.brokerClient().nextName(suffix) as { name?: unknown }
      if (typeof result.name === 'string' && result.name !== '') return result.name
    } catch {
      // Broker may not be running yet; fall back to the local fixed directory.
    }
    const root = join(homedir(), '.local', 'share', 'feishu4dsh', 'sandboxes')
    let names: string[] = []
    try {
      names = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name)
    } catch {
      // Missing root means nothing exists yet.
    }
    return nextSandboxName(names, suffix)
  }

  async sandboxList(): Promise<readonly BrokerSandboxView[]> {
    await this.registerBrokerMain()
    const result = await this.brokerClient().list() as { sandboxes?: BrokerSandboxView[] }
    return result.sandboxes ?? []
  }

  async sandboxInfo(name: string): Promise<BrokerSandboxView | undefined> {
    try {
      await this.registerBrokerMain()
      const result = await this.brokerClient().info(name) as { sandbox?: BrokerSandboxView }
      return result.sandbox
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) return undefined
      throw error
    }
  }

  async sandboxStats(name: string): Promise<BrokerDockerStats | undefined> {
    try {
      await this.registerBrokerMain()
      const result = await this.brokerClient().stats(name) as { stats?: BrokerDockerStats }
      return result.stats
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) return undefined
      throw error
    }
  }

  async sandboxAction(action: 'start' | 'stop' | 'restart' | 'destroy', name: string): Promise<void> {
    await this.registerBrokerMain()
    const client = this.brokerClient()
    if (action === 'start') await client.start(name)
    else if (action === 'stop') await client.stop(name)
    else if (action === 'restart') await client.restart(name)
    else await client.destroy(name)
  }

  /** Fast-forward the current scope's shadow repo from its committed source HEAD. */
  async update(input: { readonly scopeKey: string }): Promise<SecretaryRuntimeUpdateResult> {
    if (this.service === undefined) throw new Error('SHE service is not active; run /she init first')
    const state = this.bootstrap ?? await readBootstrapState(this.stateFile)
    const scope = state?.scopes[input.scopeKey]
    if (state === undefined || scope === undefined) throw new Error('current scope is not initialized; run /she init first')
    if (this.service.storeView().hasUnfinishedTasks(input.scopeKey)) {
      throw new Error('cannot update shadow repo while queued or running tasks exist')
    }
    if (!(await shadowMatchesSource(scope.shadowRepo, scope.sourceRepo))) {
      throw new Error(`shadow repo origin does not match source: ${scope.shadowRepo}`)
    }
    const dirty = await execFileAsync('git', ['-C', scope.shadowRepo, 'status', '--porcelain'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 8 * 1024 * 1024,
    })
    if (dirty.stdout.trim() !== '') throw new Error('shadow repo has a dirty working tree; refusing update')
    const previousHead = await gitHead(scope.shadowRepo)
    await execFileAsync('git', ['-C', scope.shadowRepo, 'fetch', '--prune', 'origin'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
    })
    await execFileAsync('git', ['-C', scope.shadowRepo, 'merge', '--ff-only', '@{u}'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
    })
    const head = await gitHead(scope.shadowRepo)
    const next = { ...state, updatedAt: Date.now() }
    await writeBootstrapState(this.stateFile, next)
    this.bootstrap = next
    return { shadowRepo: scope.shadowRepo, sourceRepo: scope.sourceRepo, previousHead, head }
  }

  /** Forget one scope→shadow mapping; the repo directory is intentionally retained. */
  async reset(input: { readonly scopeKey: string }): Promise<SecretaryRuntimeResetResult> {
    const state = this.bootstrap ?? await readBootstrapState(this.stateFile)
    const scope = state?.scopes[input.scopeKey]
    if (state === undefined || scope === undefined) throw new Error('current scope is not initialized')
    const scopes = { ...state.scopes }
    delete scopes[input.scopeKey]
    const next = { ...state, scopes, updatedAt: Date.now() }
    await writeBootstrapState(this.stateFile, next)
    this.bootstrap = next
    const service = this.service
    this.service = undefined
    this.source = 'none'
    await service?.dispose().catch(() => undefined)
    return { shadowRepo: scope.shadowRepo, sourceRepo: scope.sourceRepo }
  }

  private resolveTask(scopeKey: string, reference: string): { topic: SecretaryTopic; task: SecretaryTask } {
    if (this.service === undefined) throw new SecretaryReturnError('not_found', 'SHE service is not active')
    const found = this.service.storeView().resolveReference(scopeKey, reference)
    if (found?.task === undefined) throw new SecretaryReturnError('not_found', `task not found: ${reference}`)
    return { topic: found.topic, task: found.task }
  }

  /** Copy one task's report/patch/outputs into the project return directory. */
  async returnTask(input: { readonly scopeKey: string; readonly taskRef: string; readonly projectRoot: string }): Promise<TaskReturnResult> {
    const found = this.resolveTask(input.scopeKey, input.taskRef)
    return buildTaskReturn({ projectRoot: input.projectRoot, topic: found.topic, task: found.task })
  }

  /** Apply a previously returned bundle to the project working tree and stage affected paths. */
  async acceptTask(input: { readonly scopeKey: string; readonly taskRef: string; readonly projectRoot: string }): Promise<TaskAcceptResult> {
    const found = this.resolveTask(input.scopeKey, input.taskRef)
    return acceptTaskReturn({ projectRoot: input.projectRoot, taskId: found.task.id })
  }

  /** Read-only diagnostics for `/she doctor`. */
  async doctor(scopeKey: string): Promise<SecretaryDoctorReport> {
    let state: SecretaryBootstrapState | undefined
    let statePresent = false
    try {
      state = await readBootstrapState(this.stateFile)
      statePresent = state !== undefined
    } catch {
      statePresent = true
    }
    this.bootstrap = state ?? this.bootstrap
    const url = state?.opencode.url ?? (this.source === 'manual' ? this.config.secretaryOpencodeUrl : undefined)
    let health: SecretaryDoctorReport['health'] = { ok: false, detail: 'OpenCode endpoint not configured' }
    if (url !== undefined) {
      try {
        const credential = state !== undefined
          ? await readPasswordJson(state.opencode.passwordFile, this.report)
          : await resolveOpenCodePassword(this.config, this.report)
        health = await (this.deps.probeOpenCode ?? probeOpenCode)(url, state?.opencode.username ?? this.config.secretaryOpencodeUsername, credential)
      } catch (error) {
        health = { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      ready: this.service !== undefined && health.ok,
      source: this.source,
      stateFile: this.stateFile,
      statePresent,
      ...(state === undefined ? {} : {
        runtimeRoot: state.runtime.root,
        worktreeRoot: state.runtime.worktreeRoot,
        reposRoot: state.runtime.reposRoot,
        opencodeUrl: state.opencode.url,
      }),
      health,
      ...(bootstrapWorkspaceOf(state, scopeKey) === undefined ? {} : { currentScopeShadowRepo: bootstrapWorkspaceOf(state, scopeKey) }),
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const service = this.service
    this.service = undefined
    await service?.dispose().catch(() => undefined)
  }

  private createService(input: {
    readonly root: string
    readonly worktreeRoot: string
    readonly url: string
    readonly username: string
    readonly credential: string
    readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  }): SecretaryService {
    const root = absolutePath(expandHome(input.root))
    const client = new OpenCodeClient({ baseUrl: input.url, username: input.username, credential: input.credential })
    const maxConcurrent = maxConcurrentOf(this.config)
    const service = new SecretaryService({
      dbPath: join(root, 'relay.db'),
      worktreeRoot: absolutePath(expandHome(input.worktreeRoot)),
      executor: new OpenCodeExecutor(client),
      worktree: new GitWorktreeAllocator(absolutePath(expandHome(input.worktreeRoot))),
      pollIntervalMs: this.config.secretaryPollIntervalMs,
      leaseMs: this.config.secretaryLeaseMs,
      maxTopicsPerChat: this.config.secretaryMaxTopicsPerChat,
      maxQueuedTasks: this.config.secretaryMaxQueuedTasks,
      maxConcurrent,
      requireReport: this.config.secretaryRequireReport,
      maxReportBytes: this.config.secretaryMaxReportBytes,
      model: input.model,
      permissionRules: SHE_PERMISSION_RULES,
      report: this.report,
    })
    service.start()
    return service
  }
}

/** Create and start the SHE controller. Never throws: failures disable SHE loudly. */
export async function createSecretaryRuntime(
  config: ResolvedConfig,
  report: (line: string) => void,
): Promise<SecretaryRuntime> {
  const runtime = new SecretaryRuntime(config, report)
  await runtime.start()
  return runtime
}
