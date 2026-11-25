import { describe, expect, it, vi } from 'vitest'
import {
  GATEWAY_V1_FIXTURES,
  GATEWAY_V1_TASK_EVENT,
  type RenderTarget,
} from '@she/protocol'
import {
  FeishuSheAdapter,
  type FeishuRenderPort,
  type SheGatewayInboundSink,
} from '../src/integrations/she/index.js'

const target: RenderTarget = { conversation: { id: 'chat-1', kind: 'dm' } }

function port(): FeishuRenderPort & {
  texts: Array<{ text: string; markdown: boolean }>
  cards: object[]
  files: string[]
} {
  const state = {
    texts: [] as Array<{ text: string; markdown: boolean }>,
    cards: [] as object[],
    files: [] as string[],
  }
  return {
    ...state,
    sendText: async (_target, text, markdown) => {
      state.texts.push({ text, markdown })
      return { messageId: `m-${state.texts.length}` }
    },
    sendCard: async (_target, cardObject) => {
      state.cards.push(cardObject)
      return { messageId: `c-${state.cards.length}` }
    },
    sendFile: async (_target, artifact) => {
      state.files.push(artifact.fileName)
      return { messageId: `f-${state.files.length}` }
    },
    get texts() { return state.texts },
    get cards() { return state.cards },
    get files() { return state.files },
  }
}

describe('Feishu SHE gateway adapter', () => {
  it('dispatches inbound events to the started sink', async () => {
    const adapter = new FeishuSheAdapter({ version: 'test', port: port(), now: () => 123 })
    const seen: string[] = []
    const sink: SheGatewayInboundSink = { onInbound: async event => { seen.push(event.requestId) } }
    await adapter.start(sink)
    await adapter.dispatchInbound(GATEWAY_V1_FIXTURES.commandRequest.command)
    expect(seen).toEqual(['req-fixture-1'])
    await adapter.stop()
    await expect(adapter.dispatchInbound(GATEWAY_V1_FIXTURES.commandRequest.command)).rejects.toThrow('not started')
  })

  it('renders text, card and file intents and returns stable receipts', async () => {
    const renderPort = port()
    const taskEvents: string[] = []
    const adapter = new FeishuSheAdapter({
      version: 'test',
      port: renderPort,
      now: () => 999,
      onTaskEvent: event => { taskEvents.push(event.eventId) },
    })
    await adapter.start({ onInbound: async () => undefined })

    const [text, card] = GATEWAY_V1_FIXTURES.renderIntents
    const textReceipt = await adapter.render(target, text!)
    expect(textReceipt).toEqual({ renderId: 'render-fixture-text', sequence: 1, deliveredAt: 999, messageId: 'm-1' })
    const cardReceipt = await adapter.render(target, card!)
    expect(cardReceipt.messageId).toBe('c-1')
    await adapter.render(target, {
      kind: 'file',
      renderId: 'file-1',
      sequence: 1,
      artifact: { id: 'a1', fileName: 'report.md', bytes: 10 },
      caption: 'report',
    })
    expect(renderPort.files).toEqual(['report.md'])
    await adapter.onTaskEvent(GATEWAY_V1_TASK_EVENT)
    expect(taskEvents).toEqual(['event-fixture-1'])
    expect(adapter.descriptor).toMatchObject({
      adapterId: 'feishu4dsh',
      displayName: 'Feishu/Lark',
      version: 'test',
    })
    expect(adapter.descriptor.capabilities.values).toHaveLength(13)
  })

  it('renders semantic forms and uses explicit file fallbacks without a file port', async () => {
    const renderPort = port()
    const adapter = new FeishuSheAdapter({ version: 'test', port: renderPort })
    await adapter.start({ onInbound: async () => undefined })
    await adapter.render(target, {
      kind: 'form', renderId: 'form-1', sequence: 1, interactionId: 'i1', title: 'Form',
      fields: [
        { type: 'text', id: 'notes', label: 'Notes' },
        { type: 'select', id: 'choice', label: 'Choice', options: [{ value: 'a', label: 'A' }] },
      ],
    })
    expect(renderPort.cards.at(-1)).toMatchObject({
      elements: [{ tag: 'form', name: 'she_form' }],
    })
    const filelessPort = port()
    delete (filelessPort as { sendFile?: unknown }).sendFile
    const filelessAdapter = new FeishuSheAdapter({ version: 'test', port: filelessPort })
    await filelessAdapter.start({ onInbound: async () => undefined })
    await filelessAdapter.render(target, {
      kind: 'file', renderId: 'file-1', sequence: 1,
      artifact: { id: 'a1', fileName: 'report.md', bytes: 10 },
    })
    expect(filelessPort.texts.at(-1)?.text).toContain('SHE file intent: report.md')
  })
})
