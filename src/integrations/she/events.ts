/**
 * Reconnecting gateway.v1 event pump.
 *
 * The pump owns only transport concerns: cursor persistence, reconnect
 * backoff, duplicate suppression, heartbeat handling and cursor-expired
 * snapshot recovery. Task/render semantics stay in the injected sink.
 * @module feishu4dsh/integrations/she/events
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  GatewayServerEvent,
  GatewaySnapshot,
  GatewayTaskEvent,
  RenderIntent,
  RenderTarget,
} from '@she/protocol'

/** Minimal client surface required by the event pump. */
export interface SheEventSource {
  events(options: { readonly cursor?: string; readonly signal?: AbortSignal }): AsyncIterable<GatewayServerEvent>
  snapshot(signal?: AbortSignal): Promise<GatewaySnapshot>
}

/** Persist the last successfully delivered task cursor. */
export interface SheEventCursorStore {
  read(): string | undefined | Promise<string | undefined>
  write(cursor: string): void | Promise<void>
}

/** Persistent cursor store: one cursor per file, mode 0600, atomic replace. */
export class FileSheEventCursorStore implements SheEventCursorStore {
  constructor(private readonly path: string) {}

  async read(): Promise<string | undefined> {
    try {
      const value = (await readFile(this.path, 'utf8')).trim()
      return value === '' ? undefined : value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(cursor: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${cursor}\n`, { mode: 0o600 })
    await rename(temp, this.path)
  }
}

/** In-memory cursor store; production may persist this outside the process. */
export class MemorySheEventCursorStore implements SheEventCursorStore {
  private cursor: string | undefined

  constructor(cursor?: string) {
    this.cursor = cursor
  }

  read(): string | undefined {
    return this.cursor
  }

  write(cursor: string): void {
    this.cursor = cursor
  }
}

/** Side effects driven by the event stream. */
export interface SheEventSink {
  render(target: RenderTarget, intent: RenderIntent): Promise<void> | void
  task?(event: GatewayTaskEvent): Promise<void> | void
  snapshot?(snapshot: GatewaySnapshot): Promise<void> | void
  heartbeat?(at: number): Promise<void> | void
  error?(error: unknown): Promise<void> | void
}

export interface SheEventPumpOptions {
  readonly client: SheEventSource
  readonly sink: SheEventSink
  readonly signal: AbortSignal
  readonly cursorStore?: SheEventCursorStore
  /** Initial reconnect delay; doubled up to reconnectMaxMs. */
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
  /** Injection seam for deterministic tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly onError?: (error: unknown) => void
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Bounded duplicate suppression across reconnect/replay boundaries. */
class RecentKeys {
  private readonly keys = new Set<string>()
  private readonly order: string[] = []

  constructor(private readonly limit = 2_048) {}

  has(key: string): boolean {
    return this.keys.has(key)
  }

  add(key: string): void {
    if (this.keys.has(key)) return
    this.keys.add(key)
    this.order.push(key)
    while (this.order.length > this.limit) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.keys.delete(oldest)
    }
  }
}

function eventKey(event: GatewayServerEvent): string | undefined {
  if (event.type === 'task') return `task:${event.event.eventId}`
  if (event.type === 'render') return `render:${event.render.renderId}:${String(event.render.sequence)}`
  return undefined
}

/**
 * Pump the SHE event stream until `signal` is aborted.
 *
 * On `cursor_expired`, the pump fetches a snapshot, hands it to the sink, and
 * resumes from `snapshot.cursor` instead of silently dropping events.
 */
export async function pumpSheEvents(options: SheEventPumpOptions): Promise<void> {
  const {
    client,
    sink,
    signal,
    cursorStore,
    reconnectBaseMs = 500,
    reconnectMaxMs = 15_000,
    sleep = abortableSleep,
    onError,
  } = options
  let cursor = await cursorStore?.read()
  let delay = Math.max(1, reconnectBaseMs)
  const recent = new RecentKeys()

  while (!signal.aborted) {
    try {
      for await (const event of client.events({
        ...(cursor === undefined ? {} : { cursor }),
        signal,
      })) {
        if (signal.aborted) return
        const key = eventKey(event)
        if (key !== undefined && recent.has(key)) continue
        if (event.type === 'task') {
          await sink.task?.(event.event)
          cursor = event.event.cursor
          await cursorStore?.write(cursor)
        } else if (event.type === 'render') {
          await sink.render(event.target, event.render)
        } else if (event.type === 'heartbeat') {
          await sink.heartbeat?.(event.at)
        }
        if (key !== undefined) recent.add(key)
      }
      if (signal.aborted) return
      delay = Math.max(1, reconnectBaseMs)
    } catch (error) {
      if (signal.aborted) return
      if (errorCodeOf(error) === 'cursor_expired') {
        try {
          const snapshot = await client.snapshot(signal)
          await sink.snapshot?.(snapshot)
          cursor = snapshot.cursor ?? undefined
          if (cursor !== undefined) await cursorStore?.write(cursor)
          delay = Math.max(1, reconnectBaseMs)
          continue
        } catch (snapshotError) {
          onError?.(snapshotError)
          await sink.error?.(snapshotError)
        }
      } else {
        onError?.(error)
        await sink.error?.(error)
      }
    }
    if (signal.aborted) return
    await sleep(delay, signal)
    delay = Math.min(reconnectMaxMs, delay * 2)
  }
}
