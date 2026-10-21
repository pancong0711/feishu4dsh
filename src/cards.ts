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

/**
 * R36-2: budget for the reasoning text rendered inside one collapsible panel.
 * The panel element is one of the card's elements; the SDK's
 * `DEFAULT_MAX_ELEMENT_CHARS` (30000) is the reference limit, and this stays
 * well under it so the whole-card JSON (panel + body + wrappers) also fits the
 * per-message content limit Feishu enforces on `im.v1.message.patch`.
 */
export const REASONING_PANEL_MAX_CHARS = 12_000

/**
 * R36-2 / R49: total rendered text (reasoning panel + body) ONE reply card may
 * carry. Feishu rejects an oversized markdown element outright (~30k chars);
 * past this budget the live card **rolls over to a fresh streaming card** that
 * continues the tail (see the bridge's `openCardReplyStream` rollover), so a
 * long answer streams across several in-thread cards instead of freezing on the
 * head and dumping at turn end. Kept below the hard limit with margin.
 */
export const CARD_STREAM_MAX_CHARS = 28_000

/**
 * R49: minimum characters newly added before a card page is allowed to roll
 * over again. Bounds how often the heavy "create a new card" round-trip fires
 * when a turn emits content fast, without visibly truncating any page.
 */
export const CARD_ROLLOVER_MIN_CHARS = 2_000

/**
 * R49: minimum wall-clock spacing between two consecutive card rollovers (ms).
 * The companion throttle to {@link CARD_ROLLOVER_MIN_CHARS}; together they keep
 * paging from hammering the Feishu API while still delivering mid-turn.
 */
export const CARD_ROLLOVER_MIN_INTERVAL_MS = 1_000

/**
 * R36-2: one collapsible panel (`collapsible_panel`, card JSON 1.0 — the same
 * shape the other cards in this module use). On Feishu clients older than V7.9
 * the panel body renders as an "upgrade your client" placeholder; the rest of
 * the card is unaffected, which is why the reasoning block is safe to fold.
 * @param options - header title, panel body and initial fold state.
 * @returns the panel element.
 */
