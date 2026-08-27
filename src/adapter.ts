/**
 * The Feishu side of the seam: one `LarkChannel` from the official SDK,
 * shaped into the narrow port surface the bridge consumes, plus the
 * optional webhook server for deployments that cannot use the long
 * connection.
 *
 * Transport safety the SDK pipeline owns: event dedup, chat-serial queue,
 * optional text/media batching, policy allowlists, mention gating, send
 * retry/backoff, streaming-card throttling. The bridge above focuses on the
 * agent half.
 * @module feishu4dsh/adapter
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import {
  Domain,
  EventDispatcher,
  adaptDefault,
  createLarkChannel,
  type BotIdentity,
  type CardActionEvent,
  type EventMap,
  type EventName,
  type LarkChannel,
  type LarkChannelOptions,
  type NormalizedMessage,
  type PolicyConfig,
  type ReactionEvent,
  type RejectEvent,
  type ResourceType,
  type SendInput,
  type SendOptions,
  type SendResult,
  type StreamInput,
} from '@larksuiteoapi/node-sdk'
import type { ResolvedConfig } from './config.js'
import type { Authorization } from './acl.js'

/** The narrow port surface the bridge drives; fakes implement it in tests. */
export interface ChannelPort {
  /** Handshake the transport; resolves once the channel can receive. */
  connect(): Promise<void>
  /** Close the transport and stop any webhook server. */
  disconnect(): Promise<void>
  /** The bot's own identity once connected. */
  readonly botIdentity: BotIdentity | undefined
  on<K extends EventName>(name: K, handler: EventMap[K]): () => void
  send(to: string, input: SendInput, options?: SendOptions): Promise<SendResult>
  stream(to: string, input: StreamInput, options?: SendOptions): Promise<SendResult>
  updateCard(messageId: string, cardObject: object): Promise<void>
  editMessage(messageId: string, text: string): Promise<void>
  /**
   * Fetch a message's resource bytes. Prefer the message-scoped API
   * (`messages/{message_id}/resources/{file_key}`): the legacy bot-scoped
   * endpoints (`im.v1.image.get` / `im.v1.file.get`) only serve resources the
   * bot itself uploaded and 400 on resources sent by users. Where the
   * message-scoped call fails (bot-self uploads, card payloads, …) the
   * implementation falls back to the legacy path.
   * @param fileKey - the resource file key.
   * @param type - SDK ResourceType the fetch must be scoped to ('image' | 'file').
   * @param messageId - the message that carried the resource (bridge memory state).
   */
  downloadResource(fileKey: string, type: ResourceType, messageId: string): Promise<Buffer>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>
}

/** Build the SDK channel options from resolved config and authorization. */
export function channelOptions(
  config: ResolvedConfig,
  authorization: Authorization,
): LarkChannelOptions {
  // Authorization narrows; it does not gate. Who may reach the bot at all is
  // the app's visibility scope; this duplicates the deployment's wish on the
  // transport too, defense in depth — an allowlist the transport enforces
  // never depends on the bridge's own handler being reached.
  const policy: PolicyConfig = { requireMention: config.requireMention }
  if (authorization.directSenders.size > 0) {
    policy.dmMode = 'allowlist'
    policy.dmAllowlist = [...authorization.directSenders]
  }
  if (authorization.groups.size > 0) policy.groupAllowlist = [...authorization.groups]

  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    transport: config.connectionMode,
    policy,
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu4dsh',
    // Messages arriving within one chat are processed strictly in order; the
    // agent's inbox already drains queued messages into a single turn.
    // The batching window MUST stay closed: with the default 600 ms text
    // debounce the SDK merges consecutive messages into one representative
    // that keeps the LAST message's identity (`mergeBatch`), so a topic
    // message bundled with an adjacent non-topic message loses its
    // thread_id — its answer is then scoped/replied to the chat root
    // instead of the topic. `chatQueue.enabled` alone does NOT close that
    // window; only `batch.text.delayMs = 0` does (immediate serial flush).
    safety: {
      chatQueue: { enabled: true },
      batch: { text: { delayMs: 0 } },
    },
  }
  if (config.connectionMode === 'webhook') {
    options.webhook = {
      ...config.verificationToken === '' ? {} : { verificationToken: config.verificationToken },
      ...config.encryptKey === '' ? {} : { encryptKey: config.encryptKey },
    }
  }
  return options
}

/** The webhook half of a webhook-mode deployment, owned by the adapter. */
export interface WebhookEndpoint {
  listen(): Promise<number>
  close(): Promise<void>
}

/** Escape hatch: the channel's private event dispatcher. */
interface DispatcherOwner {
  dispatcher?: EventDispatcher
}

