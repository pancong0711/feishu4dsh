/**
 * RenderIntent -> Feishu channel primitives.
 *
 * Pure translation only: no network and no SHE state. File delivery,
 * approvals and interactive submissions are handed to the channel layer by
 * the caller.
 * @module feishu4dsh/integrations/she/render
 */

import type {
  ArtifactRef,
  CardAction,
  CardRenderIntent,
  FileRenderIntent,
  FormRenderIntent,
  GatewayCommandResult,
  GatewayServerEvent,
  GatewayTaskEvent,
  InteractionValue,
  RenderIntent,
} from '@she/protocol'
import {
  actionRow,
  card,
  markdownElement,
  noteElement,
  type CardButton,
  type CardTemplate,
} from '../../channel/index.js'

export type FeishuRenderOutput =
  | { readonly kind: 'text'; readonly text: string; readonly markdown: boolean }
  | { readonly kind: 'card'; readonly card: object }
  | {
      readonly kind: 'file'
      readonly artifact: ArtifactRef
      readonly caption?: string
      readonly approval: 'channel-policy' | 'always' | 'never'
    }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly intent: RenderIntent }

function plainElement(text: string): object {
  return { tag: 'div', text: { tag: 'plain_text', content: text } }
}

function buttonFor(action: CardAction, interactionId: string): CardButton {
  return {
    label: action.label,
    style: action.style ?? 'default',
    value: {
      she: {
        interactionId,
        actionId: action.id,
        ...(action.value === undefined ? {} : { value: action.value }),
      },
    },
  }
}

function cardElements(intent: CardRenderIntent): object[] {
  const elements: object[] = []
  if (intent.subtitle !== undefined && intent.subtitle !== '') elements.push(noteElement(intent.subtitle))
  for (const block of intent.blocks) {
    switch (block.type) {
      case 'text':
        elements.push(block.format === 'plain' ? plainElement(block.text) : markdownElement(block.text))
        break
      case 'fields':
        elements.push(markdownElement(block.fields.map(field => `**${field.label}**：${field.value}`).join('\n')))
        break
      case 'list':
        elements.push(markdownElement(block.items.map(item => {
          const marker = item.selected === true ? '✓' : '•'
          return `${marker} ${item.primary}${item.secondary === undefined ? '' : ` — ${item.secondary}`}`
        }).join('\n')))
        break
      case 'divider':
        elements.push({ tag: 'hr' })
        break
    }
  }
  if (intent.actions !== undefined && intent.actions.length > 0) {
    elements.push(actionRow(intent.actions.map(action => buttonFor(action, `card:${intent.renderId}:${action.id}`))))
  }
  if (elements.length === 0) elements.push(noteElement('SHE'))
  return elements
}

function renderCard(intent: CardRenderIntent): FeishuRenderOutput {
  return {
    kind: 'card',
    card: card(
      { title: intent.title ?? 'SHE', template: 'blue' satisfies CardTemplate },
      cardElements(intent),
    ),
  }
}

function renderFile(intent: FileRenderIntent): FeishuRenderOutput {
  return {
    kind: 'file',
    artifact: intent.artifact,
    ...(intent.caption === undefined ? {} : { caption: intent.caption }),
    approval: intent.approval ?? 'channel-policy',
  }
}

function renderForm(intent: FormRenderIntent): FeishuRenderOutput {
  const elements: object[] = []
  if (intent.description !== undefined && intent.description !== '') {
    elements.push(markdownElement(intent.description))
  }
  const fieldNames: Array<{ readonly id: string; readonly name: string; readonly type: 'text' | 'select' }> = []
  intent.fields.forEach((field, index) => {
    const name = `f${String(index)}`
    fieldNames.push({ id: field.id, name, type: field.type })
    const required = field.required === true ? ' *' : ''
    elements.push(markdownElement(`**${field.label}**${required}`))
    if (field.type === 'text') {
      elements.push({
        tag: 'input',
        name,
        placeholder: { tag: 'plain_text', content: field.placeholder ?? field.label },
      })
      return
    }
    const control = field.multiple === true ? 'checker' : 'select_static'
    elements.push({
      tag: control,
      name,
      placeholder: { tag: 'plain_text', content: field.label },
      options: field.options.map(option => ({
        text: {
          tag: 'plain_text',
          content: option.description === undefined || option.description === ''
            ? option.label
            : `${option.label} — ${option.description}`,
        },
        value: option.value,
      })),
    })
  })
  elements.push({
    tag: 'button',
    name: 'submit',
    text: { tag: 'plain_text', content: intent.submitLabel ?? 'Submit' },
    type: 'primary',
    action_type: 'form_submit',
    value: {
      she: {
        interactionId: intent.interactionId,
        actionId: 'submit',
        fields: fieldNames,
      },
    },
  })
  return {
    kind: 'card',
    card: card(
      { title: intent.title, template: 'blue' },
      [{ tag: 'form', name: 'she_form', elements }],
    ),
  }
}

function renderApproval(intent: Extract<RenderIntent, { kind: 'approval' }>): FeishuRenderOutput {
  const template: CardTemplate = 'orange'
  const buttons: CardButton[] = [
    {
      label: intent.approveLabel ?? 'Approve',
      style: 'primary',
      value: { she: { interactionId: intent.interactionId, actionId: 'approve' } },
    },
    {
      label: intent.denyLabel ?? 'Deny',
      style: 'danger',
      value: { she: { interactionId: intent.interactionId, actionId: 'deny' } },
    },
  ]
  const elements: object[] = []
  if (intent.body !== undefined && intent.body !== '') elements.push(markdownElement(intent.body))
  elements.push(actionRow(buttons))
  return { kind: 'card', card: card({ title: intent.title, template }, elements) }
}

