/**
 * The glue layer: normalized Feishu events on one side, dsh agent sessions
 * on the other. This is the "对接层" of the porting playbook — the adapter
 * delivers clean messages, this module drives the agent, and replies go
 * back as streamed text, cards, and approvals.
 * @module feishu4dsh/bridge
 */

import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AGENT_PRESETS, REASONING_CHOICES, type ReasoningChoice, type ResolvedConfig } from './config.js'
import type { Authorization } from './acl.js'
import { mayApprove } from './acl.js'
import type { ChannelPort, CardActionEvent, NormalizedMessage, RejectEvent } from './adapter.js'
import { resolveScopeKey, agentKeyOf, isAgentKey, sessionIdOf, AgentLedger, type SessionScopeInput } from './sessions.js'
import { buildCatalog, listSubdirectories, listWorkspaces, resolveCdTarget, registeredPathsOf, resolveWorkspaceDirectory, normalizeWorkspacePath, type WorkspaceCatalog } from './workspaces.js'
import {
  approvalCard, collapsiblePanel, decodeActionValue, markdownElement, noteElement, settledApprovalCard, truncateMiddle,
  CARD_STREAM_MAX_CHARS, REASONING_PANEL_MAX_CHARS,
  type CardActionPayload, type MenuActionPayload,
} from './cards.js'
import type { HostAgentHandle, HostAgentOptions, HostAgentRegistry, HostApprovalOutcome, HostApprovalRequest, HostAttachments, HostCommands, HostContentBlock, HostDefaultModel, HostInstallModelSelection, HostModelSelection, HostSession, HostSessionEvent, HostTools, HostWorkspace, HostWorkspaceRegistry, TokenUsageData } from './host.js'
import { assistantText, isAssistantChunkEvent, isAssistantMessageEvent, isStepStartEvent, isToolCallEvent, isTurnEndEvent, isTurnStartEvent, isUserMessageEvent, turnErrorDetail } from './host.js'
import { EFFORT_LEVELS, installAgentModelSelection, createAgentModelSelection, defaultSelectionOf, displayedModelOf, parseModelTarget, readLoggedSelection, type AgentModelSelection, type ModelDisplay } from './model-selection.js'
import { readOutboundFile, sendFileTool, storeInboundFile, type OutboundFile, type SendFilePorts } from './files.js'
import { accumulateSessionUsage, emptySessionUsage, hasSessionUsage, statsOfEvents, type SessionUsage } from './session-stats.js'
import {
  activeRecordOf, hydrateSessionRegistry, listSessions, nextGenOf, renameSession, staleSessionsOf, touchSession,
  upsertSession, type ActiveGenMap, type SessionRecord, type SessionRegistry,
} from './session-registry.js'
import {
  MENU_TTL_MS, MenuRegistry, browseCard, createMenuId, menuDoneCard,
  menuExpiredCard, modelMenuCard, sessionMenuCard, wsMenuCard, type BrowseLabels, type MenuLabels,
  type MenuOption, type MenuState,
} from './card-menu.js'
import { resolveLocale, strings, type Locale, type Strings } from './strings.js'
import { formatBytes, formatNumber, formatStamp, shortHash } from './util.js'

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
  /**
   * R36: live process-line counters for the current turn (`step/start`,
   * reasoning character count, elapsed time). Counters only — reasoning TEXT
   * is never stored here, rendered, or buffered.
   */
  processStatus?: TurnProcessStatus
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
  /**
   * R36: replace the reply surface with ONE live process line (step / elapsed
   * / tool tallies — never reasoning text). Optional capability: surfaces
   * without a card-level `setContent` (card mode, degraded transports) omit
   * it, and the caller silently degrades to the pre-R36 path. The next
   * {@link append} replaces the status line with the reply body, so the two
   * can never interleave.
   */
  setStatus?(line: string): Promise<void>
  /**
   * R36 stage two: render the turn's reasoning on a card surface as a
   * collapsible panel. Card surfaces only — the markdown stream cannot carry a
   * second region, and omitting the member is how a surface says so (the
   * caller then keeps the stage-one process line instead).
   *
   * `title` is the CLOSING header (char count + elapsed seconds); while the
   * turn runs the surface shows its own live header (the pushed process line
   * when there is one). `content` is the full reasoning text — the surface
   * truncates it to its element budget. `expanded` is the live fold state
   * (private chats open, groups folded); `finish` always folds the panel.
   */
  setReasoning?(panel: ReasoningPanelSpec): Promise<void>
}

/**
 * R36 stage two: what one reply card's reasoning region should show. Plain
 * data — the surface owns the card JSON, the bridge owns the copy and the
 * counters.
 */
interface ReasoningPanelSpec {
  /** Closing panel header. */
  readonly title: string
  /** Full reasoning text of this turn. */
  readonly content: string
  /** Whether the panel starts expanded while the turn runs. */
  readonly expanded: boolean
}

/**
 * R36: one turn's live process-line counters. Counters only — the reasoning
 * text they summarize travels separately in {@link TurnProcessStatus.reasoningText}
 * (stage two), and neither ever reaches the reply buffer.
 */
interface TurnProcessStatus {
  /** Wall-clock turn start (ms), for the elapsed segment. */
  readonly startedAt: number
  /** Latest `step/start` step number; 0 before the first step boundary. */
  step: number
  /** Reasoning characters seen this turn (count only, never the text). */
  reasoningChars: number
  /**
   * R36 stage two: the turn's reasoning TEXT, held only while a card surface
   * renders it (config/`/reasoning` enabled and the transport card-capable).
   * It is the reasoning region's content and NEVER the body: it is not
   * buffered into `binding.stream`, not `streamedTurns`, and not
   * `turnHasOutput`. Dropped with the rest of the status at `turn/end`.
   */
  reasoningText: string
  /** Whether a live status line ever reached the reply surface. */
  shown: boolean
  /** Wall-clock of the last status push (ms); 0 = never pushed. */
  lastPushAt: number
  /** `reasoningChars` at the last push — the character-threshold gate. */
  lastPushChars: number
}

/**
 * Accumulated token usage for one turn — the same shape and accumulator as
 * the session totals in `session-stats.ts`, so `/status` and the per-turn
 * summary can never drift apart (R26 D6, one shared口径).
 */
type TurnUsage = SessionUsage

/**
 * One remembered reply anchor: the Feishu message a turn's eventual output
 * should thread under. Carries the owning scopeKey so `/new` can purge the
 * entries of exactly its own scope (R22 §2.2).
 */
interface ReplyTarget {
  readonly scopeKey: string
  readonly messageId: string
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
  /** Persist one scope's `/mode` preset override (R27). */
  onPresetChange?: (scopeKey: string, preset: string) => void | Promise<void>
  /** Persist one scope's `/reasoning` display override (R36-2). */
  onReasoningChange?: (scopeKey: string, choice: ReasoningChoice) => void | Promise<void>
  /** Persist the per-model reasoning-effort preference table (R28). */
  onModelEffortsChange?: (efforts: Record<string, string>) => void | Promise<void>
  /** Persist the `/model` picker catalog (R33: add/del/auto-learn). */
  onModelCatalogChange?: (entries: string[]) => void | Promise<void>
  /** Persist the session registry + active-generation pointers (R29). */
  onSessionsChange?: (payload: {
    sessions: SessionRegistry
    activeGen: ActiveGenMap
  }) => void | Promise<void>
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

/**
 * R36 process-line throttle: the minimum wall-clock gap between two live
 * status-line updates of one turn. 1.5 s keeps the card visibly moving during
 * a long reasoning phase without turning every delta into a card update.
 */
export const PROCESS_STATUS_MIN_INTERVAL_MS = 1_500

/**
 * R36 process-line throttle: a burst of reasoning inside the interval window
 * still forces one update once this many reasoning characters accumulated
 * (counted, never rendered).
 */
export const PROCESS_STATUS_MIN_CHARS = 200

/**
 * R36 stage two whole-card patch throttle: the minimum wall-clock gap between
 * two live updates of one reply card. The body region is what sets the pace —
 * an answer should appear to flow, not to jump every reasoning-sized window —
 * so this is much tighter than {@link PROCESS_STATUS_MIN_INTERVAL_MS}: 250 ms
 * is ~4 card patches per second per active turn, the same order as the SDK's
 * own markdown-stream default (100 ms / 50 chars).
 */
export const CARD_PATCH_MIN_INTERVAL_MS = 250

/**
 * R36 stage two whole-card patch throttle: characters (rendered reasoning +
 * body) accumulated since the last patch force one through before the interval
 * elapses, so a fast answer never lags a whole window behind.
 */
export const CARD_PATCH_MIN_CHARS = 80

/** Injectable timings (primarily for tests; production uses the defaults). */
export interface BridgeTimingOptions {
  /** Overrides {@link REPLY_STREAM_READY_TIMEOUT_MS} (stream ready / card placeholder). */
  replyReadyTimeoutMs?: number
  /** Overrides {@link REPLY_STREAM_FINISH_TIMEOUT_MS} (stream settle / card update). */
  replyFinishTimeoutMs?: number
  /** Overrides {@link PROCESS_STATUS_MIN_INTERVAL_MS} (R36 live process line). */
  processStatusMinIntervalMs?: number
  /** Overrides {@link PROCESS_STATUS_MIN_CHARS} (R36 live process line). */
  processStatusMinChars?: number
  /** Overrides {@link CARD_PATCH_MIN_INTERVAL_MS} (R36-2 whole-card patch). */
  cardPatchMinIntervalMs?: number
  /** Overrides {@link CARD_PATCH_MIN_CHARS} (R36-2 whole-card patch). */
  cardPatchMinChars?: number
}

/** The resolved timing knobs carried on {@link BridgeEnv}. */
export interface BridgeTiming {
  readonly replyReadyTimeoutMs: number
  readonly replyFinishTimeoutMs: number
  readonly processStatusMinIntervalMs: number
  readonly processStatusMinChars: number
  readonly cardPatchMinIntervalMs: number
  readonly cardPatchMinChars: number
}

/**
 * Backstop cap on remembered reply anchors (R22 §2.2): entries are consumed
 * (deleted) when the host restores their user message; anchors of turns that
 * died before restoration would otherwise accumulate forever. Past this many,
 * the OLDEST entries are pruned at turn/end. Deterministic cleanup point only
 * — deliberately no TTL/LRU.
 */
export const REPLY_TARGETS_MAX = 100

/** Upper bound of the `/model` picker catalog (R33 auto-learn + manual add). */
export const MODEL_CATALOG_CAP = 20

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
      processStatusMinIntervalMs: timing.processStatusMinIntervalMs ?? PROCESS_STATUS_MIN_INTERVAL_MS,
      processStatusMinChars: timing.processStatusMinChars ?? PROCESS_STATUS_MIN_CHARS,
      cardPatchMinIntervalMs: timing.cardPatchMinIntervalMs ?? CARD_PATCH_MIN_INTERVAL_MS,
      cardPatchMinChars: timing.cardPatchMinChars ?? CARD_PATCH_MIN_CHARS,
    },
  }
  const state = createBridgeState()
  for (const workspace of config.userWorkspaces) state.userWorkspaces.add(workspace)
  // R33: seed the picker catalog from config (order preserved, deduped).
  for (const entry of config.modelCatalog) {
    if (!state.modelCatalog.includes(entry)) state.modelCatalog.push(entry)
  }
  Object.assign(state.chatPresets, config.chatPresets)
  Object.assign(state.chatReasoning, config.chatReasoning)
  Object.assign(state.modelEfforts, config.modelEfforts)
  // R29: seed the session registry and re-point every agent key's ACTIVE
  // generation -- this is what makes a restart resume the session the chat
  // was actually on (a fresh ledger pointer alone would reset to generation
  // 0, silently dropping /new history).
  // R30: the host deep-freezes the settings document it hands us, so the
  // persisted graph MUST be rebuilt into owned mutable state — aliasing it
  // by reference made every registry mutation throw the moment a restart
  // carried a non-empty chatSessions (all messages failed before their turn).
  Object.assign(
    state.chatSessions,
    hydrateSessionRegistry(config.chatSessions, line => env.report(line)),
  )
  for (const [agentKey, gen] of Object.entries(config.chatActiveGen)) {
    if (!isAgentKey(agentKey)) {
      env.report(`feishu4dsh: chatActiveGen key '${agentKey}' is not scope§workspace — skipped`)
      continue
    }
    state.chatActiveGen[agentKey] = gen
    state.ledger.pointerTo(agentKey, gen)
  }
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
  /** `/model` picker catalog, runtime-mutable (R33): seeded from config, learned on switch. */
  readonly modelCatalog: string[]
  /** Live interactive menus (R32): menuId -> state; timers live separately. */
  readonly cardMenus: MenuRegistry
  /** menuId -> expiry timer that retires the card (R32). */
  readonly menuTimers: Map<string, NodeJS.Timeout>
  /**
   * scope key -> tail of that binding's render queue (R21 §3.4). Session
   * events for one chat render strictly one after another, so concurrent
   * turns can never interleave writes into the same reply stream.
   */
  readonly renderQueues: Map<string, Promise<void>>
  /** Workspace paths added at runtime via `/ws add`. */
  readonly userWorkspaces: Set<string>
  /** session id -> the agentPreset the agent was actually CREATED with (R26). */
  readonly sessionPresets: Map<string, string>
  /** scope key -> `/mode` preset override (seeded from config, mutated live) (R27). */
  readonly chatPresets: Record<string, string>
  /** scope key -> `/reasoning` display override (seeded from config, mutated live) (R36-2). */
  readonly chatReasoning: Record<string, string>
  /** `provider/model` -> reasoning-effort preference (seeded from config) (R28). */
  readonly modelEfforts: Record<string, string>
  /** agentKey -> known sessions with titles/stamps (R29). */
  readonly chatSessions: SessionRegistry
  /** agentKey -> ACTIVE generation pointer (R29). */
  readonly chatActiveGen: Record<string, number>
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
    modelCatalog: [],
    cardMenus: new MenuRegistry(),
    menuTimers: new Map(),
    renderQueues: new Map(),
    userWorkspaces: new Set(),
    sessionPresets: new Map(),
    chatPresets: {},
    chatReasoning: {},
    modelEfforts: {},
    chatSessions: {},
    chatActiveGen: {},
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

