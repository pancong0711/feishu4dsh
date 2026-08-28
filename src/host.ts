/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes.
 *
 * Keeping structural copies (instead of importing host source packages) lets
 * the package build self-contained: a composed DSH profile supplies the real
 * implementations at runtime. Field shapes mirror `@deepseek-ai/dsh-agent`,
 * `@deepseek-ai/dsh-session`, and `@deepseek-ai/dsh-user-approval` as of
 * dsh 0.1.0-rc.6.
 * @module feishu4dsh/host
 */

import type { Context } from '@deepseek-ai/cordis'

/* ------------------------------------------------------------------ */
/* Session log events                                                  */
/* ------------------------------------------------------------------ */

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The live session a host agent drives; only the identity and log are read. */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
  /** The session log; read-only here. */
  readonly events?: readonly HostSessionEvent[]
  /**
   * The routing header of the session's most recent model request, as the
   * web/headless hosts log it; absent on older hosts or before any turn.
   */
  readonly requestHeader?: () => { config?: HostRequestHeaderConfig } | undefined
}

/** One model request's provider/model routing header (subset). */
export interface HostRequestHeaderConfig {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: unknown
}

/**
 * A concrete provider/model pair, as per-agent model selection carries it.
 * `reasoningEffort` stays open for now; the field slot is reserved.
 */
export interface HostModelSelection {
  provider: string
  model: string
  reasoningEffort?: unknown
}

/** Token accounting for one model call (cache fields optional). */
export interface TokenUsageData {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** The `assistant/message` payload: the assembled answer of one step. */
export interface AssistantMessageData {
  readonly turn: number
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
  readonly usage?: TokenUsageData
}

/** The `assistant/chunk` payload: one raw assistant stream chunk. */
export interface AssistantChunkData {
  readonly turn: number
  /** Only `text-delta` blocks are rendered; reasoning stays off the wire. */
  readonly chunk: {
    readonly type: string
    readonly text?: string
    readonly usage?: TokenUsageData
  }
}

/** The `turn/start` payload. */
export interface TurnStartData {
  readonly turn: number
}

/** The `turn/end` payload. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: {
    readonly kind: string
    readonly error?: { readonly code?: string; readonly message?: string }
  }
}

/** The `tool/call` payload: one model-requested tool invocation. */
export interface ToolCallData {
  readonly turn: number
  readonly callId: string
  readonly name: string
  /** Raw arguments JSON as produced by the model (unparsed, untrusted). */
  readonly arguments: string
}

/** The `user/message` payload: a message object a turn consumed. */
export interface UserMessageEventData {
  readonly id?: string
}

export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === 'assistant/message'
}

export function isAssistantChunkEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantChunkData } {
  return event.type === 'assistant/chunk'
}

export function isTurnStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnStartData } {
  return event.type === 'turn/start'
}

export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === 'turn/end'
}

export function isToolCallEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolCallData } {
  return event.type === 'tool/call'
}

export function isUserMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: UserMessageEventData } {
  return event.type === 'user/message'
}

/** Join the text blocks of a committed assistant message. */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join('')
}

/** Render a failed turn's reason as one operator-readable line. */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  return error === undefined ? '' : `${error.code ?? 'error'}: ${error.message ?? ''}`.trimEnd()
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/** Durable metadata for one stored image, from {@link HostAttachments.saveImage}. */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: HostImageRef }

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  readonly content: readonly HostContentBlock[]
  /** Producer tag: chat input is a direct human prompt. */
  readonly source: { readonly kind: 'user' }
}

/** What one image must satisfy to be stored. */
export interface HostImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/** The `attachments` store (subset of the host `AttachmentStore`). */
export interface HostAttachments {
  readonly imageLimits: HostImageLimits
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /** Clear queued work and abort the active turn; a no-op when idle. */
  cancel(cause: string): void
  /** Resolve once the agent has no running task; absent on older hosts. */
  whenIdle?(): Promise<void>
  /**
   * Run one non-turn task from the agent's true idle phase. Throws
   * synchronously when a turn or another maintenance task owns the agent,
   * which is what makes channel-issued commands safe: every command appends
   * to the session log, and the log takes one writer.
   */
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Per-agent provider/model routing accepted by the registry. */
export interface HostAgentOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: HostAgentOptions
    readonly setup?: (agentCtx: Context) => Promise<void>
  }): Promise<HostAgentHandle>
  /** Look up a live agent by session id. */
  get?(sessionId: string): HostAgent | undefined
}

/* ------------------------------------------------------------------ */
/* Commands, tools, prompts                                            */
/* ------------------------------------------------------------------ */

