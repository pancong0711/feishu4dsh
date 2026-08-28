/**
 * Session statistics for `/status`, computed from the dsh session log
 * (`HostSession.events`). Pure logic: no host imports, no I/O, unit-testable.
 *
 * 口径（R26，与每轮摘要共用同一累加函数）：
 * - 轮（turns）  = `turn/start` 事件计数；
 * - 步（steps）  = `assistant/message` 事件计数；
 * - Token 累计   = `assistant/message.usage` 与 `assistant/chunk(usage)` 的累加。
 *
 * ⚠️ 口径核对（工作单 D6）：若上游对同一步同时发 chunk(usage) 与 message.usage，
 * 此处会双计——与 R7 每轮摘要的行为一致；须在部署机对照 dsh web 的显示收敛，
 * 结论回填本文档。宿主不暴露日志（旧版本）时返回 undefined，由调用方渲染“—”。
 * @module feishu4dsh/session-stats
 */

import type { HostSessionEvent, TokenUsageData } from './host.js'
import { isAssistantChunkEvent, isAssistantMessageEvent, isTurnStartEvent } from './host.js'

/** Cumulative token usage across one session. */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** Everything the `/status` statistics block needs. */
export interface SessionStats {
  /** Number of turns (`turn/start` count). */
  readonly turns: number
  /** Number of committed assistant steps (`assistant/message` count). */
  readonly steps: number
  readonly usage: SessionUsage
}

export function emptySessionUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

/** Add one usage payload into the accumulator (cache fields optional upstream). */
export function accumulateSessionUsage(target: SessionUsage, usage: TokenUsageData): void {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.cacheReadTokens += usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  target.reasoningTokens += usage.reasoningTokens ?? 0
}

/** Whether any dimension of the accumulator is non-zero. */
export function hasSessionUsage(usage: SessionUsage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0
    || usage.cacheWriteTokens > 0 || usage.reasoningTokens > 0
}

/**
 * Scan one session log for `/status` statistics. Returns `undefined` when the
 * host does not expose the log (old host) so the caller renders “—” instead
 * of misleading zeros; an EMPTY log yields zeros (session genuinely fresh).
 */
export function statsOfEvents(events: readonly HostSessionEvent[] | undefined): SessionStats | undefined {
  if (!Array.isArray(events)) return undefined
  const stats = { turns: 0, steps: 0, usage: emptySessionUsage() }
  for (const event of events) {
    if (isTurnStartEvent(event)) {
      stats.turns += 1
    } else if (isAssistantMessageEvent(event)) {
      stats.steps += 1
      if (event.data.usage !== undefined) accumulateSessionUsage(stats.usage, event.data.usage)
    } else if (isAssistantChunkEvent(event)) {
      const chunk = event.data.chunk
      if (chunk.type === 'usage' && chunk.usage !== undefined) accumulateSessionUsage(stats.usage, chunk.usage)
    }
  }
  return stats
}