/** R36 stage two: how {@link openReplyStream} should shape the reply surface. */
export interface ReplyStreamOptions {
  /**
   * Render the turn as ONE live card with two regions: a collapsible reasoning
   * panel on top and the markdown body below, patched while the turn runs.
   * Set only when the deployment/scope asked for reasoning display AND the
   * transport advertises {@link ChannelPort.cardStream}; everything else keeps
   * the markdown stream (stage one) or the buffered fallback.
   */
  readonly cardReasoning?: boolean
  /** Start the reasoning panel expanded (private chats) instead of folded (groups). */
  readonly reasoningExpanded?: boolean
}

/**
 * Open a progressive reply into one chat. `stream` mode drives the SDK's
 * markdown stream via a push->pull adapter; `card` mode sends one placeholder
 * card and re-renders it on settle. Both accumulate the full text so a settle
 * always has the complete answer, and both degrade to a single final `send`.
 *
 * R36 stage two adds a third shape: `stream` output whose scope shows reasoning
 * goes through the card surface too ({@link ReplyStreamOptions.cardReasoning}),
 * so one card can carry the reasoning panel AND the body.
 * @param env - bridge dependencies.
 * @param chatId - the chat to reply into.
 * @param replyTo - inbound message id to thread the reply under.
 * @param copy - the resolved copy table for this deployment's locale.
 * @param options - R36-2 card-reasoning shaping; omitted = stage-one behaviour.
 * @returns the open reply stream.
 */
export function openReplyStream(
  env: BridgeEnv,
  chatId: string,
  replyTo: string | undefined,
  copy: Strings,
  options: ReplyStreamOptions = {},
): ReplyStream {
  const { port } = env
  const sendOptions = replyTo === undefined ? undefined : { replyTo, replyInThread: true }
  let buffer = ''

  if (env.config.output === 'card' || options.cardReasoning === true) {
    return openCardReplyStream(env, chatId, sendOptions, copy, {
      live: options.cardReasoning === true,
      expanded: options.reasoningExpanded === true,
      // The live reasoning card IS a `stream`-output surface, so it keeps the
      // streaming placeholder (already localized via `streamInitialText`'s
      // string); plain `card` output keeps its historical copy.
      placeholder: options.cardReasoning === true ? copy.streamInitial : copy.thinking,
    })
  }

  // Stream mode: progressive markdown when the port supports it.
  if (typeof port.stream === 'function') {
    let controller: StreamControllerLike | undefined
    let failed = false
    let streamed = false
    let fallbackSent = false
    /**
     * R36: whether the card currently renders a live process line rather than
     * reply text. Set by {@link ReplyStream.setStatus}, cleared by the first
     * content-bearing `append`.
     */
    let statusShown = false
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
      sendOptions,
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
          if (statusShown && typeof controller.setContent === 'function') {
            // R36 hard constraint: the card currently shows a live status line,
            // so the first real content REPLACES it with the whole buffered
            // body. Appending instead would weld the status line to the answer
            // (the SDK's merge keeps the accumulated prefix).
            statusShown = false
            await controller.setContent(buffer)
          } else {
            await controller.append(text)
          }
        } catch {
          // The stream could not carry this chunk; the settle still sends it.
        }
      },
      async setStatus(line: string): Promise<void> {
        if (failed) return
        await ready
        if (failed || controller === undefined || typeof controller.setContent !== 'function') return
        statusShown = true
        try {
          await controller.setContent(line)
        } catch {
          // Best effort: the process line is decoration, the reply is not.
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
          await port.send(chatId, { markdown: buffer }, sendOptions).catch(
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
      await port.send(chatId, { markdown: buffer }, sendOptions).catch(
        error => env.report(`feishu4dsh: reply send failed: ${describeError(error)}`),
      )
    },
    hasPayload(): boolean {
      return buffer.trim() !== ''
    },
  }
}

/**
 * R36 stage two: the card reply surface, optionally LIVE.
 *
 * One interactive card carries both regions — a collapsible reasoning panel and
 * the markdown body — and the whole card is re-rendered with `updateCard` on a
 * throttle while the turn runs. It reuses the R22 card skeleton unchanged for
 * everything that guards content delivery: the placeholder send is bounded by
 * the same time-to-ready watchdog, `finish` re-renders under the same
 * convergence cap, and a card that never became usable degrades to exactly one
 * plain markdown send. The live patches are a *decoration* on top: they are
 * chained, never awaited by the render path, and a failed patch is reported
 * (the closing `finish` patch remains the authoritative render).
 *
 * Deliberately NOT the SDK's `{ card: { initial, producer } }` stream form:
 * that controller patches from inside its own throttle timer and lets a
 * rejected patch escape as an unhandled rejection (`CardStreamControllerImpl`
 * has no `streamingFailed` guard — only the markdown controller catches), which
 * on Node ≥15 terminates the whole host process, not just the turn. Patching
 * through `port.updateCard` keeps every failure inside this module's try/catch.
 * @param env - bridge dependencies.
 * @param chatId - the chat to reply into.
 * @param options - reply threading options.
 * @param copy - the resolved copy table.
 * @param shape - live patching, the panel's initial fold state and the empty
 *   card's placeholder copy.
 * @returns the open card reply stream.
 */
