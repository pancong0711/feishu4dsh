/**
 * SHE service: deterministic topic/task state machine, serial queue, watcher,
 * report validation, and the narrow command-facing API.
 *
 * The bridge owns Feishu formatting only; OpenCode lives behind
 * `ExecutorAdapter`. No module here imports the Feishu SDK or the dsh host.
 * @module feishu4dsh/secretary/service
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type {
  ExecutorAdapter,
  ExecutorPermissionRule,
  SecretaryArtifact,
  SecretaryAttachmentInput,
  SecretaryAttachmentRef,
  SecretaryReport,
  SecretarySubmission,
  SecretaryTask,
  SecretaryTopic,
  WorktreeAllocator,
} from './types.js'
import { buildEnvelope, excerptTwenty, hashRequest } from './envelope.js'
import { SecretaryStore } from './store.js'
import { sanitizeFileName } from '../util.js'

/** One task row plus the display label the bridge renders. */
export interface SecretaryTaskView {
  readonly task: SecretaryTask
  readonly display: string
}

/** One topic plus its tasks, for `/she list`. */
export interface SecretaryTopicView {
  readonly topic: SecretaryTopic
  readonly tasks: readonly SecretaryTaskView[]
}

/** Durable service configuration; the runtime resolves it from plugin config. */
export interface SecretaryServiceOptions {
  readonly dbPath: string
  readonly worktreeRoot: string
  readonly executor: ExecutorAdapter
  readonly worktree: WorktreeAllocator
  readonly pollIntervalMs: number
  readonly leaseMs: number
  readonly maxTopicsPerChat: number
  readonly maxQueuedTasks: number
  readonly maxConcurrent: number
  readonly requireReport: boolean
  readonly maxReportBytes: number
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly permissionRules: readonly ExecutorPermissionRule[]
  readonly now?: () => number
  readonly report?: (line: string) => void
}

/** Stable command-facing failure. */
export class SecretaryServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SecretaryServiceError'
  }
}

function displayOf(topic: SecretaryTopic, task: SecretaryTask): string {
  return `${topic.displayNo ?? '?'}.${task.seq}`
}

function safeFilePart(value: string, fallback: string): string {
  return sanitizeFileName(value, fallback)
}

/** Format one topic label for the default title (first task excerpt). */
function titleOf(raw: string): string {
  return excerptTwenty(raw)
}

/**
 * Long-lived secretary service. `submit`/`continue` only enqueue; every
 * executor call happens in the watcher tick (or an explicit status poll).
 */
export class SecretaryService {
  private readonly store: SecretaryStore
  private readonly now: () => number
  /** Raw prompts for tasks not yet accepted by OpenCode. Kept only until dispatch. */
  private readonly pendingRaw = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private disposed = false
  private readonly owner = randomUUID()

  constructor(private readonly options: SecretaryServiceOptions) {
    this.store = new SecretaryStore(options.dbPath)
    this.now = options.now ?? Date.now
  }

