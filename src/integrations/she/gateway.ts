/**
 * Feishu-to-gateway.v1 mapping.
 *
 * Only channel metadata (chat/message/thread ids) travels in extensions.
 * Task/queue/session state remains owned by SHE.
 * @module feishu4dsh/integrations/she/gateway
 */

import { randomUUID } from 'node:crypto'
import type {
  ActorRef,
  ConversationRef,
  GatewayCommandInvocation,
  GatewayInteractionResponse,
  InteractionValue,
  RenderTarget,
  ReplyContext,
} from '@she/protocol'

export type FeishuChatType = 'p2p' | 'group'

/** Trusted context the bridge already resolved for one inbound message. */
export interface FeishuSheContext {
  readonly senderId: string
  readonly senderName?: string
  readonly chatId: string
  readonly chatType: FeishuChatType
  readonly messageId?: string
  readonly threadId?: string
  readonly workspaceKey?: string
}

export interface FeishuSheCommandInput extends FeishuSheContext {
  readonly rawCommand: string
  /** Injection seam for tests; production defaults to randomUUID(). */
  readonly requestId?: string
  readonly idempotencyKey?: string
}

export interface FeishuSheInteractionInput extends FeishuSheContext {
  readonly interactionId: string
  readonly values: Readonly<Record<string, InteractionValue>>
  readonly requestId?: string
}

function feishuExtensions(input: FeishuSheContext): Readonly<Record<string, unknown>> {
  return {
    feishu: {
      chatId: input.chatId,
      chatType: input.chatType,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    },
  }
}

/** Map one Feishu sender to an SHE actor ref. */
export function actorFromFeishu(input: FeishuSheContext): ActorRef {
  return {
    id: input.senderId,
    kind: 'user',
    ...(input.senderName === undefined ? {} : { displayName: input.senderName }),
    extensions: feishuExtensions(input),
  }
}

/** Map one Feishu chat/thread to an SHE conversation ref. */
export function conversationFromFeishu(input: FeishuSheContext): ConversationRef {
  if (input.threadId !== undefined && input.threadId !== '') {
    return {
      id: `${input.chatId}:${input.threadId}`,
      kind: 'thread',
      parentId: input.chatId,
      threadId: input.threadId,
      extensions: feishuExtensions(input),
    }
  }
  return {
    id: input.chatId,
    kind: input.chatType === 'p2p' ? 'dm' : 'group',
    extensions: feishuExtensions(input),
  }
}

/** Preserve Feishu's reply/thread anchors for outbound renders. */
export function replyContextFromFeishu(input: FeishuSheContext): ReplyContext | undefined {
  if (input.messageId === undefined && input.threadId === undefined) return undefined
  return {
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  }
}

/** Build one idempotent gateway command invocation from a Feishu message. */
export function commandInvocationFromFeishu(input: FeishuSheCommandInput): GatewayCommandInvocation {
  return {
    kind: 'command',
    requestId: input.requestId ?? randomUUID(),
    ...(input.idempotencyKey === undefined
      ? input.messageId === undefined ? {} : { idempotencyKey: `feishu:message:${input.messageId}` }
      : { idempotencyKey: input.idempotencyKey }),
    actor: actorFromFeishu(input),
    conversation: conversationFromFeishu(input),
    ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
    ...(replyContextFromFeishu(input) === undefined ? {} : { replyTo: replyContextFromFeishu(input) }),
    rawCommand: input.rawCommand,
    extensions: feishuExtensions(input),
  }
}

/** Build one gateway interaction response from a Feishu card action.
 *
 * `renderedTarget` is the target the card was originally rendered for. It is
 * preferred over the callback's reduced chat metadata so a thread-scoped card
 * still answers in the original conversation.
 */
export function interactionResponseFromFeishu(
  input: FeishuSheInteractionInput,
  renderedTarget?: RenderTarget,
): GatewayInteractionResponse {
  return {
    kind: 'interaction',
    requestId: input.requestId ?? randomUUID(),
    actor: actorFromFeishu(input),
    conversation: renderedTarget?.conversation ?? conversationFromFeishu(input),
    ...(renderedTarget?.replyTo === undefined
      ? replyContextFromFeishu(input) === undefined ? {} : { replyTo: replyContextFromFeishu(input) }
      : { replyTo: renderedTarget.replyTo }),
    interactionId: input.interactionId,
    values: input.values,
    extensions: feishuExtensions(input),
  }
}