function openCardReplyStream(
  env: BridgeEnv,
  chatId: string,
  options: { replyTo?: string; replyInThread?: boolean } | undefined,
  copy: Strings,
  shape: { live: boolean; expanded: boolean; placeholder: string },
): ReplyStream {
  const { port } = env
  // The body buffer == the reply body. The reasoning text lives in the caller's
  // per-turn status, reaches this surface only through `setReasoning`, and is
  // never appended here (R36 red line).
  let buffer = ''
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

  /** R36-2: the reasoning region, set by the bridge; undefined = no panel. */
  let reasoning: ReasoningPanelSpec | undefined
  /** R36-2: the last live process line pushed through {@link ReplyStream.setStatus}. */
  let statusLine: string | undefined
  /** R36-2: live whole-card patch gate (see {@link CARD_PATCH_MIN_INTERVAL_MS}). */
  let dirty = false
  let pushed = false
  let lastPushAt = 0
  let lastPushChars = 0
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  /** Serializes live patches so an older snapshot can never land last. */
  let patchChain: Promise<void> = Promise.resolve()
  /** R36-2: `turn/end` closed the live phase; nothing may patch afterwards. */
  let closed = false
  /**
   * R36-2 overflow valve: the body alone outgrew the card's budget. The card
   * keeps the head (plus a note) and `finish` delivers the full text as one
   * plain message, so a long answer is never truncated on the wire.
   */
  let overflowed = false
  let overflowHead = ''
  let fallbackSent = false

  /** Reasoning text as it will be rendered (budget applied, head+tail kept). */
  const panelContent = (): string => {
    if (reasoning === undefined) return ''
    return truncateMiddle(reasoning.content, REASONING_PANEL_MAX_CHARS, omitted => copy.reasoningOmitted(formatNumber(omitted))).text
  }
  const panelVisible = (): boolean => reasoning !== undefined && reasoning.content !== ''
  /** Rendered characters of the reasoning region — half of the card's budget. */
  const panelChars = (): number => panelContent().length

  const buildCard = (): object => {
    const panel = reasoning
    const elements: unknown[] = []
    if (panel !== undefined && panel.content !== '') {
      elements.push(collapsiblePanel({
        // While the turn runs the header carries the live progress line (the
        // panel's own live title until one was pushed); `finish` folds the
        // panel onto the closing header the bridge handed over.
        title: closed ? panel.title : statusLine ?? panel.title,
        content: panelContent(),
        expanded: closed ? false : shape.expanded,
      }))
    } else if (!closed && statusLine !== undefined && buffer.trim() === '') {
      // R36 stage one's live process line, carried as a note on the card
      // surface. Only until the panel or the body takes over — never residue.
      elements.push(noteElement(statusLine))
    }
    if (buffer.trim() !== '') {
      elements.push(markdownElement(overflowed ? `${overflowHead}\n\n${copy.reasoningBodyOverflowNote}` : buffer))
    } else if (elements.length === 0) {
      // Nothing to show yet (or nothing at all): the localized placeholder this
      // surface opened with.
      elements.push(markdownElement(shape.placeholder))
    }
    return { elements }
  }

  /** Rendered characters of the whole card — the throttle's character gate. */
  const renderedChars = (): number => panelChars() + buffer.length + (statusLine?.length ?? 0)

  const patch = (card: object): void => {
    const messageId = cardMessageId
    if (messageId === undefined) return
    patchChain = patchChain
      .then(() => {
        // A link still queued when `turn/end` closed the card is dropped: the
        // closing render below is authoritative, and replaying an older
        // snapshot after it would leave the card on a stale live frame.
        if (closed) return
        return env.port.updateCard(messageId, card)
      })
      .catch(error => env.report(`feishu4dsh: live card update failed: ${describeError(error)}`))
  }

  const maybePush = (): void => {
    if (!shape.live || closed || !dirty || cardMessageId === undefined) return
    const now = Date.now()
    const chars = renderedChars()
    if (pushed
      && now - lastPushAt < env.timing.cardPatchMinIntervalMs
      && chars - lastPushChars < env.timing.cardPatchMinChars) {
      // Inside the window: fold this change into ONE trailing patch instead of
      // dropping it, so the card's last live frame is never stale for the whole
      // remainder of the turn.
      if (pushTimer === undefined) {
        pushTimer = setTimeout(() => {
          pushTimer = undefined
          if (closed) return
          pushed = true
          dirty = false
          lastPushAt = Date.now()
          lastPushChars = renderedChars()
          patch(buildCard())
        }, Math.max(0, env.timing.cardPatchMinIntervalMs - (now - lastPushAt)))
      }
      return
    }
    pushed = true
    dirty = false
    lastPushAt = now
    lastPushChars = chars
    patch(buildCard())
  }

  void (async () => {
    try {
      const result = await port.send(chatId, { card: buildCard() }, options)
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
      // A delta that arrived before the placeholder settled still has to land.
      maybePush()
    }
  })()

  /** What a degraded (non-card) delivery must carry to not lose content. */
  const fallbackText = (): string => {
    if (buffer.trim() !== '') return buffer
    if (panelVisible()) return `${reasoning?.title ?? ''}\n\n${panelContent()}`.trim()
    return shape.placeholder
  }

  const sendFallback = async (text: string): Promise<void> => {
    if (fallbackSent) return
    fallbackSent = true
    await port.send(chatId, { markdown: text }, options).catch(
      error => env.report(`feishu4dsh: reply send failed: ${describeError(error)}`),
    )
  }

  return {
    async append(text: string): Promise<void> {
      buffer += text
      // R36-2 overflow valve: once the body no longer fits beside the panel,
      // freeze the card's body at the head and leave the rest to `finish`.
      if (!overflowed) {
        const budget = CARD_STREAM_MAX_CHARS - panelChars()
        if (buffer.length > budget) {
          overflowed = true
          overflowHead = buffer.slice(0, Math.max(0, budget))
          env.report(
            `feishu4dsh: reply body exceeds the card budget (${CARD_STREAM_MAX_CHARS} chars);`
            + ` the card keeps the head and the full text follows as one message`,
          )
        }
      }
      dirty = true
      maybePush()
    },
    async setStatus(line: string): Promise<void> {
      statusLine = line
      dirty = true
      maybePush()
    },
    async setReasoning(panel: ReasoningPanelSpec): Promise<void> {
      reasoning = panel
      dirty = true
      maybePush()
    },
    hasPayload(): boolean {
      // The red line: only BODY text counts as payload. A card carrying a
      // reasoning panel (or a process line) is still an empty reply as far as
      // `turn/start` reclamation and `assistant/message` dedup are concerned.
      return buffer.trim() !== ''
    },
    async finish(): Promise<void> {
      // Bounded verdict wait: the placeholder settled (with or without a
      // card id) or the watchdog condemned it. `condemned` keeps a LATE
      // placeholder from being used after degradation, so the content is
      // still delivered through exactly one path.
      await placeholderGate
      const condemned = !placeholderSettled
      closed = true
      if (pushTimer !== undefined) {
        clearTimeout(pushTimer)
        pushTimer = undefined
      }
      if (!condemned && cardMessageId !== undefined) {
        // Live patches are fire-and-forget; let the ones already in flight land
        // before the closing render so the card does not end on an older
        // snapshot — but BOUNDED, like every other transport wait in this
        // module (R21 §3.2): a hung patch must never park turn/end. Links still
        // queued past this point see `closed` and drop themselves.
        await settleWithin(patchChain, env.timing.replyFinishTimeoutMs)
        if (await tryUpdateCard(env, cardMessageId, buildCard())) {
          if (overflowed) await sendFallback(buffer)
          return
        }
      }
      await sendFallback(fallbackText())
    },
  }
}

/** The push-side controller shape `port.stream` hands to the producer. */
interface StreamControllerLike {
  append(chunk: string): Promise<void>
  /**
   * Replace the whole markdown element (R36). The SDK's
   * `MarkdownStreamController` implements it; older/other implementations may
   * not, and the bridge then keeps the pre-R36 rendering path untouched.
   */
  setContent?(full: string): Promise<void>
}

/**
 * Await one piece of fire-and-forget work, but never longer than `timeoutMs`
 * (R21 §3.2 discipline: every transport wait is bounded so a hung request can
 * never park turn/end). The work promise is expected to carry its own catch.
 */
async function settleWithin(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const capped = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  try {
    await Promise.race([work, capped])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
    handle = await ensureAgent(env, state, binding, text !== '' ? text : undefined)
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
    binding.stream = openReplyStream(
      env,
      binding.chatId,
      binding.replyTo ?? binding.lastInboundReplyTo,
      state.copy,
      {
        // R36-2: only a card-capable transport can render the two-region reply;
        // everything else keeps the markdown stream or the buffered fallback.
        cardReasoning: env.config.output === 'stream'
          && env.port.cardStream === true
          && reasoningDisplayOf(env, state, binding).enabled,
        // R36-2 Q2: private chats open the reasoning panel, groups fold it.
        reasoningExpanded: binding.chatType === 'p2p',
      },
    )
  }
}

async function safeSend(env: BridgeEnv, chatId: string, text: string, replyTo?: string): Promise<void> {
  await env.port.send(chatId, { markdown: text }, replyTo === undefined ? undefined : { replyTo, replyInThread: true })
    .catch(error => env.report(`feishu4dsh: send failed: ${describeError(error)}`))
}

/* ------------------------------------------------------------------ */
/* R36 process line (counters only — never reasoning text)             */
/* ------------------------------------------------------------------ */

/** Whole seconds since a turn started; never negative. */
function elapsedSeconds(startedAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - startedAt) / 1000))
}

/**
 * `bash × 2、edit × 1` for one turn's tool counters, `''` when nothing was
 * called. Sorted by name so the line is stable; joined with the same
 * separator the turn-end tool summary uses (one source of copy).
 */
function toolTally(copy: Strings, counts: Map<string, number> | undefined): string {
  if (counts === undefined || counts.size === 0) return ''
  const parts = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => copy.toolCountCompact(name, count))
  return copy.toolCallSummary(parts)
}

/**
 * Push the turn's live process line onto the reply surface (R36).
 *
 * Throttled by {@link BridgeTiming.processStatusMinIntervalMs} /
 * {@link BridgeTiming.processStatusMinChars}: the first process event of a
 * turn always pushes (so the card starts moving immediately), later ones only
 * once the window or the character threshold is crossed. The line carries
 * step / elapsed seconds / tool tallies and NOTHING from the reasoning text —
 * which is why reasoning deltas never touch the reply buffer.
 *
 * Silently degrades when the surface cannot take a status line: card output,
 * a port without `stream`, or a controller without `setContent` all keep the
 * pre-R36 rendering path, without an error and without an extra message.
 * `showProcess: false` disables the whole feature exactly as it disabled the
 * per-turn tool summary before.
 */
async function showProcessStatus(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  status: TurnProcessStatus,
): Promise<void> {
  if (!env.config.showProcess) return
  // Stream mode only: `output: 'card'` re-renders one placeholder at settle
  // time, and its `copy.thinking` placeholder is already localized. A port with
  // neither the markdown stream nor the card surface has nowhere to put it.
  if (env.config.output !== 'stream') return
  if (typeof env.port.stream !== 'function' && env.port.cardStream !== true) return
  const now = Date.now()
  const due = !status.shown
    || now - status.lastPushAt >= env.timing.processStatusMinIntervalMs
    || status.reasoningChars - status.lastPushChars >= env.timing.processStatusMinChars
  if (!due) return
  // Open the reply surface on the first process event so a turn that never
  // produces body text still shows progress (host-initiated turns have no
  // pre-opened placeholder).
  safeOpenStream(env, state, binding)
  const stream = binding.stream
  if (stream?.setStatus === undefined) return
  status.shown = true
  status.lastPushAt = now
  status.lastPushChars = status.reasoningChars
  await stream.setStatus(state.copy.processLine(
    status.step,
    elapsedSeconds(status.startedAt, now),
    toolTally(state.copy, binding.toolCallCounts),
  ))
}

/* ------------------------------------------------------------------ */
/* R36 stage two: reasoning display switch and panel                   */
/* ------------------------------------------------------------------ */

/**
 * R36-2: whether this scope shows reasoning, and where that answer comes from.
 * Chain mirrors `/mode`'s preset chain — an explicit scope override
 * (`/reasoning on|off`) wins over the deployment's `showReasoning` default.
 */
function reasoningDisplayOf(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
): { enabled: boolean; source: 'scope' | 'config' } {
  const override = state.chatReasoning[binding.scopeKey]
  if (override === 'on') return { enabled: true, source: 'scope' }
  if (override === 'off') return { enabled: false, source: 'scope' }
  return { enabled: env.config.showReasoning, source: 'config' }
}

/**
 * R36-2: whether this turn's reasoning belongs in a reply card panel at all.
 * Stream output needs a card-capable transport (otherwise the markdown stream
 * cannot carry a second region); `card` output is a card by construction.
 */
function reasoningPanelEnabled(env: BridgeEnv, state: BridgeState, binding: ChatBinding): boolean {
  if (!reasoningDisplayOf(env, state, binding).enabled) return false
  return env.config.output === 'card' || env.port.cardStream === true
}

/** R36-2: the panel header for one moment of the turn (live vs closing). */
function reasoningPanelTitle(copy: Strings, status: TurnProcessStatus, final: boolean): string {
  const chars = formatNumber(status.reasoningChars)
  const seconds = elapsedSeconds(status.startedAt)
  return final
    ? copy.reasoningPanelTitleDone(chars, seconds)
    : copy.reasoningPanelTitleLive(chars, seconds)
}

/**
 * R36-2: hand the turn's reasoning to a card surface. Silent no-op on surfaces
 * without a reasoning region (markdown stream, degraded transports) — the
 * turn's copy then keeps the stage-one process line / "reasoning only" summary.
 *
 * The reasoning text travels through this call ONLY: it is never appended to
 * the reply buffer and never marks the binding as streamed.
 */
