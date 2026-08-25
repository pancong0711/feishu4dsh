/**
 * Interactive-card builders and the action-payload codec. Pure functions:
 * no network here, so every card shape is unit-testable.
 * @module feishu4dsh/cards
 */

/** One card button: label, style, and the value payload Feishu echoes back. */
export interface CardButton {
  readonly label: string
  readonly value: Record<string, unknown>
  readonly style?: 'primary' | 'danger' | 'default'
}

/** Header tone of a card. */
export type CardTemplate = 'blue' | 'orange' | 'red' | 'green' | 'grey'

/**
 * Assemble one Feishu interactive-card object.
 * @param header - title and tone.
 * @param elements - card body elements, already in render order.
 * @returns the card object accepted by the send/patch APIs.
 */
export function card(
  header: { title: string; template: CardTemplate },
  elements: unknown[],
): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: header.title },
      template: header.template,
    },
    elements,
  }
}

/** A `lark_md` block element. */
export function markdownElement(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } }
}

/** A small footer note row. */
export function noteElement(text: string): object {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: text }] }
}

/** One action row from a button list. */
export function actionRow(buttons: CardButton[]): object {
  return {
    tag: 'action',
    actions: buttons.map(button => ({
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: button.style ?? 'default',
      value: button.value,
    })),
  }
}

/** Action kinds the channel binds to card buttons. */
export type CardActionKind = 'approval' | 'file-send'

/** The decoded payload behind one card click. */
export interface CardActionPayload {
  readonly kind: CardActionKind
  /** Ties the click to the pending question it settles. */
  readonly token: string
  /** approve / deny / etc.; card-kind specific. */
  readonly decision: 'approve' | 'deny'
  /** Chat the card was created in; a forward to another chat must not act. */
  readonly chatId: string
}

/**
 * Encode one action payload for a button's `value`. Kept flat-string-safe:
 * Feishu accepts any JSON value, round-tripping through this pair.
 * @param payload - the payload to carry.
 * @returns the value object.
 */
export function encodeActionValue(payload: CardActionPayload): Record<string, unknown> {
  return { ...payload }
}

/**
 * Decode one card click's `action.value` back into a payload, or `null`
 * when it is not one of this channel's actions (somebody else's card).
 * @param value - raw value echoed by Feishu.
 * @returns the decoded payload, or null.
 */
export function decodeActionValue(value: unknown): CardActionPayload | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const kind = record.kind
  const token = record.token
  const decision = record.decision
  const chatId = record.chatId
  if ((kind !== 'approval' && kind !== 'file-send')
    || typeof token !== 'string' || token === ''
    || (decision !== 'approve' && decision !== 'deny')
    || typeof chatId !== 'string' || chatId === '') {
    return null
  }
  return { kind, token, decision, chatId }
}

/** Options for one approval-question card. */
export interface ApprovalCardOptions {
  readonly title: string
  /** Markdown body: what is being decided. */
  readonly body: string
  readonly approveLabel: string
  readonly denyLabel: string
  readonly payload: CardActionPayload
  /** Footer note, e.g. who-approves or the timeout. */
  readonly note?: string
}

/**
 * Build the interactive card that asks a human to allow or deny one
 * tool call (or one outbound file).
 * @param options - card content and action wiring.
 * @returns the card object.
 */
export function approvalCard(options: ApprovalCardOptions): object {
  const elements: unknown[] = [markdownElement(options.body)]
  elements.push(actionRow([
    { label: options.approveLabel, value: { ...options.payload, decision: 'approve' }, style: 'primary' },
    { label: options.denyLabel, value: { ...options.payload, decision: 'deny' }, style: 'danger' },
  ]))
  if (options.note !== undefined && options.note !== '') elements.push(noteElement(options.note))
  return card({ title: options.title, template: 'orange' }, elements)
}

/** Settled-state styles for the replacement card. */
export const SETTLED_TEMPLATES = {
  approved: 'green',
  denied: 'red',
  timedOut: 'grey',
} as const satisfies Record<string, CardTemplate>

/**
 * Build the card that replaces an approval card once it is settled.
 * @param title - original card title, kept for continuity.
 * @param status - the one-line outcome.
 * @param outcome - which settled state.
 * @returns the card object.
 */
export function settledApprovalCard(title: string, status: string, outcome: 'approved' | 'denied' | 'timedOut'): object {
  const icon = outcome === 'approved' ? '✅' : outcome === 'denied' ? '❌' : '⏱️'
  return card(
    { title, template: SETTLED_TEMPLATES[outcome] },
    [markdownElement(`${icon} ${status}`)],
  )
}
