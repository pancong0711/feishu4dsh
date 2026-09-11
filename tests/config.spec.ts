import { describe, expect, it } from 'vitest'
import { Config, resolveConfig, hasCredentials } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies schema defaults for an empty config', () => {
    const resolved = resolveConfig(new Config())
    expect(resolved.domain).toBe('feishu')
    expect(resolved.connectionMode).toBe('websocket')
    expect(resolved.webhookPort).toBe(3081)
    expect(resolved.sessionScope).toBe('chat')
    expect(resolved.requireMention).toBe(true)
    expect(resolved.output).toBe('stream')
    expect(resolved.showProcess).toBe(true)
    expect(resolved.receiveFiles).toBe(true)
    expect(resolved.maxReceiveFileBytes).toBe(20 * 1024 * 1024)
    expect(resolved.maxMessageReceiveBytes).toBe(1024 * 1024 * 1024)
    expect(resolved.saveImagesToInbox).toBe(true)
    expect(resolved.attachImages).toBe(false)
    expect(resolved.sendFiles).toBe(true)
    expect(resolved.approvalTimeoutMs).toBe(300_000)
    expect(resolved.locale).toBe('auto')
    expect(resolved.workspaceRoots).toEqual([])
    expect(resolved.chatWorkspaces).toEqual({})
    expect(resolved.agentPreset).toBe('standard')
    expect(resolved.chatPresets).toEqual({})
    expect(resolved.chatSessions).toEqual({})
    expect(resolved.chatActiveGen).toEqual({})

    expect(resolved.senderAllowlist).toEqual([])
    expect(resolved.groupAllowlist).toEqual([])
    expect(resolved.approvers).toEqual([])
  })

  it('tolerates scalar strings where lists belong (hand-edited settings, R33)', () => {
    // A hand-edited `workspaceRoots: <path>` / `modelCatalog: a/b c/d` used to
    // throw during bootstrap and take the whole bot down; scalars now degrade
    // to one-entry lists.
    const resolved = resolveConfig({
      appId: 'cli_abc',
      appSecret: 'secret',
      workspaceRoots: '/home/user/projects' as unknown as string[],
      modelCatalog: 'deepseek-official/deepseek-v4' as unknown as string[],
    })
    expect(resolved.workspaceRoots).toEqual(['/home/user/projects'])
    expect(resolved.modelCatalog).toEqual(['deepseek-official/deepseek-v4'])
  })

  it('keeps configured values', () => {
    const resolved = resolveConfig({
      appId: 'cli_abc',
      appSecret: 'secret',
      domain: 'lark',
      connectionMode: 'webhook',
      sessionScope: 'chat-sender',
      requireMention: false,
      locale: 'en-US',
      senderAllowlist: ['ou_a', '', ' ou_b '],
    })
    expect(resolved.appId).toBe('cli_abc')
    expect(resolved.domain).toBe('lark')
    expect(resolved.connectionMode).toBe('webhook')
    expect(resolved.sessionScope).toBe('chat-sender')
    expect(resolved.requireMention).toBe(false)
    expect(resolved.locale).toBe('en-US')
    expect(resolved.senderAllowlist).toEqual(['ou_a', 'ou_b'])
  })

  it('keeps agentPreset and cleans the chatPresets map (R27)', () => {
    const resolved = resolveConfig({
      appId: 'cli_abc',
      appSecret: 'secret',
      agentPreset: 'minimal',
      chatPresets: { 'oc_a@om_t': ' minimal ', 'oc_b': '' },
    })
    expect(resolved.agentPreset).toBe('minimal')
    expect(resolved.chatPresets).toEqual({ 'oc_a@om_t': 'minimal' })
  })

  it('defaults showReasoning to true and cleans the chatReasoning map (R36-2)', () => {
    expect(resolveConfig({ appId: 'cli_a', appSecret: 's' }).showReasoning).toBe(true)
    expect(resolveConfig({ appId: 'cli_a', appSecret: 's', showReasoning: false }).showReasoning).toBe(false)
    expect(resolveConfig({ appId: 'cli_a', appSecret: 's' }).chatReasoning).toEqual({})
    // The `/reasoning` vocabulary is closed: a hand-edited third state is
    // dropped rather than reaching the bridge as an unrenderable value.
    const resolved = resolveConfig({
      appId: 'cli_a',
      appSecret: 's',
      chatReasoning: { oc_a: 'off', 'oc_b': ' maybe ', oc_c: '' },
    })
    expect(resolved.chatReasoning).toEqual({ oc_a: 'off' })
  })

  it('clamps numbers to sane lower bounds', () => {
    const resolved = resolveConfig({ approvalTimeoutMs: 5, maxReceiveFileBytes: -1, webhookPort: 0 })
    expect(resolved.approvalTimeoutMs).toBe(10_000)
    expect(resolved.maxReceiveFileBytes).toBe(20 * 1024 * 1024)
    expect(resolved.webhookPort).toBe(1)
  })
})

describe('hasCredentials', () => {
  it('requires both non-empty fields', () => {
    expect(hasCredentials({ appId: 'cli_a', appSecret: 'x' })).toBe(true)
    expect(hasCredentials({ appId: '', appSecret: 'x' })).toBe(false)
    expect(hasCredentials({ appId: 'cli_a', appSecret: '' })).toBe(false)
    expect(hasCredentials({})).toBe(false)
  })
})