async function showReasoningPanel(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  status: TurnProcessStatus,
  final = false,
): Promise<void> {
  if (!reasoningPanelEnabled(env, state, binding) || status.reasoningText === '') return
  safeOpenStream(env, state, binding)
  const stream = binding.stream
  if (stream?.setReasoning === undefined) return
  await stream.setReasoning({
    // The closing header is handed over at `turn/end`; until then the surface
    // may prefer its own live process line over this one.
    title: reasoningPanelTitle(state.copy, status, final),
    content: status.reasoningText,
    expanded: binding.chatType === 'p2p',
  })
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

async function ensureAgent(env: BridgeEnv, state: BridgeState, binding: ChatBinding, hintText?: string): Promise<HostAgentHandle> {
  const agentKey = agentKeyOf(binding.scopeKey, binding.workspacePath)
  const existing = state.ledger.get(agentKey)
  if (existing !== undefined) return existing.handle

  // Concurrent messages racing into a not-yet-created agent share ONE creation
  // promise: without this, two back-to-back texts can both observe an empty
  // ledger and double-create agents for the same session id.
  const pending = state.pendingAgents.get(agentKey)
  if (pending !== undefined) return pending

  const creation = createAgent(env, state, binding, agentKey, hintText)
  state.pendingAgents.set(agentKey, creation)
  try {
    return await creation
  } finally {
    state.pendingAgents.delete(agentKey)
  }
}

/**
 * The agentPreset this channel creates sessions with (R18: the deployment
 * default `minimal` cannot carry the fs/subagent collaboration flow). R27
 * turns this into a configurable chain (scope override -> deployment default).
 */
const CHANNEL_DEFAULT_PRESET = 'standard'

/**
 * Validate a configured preset value against the known list, falling back to
 * the given default when it is missing or unknown (hand-edited settings must
 * not poison `agents.create`).
 */
function resolvePreset(raw: string | undefined, fallback: string): string {
  const value = raw?.trim()
  return value !== undefined && value !== '' && (AGENT_PRESETS as readonly string[]).includes(value)
    ? value
    : fallback
}

/** The preset the NEXT new session of this scope will be created with (R27). */
function nextPresetOf(env: BridgeEnv, state: BridgeState, binding: ChatBinding): string {
  return resolvePreset(state.chatPresets[binding.scopeKey], resolvePreset(env.config.agentPreset, CHANNEL_DEFAULT_PRESET))
}

/** Create (or resume) the one agent for an agent key; see {@link ensureAgent}. */
async function createAgent(env: BridgeEnv, state: BridgeState, binding: ChatBinding, agentKey: string, hintText?: string): Promise<HostAgentHandle> {
  // Wait for the loader so a first message never sees a half-grown tree.
  const loader = env.host.get('loader') as { await(): Promise<unknown> } | undefined
  if (loader !== undefined) await loader.await().catch(() => undefined)

  await registerWorkspace(env, binding.workspacePath)

  const generation = state.ledger.generationOf(agentKey)
  const sessionId = sessionIdOf(binding.scopeKey, binding.workspacePath, generation)
  // R29b: resolve (or lazily create) the workspace record so the session can
  // be ACCOUNTED under it below -- without attachSession, dsh web groups
  // every channel session as ungrouped.
  const workspaceRecord = await registerWorkspace(env, binding.workspacePath)
  const setup = composeAgentSetup(env, state, binding)
  // New agents need an explicit provider/model; without one the agent/request
  // waterfall has nothing to seed and turns fail with "has no provider/model".
  const agentOptions = defaultModelOf(env)
  // R27: preset chain — scope override (`/mode`) first, deployment default
  // second, channel fallback last.
  const preset = nextPresetOf(env, state, binding)

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
        agentPreset: preset,
      },
      agentOptions,
      setup,
    })
  }
  // R26: remember what THIS session was created with so /status can show the
  // real mode; resumed sessions stay unrecorded (the host does not report the
  // preset of a persisted session) and fall back to the channel default.
  state.sessionPresets.set(sessionId, preset)
  state.ledger.set(agentKey, { handle, generation, sessionId })
  state.sessionScopes.set(sessionId, binding.scopeKey)
  // R29: register the session (title from the first message's hint) and mark
  // it ACTIVE -- the pointer this chat resumes after a restart.
  upsertSession(state.chatSessions, agentKey, generation, sessionId, { hintText, now: Date.now() })
  state.chatActiveGen[agentKey] = generation
  persistSessions(env, state)
  // R29b: account the session under its workspace (best-effort -- failures
  // are logged and retried on the next resume, which also heals sessions
  // created before this change). Without this, dsh web shows every channel
  // session as ungrouped.
  try {
    await workspaceRecord?.attachSession?.(sessionId)
  } catch (error) {
    env.report(`feishu4dsh: attach session to workspace failed: ${describeError(error)}`)
  }
  return handle
}

/**
 * Best-effort: tell the host workspace registry about one directory so it
 * shows up in `/ws` for every chat. Failures are non-fatal — the channel's
 * own bookkeeping still works without a registry.
 */
async function registerWorkspace(env: BridgeEnv, workspacePath: string): Promise<HostWorkspace | undefined> {
  const registry = env.host.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  if (registry === undefined) return undefined
  try {
    const existing = await registry.resolveByPath(workspacePath)
    if (existing !== undefined) return existing
    // Registration is cosmetic; never block a turn on it.
    return await registry.create(workspacePath, basename(workspacePath))
  } catch {
    return undefined
  }
}

/** The chat that owns one session, resolved live (R33): unknown → undefined. */
function resolveBindingOf(state: BridgeState, sessionId: string): ChatBinding | undefined {
  const scopeKey = state.sessionScopes.get(sessionId)
  return scopeKey === undefined ? undefined : state.chats.get(scopeKey)
}

