/**
 * The glue layer: normalized Feishu events on one side, dsh agent sessions
 * on the other. This is the "对接层" of the porting playbook — the adapter
 * delivers clean messages, this module drives the agent, and replies go
 * back as streamed text, cards, and approvals.
 * @module feishu4dsh/bridge
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import type { Authorization } from './acl.js'
import { mayApprove } from './acl.js'
import type { ChannelPort, CardActionEvent, NormalizedMessage, RejectEvent } from './adapter.js'
import { resolveScopeKey, agentKeyOf, sessionIdOf, AgentLedger, type SessionScopeInput } from './sessions.js'
import { buildCatalog, listWorkspaces, resolveCdTarget, registeredPathsOf, resolveWorkspaceDirectory, normalizeWorkspacePath, type WorkspaceCatalog } from './workspaces.js'
import { approvalCard, decodeActionValue, settledApprovalCard, type CardActionPayload } from './cards.js'
import type { HostAgentHandle, HostAgentOptions, HostAgentRegistry, HostApprovalOutcome, HostApprovalRequest, HostAttachments, HostCommands, HostContentBlock, HostDefaultModel, HostInstallModelSelection, HostModelSelection, HostSession, HostSessionEvent, HostTools, HostWorkspaceRegistry, TokenUsageData } from './host.js'
import { assistantText, isAssistantChunkEvent, isAssistantMessageEvent, isToolCallEvent, isTurnEndEvent, isTurnStartEvent, isUserMessageEvent, turnErrorDetail } from './host.js'
import { installAgentModelSelection, createAgentModelSelection, defaultSelectionOf, displayedModelOf, parseModelTarget, readLoggedSelection, type AgentModelSelection, type ModelDisplay } from './model-selection.js'
import { readOutboundFile, sendFileTool, storeInboundFile, type OutboundFile, type SendFilePorts } from './files.js'
import { resolveLocale, strings, type Locale, type Strings } from './strings.js'
import { formatBytes, formatNumber, shortHash } from './util.js'

/* ------------------------------------------------------------------ */
/* Host surface the bridge needs (structurally satisfied by cordis ctx) */
/* ------------------------------------------------------------------ */

/** The narrow host surface the bridge consumes; a cordis Context fits. */
export interface BridgeHost {
  /** The agent registry; injected. */
  readonly agents: HostAgentRegistry
  /** Subscribe a handler; returns an unsubscribe function. */
  on(name: string, listener: (...args: never[]) => unknown): unknown
  /** Look up an optional host service; undefined when absent. */
  get(name: string): unknown
}

/* ------------------------------------------------------------------ */
/* Per-chat state                                                      */
/* ------------------------------------------------------------------ */

/** One chat's live binding: scope key, chat id, type, workspace, reply stream. */
export interface ChatBinding {
  readonly scopeKey: string
  readonly chatId: string
  /** p2p sends files straight through; groups gate them behind a card. */
  readonly chatType: 'p2p' | 'group'
  /** Canonical directory the chat's CURRENT session is rooted in. */
  workspacePath: string
  /** Display name of the current workspace (basename). */
  workspaceName: string
  /** The inbound message id the next reply aims at (one-shot: cleared at turn/end). */
  replyTo?: string
  /**
   * The last inbound message id this scope ever saw (R20). Unlike `replyTo`,
   * this persists across turn/end, so a turn the HOST initiates on its own
   * (subagent completion reports, job/goal injections — no inbound message,
   * no user/message restoration) can still thread its output under the
   * conversation's most recent inbound topic instead of the chat root.
   */
  lastInboundReplyTo?: string
  /** The active reply stream, when one is open. */
  stream?: ReplyStream
  /** Tool call counts for the current turn; reset at `turn/start`. */
  toolCallCounts?: Map<string, number>
  /** Whether the current turn has already appended visible text. */
  turnHasOutput?: boolean
  /** Accumulated token accounting for the current turn. */
  turnUsage?: TurnUsage
  /** Turn counter for log correlation. */
  turn: number
}

/** One open reply stream into one chat message. */
interface ReplyStream {
  append(text: string): Promise<void>
  finish(): Promise<void>
  /**
   * Whether this stream already carries round content (buffered text, or
   * anything that reached the underlying card). `handleInboundMessage`
   * PRE-OPENS a stream before the agent turn starts, so an attached stream
   * at `turn/start` is usually that fresh, still-empty placeholder — it must
   * be KEPT. Only a stream holding a previous round's payload is stale
   * residue worth reclaiming (R21 §3.3); the per-binding render queue
   * guarantees anything with payload predates the new turn/start.
   */
  hasPayload(): boolean
}

/** Accumulated token usage for one turn. */
interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/**
 * One remembered reply anchor: the Feishu message a turn's eventual output
 * should thread under. Carries the owning scopeKey so `/new` can purge the
 * entries of exactly its own scope (R22 §2.2).
 */
interface ReplyTarget {
  readonly scopeKey: string
  readonly messageId: string
}

function emptyTurnUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function accumulateUsage(target: TurnUsage, usage: TokenUsageData): void {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  target.reasoningTokens += usage.reasoningTokens ?? 0
}

function hasUsage(usage: TurnUsage): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheReadTokens > 0
    || usage.cacheWriteTokens > 0
    || usage.reasoningTokens > 0
}

/** One pending approval-question card. */
interface PendingApproval {
  readonly token: string
  readonly kind: CardActionPayload['kind']
  readonly chatId: string
  readonly sessionId: string
  readonly messageId: string
  /** Resolves the outcome once a click settles it. */
  settle(decision: 'approve' | 'deny', deciderName: string): void
  /** The timeout that fails this card closed. */
  timer: ReturnType<typeof setTimeout>
  /** The file awaiting delivery, for file-send cards. */
  file?: OutboundFile
  settled: boolean
}

/** Optional cross-cutting hooks the runtime can supply. */
export interface BridgeHooks {
  /** Persist one chat's workspace selection (survives restarts via settings). */
  onWorkspaceChange?: (scopeKey: string, workspacePath: string) => void | Promise<void>
  /** Persist the list of user-added workspaces (from `/ws add` / `/ws remove`). */
  onUserWorkspacesChange?: (workspaces: string[]) => void | Promise<void>
}

/**
 * Time-to-ready watchdog for stream-mode replies (R21 §3.1): if the SDK's
 * markdown callback has not handed us a controller within this window (hung
 * open request, throttling, WS reconnect), the stream is condemned and every
 * later `append` becomes a no-op while `finish` delivers the accumulated
 * buffer as one plain message. A constant for now; promoting it into
 * `ResolvedConfig` is deliberately deferred.
 *
 * R22 §2.1: the SAME window bounds the card-mode placeholder round-trip —
 * a placeholder that neither settles nor fails within it condemns the card,
 * and `finish` degrades to the plain-markdown path.
 */
export const REPLY_STREAM_READY_TIMEOUT_MS = 10_000

/**
 * Convergence cap for stream-mode `finish()` (R21 §3.2): waiting for the
 * SDK's send promise is raced against this window, so a turn end always
 * resolves in bounded time even when the underlying request hangs.
 *
 * R22 §2.1: the SAME cap bounds the card-mode `updateCard` round-trip inside
 * `finish()`; past it the content degrades to one plain markdown send.
 */
export const REPLY_STREAM_FINISH_TIMEOUT_MS = 30_000

/** Injectable timings (primarily for tests; production uses the defaults). */
export interface BridgeTimingOptions {
  /** Overrides {@link REPLY_STREAM_READY_TIMEOUT_MS} (stream ready / card placeholder). */
  replyReadyTimeoutMs?: number
  /** Overrides {@link REPLY_STREAM_FINISH_TIMEOUT_MS} (stream settle / card update). */
  replyFinishTimeoutMs?: number
}

/** The resolved timing knobs carried on {@link BridgeEnv}. */
export interface BridgeTiming {
  readonly replyReadyTimeoutMs: number
  readonly replyFinishTimeoutMs: number
}

/**
 * Backstop cap on remembered reply anchors (R22 §2.2): entries are consumed
 * (deleted) when the host restores their user message; anchors of turns that
 * died before restoration would otherwise accumulate forever. Past this many,
 * the OLDEST entries are pruned at turn/end. Deterministic cleanup point only
 * — deliberately no TTL/LRU.
 */
export const REPLY_TARGETS_MAX = 100

/** Dependencies every bridge call threads through. */
export interface BridgeEnv {
  readonly host: BridgeHost
  readonly config: ResolvedConfig
  readonly port: ChannelPort
  readonly authorization: Authorization
  readonly report: (line: string) => void
  readonly hooks: BridgeHooks
  /** Reply-stream liveness timings (R21); resolved from {@link BridgeTimingOptions}. */
  readonly timing: BridgeTiming
}

/**
 * What {@link installBridge} hands back: the teardown hook, plus the live
 * bridge state as a read-only observation surface for tests and diagnostics.
 */
export interface BridgeDisposer {
  (): Promise<void>
  /** The live bridge state (R22: lets regressions assert memory hygiene). */
  readonly state: BridgeState
}

