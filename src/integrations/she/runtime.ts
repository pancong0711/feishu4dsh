/**
 * Optional SHE runtime orchestration.
 *
 * Owns one client/adapter/event-pump lifecycle but no dsh session state and no
 * SHE business state. Start is explicitly opt-in; every failure is isolated so
 * ordinary Feishu chat continues to work when SHE is absent.
 * @module feishu4dsh/integrations/she/runtime
 */

import type {
  GatewayCommandInvocation,
  GatewayCommandResult,
  GatewayInboundEvent,
  GatewayInteractionResponse,
  GatewayInteractionResult,
  GatewayServerEvent,
  GatewaySnapshot,
  GatewayTaskEvent,
  RenderIntent,
  RenderTarget,
} from '@she/protocol'
import type { SheClient } from '@she/client'
import { FeishuSheAdapter, type FeishuRenderPort } from './adapter.js'
import {
  createSheClient,
  probeSheClient,
  type SheProbeClient,
  type SheProbeFailure,
  type SheProbeOptions,
  type SheProbeSuccess,
} from './client.js'
import {
  commandInvocationFromFeishu,
  interactionResponseFromFeishu,
  type FeishuSheCommandInput,
  type FeishuSheInteractionInput,
} from './gateway.js'
import { normalizeSheCommandText } from './commands.js'
import { renderTaskEvent } from './render.js'
import {
  MemorySheEventCursorStore,
  pumpSheEvents,
  type SheEventCursorStore,
} from './events.js'
import type { SheIntegrationConfig } from './config.js'

/** Full public SHE client surface consumed by the runtime. */
export interface SheRuntimeClient extends SheProbeClient {
  command(command: GatewayCommandInvocation, signal?: AbortSignal): Promise<GatewayCommandResult>
  interaction(
    interaction: GatewayInteractionResponse,
    signal?: AbortSignal,
  ): Promise<GatewayInteractionResult>
  events(options: { readonly cursor?: string; readonly signal?: AbortSignal }): AsyncIterable<GatewayServerEvent>
  snapshot(signal?: AbortSignal): Promise<GatewaySnapshot>
  close(): Promise<void>
}

export type SheRuntimeState = 'stopped' | 'disabled' | 'starting' | 'ready' | 'unavailable'

export interface SheRuntimeStartFailure {
  readonly ok: false
  readonly state: 'disabled' | 'unavailable'
  readonly failure: SheProbeFailure
}

export interface SheRuntimeStartSuccess {
  readonly ok: true
  readonly state: 'ready'
  readonly probe: SheProbeSuccess
}

export type SheRuntimeStartResult = SheRuntimeStartFailure | SheRuntimeStartSuccess

export interface SheIntegrationRuntimeOptions {
  readonly config: SheIntegrationConfig
  readonly adapter: FeishuSheAdapter
  readonly createClient?: (config: SheIntegrationConfig) => Promise<SheRuntimeClient>
  readonly cursorStore?: SheEventCursorStore
  readonly requiredCapabilities?: SheProbeOptions['requiredCapabilities']
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly onError?: (error: unknown) => void
  readonly onSnapshot?: (snapshot: GatewaySnapshot) => Promise<void> | void
}

function failure(
  code: SheProbeFailure['code'],
  message: string,
  retryable = false,
): SheProbeFailure {
  return { ok: false, code, message, retryable }
}

function targetOf(event: GatewayInboundEventLike): RenderTarget {
  return {
    conversation: event.conversation,
    ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
  }
}

/** Structural subset shared by all gateway inbound events. */
type GatewayInboundEventLike = GatewayInboundEvent