/** The per-agent composition: register the channel's tools on the agent plane. */
function composeAgentSetup(env: BridgeEnv, state: BridgeState, binding: ChatBinding): (agentCtx: Context) => Promise<void> {
  return async (agentCtx: Context) => {
    installModelSelectionForAgent(env, state, binding, agentCtx)
    const tools = agentCtx.get('tools') as HostTools | undefined
    if (env.config.sendFiles && tools !== undefined && typeof tools.register === 'function') {
      const ports: SendFilePorts = {
        // R33: resolve the calling session's chat AT EXECUTION TIME — the
        // registered closure must never deliver via a stale/other chat's
        // binding (the "file lands in the private chat" bug).
        deliver: (sessionId, file, signal) => {
          const owner = resolveBindingOf(state, sessionId)
          if (owner === undefined) return Promise.resolve('send_file found no chat for this session')
          return deliverFile(env, state, owner, sessionId, file, signal)
        },
        workspaceOf: sessionId => resolveBindingOf(state, sessionId)?.workspacePath,
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
  // R28: the selection composes the per-model effort preference, so BOTH
  // installer paths (host service and local waterfall) route it.
  const selection = createAgentModelSelection(fallback, sel => state.modelEfforts[`${sel.provider}/${sel.model}`])
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

  // R25: file messages thread under the conversation's current anchor exactly
  // like every other output path (text / stream / approval cards). ONE anchor
  // is taken here and reused for both the group's approval card and the
  // delivered file, so card and file land in the same topic — the file used
  // to be the only anchor-less output and fell at the chat root (p2p topic or
  // group alike).
  const anchor = replyAnchorFor(state, binding, sessionId)
  const options = anchor === undefined ? undefined : { replyTo: anchor, replyInThread: true }

  if (!isGroup) return sendFileBytes(env, binding.chatId, file, options)

  const token = randomUUID()
  const payload = { kind: 'file-send' as const, token, decision: 'deny' as const, chatId: binding.chatId }
  const cardObject = approvalCard({
    title: state.copy.sendFileApprovalTitle,
    body: state.copy.sendFileApprovalDetail(file.pathInWorkspace, file.workspaceName, formatBytes(file.bytes)),
    approveLabel: state.copy.approveButton,
    denyLabel: state.copy.denyButton,
    payload,
  })
  const sent = await env.port.send(binding.chatId, { card: cardObject }, options).catch(() => undefined)
  if (sent === undefined) return 'send_file could not ask the group for approval'

  const decision = await waitForCardDecision(env, state, {
    token, kind: 'file-send', chatId: binding.chatId, sessionId, messageId: sent.messageId, file,
  }, signal)
  return decision === 'approve'
    ? sendFileBytes(env, binding.chatId, file, options)
    : 'The group declined to send that file.'
}

async function sendFileBytes(
  env: BridgeEnv,
  chatId: string,
  file: OutboundFile,
  options?: { replyTo?: string; replyInThread?: boolean },
): Promise<string | undefined> {
  try {
    const data = await readOutboundFile(file)
    await env.port.send(chatId, { file: { source: data, fileName: file.fileName } }, options)
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

/* ------------------------------------------------------------------ */
/* Interactive menus (R32): /ws picker, /ws new browser, /model picker, */
/* /session picker. One live menu per (scope, kind); clicks re-check    */
/* the ACL of the underlying command with the CLICKER's identity.       */
/* ------------------------------------------------------------------ */

/** Register a menu and arm its expiry timer. */
function registerMenu(env: BridgeEnv, state: BridgeState, menu: MenuState): void {
  state.cardMenus.put(menu)
  const timer = setTimeout(() => {
    state.menuTimers.delete(menu.id)
    if (state.cardMenus.get(menu.id, Date.now()) === 'expired') {
      state.cardMenus.remove(menu.id)
      if (menu.messageId !== undefined) {
        void env.port.updateCard(menu.messageId, menuExpiredCard(state.copy.menuExpired))
          .catch(() => undefined)
      }
    }
  }, MENU_TTL_MS)
  timer.unref?.()
  state.menuTimers.set(menu.id, timer)
}

/** Retire one menu: stop its timer, drop it, and swap the card to settled. */
async function settleMenu(env: BridgeEnv, state: BridgeState, menu: MenuState, title: string, body: string): Promise<void> {
  const timer = state.menuTimers.get(menu.id)
  if (timer !== undefined) {
    clearTimeout(timer)
    state.menuTimers.delete(menu.id)
  }
  state.cardMenus.remove(menu.id)
  if (menu.messageId !== undefined) {
    await env.port.updateCard(menu.messageId, menuDoneCard(title, body)).catch(() => undefined)
  }
}

/** Clear every menu of one scope (session switch / `/new` hygiene). */
function dropScopeMenus(state: BridgeState, scopeKey: string): void {
  for (const menu of state.cardMenus.all()) {
    if (menu.scopeKey !== scopeKey) continue
    const timer = state.menuTimers.get(menu.id)
    if (timer !== undefined) {
      clearTimeout(timer)
      state.menuTimers.delete(menu.id)
    }
    state.cardMenus.remove(menu.id)
  }
}

/** Re-render one paged/browse card in place after a navigation click. */
async function refreshMenuCard(env: BridgeEnv, state: BridgeState, menu: MenuState): Promise<void> {
  if (menu.messageId === undefined) return
  // Model menus re-sync their options from the LIVE catalog so addcur/learn
  // reflect immediately (the send-time snapshot would go stale).
  if (menu.kind === 'model') {
    menu.options = state.modelCatalog.map(entry => ({
      label: entry,
      disabled: entry === menu.currentModel,
    }))
  }
  const cardObject = menu.kind === 'browse'
    ? browseCard(menu.chatId, menu, browseLabelsFor(state))
    : menu.kind === 'model'
      ? modelMenuCard(menu.chatId, menu, modelMenuLabels(state))
      : undefined
  if (cardObject === undefined) return
  await env.port.updateCard(menu.messageId, cardObject).catch(error => {
    env.report(`feishu4dsh: menu card update failed: ${describeError(error)}`)
  })
}

function modelMenuLabels(state: BridgeState): MenuLabels & { title: string } {
  return {
    title: state.copy.modelMenuTitle,
    prev: state.copy.menuPrevLabel,
    next: state.copy.menuNextLabel,
    pageOf: state.copy.menuPageOf,
    placeholder: state.copy.modelMenuPlaceholder,
    expiredNote: state.copy.modelMenuExpiredNote,
    addCurrent: state.copy.modelAddCurButton,
  }
}

function browseLabelsFor(state: BridgeState): BrowseLabels {
  return {
    title: path => path,
    empty: state.copy.browseEmpty,
    confirm: state.copy.browseConfirm,
    parent: state.copy.browseParent,
    note: state.copy.browseNote,
    prev: state.copy.menuPrevLabel,
    next: state.copy.menuNextLabel,
    pageOf: state.copy.menuPageOf,
  }
}

/**
 * One menu-card click: expiry, forward and ACL guards, then act routing.
 * Every action re-checks the ACL of its underlying command with the
 * CLICKER's identity — a forwarded card or a non-approver group member can
 * never act (R11 semantics, now on the click path too).
 */
async function handleMenuAction(env: BridgeEnv, state: BridgeState, event: CardActionEvent, payload: MenuActionPayload): Promise<void> {
  const resolved = state.cardMenus.get(payload.menuId, Date.now())
  if (resolved === undefined) {
    // R34: the menu no longer exists (settled away, dropped, or lost to a
    // restart) — answer with a hint instead of failing silently. A click in
    // a foreign chat stays quiet, mirroring the expired branch below.
    if (payload.chatId === event.chatId) await safeSend(env, event.chatId, state.copy.menuGone)
    return
  }
  if (resolved === 'expired') {
    if (payload.chatId === event.chatId) await safeSend(env, event.chatId, state.copy.menuExpired)
    return
  }
  const menu = resolved
  if (payload.chatId !== event.chatId) {
    await safeSend(env, event.chatId, state.copy.menuWrongChat)
    return
  }
  const openId = event.operator.openId
  if (!canManageWorkspaces(env, openId)) {
    await safeSend(env, event.chatId, state.copy.cdNoPermission)
    return
  }
  const binding = state.chats.get(menu.scopeKey)
  if (binding === undefined) return

  if (menu.kind === 'browse') {
    await handleBrowseAction(env, state, menu, binding, payload)
    return
  }

  if (payload.act === 'addcur') {
    if (menu.currentModel === undefined
      || addModelCatalogEntry(env, state, menu.currentModel) === 'full') {
      await safeSend(env, event.chatId, state.copy.modelCatalogFull(MODEL_CATALOG_CAP))
      return
    }
    // Re-render: the entry is now in the list (marked ✅) and the ➕ disappears.
    await refreshMenuCard(env, state, menu)
    return
  }
  if (payload.act === 'page' && payload.idx !== undefined) {
    menu.page = payload.idx
    await refreshMenuCard(env, state, menu)
    return
  }
  if (payload.act !== 'sel' || payload.idx === undefined) return
  const option = menu.options[payload.idx]
  if (option === undefined || option.disabled === true) {
    await safeSend(env, event.chatId, state.copy.menuExpired)
    return
  }

  if (menu.kind === 'ws') {
    const path = menu.paths?.[payload.idx]
    const label = option.label
    if (path === undefined) {
      await safeSend(env, event.chatId, state.copy.menuExpired)
      return
    }
    await settleMenu(env, state, menu, state.copy.menuWsSettledTitle,
      state.copy.cdSwitched(label, path))
    await applyWorkspaceSwitch(env, state, binding, path)
    return
  }
  if (menu.kind === 'model') {
    // R34: resolve against the LIVE catalog the options were rendered from
    // (`state.modelCatalog`, mutated by /model add|del and auto-learn), not
    // the startup-frozen `env.config` copy — otherwise a diverged list maps
    // the clicked index to the wrong model.
    const raw = state.modelCatalog[payload.idx]
    const target = raw === undefined ? undefined : parseModelTarget(raw)
    if (target === undefined) {
      await safeSend(env, event.chatId, state.copy.menuExpired)
      return
    }
    await settleMenu(env, state, menu, state.copy.menuModelSettledTitle,
      state.copy.modelSwitched(target.provider, target.model))
    await applyModelSelection(env, state, binding, target, openId)
    return
  }
  if (menu.kind === 'session') {
    const record = listSessions(state.chatSessions, currentAgentKey(binding))[payload.idx]
    if (record === undefined) {
      await safeSend(env, event.chatId, state.copy.menuExpired)
      return
    }
    await settleMenu(env, state, menu, state.copy.menuSessionSettledTitle,
      state.copy.sessionSwitched(record.title))
    await switchSessionToRecord(env, state, binding, record, openId)
  }
}

/** `/ws` (no argument): the workspace picker card. `/ws list` = text. */
async function sendWsMenu(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  invalidateWorkspaceCatalog(state)
  const catalog = await workspaceCatalogFor(env, state)
  const infos = listWorkspaces(catalog, binding.workspacePath)
  const menu: MenuState = {
    id: createMenuId(),
    kind: 'ws',
    chatId: binding.chatId,
    scopeKey: binding.scopeKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + MENU_TTL_MS,
    page: 0,
    options: infos.map(info => ({
      label: info.name,
      disabled: info.path === binding.workspacePath,
    })),
    paths: infos.map(info => info.path),
  }
  registerMenu(env, state, menu)
  const paths = infos.map(info => `- ${info.name} — \`${info.path}\``)
  const sent = await env.port.send(binding.chatId, { card: wsMenuCard(binding.chatId, menu, paths, {
    note: state.copy.wsMenuNote,
    title: state.copy.wsMenuTitle,
  }) }, replyTo === undefined ? undefined : { replyTo, replyInThread: true }).catch(() => undefined)
  if (sent !== undefined) menu.messageId = sent.messageId
}

/** `/model` picker over the configured catalog (current entry marked). */
async function sendModelMenu(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  const catalog = state.modelCatalog.filter(entry => parseModelTarget(entry) !== undefined)
  if (catalog.length === 0) return // no catalog configured: /model stays text-only
  const current = effectiveSessionSelection(env, state, binding)
  const currentKey = current === undefined ? undefined : `${current.provider}/${current.model}`
  const menu: MenuState = {
    id: createMenuId(),
    kind: 'model',
    chatId: binding.chatId,
    scopeKey: binding.scopeKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + MENU_TTL_MS,
    page: 0,
    currentModel: currentKey,
    options: catalog.map(entry => ({
      label: entry,
      disabled: entry === currentKey,
    })),
  }
  registerMenu(env, state, menu)
  const sent = await env.port.send(binding.chatId, { card: modelMenuCard(binding.chatId, menu, modelMenuLabels(state)) },
    replyTo === undefined ? undefined : { replyTo, replyInThread: true }).catch(() => undefined)
  if (sent !== undefined) menu.messageId = sent.messageId
}

/** `/session` picker under the text list (same numbering, current marked). */
async function sendSessionMenu(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  const agentKey = currentAgentKey(binding)
  const activeGen = state.ledger.generationOf(agentKey)
  const archived = archivedSetOf(env)
  const records = listSessions(state.chatSessions, agentKey)
  const options: MenuOption[] = []
  const indexMap: number[] = []
  records.forEach((record, index) => {
    const isArchived = archived?.has(record.sessionId) ?? false
    if (isArchived && record.gen !== activeGen) return
    options.push({ label: record.title, disabled: record.gen === activeGen })
    indexMap.push(index)
  })
  if (options.length === 0) return
  const menu: MenuState = {
    id: createMenuId(),
    kind: 'session',
    chatId: binding.chatId,
    scopeKey: binding.scopeKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + MENU_TTL_MS,
    page: 0,
    options,
    indexMap,
  }
  registerMenu(env, state, menu)
  const sent = await env.port.send(binding.chatId, { card: sessionMenuCard(binding.chatId, menu, {
    note: state.copy.sessionMenuNote,
    title: state.copy.sessionMenuTitle,
  }) }, replyTo === undefined ? undefined : { replyTo, replyInThread: true }).catch(() => undefined)
  if (sent !== undefined) menu.messageId = sent.messageId
}

/** Browse-card click routing: enter / up / page / confirm. */
async function handleBrowseAction(env: BridgeEnv, state: BridgeState, menu: MenuState, binding: ChatBinding, payload: MenuActionPayload): Promise<void> {
  const root = menu.root ?? ''
  if (payload.act === 'page' && payload.idx !== undefined) {
    menu.page = payload.idx
    await refreshMenuCard(env, state, menu)
    return
  }
  if (payload.act === 'up') {
    const parent = dirname(menu.cwd ?? '.')
    const withinRoot = parent === root || parent.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (root === '' || !withinRoot) {
      await refreshMenuCard(env, state, menu)
      return
    }
    menu.cwd = parent
    await refreshBrowseEntries(env, menu)
    await refreshMenuCard(env, state, menu)
    return
  }
  if (payload.act === 'sel' && payload.idx !== undefined) {
    const name = (menu.entries ?? [])[payload.idx]
    const candidate = name === undefined ? undefined : resolve(menu.cwd ?? '.', name)
    const canonical = candidate === undefined ? undefined : await realpath(candidate).catch(() => undefined)
    if (canonical === undefined) {
      await refreshMenuCard(env, state, menu)
      return
    }
    menu.cwd = canonical
    await refreshBrowseEntries(env, menu)
    await refreshMenuCard(env, state, menu)
    return
  }
  if (payload.act === 'ok') {
    const cwd = menu.cwd
    if (cwd === undefined) return
    await settleMenu(env, state, menu, state.copy.menuBrowseSettledTitle,
      state.copy.cdSwitched(basename(cwd), cwd))
    await registerAndSwitchWorkspace(env, state, binding, cwd)
  }
}

/** Rebuild the directory snapshot of a browse menu at its cwd. */
async function refreshBrowseEntries(env: BridgeEnv, menu: MenuState): Promise<void> {
  try {
    menu.entries = await listSubdirectories(menu.cwd ?? '.')
  } catch (error) {
    env.report(`feishu4dsh: browse listing failed: ${describeError(error)}`)
    menu.entries = []
  }
  menu.page = 0
}

/** `/ws new` (no argument): open the folder browser inside allowed roots. */
async function openBrowseMenu(env: BridgeEnv, state: BridgeState, binding: ChatBinding, senderId: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, state.copy.wsNoPermission, replyTo)
    return
  }
  invalidateWorkspaceCatalog(state)
  const catalog = await workspaceCatalogFor(env, state)
  if (catalog.roots.length === 0) {
    await safeSend(env, chatId, state.copy.browseNoRoots, replyTo)
    return
  }
  // Prefer the chat's current workspace when it sits inside a root, so the
  // browser opens where the user already is; otherwise the first root.
  const inside = catalog.roots.find(root => binding.workspacePath === root
    || binding.workspacePath.startsWith(root.endsWith('/') ? root : `${root}/`))
  const menu: MenuState = {
    id: createMenuId(),
    kind: 'browse',
    chatId,
    scopeKey: binding.scopeKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + MENU_TTL_MS,
    page: 0,
    options: [],
    cwd: inside ?? catalog.roots[0],
    root: inside ?? catalog.roots[0],
    entries: [],
  }
  await refreshBrowseEntries(env, menu)
  registerMenu(env, state, menu)
  const sent = await env.port.send(chatId, { card: browseCard(chatId, menu, browseLabelsFor(state)) },
    replyTo === undefined ? undefined : { replyTo, replyInThread: true }).catch(() => undefined)
  if (sent !== undefined) menu.messageId = sent.messageId
}

/**
 * Register one directory as a user workspace (the `/ws add` accounting)
 * and then switch the chat onto it — the `/ws new` outcome.
 */
async function registerAndSwitchWorkspace(env: BridgeEnv, state: BridgeState, binding: ChatBinding, canonical: string): Promise<void> {
  state.userWorkspaces.add(canonical)
  await registerWorkspace(env, canonical)
  invalidateWorkspaceCatalog(state)
  try {
    await env.hooks.onUserWorkspacesChange?.([...state.userWorkspaces])
  } catch (error) {
    env.report(`feishu4dsh: persist user workspaces failed: ${describeError(error)}`)
  }
  await applyWorkspaceSwitch(env, state, binding, canonical)
}

/** `/ws new <名称>`: mkdir at the browsed location (or current workspace). */
async function wsMkdir(env: BridgeEnv, state: BridgeState, binding: ChatBinding, rawName: string, senderId: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, state.copy.wsNoPermission, replyTo)
    return
  }
  const name = rawName.trim()
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    await safeSend(env, chatId, name === '' ? state.copy.wsMkdirUsage : state.copy.wsMkdirInvalid(name), replyTo)
    return
  }
  // Parent = the chat's live browse location if one is open, else the
  // current workspace — "create where I'm looking, or where I am".
  let parent: string | undefined
  for (const menu of state.cardMenus.all()) {
    if (menu.scopeKey === binding.scopeKey && menu.kind === 'browse' && menu.cwd !== undefined) {
      parent = menu.cwd
      break
    }
  }
  if (parent === undefined) parent = binding.workspacePath
  const target = resolve(parent, name)
  try {
    await mkdir(target)
  } catch (error) {
    env.report(`feishu4dsh: mkdir failed: ${describeError(error)}`)
    await safeSend(env, chatId, state.copy.wsMkdirInvalid(name), replyTo)
    return
  }
  const canonical = await realpath(target)
  await safeSend(env, chatId, state.copy.wsMkdirDone(basename(canonical), canonical), replyTo)
  await registerAndSwitchWorkspace(env, state, binding, canonical)
}