/** Install the bridge and return a disposer. */
export function installBridge(
  host: BridgeHost,
  config: ResolvedConfig,
  port: ChannelPort,
  authorization: Authorization,
  report: (line: string) => void,
  hooks: BridgeHooks = {},
  timing: BridgeTimingOptions = {},
): BridgeDisposer {
  const env: BridgeEnv = {
    host,
    config,
    port,
    authorization,
    report,
    hooks,
    timing: {
      replyReadyTimeoutMs: timing.replyReadyTimeoutMs ?? REPLY_STREAM_READY_TIMEOUT_MS,
      replyFinishTimeoutMs: timing.replyFinishTimeoutMs ?? REPLY_STREAM_FINISH_TIMEOUT_MS,
    },
  }
  const state = createBridgeState()
  for (const workspace of config.userWorkspaces) state.userWorkspaces.add(workspace)
  wirePortEvents(env, state)
  wireSessionEvents(env, state)
  wireApprovals(env, state)
  return Object.assign(async (): Promise<void> => { await dispose(env, state) }, { state })
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export interface BridgeState {
  readonly ledger: AgentLedger<HostAgentHandle>
  /** scope key -> chat binding. */
  readonly chats: Map<string, ChatBinding>
  /** session id -> scope key. */
  readonly sessionScopes: Map<string, string>
  /** approval token -> pending card. */
  readonly approvals: Map<string, PendingApproval>
  /** agent key -> per-agent mutable model selection (R7/R8). */
  readonly selections: Map<string, AgentModelSelection>
  /** agent key -> in-flight creation promise, so bursts share one agent (R11). */
  readonly pendingAgents: Map<string, Promise<HostAgentHandle>>
  /** Bindings whose current turn already streamed assistant deltas. */
  readonly streamedTurns: Set<ChatBinding>
  /** userMessage.id -> Feishu anchor of the scope that produced it (R22). */
  readonly replyTargets: Map<string, ReplyTarget>
  /**
   * scope key -> tail of that binding's render queue (R21 §3.4). Session
   * events for one chat render strictly one after another, so concurrent
   * turns can never interleave writes into the same reply stream.
   */
  readonly renderQueues: Map<string, Promise<void>>
  /** Workspace paths added at runtime via `/ws add`. */
  readonly userWorkspaces: Set<string>
  /** Cached workspace catalog; rebuilt by {@link workspaceCatalogFor}. */
  workspaceCatalog: WorkspaceCatalog | undefined
  locale: Locale
  copy: Strings
  disposed: boolean
}

function createBridgeState(): BridgeState {
  return {
    ledger: new AgentLedger(),
    chats: new Map(),
    sessionScopes: new Map(),
    approvals: new Map(),
    selections: new Map(),
    pendingAgents: new Map(),
    streamedTurns: new Set(),
    replyTargets: new Map(),
    renderQueues: new Map(),
    userWorkspaces: new Set(),
    workspaceCatalog: undefined,
    locale: 'zh-CN',
    copy: strings('zh-CN'),
    disposed: false,
  }
}

/**
 * Build (and cache) the workspace catalog from the default workspace, the
 * host's registered workspaces, and the configured allowed roots.
 * @param env - bridge dependencies.
 * @param state - mutable bridge state holding the cache.
 * @returns the catalog decisions are made against.
 */
async function workspaceCatalogFor(env: BridgeEnv, state: BridgeState): Promise<WorkspaceCatalog> {
  if (state.workspaceCatalog !== undefined) return state.workspaceCatalog
  const registry = env.host.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  const registered = registeredPathsOf(registry)
  state.workspaceCatalog = await buildCatalog(
    env.config.workspace,
    registered,
    env.config.workspaceRoots,
    [...state.userWorkspaces],
  )
  return state.workspaceCatalog
}

/** Refresh the catalog so newly-registered workspaces show up next time. */
function invalidateWorkspaceCatalog(state: BridgeState): void {
  state.workspaceCatalog = undefined
}

/* ------------------------------------------------------------------ */
/* Reply streams                                                       */
/* ------------------------------------------------------------------ */

/**
 * Open a progressive reply into one chat. `stream` mode drives the SDK's
 * markdown stream via a push->pull adapter; `card` mode sends one placeholder
 * card and re-renders it on settle. Both accumulate the full text so a settle
 * always has the complete answer, and both degrade to a single final `send`.
 * @param env - bridge dependencies.
 * @param chatId - the chat to reply into.
 * @param replyTo - inbound message id to thread the reply under.
 * @returns the open reply stream.
 */
export function openReplyStream(env: BridgeEnv, chatId: string, replyTo: string | undefined, copy: Strings): ReplyStream {
  const { port } = env
  const options = replyTo === undefined ? undefined : { replyTo, replyInThread: true }
  let buffer = ''

  if (env.config.output === 'card') {
    // Card mode: one interactive card, re-rendered as content grows.
    let cardMessageId: string | undefined
    // R22 §2.1: the placeholder round-trip is raced against the same
    // time-to-ready window as stream mode. A placeholder that neither settles
    // nor fails within the window (hung request, throttling, reconnect) used
    // to park `finish()` — and with it turn/end — indefinitely; now the card
    // is condemned ("no card") and finish takes the markdown fallback below.
    let placeholderSettled = false
    let openPlaceholderGate: (() => void) | undefined
    const placeholderGate = new Promise<void>(resolve => { openPlaceholderGate = resolve })
    let placeholderTimer: ReturnType<typeof setTimeout> | undefined
    // The watchdog is armed before the request so even a synchronously
    // throwing port cannot escape the settle path's bookkeeping.
    placeholderTimer = setTimeout(() => {
      if (placeholderSettled) return
      env.report(
        `feishu4dsh: placeholder card not ready within ${env.timing.replyReadyTimeoutMs}ms;`
        + ` delivering the reply as one plain message`,
      )
      openPlaceholderGate?.()
    }, env.timing.replyReadyTimeoutMs)
    void (async () => {
      try {
        const initial = simpleCard(copy.thinking)
        const result = await port.send(chatId, { card: initial }, options)
        cardMessageId = result.messageId
      } catch (error) {
        env.report(`feishu4dsh: placeholder card failed: ${describeError(error)}`)
      } finally {
        placeholderSettled = true
        if (placeholderTimer !== undefined) {
          clearTimeout(placeholderTimer)
          placeholderTimer = undefined
        }
        openPlaceholderGate?.()
      }
    })()
    return {
      async append(text: string): Promise<void> {
        buffer += text
      },
      async finish(): Promise<void> {
        // Bounded verdict wait: the placeholder settled (with or without a
        // card id) or the watchdog condemned it. `condemned` keeps a LATE
        // placeholder from being used after degradation, so the content is
        // still delivered through exactly one path.
        await placeholderGate
        const condemned = !placeholderSettled
        const content = buffer.trim() === '' ? copy.thinking : buffer
        if (!condemned && cardMessageId !== undefined) {
          if (await tryUpdateCard(env, cardMessageId, simpleCard(content))) return
        }
        await port.send(chatId, { markdown: content }, options).catch(
          error => env.report(`feishu4dsh: reply send failed: ${describeError(error)}`),
        )
      },
      hasPayload(): boolean {
        return buffer.trim() !== ''
      },
    }
  }

  // Stream mode: progressive markdown when the port supports it.
  if (typeof port.stream === 'function') {
    let controller: StreamControllerLike | undefined
    let failed = false
    let streamed = false
    let fallbackSent = false
    let onReady: (() => void) | undefined
    const ready = new Promise<void>(resolve => { onReady = resolve })
    let resolveDone: (() => void) | undefined
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    // R21 §3.2: a failure signal that releases a finish() parked in the
    // convergence race the moment the stream is condemned (watchdog or
    // rejection), instead of making it wait out the full cap.
    let signalFailure: (() => void) | undefined
    const failure = new Promise<void>(resolve => { signalFailure = resolve })
    // Declared before `port.stream()` so a (hypothetical) synchronous
    // markdown callback can never touch it in its temporal dead zone.
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined

    /** Condemn the stream once and for all; wake every waiter. */
    const markFailed = (): void => {
      if (failed) return
      failed = true
      if (watchdogTimer !== undefined) {
        clearTimeout(watchdogTimer)
        watchdogTimer = undefined
      }
      onReady?.()
      signalFailure?.()
    }

    const sendPromise = port.stream(
      chatId,
      {
        markdown: async (streamController: StreamControllerLike) => {
          controller = streamController
          if (watchdogTimer !== undefined) {
            clearTimeout(watchdogTimer)
            watchdogTimer = undefined
          }
          onReady?.()
          await done
        },
      },
      options,
    )
    sendPromise.catch(error => {
      env.report(`feishu4dsh: stream open failed: ${describeError(error)}`)
      markFailed()
    })

    // R21 §3.1 time-to-ready watchdog: the ready gate used to be opened ONLY
    // by the SDK's first markdown callback, and every append waited on it
    // forever — one hung stream-open request silently parked the whole turn's
    // rendering until the underlying HTTP finally timed out. Now the wait is
    // bounded: past the window the stream is condemned, appends no-op into
    // the buffer, and finish delivers that buffer as one plain message.
    watchdogTimer = setTimeout(() => {
      // The controller may have arrived between timer scheduling and firing
      // (or synchronously during port.stream()); never condemn a live stream.
      if (failed || controller !== undefined) return
      env.report(
        `feishu4dsh: reply stream not ready within ${env.timing.replyReadyTimeoutMs}ms;`
        + ` delivering the buffered reply as one plain message`,
      )
      markFailed()
    }, env.timing.replyReadyTimeoutMs)

    return {
      async append(text: string): Promise<void> {
        buffer += text
        if (failed) return
        await ready
        if (failed || controller === undefined) return
        try {
          streamed = true
          await controller.append(text)
        } catch {
          // The stream could not carry this chunk; the settle still sends it.
        }
      },
      hasPayload(): boolean {
        // Anything that reached the card counts, even if only partially.
        return streamed || buffer.trim() !== ''
      },
      async finish(): Promise<void> {
        resolveDone?.()
        let openFailed = false
        let capped = false
        if (!failed) {
          // R21 §3.2 convergence cap: `sendPromise` once hung finish (and with
          // it turn/end) indefinitely when the underlying request stalled.
          // Race it against the cap and the failure signal so finish ALWAYS
          // resolves in finite time.
          let capElapsed: (() => void) | undefined
          const cappedPromise = new Promise<void>(resolve => { capElapsed = resolve })
          const capTimer = setTimeout(() => {
            capped = true
            capElapsed?.()
          }, env.timing.replyFinishTimeoutMs)
          try {
            await Promise.race([sendPromise, cappedPromise, failure])
          } catch {
            // The stream request itself failed; deliver from the buffer below.
            openFailed = true
          }
          clearTimeout(capTimer)
        }
        // Exactly one buffered fallback across every degradation shape
        // (open rejection, watchdog condemnation, convergence cap): the same
        // contract the old open-failure catch path implemented.
        if ((failed || openFailed || capped) && !streamed && !fallbackSent && buffer.trim() !== '') {
          fallbackSent = true
          await port.send(chatId, { markdown: buffer }, options).catch(
            sendError => env.report(`feishu4dsh: reply send failed: ${describeError(sendError)}`),
          )
        }
      },
    }
  }

  // Fallback: buffer, then commit once at the end.
  return {
    async append(text: string): Promise<void> {
      buffer += text
    },
    async finish(): Promise<void> {
      if (buffer.trim() === '') return
      await port.send(chatId, { markdown: buffer }, options).catch(
        error => env.report(`feishu4dsh: reply send failed: ${describeError(error)}`),
      )
    },
    hasPayload(): boolean {
      return buffer.trim() !== ''
    },
  }
}

/** The push-side controller shape `port.stream` hands to the producer. */
interface StreamControllerLike {
  append(chunk: string): Promise<void>
}

/**
 * One card-update attempt under the finish convergence cap (R22 §2.1):
 * resolves `true` when the card was re-rendered within the window, `false`
 * when the round-trip failed or outlived it — the caller then degrades to a
 * single plain markdown send, so content still arrives exactly once and
 * `finish()` always resolves in finite time.
 */
async function tryUpdateCard(env: BridgeEnv, messageId: string, card: object): Promise<boolean> {
  // A synchronously throwing port must degrade exactly like a rejected one —
  // the legacy finish() try/catch covered both, so keep that parity here:
  // the caller's markdown fallback is the only place content may land.
  let update: Promise<void>
  try {
    update = env.port.updateCard(messageId, card)
  } catch (error) {
    env.report(`feishu4dsh: card update failed: ${describeError(error)}`)
    return false
  }
  // The cap may release this race while the request is still in flight; mark
  // the promise handled so a late failure cannot surface as unhandledRejection.
  update.catch(() => undefined)
  let capped = false
  let capElapsed: (() => void) | undefined
  const cappedPromise = new Promise<void>(resolve => { capElapsed = resolve })
  const capTimer = setTimeout(() => {
    capped = true
    capElapsed?.()
  }, env.timing.replyFinishTimeoutMs)
  try {
    await Promise.race([update, cappedPromise])
  } catch (error) {
    env.report(`feishu4dsh: card update failed: ${describeError(error)}`)
    return false
  } finally {
    clearTimeout(capTimer)
  }
  if (!capped) return true
  env.report(
    `feishu4dsh: card update did not settle within ${env.timing.replyFinishTimeoutMs}ms;`
    + ` delivering the reply as one plain message`,
  )
  return false
}

/** A single markdown-element card. */
export function simpleCard(content: string): object {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ */
/* Port events: inbound messages, card clicks, policy rejections       */
/* ------------------------------------------------------------------ */

function wirePortEvents(env: BridgeEnv, state: BridgeState): void {
  env.port.on('message', (...args: unknown[]) => {
    void handleInboundMessage(env, state, args[0] as NormalizedMessage)
  })
  env.port.on('cardAction', (...args: unknown[]) => {
    void handleCardAction(env, state, args[0] as CardActionEvent)
  })
  env.port.on('reject', (...args: unknown[]) => {
    const event = args[0] as RejectEvent
    env.report(`feishu4dsh: rejected ${event.messageId} (${event.reason})`)
  })
  env.port.on('error', (...args: unknown[]) => {
    const error = args[0] as { message?: string; code?: string }
    env.report(`feishu4dsh: transport error ${error.code ?? ''}: ${error.message ?? ''}`.trim())
  })
}

/** The one inbound pipeline: scope -> media -> content -> command or turn. */
async function handleInboundMessage(env: BridgeEnv, state: BridgeState, message: NormalizedMessage): Promise<void> {
  const scopeInput: SessionScopeInput = {
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    threadId: message.threadId,
  }
  const scopeKey = resolveScopeKey(env.config, scopeInput)
  const binding = await ensureBinding(env, state, scopeKey, message.chatId, message.chatType)
  binding.replyTo = message.messageId
  // R20: remember the latest inbound anchor for the binding's whole lifetime;
  // turn/end clears only `replyTo` (one-shot semantics unchanged).
  binding.lastInboundReplyTo = message.messageId
  state.locale = resolveLocale(env.config.locale)
  state.copy = strings(state.locale)

  // A slash line routes to the command runtime, never to a model turn.
  if (message.content.trim().startsWith('/')) {
    await runCommand(env, state, binding, message.content.trim(), message.senderId)
    return
  }

  const blocks: HostContentBlock[] = []
  const notes: string[] = []
  await collectMedia(env, state, message, binding.workspacePath, blocks, notes)

  const text = message.content.trim()
  if (text !== '') blocks.push({ type: 'text', text })
  for (const note of notes) blocks.push({ type: 'text', text: note })
  if (blocks.length === 0) return

  let handle
  try {
    handle = await ensureAgent(env, state, binding)
  } catch (error) {
    env.report(`feishu4dsh: agent unavailable: ${describeError(error)}`)
    await safeSend(env, message.chatId, state.copy.turnFailed(describeError(error)), message.messageId)
    return
  }

  const userMessage = {
    id: randomUUID(),
    role: 'user' as const,
    content: blocks,
    source: { kind: 'user' as const },
  }
  state.replyTargets.set(userMessage.id, { scopeKey: binding.scopeKey, messageId: message.messageId })
  safeOpenStream(env, state, binding)
  handle.agent.followup(userMessage)
}

/**
 * Look up (or create) the binding for one scope. A first-time binding roots
 * the chat in the workspace persisted for that scope (`chatWorkspaces`), or
 * the deployment default — so a `/cd` selection survives a restart. Under
 * `chat-thread`, a brand-new topic (`chatId@threadId`) additionally inherits
 * the chat-level mapping (`chatId`) when no exact topic entry exists.
 *
 * The candidate is resolved STRICTLY to a real directory (R10), with a
 * three-step fallback so `binding.workspacePath` is ALWAYS a directory that
 * actually exists (R10-d):
 *   persisted / inherited value → configured default → daemon process cwd.
 * The last step matters when the default workspace itself is invalid (deleted,
 * renamed, hand-edited settings, empty string): keeping an unusable path would
 * make dsh root the Agent at its own fallback cwd and desync `/status` again.
 */
async function ensureBinding(env: BridgeEnv, state: BridgeState, scopeKey: string, chatId: string, chatType: 'p2p' | 'group'): Promise<ChatBinding> {
  const existing = state.chats.get(scopeKey)
  if (existing !== undefined) return existing

  let persisted = env.config.chatWorkspaces[scopeKey]
  if (persisted === undefined || persisted === '') {
    // chat-thread 新话题回退继承群聊维度映射；scopeKey 形如 chatId@threadId。
    const at = scopeKey.indexOf('@')
    if (at > 0) persisted = env.config.chatWorkspaces[scopeKey.slice(0, at)]
  }
  const initial = persisted !== undefined && persisted !== '' ? persisted : env.config.workspace

  let workspacePath = await resolveWorkspaceDirectory(initial)
  if (workspacePath === undefined) {
    // Next: the configured default workspace — unless it IS the bad value.
    if (initial !== env.config.workspace) {
      workspacePath = await resolveWorkspaceDirectory(env.config.workspace)
      if (workspacePath !== undefined) {
        env.report(
          `feishu4dsh: workspace '${initial}' for scope '${scopeKey}' is not a real directory; `
          + `fell back to default '${workspacePath}'`,
        )
      }
    }
    if (workspacePath === undefined) {
      // R10-d: the default is unusable too. Fall back to the daemon's verified
      // process cwd so `/status` shows the directory the Agent really uses,
      // with a loud hint pointing at the misconfiguration.
      workspacePath = (await resolveWorkspaceDirectory(process.cwd())) ?? process.cwd()
      env.report(
        `feishu4dsh: workspace '${initial}' for scope '${scopeKey}' is not a real directory`
        + (initial === env.config.workspace ? '' : ` (default '${env.config.workspace}' is not real either)`)
        + `; using the daemon working directory '${workspacePath}' — fix the 'workspace' setting`,
      )
    }
  }

  // R14 自愈 + 提示：当配置值无法按字面解析、需经规范清理（全角空格 U+3000 /
  // 多余空格 / NFC 变体）才得到真实目录时，报告并回写 canonical 路径。
  // 原因：dsh 沙箱的 workspace-write 写权限根 = 会话 header 里存储的 cwd；
  // 若会话曾以坏拼写（如 `20260730　-　示例目录`）创建，其 header.cwd 永远
  // 无法 realpath 到真实目录 → 沙箱把工作区内的写入判为越界 → 明明有写权限
  // 却不停申请。回写 canonical 后，sessionIdOf 也随路径变化，新会话以正确
  // cwd 创建，沙箱根与 `/status` 重新对齐。
  // 仅当「拼写本身被规范化」时处理；纯 symlink 解析（拼写不变）不在此列，
  // 避免默认工作区是软链时每次绑定都报警。
  if (normalizeWorkspacePath(initial.normalize('NFC')) !== initial.normalize('NFC')) {
    env.report(
      `feishu4dsh: workspace '${initial}' for scope '${scopeKey}' was normalized to '${workspacePath}'`
      + ` (stray whitespace / non-canonical spelling); sandbox write root now follows the canonical path`,
    )
    if (persisted !== undefined && persisted !== '') {
      try {
        await env.hooks.onWorkspaceChange?.(scopeKey, workspacePath)
      } catch (error) {
        env.report(`feishu4dsh: persist normalized workspace failed: ${describeError(error)}`)
      }
    }
  }

  const binding: ChatBinding = {
    scopeKey,
    chatId,
    chatType,
    workspacePath,
    workspaceName: basename(workspacePath),
    turn: 0,
  }
  state.chats.set(scopeKey, binding)
  return binding
}

/** Open (or reuse) the reply stream for the binding's current turn. */
function safeOpenStream(env: BridgeEnv, state: BridgeState, binding: ChatBinding): void {
  if (binding.stream === undefined) {
    // Anchor priority (R20): this turn's one-shot inbound anchor first; when
    // it is gone (turn/end cleared it), fall back to the scope's persistent
    // last-inbound anchor so a HOST-initiated turn — one that never went
    // through handleInboundMessage and gets no user/message restoration —
    // still threads under the conversation's most recent topic instead of
    // landing at the chat root. Stale sessions never reach here:
    // renderSessionEvent drops them before any stream can open.
    binding.stream = openReplyStream(env, binding.chatId, binding.replyTo ?? binding.lastInboundReplyTo, state.copy)
  }
}

async function safeSend(env: BridgeEnv, chatId: string, text: string, replyTo?: string): Promise<void> {
  await env.port.send(chatId, { markdown: text }, replyTo === undefined ? undefined : { replyTo, replyInThread: true })
    .catch(error => env.report(`feishu4dsh: send failed: ${describeError(error)}`))
}

/* ------------------------------------------------------------------ */
/* Inbound media                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch the message's resources. Non-image files always land in the current
 * workspace inbox; images land in the inbox too when `saveImagesToInbox` is
 * enabled, and additionally become model-visible blocks when vision is
 * enabled and an attachment store exists.
 */
async function collectMedia(
  env: BridgeEnv,
  state: BridgeState,
  message: NormalizedMessage,
  workspacePath: string,
  blocks: HostContentBlock[],
  notes: string[],
): Promise<void> {
  if (message.resources.length === 0) return
  const attachments = env.host.get('attachments') as HostAttachments | undefined
  let totalBytes = 0

  for (const resource of message.resources) {
    try {
      const isImage = resource.type === 'image'
      const shouldAttach = isImage && env.config.attachImages && attachments !== undefined
      const shouldSave = env.config.receiveFiles && (!isImage || env.config.saveImagesToInbox)
      if (!shouldAttach && !shouldSave) {
        if (isImage && !env.config.attachImages) {
          notes.push(state.copy.imageReceivedNote)
        } else {
          notes.push(state.copy.unsupportedMediaNote(resource.type))
        }
        continue
      }

      const resourceType = isImage ? 'image' : 'file'
      // R24: message_id only exists in bridge memory state — it must be
      // carried here so the port can use the message-scoped download API
      // (user-uploaded resources 400 on the legacy bot-scoped endpoints).
      const data = await env.port.downloadResource(resource.fileKey, resourceType, message.messageId)
      if (data.byteLength > env.config.maxReceiveFileBytes) {
        notes.push(state.copy.unsupportedMediaNote(`${resource.type} (> ${formatBytes(env.config.maxReceiveFileBytes)})`))
        continue
      }
      if (shouldAttach && data.byteLength > attachments.imageLimits.maxImageBytes) {
        notes.push(state.copy.unsupportedMediaNote('image'))
        continue
      }
      if (totalBytes + data.byteLength > env.config.maxMessageReceiveBytes) {
        notes.push(state.copy.mediaTotalTooLargeNote(formatBytes(env.config.maxMessageReceiveBytes)))
        continue
      }
      totalBytes += data.byteLength

      if (shouldAttach) {
        const ref = await attachments.saveImage({ data, mediaType: sniffMediaType(data) ?? 'image/png', name: resource.fileName })
        blocks.push({ type: 'image', attachment: ref })
      }

      if (shouldSave) {
        const messageKey = `${message.createTime}-${shortHash(message.messageId, 6)}`
        const stored = await storeInboundFile(
          workspacePath,
          messageKey,
          resource.fileName ?? `${resource.type}-${shortHash(resource.fileKey, 6)}`,
          data,
          env.config.maxReceiveFileBytes,
        )
        if (stored.ok) {
          notes.push(state.copy.fileReceivedNote(stored.file.pathInWorkspace, formatBytes(stored.file.bytes)))
        } else if (stored.refusal.code === 'too_large') {
          notes.push(state.copy.unsupportedMediaNote(`${resource.type} (> ${formatBytes(stored.refusal.limit)})`))
        } else {
          notes.push(state.copy.unsupportedMediaNote(resource.type))
        }
      }
    } catch (error) {
      env.report(`feishu4dsh: media fetch failed (${resource.type}): ${describeError(error)}`)
      notes.push(state.copy.unsupportedMediaNote(resource.type))
    }
  }
}

/** Sniff common image magic numbers; Feishu gives no content type here. */
export function sniffMediaType(data: Uint8Array): string | undefined {
  const b = data
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return undefined
}

/* ------------------------------------------------------------------ */
/* Agent lifecycle                                                     */
/* ------------------------------------------------------------------ */

/**
 * Resume the (scope × current-workspace) session, else create it rooted at
 * that workspace; both share one composition. The agent key folds in the
 * binding's CURRENT workspace, so switching workspace drives a different
 * session without touching any other workspace's context.
 *
 * Concurrent callers asking for the same agent key share one in-flight
 * creation promise (`state.pendingAgents`) — a burst of messages can never
 * double-create agents for one session id.
 */
/** The deployment's current default provider/model selection, if advertised. */
function defaultModelOf(env: BridgeEnv): HostAgentOptions {
  const defaults = env.host.get('agentDefaultModel') as HostDefaultModel | undefined
  if (defaults === undefined) return {}
  try {
    return defaults.currentSelection()
  } catch {
    return {}
  }
}

/**
 * The deployment default as a concrete provider/model selection, or undefined
 * when no usable default is advertised (or the service throws).
 */
function advertisedDefaultSelection(env: BridgeEnv): HostModelSelection | undefined {
  try {
    return defaultSelectionOf((env.host.get('agentDefaultModel') as HostDefaultModel | undefined)?.currentSelection())
  } catch {
    return undefined
  }
}

async function ensureAgent(env: BridgeEnv, state: BridgeState, binding: ChatBinding): Promise<HostAgentHandle> {
  const agentKey = agentKeyOf(binding.scopeKey, binding.workspacePath)
  const existing = state.ledger.get(agentKey)
  if (existing !== undefined) return existing.handle

  // Concurrent messages racing into a not-yet-created agent share ONE creation
  // promise: without this, two back-to-back texts can both observe an empty
  // ledger and double-create agents for the same session id.
  const pending = state.pendingAgents.get(agentKey)
  if (pending !== undefined) return pending

  const creation = createAgent(env, state, binding, agentKey)
  state.pendingAgents.set(agentKey, creation)
  try {
    return await creation
  } finally {
    state.pendingAgents.delete(agentKey)
  }
}

/** Create (or resume) the one agent for an agent key; see {@link ensureAgent}. */
async function createAgent(env: BridgeEnv, state: BridgeState, binding: ChatBinding, agentKey: string): Promise<HostAgentHandle> {
  // Wait for the loader so a first message never sees a half-grown tree.
  const loader = env.host.get('loader') as { await(): Promise<unknown> } | undefined
  if (loader !== undefined) await loader.await().catch(() => undefined)

  await registerWorkspace(env, binding.workspacePath)

  const generation = state.ledger.generationOf(agentKey)
  const sessionId = sessionIdOf(binding.scopeKey, binding.workspacePath, generation)
  const setup = composeAgentSetup(env, state, binding)
  // New agents need an explicit provider/model; without one the agent/request
  // waterfall has nothing to seed and turns fail with "has no provider/model".
  const agentOptions = defaultModelOf(env)

  let handle: HostAgentHandle
  try {
    handle = await env.host.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
  } catch {
    handle = await env.host.agents.create({
      sessionId,
      meta: {
        ...(binding.workspacePath === '' ? {} : { cwd: binding.workspacePath }),
        // Feishu sessions run the FULL coding-agent preset (fs/search/subagent/
        // workflow tools). The deployment default is `minimal`, which ships only
        // a bash terminal and cannot carry the requirement-doc → subagent
        // collaboration flow. resume() cannot change presets, so existing
        // sessions keep theirs until /new starts a fresh one. (R18)
        agentPreset: 'standard',
      },
      agentOptions,
      setup,
    })
  }
  state.ledger.set(agentKey, { handle, generation, sessionId })
  state.sessionScopes.set(sessionId, binding.scopeKey)
  return handle
}

/**
 * Best-effort: tell the host workspace registry about one directory so it
 * shows up in `/ws` for every chat. Failures are non-fatal — the channel's
 * own bookkeeping still works without a registry.
 */
async function registerWorkspace(env: BridgeEnv, workspacePath: string): Promise<void> {
  const registry = env.host.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  if (registry === undefined) return
  try {
    const existing = await registry.resolveByPath(workspacePath)
    if (existing !== undefined) return
    await registry.create(workspacePath, basename(workspacePath))
  } catch {
    // Registration is cosmetic; never block a turn on it.
  }
}

/** The per-agent composition: register the channel's tools on the agent plane. */
function composeAgentSetup(env: BridgeEnv, state: BridgeState, binding: ChatBinding): (agentCtx: Context) => Promise<void> {
  return async (agentCtx: Context) => {
    installModelSelectionForAgent(env, state, binding, agentCtx)
    const tools = agentCtx.get('tools') as HostTools | undefined
    if (env.config.sendFiles && tools !== undefined && typeof tools.register === 'function') {
      const ports: SendFilePorts = {
        deliver: (sessionId, file, signal) => deliverFile(env, state, binding, sessionId, file, signal),
        workspaceOf: () => binding.workspacePath,
        maxBytes: env.config.maxSendFileBytes,
        copy: state.copy,
      }
      tools.register(sendFileTool(ports))
    }
  }
}

/**
 * Install the per-agent mutable model selection through the host's
 * `installModelSelection` (the web/headless `selectionFor` mechanism) and keep
 * it in bridge state for `/status` and `/model`. A host without the service —
 * an older dsh — is skipped silently: switching degrades to "unsupported"
 * while every other feature keeps working.
 */
/**
 * Get (or lazily create) the mutable model selection for a chat's current
 * agent key. Creating it before an Agent exists lets `/model` pre-pin a model;
 * when the Agent is later created, `installModelSelectionForAgent` reuses the
 * same selection so the pin survives.
 */
function ensureSelection(env: BridgeEnv, state: BridgeState, binding: ChatBinding): AgentModelSelection {
  const agentKey = currentAgentKey(binding)
  const existing = state.selections.get(agentKey)
  if (existing !== undefined) return existing
  const fallback = (): HostModelSelection | undefined =>
    readLoggedSelection(state.ledger.get(agentKey)?.handle.agent.session) ?? advertisedDefaultSelection(env)
  const selection = createAgentModelSelection(fallback)
  state.selections.set(agentKey, selection)
  return selection
}

function installModelSelectionForAgent(env: BridgeEnv, state: BridgeState, binding: ChatBinding, agentCtx: Context): void {
  const agentKey = currentAgentKey(binding)
  const selection = ensureSelection(env, state, binding)
  const install = env.host.get('installModelSelection') as HostInstallModelSelection | undefined
  try {
    if (typeof install === 'function') {
      install(agentCtx, selection)
    } else if (typeof (agentCtx as { on?: unknown }).on === 'function') {
      // Production dsh does NOT expose installModelSelection as a Cordis
      // service; install the two waterfall listeners directly on the agent
      // context, matching the Web/headless behavior.
      installAgentModelSelection(agentCtx, selection)
    } else {
      env.report('feishu4dsh: installModelSelection skipped (no agentCtx.on)')
      state.selections.delete(agentKey)
      return
    }
  } catch (error) {
    env.report(`feishu4dsh: installModelSelection failed: ${describeError(error)}`)
    state.selections.delete(agentKey)
    return
  }
  state.selections.set(agentKey, selection)
}

/** The installed mutable selection for a chat's CURRENT agent, if any. */
export function selectionOf(state: BridgeState, binding: ChatBinding): AgentModelSelection | undefined {
  return state.selections.get(currentAgentKey(binding))
}

/* ------------------------------------------------------------------ */
/* Outbound files                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deliver one cleared file to its chat. Direct messages send straight
 * through; groups gate every send behind an approval card — there is no
 * switch to turn the group gate off.
 */
async function deliverFile(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  sessionId: string,
  file: OutboundFile,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const isGroup = binding.chatType === 'group'

  if (!isGroup) return sendFileBytes(env, binding.chatId, file)

  const token = randomUUID()
  const payload = { kind: 'file-send' as const, token, decision: 'deny' as const, chatId: binding.chatId }
  const cardObject = approvalCard({
    title: state.copy.sendFileApprovalTitle,
    body: state.copy.sendFileApprovalDetail(file.pathInWorkspace, file.workspaceName, formatBytes(file.bytes)),
    approveLabel: state.copy.approveButton,
    denyLabel: state.copy.denyButton,
    payload,
  })
  const anchor = replyAnchorFor(state, binding, sessionId)
  const options = anchor === undefined ? undefined : { replyTo: anchor, replyInThread: true }
  const sent = await env.port.send(binding.chatId, { card: cardObject }, options).catch(() => undefined)
  if (sent === undefined) return 'send_file could not ask the group for approval'

  const decision = await waitForCardDecision(env, state, {
    token, kind: 'file-send', chatId: binding.chatId, sessionId, messageId: sent.messageId, file,
  }, signal)
  return decision === 'approve' ? sendFileBytes(env, binding.chatId, file) : 'The group declined to send that file.'
}

async function sendFileBytes(env: BridgeEnv, chatId: string, file: OutboundFile): Promise<string | undefined> {
  try {
    const data = await readOutboundFile(file)
    await env.port.send(chatId, { file: { source: data, fileName: file.fileName } })
    return undefined
  } catch (error) {
    return `send_file failed to deliver: ${describeError(error)}`
  }
}

/** Park one pending card and wait for its human decision or a timeout. */
function waitForCardDecision(
  env: BridgeEnv,
  state: BridgeState,
  base: Omit<PendingApproval, 'settle' | 'timer' | 'settled'>,
  signal?: AbortSignal,
): Promise<'approve' | 'deny'> {
  return new Promise<'approve' | 'deny'>(resolve => {
    let done = false
    const finish = (decision: 'approve' | 'deny'): void => {
      if (done) return
      done = true
      clearTimeout(pending.timer)
      resolve(decision)
    }

    const timer = setTimeout(() => {
      void settleCard(env, state, base.token, 'deny', undefined, 'timedOut')
      finish('deny')
    }, env.config.approvalTimeoutMs)

    const pending: PendingApproval = {
      ...base,
      timer,
      settled: false,
      settle: decision => finish(decision),
    }
    state.approvals.set(base.token, pending)

    if (signal !== undefined) {
      const onAbort = (): void => finish('deny')
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/* ------------------------------------------------------------------ */
/* Card clicks                                                         */
/* ------------------------------------------------------------------ */

async function handleCardAction(env: BridgeEnv, state: BridgeState, event: CardActionEvent): Promise<void> {
  const payload = decodeActionValue(event.action.value)
  if (payload === null) return
  const pending = state.approvals.get(payload.token)
  if (pending === undefined || pending.settled) return

  // A card forwarded to another chat must not act on the original session.
  if (payload.chatId !== event.chatId) {
    await safeSend(env, event.chatId, state.copy.approvalWrongChat)
    return
  }

  const scopeKey = state.sessionScopes.get(pending.sessionId)
  const driver = scopeKey === undefined ? undefined : state.chats.get(scopeKey)
  const isDriver = driver !== undefined && driver.chatId === event.chatId
  if (!mayApprove(env.authorization, event.operator.openId, isDriver)) {
    return
  }

  pending.settled = true
  const decision: 'approve' | 'deny' = payload.decision === 'approve' ? 'approve' : 'deny'
  await settleCard(env, state, pending.token, decision, event.operator.name)
  pending.settle(decision, event.operator.name ?? event.operator.openId)
}

/** Replace one pending card with its settled state and clear its timer. */
async function settleCard(
  env: BridgeEnv,
  state: BridgeState,
  token: string,
  decision: 'approve' | 'deny',
  deciderName?: string,
  forced?: 'timedOut',
): Promise<void> {
  const pending = state.approvals.get(token)
  if (pending === undefined) return
  clearTimeout(pending.timer)
  state.approvals.delete(token)

  const title = pending.kind === 'file-send' ? state.copy.sendFileApprovalTitle : state.copy.approvalTitle
  const status = forced === 'timedOut'
    ? state.copy.approvalTimedOut
    : decision === 'approve'
      ? state.copy.approvalApprovedBy(deciderName ?? '')
      : state.copy.approvalDeniedBy(deciderName ?? '')
  const outcome = forced === 'timedOut' ? 'timedOut' : decision === 'approve' ? 'approved' : 'denied'
  await env.port.updateCard(pending.messageId, settledApprovalCard(title, status, outcome))
    .catch(error => env.report(`feishu4dsh: card settle failed: ${describeError(error)}`))
}

/* ------------------------------------------------------------------ */
/* Session events: render agent output into the chat                   */
/* ------------------------------------------------------------------ */

function wireSessionEvents(env: BridgeEnv, state: BridgeState): void {
  env.host.on('session/event', (...args: unknown[]) => {
    void renderSessionEvent(env, state, args[0] as HostSession, args[1] as HostSessionEvent)
  })
}

/**
 * Render one session event into its chat. Only the scope lookup happens
 * outside the queue (cheap filter: sessions this channel does not drive are
 * dropped without allocating a queue slot); everything else — including the
 * current-session guard, re-checked at EXECUTION time so a `/cd` mid-queue
 * still suppresses stale events — runs serialized per binding (R21 §3.4).
 */
async function renderSessionEvent(env: BridgeEnv, state: BridgeState, session: HostSession, event: HostSessionEvent): Promise<void> {
  const scopeKey = state.sessionScopes.get(session.id)
  if (scopeKey === undefined) return
  await enqueueRender(env, state, scopeKey, () => renderScopeEvent(env, state, scopeKey, session, event))
}

/**
 * Append one render task to the binding's queue and return a promise that
 * resolves when THIS task has finished. The stored tail always carries a
 * `catch`, so a failing task is reported and the chain keeps flowing — one
 * broken event must never silence every later one.
 */
function enqueueRender(env: BridgeEnv, state: BridgeState, scopeKey: string, task: () => Promise<void>): Promise<void> {
  const tail = state.renderQueues.get(scopeKey) ?? Promise.resolve()
  const next = tail.then(task).catch(error => {
    env.report(`feishu4dsh: session event render failed: ${describeError(error)}`)
  })
  state.renderQueues.set(scopeKey, next)
  return next
}

/**
 * Drop one scope's render-queue slot after letting any in-flight render drain
 * (R22 §2.2). `/new` uses this: the old session's agent is gone, so fresh
 * events must start a clean chain instead of chaining onto — and keeping
 * alive — a tail that would otherwise sit in the map forever.
 */
async function drainRenderQueue(state: BridgeState, scopeKey: string): Promise<void> {
  const tail = state.renderQueues.get(scopeKey)
  if (tail === undefined) return
  state.renderQueues.delete(scopeKey)
  await tail.catch(() => undefined)
}

/**
 * Backstop sweep for reply anchors (R22 §2.2): once {@link REPLY_TARGETS_MAX}
 * is exceeded at turn/end, drop the OLDEST entries (insertion order) back down
 * to the cap. Consumed entries are already gone; this only bounds anchors of
 * turns that died before their user message was ever restored.
 */
function pruneReplyTargets(state: BridgeState): void {
  let excess = state.replyTargets.size - REPLY_TARGETS_MAX
  if (excess <= 0) return
  for (const id of state.replyTargets.keys()) {
    if (excess <= 0) break
    state.replyTargets.delete(id)
    excess -= 1
  }
}

async function renderScopeEvent(env: BridgeEnv, state: BridgeState, scopeKey: string, session: HostSession, event: HostSessionEvent): Promise<void> {
  const binding = state.chats.get(scopeKey)
  if (binding === undefined) return

  // Only the chat's CURRENT session renders. After a /cd (or /new), a
  // still-running previous-workspace agent must not bleed its deltas,
  // summaries, or errors into the new turn's reply stream (R11). Approval
  // cards are unaffected: answerApproval routes by sessionScopes directly.
  const currentSessionId = state.ledger.get(currentAgentKey(binding))?.sessionId
  if (session.id !== currentSessionId) return

  if (isTurnStartEvent(event)) {
    // R21 §3.3 turn/start hygiene: a stream still attached here that already
    // CARRIES content is residue of an aborted previous round (hung append in
    // the pre-R21 world, lost turn/end, crash). Reclaim it fire-and-forget —
    // its finish is bounded (R21 §3.1/§3.2) and its buffered text is salvaged.
    // An attached but still-EMPTY stream is the inbound pipeline's fresh
    // pre-opened placeholder; it is kept so this round's deltas flow into it
    // instead of forking a second card. The render queue guarantees any
    // payload-bearing stream predates this turn/start.
    const stale = binding.stream
    if (stale !== undefined && stale.hasPayload()) {
      binding.stream = undefined
      void stale.finish().catch(() => undefined)
      env.report(`feishu4dsh: stale stream reclaimed at turn/start of scope ${scopeKey}`)
    }
    binding.turn = event.data.turn
    binding.toolCallCounts = new Map()
    binding.turnUsage = emptyTurnUsage()
    binding.turnHasOutput = false
    return
  }

  if (isUserMessageEvent(event)) {
    const id = event.data.id
    if (id !== undefined) {
      const replyTo = state.replyTargets.get(id)
      if (replyTo !== undefined) {
        binding.replyTo = replyTo.messageId
        state.replyTargets.delete(id)
      }
    }
    return
  }

  if (isAssistantChunkEvent(event)) {
    const chunk = event.data.chunk
    if (chunk.type === 'usage' && chunk.usage !== undefined) {
      if (binding.turnUsage === undefined) binding.turnUsage = emptyTurnUsage()
      accumulateUsage(binding.turnUsage, chunk.usage)
      return
    }
    if (chunk.type !== 'text-delta' || chunk.text === undefined || chunk.text === '') return
    safeOpenStream(env, state, binding)
    state.streamedTurns.add(binding)
    binding.turnHasOutput = true
    await binding.stream?.append(chunk.text)
    return
  }

  if (isAssistantMessageEvent(event)) {
    if (event.data.usage !== undefined) {
      if (binding.turnUsage === undefined) binding.turnUsage = emptyTurnUsage()
      accumulateUsage(binding.turnUsage, event.data.usage)
    }
    // Non-streaming routes commit one assembled message; when no chunk
    // streamed anything for this binding's current turn, this IS the answer.
    const text = assistantText(event.data)
    if (text === '') return
    if (state.streamedTurns.has(binding)) {
      // Deltas already carried this content; the committed message repeats it.
      return
    }
    safeOpenStream(env, state, binding)
    binding.turnHasOutput = true
    await binding.stream?.append(text)
    return
  }

  if (isToolCallEvent(event) && env.config.showProcess) {
    // Do not spam one message per call. Count by tool name and render a
    // compact summary when the turn ends.
    const counts = binding.toolCallCounts ??= new Map()
    counts.set(event.data.name, (counts.get(event.data.name) ?? 0) + 1)
    return
  }

  if (isTurnEndEvent(event)) {
    const detail = turnErrorDetail(event.data)
    if (detail !== '') {
      safeOpenStream(env, state, binding)
      binding.turnHasOutput = true
      await binding.stream?.append(`\n\n${state.copy.turnFailed(detail)}`)
    }
    const toolCallCounts = binding.toolCallCounts
    binding.toolCallCounts = undefined
    const usage = binding.turnUsage
    binding.turnUsage = undefined

    const summaryLines: string[] = []
    if (env.config.showProcess && toolCallCounts !== undefined && toolCallCounts.size > 0) {
      const parts = [...toolCallCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => state.copy.toolCallCountLine(name, count))
      const summary = state.copy.toolCallSummary(parts)
      if (summary !== '') summaryLines.push(`> ${summary}`)
    }
    if (usage !== undefined && hasUsage(usage)) {
      const cacheRead = usage.cacheReadTokens > 0 ? formatNumber(usage.cacheReadTokens) : undefined
      const cacheWrite = usage.cacheWriteTokens > 0 ? formatNumber(usage.cacheWriteTokens) : undefined
      const reasoning = usage.reasoningTokens > 0 ? formatNumber(usage.reasoningTokens) : undefined
      summaryLines.push(`> ${state.copy.usageSummary(
        formatNumber(usage.inputTokens),
        formatNumber(usage.outputTokens),
        cacheRead,
        cacheWrite,
        reasoning,
      )}`)
    }
    if (summaryLines.length > 0) {
      safeOpenStream(env, state, binding)
      const prefix = binding.turnHasOutput ? '\n\n' : ''
      binding.turnHasOutput = true
      await binding.stream?.append(prefix + summaryLines.join('\n'))
    }
    state.streamedTurns.delete(binding)
    const stream = binding.stream
    binding.stream = undefined
    binding.replyTo = undefined
    binding.turnHasOutput = false
    if (stream !== undefined) await stream.finish()
    // R22 §2.2: turn/end is a deterministic cleanup point — sweep reply
    // anchors that outlived their turn before the queue takes the next task.
    pruneReplyTargets(state)
  }
}

/* ------------------------------------------------------------------ */
/* Approvals: answer the host permission waterfall                     */
/* ------------------------------------------------------------------ */

function wireApprovals(env: BridgeEnv, state: BridgeState): void {
  env.host.on('approval/request', (...args: unknown[]) => {
    return answerApproval(
      env,
      state,
      args[0] as HostApprovalRequest,
      args[1] as () => Promise<HostApprovalOutcome>,
    )
  })
}

/**
 * Answer one approval question: only agents this channel owns are settled
 * here; everything else delegates to the next runner in the waterfall.
 */
async function answerApproval(
  env: BridgeEnv,
  state: BridgeState,
  request: HostApprovalRequest,
  next: () => Promise<HostApprovalOutcome>,
): Promise<HostApprovalOutcome> {
  const sessionId = request.agent.session.id
  const scopeKey = state.sessionScopes.get(sessionId)
  if (scopeKey === undefined) return next()
  const binding = state.chats.get(scopeKey)
  if (binding === undefined) return next()

  const token = randomUUID()
  const payload = { kind: 'approval' as const, token, decision: 'deny' as const, chatId: binding.chatId }
  const reasonLine = request.reason === undefined || request.reason === ''
    ? ''
    : `\n**${state.copy.approvalReasonLabel}**：${request.reason}`
  const cardObject = approvalCard({
    title: state.copy.approvalTitle,
    body: `\`${request.toolName}\`${reasonLine}`,
    approveLabel: state.copy.approveButton,
    denyLabel: state.copy.denyButton,
    payload,
  })

  let messageId: string
  try {
    const anchor = replyAnchorFor(state, binding, sessionId)
    const options = anchor === undefined ? undefined : { replyTo: anchor, replyInThread: true }
    messageId = (await env.port.send(binding.chatId, { card: cardObject }, options)).messageId
  } catch (error) {
    env.report(`feishu4dsh: approval card failed: ${describeError(error)}`)
    return next()
  }

  const decision = await waitForCardDecision(env, state, {
    token, kind: 'approval', chatId: binding.chatId, sessionId, messageId,
  }, request.signal)
  return decision === 'approve' ? 'allowed-once' : 'rejected'
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/** The ledger key for the chat's CURRENT workspace. */
function currentAgentKey(binding: ChatBinding): string {
  return agentKeyOf(binding.scopeKey, binding.workspacePath)
}

/** The session id the chat is driving right now (live or prospective). */
/**
 * The Feishu message an interactive card should thread under when asked by
 * THIS session: the inbound message that started its current turn. Undefined
 * when the asking session is not the chat's CURRENT one (e.g. a pre-/cd
 * leftover still finishing a turn) or no anchor is known — such a card then
 * lands in the chat root rather than inside a wrong topic (R17).
 */
function replyAnchorFor(state: BridgeState, binding: ChatBinding, sessionId: string): string | undefined {
  const currentSession = state.ledger.get(currentAgentKey(binding))?.sessionId
  if (currentSession !== sessionId) return undefined
  return binding.replyTo
}

function currentSessionId(state: BridgeState, binding: ChatBinding): string {
  const agentKey = currentAgentKey(binding)
  const entry = state.ledger.get(agentKey)
  if (entry !== undefined) return entry.sessionId
  return sessionIdOf(binding.scopeKey, binding.workspacePath, state.ledger.generationOf(agentKey))
}

/** Built-in channel commands; unrecognised lines fall through to the host. */
async function runCommand(env: BridgeEnv, state: BridgeState, binding: ChatBinding, line: string, senderId: string): Promise<void> {
  const chatId = binding.chatId
  const replyTo = binding.replyTo
  const name = line.split(/\s+/)[0] ?? ''

  switch (name) {
    case '/help': {
      await cmdHelp(env, state, binding, replyTo)
      return
    }
    case '/new': {
      const agentKey = currentAgentKey(binding)
      const entry = state.ledger.get(agentKey)
      if (entry !== undefined) {
        entry.handle.agent.cancel('session reset')
        await entry.handle.dispose().catch(() => undefined)
      }
      state.ledger.reset(agentKey)
      // The /model pin is bridge-owned (state.selections), not agent-owned:
      // ensureSelection hands the SAME object to the next agent when
      // installModelSelectionForAgent runs, so the choice survives the reset.
      // /new clears CONTEXT only — workspace binding and model choice stay.
      for (const [sessionId] of [...state.sessionScopes]) {
        if (entry !== undefined && sessionId === entry.sessionId) state.sessionScopes.delete(sessionId)
      }
      // R22 §2.2 memory hygiene: a reset must not leak this scope's
      // bookkeeping. The render-queue slot is drained and dropped; reply
      // anchors of messages this scope will never restore (its agent was just
      // cancelled) would otherwise sit in replyTargets forever.
      await drainRenderQueue(state, binding.scopeKey)
      for (const [id, target] of [...state.replyTargets]) {
        if (target.scopeKey === binding.scopeKey) state.replyTargets.delete(id)
      }
      await safeSend(env, chatId, state.copy.newSessionDone, replyTo)
      return
    }
    case '/stop': {
      const entry = state.ledger.get(currentAgentKey(binding))
      if (entry === undefined) {
        await safeSend(env, chatId, state.copy.nothingToStop, replyTo)
        return
      }
      entry.handle.agent.cancel('stopped from chat')
      await safeSend(env, chatId, state.copy.stopped, replyTo)
      return
    }
    case '/status': {
      await cmdStatus(env, state, binding, replyTo)
      return
    }
    case '/model': {
      await cmdModel(env, state, binding, line.slice('/model'.length).trim(), senderId, replyTo)
      return
    }
    case '/ws': {
      await cmdWs(env, state, binding, line, senderId, replyTo)
      return
    }
    case '/cd': {
      await cmdSwitchWorkspace(env, state, binding, line.slice('/cd'.length).trim(), senderId, replyTo)
      return
    }
    default: {
      // Delegate to the host command runtime when one is composed.
      const entry = state.ledger.get(currentAgentKey(binding))
      const commands = env.host.get('commands') as HostCommands | undefined
      if (entry !== undefined && commands !== undefined) {
        const controller = new AbortController()
        const execution = await commands.execute(entry.handle.agent, line, controller.signal)
        if (execution !== undefined) {
          const text = execution.result.kind === 'error'
            ? execution.result.text
            : execution.result.text ?? ''
          if (text !== '') await safeSend(env, chatId, text, replyTo)
          return
        }
      }
      await safeSend(env, chatId, state.copy.commandUnknown(line), replyTo)
      return
    }
  }
}

/** `/status`: session id, scope, current workspace (name + path), model. */
async function cmdStatus(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  const shown = resolveDisplayedModel(env, state, binding)
  const model = shown === undefined
    ? ''
    : `${shown.text}${shown.isDefaultNotStarted ? state.copy.modelDefaultNotStarted : ''}`
  const lines = [
    `**${state.copy.statusTitle}**`,
    state.copy.statusSession(currentSessionId(state, binding)),
    state.copy.statusScope(env.config.sessionScope),
    state.copy.statusWorkspace(binding.workspaceName, binding.workspacePath),
    ...model === '' ? [] : [state.copy.statusModel(model)],
    '\n/ws 列出工作区 · /cd <名称或路径> 切换工作区',
  ]
  await safeSend(env, binding.chatId, lines.join('\n'), replyTo)
}

/**
 * What `/status` (and a bare `/model`) should show: the pinned `/model` choice
 * first, then what this session actually ran last from its request header,
 * then the deployment default — tagged when it is merely "no turn yet".
 */
function resolveDisplayedModel(env: BridgeEnv, state: BridgeState, binding: ChatBinding): ModelDisplay | undefined {
  const agentKey = currentAgentKey(binding)
  const entry = state.ledger.get(agentKey)
  return displayedModelOf(
    state.selections.get(agentKey),
    entry === undefined ? undefined : entry.handle.agent.session,
    advertisedDefaultSelection(env),
  )
}

/** The session's effective provider/model right now: pin → session log → default. */
function effectiveSessionSelection(env: BridgeEnv, state: BridgeState, binding: ChatBinding): HostModelSelection | undefined {
  const agentKey = currentAgentKey(binding)
  const pinned = state.selections.get(agentKey)?.current
  if (pinned !== undefined) return pinned
  const entry = state.ledger.get(agentKey)
  const logged = readLoggedSelection(entry === undefined ? undefined : entry.handle.agent.session)
  return logged ?? advertisedDefaultSelection(env)
}

/**
 * `/model`: show or live-switch THIS session's model.
 * - `/model`                  — report the real current model and its source;
 * - `/model <provider>/<model>` — pin it; takes effect on the next turn;
 * - `/model default`          — save the session's choice as deployment default;
 * anything else answers usage. Mutating forms share `/ws add`'s ACL, and a
 * host without `installModelSelection` degrades to "unsupported".
 */
async function cmdModel(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rest: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy

  if (rest === '') {
    const shown = resolveDisplayedModel(env, state, binding)
    const text = shown === undefined
      ? `${copy.modelTitle}：${copy.modelUnknown}`
      : `${copy.modelTitle}：${shown.text}${shown.isDefaultNotStarted ? copy.modelDefaultNotStarted : ''}${copy.modelSourceSession}`
    await safeSend(env, chatId, text, replyTo)
    return
  }

  // Switching / persisting are gated like `/ws add`.
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, copy.modelNoPermission, replyTo)
    return
  }

  if (rest === 'default') {
    const defaults = env.host.get('agentDefaultModel') as HostDefaultModel | undefined
    if (defaults === undefined || typeof defaults.saveSelection !== 'function') {
      await safeSend(env, chatId, copy.modelSaveDefaultUnsupported, replyTo)
      return
    }
    const effective = effectiveSessionSelection(env, state, binding)
    if (effective === undefined) {
      await safeSend(env, chatId, `${copy.modelTitle}：${copy.modelUnknown}`, replyTo)
      return
    }
    try {
      await defaults.saveSelection(effective)
    } catch (error) {
      env.report(`feishu4dsh: save default model failed: ${describeError(error)}`)
      await safeSend(env, chatId, copy.turnFailed(describeError(error)), replyTo)
      return
    }
    env.report(`feishu4dsh: default model saved by ${senderId}: ${effective.provider}/${effective.model}`)
    await safeSend(env, chatId, copy.modelSaveDefaultDone(effective.provider, effective.model), replyTo)
    return
  }

  const target = parseModelTarget(rest)
  if (target === undefined) {
    await safeSend(env, chatId, copy.modelUsage, replyTo)
    return
  }
  const agentKey = currentAgentKey(binding)
  let selection = state.selections.get(agentKey)
  if (selection === undefined) {
    // An existing Agent whose selection is missing means installation was
    // skipped or failed; only pre-agent topics may create a pending pin.
    if (state.ledger.get(agentKey) !== undefined) {
      await safeSend(env, chatId, copy.modelUnsupported, replyTo)
      return
    }
    selection = ensureSelection(env, state, binding)
  }
  selection.current = target
  env.report(`feishu4dsh: model switched by ${senderId}: ${target.provider}/${target.model}`)
  await safeSend(env, chatId, copy.modelSwitched(target.provider, target.model), replyTo)
}

/** `/ws`: list every workspace the channel knows, marking the current one. */
async function cmdListWorkspaces(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  invalidateWorkspaceCatalog(state)
  const catalog = await workspaceCatalogFor(env, state)
  const list = listWorkspaces(catalog, binding.workspacePath)
  if (list.length === 0) {
    await safeSend(env, binding.chatId, state.copy.wsEmpty, replyTo)
    return
  }
  const lines = [`**${state.copy.wsTitle}**`]
  for (const workspace of list) {
    const tags: string[] = []
    if (workspace.current) tags.push(state.copy.wsCurrentTag)
    if (workspace.isDefault) tags.push(state.copy.wsDefaultTag)
    const tagText = tags.length === 0 ? '' : `  [${tags.join(' · ')}]`
    lines.push(`• ${workspace.name}${tagText}`)
    lines.push(`    ${workspace.path}`)
  }
  lines.push(state.copy.cdUsage)
  await safeSend(env, binding.chatId, lines.join('\n'), replyTo)
}

/**
 * Whether the sender may manage (add/remove) workspaces. Mirrors the approval
 * ACL: a configured approver list gates strictly to its members; without one,
 * the chat driver (the sender driving this conversation) may manage.
 */
function canManageWorkspaces(env: BridgeEnv, senderId: string): boolean {
  return mayApprove(env.authorization, senderId, true)
}

/** `/ws`: list by default; `add`/`remove` subcommands manage the allowed set. */
async function cmdWs(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  line: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const rest = line.trim().slice('/ws'.length).trim()
  if (rest === '') {
    await cmdListWorkspaces(env, state, binding, replyTo)
    return
  }
  const [sub, ...restParts] = rest.split(/\s+/)
  const arg = restParts.join(' ').trim()
  switch (sub) {
    case 'add':
      await cmdWsAdd(env, state, binding, arg, senderId, replyTo)
      return
    case 'remove':
    case 'rm':
      await cmdWsRemove(env, state, binding, arg, senderId, replyTo)
      return
    default:
      await safeSend(env, binding.chatId, state.copy.wsUsage, replyTo)
      return
  }
}

/**
 * `/ws add <path>`: register an existing directory as an allowed workspace so
 * it can be `/cd`-ed into — convenient from a phone without editing config.
 * Gated by the approval ACL; the addition is persisted.
 */
async function cmdWsAdd(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rawPath: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, state.copy.wsNoPermission, replyTo)
    return
  }
  const target = rawPath.trim()
  if (target === '') {
    await safeSend(env, chatId, state.copy.wsAddUsage, replyTo)
    return
  }

  // Resolve the path the same way /cd resolves relative names, then require
  // that it exists and is a directory before admitting it.
  invalidateWorkspaceCatalog(state)
  const catalog = await workspaceCatalogFor(env, state)
  const candidatePath = isAbsolute(target)
    ? target
    : resolve(dirname(catalog.defaultWorkspace.path), target)
  let canonical: string
  try {
    canonical = await realpath(candidatePath)
  } catch {
    await safeSend(env, chatId, state.copy.wsNotDirectory(target), replyTo)
    return
  }
  const info = await stat(canonical).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    await safeSend(env, chatId, state.copy.wsNotDirectory(target), replyTo)
    return
  }

  state.userWorkspaces.add(canonical)
  await registerWorkspace(env, canonical)
  invalidateWorkspaceCatalog(state)
  try {
    await env.hooks.onUserWorkspacesChange?.([...state.userWorkspaces])
  } catch (error) {
    env.report(`feishu4dsh: persist user workspaces failed: ${describeError(error)}`)
  }
  env.report(`feishu4dsh: workspace added by ${senderId}: ${canonical}`)
  await safeSend(env, chatId, state.copy.wsAdded(basename(canonical), canonical), replyTo)
}

/**
 * `/ws remove <name|path>`: drop a workspace that was added via `/ws add`.
 * Default and host-registered workspaces are protected from removal.
 */
async function cmdWsRemove(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rawTarget: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, state.copy.wsNoPermission, replyTo)
    return
  }
  const target = rawTarget.trim()
  if (target === '') {
    await safeSend(env, chatId, state.copy.wsRemoveUsage, replyTo)
    return
  }

  let matched: string | undefined
  for (const workspace of state.userWorkspaces) {
    if (workspace === target || basename(workspace) === target) {
      matched = workspace
      break
    }
  }
  if (matched === undefined) {
    await safeSend(env, chatId, state.copy.wsNotUserAdded(target), replyTo)
    return
  }

  state.userWorkspaces.delete(matched)
  invalidateWorkspaceCatalog(state)
  try {
    await env.hooks.onUserWorkspacesChange?.([...state.userWorkspaces])
  } catch (error) {
    env.report(`feishu4dsh: persist user workspaces failed: ${describeError(error)}`)
  }
  env.report(`feishu4dsh: workspace removed by ${senderId}: ${matched}`)
  await safeSend(env, chatId, state.copy.wsRemoved(basename(matched), matched), replyTo)
}

