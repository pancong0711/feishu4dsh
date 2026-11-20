/**
 * SQLite persistence for the secretary state machine.
 *
 * SHE is the single source of truth: the bridge and Feishu cards only read
 * this store. The schema intentionally keeps the original user prompt out of
 * the database (hash + 20-char excerpt only).
 * @module feishu4dsh/secretary/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  SecretaryArtifact,
  SecretaryAttachmentRef,
  SecretaryTask,
  SecretaryTaskStatus,
  SecretaryTopic,
  SecretaryTopicStatus,
} from './types.js'

interface TopicRow {
  id: string
  scope_key: string
  display_no: string | null
  title_excerpt: string
  workspace_path: string
  worktree_path: string
  branch: string
  opencode_session_id: string | null
  status: string
  created_at: number
  updated_at: number
  last_active_at: number
  deleted: number
}

interface TaskRow {
  id: string
  topic_id: string
  seq: number
  status: string
  raw_hash: string
  raw_excerpt: string
  report_path: string
  opencode_session_id: string | null
  opencode_message_id: string | null
  error: string | null
  attachments_json: string
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

interface ArtifactRow {
  id: string
  task_id: string
  kind: string
  path: string
  bytes: number
  created_at: number
}

function topicOf(row: TopicRow): SecretaryTopic {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    displayNo: row.display_no,
    titleExcerpt: row.title_excerpt,
    workspacePath: row.workspace_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    opencodeSessionId: row.opencode_session_id,
    status: row.status as SecretaryTopicStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    deleted: row.deleted !== 0,
  }
}

function taskOf(row: TaskRow): SecretaryTask {
  let attachments: SecretaryAttachmentRef[] = []
  try {
    const parsed: unknown = JSON.parse(row.attachments_json)
    if (Array.isArray(parsed)) attachments = parsed as SecretaryAttachmentRef[]
  } catch {
    attachments = []
  }
  return {
    id: row.id,
    topicId: row.topic_id,
    seq: row.seq,
    status: row.status as SecretaryTaskStatus,
    rawHash: row.raw_hash,
    rawExcerpt: row.raw_excerpt,
    reportPath: row.report_path,
    opencodeSessionId: row.opencode_session_id,
    opencodeMessageId: row.opencode_message_id,
    error: row.error,
    attachments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function artifactOf(row: ArtifactRow): SecretaryArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as 'report',
    path: row.path,
    bytes: row.bytes,
    createdAt: row.created_at,
  }
}

/** Business-state error with a stable code for command copy. */
export class SecretaryStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SecretaryStoreError'
  }
}

/**
 * One SQLite-backed repository. All writes are serialized on the single
 * `DatabaseSync` connection; multi-statement operations use an explicit
 * BEGIN IMMEDIATE transaction.
 */