async function handleCardAction(env: BridgeEnv, state: BridgeState, event: CardActionEvent): Promise<void> {
  // R34: select_static callbacks carry the picked option in `action.option`
  // while `action.value` stays the component-level value (empty for our
  // model card). Prefer a non-empty option, fall back to the button value —
  // an empty string is not nullish, so `??` alone would skip the fallback.
  const action = event.action
  const raw = typeof action.option === 'string' && action.option !== '' ? action.option : action.value
  const payload = decodeActionValue(raw)
  if (payload === null) return
  if (payload.kind === 'menu') {
    await handleMenuAction(env, state, event, payload)
    return
  }
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
    binding.turnUsage = emptySessionUsage()
    binding.turnHasOutput = false
    // R36: fresh process-line counters. Counters only — no reasoning text ever
    // lands on the binding, so nothing here can reach the reply buffer, the
    // card body, or `streamedTurns`. R36-2 adds ONE deliberate exception,
    // `reasoningText`: the reasoning REGION's content, held per turn and handed
    // to the card surface alone (never buffered, never `streamedTurns`).
    binding.processStatus = {
      startedAt: Date.now(),
      step: 0,
      reasoningChars: 0,
      reasoningText: '',
      shown: false,
      lastPushAt: 0,
      lastPushChars: 0,
    }
    // R29: the session is alive -- refresh its activity stamp for
    // `/session archive old`.
    touchSession(state.chatSessions, currentAgentKey(binding), state.ledger.generationOf(currentAgentKey(binding)), Date.now())
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

  if (isStepStartEvent(event)) {
    // R36: a new step is the clearest "still working" signal; fold it into the
    // live process line (throttled).
    const status = binding.processStatus
    if (status !== undefined) {
      status.step = event.data.step
      await showProcessStatus(env, state, binding, status)
    }
    return
  }

  if (isAssistantChunkEvent(event)) {
    const chunk = event.data.chunk
    if (chunk.type === 'usage' && chunk.usage !== undefined) {
      if (binding.turnUsage === undefined) binding.turnUsage = emptySessionUsage()
      accumulateSessionUsage(binding.turnUsage, chunk.usage)
      return
    }
    if (chunk.type === 'reasoning-delta' && chunk.text !== undefined && chunk.text !== '') {
      // R36: reasoning never reaches the body — no buffer, no
      // `streamedTurns`. Stage one counts it and pushes a live process line;
      // stage two additionally hands the TEXT to the card's reasoning panel
      // (which is a different region of the same card, not the body).
      const status = binding.processStatus
      if (status !== undefined) {
        status.reasoningChars += chunk.text.length
        if (reasoningPanelEnabled(env, state, binding)) {
          status.reasoningText += chunk.text
          await showReasoningPanel(env, state, binding, status)
        } else {
          await showProcessStatus(env, state, binding, status)
        }
      }
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
      if (binding.turnUsage === undefined) binding.turnUsage = emptySessionUsage()
      accumulateSessionUsage(binding.turnUsage, event.data.usage)
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
    // compact summary when the turn ends — the live process line (R36) shows
    // the running tally, still without per-call detail.
    const counts = binding.toolCallCounts ??= new Map()
    counts.set(event.data.name, (counts.get(event.data.name) ?? 0) + 1)
    const status = binding.processStatus
    if (status !== undefined) await showProcessStatus(env, state, binding, status)
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
    const status = binding.processStatus
    binding.processStatus = undefined

    const summaryLines: string[] = []
    // R36-2: a rendered reasoning panel ALREADY reports size and duration, so
    // the stage-one "reasoning only" line is skipped for that shape (the card
    // ends folded on the panel instead of duplicating the same numbers).
    const panelShown = status !== undefined && status.reasoningText !== '' && reasoningPanelEnabled(env, state, binding)
    // R36: a turn that reasoned but produced no body text ends on ONE closing
    // line instead of freezing the live status line — the "empty reply" look
    // the work order calls out. Counters only, as everywhere else.
    const reasoningOnly = env.config.showProcess && !panelShown
      && status !== undefined && status.reasoningChars > 0 && !binding.turnHasOutput
    if (reasoningOnly && status !== undefined) {
      summaryLines.push(state.copy.reasoningOnlyLine(
        formatNumber(status.reasoningChars),
        elapsedSeconds(status.startedAt),
        toolTally(state.copy, toolCallCounts),
      ))
    }
    // The reasoning-only line already carries the tool tally, so the aggregate
    // line is skipped for that shape (no double count); every other turn keeps
    // the pre-R36 tool summary unchanged.
    if (!reasoningOnly && env.config.showProcess && toolCallCounts !== undefined && toolCallCounts.size > 0) {
      const parts = [...toolCallCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => state.copy.toolCallCountLine(name, count))
      const summary = state.copy.toolCallSummary(parts)
      if (summary !== '') summaryLines.push(`> ${summary}`)
    }
    if (usage !== undefined && hasSessionUsage(usage)) {
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
    // R36-2: hand over the CLOSING panel (folded, with the turn's reasoning
    // size and duration) before the stream is finished; `finish` renders that
    // final state, so the panel never freezes on the live header.
    if (panelShown && status !== undefined) {
      await showReasoningPanel(env, state, binding, status, true)
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
      await resetSessionScope(env, state, binding, 'session reset')
      await safeSend(env, chatId, state.copy.newSessionDone, replyTo)
      return
    }
    case '/mode': {
      await cmdMode(env, state, binding, line.slice('/mode'.length).trim(), senderId, replyTo)
      return
    }
    case '/reasoning': {
      await cmdReasoning(env, state, binding, line.slice('/reasoning'.length).trim(), senderId, replyTo)
      return
    }
    case '/session': {
      await cmdSession(env, state, binding, line.slice('/session'.length).trim(), senderId, replyTo)
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

/**
 * Tear down the scope's live agent and advance its generation — the shared
 * body of `/new` and `/mode` (R27). The /model pin is bridge-owned
 * (state.selections), not agent-owned: ensureSelection hands the SAME object
 * to the next agent when installModelSelectionForAgent runs, so the choice
 * survives the reset; workspace binding stays too. R22 §2.2 memory hygiene:
 * the scope's render-queue slot and reply anchors die with the session, and
 * the R26 preset recording for the dead session id is dropped.
 */
async function resetSessionScope(env: BridgeEnv, state: BridgeState, binding: ChatBinding, cause: string): Promise<void> {
  const agentKey = currentAgentKey(binding)
  const entry = state.ledger.get(agentKey)
  if (entry !== undefined) {
    entry.handle.agent.cancel(cause)
    await entry.handle.dispose().catch(() => undefined)
  }
  // R29: the next generation is one past the highest KNOWN generation (the
  // registry), never reusing ids a `/session` switch-back pointed at.
  const nextGen = nextGenOf(state.chatSessions, agentKey, state.ledger.generationOf(agentKey))
  state.ledger.reset(agentKey, nextGen)
  state.chatActiveGen[agentKey] = nextGen
  persistSessions(env, state)
  // R32: session menus are stale the moment the generation moves.
  dropScopeMenus(state, binding.scopeKey)
  for (const [sessionId] of [...state.sessionScopes]) {
    if (entry !== undefined && sessionId === entry.sessionId) {
      state.sessionScopes.delete(sessionId)
      state.sessionPresets.delete(sessionId)
    }
  }
  await drainRenderQueue(state, binding.scopeKey)
  for (const [id, anchor] of [...state.replyTargets]) {
    if (anchor.scopeKey === binding.scopeKey) state.replyTargets.delete(id)
  }
}

/**
 * Fire-and-forget persistence of the session registry + active pointers
 * (R29). JSON round-trip detaches the persisted payload from live mutations.
 */
function persistSessions(env: BridgeEnv, state: BridgeState): void {
  void (async () => {
    try {
      await env.hooks.onSessionsChange?.({
        sessions: JSON.parse(JSON.stringify(state.chatSessions)) as SessionRegistry,
        activeGen: { ...state.chatActiveGen },
      })
    } catch (error) {
      env.report(`feishu4dsh: persist sessions failed: ${describeError(error)}`)
    }
  })()
}

/** Fire-and-forget persistence of the `/model` picker catalog (R33). */
function persistModelCatalog(env: BridgeEnv, state: BridgeState): void {
  void (async () => {
    try {
      await env.hooks.onModelCatalogChange?.([...state.modelCatalog])
    } catch (error) {
      env.report(`feishu4dsh: persist model catalog failed: ${describeError(error)}`)
    }
  })()
}

/** Add one entry to the picker catalog (dedup, cap). */
function addModelCatalogEntry(env: BridgeEnv, state: BridgeState, entry: string): 'added' | 'exists' | 'full' {
  if (state.modelCatalog.includes(entry)) return 'exists'
  if (state.modelCatalog.length >= MODEL_CATALOG_CAP) return 'full'
  state.modelCatalog.push(entry)
  persistModelCatalog(env, state)
  return 'added'
}

/** Remove one entry; refuses to empty the list. */
function removeModelCatalogEntry(state: BridgeState, entry: string): 'ok' | 'missing' | 'last' {
  const idx = state.modelCatalog.indexOf(entry)
  if (idx === -1) return 'missing'
  if (state.modelCatalog.length <= 1) return 'last'
  state.modelCatalog.splice(idx, 1)
  return 'ok'
}

/**
 * The host's global archive set (shared with dsh web), or undefined when the
 * deployment does not support archiving — the single fact source for which
 * sessions `/session` hides; the channel never stores archived flags itself.
 */
function archivedSetOf(env: BridgeEnv): Set<string> | undefined {
  const registryService = env.host.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  if (registryService?.archivedSessionIds === undefined) return undefined
  try {
    return new Set(registryService.archivedSessionIds())
  } catch {
    return undefined
  }
}

/** `/session`'s default view: everything except archived, PLUS the current. */
function visibleSessions(state: BridgeState, agentKey: string, activeGen: number, archived?: Set<string>): SessionRecord[] {
  return listSessions(state.chatSessions, agentKey)
    .filter(record => record.gen === activeGen || !(archived?.has(record.sessionId) ?? false))
}

/**
 * `/session` (R29): list, switch, rename, and archive the sessions of the
 * CURRENT agent key (scope × workspace).
 * - `/session` / `/session all` -- list (all includes `[已归档]` entries; the
 *   ACTIVE session is always shown, even when archived);
 * - `/session <n>` -- switch (D1: cancels the running task, disposes the live
 *   agent, re-points the ACTIVE generation; the next message resumes the
 *   target session);
 * - `/session rename <title>` -- rename the current session (user title wins);
 * - `/session archive <n>` / `/session archive old [days]` -- archive via the
 *   HOST's registry-global set (shared with dsh web); the default view always
 *   hides archived entries except the active one.
 * Switch/rename/archive are gated like `/cd`; listing is free.
 */
async function cmdSession(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rest: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy
  const agentKey = currentAgentKey(binding)
  const activeGen = state.ledger.generationOf(agentKey)
  const archived = archivedSetOf(env)
  const archiveSupported = archived !== undefined

  if (rest === '' || rest === 'all') {
    // Numbering is GLOBAL and stable (full registry, newest gen first, like
    // TUI buffer ids): the default view omits archived lines but never
    // renumbers, so `/session <n>` and `/session archive <n>` always match
    // whatever list the user just saw.
    const records = listSessions(state.chatSessions, agentKey)
    if (records.length === 0) {
      await safeSend(env, chatId, copy.sessionListEmpty, replyTo)
      return
    }
    const lines = [`**${copy.sessionTitle}**`]
    records.forEach((record, index) => {
      const isArchived = archived?.has(record.sessionId) ?? false
      if (isArchived && rest !== 'all' && record.gen !== activeGen) return
      const flag = record.gen === activeGen ? '● ' : '  '
      const tag = isArchived ? copy.sessionArchivedTag : ''
      lines.push(`${flag}${index + 1} · ${record.title} · ${formatStamp(record.lastActiveAt)}${tag}`)
    })
    lines.push(copy.sessionUsage)
    await safeSend(env, chatId, lines.join('\n'), replyTo)
    // R32: the tappable session list rides along with the text listing.
    await sendSessionMenu(env, state, binding, replyTo)
    return
  }

  if (rest === 'rename' || rest.startsWith('rename ')) {
    if (!canManageWorkspaces(env, senderId)) {
      await safeSend(env, chatId, copy.sessionNoPermission, replyTo)
      return
    }
    const title = rest.slice('rename'.length).trim()
    if (title === '') {
      await safeSend(env, chatId, copy.sessionRenameUsage, replyTo)
      return
    }
    if (!renameSession(state.chatSessions, agentKey, activeGen, title)) {
      await safeSend(env, chatId, copy.sessionNothingToRename, replyTo)
      return
    }
    persistSessions(env, state)
    env.report(`feishu4dsh: session renamed by ${senderId}: ${title}`)
    await safeSend(env, chatId, copy.sessionRenamed(title), replyTo)
    return
  }

  if (rest === 'archive' || rest.startsWith('archive ')) {
    if (!canManageWorkspaces(env, senderId)) {
      await safeSend(env, chatId, copy.sessionNoPermission, replyTo)
      return
    }
    const registryService = env.host.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
    if (!archiveSupported || registryService?.archiveSession === undefined) {
      await safeSend(env, chatId, copy.sessionArchiveUnsupported, replyTo)
      return
    }
    const arg = rest.slice('archive'.length).trim()
    const staleMatch = /^old(?:\s+(\d+))?$/.exec(arg)
    if (arg === '' || staleMatch !== null) {
      if (arg === '') {
        await safeSend(env, chatId, copy.sessionArchiveUsage, replyTo)
        return
      }
      const days = Math.max(1, Number(staleMatch?.[1] ?? 2))
      const stale = staleSessionsOf(state.chatSessions, agentKey, activeGen, Date.now(), days, id => archived.has(id))
        .filter(record => record.sessionId.startsWith('feishu-'))
      if (stale.length === 0) {
        await safeSend(env, chatId, copy.sessionArchiveNone(days), replyTo)
        return
      }
      const titles: string[] = []
      for (const record of stale) {
        try {
          await registryService.archiveSession(record.sessionId)
          titles.push(record.title)
        } catch (error) {
          env.report(`feishu4dsh: archive failed for ${record.sessionId}: ${describeError(error)}`)
        }
      }
      if (titles.length === 0) {
        await safeSend(env, chatId, copy.turnFailed('archive'), replyTo)
        return
      }
      env.report(`feishu4dsh: archived ${titles.length} stale session(s) by ${senderId}`)
      await safeSend(env, chatId, copy.sessionArchivedMany(titles.length, titles.join('、')), replyTo)
      return
    }
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1) {
      await safeSend(env, chatId, copy.sessionArchiveUsage, replyTo)
      return
    }
    const record = listSessions(state.chatSessions, agentKey)[n - 1]
    if (record === undefined) {
      await safeSend(env, chatId, copy.sessionUnknown(n), replyTo)
      return
    }
    // Boundary (owner decision): ONLY sessions created on the Feishu side are
    // archivable from here -- dsh web sessions are the user's to manage.
    if (!record.sessionId.startsWith('feishu-')) {
      await safeSend(env, chatId, copy.sessionArchiveForeign, replyTo)
      return
    }
    if (archived.has(record.sessionId)) {
      await safeSend(env, chatId, copy.sessionArchivedAlready(record.title), replyTo)
      return
    }
    try {
      await registryService.archiveSession(record.sessionId)
    } catch (error) {
      await safeSend(env, chatId, copy.sessionArchiveFailed(describeError(error)), replyTo)
      return
    }
    env.report(`feishu4dsh: session archived by ${senderId}: ${record.sessionId}`)
    await safeSend(env, chatId, copy.sessionArchivedOne(record.title), replyTo)
    return
  }

  // `/session <n>`: switch the ACTIVE pointer (same numbering as the list).
  const n = Number(rest)
  if (!Number.isInteger(n) || n < 1) {
    await safeSend(env, chatId, copy.sessionUsage, replyTo)
    return
  }
  const target = listSessions(state.chatSessions, agentKey)[n - 1]
  if (target === undefined) {
    await safeSend(env, chatId, copy.sessionUnknown(n), replyTo)
    return
  }
  await switchSessionToRecord(env, state, binding, target, senderId, replyTo)
}

/**
 * The `/session <n>` body after index resolution — also the landing path
 * for the session picker card (R32), whose click ACL was already checked
 * in `handleMenuAction`. D1: the running task dies with the switch.
 */
async function switchSessionToRecord(env: BridgeEnv, state: BridgeState, binding: ChatBinding, target: SessionRecord, senderId: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy
  const agentKey = currentAgentKey(binding)
  const activeGen = state.ledger.generationOf(agentKey)
  if (target.gen === activeGen) {
    await safeSend(env, chatId, copy.sessionAlreadyCurrent(target.title), replyTo)
    return
  }
  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, copy.sessionNoPermission, replyTo)
    return
  }

  // D1: the running task dies with the switch, exactly like /stop.
  const entry = state.ledger.get(agentKey)
  if (entry !== undefined) {
    entry.handle.agent.cancel('session switch')
    await entry.handle.dispose().catch(() => undefined)
  }
  // pointerTo keeps any live entry by contract -- drop the disposed one so
  // the next message really creates the target session's agent.
  state.ledger.delete(agentKey)
  state.ledger.pointerTo(agentKey, target.gen)
  state.chatActiveGen[agentKey] = target.gen
  for (const [sessionId] of [...state.sessionScopes]) {
    if (entry !== undefined && sessionId === entry.sessionId) state.sessionScopes.delete(sessionId)
  }
  await drainRenderQueue(state, binding.scopeKey)
  for (const [id, anchor] of [...state.replyTargets]) {
    if (anchor.scopeKey === binding.scopeKey) state.replyTargets.delete(id)
  }
  persistSessions(env, state)
  dropScopeMenus(state, binding.scopeKey)
  env.report(`feishu4dsh: session switched by ${senderId}: gen ${target.gen} (${target.title})`)
  await safeSend(env, chatId, copy.sessionSwitched(target.title), replyTo)
}

/**
 * `/mode`: show or set THIS scope's agent preset (R27).
 * - `/mode`            — current session's mode / next new session's mode / deployment default;
 * - `/mode <preset>`   — validate, persist per scope, then open a NEW session
 *   (resume() cannot change presets, so switching modes always means a fresh
 *   session — the action `/new` performs, with the new preset recorded).
 * Mutating is gated like `/ws add` / `/model` / `/cd`.
 */
async function cmdMode(
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
    const entry = state.ledger.get(currentAgentKey(binding))
    const current = entry === undefined ? undefined : state.sessionPresets.get(entry.sessionId)
    const lines = [
      `**${copy.modeTitle}**`,
      current === undefined ? copy.modeNotStarted : copy.modeCurrent(current),
      copy.modeNext(nextPresetOf(env, state, binding)),
      copy.modeDefaultLine(env.config.agentPreset),
    ]
    await safeSend(env, chatId, lines.join('\n'), replyTo)
    return
  }

  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, copy.modeNoPermission, replyTo)
    return
  }

  const target = rest.trim().toLowerCase()
  if (!(AGENT_PRESETS as readonly string[]).includes(target)) {
    await safeSend(env, chatId, copy.modeUsage, replyTo)
    return
  }
  if (target === nextPresetOf(env, state, binding)) {
    await safeSend(env, chatId, copy.modeAlready(target), replyTo)
    return
  }

  // Persist the scope override (in-memory first so the very next session uses
  // it, then settings so it survives a restart).
  state.chatPresets[binding.scopeKey] = target
  try {
    await env.hooks.onPresetChange?.(binding.scopeKey, target)
  } catch (error) {
    env.report(`feishu4dsh: persist preset failed: ${describeError(error)}`)
  }
  env.report(`feishu4dsh: preset changed by ${senderId}: ${target} (scope ${binding.scopeKey})`)

  await resetSessionScope(env, state, binding, 'preset change')
  await safeSend(env, chatId, copy.modeSwitched(target), replyTo)
}

