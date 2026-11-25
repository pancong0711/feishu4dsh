import { describe, expect, it } from 'vitest'
import { GATEWAY_V1_COMMAND_RESULT } from '@she/protocol'
import {
  commandInvocationFromFeishu,
  conversationFromFeishu,
  forwardSheCommand,
  interactionResponseFromFeishu,
  isSheCommand,
  normalizeSheCommandText,
  type SheCommandClient,
} from '../src/integrations/she/index.js'

const base = {
  senderId: 'ou_user',
  senderName: 'Alice',
  chatId: 'oc_chat',
  chatType: 'group' as const,
  messageId: 'om_message',
  threadId: 'omt_thread',
  workspaceKey: 'workspace-1',
}

describe('Feishu -> SHE gateway mapping', () => {
  it('maps channel metadata without carrying task state', () => {
    const command = commandInvocationFromFeishu({
      ...base,
      rawCommand: '/she status 1',
      requestId: 'req-fixed',
    })
    expect(command).toMatchObject({
      kind: 'command',
      requestId: 'req-fixed',
      idempotencyKey: 'feishu:message:om_message',
      workspaceKey: 'workspace-1',
      rawCommand: '/she status 1',
      actor: { id: 'ou_user', kind: 'user', displayName: 'Alice' },
      conversation: { id: 'oc_chat:omt_thread', kind: 'thread', parentId: 'oc_chat', threadId: 'omt_thread' },
      replyTo: { messageId: 'om_message', threadId: 'omt_thread' },
    })
    expect(JSON.stringify(command.extensions)).not.toContain('task')
  })

  it('maps p2p chats and interaction responses', () => {
    expect(conversationFromFeishu({ ...base, chatType: 'p2p', threadId: undefined })).toMatchObject({
      id: 'oc_chat',
      kind: 'dm',
    })
    const interaction = interactionResponseFromFeishu({
      ...base,
      requestId: 'req-interaction',
      interactionId: 'int-1',
      values: { choice: 'approve' },
    })
    expect(interaction).toMatchObject({
      kind: 'interaction',
      requestId: 'req-interaction',
      interactionId: 'int-1',
      values: { choice: 'approve' },
    })
  })

  it('forwards only /she commands and leaves subcommands opaque', async () => {
    expect(normalizeSheCommandText('  /she sandbox list  ')).toBe('/she sandbox list')
    expect(normalizeSheCommandText('/shell')).toBeUndefined()
    expect(isSheCommand('/she')).toBe(true)

    const calls: string[] = []
    const client: SheCommandClient = {
      command: async command => {
        calls.push(command.rawCommand)
        return GATEWAY_V1_COMMAND_RESULT
      },
    }
    await expect(forwardSheCommand(client, { ...base, text: 'hello' })).resolves.toBeUndefined()
    expect(calls).toEqual([])
    await expect(forwardSheCommand(client, { ...base, text: '/she status' })).resolves.toEqual(GATEWAY_V1_COMMAND_RESULT)
    expect(calls).toEqual(['/she status'])
  })
})