/**
 * `/cd <name|path>`: re-root the chat's session at another workspace. The
 * target must be the default, a registered workspace, or inside an allowed
 * root — anything else is refused. On success the new selection is persisted.
 *
 * Switching is gated by the same ACL as `/ws add` and `/model` (R11): with a
 * configured approver list only members may re-root a chat's session;
 * without one the chat driver may. This keeps a shared group session from
 * being redirected by any member who can merely @ the bot.
 */
async function cmdSwitchWorkspace(env: BridgeEnv, state: BridgeState, binding: ChatBinding, target: string, senderId: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, state.copy.cdNoPermission, replyTo)
    return
  }
  if (target === '') {
    await safeSend(env, chatId, state.copy.cdUsage, replyTo)
    return
  }

  invalidateWorkspaceCatalog(state)
  const catalog = await workspaceCatalogFor(env, state)
  const resolved = await resolveCdTarget(target, catalog)
  if (!resolved.ok) {
    const refusal = resolved.refusal
    if (refusal.code === 'ambiguous') {
      const names = refusal.matches.map(m => m.path).join('、')
      await safeSend(env, chatId, state.copy.cdAmbiguous(target, names), replyTo)
    } else if (refusal.code === 'not_found') {
      await safeSend(env, chatId, state.copy.cdNotFound(target), replyTo)
    } else if (refusal.code === 'not_allowed') {
      await safeSend(env, chatId, state.copy.cdNotAllowed(target), replyTo)
    } else {
      await safeSend(env, chatId, state.copy.cdUsage, replyTo)
    }
    return
  }

  const workspace = resolved.entry
  if (workspace.path === binding.workspacePath) {
    await safeSend(env, chatId, state.copy.cdSwitched(workspace.name, workspace.path), replyTo)
    return
  }

  // A live turn is writing to the old workspace; finish it before moving on.
  const stream = binding.stream
  binding.stream = undefined
  if (stream !== undefined) await stream.finish().catch(() => undefined)

  binding.workspacePath = workspace.path
  binding.workspaceName = workspace.name
  await registerWorkspace(env, workspace.path)
  invalidateWorkspaceCatalog(state)
  try {
    await env.hooks.onWorkspaceChange?.(binding.scopeKey, workspace.path)
  } catch (error) {
    env.report(`feishu4dsh: persist workspace failed: ${describeError(error)}`)
  }
  await safeSend(env, chatId, state.copy.cdSwitched(workspace.name, workspace.path), replyTo)
}

