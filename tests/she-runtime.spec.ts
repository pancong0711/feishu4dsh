import { describe, expect, it } from 'vitest'
import {
  GATEWAY_V1_COMMAND_RESULT,
  GATEWAY_V1_FIXTURES,
  GATEWAY_PROTOCOL_VERSION,
  makeCapabilitySet,
  CHANNEL_CAPABILITIES_V1,
  type GatewayHealth,
  type GatewayServerEvent,
  type GatewaySnapshot,
  type GatewayWelcome,
} from '@she/protocol'
import {
  FeishuSheAdapter,
  SheIntegrationRuntime,
  type FeishuRenderPort,
  type SheRuntimeClient,
} from '../src/integrations/she/index.js'

function health(): GatewayHealth {
  return {
    status: 'ok', service: 'she-control-plane', version: '0.1.0',
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    capabilities: makeCapabilitySet(CHANNEL_CAPABILITIES_V1),
    checkedAt: 1,
  }
}

function welcome(): GatewayWelcome {
  return {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    capabilities: makeCapabilitySet(CHANNEL_CAPABILITIES_V1),
  }
}

function renderPort(): FeishuRenderPort & { texts: string[]; cards: object[] } {
  const state = { texts: [] as string[], cards: [] as object[], nextCard: 0 }
  return {
    get texts() { return state.texts },
    get cards() { return state.cards },
    sendText: async (_target, text) => { state.texts.push(text) },
    sendCard: async (_target, cardObject) => {
      state.cards.push(cardObject)
      state.nextCard += 1
      return { messageId: `card-${String(state.nextCard)}` }
    },
  }
}

function fakeClient(overrides: Partial<SheRuntimeClient> = {}): SheRuntimeClient {
  return {
    health: async () => health(),
    hello: async () => welcome(),
    command: async () => GATEWAY_V1_COMMAND_RESULT,
    interaction: async input => ({
      accepted: true,
      interactionId: input.interactionId,
      commandResult: { renderIntents: [GATEWAY_V1_FIXTURES.renderIntents[0]!] },
    }),
    async *events(options): AsyncIterable<GatewayServerEvent> {
      await new Promise<void>(resolve => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    snapshot: async (): Promise<GatewaySnapshot> => GATEWAY_V1_FIXTURES.snapshot,
    close: async () => undefined,
    ...overrides,
  }
}

const baseConfig = {
  enabled: true,
  socketPath: '/tmp/she.sock',
  tokenFile: '/tmp/she.token',
  timeoutMs: 1_000,
}

describe('SHE integration runtime', () => {
  it('stays disabled by default and never creates a client', async () => {
    let created = 0
    const runtime = new SheIntegrationRuntime({
      config: { ...baseConfig, enabled: false },
      adapter: new FeishuSheAdapter({ version: 'test', port: renderPort() }),
      createClient: async () => { created += 1; return fakeClient() },
    })
    await expect(runtime.start()).resolves.toMatchObject({ ok: false, state: 'disabled' })
    expect(created).toBe(0)
  })

  it('starts, forwards commands/interactions and stops cleanly', async () => {
    const commands: string[] = []
    const interactions: string[] = []
    const interactionConversations: string[] = []
    let closed = false
    const client = fakeClient({
      command: async command => { commands.push(command.rawCommand); return GATEWAY_V1_COMMAND_RESULT },
      interaction: async input => {
        interactions.push(input.interactionId)
        interactionConversations.push(input.conversation.id)
        return { accepted: true, interactionId: input.interactionId, commandResult: { renderIntents: [GATEWAY_V1_FIXTURES.renderIntents[0]!] } }
      },
      close: async () => { closed = true },
    })
    const output = renderPort()
    const runtime = new SheIntegrationRuntime({
      config: baseConfig,
      adapter: new FeishuSheAdapter({ version: 'test', port: output }),
      createClient: async () => client,
    })
    await expect(runtime.start()).resolves.toMatchObject({ ok: true, state: 'ready' })
    expect(runtime.state).toBe('ready')

    const context = {
      senderId: 'u1', chatId: 'c1', chatType: 'p2p' as const, messageId: 'm1', threadId: 't1',
    }
    await expect(runtime.handleFeishuText({ ...context, text: 'hello' })).resolves.toBe(false)
    await expect(runtime.handleFeishuText({ ...context, text: '/she status' })).resolves.toBe(true)
    expect(commands).toEqual(['/she status'])
    expect(output.texts.length).toBeGreaterThan(0)
    expect(output.cards.length).toBeGreaterThan(0)

    await runtime.handleFeishuInteraction({
      ...context,
      messageId: 'card-1',
      interactionId: 'int-1',
      values: { ok: true },
    })
    expect(interactions).toEqual(['int-1'])
    expect(interactionConversations).toEqual(['c1:t1'])

    await runtime.stop()
    expect(runtime.state).toBe('stopped')
    expect(closed).toBe(true)
  })

  it('isolates probe failures without throwing', async () => {
    let closed = false
    const runtime = new SheIntegrationRuntime({
      config: baseConfig,
      adapter: new FeishuSheAdapter({ version: 'test', port: renderPort() }),
      createClient: async () => fakeClient({
        health: async () => { throw new Error('control plane down') },
        close: async () => { closed = true },
      }),
    })
    await expect(runtime.start()).resolves.toMatchObject({ ok: false, state: 'unavailable' })
    expect(closed).toBe(true)
    expect(runtime.state).toBe('unavailable')
  })
})
