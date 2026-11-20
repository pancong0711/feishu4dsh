/**
 * Runtime assembly for the optional SHE submodule.
 * @module feishu4dsh/secretary/runtime
 */

import { availableParallelism } from 'node:os'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { OpenCodeClient, OpenCodeExecutor } from './opencode.js'
import { GitWorktreeAllocator } from './worktree.js'
import { SecretaryService } from './service.js'
import { SHE_PERMISSION_RULES } from './permissions.js'

function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

async function resolveOpenCodePassword(config: ResolvedConfig, report: (line: string) => void): Promise<string> {
  const fromEnv = process.env.OPENCODE_SERVICE_PASSWORD
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (config.secretaryOpencodePassword !== '') return config.secretaryOpencodePassword
  const file = absolutePath(expandHome(config.secretaryOpencodePasswordFile))
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read OpenCode password file ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const mode = (await stat(file)).mode & 0o777
    if ((mode & 0o077) !== 0) report(`feishu4dsh: secretary password file ${file} is mode ${mode.toString(8)}; 600 is recommended`)
  } catch {
    // The read already succeeded; permission inspection is best effort.
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

/**
 * Build and start the secretary watcher when `secretaryEnabled` is true.
 * Failures are returned to the caller as a disabled feature (with a loud
 * console line), never as a channel bootstrap failure: the generic Feishu
 * bot must keep working even when OpenCode is down.
 */
export async function startSecretaryRuntime(
  config: ResolvedConfig,
  report: (line: string) => void,
): Promise<SecretaryService | undefined> {
  if (!config.secretaryEnabled) return undefined
  try {
    const root = absolutePath(expandHome(config.secretaryRoot))
    await mkdir(root, { recursive: true, mode: 0o700 })
    const credential = await resolveOpenCodePassword(config, report)
    const client = new OpenCodeClient({
      baseUrl: config.secretaryOpencodeUrl,
      username: config.secretaryOpencodeUsername,
      credential,
    })
    const maxConcurrent = config.secretaryMaxConcurrent > 0
      ? config.secretaryMaxConcurrent
      : Math.max(1, Math.min(4, availableParallelism() - 4))
    const service = new SecretaryService({
      dbPath: join(root, 'relay.db'),
      worktreeRoot: join(root, 'worktrees'),
      executor: new OpenCodeExecutor(client),
      worktree: new GitWorktreeAllocator(join(root, 'worktrees')),
      pollIntervalMs: config.secretaryPollIntervalMs,
      leaseMs: config.secretaryLeaseMs,
      maxTopicsPerChat: config.secretaryMaxTopicsPerChat,
      maxQueuedTasks: config.secretaryMaxQueuedTasks,
      maxConcurrent,
      requireReport: config.secretaryRequireReport,
      maxReportBytes: config.secretaryMaxReportBytes,
      model: {
        providerID: config.secretaryModelProviderID,
        id: config.secretaryModelID,
        ...(config.secretaryModelVariant === '' ? {} : { variant: config.secretaryModelVariant }),
      },
      permissionRules: SHE_PERMISSION_RULES,
      report,
    })
    service.start()
    report(
      `feishu4dsh: secretary (SHE) enabled — OpenCode ${config.secretaryOpencodeUrl}, `
      + `model ${config.secretaryModelProviderID}/${config.secretaryModelID}, concurrency ${maxConcurrent}`,
    )
    return service
  } catch (error) {
    report(`feishu4dsh: secretary enabled but unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