function errorIntent(requestId: string, error: unknown): {
  kind: 'text'
  renderId: string
  sequence: number
  format: 'plain'
  text: string
} {
  return {
    kind: 'text',
    renderId: `${requestId}:error`,
    sequence: 1,
    format: 'plain',
    text: `SHE is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/**
 * Lifecycle owner for one SHE connection.
 *
 * `start()` resolves ready once health/hello negotiation succeeds. The event
 * pump then runs in the background until `stop()` or an unrecoverable failure.
 */
export class SheIntegrationRuntime {
  private stateValue: SheRuntimeState = 'stopped'
  private client: SheRuntimeClient | undefined
  private probeValue: SheProbeSuccess | undefined
  private abortController: AbortController | undefined
  private pumpPromise: Promise<void> | undefined
  private snapshotValue: GatewaySnapshot | undefined
  private readonly cursorStore: SheEventCursorStore
  /** Card message id -> original target, used to preserve thread/conversation on clicks. */
  private readonly renderedTargets = new Map<string, RenderTarget>()
  private readonly taskTargets = new Map<string, RenderTarget>()
  private readonly topicTargets = new Map<string, RenderTarget>()

  constructor(private readonly options: SheIntegrationRuntimeOptions) {
    this.cursorStore = options.cursorStore ?? new MemorySheEventCursorStore()
  }

  get state(): SheRuntimeState {
    return this.stateValue
  }

  get probe(): SheProbeSuccess | undefined {
    return this.probeValue
  }

  get lastSnapshot(): GatewaySnapshot | undefined {
    return this.snapshotValue
  }

  /** Start only when explicitly enabled; never throws for expected failures. */
  async start(): Promise<SheRuntimeStartResult> {
    if (this.stateValue === 'ready') {
      if (this.probeValue === undefined) throw new Error('SHE runtime is ready without a probe')
      return { ok: true, state: 'ready', probe: this.probeValue }
    }
    if (!this.options.config.enabled) {
      this.stateValue = 'disabled'
      return { ok: false, state: 'disabled', failure: failure('disabled', 'SHE integration is disabled') }
    }
    if (this.stateValue === 'starting') throw new Error('SHE runtime is already starting')
    this.stateValue = 'starting'

    let client: SheRuntimeClient | undefined
    try {
      client = await (this.options.createClient?.(this.options.config) ?? createSheClient(this.options.config))
      const probe = await probeSheClient(client, {
        ...(this.options.requiredCapabilities === undefined
          ? {}
          : { requiredCapabilities: this.options.requiredCapabilities }),
      })
      if (!probe.ok) {
        await client.close().catch(() => undefined)
        this.stateValue = 'unavailable'
        this.options.onError?.(probe)
        return { ok: false, state: 'unavailable', failure: probe }
      }
      this.client = client
      this.probeValue = probe
      await this.options.adapter.start({ onInbound: event => this.dispatchInbound(event) })
      const controller = new AbortController()
      this.abortController = controller
      this.pumpPromise = pumpSheEvents({
        client,
        signal: controller.signal,
        cursorStore: this.cursorStore,
        sink: {
          render: async (target, intent) => { await this.renderAndRemember(target, intent) },
          task: async event => {
            const target = this.taskTargets.get(event.taskId) ?? this.topicTargets.get(event.topicId)
            const intent = renderTaskEvent(event)
            if (target !== undefined && intent !== undefined) await this.renderAndRemember(target, intent)
            await this.options.adapter.onTaskEvent?.(event)
          },
          snapshot: async snapshot => {
            this.snapshotValue = snapshot
            await this.options.onSnapshot?.(snapshot)
          },
          error: async error => { this.options.onError?.(error) },
        },
        ...(this.options.reconnectBaseMs === undefined ? {} : { reconnectBaseMs: this.options.reconnectBaseMs }),
        ...(this.options.reconnectMaxMs === undefined ? {} : { reconnectMaxMs: this.options.reconnectMaxMs }),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        onError: error => this.options.onError?.(error),
      }).catch(error => { this.options.onError?.(error) })
      this.stateValue = 'ready'
      return { ok: true, state: 'ready', probe }
    } catch (error) {
      await client?.close().catch(() => undefined)
      this.client = undefined
      this.stateValue = 'unavailable'
      const result = failure('internal', error instanceof Error ? error.message : String(error))
      this.options.onError?.(result)
      return { ok: false, state: 'unavailable', failure: result }
    }
  }

  /** Forward a Feishu `/she ...` message. Returns false for non-SHE text. */
  async handleFeishuText(input: Omit<FeishuSheCommandInput, 'rawCommand'> & { readonly text: string }): Promise<boolean> {
    const rawCommand = normalizeSheCommandText(input.text)
    if (rawCommand === undefined) return false
    await this.dispatchInbound(commandInvocationFromFeishu({ ...input, rawCommand }))
    return true
  }

  /** Forward a Feishu card/form action to SHE. */
  async handleFeishuInteraction(input: FeishuSheInteractionInput): Promise<void> {
    const renderedTarget = input.messageId === undefined
      ? undefined
      : this.renderedTargets.get(input.messageId)
    await this.dispatchInbound(interactionResponseFromFeishu(input, renderedTarget))
  }

  /** Dispatch one already-mapped gateway inbound event. */
  async dispatchInbound(event: GatewayInboundEvent): Promise<void> {
    const client = this.client
    if (client === undefined) throw new Error('SHE runtime is not ready')
    const target = targetOf(event)
    try {
      if (event.kind === 'command') {
        const result = await client.command(event)
        await this.renderResult(target, result)
        return
      }
      if (event.kind === 'interaction') {
        const result = await client.interaction(event)
        await this.renderResult(target, result)
        return
      }
      await this.options.adapter.render(target, {
        kind: 'text',
        renderId: `${event.requestId}:unsupported`,
        sequence: 1,
        format: 'plain',
        text: 'This Feishu message type is not supported by SHE gateway.v1.',
      })
    } catch (error) {
      await this.renderAndRemember(target, errorIntent(event.requestId, error)).catch(() => undefined)
      this.options.onError?.(error)
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort()
    await this.pumpPromise?.catch(() => undefined)
    this.pumpPromise = undefined
    this.abortController = undefined
    await this.options.adapter.stop().catch(() => undefined)
    const client = this.client
    this.client = undefined
    await client?.close().catch(() => undefined)
    this.stateValue = 'stopped'
  }

  private async renderResult(
    target: RenderTarget,
    result: GatewayCommandResult | GatewayInteractionResult,
  ): Promise<void> {
    if ('taskId' in result && result.taskId !== undefined) {
      this.rememberTaskTarget(this.taskTargets, result.taskId, target)
    }
    if ('topicId' in result && result.topicId !== undefined) {
      this.rememberTaskTarget(this.topicTargets, result.topicId, target)
    }
    for (const intent of result.commandResult?.renderIntents ?? []) {
      await this.renderAndRemember(target, intent)
    }
  }

  private rememberTaskTarget(map: Map<string, RenderTarget>, key: string, target: RenderTarget): void {
    map.set(key, target)
    while (map.size > 512) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  private async renderAndRemember(target: RenderTarget, intent: RenderIntent): Promise<void> {
    const receipt = await this.options.adapter.render(target, intent)
    if (receipt.messageId === undefined) return
    this.renderedTargets.set(receipt.messageId, target)
    while (this.renderedTargets.size > 512) {
      const oldest = this.renderedTargets.keys().next()
      if (oldest.done === true) break
      this.renderedTargets.delete(oldest.value)
    }
  }
}

export type { FeishuRenderPort }
export type { SheClient, GatewayTaskEvent, GatewayInboundEvent }