/** One command this deployment offers, from {@link HostCommands.list}. */
export interface HostCommandDescriptor {
  /** Lowercase name without the leading slash. */
  readonly name: string
  readonly description: string
}

/** One settled command execution. */
export interface HostCommandExecution {
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

/**
 * The `commands` runtime: slash commands dispatched WITHOUT a model turn,
 * which is why a chat must route them here instead of letting the model
 * read a literal `/clear` as prose.
 */
export interface HostCommands {
  list(agent: HostAgent): readonly HostCommandDescriptor[]
  /**
   * Run one complete slash-command line. Resolves `undefined` when the
   * syntax or name does not resolve, which distinguishes an unknown command
   * from one that ran and failed.
   */
  execute(agent: HostAgent, line: string, signal: AbortSignal): Promise<HostCommandExecution | undefined>
}

/** The `tools` registry as per-agent composition uses it. */
export interface HostTools {
  /** Register a monotonic execution guard; returning a string denies. */
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
  /** Register a tool definition, returning its disposer. */
  register?(definition: object): () => void
}

/** The `systemPrompt` assembler, as per-agent composition uses it. */
export interface HostSystemPrompt {
  /** Register one ordered prompt section in the calling context's scope. */
  section(section: { name: string; order: number; text: string }): () => void
}

/* ------------------------------------------------------------------ */
/* Models, settings, loader                                            */
/* ------------------------------------------------------------------ */

/** The `agentDefaultModel` service. */
export interface HostDefaultModel {
  currentSelection(): HostAgentOptions
  /**
   * Persist a new deployment-wide default; absent on older hosts, in which
   * case `/model default` degrades to "not supported".
   */
  saveSelection?(selection: HostModelSelection | HostAgentOptions): Promise<void> | void
}

/**
 * The dsh-provided per-agent model-selection installer (the web/headless
 * `installModelSelection`): it wires waterfall listeners so the selection's
 * `current` routes the agent's next request. Optional — a host without it
 * degrades to "model switching unsupported" instead of failing.
 */
export interface HostInstallModelSelection {
  (agentCtx: Context, selection: {
    current: HostModelSelection | undefined
    assembled: unknown
  }): () => void
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /**
   * Account one session under this workspace. Validates the session header's
   * cwd against {@link path}, so a session created with that exact value
   * attaches and one created with an uncanonicalized variant is rejected.
   * This accounting is what dsh web uses to GROUP sessions under a
   * workspace -- without it sessions land in the ungrouped bucket. Optional:
   * absent on older hosts, where grouping is simply unavailable.
   */
  attachSession?(id: string): Promise<unknown>
}

/**
 * The `workspaceRegistry` service (subset of the host registry). Grouping is
 * accounted, not derived. Listing is optional so a deployment composing an
 * older registry still boots; `/ws` then lists only what this channel knows.
 */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one record per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
  /** Every registered workspace; absent on older registries. */
  list?(): readonly HostWorkspace[]
  /**
   * The registry-global archive set (R29; dsh ≥ 0.1.1-rc.2): session ids the
   * web UI hides everywhere. Sessions themselves are untouched on disk.
   * Absent on older hosts — archive commands then degrade to "unsupported".
   */
  archivedSessionIds?(): readonly string[]
  /**
   * Durably add one session id to the archive set. Idempotent for already
   * archived ids; throws for ids that are neither live nor in persistence.
   * No unarchive exists upstream yet — the set is one-way by design.
   */
  archiveSession?(sessionId: string): Promise<void>
}

/** The Cordis loader service; awaited so agents never see a half-grown tree. */
export interface HostLoader {
  await(): Promise<unknown>
}

/** One registered namespace's owner scope (subset of `SettingsScope`). */
export interface HostSettingsScope {
  get(): unknown
  update(patch: object): Promise<unknown>
}

/** The `settings` user-settings service. */
export interface HostSettings {
  register(ns: string, schema: unknown, options?: { base?: unknown }): HostSettingsScope
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/** Closed outcome of a host approval question; `'allowed-once'` is the only grant. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Readonly same-process permission question. */
export interface HostApprovalRequest {
  /** The agent on whose behalf the question is asked; routes the question. */
  readonly agent: HostAgent
  /** The tool the question is about. */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of why it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question; a late answer is discarded. */
  readonly signal?: AbortSignal
}

/* ------------------------------------------------------------------ */
/* Cordis declaration merging                                          */
/* ------------------------------------------------------------------ */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
    /** Waterfall permission question; answer only for owned agents, else `next()`. */
    'approval/request'(
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
  }
}
