import { describe, expect, it } from 'vitest'
import {
  autoTitleOf, hydrateSessionRegistry, listSessions, nextGenOf, renameSession, staleSessionsOf, upsertSession,
  type SessionRecord, type SessionRegistry,
} from '../src/session-registry.js'

const NOW = new Date('2026-08-28T14:02:00').getTime()

/** Freeze `value` and every nested object/array (the host's settings contract). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function recordOf(gen: number, sessionId: string): SessionRecord {
  return { gen, sessionId, title: `090${gen} 会话`, titleIsAuto: true, createdAt: NOW, lastActiveAt: NOW }
}

describe('hydrateSessionRegistry (R30)', () => {
  it('rebuilds a deep-frozen settings graph into owned, mutable state', () => {
    const raw = deepFreeze({
      'oc_a§/tmp/ws': [recordOf(1, 'feishu-a-r1'), recordOf(2, 'feishu-a-r2')],
    }) as SessionRegistry

    const registry = hydrateSessionRegistry(raw)
    const list = registry['oc_a§/tmp/ws']!
    expect(list.map(r => r.sessionId)).toEqual(['feishu-a-r1', 'feishu-a-r2'])
    // The hydrated graph is plugin-owned: no frozen arrays, no frozen records.
    expect(Object.isFrozen(list)).toBe(false)
    expect(list.every(record => !Object.isFrozen(record))).toBe(true)

    // Every registry mutation works — the exact operations that threw on the
    // aliased frozen graph (upsert touch/push, rename).
    list[0]!.lastActiveAt = NOW + 5
    list.push(recordOf(3, 'feishu-a-r3'))
    list[0]!.title = '用户标题'
    list.sort((a, b) => b.gen - a.gen)
    expect(list.map(r => r.gen)).toEqual([3, 2, 1])

    // The frozen source stays untouched (no accidental writes through aliases).
    expect(Object.isFrozen(raw['oc_a§/tmp/ws']![0])).toBe(true)
    expect(raw['oc_a§/tmp/ws']![0]!.lastActiveAt).toBe(NOW)
  })

  it('skips keys without the scope§workspace separator and reports them', () => {
    const reports: string[] = []
    const raw = {
      oc_broken: [recordOf(1, 'feishu-x-r1')],
      'oc_ok§/tmp/ws': [recordOf(1, 'feishu-ok-r1')],
    } as unknown as SessionRegistry
    const registry = hydrateSessionRegistry(raw, line => reports.push(line))
    expect(Object.keys(registry)).toEqual(['oc_ok§/tmp/ws'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('oc_broken')
  })

  it('tolerates undefined input and non-array values', () => {
    expect(hydrateSessionRegistry(undefined)).toEqual({})
    const registry = hydrateSessionRegistry({ 'oc_a§/tmp/ws': undefined } as unknown as SessionRegistry)
    expect(registry['oc_a§/tmp/ws']).toEqual([])
  })
})

describe('autoTitleOf (R29 D5)', () => {
  it('uses the first non-empty line, date first, capped at 12 code points', () => {
    const title = autoTitleOf('\n  修复登录页的会话跳转问题\n细节如下……', new Date('2026-08-28T10:00:00'))
    expect(title).toBe('0828 修复登录页的会话跳转问题')
  })

  it('truncates by code points and falls back to the date when blank', () => {
    expect(autoTitleOf('123456789012345', new Date('2026-08-28T10:00:00'))).toBe('0828 123456789012')
    expect(autoTitleOf('   \n \n', new Date('2026-08-28T10:00:00'))).toBe('0828')
    expect(autoTitleOf(undefined, new Date('2026-08-28T10:00:00'))).toBe('0828')
  })
})

describe('session registry', () => {
  it('upsert creates, then touches; the auto title upgrades from the hint', () => {
    const registry: SessionRegistry = {}
    const first = upsertSession(registry, 'k', 0, 'feishu-a', { now: NOW })
    expect(first.title).toMatch(/^0828/)
    const second = upsertSession(registry, 'k', 0, 'feishu-a', { hintText: '新主题', now: NOW + 1000 })
    expect(second.lastActiveAt).toBe(NOW + 1000)
    expect(second.title).toContain('新主题')
  })

  it('a user title is never overwritten by hints', () => {
    const registry: SessionRegistry = {}
    upsertSession(registry, 'k', 0, 'feishu-a', { hintText: 'auto', now: NOW })
    renameSession(registry, 'k', 0, '我的标题')
    const record = upsertSession(registry, 'k', 0, 'feishu-a', { hintText: 'another', now: NOW + 1 })
    expect(record.title).toBe('我的标题')
    expect(renameSession(registry, 'k', 9, 'x')).toBe(false)
  })

  it('lists newest generation first and computes the next gen from known max', () => {
    const registry: SessionRegistry = {}
    upsertSession(registry, 'k', 0, 'feishu-a', { now: NOW })
    upsertSession(registry, 'k', 1, 'feishu-a-r1', { now: NOW })
    upsertSession(registry, 'k', 2, 'feishu-a-r2', { now: NOW })
    expect(listSessions(registry, 'k').map(r => r.gen)).toEqual([2, 1, 0])
    expect(nextGenOf(registry, 'k', 2)).toBe(3)
    // A pointer sitting on an OLD generation must not make /new reuse ids.
    expect(nextGenOf(registry, 'k', 0)).toBe(3)
    expect(nextGenOf(registry, 'k', 5)).toBe(6)
  })

  it('staleSessionsOf skips the active and already-archived entries', () => {
    const registry: SessionRegistry = {}
    upsertSession(registry, 'k', 0, 'feishu-a', { now: NOW - 10 * 86_400_000 })
    upsertSession(registry, 'k', 1, 'feishu-b', { now: NOW - 10 * 86_400_000 })
    upsertSession(registry, 'k', 2, 'feishu-c', { now: NOW - 10 * 86_400_000 })
    upsertSession(registry, 'k', 3, 'feishu-live', { now: NOW })
    const stale = staleSessionsOf(registry, 'k', 3, NOW, 2, id => id === 'feishu-b')
    expect(stale.map(r => r.sessionId)).toEqual(['feishu-a', 'feishu-c'])
  })
})