/**
 * Create the webhook endpoint for a webhook-mode channel. The SDK keeps the
 * dispatcher on the channel and documents plugging it into an HTTP handler;
 * this builds that handler on `node:http` with URL-configuration challenge
 * auto-answered.
 * @param channel - the connected (or connecting) channel.
 * @param config - resolved config; supplies the listen port.
 * @param report - operator console line.
 * @returns the endpoint, or undefined when the dispatcher is unreachable.
 */
export function createWebhookEndpoint(
  channel: LarkChannel,
  config: ResolvedConfig,
  report: (line: string) => void,
): WebhookEndpoint | undefined {
  const dispatcher = (channel as unknown as DispatcherOwner).dispatcher
  if (dispatcher === undefined) {
    report('feishu4dsh: webhook mode unavailable (no dispatcher on channel)')
    return undefined
  }
  const handler = adaptDefault('/webhook/event', dispatcher, { autoChallenge: true })
  let server: Server | undefined
  return {
    async listen(): Promise<number> {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void handler(req, res).catch((error: unknown) => {
          report(`feishu4dsh: webhook handler error: ${error instanceof Error ? error.message : String(error)}`)
          if (!res.writableEnded) {
            res.statusCode = 500
            res.end()
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        const instance = server
        if (instance === undefined) { reject(new Error('server vanished')); return }
        instance.once('error', reject)
        instance.listen(config.webhookPort, () => { instance.removeListener('error', reject); resolve() })
      })
      report(`feishu4dsh: webhook listening on :${config.webhookPort}/webhook/event`)
      return config.webhookPort
    },
    async close(): Promise<void> {
      const instance = server
      if (instance === undefined) return
      server = undefined
      await new Promise<void>(resolve => { instance.close(() => resolve()) })
    },
  }
}

/**
 * Drain a Node `Readable` into a single `Buffer` (for-await collects chunks,
 * `Buffer.concat` joins them). The SDK code-gen download endpoints expose the
 * body as a readable stream wrapper (`{ getReadableStream }`), so both the
 * message-scoped and the legacy download paths funnel through here.
 */
async function bufferFromStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** One production Feishu port behind the bridge. */
export interface FeishuPort extends ChannelPort {
  readonly channel: LarkChannel
  readonly webhook: WebhookEndpoint | undefined
}

/**
 * Build the production port from resolved configuration.
 * @param config - credentials present, resolved plugin configuration.
 * @param authorization - who this deployment answers.
 * @param report - operator console line.
 * @returns the port wiring the bridge consumes.
 */
export function createFeishuPort(
  config: ResolvedConfig,
  authorization: Authorization,
  report: (line: string) => void,
): FeishuPort {
  const channel = createLarkChannel(channelOptions(config, authorization))
  const webhook = config.connectionMode === 'webhook'
    ? createWebhookEndpoint(channel, config, report)
    : undefined
  return {
    channel,
    webhook,
    async connect(): Promise<void> {
      await channel.connect()
      if (webhook !== undefined) await webhook.listen()
    },
    async disconnect(): Promise<void> {
      await webhook?.close()
      await channel.disconnect()
    },
    get botIdentity(): BotIdentity | undefined {
      return channel.botIdentity
    },
    on<K extends EventName>(name: K, handler: EventMap[K]): () => void {
      return channel.on(name, handler)
    },
    send: (to, input, options) => channel.send(to, input, options),
    stream: (to, input, options) => channel.stream(to, input, options),
    updateCard: (messageId, cardObject) => channel.updateCard(messageId, cardObject),
    editMessage: (messageId, text) => channel.editMessage(messageId, text),
    downloadResource: async (fileKey, type, messageId) => {
      try {
        // R24: message-scoped fetch — the only path that serves resources the
        // USER uploaded; the legacy bot-scoped endpoints 400 on those
        // (`234008 not resource sender`). `params.type` stays within the SDK
        // ResourceType enum ('image' | 'file'); never a free-form string.
        const r = await channel.rawClient.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type },
        })
        return await bufferFromStream(r.getReadableStream())
      } catch (error) {
        // Fallback: bot-self-uploaded resources / card payloads that the
        // message-scoped endpoint does not serve. Keep the operator console
        // line so a regression back to the old 400s stays visible.
        const detail = error instanceof Error ? error.message : String(error)
        report(`feishu4dsh: messageResource.get failed (${fileKey}, ${type}): ${detail}; falling back to channel.downloadResource`)
        return await channel.downloadResource(fileKey, type)
      }
    },
    addReaction: (messageId, emojiType) => channel.addReaction(messageId, emojiType),
    removeReactionByEmoji: (messageId, emojiType) => channel.removeReactionByEmoji(messageId, emojiType),
  }
}

/* Re-export the SDK event shapes the bridge and tests name. */
export type {
  CardActionEvent,
  EventMap,
  EventName,
  NormalizedMessage,
  ReactionEvent,
  RejectEvent,
  ResourceType,
  SendInput,
  SendOptions,
  SendResult,
  StreamInput,
}