/**
 * `/reasoning`: show or set THIS scope's reasoning display (R36 stage two).
 * - `/reasoning`          — current state + where it comes from, and the
 *   deployment default;
 * - `/reasoning on|off`   — persist the scope override (in memory first, then
 *   settings) and take effect on the next turn.
 * Mutating is gated like `/mode` / `/ws add` / `/cd`; viewing is not. Unlike
 * `/mode` no new session is needed: the switch only decides how the NEXT reply
 * is rendered.
 */
async function cmdReasoning(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rest: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy
  const label = (enabled: boolean): string => enabled ? copy.reasoningShown : copy.reasoningHidden
  const current = reasoningDisplayOf(env, state, binding)

  if (rest === '') {
    const lines = [
      `**${copy.reasoningTitle}**`,
      copy.reasoningCurrent(
        label(current.enabled),
        current.source === 'scope' ? copy.reasoningSourceScope : copy.reasoningSourceConfig,
      ),
      copy.reasoningDefaultLine(label(env.config.showReasoning)),
    ]
    await safeSend(env, chatId, lines.join('\n'), replyTo)
    return
  }

  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, copy.reasoningNoPermission, replyTo)
    return
  }

  const target = rest.trim().toLowerCase()
  if (!(REASONING_CHOICES as readonly string[]).includes(target)) {
    await safeSend(env, chatId, copy.reasoningUsage, replyTo)
    return
  }
  const choice = target as ReasoningChoice
  if (state.chatReasoning[binding.scopeKey] === choice) {
    await safeSend(env, chatId, copy.reasoningAlready(label(choice === 'on')), replyTo)
    return
  }

  // Persist the scope override (in-memory first so the very next turn uses it,
  // then settings so it survives a restart) — the same shape `/mode` uses.
  state.chatReasoning[binding.scopeKey] = choice
  try {
    await env.hooks.onReasoningChange?.(binding.scopeKey, choice)
  } catch (error) {
    env.report(`feishu4dsh: persist reasoning display failed: ${describeError(error)}`)
  }
  env.report(`feishu4dsh: reasoning display changed by ${senderId}: ${choice} (scope ${binding.scopeKey})`)
  await safeSend(env, chatId, copy.reasoningSwitched(label(choice === 'on')), replyTo)
}