export function collapsiblePanel(options: { title: string; content: string; expanded: boolean }): object {
  return {
    tag: 'collapsible_panel',
    expanded: options.expanded,
    header: {
      title: { tag: 'markdown', content: options.title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [markdownElement(options.content)],
  }
}

/**
 * R36-2: shorten a long text to `budget` characters, keeping its head and its
 * tail and stating how much was dropped in between. Head and tail carry the
 * parts a reader needs most (the opening framing and the conclusion), and the
 * dropped middle is announced rather than silently lost.
 *
 * The rendered result is `budget` characters plus the `join(omitted)` marker —
 * callers size their budget net of that marker.
 * @param text - full text.
 * @param budget - characters to keep (split evenly between head and tail).
 * @param join - renders the omission marker for the dropped character count.
 * @returns the shortened text and the number of dropped characters (0 = kept).
 */
export function truncateMiddle(
  text: string,
  budget: number,
  join: (omitted: number) => string,
): { text: string; omitted: number } {
  if (budget < 0) budget = 0
  if (text.length <= budget) return { text, omitted: 0 }
  const head = Math.floor(budget / 2)
  const tail = budget - head
  const omitted = text.length - head - tail
  return {
    text: `${text.slice(0, head)}\n${join(omitted)}\n${text.slice(text.length - tail)}`,
    omitted,
  }
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
export type CardActionKind = 'approval' | 'file-send' | 'menu' | 'question'

/** Actions a menu card supports (`R32`). */
export type MenuAct = 'sel' | 'page' | 'up' | 'ok' | 'addcur'

/** The decoded payload behind one approval-style card click. */
export interface ApprovalActionPayload {
  readonly kind: 'approval' | 'file-send'
  /** Ties the click to the pending question it settles. */
  readonly token: string
  /** approve / deny / etc.; card-kind specific. */
  readonly decision: 'approve' | 'deny'
  /** Chat the card was created in; a forward to another chat must not act. */
  readonly chatId: string
}

/**
 * The decoded payload behind one menu-card interaction (R32). Buttons carry
 * it as a JSON object; `select_static` options may only carry a string, so
 * {@link encodeMenuValue}/{@link parseMenuValue} provide the string form and
 * {@link decodeActionValue} accepts both.
 */
export interface MenuActionPayload {
  readonly kind: 'menu'
  readonly menuId: string
  readonly act: MenuAct
  /** Global option index (sel) or target page (page). */
  readonly idx?: number
  /** Chat the card was created in; a forward to another chat must not act. */
  readonly chatId: string
}

/**
 * The decoded payload behind one `ask_user` form submit (R51). The form's
 * field values ride on `action.form_value` of the raw callback and are read
 * by the bridge, so this payload only needs the identity of the pending ask.
 */
export interface QuestionActionPayload {
  readonly kind: 'question'
  /** Ties the submit to the pending question batch it settles. */
  readonly token: string
  /** Chat the card was created in; a forward to another chat must not act. */
  readonly chatId: string
}

/** The decoded payload behind one card click. */
export type CardActionPayload = ApprovalActionPayload | MenuActionPayload | QuestionActionPayload

/**
 * The compact string form of one menu action, for components whose option
 * `value` must be a string (`select_static`). `|` never appears in ids,
 * chat ids, or the fixed act set.
 */
export function encodeMenuValue(menuId: string, act: MenuAct, chatId: string, idx?: number): string {
  return `m|${menuId}|${act}|${idx ?? '-'}|${chatId}`
}

/** Parse one {@link encodeMenuValue} string back into a payload, or null. */
export function parseMenuValue(value: string): MenuActionPayload | null {
  const parts = value.split('|')
  if (parts.length !== 5 || parts[0] !== 'm') return null
  const menuId = parts[1]
  const actText = parts[2]
  const idxText = parts[3]
  const chatId = parts[4]
  const acts: MenuAct[] = ['sel', 'page', 'up', 'ok', 'addcur']
  if (menuId === undefined || actText === undefined || idxText === undefined || chatId === undefined) return null
  if (menuId === '' || chatId === '' || !acts.includes(actText as MenuAct)) return null
  const idx = idxText === '-' ? undefined : Number(idxText)
  if (idx !== undefined && !Number.isInteger(idx)) return null
  return { kind: 'menu', menuId, act: actText as MenuAct, idx, chatId }
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
 * Accepts the object form (buttons) and the string form (select options).
 * @param value - raw value echoed by Feishu.
 * @returns the decoded payload, or null.
 */
export function decodeActionValue(value: unknown): CardActionPayload | null {
  if (typeof value === 'string') return parseMenuValue(value)
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'menu') {
    const menuId = record.menuId
    const act = record.act
    const chatId = record.chatId
    const acts: MenuAct[] = ['sel', 'page', 'up', 'ok', 'addcur']
    if (typeof menuId !== 'string' || menuId === ''
      || typeof act !== 'string' || !acts.includes(act as MenuAct)
      || typeof chatId !== 'string' || chatId === '') {
      return null
    }
    const idx = record.idx
    if (idx !== undefined && typeof idx !== 'number') return null
    return { kind: 'menu', menuId, act: act as MenuAct, idx, chatId }
  }
  const kind = record.kind
  const token = record.token
  const decision = record.decision
  const chatId = record.chatId
  if (kind === 'question') {
    if (typeof token !== 'string' || token === ''
      || typeof chatId !== 'string' || chatId === '') return null
    return { kind: 'question', token, chatId }
  }
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

/* ------------------------------------------------------------------ */
/* ask_user question form (R51)                                        */
/* ------------------------------------------------------------------ */

/**
 * One question as the card renderer consumes it (structural mirror of the
 * host `AskUserQuestionItem`, kept local so this module stays host-free).
 */
export interface QuestionCardItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** Copy the question card needs; supplied by the caller's string table. */
export interface QuestionCardCopy {
  readonly title: string
  readonly submit: string
  readonly selectPlaceholder: string
  readonly customPlaceholder: string
  readonly noOptionsHint: string
}

/** Element-name prefixes for the form fields, keyed by question index. */
export const QUESTION_FIELD_PREFIX = 'q'
export const QUESTION_CUSTOM_PREFIX = 'c'

/**
 * Field name of question `index`'s option control.
 * @param index - zero-based question position.
 * @returns the form field name.
 */
export function questionFieldName(index: number): string {
  return `${QUESTION_FIELD_PREFIX}${String(index)}`
}

/**
 * Field name of question `index`'s free-text control.
 * @param index - zero-based question position.
 * @returns the form field name.
 */
export function questionCustomName(index: number): string {
  return `${QUESTION_CUSTOM_PREFIX}${String(index)}`
}

/**
 * Normalize one `form_value` entry into the selected-label list the host
 * answer batch wants: a `select_static` field echoes one string, a `checker`
 * field echoes an array, and an untouched field echoes nothing.
 * @param value - raw form value for one question's option control.
 * @returns selected labels, in the order the form reported them.
 */
export function selectedLabelsOf(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * Build the interactive form card for one `ask_user` request: per question a
 * heading block plus a native option control (`select_static` single-select /
 * `checker` multi-select) and a free-text `input`, all inside ONE form whose
 * submit button carries the pending-ask identity. Native form controls are
 * what make "Other…" answers and multi-select possible on Feishu at all.
 * @param items - the questions to render.
 * @param options - copy table and the action payload to bind.
 * @returns the card object for `send({card})`.
 */
export function questionCard(
  items: readonly QuestionCardItem[],
  options: { copy: QuestionCardCopy; payload: { token: string; chatId: string } },
): object {
  const fields: object[] = []
  items.forEach((item, index) => {
    const heading = item.header === undefined || item.header === ''
      ? `**${String(index + 1)}. ${item.question}**`
      : `**${String(index + 1)}. ${item.header}**\n${item.question}`
    const detail = item.detail === undefined || item.detail === '' ? '' : `\n\n${item.detail}`
    fields.push({ tag: 'div', text: { tag: 'lark_md', content: `${heading}${detail}` } })
    const choices = item.options ?? []
    if (choices.length > 0) {
      const control = {
        tag: item.multiSelect === true ? 'checker' : 'select_static',
        name: questionFieldName(index),
        placeholder: { tag: 'plain_text', content: options.copy.selectPlaceholder },
        options: choices.map(choice => ({
          text: { tag: 'plain_text', content: choice.description === undefined || choice.description === '' ? choice.label : `${choice.label} — ${choice.description}` },
          value: choice.label,
        })),
      }
      fields.push(control)
    } else {
      fields.push(markdownElement(options.copy.noOptionsHint))
    }
    fields.push({
      tag: 'input',
      name: questionCustomName(index),
      placeholder: { tag: 'plain_text', content: options.copy.customPlaceholder },
    })
  })
  fields.push({
    tag: 'button',
    name: 'submit',
    text: { tag: 'plain_text', content: options.copy.submit },
    type: 'primary',
    action_type: 'form_submit',
    value: { kind: 'question', token: options.payload.token, chatId: options.payload.chatId },
  })
  return card(
    { title: options.copy.title, template: 'blue' },
    [{ tag: 'form', name: 'askuser', elements: fields }],
  )
}

/**
 * Render the settled state of a question card: what was answered, or that the
 * ask expired un-answered.
 * @param title - card header.
 * @param status - one-line operator-readable outcome.
 * @param outcome - drives the icon and header tone.
 * @returns the replacement card for `updateCard`.
 */
export function settledQuestionCard(title: string, status: string, outcome: 'answered' | 'timedOut'): object {
  const icon = outcome === 'answered' ? '✅' : '⏱️'
  return card(
    { title, template: outcome === 'answered' ? 'green' : 'grey' },
    [markdownElement(`${icon} ${status}`)],
  )
}
