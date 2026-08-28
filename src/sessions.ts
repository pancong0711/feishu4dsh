/**
 * Session identity: how one Feishu conversation maps onto one dsh agent
 * session, and the ledger that owns the live agent handles.
 *
 * A session is identified by the triple (scope × workspace × generation):
 * - scope     — which conversation (chat / chat-thread / chat-sender).
 * - workspace — which directory the agent is rooted in. Switching workspace
 *               therefore switches WHICH session (and its history) a chat
 *               drives, without ever cross-wiring two workspaces' contexts.
 * - generation — the `/new` reset counter, so a cleared context can not be
 *               resumed by accident.
 * @module feishu4dsh/sessions
 */

import { shortHash } from './util.js'
import type { ResolvedConfig } from './config.js'

/** Facts one inbound message contributes to scope identity. */
export interface SessionScopeInput {
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId: string
  readonly threadId?: string
}

/** Session-key strategy; mirrors `config.sessionScope`. */
export type SessionScope = 'chat' | 'chat-thread' | 'chat-sender'

/**
 * Resolve the stable channel-level scope key for one message. The same key
 * continues one conversation; a different key starts a separate agent.
 * @param scope - configured granularity.
 * @param input - the message's identity facts.
 * @returns the scope key, e.g. `oc_xxx` or `oc_xxx#ou_yyy`.
 */
export function scopeKeyOf(scope: SessionScope, input: SessionScopeInput): string {
  switch (scope) {
    case 'chat':
      return input.chatId
    case 'chat-thread':
      return input.threadId === undefined ? input.chatId : `${input.chatId}@${input.threadId}`
    case 'chat-sender':
      return `${input.chatId}#${input.senderId}`
    default:
      return input.chatId
  }
}

/** Resolve the scope key directly from resolved configuration. */
export function resolveScopeKey(
  config: Pick<ResolvedConfig, 'sessionScope'>,
  input: SessionScopeInput,
): string {
  return scopeKeyOf(config.sessionScope, input)
}

/**
 * The composite ledger key for one (scope × workspace) pair. The live agent
 * for a chat's CURRENT workspace is looked up under this key; a workspace
 * switch simply points the chat at a different key, so each workspace keeps
 * its own session and history.
 * @param scopeKey - channel-level scope key.
 * @param workspacePath - canonical workspace directory the agent roots in.
 * @returns the agent key, e.g. `oc_xxx§/abs/path`.
 */
export function agentKeyOf(scopeKey: string, workspacePath: string): string {
  return `${scopeKey}§${workspacePath}`
}

/**
 * The durable session id one (scope × workspace) pair drives. Deterministic
 * and stable across restarts so `agents.resume` can reopen it; a generation
 * suffix separates one `/new` reset from the history before it.
 * @param scopeKey - channel-level scope key.
 * @param workspacePath - canonical workspace directory.
 * @param generation - reset generation, 0 until the chat asks for `/new`.
 * @returns the host session id.
 */
export function sessionIdOf(scopeKey: string, workspacePath: string, generation: number): string {
  const digest = shortHash(`feishu4dsh:${scopeKey}@${workspacePath}`, 12)
  return generation === 0 ? `feishu-${digest}` : `feishu-${digest}-r${generation}`
}

/** One (scope × workspace) live agent, with the generation it was created under. */
export interface LedgerEntry<TAgent> {
  readonly handle: TAgent
  readonly generation: number
  readonly sessionId: string
}

/**
 * Registry of the agents this channel owns, keyed by agent key
 * (scope × workspace). Ownership is what the approval waterfall checks: a
 * question from an agent not present here is answered by somebody else, so
 * this channel delegates via `next()`.
 *
 * R29: the per-key generation is an ACTIVE POINTER, not a monotonic counter —
 * `/session <n>` re-points it at any historical generation, while `/new`
 * advances it (callers pass an explicit next generation computed from the
 * session registry so switched-back generations are never reused). The map
 * itself is in-memory only; the bridge persists the pointer via settings and
 * re-seeds it on startup (`pointerTo`).
 */
export class AgentLedger<TAgent> {
  private readonly entries = new Map<string, LedgerEntry<TAgent>>()
  private readonly generations = new Map<string, number>()

  /** The live handle for one agent key, if any. */
  get(agentKey: string): LedgerEntry<TAgent> | undefined {
    return this.entries.get(agentKey)
  }

  /** Record a newly created or resumed handle for one agent key. */
  set(agentKey: string, entry: LedgerEntry<TAgent>): void {
    this.entries.set(agentKey, entry)
    this.generations.set(agentKey, entry.generation)
  }

  /**
   * Drop one agent key's handle without touching its generation, keeping the
   * next session id stable for teardown bookkeeping.
   * @returns the removed entry, when one existed.
   */
  delete(agentKey: string): LedgerEntry<TAgent> | undefined {
    const entry = this.entries.get(agentKey)
    this.entries.delete(agentKey)
    return entry
  }

  /**
   * Drop one agent key's handle and point it at the NEXT generation — by
   * default one past the active pointer, or an explicit generation computed
   * by the caller (R29: registry max + 1, so a pointer sitting on a
   * switched-back historical generation never reuses ids).
   * @returns the generation the next agent starts under.
   */
  reset(agentKey: string, nextGen?: number): number {
    this.entries.delete(agentKey)
    const next = nextGen ?? this.generationOf(agentKey) + 1
    this.generations.set(agentKey, next)
    return next
  }

  /** The ACTIVE generation an agent key currently points at. */
  generationOf(agentKey: string): number {
    return this.generations.get(agentKey) ?? 0
  }

  /**
   * Re-point an agent key at a (historical) generation without dropping any
   * live entry — callers dispose explicitly. Used by `/session <n>` (R29)
   * and by startup seeding from the persisted pointer.
   */
  pointerTo(agentKey: string, gen: number): void {
    this.generations.set(agentKey, gen)
  }

  /** Whether one session id belongs to this ledger's agents. */
  ownsSession(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return true
    }
    return false
  }

  /** Every live entry, for teardown. */
  values(): IterableIterator<LedgerEntry<TAgent>> {
    return this.entries.values()
  }

  /** The agent key one session id was installed under, if any. */
  keyOf(sessionId: string): string | undefined {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) return key
    }
    return undefined
  }
}
