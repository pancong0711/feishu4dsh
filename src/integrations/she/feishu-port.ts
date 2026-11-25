/**
 * Adapt the existing Feishu ChannelPort to the SHE render port.
 *
 * This module owns only target translation and send calls. It deliberately
 * does not fetch SHE artifacts: the public client does not expose an artifact
 * content endpoint yet, so file delivery stays explicitly unavailable until
 * that contract exists.
 * @module feishu4dsh/integrations/she/feishu-port
 */

import type { RenderTarget } from '@she/protocol'
import type { ChannelPort } from '../../adapter.js'
import type { FeishuRenderPort } from './adapter.js'

type SendOptions = Parameters<ChannelPort['send']>[2]

function feishuMeta(target: RenderTarget): { chatId?: string } {
  const extensions = target.conversation.extensions
  const feishu = extensions?.feishu
  if (typeof feishu !== 'object' || feishu === null || Array.isArray(feishu)) return {}
  const chatId = (feishu as { chatId?: unknown }).chatId
  return typeof chatId === 'string' && chatId !== '' ? { chatId } : {}
}

function chatIdOf(target: RenderTarget): string {
  return feishuMeta(target).chatId ?? target.conversation.parentId ?? target.conversation.id
}

function optionsOf(target: RenderTarget): SendOptions {
  const messageId = target.replyTo?.messageId
  return messageId === undefined ? undefined : { replyTo: messageId, replyInThread: true }
}

/** Build the channel-side render port used by FeishuSheAdapter. */
export function createFeishuSheRenderPort(port: Pick<ChannelPort, 'send'>): FeishuRenderPort {
  return {
    async sendText(target, text, markdown) {
      const sent = await port.send(
        chatIdOf(target),
        markdown ? { markdown: text } : { text },
        optionsOf(target),
      )
      return sent.messageId === undefined ? undefined : { messageId: sent.messageId }
    },
    async sendCard(target, cardObject) {
      const sent = await port.send(
        chatIdOf(target),
        { card: cardObject },
        optionsOf(target),
      )
      return sent.messageId === undefined ? undefined : { messageId: sent.messageId }
    },
  }
}
