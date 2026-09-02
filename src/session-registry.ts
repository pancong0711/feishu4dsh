/**
 * The channel-side session registry behind `/session` (R29): per agent key
 * (scope × workspace) a durable list of known generations with human titles
 * and activity stamps.
 *
 * Boundaries:
 * - Titles are CHANNEL state (auto = `MMDD + first non-empty line ≤ 12
 *   chars`, user rename wins); the host has no notion of them.
 * - Archived state is HOST state (`workspaceRegistry.archivedSessionIds`,
 *   shared with dsh web) — this module never stores it; the caller fetches
 *   the set at render time.
 * - `lastActiveAt` starts at registration time and refreshes on turn/start;
 *   `/session archive old [days]` selects entries older than the cutoff
 *   except the ACTIVE session.
 * @module feishu4dsh/session-registry
 */

import { isAgentKey } from './sessions.js'

/** One known session of one agent key. JSON-shaped: settings persistence. */
export interface SessionRecord {
  /** Generation the session was created under (unique per agent key). */
  readonly gen: number
  /** Deterministic session id (`feishu-<hash>` or `feishu-<hash>-rN`). */
  readonly sessionId: string
  /** Auto or user title; user rename flips `titleIsAuto` off. */
  title: string
  /** True while the title is still the generated default. */
  titleIsAuto: boolean
  readonly createdAt: number
  lastActiveAt: number
}

/** agentKey (scope § workspace) → known sessions, stored in gen-asc order. */
export type SessionRegistry = Record<string, SessionRecord[]>

/** The persisted pointer payload: agentKey → active generation. */
export type ActiveGenMap = Record<string, number>

