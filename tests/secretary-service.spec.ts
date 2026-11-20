import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretaryService } from '../src/secretary/service.js'
import type { ExecutorAdapter, ExecutorSessionContext, ExecutorStatus, SecretaryTask, WorktreeAllocator } from '../src/secretary/types.js'

class FakeWorktree implements WorktreeAllocator {
  ensure(input: { workspacePath: string; topicId: string; titleExcerpt: string }): Promise<{ worktreePath: string; branch: string }> {
    const worktreePath = join(input.workspacePath, '.worktrees', input.topicId)
    mkdirSync(worktreePath, { recursive: true })
    return Promise.resolve({ worktreePath, branch: `she/${input.topicId}` })
  }
}

class FakeExecutor implements ExecutorAdapter {
  readonly createCalls: ExecutorSessionContext[] = []
  readonly submitted: string[] = []
  readonly statuses: ExecutorStatus[] = []
  reportPath: string | undefined
  private session = 'ses_fake'

  createOrResumeSession(context: ExecutorSessionContext): Promise<{ sessionId: string }> {
    this.createCalls.push(context)
    return Promise.resolve({ sessionId: context.existingSessionId ?? this.session })
  }

  submit(input: { sessionId: string; text: string }): Promise<{ messageId: string }> {
    this.submitted.push(input.text)
    const match = /^report_path: (.+)$/m.exec(input.text)
    if (match?.[1] !== undefined) this.reportPath = match[1]
    return Promise.resolve({ messageId: `msg_${this.submitted.length}` })
  }

  status(): Promise<ExecutorStatus> {
    const next = this.statuses.shift() ?? { state: 'running' as const }
    if (next.state === 'succeeded' && this.reportPath !== undefined) {
      mkdirSync(join(this.reportPath, '..'), { recursive: true })
      writeFileSync(this.reportPath, '# report\n')
    }
    return Promise.resolve(next)
  }

  interrupt(): Promise<void> { return Promise.resolve() }
}

function setup(maxConcurrent = 1, existingDir?: string, existingExecutor?: FakeExecutor) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'feishu4dsh-secretary-service-'))
  const workspace = join(dir, 'project')
  mkdirSync(workspace, { recursive: true })
  const executor = existingExecutor ?? new FakeExecutor()
  const service = new SecretaryService({
    dbPath: join(dir, 'relay.db'),
    worktreeRoot: join(dir, 'worktrees'),
    executor,
    worktree: new FakeWorktree(),
    pollIntervalMs: 1_000_000,
    leaseMs: 1_000,
    maxTopicsPerChat: 2,
    maxQueuedTasks: 20,
    maxConcurrent,
    requireReport: true,
    maxReportBytes: 1024 * 1024,
    model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
    permissionRules: [],
  })
  return { dir, workspace, executor, service }
}