/**
 * Translate one semantic RenderIntent into a Feishu-side output descriptor.
 * Unsupported intent kinds are reported explicitly rather than silently
 * dropped or sent as fabricated platform JSON.
 */
export function renderIntent(intent: RenderIntent): FeishuRenderOutput {
  switch (intent.kind) {
    case 'text':
      return { kind: 'text', text: intent.text, markdown: intent.format === 'markdown' }
    case 'progress': {
      const parts = [intent.stage, intent.label, intent.detail].filter(
        (part): part is string => part !== undefined && part !== '',
      )
      return { kind: 'text', text: parts.join(' · ') || 'SHE progress', markdown: false }
    }
    case 'status': {
      const parts = [intent.status, intent.label, intent.detail].filter(
        (part): part is string => part !== undefined && part !== '',
      )
      return { kind: 'text', text: parts.join(' · '), markdown: false }
    }
    case 'card':
      return renderCard(intent)
    case 'approval':
      return renderApproval(intent)
    case 'file':
      return renderFile(intent)
    case 'form':
      return renderForm(intent)
    default: {
      const unknown = intent as { kind?: unknown }
      return {
        kind: 'unsupported',
        reason: `unsupported RenderIntent kind: ${String(unknown.kind)}`,
        intent,
      }
    }
  }
}

/** Render the immediate read-only output of one gateway command result. */
export function renderCommandResult(result: GatewayCommandResult): readonly FeishuRenderOutput[] {
  return (result.commandResult?.renderIntents ?? []).map(renderIntent)
}

/** Render one event-stream item when it carries a RenderIntent. */
export function renderServerEvent(event: GatewayServerEvent): FeishuRenderOutput | undefined {
  return event.type === 'render' ? renderIntent(event.render) : undefined
}


/** Normalize one Feishu form/action value into the gateway.v1 interaction type. */
function interactionValueOf(value: unknown): InteractionValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const strings = value.filter((entry): entry is string => typeof entry === 'string')
    return strings.length === 0 ? undefined : strings
  }
  return undefined
}

export interface ParsedSheCardInteraction {
  readonly interactionId: string
  readonly actionId: string
  readonly values: Readonly<Record<string, InteractionValue>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Decode a Feishu card action carrying an SHE interaction.
 *
 * Cards emitted by this integration use `{ she: { interactionId, actionId,
 * fields?, value? } }`. Form submit values arrive separately in
 * `action.form_value`; the `fields` descriptor maps generated form field names
 * back to contiguous SHE field ids.
 */
export function parseSheCardInteraction(
  raw: unknown,
  formValue?: Readonly<Record<string, unknown>>,
): ParsedSheCardInteraction | undefined {
  const outer = asRecord(raw)
  if (outer === undefined) return undefined
  const she = asRecord(outer.she)
  if (she === undefined) return undefined
  const interactionId = typeof she.interactionId === 'string' ? she.interactionId : ''
  const actionId = typeof she.actionId === 'string' ? she.actionId : ''
  if (interactionId === '' || actionId === '') return undefined
  const values: Record<string, InteractionValue> = {}

  if (Array.isArray(she.fields) && formValue !== undefined) {
    for (const rawField of she.fields) {
      const field = asRecord(rawField)
      if (field === undefined) continue
      const id = typeof field.id === 'string' ? field.id : undefined
      const name = typeof field.name === 'string' ? field.name : undefined
      if (id === undefined || name === undefined) continue
      const value = interactionValueOf(formValue[name])
      if (value !== undefined) values[id] = value
    }
  } else {
    const value = interactionValueOf(she.value)
    if (value !== undefined) values.value = value
  }
  return { interactionId, actionId, values }
}


/** Human-readable status line for a gateway task event.
 *
 * Agent deltas and raw tool traffic intentionally do not become chat messages:
 * they are too noisy. Persistent status panels can consume them separately.
 */
export function renderTaskEvent(event: GatewayTaskEvent): RenderIntent | undefined {
  const base = { renderId: `task:${event.eventId}`, sequence: event.sequence, format: 'plain' as const }
  switch (event.type) {
    case 'task.accepted':
      return {
        kind: 'text',
        ...base,
        text: `SHE task accepted: ${event.taskRef} (queue ${String(event.queuePosition)})`,
      }
    case 'task.progress': {
      const detail = [event.stage, event.label, event.detail].filter(
        (part): part is string => part !== undefined && part !== '',
      ).join(' · ')
      return { kind: 'text', ...base, text: `SHE task ${event.taskId}: ${detail || event.stage}` }
    }
    case 'approval.requested':
      return {
        kind: 'approval',
        renderId: `task:${event.eventId}:approval`,
        sequence: event.sequence,
        interactionId: event.interactionId,
        title: event.title,
        ...(event.body === undefined ? {} : { body: event.body }),
      }
    case 'artifact.created':
      return {
        kind: 'text',
        ...base,
        text: `SHE artifact: ${event.artifact.fileName} (${String(event.artifact.bytes)} bytes)`,
      }
    case 'task.completed':
      return {
        kind: 'text',
        ...base,
        text: event.summary === undefined || event.summary === ''
          ? `SHE task completed: ${event.taskId}`
          : `SHE task completed: ${event.summary}`,
      }
    case 'task.failed':
      return {
        kind: 'text',
        ...base,
        text: `SHE task failed (${event.error.code}): ${event.error.message}`,
      }
    default:
      return undefined
  }
}