/** `/status`: session id, scope, current workspace (name + path), model. */
async function cmdStatus(env: BridgeEnv, state: BridgeState, binding: ChatBinding, replyTo?: string): Promise<void> {
  const copy = state.copy
  const shown = resolveDisplayedModel(env, state, binding)
  const model = shown === undefined
    ? ''
    : `${shown.text}${shown.isDefaultNotStarted ? copy.modelDefaultNotStarted : ''}`
  const agentKey = currentAgentKey(binding)
  const entry = state.ledger.get(agentKey)
  const session = entry?.handle.agent.session
  // R26 statistics come from the dsh session log when the host exposes it;
  // an old host without the log renders “—” instead of misleading zeros.
  const stats = statsOfEvents(session?.events)
  const turns = stats === undefined ? copy.statusStatsUnavailable : String(stats.turns)
  const steps = stats === undefined ? copy.statusStatsUnavailable : String(stats.steps)
  const effort = displayEffortOf(env, state, binding)
  const sessionId = currentSessionId(state, binding)
  const record = activeRecordOf(state.chatSessions, currentAgentKey(binding), state.ledger.generationOf(currentAgentKey(binding)))
  const sessionLine = record === undefined ? sessionId : `${record.title} (${sessionId})`
  const lines = [
    `**${copy.statusTitle}**`,
    copy.statusSession(sessionLine),
    copy.statusScope(copy.scopeLabel(env.config.sessionScope)),
    copy.statusWorkspace(binding.workspaceName, binding.workspacePath),
    copy.statusPreset(sessionPresetOf(env, state, binding)),
    ...model === '' ? [] : [copy.statusModel(model)],
    copy.statusEffort(effort.value, effort.source),
    copy.statusTurns(turns, steps),
    stats !== undefined && hasSessionUsage(stats.usage)
      ? copy.statusTokens(
        formatNumber(stats.usage.inputTokens),
        formatNumber(stats.usage.outputTokens),
        stats.usage.cacheReadTokens > 0 ? formatNumber(stats.usage.cacheReadTokens) : undefined,
        stats.usage.cacheWriteTokens > 0 ? formatNumber(stats.usage.cacheWriteTokens) : undefined,
        stats.usage.reasoningTokens > 0 ? formatNumber(stats.usage.reasoningTokens) : undefined,
      )
      : copy.statusTokensUnavailable,
    '\n/ws 点选工作区 · /cd <名称或路径> 切换 · /ws new 新建',
  ]
  await safeSend(env, binding.chatId, lines.join('\n'), replyTo)
}

/**
 * The preset /status should show for the chat's CURRENT session (R26): what
 * the agent was actually created with, or the channel default for a session
 * that does not exist yet (or predates the recording).
 */
function sessionPresetOf(env: BridgeEnv, state: BridgeState, binding: ChatBinding): string {
  const entry = state.ledger.get(currentAgentKey(binding))
  const fallback = nextPresetOf(env, state, binding)
  return entry === undefined
    ? fallback
    : (state.sessionPresets.get(entry.sessionId) ?? fallback)
}

/**
 * The reasoning effort /status should show (R26): what the session's last
 * request actually carried, or the deployment default. R28 prepends the
 * per-model preference as a source in front of this chain.
 */
function displayEffortOf(env: BridgeEnv, state: BridgeState, binding: ChatBinding): { value: string; source: string } {
  const effective = effectiveSessionSelection(env, state, binding)
  const modelKey = effective === undefined ? undefined : `${effective.provider}/${effective.model}`
  const preferred = modelKey === undefined ? undefined : state.modelEfforts[modelKey]
  if (preferred !== undefined) {
    return { value: preferred, source: state.copy.effortSourcePreferred }
  }
  const entry = state.ledger.get(currentAgentKey(binding))
  const logged = readLoggedSelection(entry?.handle.agent.session)
  if (logged?.reasoningEffort !== undefined) {
    return { value: String(logged.reasoningEffort), source: state.copy.effortSourceMeasured }
  }
  return { value: 'default', source: '' }
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

  // R28: effort is a /model subcommand (`/model effort ...`), not a
  // standalone command — the command surface stays grouped under /model.
  if (rest === 'effort' || rest.startsWith('effort ')) {
    await cmdModelEffort(env, state, binding, rest.slice('effort'.length).trim(), senderId, replyTo)
    return
  }

  if (rest === '') {
    const shown = resolveDisplayedModel(env, state, binding)
    const effort = displayEffortOf(env, state, binding)
    const modelLine = shown === undefined
      ? `${copy.modelTitle}：${copy.modelUnknown}`
      : `${copy.modelTitle}：${shown.text}${shown.isDefaultNotStarted ? copy.modelDefaultNotStarted : ''}${copy.modelSourceSession}`
    const hint = state.modelCatalog.length === 0 ? `\n${copy.modelCatalogHint}` : ''
    await safeSend(env, chatId, `${modelLine}\n${copy.modelEffortLine(effort.value, effort.source)}${hint}`, replyTo)
    // R32: the tappable model list rides along when a catalog is configured.
    await sendModelMenu(env, state, binding, replyTo)
    return
  }

  // R33: manage the picker catalog — add / del entries (approver-gated).
  if (rest.startsWith('add ') || rest.startsWith('del ')) {
    if (!canManageWorkspaces(env, senderId)) {
      await safeSend(env, chatId, copy.modelNoPermission, replyTo)
      return
    }
    const entry = rest.slice(4).trim()
    const target = parseModelTarget(entry)
    if (target === undefined) {
      await safeSend(env, chatId, copy.modelAddDelUsage, replyTo)
      return
    }
    if (rest.startsWith('add ')) {
      const outcome = addModelCatalogEntry(env, state, entry)
      await safeSend(env, chatId, outcome === 'full'
        ? copy.modelCatalogFull(MODEL_CATALOG_CAP)
        : outcome === 'exists'
          ? copy.modelAddExists(entry)
          : copy.modelAdded(entry), replyTo)
      return
    }
    const outcome = removeModelCatalogEntry(state, entry)
    if (outcome === 'missing') await safeSend(env, chatId, copy.modelDelMissing(entry), replyTo)
    else if (outcome === 'last') await safeSend(env, chatId, copy.modelRemoveLast, replyTo)
    else await safeSend(env, chatId, copy.modelDeleted(entry), replyTo)
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
  await applyModelSelection(env, state, binding, target, senderId, replyTo)
}

/**
 * The `/model <p/m>` body after parsing — also the landing path for the
 * model picker card (R32), whose click ACL was already checked in
 * `handleMenuAction`. Pins the selection for the scope's agent key.
 */
async function applyModelSelection(env: BridgeEnv, state: BridgeState, binding: ChatBinding, target: HostModelSelection, senderId: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy
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
  // R33 auto-learn: the picker list grows with real usage (dedup, capped).
  const learned = `${target.provider}/${target.model}`
  if (addModelCatalogEntry(env, state, learned) === 'full') {
    env.report(`feishu4dsh: model catalog full (${MODEL_CATALOG_CAP}); ${learned} not learned`)
  }
  env.report(`feishu4dsh: model switched by ${senderId}: ${target.provider}/${target.model}`)
  await safeSend(env, chatId, copy.modelSwitched(target.provider, target.model), replyTo)
}

/**
 * `/model effort`: view or set the reasoning effort of the session's CURRENT
 * model (R28). A level is stored per model (`provider/model` → level) and
 * remembered globally — adjusting one model's effort updates that model's
 * default everywhere (owner decision D9: no per-session temporary override).
 * `default` deletes the override: requests then carry no explicit
 * `reasoning_effort` and the model's built-in behaviour applies. Gated like
 * the rest of `/model`.
 */
async function cmdModelEffort(
  env: BridgeEnv,
  state: BridgeState,
  binding: ChatBinding,
  rest: string,
  senderId: string,
  replyTo?: string,
): Promise<void> {
  const chatId = binding.chatId
  const copy = state.copy
  const effective = effectiveSessionSelection(env, state, binding)

  if (rest === '') {
    if (effective === undefined) {
      await safeSend(env, chatId, copy.effortUnknown, replyTo)
      return
    }
    const effort = displayEffortOf(env, state, binding)
    await safeSend(env, chatId, copy.modelEffortLine(effort.value, effort.source), replyTo)
    return
  }

  if (!canManageWorkspaces(env, senderId)) {
    await safeSend(env, chatId, copy.modelNoPermission, replyTo)
    return
  }

  const level = rest.trim().toLowerCase()
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
    await safeSend(env, chatId, copy.effortUsage, replyTo)
    return
  }
  if (effective === undefined) {
    await safeSend(env, chatId, copy.effortUnknown, replyTo)
    return
  }

  const modelKey = `${effective.provider}/${effective.model}`
  if (level === 'default') delete state.modelEfforts[modelKey]
  else state.modelEfforts[modelKey] = level
  try {
    await env.hooks.onModelEffortsChange?.({ ...state.modelEfforts })
  } catch (error) {
    env.report(`feishu4dsh: persist model efforts failed: ${describeError(error)}`)
  }
  env.report(`feishu4dsh: reasoning effort for ${modelKey} set to ${level} by ${senderId}`)
  await safeSend(
    env,
    chatId,
    level === 'default' ? copy.effortCleared(effective.model) : copy.effortSet(level, effective.model),
    replyTo,
  )
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
    await sendWsMenu(env, state, binding, replyTo)
    return
  }
  const [sub, ...restParts] = rest.split(/\s+/)
  const arg = restParts.join(' ').trim()
  switch (sub) {
    case 'list':
      await cmdListWorkspaces(env, state, binding, replyTo)
      return
    case 'add':
      await cmdWsAdd(env, state, binding, arg, senderId, replyTo)
      return
    case 'new':
      if (arg === '') {
        await openBrowseMenu(env, state, binding, senderId, replyTo)
      } else {
        await wsMkdir(env, state, binding, arg, senderId, replyTo)
      }
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
  await applyWorkspaceSwitch(env, state, binding, target, replyTo)
}

/**
 * The `/cd` body after the ACL gate — also the landing path for the `/ws`
 * picker card (R32), whose click ACL was already checked in
 * `handleMenuAction`. Sends the switched/refusal copy itself.
 */
async function applyWorkspaceSwitch(env: BridgeEnv, state: BridgeState, binding: ChatBinding, target: string, replyTo?: string): Promise<void> {
  const chatId = binding.chatId

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
  state.sessionPresets.clear()
  // R32: retire menu cards and their expiry timers with the bridge.
  for (const timer of state.menuTimers.values()) clearTimeout(timer)
  state.menuTimers.clear()
  state.cardMenus.clear()
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
