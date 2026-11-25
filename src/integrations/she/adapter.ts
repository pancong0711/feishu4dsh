/**
 * Feishu implementation of the gateway adapter boundary.
 *
 * This is intentionally structural and small enough to stay independent of the
 * optional `@she/gateway-sdk` package. It translates RenderIntent values into
 * channel sends and forwards inbound events to the configured sink.
 * @module feishu4dsh/integrations/she/adapter
 */

import {
  CHANNEL_CAPABILITIES_V1,
  makeCapabilitySet,
  type ArtifactRef,
  type CapabilitySet,
  type ExtensionBag,
  type GatewayInboundEvent,
  type GatewayTaskEvent,
  type RenderIntent,
  type RenderTarget,
} from '@she/protocol'
import { renderIntent } from './render.js'

/** Inbound command/interaction sink supplied by the integration runtime. */
export interface SheGatewayInboundSink {
  onInbound(event: GatewayInboundEvent): Promise<void>
}

/** Delivery receipt for one rendered intent. */
export interface SheRenderReceipt {
  readonly renderId: string
  readonly sequence: number
  readonly deliveredAt: number
  readonly messageId?: string
}

/** Structural equivalent of @she/gateway-sdk's GatewayAdapter. */
export interface SheGatewayAdapter {
  readonly descriptor: {
    readonly adapterId: string
    readonly displayName: string
    readonly version: string
    readonly capabilities: CapabilitySet
    readonly extensions?: ExtensionBag
  }
  start(sink: SheGatewayInboundSink): Promise<void>
  render(target: RenderTarget, intent: RenderIntent): Promise<SheRenderReceipt>
  onTaskEvent?(event: GatewayTaskEvent): Promise<void>
  stop(): Promise<void>
}

/** Channel operations the adapter needs; the bridge injects the real Feishu port. */
export interface FeishuRenderPort {
  sendText(
    target: RenderTarget,
    text: string,
    markdown: boolean,
  ): Promise<{ readonly messageId?: string } | void>
  sendCard(
    target: RenderTarget,
    cardObject: object,
  ): Promise<{ readonly messageId?: string } | void>
  sendFile?(
    target: RenderTarget,
    artifact: ArtifactRef,
    caption: string | undefined,
    approval: 'channel-policy' | 'always' | 'never',
  ): Promise<{ readonly messageId?: string } | void>
}

export interface FeishuSheAdapterOptions {
  readonly version: string
  readonly port: FeishuRenderPort
  readonly onTaskEvent?: (event: GatewayTaskEvent) => Promise<void> | void
  readonly now?: () => number
}

/** Feishu-side adapter implementation used by the optional SHE runtime. */
export class FeishuSheAdapter implements SheGatewayAdapter {
  readonly descriptor: SheGatewayAdapter['descriptor']
  private sink: SheGatewayInboundSink | undefined
  private readonly now: () => number

  constructor(private readonly options: FeishuSheAdapterOptions) {
    this.now = options.now ?? Date.now
    this.descriptor = {
      adapterId: 'feishu4dsh',
      displayName: 'Feishu/Lark',
      version: options.version,
      capabilities: makeCapabilitySet(CHANNEL_CAPABILITIES_V1),
      extensions: { feishu: { transport: 'websocket-or-webhook' } },
    }
  }

  async start(sink: SheGatewayInboundSink): Promise<void> {
    this.sink = sink
  }

  /** Called by the Feishu bridge when a command/interaction arrives. */
  async dispatchInbound(event: GatewayInboundEvent): Promise<void> {
    if (this.sink === undefined) throw new Error('SHE gateway adapter is not started')
    await this.sink.onInbound(event)
  }

  async render(target: RenderTarget, intent: RenderIntent): Promise<SheRenderReceipt> {
    const output = renderIntent(intent)
    let delivered: { readonly messageId?: string } | void
    switch (output.kind) {
      case 'text':
        delivered = await this.options.port.sendText(target, output.text, output.markdown)
        break
      case 'card':
        delivered = await this.options.port.sendCard(target, output.card)
        break
      case 'file':
        if (this.options.port.sendFile !== undefined) {
          delivered = await this.options.port.sendFile(
            target,
            output.artifact,
            output.caption,
            output.approval,
          )
        } else {
          delivered = await this.options.port.sendText(
            target,
            `SHE file intent: ${output.artifact.fileName}`,
            false,
          )
        }
        break
      case 'unsupported':
        delivered = await this.options.port.sendText(target, `SHE: ${output.reason}`, false)
        break
    }
    return {
      renderId: intent.renderId,
      sequence: intent.sequence,
      deliveredAt: this.now(),
      ...(delivered?.messageId === undefined ? {} : { messageId: delivered.messageId }),
    }
  }

  async onTaskEvent(event: GatewayTaskEvent): Promise<void> {
    await this.options.onTaskEvent?.(event)
  }

  async stop(): Promise<void> {
    this.sink = undefined
  }
}
