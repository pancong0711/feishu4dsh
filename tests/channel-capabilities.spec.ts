import { describe, expect, it } from 'vitest'
import {
  CHANNEL_CAPABILITIES_V1,
  CHANNEL_CAPABILITY_VERSION,
  createChannelCapabilitySet,
  feishuChannelCapabilitySet,
  hasChannelCapability,
  minimalChannelCapabilitySet,
  type ChannelCapability,
} from '../src/channel/capabilities.js'

describe('channel capability contract', () => {
  it('creates a versioned, deduplicated set in stable order', () => {
    const set = createChannelCapabilitySet({
      platform: 'demo',
      capabilities: ['file.outbound', 'text.outbound', 'file.outbound', 'card.outbound'],
      extensions: ['demo.card-v2', 'demo.card-v2', ' '],
    })
    expect(set).toEqual({
      protocolVersion: CHANNEL_CAPABILITY_VERSION,
      platform: 'demo',
      capabilities: ['text.outbound', 'card.outbound', 'file.outbound'],
      extensions: ['demo.card-v2'],
    })
    expect(hasChannelCapability(set, 'file.outbound')).toBe(true)
    expect(hasChannelCapability(set, 'approval.interactive')).toBe(false)
  })

  it('declares the current Feishu semantic capabilities without platform internals', () => {
    const set = feishuChannelCapabilitySet()
    expect(set.platform).toBe('feishu')
    expect(set.protocolVersion).toBe(1)
    expect(set.capabilities).toContain('text.inbound')
    expect(set.capabilities).toContain('file.outbound')
    expect(set.capabilities).toContain('thread.reply')
    expect(set.capabilities).toContain('approval.interactive')
    expect(set.extensions).toContain('feishu.thread-anchor')
    expect(set.extensions).not.toContain('card-json')
  })

  it('offers a text-only fallback when no capability negotiation is possible', () => {
    const set = minimalChannelCapabilitySet('unknown')
    expect(set.capabilities).toEqual(['text.inbound', 'text.outbound'])
    expect(hasChannelCapability(set, 'markdown.outbound')).toBe(false)
  })

  it('publishes the exact canonical v1 capability names for external gateway alignment', () => {
    const known = new Set<ChannelCapability>(feishuChannelCapabilitySet().capabilities)
    expect(CHANNEL_CAPABILITIES_V1).toEqual([
      'text.inbound',
      'text.outbound',
      'markdown.outbound',
      'stream.outbound',
      'card.outbound',
      'form.outbound',
      'selector.outbound',
      'approval.interactive',
      'file.inbound',
      'file.outbound',
      'thread.reply',
      'mention',
      'reaction',
    ])
    expect([...known].every(value => CHANNEL_CAPABILITIES_V1.includes(value))).toBe(true)
  })
})
