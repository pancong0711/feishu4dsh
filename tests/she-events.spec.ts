import { describe, expect, it } from 'vitest'
import {
  GATEWAY_V1_FIXTURES,
  GATEWAY_V1_TASK_EVENT,
  type GatewayServerEvent,
  type GatewaySnapshot,
} from '@she/protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSheEventCursorStore,
  MemorySheEventCursorStore,
  pumpSheEvents,
  type SheEventSource,
} from '../src/integrations/she/index.js'

function taskEvent(eventId: string, cursor: string): GatewayServerEvent {
  return {
    type: 'task',
    event: {
      ...GATEWAY_V1_TASK_EVENT,
      eventId,
      cursor,
    },
  }
}

describe('SHE event pump', () => {
  it('persists cursors and suppresses duplicate replayed events', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    let calls = 0
    const client: SheEventSource = {
      async *events() {
        calls += 1
        if (calls > 1) {
          await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        yield taskEvent('event-1', 'evt:1')
        yield taskEvent('event-1', 'evt:1')
        yield taskEvent('event-2', 'evt:2')
      },
      snapshot: async (): Promise<GatewaySnapshot> => GATEWAY_V1_FIXTURES.snapshot,
    }
    const cursorStore = new MemorySheEventCursorStore()
    await pumpSheEvents({
      client,
      cursorStore,
      signal: controller.signal,
      sleep: async () => undefined,
      sink: {
        render: () => undefined,
        task: event => {
          seen.push(event.eventId)
          if (event.eventId === 'event-2') controller.abort()
        },
      },
    })
    expect(seen).toEqual(['event-1', 'event-2'])
    expect(cursorStore.read()).toBe('evt:2')
  })

  it('recovers from cursor_expired through a snapshot', async () => {
    const controller = new AbortController()
    const snapshots: GatewaySnapshot[] = []
    const requestedCursors: Array<string | undefined> = []
    let calls = 0
    const client: SheEventSource = {
      async *events(options) {
        calls += 1
        requestedCursors.push(options.cursor)
        if (calls === 1) {
          throw Object.assign(new Error('event cursor expired'), { code: 'cursor_expired' })
        }
        yield taskEvent('event-2', 'evt:2')
      },
      snapshot: async () => GATEWAY_V1_FIXTURES.snapshot,
    }
    await pumpSheEvents({
      client,
      signal: controller.signal,
      sleep: async () => undefined,
      sink: {
        render: () => undefined,
        snapshot: snapshot => snapshots.push(snapshot),
        task: () => controller.abort(),
      },
    })
    expect(snapshots).toHaveLength(1)
    expect(requestedCursors).toEqual([undefined, 'evt:1'])
  })

  it('reports transport errors and keeps retrying until aborted', async () => {
    const controller = new AbortController()
    const errors: unknown[] = []
    let calls = 0
    const client: SheEventSource = {
      async *events() {
        calls += 1
        throw Object.assign(new Error('socket unavailable'), { code: 'transport_error' })
      },
      snapshot: async () => GATEWAY_V1_FIXTURES.snapshot,
    }
    await pumpSheEvents({
      client,
      signal: controller.signal,
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
      sleep: async () => {
        if (calls >= 2) controller.abort()
      },
      onError: error => errors.push(error),
      sink: { render: () => undefined },
    })
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})


describe('persistent SHE event cursor', () => {
  it('survives store recreation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'she-cursor-'))
    try {
      const path = join(dir, 'state', 'cursor')
      const first = new FileSheEventCursorStore(path)
      await expect(first.read()).resolves.toBeUndefined()
      await first.write('evt:42')
      const second = new FileSheEventCursorStore(path)
      await expect(second.read()).resolves.toBe('evt:42')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