/**
 * `/help`: group commands by their source — this channel's own commands and
 * the dsh host's delegated commands — and tag each line with where it comes
 * from, so the origin of every command is unambiguous.
 */
async function cmdHelp(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  const lines: string[] = [`**${state.copy.helpTitle}**`]
  lines.push(`**${state.copy.helpChannelHeader}**`)
  for (const command of state.copy.channelCommands) {
    lines.push(`${command} [${state.copy.helpChannelTag}]`)
  }
  const hostLines = hostCommandLines(env, state, binding)
  if (hostLines.length > 0) {
    lines.push('')
    lines.push(`**${state.copy.helpHostHeader}**`)
    for (const command of hostLines) {
      lines.push(`${command} [${state.copy.helpHostTag}]`)
    }
  }
  await safeSend(env, binding.chatId, lines.join('\n'), replyTo)
}

/** Raw host command lines for the active agent, `/{name} — {description}`. */
function hostCommandLines(env: BridgeEnv, state: BridgeState, binding: ChatBinding): string[] {
  const entry = state.ledger.get(currentAgentKey(binding))
  const commands = env.host.get('commands') as HostCommands | undefined
  if (entry === undefined || commands === undefined) return []
  try {
    return commands.list(entry.handle.agent)
      .map(command => `/${command.name} — ${command.description}`)
  } catch {
    return []
  }
}

