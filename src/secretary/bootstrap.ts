/**
 * Persistent bootstrap state for the optional SHE submodule.
 *
 * `/she init` writes this 0600 JSON file after it has prepared the shared
 * shadow repo/runtime. It intentionally stores paths and model identifiers
 * only: provider credentials and the local OpenCode Basic password stay in
 * their own secret files. The state lets a later dsh restart rehydrate SHE
 * without asking the user to edit profile URL/password/root fields.
 * @module feishu4dsh/secretary/bootstrap
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const SHE_BOOTSTRAP_SCHEMA = 1

export interface SecretaryBootstrapScope {
  readonly sourceRepo: string
  readonly shadowRepo: string
  readonly updatedAt: number
}

export interface SecretaryBootstrapState {
  readonly schema: typeof SHE_BOOTSTRAP_SCHEMA
  readonly initializedAt: number
  readonly updatedAt: number
  readonly runtime: {
    readonly root: string
    readonly worktreeRoot: string
    readonly reposRoot: string
  }
  readonly opencode: {
    readonly url: string
    readonly username: string
    readonly passwordFile: string
  }
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly scopes: Record<string, SecretaryBootstrapScope>
}

export class SecretaryBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretaryBootstrapError'
  }
}

/** Expand a leading `~` exactly once; relative paths resolve against cwd. */
export function resolveBootstrapPath(path: string): string {
  const expanded = path === '~'
    ? homedir()
    : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

/** Only loopback OpenCode endpoints are accepted by the bootstrap state. */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validate an untrusted JSON value and return a normalized frozen state.
 * Paths are kept as strings here; filesystem existence is checked by callers.
 */
export function parseBootstrapState(value: unknown): SecretaryBootstrapState {
  const root = objectOf(value)
  if (root === undefined) throw new SecretaryBootstrapError('bootstrap state is not an object')
  if (root.schema !== SHE_BOOTSTRAP_SCHEMA) throw new SecretaryBootstrapError(`unsupported bootstrap schema: ${String(root.schema)}`)
  if (!Number.isFinite(root.initializedAt) || !Number.isFinite(root.updatedAt)) {
    throw new SecretaryBootstrapError('bootstrap timestamps are invalid')
  }
  const runtime = objectOf(root.runtime)
  const opencode = objectOf(root.opencode)
  const model = objectOf(root.model)
  const scopes = objectOf(root.scopes)
  if (runtime === undefined || opencode === undefined || model === undefined || scopes === undefined) {
    throw new SecretaryBootstrapError('bootstrap state is missing runtime/opencode/model/scopes')
  }
  const runtimeRoot = runtime.root
  const worktreeRoot = runtime.worktreeRoot
  const reposRoot = runtime.reposRoot
  if (typeof runtimeRoot !== 'string' || !nonEmptyString(runtimeRoot) || !isAbsolute(runtimeRoot)) {
    throw new SecretaryBootstrapError('bootstrap runtime.root must be an absolute path')
  }
  if (typeof worktreeRoot !== 'string' || !nonEmptyString(worktreeRoot) || !isAbsolute(worktreeRoot)) {
    throw new SecretaryBootstrapError('bootstrap runtime.worktreeRoot must be an absolute path')
  }
  if (typeof reposRoot !== 'string' || !nonEmptyString(reposRoot) || !isAbsolute(reposRoot)) {
    throw new SecretaryBootstrapError('bootstrap runtime.reposRoot must be an absolute path')
  }
  const opencodeUrl = opencode.url
  const opencodeUsername = opencode.username
  const passwordFile = opencode.passwordFile
  const providerID = model.providerID
  const modelID = model.id
  if (typeof opencodeUrl !== 'string' || !nonEmptyString(opencodeUrl) || !isLoopbackHttpUrl(opencodeUrl)) {
    throw new SecretaryBootstrapError('bootstrap opencode.url must be a loopback http(s) URL')
  }
  if (typeof opencodeUsername !== 'string' || typeof passwordFile !== 'string'
    || !nonEmptyString(opencodeUsername) || !nonEmptyString(passwordFile) || !isAbsolute(passwordFile)) {
    throw new SecretaryBootstrapError('bootstrap opencode username/passwordFile is invalid')
  }
  if (typeof providerID !== 'string' || typeof modelID !== 'string' || !nonEmptyString(providerID) || !nonEmptyString(modelID)) {
    throw new SecretaryBootstrapError('bootstrap model provider/id is invalid')
  }
  if (model.variant !== undefined && typeof model.variant !== 'string') {
    throw new SecretaryBootstrapError('bootstrap model.variant must be a string')
  }
  const normalizedScopes: Record<string, SecretaryBootstrapScope> = {}
  for (const [scopeKey, raw] of Object.entries(scopes)) {
    const scope = objectOf(raw)
    if (scope === undefined || !nonEmptyString(scope.sourceRepo) || !nonEmptyString(scope.shadowRepo)
      || !isAbsolute(scope.sourceRepo) || !isAbsolute(scope.shadowRepo) || !Number.isFinite(scope.updatedAt)) {
      throw new SecretaryBootstrapError(`bootstrap scope ${scopeKey} is invalid`)
    }
    normalizedScopes[scopeKey] = {
      sourceRepo: scope.sourceRepo,
      shadowRepo: scope.shadowRepo,
      updatedAt: scope.updatedAt as number,
    }
  }
  return {
    schema: SHE_BOOTSTRAP_SCHEMA,
    initializedAt: root.initializedAt as number,
    updatedAt: root.updatedAt as number,
    runtime: {
      root: runtimeRoot,
      worktreeRoot,
      reposRoot,
    },
    opencode: {
      url: opencodeUrl.replace(/\/+$/, ''),
      username: opencodeUsername,
      passwordFile,
    },
    model: {
      providerID,
      id: modelID,
      ...(model.variant === undefined || model.variant === '' ? {} : { variant: model.variant }),
    },
    scopes: normalizedScopes,
  }
}

/** Read and validate the bootstrap file. Missing file means "not initialized". */
export async function readBootstrapState(path: string): Promise<SecretaryBootstrapState | undefined> {
  const file = resolveBootstrapPath(path)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SecretaryBootstrapError(`cannot read SHE bootstrap file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SecretaryBootstrapError(`SHE bootstrap file ${file} is not valid JSON`)
  }
  return parseBootstrapState(parsed)
}

/** Atomically persist bootstrap state with owner-only permissions. */
export async function writeBootstrapState(path: string, state: SecretaryBootstrapState): Promise<void> {
  const file = resolveBootstrapPath(path)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw new SecretaryBootstrapError(`cannot write SHE bootstrap file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Add/replace one scope's source→shadow mapping while preserving other scopes. */
export function withBootstrapScope(
  state: SecretaryBootstrapState,
  scopeKey: string,
  sourceRepo: string,
  shadowRepo: string,
  now = Date.now(),
): SecretaryBootstrapState {
  return {
    ...state,
    updatedAt: now,
    scopes: {
      ...state.scopes,
      [scopeKey]: { sourceRepo, shadowRepo, updatedAt: now },
    },
  }
}

/** Return the shadow repo associated with one bridge scope, if initialized. */
export function bootstrapWorkspaceOf(state: SecretaryBootstrapState | undefined, scopeKey: string): string | undefined {
  return state?.scopes[scopeKey]?.shadowRepo
}