export class SecretaryStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        display_no TEXT,
        title_excerpt TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        opencode_session_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_topics_scope ON topics(scope_key, deleted);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        raw_excerpt TEXT NOT NULL,
        report_path TEXT NOT NULL,
        opencode_session_id TEXT,
        opencode_message_id TEXT,
        error TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        UNIQUE(topic_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_topic ON tasks(topic_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_no INTEGER NOT NULL,
        session_id TEXT,
        message_id TEXT,
        outcome TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id, attempt_no);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watcher_leases (
        key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private event(entityType: 'topic' | 'task', entityId: string, from: string | null, to: string, detail?: string): void {
    this.db.prepare(
      'INSERT INTO events(entity_type, entity_id, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(entityType, entityId, from, to, detail ?? null, Date.now())
  }

  /** Allocate the next integer label in one chat scope (released labels are reusable). */
  private nextDisplayNo(scopeKey: string): string {
    const rows = this.db.prepare(
      'SELECT display_no FROM topics WHERE scope_key = ? AND deleted = 0 AND display_no GLOB \'[0-9]*\'',
    ).all(scopeKey) as { display_no: string | null }[]
    let max = 0
    for (const row of rows) {
      const n = Number(row.display_no)
      if (Number.isInteger(n) && n > max) max = n
    }
    return String(max + 1)
  }

  createTopic(input: {
    readonly id?: string
    readonly scopeKey: string
    readonly titleExcerpt: string
    readonly workspacePath: string
    readonly worktreePath: string
    readonly branch: string
  }): SecretaryTopic {
    return this.tx(() => {
      const now = Date.now()
      const topic: SecretaryTopic = {
        id: input.id ?? randomUUID(),
        scopeKey: input.scopeKey,
        displayNo: this.nextDisplayNo(input.scopeKey),
        titleExcerpt: input.titleExcerpt,
        workspacePath: input.workspacePath,
        worktreePath: input.worktreePath,
        branch: input.branch,
        opencodeSessionId: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        deleted: false,
      }
      this.db.prepare(`
        INSERT INTO topics(id, scope_key, display_no, title_excerpt, workspace_path, worktree_path,
          branch, opencode_session_id, status, created_at, updated_at, last_active_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        topic.id, topic.scopeKey, topic.displayNo, topic.titleExcerpt, topic.workspacePath,
        topic.worktreePath, topic.branch, null, topic.status, now, now, now,
      )
      this.event('topic', topic.id, null, topic.status)
      return topic
    })
  }

  getTopic(id: string): SecretaryTopic | undefined {
    const row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined
    return row === undefined ? undefined : topicOf(row)
  }

  getTopicByDisplay(scopeKey: string, displayNo: string): SecretaryTopic | undefined {
    const row = this.db.prepare(
      'SELECT * FROM topics WHERE scope_key = ? AND display_no = ? AND deleted = 0',
    ).get(scopeKey, displayNo) as TopicRow | undefined
    return row === undefined ? undefined : topicOf(row)
  }

  listTopics(scopeKey: string): SecretaryTopic[] {
    const rows = this.db.prepare(
      'SELECT * FROM topics WHERE scope_key = ? AND deleted = 0 ORDER BY CASE WHEN display_no GLOB \'[0-9]*\' THEN CAST(display_no AS INTEGER) ELSE 999999 END, display_no',
    ).all(scopeKey) as unknown as TopicRow[]
    return rows.map(topicOf)
  }

  /** Topics with queued/running work, across all chats, for the watcher. */
  listRunnableTopics(): SecretaryTopic[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.* FROM topics t
      JOIN tasks k ON k.topic_id = t.id
      WHERE t.deleted = 0 AND t.status = 'active'
        AND k.status IN ('queued','dispatching','submitted','running')
      ORDER BY t.updated_at ASC
    `).all() as unknown as TopicRow[]
    return rows.map(topicOf)
  }

  updateTopic(
    id: string,
    patch: {
      readonly opencodeSessionId?: string | null
      readonly status?: SecretaryTopicStatus
      readonly displayNo?: string | null
      readonly deleted?: boolean
      readonly lastActiveAt?: number
    },
  ): SecretaryTopic | undefined {
    return this.tx(() => {
      const current = this.getTopic(id)
      if (current === undefined) return undefined
      const next = {
        opencodeSessionId: patch.opencodeSessionId === undefined ? current.opencodeSessionId : patch.opencodeSessionId,
        status: patch.status ?? current.status,
        displayNo: patch.displayNo === undefined ? current.displayNo : patch.displayNo,
        deleted: patch.deleted ?? current.deleted,
        lastActiveAt: patch.lastActiveAt ?? current.lastActiveAt,
      }
      this.db.prepare(`
        UPDATE topics SET opencode_session_id = ?, status = ?, display_no = ?, deleted = ?,
          last_active_at = ?, updated_at = ? WHERE id = ?
      `).run(next.opencodeSessionId, next.status, next.displayNo, next.deleted ? 1 : 0, next.lastActiveAt, Date.now(), id)
      if (current.status !== next.status) this.event('topic', id, current.status, next.status)
      return this.getTopic(id)
    })
  }

  createTask(input: {
    readonly id?: string
    readonly topicId: string
    readonly rawHash: string
    readonly rawExcerpt: string
    readonly reportPath: string
    readonly attachments: readonly SecretaryAttachmentRef[]
  }): SecretaryTask {
    return this.tx(() => {
      const max = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM tasks WHERE topic_id = ?')
        .get(input.topicId) as { n: number }
      const now = Date.now()
      const task: SecretaryTask = {
        id: input.id ?? randomUUID(),
        topicId: input.topicId,
        seq: max.n + 1,
        status: 'queued',
        rawHash: input.rawHash,
        rawExcerpt: input.rawExcerpt,
        reportPath: input.reportPath,
        opencodeSessionId: null,
        opencodeMessageId: null,
        error: null,
        attachments: input.attachments,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      }
      this.db.prepare(`
        INSERT INTO tasks(id, topic_id, seq, status, raw_hash, raw_excerpt, report_path,
          opencode_session_id, opencode_message_id, error, attachments_json,
          created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)
      `).run(
        task.id, task.topicId, task.seq, task.status, task.rawHash, task.rawExcerpt,
        task.reportPath, JSON.stringify(task.attachments), now, now,
      )
      this.event('task', task.id, null, task.status)
      return task
    })
  }

  getTask(id: string): SecretaryTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  getTaskByDisplay(scopeKey: string, display: string): { topic: SecretaryTopic; task: SecretaryTask } | undefined {
    const match = /^(.+)\.(\d+)$/.exec(display.trim())
    if (match === null || match[1] === undefined || match[2] === undefined) return undefined
    const topic = this.getTopicByDisplay(scopeKey, match[1])
    if (topic === undefined) return undefined
    const row = this.db.prepare('SELECT * FROM tasks WHERE topic_id = ? AND seq = ?')
      .get(topic.id, Number(match[2])) as TaskRow | undefined
    return row === undefined ? undefined : { topic, task: taskOf(row) }
  }

  /** Resolve a topic label, a topic UUID, a task display (`1.2`) or a task UUID. */
  resolveReference(scopeKey: string, reference: string): { topic: SecretaryTopic; task?: SecretaryTask } | undefined {
    const directTopic = this.getTopicByDisplay(scopeKey, reference)
    if (directTopic !== undefined) return { topic: directTopic }
    const directTask = this.getTaskByDisplay(scopeKey, reference)
    if (directTask !== undefined) return directTask
    const byId = this.getTopic(reference)
    if (byId !== undefined && byId.scopeKey === scopeKey && !byId.deleted) return { topic: byId }
    const taskById = this.getTask(reference)
    if (taskById !== undefined) {
      const topic = this.getTopic(taskById.topicId)
      if (topic !== undefined && topic.scopeKey === scopeKey && !topic.deleted) return { topic, task: taskById }
    }
    return undefined
  }

  listTasks(topicId: string): SecretaryTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE topic_id = ? ORDER BY seq ASC')
      .all(topicId) as unknown as TaskRow[]
    return rows.map(taskOf)
  }

  activeTask(topicId: string): SecretaryTask | undefined {
    const row = this.db.prepare(`
      SELECT * FROM tasks WHERE topic_id = ? AND status IN ('dispatching','submitted','running')
      ORDER BY seq ASC LIMIT 1
    `).get(topicId) as TaskRow | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  nextQueued(topicId: string): SecretaryTask | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE topic_id = ? AND status = \'queued\' ORDER BY seq ASC LIMIT 1',
    ).get(topicId) as TaskRow | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  queuedCount(topicId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM tasks WHERE topic_id = ? AND status = \'queued\'',
    ).get(topicId) as { n: number }
    return row.n
  }

  countActiveTasks(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM tasks WHERE status IN (\'dispatching\',\'submitted\',\'running\')',
    ).get() as { n: number }
    return row.n
  }

  findRecentDuplicate(scopeKey: string, rawHash: string, since: number): SecretaryTask | undefined {
    const row = this.db.prepare(`
      SELECT k.* FROM tasks k JOIN topics t ON t.id = k.topic_id
      WHERE t.scope_key = ? AND t.deleted = 0 AND k.raw_hash = ? AND k.created_at >= ?
      ORDER BY k.created_at DESC LIMIT 1
    `).get(scopeKey, rawHash, since) as TaskRow | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  deleteTopic(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM artifacts WHERE task_id IN (SELECT id FROM tasks WHERE topic_id = ?)').run(id)
      this.db.prepare('DELETE FROM attempts WHERE task_id IN (SELECT id FROM tasks WHERE topic_id = ?)').run(id)
      this.db.prepare('DELETE FROM tasks WHERE topic_id = ?').run(id)
      this.db.prepare('DELETE FROM topics WHERE id = ?').run(id)
    })
  }

  activeTopicCount(scopeKey: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM topics t WHERE t.scope_key = ? AND t.deleted = 0
        AND t.status = 'active' AND EXISTS (
          SELECT 1 FROM tasks k WHERE k.topic_id = t.id
            AND k.status IN ('queued','dispatching','submitted','running')
        )
    `).get(scopeKey) as { n: number }
    return row.n
  }

  updateTask(
    id: string,
    patch: {
      readonly status?: SecretaryTaskStatus
      readonly opencodeSessionId?: string | null
      readonly opencodeMessageId?: string | null
      readonly error?: string | null
      readonly startedAt?: number | null
      readonly finishedAt?: number | null
    },
    detail?: string,
  ): SecretaryTask | undefined {
    return this.tx(() => {
      const current = this.getTask(id)
      if (current === undefined) return undefined
      const next = {
        status: patch.status ?? current.status,
        opencodeSessionId: patch.opencodeSessionId === undefined ? current.opencodeSessionId : patch.opencodeSessionId,
        opencodeMessageId: patch.opencodeMessageId === undefined ? current.opencodeMessageId : patch.opencodeMessageId,
        error: patch.error === undefined ? current.error : patch.error,
        startedAt: patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      }
      this.db.prepare(`
        UPDATE tasks SET status = ?, opencode_session_id = ?, opencode_message_id = ?, error = ?,
          started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?
      `).run(next.status, next.opencodeSessionId, next.opencodeMessageId, next.error, next.startedAt, next.finishedAt, Date.now(), id)
      if (current.status !== next.status) this.event('task', id, current.status, next.status, detail)
      return this.getTask(id)
    })
  }

  createAttempt(taskId: string, attemptNo: number, sessionId: string | null): string {
    const id = randomUUID()
    this.db.prepare(
      'INSERT INTO attempts(id, task_id, attempt_no, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, taskId, attemptNo, sessionId, Date.now())
    return id
  }

  finishAttempt(id: string, patch: { messageId?: string; outcome?: string; error?: string }): void {
    this.db.prepare(`
      UPDATE attempts SET message_id = COALESCE(?, message_id), outcome = ?,
        error = ?, finished_at = ? WHERE id = ?
    `).run(patch.messageId ?? null, patch.outcome ?? null, patch.error ?? null, Date.now(), id)
  }

  latestAttempt(taskId: string): { id: string; attemptNo: number } | undefined {
    const row = this.db.prepare(
      'SELECT id, attempt_no AS attemptNo FROM attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1',
    ).get(taskId) as { id: string; attemptNo: number } | undefined
    return row
  }

  addArtifact(taskId: string, kind: 'report', path: string, bytes: number): SecretaryArtifact {
    const artifact: SecretaryArtifact = { id: randomUUID(), taskId, kind, path, bytes, createdAt: Date.now() }
    this.db.prepare(
      'INSERT INTO artifacts(id, task_id, kind, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(artifact.id, artifact.taskId, artifact.kind, artifact.path, artifact.bytes, artifact.createdAt)
    return artifact
  }

  getArtifact(taskId: string): SecretaryArtifact | undefined {
    const row = this.db.prepare(
      'SELECT * FROM artifacts WHERE task_id = ? AND kind = \'report\' ORDER BY created_at DESC LIMIT 1',
    ).get(taskId) as ArtifactRow | undefined
    return row === undefined ? undefined : artifactOf(row)
  }

  listEvents(entityId: string, limit = 20): { toStatus: string; detail: string | null; createdAt: number }[] {
    const rows = this.db.prepare(
      'SELECT to_status AS toStatus, detail, created_at AS createdAt FROM events WHERE entity_id = ? ORDER BY id DESC LIMIT ?',
    ).all(entityId, limit) as { toStatus: string; detail: string | null; createdAt: number }[]
    return rows
  }

  /** Acquire a watcher/topic lease; returns false when another owner holds it. */
  acquireLease(key: string, owner: string, ttlMs: number): boolean {
    return this.tx(() => {
      const now = Date.now()
      this.db.prepare('DELETE FROM watcher_leases WHERE expires_at <= ?').run(now)
      const existing = this.db.prepare('SELECT owner, expires_at FROM watcher_leases WHERE key = ?')
        .get(key) as { owner: string; expires_at: number } | undefined
      if (existing !== undefined && existing.owner !== owner && existing.expires_at > now) return false
      this.db.prepare(`
        INSERT INTO watcher_leases(key, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      `).run(key, owner, now + ttlMs)
      return true
    })
  }

  releaseLease(key: string, owner: string): void {
    this.db.prepare('DELETE FROM watcher_leases WHERE key = ? AND owner = ?').run(key, owner)
  }
}