async function dispose(env: BridgeEnv, state: BridgeState): Promise<void> {
  state.disposed = true
  // R22 §2.2 memory hygiene: the per-chat tables die with the bridge. Clearing
  // them up front stops rendering/approval paths from touching state while the
  // awaits below are still unwinding. approvals/selections/pendingAgents keep
  // their existing teardown order.
  state.renderQueues.clear()
  state.chats.clear()
  state.sessionScopes.clear()
  state.replyTargets.clear()
  state.streamedTurns.clear()
  state.selections.clear()
  // Settle in-flight agent creations so the sweep below disposes their
  // handles too; failures during creation have nothing to dispose.
  for (const pending of [...state.pendingAgents.values()]) {
    await pending.catch(() => undefined)
  }
  state.pendingAgents.clear()
  // The creations awaited above only complete now, and a successful one
  // re-registers its session in `sessionScopes` — after the first sweep above.
  // Sweep the R22 tables once more so "dispose leaves every collection empty"
  // holds deterministically even when a creation raced teardown; nothing after
  // this point (the approval/ledger teardown below) repopulates them.
  state.renderQueues.clear()
  state.chats.clear()
  state.sessionScopes.clear()
  state.replyTargets.clear()
  state.streamedTurns.clear()
  for (const pending of state.approvals.values()) {
    clearTimeout(pending.timer)
  }
  state.approvals.clear()
  for (const entry of state.ledger.values()) {
    await entry.handle.dispose().catch(() => undefined)
  }
}