/** `MMDD` of a date, local time. */
function stampOf(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${mm}${dd}`
}

/**
 * Auto title (D5): `MMDD + first non-empty line of the first user message`,
 * truncated to 12 code points; falls back to the date alone when the message
 * has no usable line. The first line reads like a subject users already
 * write, which is why it beats a blind first-12-chars cut.
 */
export function autoTitleOf(text: string | undefined, now: Date): string {
  const stamp = stampOf(now)
  const firstLine = (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line !== '')
  if (firstLine === undefined) return stamp
  const head = Array.from(firstLine).slice(0, 12).join('')
  return `${stamp} ${head}`
}

/**
 * Upsert one session: create the record when the generation is new (title
 * from the hint text when available), else refresh `lastActiveAt` — and
 * upgrade an AUTO title from the hint (a pre-registered date-only title
 * becomes the real subject); a user title is never overwritten.
 */
export function upsertSession(
  registry: SessionRegistry,
  agentKey: string,
  gen: number,
  sessionId: string,
  opts: { hintText?: string; now: number },
): SessionRecord {
  const list = registry[agentKey] ?? (registry[agentKey] = [])
  let record = list.find(entry => entry.gen === gen)
  if (record === undefined) {
    record = {
      gen,
      sessionId,
      title: autoTitleOf(opts.hintText, new Date(opts.now)),
      titleIsAuto: true,
      createdAt: opts.now,
      lastActiveAt: opts.now,
    }
    list.push(record)
    list.sort((a, b) => a.gen - b.gen)
    return record
  }
  record.lastActiveAt = opts.now
  if (record.titleIsAuto && opts.hintText !== undefined && opts.hintText.trim() !== '') {
    record.title = autoTitleOf(opts.hintText, new Date(record.createdAt))
  }
  return record
}

/** Refresh `lastActiveAt` for the session under an agent key (turn start). */
export function touchSession(
  registry: SessionRegistry,
  agentKey: string,
  gen: number,
  now: number,
): void {
  const record = (registry[agentKey] ?? []).find(entry => entry.gen === gen)
  if (record !== undefined) record.lastActiveAt = now
}

/**
 * Rename one session. Returns false when there is no record (nothing to
 * rename) — e.g. `/session rename` before the session was ever created.
 */
export function renameSession(
  registry: SessionRegistry,
  agentKey: string,
  gen: number,
  title: string,
): boolean {
  const record = (registry[agentKey] ?? []).find(entry => entry.gen === gen)
  if (record === undefined) return false
  record.title = title
  record.titleIsAuto = false
  return true
}

/** The record for an agent key's ACTIVE generation, if registered. */
export function activeRecordOf(
  registry: SessionRegistry,
  agentKey: string,
  gen: number,
): SessionRecord | undefined {
  return (registry[agentKey] ?? []).find(entry => entry.gen === gen)
}

/**
 * Known sessions of an agent key, NEWEST generation first (stable order for
 * the `/session` list numbering).
 */
export function listSessions(registry: SessionRegistry, agentKey: string): SessionRecord[] {
  return [...(registry[agentKey] ?? [])].sort((a, b) => b.gen - a.gen)
}

/**
 * The generation `/new` should create: one past the highest KNOWN generation
 * (not one past the pointer), so re-pointing at a historical session never
 * makes `/new` reuse ids.
 */
export function nextGenOf(registry: SessionRegistry, agentKey: string, activeGen: number): number {
  const known = (registry[agentKey] ?? []).map(entry => entry.gen)
  return Math.max(activeGen, ...(known.length > 0 ? known : [0])) + 1
}

/**
 * Candidates for `/session archive old [days]`: known, not archived, older
 * than the cutoff — never the ACTIVE session (archiving it would hide the
 * conversation the chat is pointing at).
 */
export function staleSessionsOf(
  registry: SessionRegistry,
  agentKey: string,
  activeGen: number,
  now: number,
  days: number,
  isArchived: (sessionId: string) => boolean,
): SessionRecord[] {
  const cutoff = now - days * 86_400_000
  return (registry[agentKey] ?? []).filter(
    entry => entry.gen !== activeGen
      && !isArchived(entry.sessionId)
      && entry.lastActiveAt <= cutoff,
  )
}

/**
 * Rebuild the persisted registry into plugin-owned, MUTABLE state (R30).
 *
 * The host hands the settings document over deep-frozen (`dsh-settings`
 * `deepFreeze` is a design contract, not an incident). The v0.6.0 hydration
 * seeded `state.chatSessions` by REFERENCE, so the first restart carrying a
 * non-empty `chatSessions` aliased that frozen graph — every registry
 * mutation then threw (`read only property 'lastActiveAt'` /
 * `not extensible`) and every Feishu message failed before its turn started.
 * Hydration therefore rebuilds the object graph: a fresh array per agent key
 * and a fresh record per entry. Every `SessionRecord` field is a primitive,
 * so a shallow copy is complete.
 *
 * Hardening (work order §5): persisted keys must look like
 * `scope§workspace` (`isAgentKey`) — a malformed leftover is skipped with a
 * report instead of being carried forever; and the freeze canary is a
 * tripwire — freshly built state is never frozen, and if that ever changes
 * the deployment gets a loud report plus a `structuredClone` fallback.
 */
export function hydrateSessionRegistry(
  raw: Readonly<Record<string, unknown[]>> | undefined,
  report?: (line: string) => void,
): SessionRegistry {
  const registry: SessionRegistry = {}
  for (const [agentKey, records] of Object.entries(raw ?? {})) {
    if (!isAgentKey(agentKey)) {
      report?.(
        `feishu4dsh: chatSessions key '${agentKey}' is not scope§workspace — skipped`
        + ' (leftover of a failed write; clean it up in settings)',
      )
      continue
    }
    // The persisted records are this module's own `SessionRecord`s (written
    // by the persistence hook); the config layer only widens them to
    // `unknown[]`, so the cast is the hydration boundary, and the runtime
    // array check guards against hand-edited settings.
    const source = Array.isArray(records) ? (records as SessionRecord[]) : []
    const list = source.map(record => ({ ...record }))
    if (Object.isFrozen(list) || (list.length > 0 && Object.isFrozen(list[0]))) {
      report?.(`feishu4dsh: hydrated session registry for '${agentKey}' is still frozen — re-cloning via structuredClone`)
      registry[agentKey] = structuredClone(list)
      continue
    }
    registry[agentKey] = list
  }
  return registry
}
