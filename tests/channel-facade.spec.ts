import { describe, expect, it } from 'vitest'
import {
  CHANNEL_CAPABILITIES_V1,
  approvalCard,
  card,
  createChannelCapabilitySet,
  feishuChannelCapabilitySet,
  hasChannelCapability,
  mayApprove,
} from '../src/channel/index.js'

describe('feishu channel facade', () => {
  it('exposes canonical capabilities and card primitives', () => {
    expect(CHANNEL_CAPABILITIES_V1).toHaveLength(13)
    expect(feishuChannelCapabilitySet().platform).toBe('feishu')
    expect(hasChannelCapability(feishuChannelCapabilitySet(), 'file.outbound')).toBe(true)
    expect(createChannelCapabilitySet({ platform: 'demo', capabilities: ['text.inbound'] }).capabilities)
      .toEqual(['text.inbound'])
    expect(card({ title: 'demo', template: 'blue' }, [])).toMatchObject({
      header: { title: { content: 'demo' } },
    })
    expect(approvalCard({
      title: 'approve',
      body: 'body',
      approveLabel: 'yes',
      denyLabel: 'no',
      payload: { kind: 'approval', token: 't', decision: 'approve', chatId: 'c' },
    })).toBeTypeOf('object')
  })

  it('exposes authorization primitives without dsh host coupling', () => {
    const authorization = {
      directSenders: new Set(['u1']),
      groups: new Set<string>(),
      approvers: new Set(['u1']),
    }
    expect(mayApprove(authorization, 'u1', false)).toBe(true)
    expect(mayApprove(authorization, 'u2', true)).toBe(false)
  })
})
