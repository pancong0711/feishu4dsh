import { describe, expect, it } from 'vitest'
import { scopeKeyOf, resolveScopeKey, agentKeyOf, sessionIdOf, AgentLedger } from '../src/sessions.js'

describe('scopeKeyOf', () => {
  const base = { chatId: 'oc_chat', chatType: 'group' as const, senderId: 'ou_a' }

  it('chat scope keys on the chat alone', () => {
    expect(scopeKeyOf('chat', base)).toBe('oc_chat')
    expect(scopeKeyOf('chat', { ...base, senderId: 'ou_b' })).toBe('oc_chat')
  })

  it('thread scope splits on thread id', () => {
    expect(scopeKeyOf('chat-thread', base)).toBe('oc_chat')
    expect(scopeKeyOf('chat-thread', { ...base, threadId: 'th_1' })).toBe('oc_chat@th_1')
  })

  it('sender scope splits on sender', () => {
    expect(scopeKeyOf('chat-sender', base)).toBe('oc_chat#ou_a')
    expect(scopeKeyOf('chat-sender', { ...base, senderId: 'ou_b' })).toBe('oc_chat#ou_b')
  })
})

describe('resolveScopeKey', () => {
  it('uses the configured scope', () => {
    const input = { chatId: 'oc_chat', chatType: 'group' as const, senderId: 'ou_a' }
    expect(resolveScopeKey({ sessionScope: 'chat' }, input)).toBe('oc_chat')
    expect(resolveScopeKey({ sessionScope: 'chat-sender' }, input)).toBe('oc_chat#ou_a')
  })
})

describe('agentKeyOf', () => {
  it('folds scope and workspace into one key', () => {
    expect(agentKeyOf('oc_chat', '/a')).toBe('oc_chat§/a')
    expect(agentKeyOf('oc_chat', '/a')).not.toBe(agentKeyOf('oc_chat', '/b'))
    expect(agentKeyOf('oc_chat', '/a')).not.toBe(agentKeyOf('oc_other', '/a'))
  })
})

describe('sessionIdOf', () => {
  it('is deterministic and stable', () => {
    expect(sessionIdOf('oc_chat', '/a', 0)).toBe(sessionIdOf('oc_chat', '/a', 0))
    expect(sessionIdOf('oc_chat', '/a', 0)).toMatch(/^feishu-[0-9a-f]{12}$/)
  })

  it('differs across workspaces', () => {
    expect(sessionIdOf('oc_chat', '/a', 0)).not.toBe(sessionIdOf('oc_chat', '/b', 0))
  })

  it('differs across scope keys', () => {
    expect(sessionIdOf('oc_a', '/ws', 0)).not.toBe(sessionIdOf('oc_b', '/ws', 0))
  })

  it('changes with generation', () => {
    expect(sessionIdOf('oc_chat', '/a', 1)).not.toBe(sessionIdOf('oc_chat', '/a', 0))
    expect(sessionIdOf('oc_chat', '/a', 1)).toBe(sessionIdOf('oc_chat', '/a', 0) + '-r1')
  })
})

describe('AgentLedger', () => {
  it('stores, looks up, and deletes entries by agent key', () => {
    const ledger = new AgentLedger<{ id: string }>()
    ledger.set('oc_a§/ws', { handle: { id: 'h' }, generation: 0, sessionId: 'feishu-x' })
    expect(ledger.get('oc_a§/ws')?.handle.id).toBe('h')
    expect(ledger.ownsSession('feishu-x')).toBe(true)
    expect(ledger.keyOf('feishu-x')).toBe('oc_a§/ws')
    ledger.delete('oc_a§/ws')
    expect(ledger.get('oc_a§/ws')).toBeUndefined()
  })

  it('reset advances the generation per agent key', () => {
    const ledger = new AgentLedger<{ id: string }>()
    expect(ledger.generationOf('oc_a§/ws')).toBe(0)
    ledger.set('oc_a§/ws', { handle: { id: 'h' }, generation: 0, sessionId: 'feishu-x' })
    const next = ledger.reset('oc_a§/ws')
    expect(next).toBe(1)
    expect(ledger.get('oc_a§/ws')).toBeUndefined()
    expect(ledger.generationOf('oc_a§/ws')).toBe(1)
  })

  it('keeps distinct workspaces apart', () => {
    const ledger = new AgentLedger<{ id: string }>()
    ledger.set('oc_a§/w1', { handle: { id: 'h1' }, generation: 0, sessionId: 's1' })
    ledger.set('oc_a§/w2', { handle: { id: 'h2' }, generation: 0, sessionId: 's2' })
    expect(ledger.get('oc_a§/w1')?.handle.id).toBe('h1')
    expect(ledger.get('oc_a§/w2')?.handle.id).toBe('h2')
  })
})
