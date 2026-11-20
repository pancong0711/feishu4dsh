import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretaryStore } from '../src/secretary/store.js'

describe('secretary store', () => {
  it('allocates per-chat labels, serial task numbers and releases labels on removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu4dsh-secretary-store-'))
    const store = new SecretaryStore(join(dir, 'relay.db'))
    try {
      const first = store.createTopic({
        scopeKey: 'chat@thread',
        titleExcerpt: '第一个任务',
        workspacePath: dir,
        worktreePath: join(dir, 'wt1'),
        branch: 'she/one',
      })
      expect(first.displayNo).toBe('1')
      const task1 = store.createTask({
        topicId: first.id,
        rawHash: 'h1',
        rawExcerpt: '第一个任务',
        reportPath: join(dir, 'r1.md'),
        attachments: [],
      })
      const task2 = store.createTask({
        topicId: first.id,
        rawHash: 'h2',
        rawExcerpt: '第二个任务',
        reportPath: join(dir, 'r2.md'),
        attachments: [],
      })
      expect(task1.seq).toBe(1)
      expect(task2.seq).toBe(2)
      expect(store.getTaskByDisplay('chat@thread', '1.2')?.task.id).toBe(task2.id)

      store.updateTopic(first.id, { status: 'archived', deleted: true, displayNo: null })
      const second = store.createTopic({
        scopeKey: 'chat@thread',
        titleExcerpt: '新任务',
        workspacePath: dir,
        worktreePath: join(dir, 'wt2'),
        branch: 'she/two',
      })
      expect(second.displayNo).toBe('1')
      expect(store.listTopics('chat@thread')).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a single active task per topic and records events/artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu4dsh-secretary-store-'))
    const store = new SecretaryStore(join(dir, 'relay.db'))
    try {
      const topic = store.createTopic({
        scopeKey: 'chat',
        titleExcerpt: 'mock',
        workspacePath: dir,
        worktreePath: join(dir, 'wt'),
        branch: 'she/mock',
      })
      const task = store.createTask({
        topicId: topic.id,
        rawHash: 'h',
        rawExcerpt: 'mock',
        reportPath: join(dir, 'report.md'),
        attachments: [],
      })
      store.updateTask(task.id, { status: 'running', startedAt: 1 })
      expect(store.activeTask(topic.id)?.id).toBe(task.id)
      store.updateTask(task.id, { status: 'succeeded', finishedAt: 2 })
      expect(store.activeTask(topic.id)).toBeUndefined()
      const artifact = store.addArtifact(task.id, 'report', join(dir, 'report.md'), 12)
      expect(store.getArtifact(task.id)).toEqual(artifact)
      expect(store.listEvents(task.id).some(event => event.toStatus === 'succeeded')).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