describe('secretary service', () => {
  it('runs one topic serially, reuses the session, and captures the report', async () => {
    const { dir, workspace, executor, service } = setup()
    try {
      const first = await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: '修复登录问题' })
      const second = await service.continue({ scopeKey: 'chat', topicRef: '1', rawRequest: '再补单元测试' })
      expect(first.task.status).toBe('queued')
      expect(second.task.seq).toBe(2)

      await service.tick()
      expect(service.list('chat')[0]?.tasks[0]?.task.status).toBe('submitted')
      expect(service.list('chat')[0]?.tasks[1]?.task.status).toBe('queued')

      executor.statuses.push({ state: 'succeeded', outcome: 'succeeded', lastAssistantText: 'done' })
      await service.tick()
      expect(service.list('chat')[0]?.tasks[0]?.task.status).toBe('succeeded')
      expect(service.list('chat')[0]?.tasks[1]?.task.status).toBe('queued')

      await service.tick()
      expect(service.list('chat')[0]?.tasks[1]?.task.status).toBe('submitted')
      executor.statuses.push({ state: 'succeeded', outcome: 'succeeded', lastAssistantText: 'done again' })
      await service.tick()
      expect(service.list('chat')[0]?.tasks[1]?.task.status).toBe('succeeded')
      expect(executor.createCalls).toHaveLength(2)
      expect(executor.createCalls[0]?.existingSessionId).toBeUndefined()
      expect(executor.createCalls[1]?.existingSessionId).toBe('ses_fake')

      const report = await service.report('chat', '1.1')
      expect(report?.artifact).not.toBeNull()
      expect(readFileSync(report?.artifact?.path ?? '', 'utf8')).toContain('# report')
      expect(executor.submitted[0]).toContain('[user_request_raw]\n修复登录问题')
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pauses the topic on failure and does not dispatch the next queued task', async () => {
    const { dir, workspace, executor, service } = setup()
    try {
      await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'task one' })
      await service.continue({ scopeKey: 'chat', topicRef: '1', rawRequest: 'task two' })
      await service.tick()
      executor.statuses.push({ state: 'failed', outcome: 'failed', detail: 'tests failed' })
      await service.tick()
      const topic = service.list('chat')[0]
      expect(topic?.topic.status).toBe('paused')
      expect(topic?.tasks[0]?.task.status).toBe('failed')
      await service.tick()
      expect(topic?.tasks[1]?.task.status).toBe('queued')
      expect(executor.submitted).toHaveLength(1)

      service.resume('chat', '1')
      await service.tick()
      expect(service.list('chat')[0]?.tasks[1]?.task.status).toBe('submitted')
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks a success without its report as needs_attention and pauses', async () => {
    const { dir, workspace, executor, service } = setup()
    try {
      await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'no report' })
      await service.tick()
      executor.reportPath = undefined
      executor.statuses.push({ state: 'succeeded', outcome: 'succeeded' })
      await service.tick()
      const topic = service.list('chat')[0]
      expect(topic?.tasks[0]?.task.status).toBe('needs_attention')
      expect(topic?.topic.status).toBe('paused')
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers a queued task and its transient raw spool after a restart', async () => {
    const first = setup()
    let second: SecretaryService | undefined
    try {
      await first.service.submit({ scopeKey: 'chat', workspacePath: first.workspace, rawRequest: 'restart recovery task' })
      await first.service.dispose()

      const executor = new FakeExecutor()
      second = new SecretaryService({
        dbPath: join(first.dir, 'relay.db'),
        worktreeRoot: join(first.dir, 'worktrees'),
        executor,
        worktree: new FakeWorktree(),
        pollIntervalMs: 1_000_000,
        leaseMs: 1_000,
        maxTopicsPerChat: 2,
        maxQueuedTasks: 20,
        maxConcurrent: 1,
        requireReport: true,
        maxReportBytes: 1024 * 1024,
        model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
        permissionRules: [],
      })
      await second.tick()
      expect(second.list('chat')[0]?.tasks[0]?.task.status).toBe('submitted')
      expect(executor.submitted[0]).toContain('restart recovery task')
    } finally {
      await second?.dispose()
      rmSync(first.dir, { recursive: true, force: true })
    }
  })

  it('copies attachments into the topic worktree and passes relative paths', async () => {
    const { dir, workspace, executor, service } = setup()
    try {
      const submitted = await service.submit({
        scopeKey: 'chat',
        workspacePath: workspace,
        rawRequest: 'use the attachment',
        attachments: [{ fileName: 'input.txt', bytes: Buffer.from('hello') }],
      })
      expect(existsSync(join(submitted.topic.worktreePath, '.secretary', 'inbox', submitted.task.id, 'input.txt'))).toBe(true)
      await service.tick()
      expect(executor.submitted[0]).toContain('.secretary/inbox/')
      expect(executor.submitted[0]).toContain('input.txt')
      expect(executor.submitted[0]).toContain('sha256=')
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a report symlink that escapes the topic worktree', async () => {
    const { dir, workspace, executor, service } = setup()
    try {
      const submitted = await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'symlink report' })
      await service.tick()
      const outside = join(dir, 'outside-secret.txt')
      writeFileSync(outside, 'DO NOT SEND')
      mkdirSync(join(submitted.task.reportPath, '..'), { recursive: true })
      symlinkSync(outside, submitted.task.reportPath)
      executor.reportPath = undefined
      executor.statuses.push({ state: 'succeeded', outcome: 'succeeded' })
      await service.tick()
      const task = service.list('chat')[0]?.tasks[0]?.task
      expect(task?.status).toBe('needs_attention')
      expect(await service.report('chat', '1.1')).toMatchObject({ artifact: null })
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds active topics per chat and supports rename/remove', async () => {
    const { dir, workspace, service } = setup()
    try {
      await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'topic one' })
      await service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'topic two' })
      await expect(service.submit({ scopeKey: 'chat', workspacePath: workspace, rawRequest: 'topic three' }))
        .rejects.toMatchObject({ code: 'topic_limit' })
      expect(service.rename('chat', '1', '5').displayNo).toBe('5')
      expect(service.rename('chat', '2', '5', true).displayNo).toBe('5')
      expect(service.list('chat').some(view => view.topic.displayNo?.startsWith('5-'))).toBe(true)
      const removed = await service.remove('chat', '5')
      expect(removed.deleted).toBe(true)
      expect(service.list('chat').map(view => view.topic.displayNo)).toEqual([expect.stringMatching(/^5-/)])
      expect(existsSync(join(workspace, '.worktrees'))).toBe(true)
    } finally {
      await service.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
