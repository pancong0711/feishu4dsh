import { describe, expect, it } from 'vitest'
import {
  approvalCard, settledApprovalCard, encodeActionValue, decodeActionValue,
  type CardActionPayload,
} from '../src/cards.js'

const payload: CardActionPayload = { kind: 'approval', token: 'tok', decision: 'deny', chatId: 'oc_a' }

describe('approvalCard', () => {
  it('carries title, body, both buttons, and the note', () => {
    const card = approvalCard({
      title: '⚠️ T', body: 'run `rm -rf`', approveLabel: 'Allow', denyLabel: 'Deny',
      payload, note: 'whoever drives decides',
    }) as Record<string, any>
    expect(card.header.title.content).toBe('⚠️ T')
    expect(card.header.template).toBe('orange')
    const buttons = card.elements.find((e: any) => e.tag === 'action').actions
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text.content).toBe('Allow')
    expect(buttons[0].type).toBe('primary')
    expect(buttons[0].value.decision).toBe('approve')
    expect(buttons[1].value.decision).toBe('deny')
    expect(card.elements.some((e: any) => e.tag === 'note')).toBe(true)
  })
})

describe('action value codec', () => {
  it('round-trips a payload', () => {
    const encoded = encodeActionValue(payload)
    expect(decodeActionValue(encoded)).toEqual(payload)
  })

  it('rejects garbage values', () => {
    expect(decodeActionValue(undefined)).toBeNull()
    expect(decodeActionValue(null)).toBeNull()
    expect(decodeActionValue('token')).toBeNull()
    expect(decodeActionValue({ kind: 'approval', token: '', decision: 'approve', chatId: 'oc_a' })).toBeNull()
    expect(decodeActionValue({ kind: 'other', token: 't', decision: 'approve', chatId: 'oc_a' })).toBeNull()
    expect(decodeActionValue({ kind: 'approval', token: 't', decision: 'maybe', chatId: 'oc_a' })).toBeNull()
    expect(decodeActionValue({ kind: 'file-send', token: 't', decision: 'deny', chatId: '' })).toBeNull()
  })
})

describe('settledApprovalCard', () => {
  it('renders one tone per outcome', () => {
    const approved = settledApprovalCard('T', 'Allowed by A', 'approved') as Record<string, any>
    const denied = settledApprovalCard('T', 'Denied by B', 'denied') as Record<string, any>
    const timedOut = settledApprovalCard('T', 'No response', 'timedOut') as Record<string, any>
    expect(approved.header.template).toBe('green')
    expect(denied.header.template).toBe('red')
    expect(timedOut.header.template).toBe('grey')
    expect(approved.elements[0].text.content).toContain('Allowed by A')
  })
})