  /** Whether the watcher has started (used by tests and runtime logging). */
  get running(): boolean {
    return this.timer !== undefined
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick() }, this.options.pollIntervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  /** Stop the watcher and close the store (runtime teardown). */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    // Wait out an in-flight tick so teardown never closes the DB under it.
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 10))
    this.store.close()
  }

  /**
   * Create a new Topic, allocate its worktree, spool the raw prompt (deleted
   * once OpenCode accepts it), and enqueue task 1.1.
   */
  async submit(input: {
    readonly scopeKey: string
    readonly workspacePath: string
    readonly rawRequest: string
    readonly attachments?: readonly SecretaryAttachmentInput[]
  }): Promise<SecretarySubmission> {
    const raw = input.rawRequest
    if (raw.trim() === '') throw new SecretaryServiceError('empty_request', 'empty request')
    if (this.store.activeTopicCount(input.scopeKey) >= this.options.maxTopicsPerChat) {
      throw new SecretaryServiceError('topic_limit', `max ${this.options.maxTopicsPerChat} active topics per chat`)
    }
    const hash = hashRequest(raw)
    const duplicate = this.store.findRecentDuplicate(input.scopeKey, hash, this.now() - 5 * 60_000)
    if (duplicate !== undefined) {
      throw new SecretaryServiceError('duplicate', `recent duplicate of ${duplicate.rawExcerpt}`)
    }

    const topicId = randomUUID()
    const allocated = await this.options.worktree.ensure({
      workspacePath: input.workspacePath,
      topicId,
      titleExcerpt: titleOf(raw),
    })
    const topic = this.store.createTopic({
      id: topicId,
      scopeKey: input.scopeKey,
      titleExcerpt: titleOf(raw),
      workspacePath: input.workspacePath,
      worktreePath: allocated.worktreePath,
      branch: allocated.branch,
    })
    const task = await this.enqueue(topic, raw, input.attachments ?? [])
    return { topic, task }
  }

  /** Append one task to an existing Topic; its label is assigned by the store. */
  async continue(input: {
    readonly scopeKey: string
    readonly topicRef: string
    readonly rawRequest: string
    readonly attachments?: readonly SecretaryAttachmentInput[]
  }): Promise<SecretarySubmission> {
    const raw = input.rawRequest
    if (raw.trim() === '') throw new SecretaryServiceError('empty_request', 'empty request')
    const found = this.store.resolveReference(input.scopeKey, input.topicRef)
    if (found === undefined) throw new SecretaryServiceError('not_found', `topic not found: ${input.topicRef}`)
    const topic = found.topic
    if (topic.status === 'archived') throw new SecretaryServiceError('archived', `topic archived: ${topic.displayNo}`)
    if (this.store.queuedCount(topic.id) >= this.options.maxQueuedTasks) {
      throw new SecretaryServiceError('queue_full', `queue full (${this.options.maxQueuedTasks})`)
    }
    const hash = hashRequest(raw)
    const duplicate = this.store.findRecentDuplicate(input.scopeKey, hash, this.now() - 5 * 60_000)
    if (duplicate !== undefined) {
      throw new SecretaryServiceError('duplicate', `recent duplicate of ${duplicate.rawExcerpt}`)
    }
    return { topic, task: await this.enqueue(topic, raw, input.attachments ?? []) }
  }

  private async enqueue(
    topic: SecretaryTopic,
    raw: string,
    inputs: readonly SecretaryAttachmentInput[],
  ): Promise<SecretaryTask> {
    const taskId = randomUUID()
    const reportPath = join(topic.worktreePath, '.secretary', 'reports', `${taskId}.md`)
    const attachments = await this.spoolAttachments(topic.worktreePath, taskId, inputs)
    await this.spoolRaw(topic.worktreePath, taskId, raw)
    this.pendingRaw.set(taskId, raw)
    return this.store.createTask({
      id: taskId,
      topicId: topic.id,
      rawHash: hashRequest(raw),
      rawExcerpt: excerptTwenty(raw),
      reportPath,
      attachments,
    })
  }

  private async spoolAttachments(
    worktreePath: string,
    taskId: string,
    inputs: readonly SecretaryAttachmentInput[],
  ): Promise<SecretaryAttachmentRef[]> {
    if (inputs.length === 0) return []
    const dir = join(worktreePath, '.secretary', 'inbox', taskId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const used = new Set<string>()
    const refs: SecretaryAttachmentRef[] = []
    for (const [index, input] of inputs.entries()) {
      let fileName = safeFilePart(input.fileName, `attachment-${index + 1}`)
      if (used.has(fileName)) fileName = `${index + 1}-${fileName}`
      used.add(fileName)
      const path = join(dir, fileName)
      await writeFile(path, input.bytes, { mode: 0o600 })
      refs.push({
        fileName,
        pathInWorktree: relative(worktreePath, path),
        bytes: input.bytes.byteLength,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
      })
    }
    return refs
  }

  private async spoolRaw(worktreePath: string, taskId: string, raw: string): Promise<void> {
    const dir = join(worktreePath, '.secretary', 'pending')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, `${taskId}.raw`), raw, { mode: 0o600 })
  }

  private async takeRaw(topic: SecretaryTopic, task: SecretaryTask): Promise<string | undefined> {
    const fromMemory = this.pendingRaw.get(task.id)
    if (fromMemory !== undefined) return fromMemory
    // Restart recovery: the transient spool is the only persisted raw copy.
    try {
      return await readFile(join(topic.worktreePath, '.secretary', 'pending', `${task.id}.raw`), 'utf8')
    } catch {
      return undefined
    }
  }

  private async dropRaw(topic: SecretaryTopic, taskId: string): Promise<void> {
    this.pendingRaw.delete(taskId)
    await unlink(join(topic.worktreePath, '.secretary', 'pending', `${taskId}.raw`)).catch(() => undefined)
  }

  /** Render one Topic with its ordered tasks. */
  list(scopeKey: string): SecretaryTopicView[] {
    return this.store.listTopics(scopeKey).map(topic => ({
      topic,
      tasks: this.store.listTasks(topic.id).map(task => ({ task, display: displayOf(topic, task) })),
    }))
  }

  /** Resolve a user reference and poll the executor when a task is active. */
  async status(scopeKey: string, reference: string): Promise<{ topic: SecretaryTopic; task?: SecretaryTask } | undefined> {
    const found = this.store.resolveReference(scopeKey, reference)
    if (found === undefined) return undefined
    if (found.task !== undefined && ['submitted', 'running'].includes(found.task.status)) {
      await this.pollTask(found.topic, found.task).catch(error => {
        this.options.report?.(`feishu4dsh: secretary status poll failed: ${String(error)}`)
      })
    }
    const topic = this.store.getTopic(found.topic.id) ?? found.topic
    const refreshedTask = found.task === undefined ? undefined : this.store.getTask(found.task.id)
    return { topic, ...(refreshedTask === undefined ? {} : { task: refreshedTask }) }
  }

  /** Return the report artifact and verify its file still exists. */
  async report(scopeKey: string, reference: string): Promise<SecretaryReport | undefined> {
    const found = this.store.resolveReference(scopeKey, reference)
    if (found === undefined || found.task === undefined) return undefined
    let artifact: SecretaryArtifact | null = this.store.getArtifact(found.task.id) ?? null
    if (artifact === null) artifact = await this.captureReport(found.topic, found.task)
    return {
      topic: this.store.getTopic(found.topic.id) ?? found.topic,
      task: this.store.getTask(found.task.id) ?? found.task,
      artifact,
    }
  }

  /** Interrupt the active task and pause its Topic; queued tasks survive. */
  async stop(scopeKey: string, reference: string): Promise<{ topic: SecretaryTopic; task?: SecretaryTask }> {
    const found = this.store.resolveReference(scopeKey, reference)
    if (found === undefined) throw new SecretaryServiceError('not_found', `not found: ${reference}`)
    const topic = found.topic
    const active = this.store.activeTask(topic.id)
    if (active === undefined) {
      this.store.updateTopic(topic.id, { status: 'paused' })
      throw new SecretaryServiceError('not_running', `no running task in topic ${topic.displayNo}`)
    }
    if (active.opencodeSessionId !== null) {
      await this.options.executor.interrupt(active.opencodeSessionId).catch(error => {
        this.options.report?.(`feishu4dsh: secretary interrupt failed: ${String(error)}`)
      })
    }
    const task = this.store.updateTask(active.id, {
      status: 'interrupted',
      finishedAt: this.now(),
      error: 'interrupted by user',
    }, 'stopped by user')
    this.store.updateTopic(topic.id, { status: 'paused' })
    return { topic: this.store.getTopic(topic.id) ?? topic, ...(task === undefined ? {} : { task }) }
  }

  /** Resume a paused Topic; the next queued task advances on the next tick. */
  resume(scopeKey: string, reference: string): SecretaryTopic {
    const found = this.store.resolveReference(scopeKey, reference)
    if (found === undefined) throw new SecretaryServiceError('not_found', `topic not found: ${reference}`)
    if (found.topic.status === 'archived') throw new SecretaryServiceError('archived', 'archived topic cannot resume')
    return this.store.updateTopic(found.topic.id, { status: 'active' }) ?? found.topic
  }

  rename(scopeKey: string, oldRef: string, newLabel: string, force = false): SecretaryTopic {
    const found = this.store.resolveReference(scopeKey, oldRef)
    if (found === undefined || found.task !== undefined) throw new SecretaryServiceError('not_found', `topic not found: ${oldRef}`)
    if (!/^[A-Za-z0-9._-]+$/.test(newLabel)) throw new SecretaryServiceError('invalid_label', 'invalid topic label')
    const conflict = this.store.getTopicByDisplay(scopeKey, newLabel)
    if (conflict !== undefined && conflict.id !== found.topic.id) {
      if (!force) throw new SecretaryServiceError('conflict', `label occupied: ${newLabel}`)
      const stamp = new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
      this.store.updateTopic(conflict.id, { displayNo: `${conflict.displayNo ?? newLabel}-${stamp}` })
    }
    return this.store.updateTopic(found.topic.id, { displayNo: newLabel }) ?? found.topic
  }

  /** Soft-delete hides the topic and cancels queued tasks; `--purge` removes storage too. */
  async remove(scopeKey: string, reference: string, purge = false): Promise<SecretaryTopic> {
    const found = this.store.resolveReference(scopeKey, reference)
    if (found === undefined || found.task !== undefined) throw new SecretaryServiceError('not_found', `topic not found: ${reference}`)
    const topic = found.topic
    const active = this.store.activeTask(topic.id)
    if (active?.opencodeSessionId != null && purge) {
      await this.options.executor.interrupt(active.opencodeSessionId).catch(() => undefined)
    }
    for (const task of this.store.listTasks(topic.id)) {
      if (task.status === 'queued') this.store.updateTask(task.id, { status: 'cancelled', finishedAt: this.now() }, 'topic removed')
    }
    this.store.updateTopic(topic.id, { status: 'archived', deleted: true, displayNo: null })
    if (purge) {
      await this.options.worktree.remove?.({ workspacePath: topic.workspacePath, worktreePath: topic.worktreePath })
      this.store.deleteTopic(topic.id)
    }
    return this.store.getTopic(topic.id) ?? { ...topic, status: 'archived', deleted: true, displayNo: null }
  }

  /** One watcher pass. Public so tests and `/she status` can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return
    this.ticking = true
    try {
      let remaining = this.options.maxConcurrent - this.store.countActiveTasks()
      for (const topic of this.store.listRunnableTopics()) {
        if (!this.store.acquireLease(`topic:${topic.id}`, this.owner, this.options.leaseMs)) continue
        try {
          const active = this.store.activeTask(topic.id)
          if (active !== undefined) {
            if (active.status === 'dispatching') {
              // A previous process died between "dispatching" and submit. The
              // transient raw spool makes a replay safe; reset to queued.
              if (this.now() - active.updatedAt >= this.options.leaseMs) {
                this.store.updateTask(active.id, { status: 'queued', error: 'dispatch lease expired; retrying' }, 'lease expired')
              }
              continue
            }
            await this.pollTask(topic, active)
            continue
          }
          if (remaining <= 0 || topic.status !== 'active') continue
          const next = this.store.nextQueued(topic.id)
          if (next === undefined) continue
          await this.dispatchTask(topic, next)
          remaining -= 1
        } catch (error) {
          this.options.report?.(`feishu4dsh: secretary watcher topic ${topic.id} failed: ${String(error)}`)
        } finally {
          this.store.releaseLease(`topic:${topic.id}`, this.owner)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async dispatchTask(topic: SecretaryTopic, task: SecretaryTask): Promise<void> {
    const raw = await this.takeRaw(topic, task)
    if (raw === undefined) {
      this.store.updateTask(task.id, {
        status: 'needs_attention',
        error: 'queued raw prompt spool is missing',
        finishedAt: this.now(),
      }, 'raw spool missing')
      this.store.updateTopic(topic.id, { status: 'paused' })
      return
    }

    const attemptNo = (this.store.latestAttempt(task.id)?.attemptNo ?? 0) + 1
    const attemptId = this.store.createAttempt(task.id, attemptNo, topic.opencodeSessionId)
    this.store.updateTask(task.id, {
      status: 'dispatching',
      startedAt: task.startedAt ?? this.now(),
      error: null,
    }, `attempt ${attemptNo}`)

    try {
      const session = await this.options.executor.createOrResumeSession({
        topicId: topic.id,
        ...(topic.opencodeSessionId === null ? {} : { existingSessionId: topic.opencodeSessionId }),
        directory: topic.worktreePath,
        title: `SHE ${topic.displayNo ?? topic.id.slice(0, 8)} ${topic.titleExcerpt}`,
        model: this.options.model,
        permissionRules: this.options.permissionRules,
      })
      this.store.updateTopic(topic.id, { opencodeSessionId: session.sessionId })
      this.store.updateTask(task.id, { opencodeSessionId: session.sessionId })
      const envelope = buildEnvelope({
        taskId: task.id,
        topicId: topic.id,
        workspacePath: topic.workspacePath,
        worktreePath: topic.worktreePath,
        reportPath: task.reportPath,
        attachments: task.attachments,
        rawRequest: raw,
      })
      const submitted = await this.options.executor.submit({ sessionId: session.sessionId, text: envelope })
      this.store.finishAttempt(attemptId, { messageId: submitted.messageId })
      this.store.updateTask(task.id, {
        status: 'submitted',
        opencodeMessageId: submitted.messageId,
      }, 'submitted to executor')
      await this.dropRaw(topic, task.id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.store.finishAttempt(attemptId, { error: detail })
      this.store.updateTask(task.id, {
        status: 'failed',
        error: detail,
        finishedAt: this.now(),
      }, 'dispatch failed')
      this.store.updateTopic(topic.id, { status: 'paused' })
      this.options.report?.(`feishu4dsh: secretary dispatch failed for ${task.id}: ${detail}`)
    }
  }

  private async pollTask(topic: SecretaryTopic, task: SecretaryTask): Promise<void> {
    const sessionId = task.opencodeSessionId ?? topic.opencodeSessionId
    if (sessionId === null) return
    let result
    try {
      result = await this.options.executor.status(sessionId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.store.updateTask(task.id, { status: 'needs_attention', error: `executor poll failed: ${detail}`, finishedAt: this.now() }, 'poll failed')
      this.store.updateTopic(topic.id, { status: 'paused' })
      return
    }
    if (result.state === 'running') {
      if (task.status !== 'running') this.store.updateTask(task.id, { status: 'running' }, 'executor running')
      this.store.updateTopic(topic.id, { lastActiveAt: this.now() })
      return
    }

    const latest = this.store.latestAttempt(task.id)
    if (latest !== undefined) this.store.finishAttempt(latest.id, { outcome: result.outcome, error: result.detail })
    if (result.state === 'succeeded') {
      const artifact = this.options.requireReport ? await this.captureReport(topic, task) : null
      if (this.options.requireReport && artifact === null) {
        this.store.updateTask(task.id, {
          status: 'needs_attention',
          error: 'OpenCode succeeded but the report file is missing',
          finishedAt: this.now(),
        }, 'report missing')
        this.store.updateTopic(topic.id, { status: 'paused' })
        return
      }
      this.store.updateTask(task.id, { status: 'succeeded', error: null, finishedAt: this.now() }, 'executor succeeded')
      this.store.updateTopic(topic.id, { lastActiveAt: this.now() })
      return
    }
    this.store.updateTask(task.id, {
      status: result.state === 'interrupted' ? 'interrupted' : 'failed',
      error: result.detail ?? result.outcome ?? result.state,
      finishedAt: this.now(),
    }, result.state)
    this.store.updateTopic(topic.id, { status: 'paused' })
  }

  private async captureReport(topic: SecretaryTopic, task: SecretaryTask): Promise<SecretaryArtifact | null> {
    const existing = this.store.getArtifact(task.id)
    if (existing !== undefined) return existing
    try {
      // Realpath the report and require it to stay inside the topic worktree:
      // a symlinked report must not turn `/she report` into an arbitrary file
      // exfiltration path.
      const [canonicalWorktree, canonicalReport] = await Promise.all([
        realpath(topic.worktreePath),
        realpath(task.reportPath),
      ])
      const rel = relative(canonicalWorktree, canonicalReport)
      if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return null
      const info = await stat(canonicalReport)
      if (!info.isFile() || info.size <= 0 || info.size > this.options.maxReportBytes) return null
      return this.store.addArtifact(task.id, 'report', canonicalReport, info.size)
    } catch {
      return null
    }
  }

  /** Read a report only after it has been validated and registered. */
  async readReport(artifactPath: string): Promise<Buffer> {
    return readFile(artifactPath)
  }

  /** Exposed for the bridge's status/list copy. */
  storeView(): SecretaryStore {
    return this.store
  }
}
