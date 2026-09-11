import { describe, expect, it } from 'vitest'
import {
  approvalCard, collapsiblePanel, settledApprovalCard, truncateMiddle, encodeActionValue, decodeActionValue,
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

describe('collapsiblePanel (R36-2)', () => {
  it('carries the header title, the fold state and the reasoning body', () => {
    const panel = collapsiblePanel({ title: '💭 思考过程（12 字 · 1s）', content: 'COT', expanded: false }) as Record<string, any>
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(false)
    expect(panel.header.title).toEqual({ tag: 'markdown', content: '💭 思考过程（12 字 · 1s）' })
    expect(panel.elements[0].text.content).toBe('COT')
    // The reasoning body is a plain markdown div — same element the body uses.
    expect(panel.elements[0].tag).toBe('div')

    const open = collapsiblePanel({ title: 't', content: 'c', expanded: true }) as Record<string, any>
    expect(open.expanded).toBe(true)
  })
})

describe('truncateMiddle (R36-2)', () => {
  it('returns short text untouched', () => {
    const short = truncateMiddle('hello', 10, () => 'OMITTED')
    expect(short).toEqual({ text: 'hello', omitted: 0 })
  })

  it('keeps head and tail and reports the dropped count', () => {
    const text = 'H'.repeat(100) + 'M'.repeat(800) + 'T'.repeat(100)
    const result = truncateMiddle(text, 200, omitted => `…（已省略 ${omitted} 字）…`)
    expect(result.omitted).toBe(800)
    expect(result.text.startsWith('H'.repeat(100))).toBe(true)
    expect(result.text.endsWith('T'.repeat(100))).toBe(true)
    expect(result.text).toContain('已省略 800 字')
    // The kept text is EXACTLY the budget; only the marker is extra.
    expect(result.text.replace('…（已省略 800 字）…', '').replace(/\n/g, '')).toHaveLength(200)
  })

  it('dropping the budget to zero still yields a marker, never a crash', () => {
    const result = truncateMiddle('abcdef', 0, omitted => `(${omitted})`)
    expect(result.omitted).toBe(6)
    expect(result.text).toBe('\n(6)\n')
    expect(truncateMiddle('abcdef', -5, omitted => `(${omitted})`).omitted).toBe(6)
  })
})
