import { describe, expect, it } from 'vitest'
import { accumulateSessionUsage, emptySessionUsage, hasSessionUsage, statsOfEvents } from '../src/session-stats.js'
import type { HostSessionEvent } from '../src/host.js'

function events(...list: HostSessionEvent[]): HostSessionEvent[] {
  return list
}

describe('session-stats', () => {
  it('returns undefined when the host does not expose the session log', () => {
    expect(statsOfEvents(undefined)).toBeUndefined()
  })

  it('an empty log yields zeroed stats (fresh session)', () => {
    const stats = statsOfEvents([])
    expect(stats).toEqual({ turns: 0, steps: 0, usage: emptySessionUsage() })
    expect(hasSessionUsage(stats!.usage)).toBe(false)
  })

  it('counts turns and steps and accumulates usage from the log', () => {
    const stats = statsOfEvents(events(
      { type: 'user/message', data: { id: 'u1' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' } },
      {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 4 } } } },
      {
        type: 'assistant/message',
        data: { turn: 2, message: { content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 7, outputTokens: 2 } },
      },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } },
    ))
    expect(stats).toBeDefined()
    expect(stats!.turns).toBe(2)
    expect(stats!.steps).toBe(2)
    expect(stats!.usage.inputTokens).toBe(112)
    expect(stats!.usage.outputTokens).toBe(15)
    expect(stats!.usage.cacheReadTokens).toBe(50)
    expect(stats!.usage.cacheWriteTokens).toBe(0)
    expect(stats!.usage.reasoningTokens).toBe(4)
    expect(hasSessionUsage(stats!.usage)).toBe(true)
  })

  it('accumulateSessionUsage tolerates missing cache fields', () => {
    const usage = emptySessionUsage()
    accumulateSessionUsage(usage, { inputTokens: 3, outputTokens: 1 })
    expect(usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })
})
