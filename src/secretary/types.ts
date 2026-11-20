/**
 * SHE (Secretary Handoff Executor) domain types.
 *
 * This module is deliberately transport-agnostic: it knows nothing about
 * Feishu or the dsh host. The bridge maps `/she` commands onto the narrow
 * service interface; the OpenCode adapter implements `ExecutorAdapter`.
 * @module feishu4dsh/secretary/types
 */

/** One task's lifecycle. Only the secretary service mutates these. */
export type SecretaryTaskStatus =
  | 'queued'
  | 'dispatching'
  | 'submitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'needs_attention'
  | 'cancelled'

/** One topic's queue lifecycle. */
export type SecretaryTopicStatus = 'active' | 'paused' | 'archived'

/** A Topic is one OpenCode session + one worktree + one serial task queue. */
export interface SecretaryTopic {
  readonly id: string
  readonly scopeKey: string
  /** User-visible per-chat label, e.g. `1`; nullable while archived. */
  readonly displayNo: string | null
  readonly titleExcerpt: string
  readonly workspacePath: string
  readonly worktreePath: string
  readonly branch: string
  readonly opencodeSessionId: string | null
  readonly status: SecretaryTopicStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastActiveAt: number
  readonly deleted: boolean
}

/** One submission in a topic's serial queue. */
export interface SecretaryTask {
  readonly id: string
  readonly topicId: string
  /** Monotonic sequence inside the topic; display form is `<topic>.<seq>`. */
  readonly seq: number
  readonly status: SecretaryTaskStatus
  readonly rawHash: string
  readonly rawExcerpt: string
  readonly reportPath: string
  readonly opencodeSessionId: string | null
  readonly opencodeMessageId: string | null
  readonly error: string | null
  readonly attachments: readonly SecretaryAttachmentRef[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

/** An attachment copied into the topic worktree before dispatch. */
export interface SecretaryAttachmentRef {
  readonly fileName: string
  readonly pathInWorktree: string
  readonly bytes: number
  readonly sha256: string
}

/** In-memory bytes supplied by the channel adapter for an inbound attachment. */
export interface SecretaryAttachmentInput {
  readonly fileName: string
  readonly bytes: Uint8Array
}

/** One report or execution artifact linked to a task. */
export interface SecretaryArtifact {
  readonly id: string
  readonly taskId: string
  readonly kind: 'report'
  readonly path: string
  readonly bytes: number
  readonly createdAt: number
}

/** Context passed to an executor when binding a session. */
export interface ExecutorSessionContext {
  readonly topicId: string
  readonly existingSessionId?: string
  readonly directory: string
  readonly title: string
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly permissionRules: readonly ExecutorPermissionRule[]
}

/** OpenCode-compatible permission rule shape. */
export interface ExecutorPermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: 'allow' | 'deny' | 'ask'
}

/** Input to one executor submission. */
export interface ExecutorSubmitInput {
  readonly sessionId: string
  readonly text: string
}

/** Normalized executor poll result. */
export interface ExecutorStatus {
  readonly state: 'running' | 'succeeded' | 'failed' | 'interrupted'
  readonly outcome?: string
  readonly detail?: string
  readonly lastAssistantText?: string
}

/** The executor boundary. OpenCode is the first implementation. */
export interface ExecutorAdapter {
  createOrResumeSession(context: ExecutorSessionContext): Promise<{ readonly sessionId: string }>
  submit(input: ExecutorSubmitInput): Promise<{ readonly messageId: string }>
  status(sessionId: string): Promise<ExecutorStatus>
  interrupt(sessionId: string): Promise<void>
}

/** Worktree allocation boundary (injectable so core tests need no git). */
export interface WorktreeAllocator {
  ensure(input: {
    readonly workspacePath: string
    readonly topicId: string
    readonly titleExcerpt: string
  }): Promise<{ readonly worktreePath: string; readonly branch: string }>
  /** Remove a topic worktree (used only by explicit `/she topic remove --purge`). */
  remove?(input: { readonly workspacePath: string; readonly worktreePath: string }): Promise<void>
}

/** A command-facing summary; the bridge owns Feishu formatting. */
export interface SecretarySubmission {
  readonly topic: SecretaryTopic
  readonly task: SecretaryTask
}

/** Structured result returned by `report()`. */
export interface SecretaryReport {
  readonly task: SecretaryTask
  readonly topic: SecretaryTopic
  readonly artifact: SecretaryArtifact | null
}

/** Options for building one fixed task envelope. */
export interface EnvelopeInput {
  readonly taskId: string
  readonly topicId: string
  readonly workspacePath: string
  readonly worktreePath: string
  readonly reportPath: string
  readonly attachments: readonly SecretaryAttachmentRef[]
  readonly rawRequest: string
}
