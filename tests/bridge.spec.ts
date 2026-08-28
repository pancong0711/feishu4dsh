import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BridgeHost, BridgeHooks, BridgeTimingOptions } from '../src/bridge.js'
import { installBridge, REPLY_TARGETS_MAX } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import type { ResolvedConfig } from '../src/config.js'
import { resolveAuthorization } from '../src/acl.js'
import type { ChannelPort, ResourceType } from '../src/adapter.js'
import type { HostAgent, HostAgentOptions, HostRequestHeaderConfig, HostSession, HostSessionEvent, HostUserMessage } from '../src/host.js'
import type { MutableSelection } from '../src/model-selection.js'
import { sleep } from '../src/util.js'

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

class FakeAgent implements HostAgent {
  readonly followups: HostUserMessage[] = []
  readonly cancels: string[] = []
  /** The cwd the agent was created under (undefined when resumed). */
  cwd?: string
  /** The provider/model the agent was created with. */
  agentOptions?: HostAgentOptions
  /** The agent preset the agent was created under (R18). */
  preset?: string
  /**
   * When set, the fake session advertises `requestHeader()` (R7); leaving it
   * undefined models an older host whose sessions have no such capability.
   */
  headerReader?: () => { config?: HostRequestHeaderConfig } | undefined
  /** When set, the fake session exposes the dsh session log (R26). */
  sessionEvents?: readonly HostSessionEvent[]
  constructor(readonly id: string) {}
  get session(): HostSession {
    const base: HostSession = this.headerReader === undefined
      ? { id: this.id }
      : { id: this.id, requestHeader: this.headerReader }
    return this.sessionEvents === undefined ? base : { ...base, events: this.sessionEvents }
  }
  followup(message: HostUserMessage): void { this.followups.push(message) }
  cancel(cause: string): void { this.cancels.push(cause) }
}

interface SentMessage {
  to: string
  input: Record<string, unknown>
  options?: { replyTo?: string; replyInThread?: boolean }
}

class FakePort implements ChannelPort {
  readonly sent: SentMessage[] = []
  readonly cardUpdates: { messageId: string; card: object }[] = []
  readonly downloads = new Map<string, Buffer>()
  /** Every `downloadResource` invocation, in order (R24 signature probe). */
  readonly downloadCalls: { fileKey: string; type: ResourceType; messageId: string }[] = []
  private readonly handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  botIdentity: undefined = undefined

  on(name: string, handler: (...args: unknown[]) => unknown): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
    return () => undefined
  }

  emit(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name) ?? []) handler(...args)
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async send(to: string, input: Record<string, unknown>, options?: { replyTo?: string; replyInThread?: boolean }) {
    this.sent.push({ to, input, options })
    return { messageId: `om_${this.sent.length}` }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.cardUpdates.push({ messageId, card })
  }

  async editMessage(): Promise<void> {}
  async downloadResource(fileKey: string, type: ResourceType, messageId: string): Promise<Buffer> {
    this.downloadCalls.push({ fileKey, type, messageId })
    const data = this.downloads.get(fileKey)
    if (data === undefined) throw new Error(`no fixture for ${fileKey}`)
    return data
  }
  async stream(): Promise<{ messageId: string }> { throw new Error('no streaming in fake') }
  async addReaction(): Promise<string> { return 'r1' }
  async removeReactionByEmoji(): Promise<boolean> { return true }
}

function fakeHost() {
  const created: FakeAgent[] = []
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const services = new Map<string, unknown>()
  /** Tool definitions the bridge registered on agent contexts (R25 probing). */
  const registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const toolsRegistry = {
    register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
      registeredTools.push(definition)
      return () => undefined
    },
  }
  const host: BridgeHost & {
    created: FakeAgent[]
    emit(name: string, ...args: unknown[]): unknown[]
    services: Map<string, unknown>
    registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]
  } = {
    created,
    services,
    registeredTools,
    agents: {
      async resume(): Promise<never> { throw new Error('nothing to resume in tests') },
      async create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: HostAgentOptions; setup?: (ctx: { get(name: string): unknown }) => Promise<void> }) {
        if (options.setup !== undefined) await options.setup({ get: (name: string) => name === 'tools' ? toolsRegistry : undefined, on: () => () => undefined })
        const agent = new FakeAgent(options.sessionId)
        agent.cwd = options.meta?.cwd
        agent.preset = options.meta?.agentPreset
        agent.agentOptions = options.agentOptions
        created.push(agent)
        return { agent, async dispose(): Promise<void> {} }
      },
    },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => undefined
    },
    get(name: string): unknown { return services.get(name) },
    emit(name: string, ...args: unknown[]): unknown[] {
      return (handlers.get(name) ?? []).map(handler => handler(...args))
    },
  }
  return host
}

function makeEnv(overrides?: Partial<ResolvedConfig>, hooks?: BridgeHooks) {
  const workspace = mkdtempSync(join(tmpdir(), 'feishu4dsh-ws-'))
  // resolveConfig floors approvalTimeoutMs at 10s for production safety;
  // timeout tests bypass the floor by overriding the resolved value directly.
  const config: ResolvedConfig = {
    ...resolveConfig({
      appId: 'cli_test',
      appSecret: 'secret',
      workspace,
      ...overrides,
    }),
    ...(overrides?.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: overrides.approvalTimeoutMs }),
  }
  const port = new FakePort()
  const host = fakeHost()
  // Install the bridge under test.
  const dispose = installBridge(
    host,
    config,
    port,
    resolveAuthorization(config),
    () => undefined,
    hooks,
  )
  return { workspace, config, port, host, dispose }
}

async function textMessage(port: FakePort, content: string, extras?: Record<string, unknown>) {
  port.emit('message', {
    messageId: `m_${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'oc_chat1',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...extras,
  })
  await sleep(20)
}

/**
 * Mount a fake host `installModelSelection` service and capture every
 * selection the bridge installs, so tests can inspect `selection.current`.
 */
function captureSelections(host: ReturnType<typeof fakeHost>) {
  const installed: { ctx: unknown; selection: MutableSelection }[] = []
  host.services.set('installModelSelection', (ctx: unknown, selection: MutableSelection) => {
    installed.push({ ctx, selection })
    return () => undefined
  })
  return installed
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('bridge: inbound messages', () => {
  it('creates one agent per chat and forwards the text', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'build the project')
    await textMessage(port, 'now run the tests')

    expect(host.created).toHaveLength(1)
    const agent = host.created[0]
    expect(agent?.followups).toHaveLength(2)
    expect(agent?.followups[0]?.content[0]).toEqual({ type: 'text', text: 'build the project' })
    // Same chat continues the same session: no second agent is created.
    expect(agent?.followups[1]?.content[0]).toEqual({ type: 'text', text: 'now run the tests' })
  })

  it('seeds new agents with the default provider/model', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }),
    })
    await textMessage(port, 'hello')

    expect(host.created).toHaveLength(1)
    expect(host.created[0]?.agentOptions).toEqual({ provider: 'opencode-go', model: 'deepseek-v4-flash' })
  })

  it('R18: creates Feishu agents with the standard preset (full toolset)', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    expect(host.created).toHaveLength(1)
    // minimal 预设只有 bash 终端，跑不了「需求文档 → subagent」协作；新会话必须 standard。
    expect(host.created[0]?.preset).toBe('standard')
  })

  it('creates agents without a default model service', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')

    // No agentDefaultModel service mounted: agentOptions is left empty rather
    // than throwing, matching the host's "no default advertised" case.
    expect(host.created).toHaveLength(1)
    expect(host.created[0]?.agentOptions).toEqual({})
  })

  it('notes an image when vision is off and saving to inbox is disabled', async () => {
    const { host, port } = makeEnv({ saveImagesToInbox: false })
    await textMessage(port, '', {
      resources: [{ type: 'image', fileKey: 'img_key' }],
    })
    // The message carries only a note, which is still model-visible content:
    // one agent gets created, one followup with the note block.
    expect(host.created).toHaveLength(1)
    const blocks = host.created[0]?.followups[0]?.content ?? []
    expect(blocks.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.includes('未开启视觉'))).toBe(true)
  })
})

describe('bridge: replies', () => {
  it('renders committed assistant text and closes the turn', async () => {
    const { host, port } = makeEnv({ showProcess: false })
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'Hi there!' }] } },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'complete' } },
    })
    await sleep(5)

    const reply = port.sent.find(m => typeof m.input.markdown === 'string')
    expect(reply).toBeDefined()
    expect(reply?.input.markdown).toBe('Hi there!')
    expect(reply?.to).toBe('oc_chat1')
  })

  it('aggregates repeated tool calls into one summary line at turn end', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_1', name: 'bash', arguments: '{}' },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_2', name: 'bash', arguments: '{}' },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_3', name: 'edit', arguments: '{}' },
    })
    await sleep(20)

    // No per-call process line is emitted while the turn is still running.
    const beforeTurnEnd = port.sent.filter(m => typeof m.input.markdown === 'string' && String(m.input.markdown).startsWith('> '))
    expect(beforeTurnEnd).toHaveLength(0)

    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(20)

    const summaries = port.sent.filter(m => typeof m.input.markdown === 'string' && String(m.input.markdown).startsWith('> '))
    expect(summaries).toHaveLength(1)
    expect(String(summaries[0]?.input.markdown)).toContain('调用工具 bash × 2 次')
    expect(String(summaries[0]?.input.markdown)).toContain('调用工具 edit × 1 次')
  })

  it('includes token usage and cache reads in the turn summary', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        chunk: {
          type: 'usage',
          usage: {
            inputTokens: 1234,
            outputTokens: 56,
            cacheReadTokens: 890,
            cacheWriteTokens: 12,
            reasoningTokens: 3,
          },
        },
      },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_1', name: 'bash', arguments: '{}' },
    })
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(20)

    const summary = port.sent.find(m => typeof m.input.markdown === 'string' && String(m.input.markdown).startsWith('> '))
    expect(summary).toBeDefined()
    const text = String(summary?.input.markdown)
    expect(text).toContain('调用工具 bash × 1 次')
    expect(text).toContain('Token：输入 1,234 · 输出 56')
    expect(text).toContain('缓存读 890')
    expect(text).toContain('缓存写 12')
    expect(text).toContain('推理 3')
  })

  it('threads tool-call summary under the inbound message', async () => {
    const { host, port } = makeEnv()
    const messageId = 'om_topic_msg'
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content: 'hello',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_1', name: 'bash', arguments: '{}' },
    })
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(20)

    const summary = port.sent.find(m => typeof m.input.markdown === 'string' && String(m.input.markdown).startsWith('> '))
    expect(summary).toBeDefined()
    expect(String(summary?.input.markdown)).toContain('bash')
    expect(summary?.options?.replyTo).toBe(messageId)
  })

  it('keeps queued turns threaded under their own inbound message', async () => {
    const { host, port } = makeEnv()
    port.emit('message', {
      messageId: 'om_first',
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content: 'first',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    port.emit('message', {
      messageId: 'om_second',
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content: 'second',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
    await sleep(20)
    const firstMessageId = agent.followups[0]?.id
    const secondMessageId = agent.followups[1]?.id
    expect(firstMessageId).toBeDefined()
    expect(secondMessageId).toBeDefined()

    // First queued message's turn.
    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id: firstMessageId } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'first answer' }] } },
    })
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(20)

    // Second queued message's turn starts after the first turn/end cleared
    // binding.replyTo; the user/message event must restore it.
    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
    host.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id: secondMessageId } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/message',
      data: { turn: 2, message: { content: [{ type: 'text', text: 'second answer' }] } },
    })
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
    await sleep(20)

    const firstReply = port.sent.find(m => m.input.markdown === 'first answer')
    const secondReply = port.sent.find(m => m.input.markdown === 'second answer')
    expect(firstReply).toBeDefined()
    expect(firstReply?.options?.replyTo).toBe('om_first')
    expect(firstReply?.options?.replyInThread).toBe(true)
    expect(secondReply).toBeDefined()
    expect(secondReply?.options?.replyTo).toBe('om_second')
    expect(secondReply?.options?.replyInThread).toBe(true)
  })

  it('streams text-delta chunks into one reply', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: 'Hello ' } },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: 'world' } },
    })
    // The committed message repeats the streamed content and must not duplicate it.
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'Hello world' }] } },
    })
    host.emit('session/event', { id: agent.id }, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } },
    })
    await sleep(5)

    const replies = port.sent.filter(m => typeof m.input.markdown === 'string')
    const text = replies.map(m => m.input.markdown).join('')
    expect(text).toBe('Hello world')
  })

  it('reports a failed turn', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { code: 'boom', message: 'kaboom' } } },
    })
    await sleep(5)

    const text = port.sent.map(m => String(m.input.markdown ?? '')).join('\n')
    expect(text).toContain('boom')
  })

  it('ignores events of foreign sessions', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    host.emit('session/event', { id: 'someone-elses-session' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'not ours' }] } },
    })
    host.emit('session/event', { id: 'someone-elses-session' }, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } },
    })
    await sleep(5)
    const reply = port.sent.find(m => m.input.markdown === 'not ours')
    expect(reply).toBeUndefined()
  })
})

describe('bridge: approvals', () => {
  it('sends a card and resolves approve on click', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'delete the file')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    const results = host.emit('approval/request', {
      agent, toolName: 'bash', reason: 'rm -rf out/',
    }, async () => 'unavailable' as const)

    await sleep(5)
    const cardMessage = port.sent.find(m => 'card' in m.input)
    expect(cardMessage).toBeDefined()
    const card = cardMessage?.input.card as { elements: { actions?: { value: Record<string, unknown> }[] }[] }
    const approveButton = card.elements.flatMap(e => e.actions ?? []).find(a => a.value.decision === 'approve')
    expect(approveButton).toBeDefined()

    // Click approve from the same chat's driver.
    port.emit('cardAction', {
      messageId: cardMessage?.messageId,
      chatId: 'oc_chat1',
      operator: { openId: 'ou_user', name: 'User' },
      action: { value: approveButton?.value, tag: 'button' },
    })
    await sleep(5)

    expect(await results[0]).toBe('allowed-once')
    expect(port.cardUpdates.length).toBeGreaterThan(0)
  })

  it('fails closed when nobody answers in time', async () => {
    const { host, port } = makeEnv({ approvalTimeoutMs: 40 })
    await textMessage(port, 'delete the file')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    const results = host.emit('approval/request', { agent, toolName: 'bash' }, async () => 'unavailable' as const)
    await sleep(80)
    expect(await results[0]).toBe('rejected')
    // The settled card names the timeout.
    const settled = port.cardUpdates.at(-1)?.card as { elements: { text?: { content?: string } }[] }
    expect(JSON.stringify(settled)).toContain('超时')
  })

  it('delegates sessions owned by somebody else via next()', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const foreign = new FakeAgent('foreign-session')
    let nextCalled = false
    const results = host.emit('approval/request', { agent: foreign, toolName: 'bash' }, async () => {
      nextCalled = true
      return 'unavailable' as const
    })
    await sleep(5)
    expect(nextCalled).toBe(true)
    expect(await results[0]).toBe('unavailable')
  })

  it('rejects clicks forwarded to another chat', async () => {
    const { host, port } = makeEnv({ approvalTimeoutMs: 500 })
    await textMessage(port, 'delete the file')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    const results = host.emit('approval/request', { agent, toolName: 'bash' }, async () => 'unavailable' as const)
    await sleep(5)
    const cardMessage = port.sent.find(m => 'card' in m.input)
    const card = cardMessage?.input.card as { elements: { actions?: { value: Record<string, unknown> }[] }[] }
    const approveButton = card.elements.flatMap(e => e.actions ?? []).find(a => a.value.decision === 'approve')

    port.emit('cardAction', {
      messageId: cardMessage?.messageId,
      chatId: 'oc_other_chat',
      operator: { openId: 'ou_user', name: 'User' },
      action: { value: approveButton?.value, tag: 'button' },
    })
    await sleep(5)

    // The click produced a "wrong chat" note, not a settlement.
    expect(port.sent.some(m => typeof m.input.markdown === 'string' && String(m.input.markdown).includes('原会话'))).toBe(true)
    const outcome = await Promise.race([results[0] as Promise<string>, sleep(100).then(() => 'still-pending')])
    expect(outcome).toBe('still-pending')
  })
})

describe('bridge: commands', () => {
  it('/help lists channel commands grouped and source-tagged', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, '/help')
    expect(host.created).toHaveLength(0)
    const help = port.sent.find(m => String(m.input.markdown ?? '').includes('/new'))
    expect(help).toBeDefined()
    const text = String(help?.input.markdown)
    // Our own commands are present and clearly labelled as channel-owned.
    expect(text).toContain('feishu4dsh 频道命令')
    expect(text).toContain('/ws — 列出可用工作区 [频道]')
    expect(text).toContain('/cd <名称或路径> — 切换当前会话的工作区 [频道]')
    // No host commands yet (no active agent), so no dsh section.
    expect(text).not.toContain('dsh 宿主命令')
  })

  it('/help tags dsh host commands with their source under a section', async () => {
    const { host, port } = makeEnv()
    // Seed an active agent so host commands can be resolved against it.
    await textMessage(port, 'hello')
    expect(host.created).toHaveLength(1)
    host.services.set('commands', {
      list: () => [
        { name: 'plan', description: 'plan the work' },
        { name: 'compact', description: 'compact context' },
      ],
      execute: async () => undefined,
    })
    await textMessage(port, '/help')
    const help = port.sent.filter(m => String(m.input.markdown ?? '').includes('/new')).pop()
    const text = String(help?.input.markdown)
    expect(text).toContain('dsh 宿主命令')
    expect(text).toContain('/plan — plan the work [dsh]')
    expect(text).toContain('/compact — compact context [dsh]')
    expect(text).toContain('feishu4dsh 频道命令')
  })

  it('/new resets the session generation', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'hello')
    const first = host.created[0]
    expect(first).toBeDefined()

    await textMessage(port, '/new')
    expect(first?.cancels).toContain('session reset')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('新会话'))).toBe(true)

    await textMessage(port, 'hello again')
    expect(host.created).toHaveLength(2)
    expect(host.created[1]?.id).not.toBe(first?.id)
  })

  it('/new keeps the /model pin into the fresh session', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p_default', model: 'm_default' }),
    })
    const installed = captureSelections(host)

    await textMessage(port, 'hello')
    await textMessage(port, '/model p_pin/m_pin')
    expect(installed[0]?.selection.current).toEqual({ provider: 'p_pin', model: 'm_pin' })

    // /new clears context only: the next agent re-installs the SAME selection
    // object, so the pinned model carries over instead of dropping to default.
    await textMessage(port, '/new')
    await textMessage(port, 'hello again')
    expect(host.created).toHaveLength(2)
    expect(installed).toHaveLength(2)
    expect(installed[1]?.selection).toBe(installed[0]?.selection)
    expect(installed[1]?.selection.current).toEqual({ provider: 'p_pin', model: 'm_pin' })
  })

  it('/stop cancels the active agent', async () => {
    const { host, port } = makeEnv()
    await textMessage(port, 'long task')
    await textMessage(port, '/stop')
    expect(host.created[0]?.cancels).toContain('stopped from chat')
  })

  it('/status reports the session and workspace', async () => {
    const { port, workspace } = makeEnv()
    await textMessage(port, 'hello')
    await textMessage(port, '/status')
    const status = port.sent.find(m => String(m.input.markdown ?? '').includes('会话：'))
    expect(status).toBeDefined()
    expect(String(status?.input.markdown)).toContain(workspace)
  })

  it('unknown commands answer politely', async () => {
    const { port } = makeEnv()
    await textMessage(port, '/frobnicate')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('未知命令'))).toBe(true)
  })
})

describe('bridge: media inbound', () => {
  it('files land in the inbox and are announced', async () => {
    const { host, port } = makeEnv()
    port.downloads.set('file_key', Buffer.from('file-bytes'))
    await textMessage(port, 'summarize', {
      resources: [{ type: 'file', fileKey: 'file_key', fileName: 'notes.txt' }],
    })
    // Inbound media triggers real file I/O into the inbox; give it room to settle.
    await sleep(30)
    await textMessage(port, 'go on')
    const agent = host.created[0]
    const blocks = agent?.followups[0]?.content ?? []
    const note = blocks.find(b => b.type === 'text' && b.text.includes('.feishu4dsh/inbox'))
    expect(note).toBeDefined()
    expect(String((note as { text: string }).text)).toContain('notes.txt')
  })

  // R24: the adaptive port signature is (fileKey, type, messageId) — the
  // bridge must forward the inbound message's own id so the transport can use
  // the message-scoped download API (user resources 400 on the legacy path).
  it('forwards (fileKey, type, messageId) to downloadResource', async () => {
    const { port } = makeEnv()
    port.downloads.set('file_key', Buffer.from('file-bytes'))
    await textMessage(port, 'summarize', {
      messageId: 'om_r24_pinned',
      resources: [{ type: 'file', fileKey: 'file_key', fileName: 'notes.txt' }],
    })
    await sleep(30)
    expect(port.downloadCalls).toEqual([{ fileKey: 'file_key', type: 'file', messageId: 'om_r24_pinned' }])
  })

  it('saves inbound images into the inbox when vision is off', async () => {
    const { host, port, workspace } = makeEnv({ attachImages: false })
    port.downloads.set('img_key', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await textMessage(port, 'look at this', {
      resources: [{ type: 'image', fileKey: 'img_key', fileName: 'photo.png' }],
    })
    await sleep(30)

    const agent = host.created[0]
    expect(agent).toBeDefined()
    const blocks = agent?.followups[0]?.content ?? []
    const note = blocks.find(b => b.type === 'text' && b.text.includes('.feishu4dsh/inbox'))
    expect(note).toBeDefined()
    expect(String((note as { text: string }).text)).toContain('photo.png')

    const inbox = join(workspace, '.feishu4dsh/inbox')
    expect(existsSync(inbox)).toBe(true)
    expect(readdirSync(inbox).length).toBeGreaterThan(0)
  })

  it('enforces the total inbound media size limit per message', async () => {
    const { host, port, workspace } = makeEnv({ maxMessageReceiveBytes: 5, maxReceiveFileBytes: 100 })
    port.downloads.set('file_key_1', Buffer.from('abc'))
    port.downloads.set('file_key_2', Buffer.from('def'))
    await textMessage(port, 'two files', {
      resources: [
        { type: 'file', fileKey: 'file_key_1', fileName: 'a.txt' },
        { type: 'file', fileKey: 'file_key_2', fileName: 'b.txt' },
      ],
    })
    await sleep(30)

    const agent = host.created[0]
    expect(agent).toBeDefined()
    const blocks = agent?.followups[0]?.content ?? []
    const texts = blocks.map(b => b.type === 'text' && typeof b.text === 'string' ? b.text : '').join('\n')
    expect(texts).toContain('a.txt')
    expect(texts).toContain('总大小超过限制')

    // The second file is skipped by the total cap, so its name is not announced.
    expect(texts).not.toContain('b.txt')
    const inbox = join(workspace, '.feishu4dsh/inbox')
    expect(existsSync(inbox)).toBe(true)
    expect(readdirSync(inbox).length).toBeGreaterThan(0)
  })

  it('saves inbound files into the chat’s current workspace after /cd', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-inbox-ws-'))
    try {
      await textMessage(port, `/cd ${sibling}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)

      port.downloads.set('file_key', Buffer.from('file-bytes'))
      await textMessage(port, 'read this file', {
        resources: [{ type: 'file', fileKey: 'file_key', fileName: 'notes.txt' }],
      })
      await sleep(30)

      const agent = host.created[0]
      expect(agent).toBeDefined()
      const blocks = agent?.followups[0]?.content ?? []
      const note = blocks.find(b => b.type === 'text' && b.text.includes('.feishu4dsh/inbox'))
      expect(note).toBeDefined()
      expect(String((note as { text: string }).text)).toContain('notes.txt')

      const inbox = join(sibling, '.feishu4dsh/inbox')
      expect(existsSync(inbox)).toBe(true)
      expect(readdirSync(inbox).length).toBeGreaterThan(0)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('bridge: workspace switching', () => {
  it('/ws lists the default workspace', async () => {
    const { port, workspace } = makeEnv()
    await textMessage(port, '/ws')
    const ws = port.sent.find(m => String(m.input.markdown ?? '').includes('可用工作区'))
    expect(ws).toBeDefined()
    expect(String(ws?.input.markdown)).toContain(workspace)
  })

  it('/ws lists host-registered workspaces', async () => {
    const { host, port } = makeEnv()
    const sibling1 = mkdtempSync(join(tmpdir(), 'feishu4dsh-reg1-'))
    const sibling2 = mkdtempSync(join(tmpdir(), 'feishu4dsh-reg2-'))
    try {
      host.services.set('workspaceRegistry', {
        list: () => [{ path: sibling1 }, { path: sibling2 }],
        resolveByPath: async (p: string) => ({ id: 'w', path: p }),
        create: async (p: string) => ({ id: 'w', path: p }),
      })
      await textMessage(port, '/ws')
      const list = port.sent.map(m => String(m.input.markdown ?? '')).join('\n')
      expect(list).toContain(sibling1)
      expect(list).toContain(sibling2)
    } finally {
      rmSync(sibling1, { recursive: true, force: true })
      rmSync(sibling2, { recursive: true, force: true })
    }
  })

  it('/ws refreshes newly registered workspaces after the first listing', async () => {
    const { host, port } = makeEnv()
    const sibling1 = mkdtempSync(join(tmpdir(), 'feishu4dsh-refresh1-'))
    const sibling2 = mkdtempSync(join(tmpdir(), 'feishu4dsh-refresh2-'))
    try {
      const registry = {
        list: () => [{ path: sibling1 }],
        resolveByPath: async (p: string) => ({ id: 'w', path: p }),
        create: async (p: string) => ({ id: 'w', path: p }),
      }
      host.services.set('workspaceRegistry', registry)

      await textMessage(port, '/ws')
      let list = port.sent.map(m => String(m.input.markdown ?? '')).join('\n')
      expect(list).toContain(sibling1)
      expect(list).not.toContain(sibling2)

      // Simulate the host registering a new workspace after the bridge cached
      // its first catalog; the next /ws must pick it up.
      registry.list = () => [{ path: sibling1 }, { path: sibling2 }]
      await textMessage(port, '/ws')
      list = port.sent.map(m => String(m.input.markdown ?? '')).join('\n')
      expect(list).toContain(sibling2)
    } finally {
      rmSync(sibling1, { recursive: true, force: true })
      rmSync(sibling2, { recursive: true, force: true })
    }
  })

  it('/status reports the current workspace and scope', async () => {
    const { port, workspace } = makeEnv()
    await textMessage(port, '/status')
    const status = port.sent.find(m => String(m.input.markdown ?? '').includes('会话状态'))
    expect(status).toBeDefined()
    expect(String(status?.input.markdown)).toContain(workspace)
    expect(String(status?.input.markdown)).toContain('会话粒度')
    expect(String(status?.input.markdown)).toContain('/cd')
  })

  it('/cd switches workspace and the next turn runs in the new one', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-sib-'))
    try {
      await textMessage(port, 'first task')
      expect(host.created).toHaveLength(1)
      // The first agent is rooted in the configured default workspace.
      const defaultWs = host.created[0]?.cwd
      expect(defaultWs).not.toBe(sibling)

      await textMessage(port, `/cd ${sibling}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)

      await textMessage(port, 'second task')
      expect(host.created).toHaveLength(2)
      expect(host.created[1]?.cwd).toBe(sibling)
      expect(host.created[1]?.id).not.toBe(host.created[0]?.id)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('/cd back returns to the previous workspace without mixing sessions', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-sib2-'))
    try {
      await textMessage(port, 'task A')
      const firstAgent = host.created[0]
      expect(firstAgent).toBeDefined()

      await textMessage(port, `/cd ${sibling}`)
      await textMessage(port, 'task B')
      expect(host.created).toHaveLength(2)

      // Switch back to the default workspace and send another message.
      await textMessage(port, `/cd ${firstAgent?.cwd ?? ''}`)
      await textMessage(port, 'task A again')

      // Returning reuses the ORIGINAL default-workspace session (the first
      // agent), so no third agent is created and the message lands there.
      expect(host.created).toHaveLength(2)
      const gotIt = firstAgent?.followups.some(m =>
        m.content.some(block => block.type === 'text' && block.text === 'task A again'),
      )
      expect(gotIt).toBe(true)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('/cd refuses paths outside the allowed roots', async () => {
    const { port } = makeEnv()
    const outside = mkdtempSync(join(tmpdir(), 'feishu4dsh-out-'))
    try {
      await textMessage(port, `/cd ${outside}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不在允许'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('/cd accepts a registered workspace by name even without roots', async () => {
    const { host, port } = makeEnv()
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-reg-'))
    try {
      host.services.set('workspaceRegistry', {
        list: () => [{ path: sibling }],
        resolveByPath: async (p: string) => (p === sibling ? { id: 'w', path: sibling } : undefined),
        create: async (p: string) => ({ id: 'w', path: p }),
      })
      const name = sibling.split('/').pop() ?? ''
      await textMessage(port, `/cd ${name}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)
      await textMessage(port, 'work here')
      expect(host.created[0]?.cwd).toBe(sibling)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('/cd with no argument shows usage', async () => {
    const { port } = makeEnv()
    await textMessage(port, '/cd')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('/cd <'))).toBe(true)
  })

  it('persists workspace selection via the hook', async () => {
    const persisted: Record<string, string> = {}
    const { port } = makeEnv(
      { workspaceRoots: [tmpdir()] },
      { onWorkspaceChange: (scopeKey, path) => { persisted[scopeKey] = path } },
    )
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-persist-'))
    try {
      await textMessage(port, 'bootstrap the binding')
      await textMessage(port, `/cd ${sibling}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)
      expect(Object.values(persisted)).toEqual([sibling])
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('bridge: /ws add & remove', () => {
  it('adds an existing directory and /cd can then enter it', async () => {
    const { host, port } = makeEnv()
    const target = mkdtempSync(join(tmpdir(), 'feishu4dsh-add-'))
    try {
      await textMessage(port, `/ws add ${target}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已添加工作区'))).toBe(true)
      // It now shows up in the list and is switchable by short name.
      await textMessage(port, '/ws')
      const list = port.sent.map(m => String(m.input.markdown ?? '')).join('\n')
      expect(list).toContain(basename(target))
      await textMessage(port, `/cd ${basename(target)}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('persists added workspaces through the hook', async () => {
    let latest: string[] = []
    const { port } = makeEnv({}, { onUserWorkspacesChange: ws => { latest = ws } })
    const target = mkdtempSync(join(tmpdir(), 'feishu4dsh-persist-ws-'))
    try {
      await textMessage(port, `/ws add ${target}`)
      expect(latest).toEqual([target])
      await textMessage(port, `/ws remove ${basename(target)}`)
      expect(latest).toEqual([])
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('refuses to add a path that is not a directory', async () => {
    const { port, workspace } = makeEnv()
    const filePath = join(workspace, 'not-a-dir.txt')
    writeFileSync(filePath, 'x')
    await textMessage(port, `/ws add ${filePath}`)
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不是一个已存在的目录'))).toBe(true)
    await textMessage(port, '/ws add /nonexistent/xyzzy')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不是一个已存在的目录'))).toBe(true)
  })

  it('gates /ws add and /ws remove by the approver list', async () => {
    const { port } = makeEnv({ approvers: ['ou_admin'] })
    const target = mkdtempSync(join(tmpdir(), 'feishu4dsh-gated-'))
    try {
      // Not an approver -> refused.
      await textMessage(port, `/ws add ${target}`, { senderId: 'ou_user' })
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('无权管理工作区'))).toBe(true)
      // An approver -> allowed.
      await textMessage(port, `/ws add ${target}`, { senderId: 'ou_admin' })
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已添加工作区'))).toBe(true)
      await textMessage(port, `/ws remove ${basename(target)}`, { senderId: 'ou_user' })
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('无权管理工作区'))).toBe(true)
      await textMessage(port, `/ws remove ${basename(target)}`, { senderId: 'ou_admin' })
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已移除工作区'))).toBe(true)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('removes a user-added workspace and protects the default from removal', async () => {
    const { port, workspace } = makeEnv()
    const target = mkdtempSync(join(tmpdir(), 'feishu4dsh-rm-'))
    try {
      await textMessage(port, `/ws add ${target}`)
      await textMessage(port, `/ws remove ${basename(target)}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已移除工作区'))).toBe(true)
      // After removal the path is no longer admissible.
      await textMessage(port, `/cd ${basename(target)}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不在允许'))).toBe(true)
      // The default workspace cannot be removed.
      await textMessage(port, `/ws remove ${basename(workspace)}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不是通过 /ws add 添加'))).toBe(true)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('/ws add needs a path argument', async () => {
    const { port } = makeEnv()
    await textMessage(port, '/ws add')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('/ws add <'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* R7/R8: /status real model & /model session-scoped switching         */
/* ------------------------------------------------------------------ */

describe('bridge: R7 /status shows the real current model', () => {
  const defaultsOf = (provider: string, model: string) => ({ currentSelection: () => ({ provider, model }) })

  it('R7-a: shows the model from the session request header', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')
    agent.headerReader = () => ({ config: { provider: 'p1', model: 'm1' } })

    await textMessage(port, '/status')
    const status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
    expect(status).toBeDefined()
    const text = String(status?.input.markdown)
    expect(text).toContain('模型：p1/m1')
    // A real measured model is not tagged as default.
    expect(text).not.toContain('（默认')
  })

  it('R7-b: tags the default with “尚未开始对话” when the header has nothing yet', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))

    // Before any agent exists there is nothing to ask: plain default, no tag.
    await textMessage(port, '/status')
    let status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
    expect(String(status?.input.markdown)).toContain('模型：p_default/m_default')
    expect(String(status?.input.markdown)).not.toContain('（默认')

    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')
    agent.headerReader = () => undefined

    await textMessage(port, '/status')
    status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
    const text = String(status?.input.markdown)
    expect(text).toContain('模型：p_default/m_default（默认，尚未开始对话）')
  })

  it('R7-b: an old host without requestHeader keeps the untagged default', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    await textMessage(port, 'hello') // FakeAgent without headerReader
    await textMessage(port, '/status')
    const text = String(port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()?.input.markdown)
    expect(text).toContain('模型：p_default/m_default')
    expect(text).not.toContain('（默认')
  })

  it('R7-c: a pinned /model choice wins over the stale request header', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    const installed = captureSelections(host)
    await textMessage(port, 'hello')
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')
    agent.headerReader = () => ({ config: { provider: 'p_old', model: 'm_old' } })
    expect(installed).toHaveLength(1)

    await textMessage(port, '/model p_new/m_new')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换当前会话模型为 p_new/m_new'))).toBe(true)

    await textMessage(port, '/status')
    const text = String(port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()?.input.markdown)
    expect(text).toContain('模型：p_new/m_new')
    expect(text).not.toContain('p_old/m_old')
  })
})

describe('bridge: R8 /model switching', () => {
  const defaultsOf = (provider: string, model: string) => ({ currentSelection: () => ({ provider, model }) })

  it('R8-a: pins selection.current through the host installer and confirms', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    const installed = captureSelections(host)

    await textMessage(port, 'hello')
    expect(installed).toHaveLength(1)
    // The installer receives the agent context the host handed to setup.
    expect(installed[0]?.ctx).toBeDefined()

    await textMessage(port, '/model p2/m2')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换当前会话模型为 p2/m2'))).toBe(true)
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('下一轮'))).toBe(true)
    expect(installed[0]?.selection.current).toEqual({ provider: 'p2', model: 'm2' })
  })

  it('R8-a2: /model works before the agent exists and the pin survives agent creation', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    const installed = captureSelections(host)

    // No agent yet: /model should pre-set selection instead of “不支持”.
    await textMessage(port, '/model p_pre/m_pre')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换当前会话模型为 p_pre/m_pre'))).toBe(true)

    // Creating the agent must reuse the same pre-set selection.
    await textMessage(port, 'hello')
    expect(installed).toHaveLength(1)
    expect(installed[0]?.selection.current).toEqual({ provider: 'p_pre', model: 'm_pre' })
  })

  it('R8-b: without the host service the local agentCtx installer still works', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    await textMessage(port, 'hello')

    await textMessage(port, '/model p2/m2')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换当前会话模型为 p2/m2'))).toBe(true)
  })

  it('R8-b: a failing installer also degrades gracefully', async () => {
    const { host, port } = makeEnv()
    host.services.set('installModelSelection', () => {
      throw new Error('host exploded')
    })
    await textMessage(port, 'hello')

    await textMessage(port, '/model p2/m2')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不支持切换'))).toBe(true)
  })

  it('R8-c: the approver list gates switching; listed approvers succeed', async () => {
    const { host, port } = makeEnv({ approvers: ['ou_admin'] })
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    const installed = captureSelections(host)
    await textMessage(port, 'hello')

    await textMessage(port, '/model p2/m2', { senderId: 'ou_user' })
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('无权切换模型'))).toBe(true)
    expect(installed[0]?.selection.current).toEqual({ provider: 'p_default', model: 'm_default' })

    await textMessage(port, '/model p3/m3', { senderId: 'ou_admin' })
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换当前会话模型为 p3/m3'))).toBe(true)
    expect(installed[0]?.selection.current).toEqual({ provider: 'p3', model: 'm3' })
  })

  it('R8-d: bare /model reports the current model; bad input answers usage', async () => {
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    const installed = captureSelections(host)
    await textMessage(port, 'hello')

    await textMessage(port, '/model')
    expect(String(port.sent.at(-1)?.input.markdown)).toContain('模型：p_default/m_default')

    await textMessage(port, '/model abc')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('用法：/model'))).toBe(true)
    // The refused input left the selection untouched.
    expect(installed[0]?.selection.current).toEqual({ provider: 'p_default', model: 'm_default' })
  })

  it('/model default saves the session choice; missing saveSelection refuses', async () => {
    const saved: unknown[] = []
    const { host, port } = makeEnv()
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p_default', model: 'm_default' }),
      saveSelection: (selection: unknown) => { saved.push(selection) },
    })
    captureSelections(host)
    await textMessage(port, 'hello')
    await textMessage(port, '/model p9/m9')

    await textMessage(port, '/model default')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已把部署默认模型保存为 p9/m9'))).toBe(true)
    expect(saved).toEqual([{ provider: 'p9', model: 'm9' }])

    // Service without saveSelection → graceful "unsupported".
    host.services.set('agentDefaultModel', defaultsOf('p_default', 'm_default'))
    await textMessage(port, '/model default')
    expect(port.sent.some(m => String(m.input.markdown ?? '').includes('不支持保存默认模型'))).toBe(true)
  })
})

describe('bridge: R9 chat-thread inherits the chat’s saved workspace', () => {
  it('R9-a: a brand-new topic inherits the chat-level /cd mapping', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r9a-'))
    try {
      const { host, port, workspace } = makeEnv({
        sessionScope: 'chat-thread',
        chatWorkspaces: { oc_chat1: sibling },
      })
      // First message in a NEW thread: scopeKey is `oc_chat1@ot_thread1`,
      // which has no persisted entry of its own — it must fall back to the
      // chat-level mapping instead of the deployment default.
      await textMessage(port, 'hello from a fresh topic', { threadId: 'ot_thread1' })

      expect(host.created).toHaveLength(1)
      expect(host.created[0]?.cwd).toBe(sibling)
      expect(host.created[0]?.cwd).not.toBe(workspace)

      // /status reports the inherited workspace too.
      await textMessage(port, '/status', { threadId: 'ot_thread1' })
      const status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
      expect(String(status?.input.markdown)).toContain(basename(sibling))
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('R9-b: an exact topic mapping still wins over the chat-level one', async () => {
    const chatWs = mkdtempSync(join(tmpdir(), 'feishu4dsh-r9b-chat-'))
    const topicWs = mkdtempSync(join(tmpdir(), 'feishu4dsh-r9b-topic-'))
    try {
      const { host, port } = makeEnv({
        sessionScope: 'chat-thread',
        chatWorkspaces: {
          oc_chat1: chatWs,
          'oc_chat1@ot_thread2': topicWs,
        },
      })
      await textMessage(port, 'hello exact topic', { threadId: 'ot_thread2' })

      expect(host.created).toHaveLength(1)
      expect(host.created[0]?.cwd).toBe(topicWs)
      expect(host.created[0]?.cwd).not.toBe(chatWs)
    } finally {
      rmSync(chatWs, { recursive: true, force: true })
      rmSync(topicWs, { recursive: true, force: true })
    }
  })

  it('R9-c: the fallback never fires outside chat-thread', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r9c-'))
    try {
      // chat-sender: scope key is `oc_chat1#ou_user` — no `@`, so the
      // chat-level mapping must NOT be inherited; the default applies.
      const sender = makeEnv({ sessionScope: 'chat-sender', chatWorkspaces: { oc_chat1: sibling } })
      await textMessage(sender.port, 'hello per sender')
      expect(sender.host.created).toHaveLength(1)
      expect(sender.host.created[0]?.cwd).toBe(sender.workspace)
      sender.dispose()

      // chat: scope key IS the chat id — plain exact lookup, unchanged.
      const chat = makeEnv({ sessionScope: 'chat', chatWorkspaces: { oc_chat1: sibling } })
      await textMessage(chat.port, 'hello whole chat')
      expect(chat.host.created).toHaveLength(1)
      expect(chat.host.created[0]?.cwd).toBe(sibling)
      chat.dispose()
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R10: workspace path validation & normalization                      */
/* ------------------------------------------------------------------ */

describe('bridge: R10 workspace path validation & normalization', () => {
  it('R10-a: a chatWorkspaces value pointing at a non-existent (stray-space) path falls back to the default workspace', async () => {
    // The bad inherited path points at a directory that does NOT exist.
    const parent = mkdtempSync(join(tmpdir(), 'feishu4dsh-r10a-'))
    const bad = join(parent, 'some - dir') // stray space + non-existent dir
    const { host, port, workspace } = makeEnv({
      sessionScope: 'chat-thread',
      chatWorkspaces: {
        // key must be `oc_chat1@ot_...` because textMessage hardcodes chatId `oc_chat1`.
        'oc_chat1@ot_bad': bad,
      },
    })
    try {
      await textMessage(port, 'hello on a bad-inherited workspace', { threadId: 'ot_bad' })
      expect(host.created).toHaveLength(1)
      // The bad, non-existent path must NOT be used as the Agent cwd; it falls
      // back to the deployment default (which makeEnv created for real).
      expect(host.created[0]?.cwd).toBe(workspace)
      expect(host.created[0]?.cwd).not.toContain('some - dir')
    } finally {
      rmSync(parent, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('R10-b: a chatWorkspaces value with stray spaces is normalized to the real directory when the cleaned form exists', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'feishu4dsh-r10b-'))
    const real = join(parent, '示例目录') // real dir, no stray space
    mkdirSync(real)
    try {
      const { host, port } = makeEnv({
        sessionScope: 'chat-thread',
        chatWorkspaces: {
          // Stray space in the saved value; cleaning yields `real`.
          'oc_chat1@ot_clean': join(parent, '示例 目录'),
        },
      })
      await textMessage(port, 'hello on a cleanable workspace', { threadId: 'ot_clean' })
      expect(host.created).toHaveLength(1)
      expect(host.created[0]?.cwd).toBe(real)
      expect(host.created[0]?.cwd).not.toContain('示例 目录')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('R10-c: /status reflects the fallback default, not the invalid workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'feishu4dsh-r10c-'))
    const bad = join(parent, 'nope - missing')
    const { host, port, workspace } = makeEnv({
      sessionScope: 'chat-thread',
      chatWorkspaces: { 'oc_chat1@ot_bad': bad },
    })
    try {
      await textMessage(port, 'hello', { threadId: 'ot_bad' })
      await textMessage(port, '/status', { threadId: 'ot_bad' })
      const status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
      const text = String(status?.input.markdown)
      // Shows the real (default) workspace, never the stray-space bogus path.
      expect(text).toContain(basename(workspace))
      expect(text).not.toContain('nope')
    } finally {
      rmSync(parent, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R11: model/workspace switch hardening                               */
/* ------------------------------------------------------------------ */

describe('bridge: R11 switch hardening', () => {
  it('R11-a (R10-d): an invalid DEFAULT workspace falls back to the daemon working directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'feishu4dsh-r11a-'))
    const missingDefault = join(parent, 'missing-default')
    const { host, port } = makeEnv({ workspace: missingDefault })
    try {
      await textMessage(port, 'hello on a broken deployment')
      expect(host.created).toHaveLength(1)
      // Never root the Agent at a non-existent path (that is what made dsh
      // silently run in the host's own directory); fall back to the daemon's own cwd.
      expect(host.created[0]?.cwd).toBe(process.cwd())

      // /status shows the directory the Agent really uses.
      await textMessage(port, '/status')
      const status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
      expect(String(status?.input.markdown)).toContain(process.cwd())
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('R11-b (R10-d): a bad persisted value with an equally bad default still lands on a real directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'feishu4dsh-r11b-'))
    const bad = join(parent, 'nope - dir')
    const { host, port } = makeEnv({
      workspace: join(parent, 'also-missing'),
      chatWorkspaces: { oc_chat1: bad },
    })
    try {
      await textMessage(port, 'hello double-broken')
      expect(host.created).toHaveLength(1)
      expect(host.created[0]?.cwd).toBe(process.cwd())
      expect(host.created[0]?.cwd).not.toContain('nope')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('R11-c: /cd requires the approver ACL, matching /ws add and /model', async () => {
    const { port, workspace } = makeEnv({ approvers: ['ou_admin'], workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r11c-'))
    try {
      // A non-approver may not re-root the shared session…
      await textMessage(port, `/cd ${sibling}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('无权切换工作区'))).toBe(true)
      // …and the binding stays on the default workspace.
      await textMessage(port, '/status')
      const status = port.sent.filter(m => String(m.input.markdown ?? '').includes('会话状态')).pop()
      const text = String(status?.input.markdown)
      expect(text).toContain(basename(workspace))
      expect(text).not.toContain(basename(sibling))

      // An approver can switch.
      await textMessage(port, `/cd ${basename(sibling)}`, { senderId: 'ou_admin' })
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('R11-d: concurrent first messages share one agent creation', async () => {
    const { host, port } = makeEnv()
    // Slow the loader so both messages are in-flight inside ensureAgent at
    // the same time; without the shared creation promise this creates twice.
    host.services.set('loader', { await: () => sleep(30) })

    await Promise.all([
      textMessage(port, 'burst one'),
      textMessage(port, 'burst two'),
    ])
    // The shared creation is still in flight when the bursts' sleeps end.
    await sleep(60)

    expect(host.created).toHaveLength(1)
    expect(host.created[0]?.followups).toHaveLength(2)
  })

  it('R11-e: late events from a previous workspace session do not bleed into the chat after /cd', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r11e-'))
    try {
      await textMessage(port, 'task before switch')
      const oldAgent = host.created[0]
      expect(oldAgent).toBeDefined()

      // A full turn while the old session is current renders normally.
      host.emit('session/event', { id: oldAgent?.id }, { type: 'turn/start', data: { turn: 1 } })
      host.emit('session/event', { id: oldAgent?.id }, {
        type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: 'live answer' } },
      })
      host.emit('session/event', { id: oldAgent?.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
      await sleep(20)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('live answer'))).toBe(true)

      await textMessage(port, `/cd ${sibling}`)
      const sentAfterSwitch = port.sent.length

      // The old agent keeps producing events — they must be dropped instead
      // of appended into whatever the chat is doing in the NEW workspace.
      host.emit('session/event', { id: oldAgent?.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: oldAgent?.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'stale bleed' } },
      })
      host.emit('session/event', { id: oldAgent?.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
      await sleep(20)

      expect(port.sent.length).toBe(sentAfterSwitch)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('stale bleed'))).toBe(false)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R17: approval cards follow their source conversation                */
/* ------------------------------------------------------------------ */

describe('bridge: R17 approval cards follow their source topic', () => {
  function emitInbound(port: FakePort, content: string, messageId: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  it('R17-a: an approval card threads under the current turn’s inbound message', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'do privileged work', 'm_anchor')
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    host.emit('approval/request', {
      agent, toolName: 'bash', reason: 'rm -rf out/',
    }, async () => 'unavailable' as const)
    await sleep(5)

    const cardMessage = port.sent.find(m => 'card' in m.input)
    expect(cardMessage).toBeDefined()
    // The card lands INSIDE the topic that asked for it, not at the chat root.
    expect(cardMessage?.options).toEqual({ replyTo: 'm_anchor', replyInThread: true })
  })

  it('R17-b: a stale session’s approval falls back to unthreaded delivery', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r17b-'))
    try {
      emitInbound(port, 'task before switch', 'm_old_turn')
      await sleep(20)
      const oldAgent = host.created[0]
      if (oldAgent === undefined) throw new Error('agent missing')

      // Switching re-points the chat at another workspace; the old session is
      // no longer "current", so its late approval must NOT thread under the
      // new context's messages.
      await textMessage(port, `/cd ${sibling}`)
      host.emit('approval/request', { agent: oldAgent, toolName: 'bash' },
        async () => 'unavailable' as const)
      await sleep(5)

      const cardMessage = port.sent.find(m => 'card' in m.input)
      expect(cardMessage).toBeDefined()
      expect(cardMessage?.options).toBeUndefined()
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R20: host-autonomous turns thread under the last inbound message    */
/* ------------------------------------------------------------------ */

describe('bridge: R20 host-autonomous turn thread anchor', () => {
  /** Emit an inbound text message with an explicit messageId (the anchor). */
  function emitInbound(port: FakePort, messageId: string, content: string, extras?: Record<string, unknown>): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
      ...extras,
    })
  }

  interface AutonomousTurn {
    turn: number
    text?: string
  }

  /** Drive one turn purely through session/event — no inbound message involved. */
  function emitAutonomousTurn(host: ReturnType<typeof fakeHost>, sessionId: string, options: AutonomousTurn): void {
    host.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: options.turn } })
    if (options.text !== undefined) {
      host.emit('session/event', { id: sessionId }, {
        type: 'assistant/chunk', data: { turn: options.turn, chunk: { type: 'text-delta', text: options.text } },
      })
    }
    host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: options.turn, reason: { kind: 'complete' } } })
  }

  it('R20-a: a host-autonomous turn falls back to the last inbound message as its thread anchor', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'om_seed', 'seed the conversation')
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    // Complete the inbound-driven turn the normal way (with user/message
    // restoration); its answer threads under om_seed...
    host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    host.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id: agent.followups[0]?.id } })
    host.emit('session/event', { id: agent.id }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: 'seed answer' }] } },
    })
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(20)
    const seededReply = port.sent.find(m => m.input.markdown === 'seed answer')
    expect(seededReply?.options).toEqual({ replyTo: 'om_seed', replyInThread: true })

    // ...which cleared the one-shot binding.replyTo. A HOST-AUTONOMOUS turn
    // now starts without any inbound message and without user/message
    // restoration — its output must still thread under the LAST inbound
    // message instead of landing at the chat root.
    emitAutonomousTurn(host, agent.id, { turn: 2, text: 'background subagent report' })
    await sleep(20)

    const report = port.sent.find(m => String(m.input.markdown ?? '').includes('background subagent report'))
    expect(report).toBeDefined()
    expect(report?.options).toEqual({ replyTo: 'om_seed', replyInThread: true })

    // The persistent anchor survives the autonomous turn/end as well.
    emitAutonomousTurn(host, agent.id, { turn: 3, text: 'second background report' })
    await sleep(20)
    const second = port.sent.find(m => String(m.input.markdown ?? '').includes('second background report'))
    expect(second?.options).toEqual({ replyTo: 'om_seed', replyInThread: true })
  })

  it('R20-b: after /cd the stale session gets no output and no thread anchor from the new conversation', async () => {
    const { host, port } = makeEnv({ workspaceRoots: [tmpdir()] })
    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r20b-'))
    try {
      emitInbound(port, 'om_before', 'task before switch')
      await sleep(20)
      const oldAgent = host.created[0]
      if (oldAgent === undefined) throw new Error('agent missing')
      // Finish the old turn so only the PERSISTENT anchor remains.
      emitAutonomousTurn(host, oldAgent.id, { turn: 1 })
      await sleep(20)

      await textMessage(port, `/cd ${sibling}`)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('已切换工作区'))).toBe(true)
      const sentAfterSwitch = port.sent.length

      // Host-autonomous events from the STALE (pre-/cd) session: the render
      // guard must drop every event — the persistent anchor must never hand
      // the old session a thread inside the new workspace conversation.
      emitAutonomousTurn(host, oldAgent.id, { turn: 2, text: 'stale autonomous report' })
      await sleep(20)

      expect(port.sent.length).toBe(sentAfterSwitch)
      expect(port.sent.slice(sentAfterSwitch).every(m => m.options === undefined)).toBe(true)
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('stale autonomous'))).toBe(false)

      // The NEW workspace's own session keeps working: after its own turn
      // completes (one-shot anchor cleared), an autonomous turn there still
      // anchors under this binding's latest inbound message.
      emitInbound(port, 'om_after', 'task in new workspace')
      await sleep(20)
      const newAgent = host.created[1]
      if (newAgent === undefined) throw new Error('second agent missing')
      emitAutonomousTurn(host, newAgent.id, { turn: 1 })
      await sleep(10)
      emitAutonomousTurn(host, newAgent.id, { turn: 2, text: 'fresh autonomous report' })
      await sleep(20)

      const fresh = port.sent.find(m => String(m.input.markdown ?? '').includes('fresh autonomous report'))
      expect(fresh).toBeDefined()
      expect(fresh?.options).toEqual({ replyTo: 'om_after', replyInThread: true })
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('R20-c: per-topic persistent anchors stay isolated across bindings', async () => {
    const { host, port } = makeEnv({ sessionScope: 'chat-thread' })
    emitInbound(port, 'om_t1', 'topic one seed', { threadId: 'ot_thread1' })
    await sleep(20)
    emitInbound(port, 'om_t2', 'topic two seed', { threadId: 'ot_thread2' })
    await sleep(20)
    expect(host.created).toHaveLength(2)

    const agentOfTopicOne = host.created.find(a =>
      a.followups.some(f => f.content.some(b => b.type === 'text' && b.text === 'topic one seed')),
    )
    if (agentOfTopicOne === undefined) throw new Error('topic-one agent missing')

    // Clear the one-shot anchor of topic one, then let the HOST start a turn
    // on its own: it must use topic ONE's last inbound anchor, never topic
    // two's — each binding holds its own persistent anchor.
    emitAutonomousTurn(host, agentOfTopicOne.id, { turn: 1 })
    await sleep(10)
    emitAutonomousTurn(host, agentOfTopicOne.id, { turn: 2, text: 'topic one background report' })
    await sleep(20)

    const report = port.sent.find(m => String(m.input.markdown ?? '').includes('topic one background report'))
    expect(report).toBeDefined()
    expect(report?.options).toEqual({ replyTo: 'om_t1', replyInThread: true })
    expect(report?.options?.replyTo).not.toBe('om_t2')
  })
})

/* ------------------------------------------------------------------ */
/* R21: reply-stream liveness — ready watchdog, finish convergence     */
/* cap, turn/start stale-stream reclaim, per-binding render queue      */
/* ------------------------------------------------------------------ */

describe('bridge: R21 reply-stream liveness hardening', () => {
  /** How a test hands the (never-arriving-on-its-own) stream controller over. */
  interface ManualStreamOpenSpec {
    /** Per-chunk controller.append delays, indexed by chunk arrival order. */
    delays?: number[]
    /** Chunk values for which controller.append rejects (partial-stream failure). */
    rejectChunks?: string[]
    /** Keep the underlying send promise pending even after the producer ends. */
    holdSettle?: boolean
  }

  interface ManualStreamHandle {
    to: string
    options?: { replyTo?: string; replyInThread?: boolean }
    /** Chunks that actually flowed through the streaming controller. */
    readonly chunks: string[]
    /** Hand the bridge its controller; never calling this models a hung open. */
    open(spec?: ManualStreamOpenSpec): void
    /** Reject the underlying send promise (models a delayed open failure). */
    failOpen(error: unknown): void
  }

  /**
   * A port whose `stream` never opens by itself: the SDK markdown callback is
   * recorded and only runs when a test calls `open()`. This models every
   * timing shape R21 guards against without real 10s/30s waits.
   */
  class ManualStreamPort extends FakePort {
    readonly opened: ManualStreamHandle[] = []

    override async stream(
      to: string,
      input: Record<string, unknown>,
      options?: { replyTo?: string; replyInThread?: boolean },
    ): Promise<{ messageId: string }> {
      return new Promise((resolve, reject) => {
        const producer = input.markdown as ((controller: { append(chunk: string): Promise<void> }) => Promise<void>)
        const handle: ManualStreamHandle = {
          to,
          options,
          chunks: [],
          open(spec?: ManualStreamOpenSpec): void {
            const delays = spec?.delays ?? []
            const rejectChunks = spec?.rejectChunks ?? []
            let index = 0
            void producer({
              append: async (chunk: string): Promise<void> => {
                const delay = delays[index] ?? 0
                index += 1
                if (delay > 0) await sleep(delay)
                if (rejectChunks.includes(chunk)) throw new Error(`controller refuses ${chunk}`)
                handle.chunks.push(chunk)
              },
            }).then(() => {
              // A real SDK send promise settles only after card finalization;
              // holding it back models a hang at the settle stage (R21 §3.2).
              if (spec?.holdSettle !== true) resolve({ messageId: `om_stream_${index}` })
            }, error => reject(error))
          },
          failOpen: error => reject(error),
        }
        this.opened.push(handle)
      })
    }
  }

  function makeR21Env(timing: BridgeTimingOptions) {
    const workspace = mkdtempSync(join(tmpdir(), 'feishu4dsh-r21-'))
    const config = resolveConfig({ appId: 'cli_test', appSecret: 'secret', workspace })
    const port = new ManualStreamPort()
    const host = fakeHost()
    const reportLines: string[] = []
    const dispose = installBridge(
      host,
      config,
      port,
      resolveAuthorization(config),
      line => reportLines.push(line),
      {},
      timing,
    )
    return { workspace, config, port, host, reportLines, dispose }
  }

  function emitInbound(port: ManualStreamPort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  /** Poll until a condition holds; fails loudly instead of hanging forever. */
  async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('R21 condition not met within timeout')
      await sleep(5)
    }
  }

  /**
   * Seed one chat scope deterministically. The inbound message creates the
   * agent + binding and PRE-OPENS its placeholder stream (that is what
   * `handleInboundMessage` does); a first clean bootstrap turn consumes that
   * placeholder — opened by hand here so its producer completes — and clears
   * the one-shot anchor. Every tested round afterwards is HOST-autonomous
   * (R20 style): it anchors via lastInboundReplyTo and starts with NO
   * attached stream, so `port.opened[N]` indices stay predictable.
   */
  async function seedBinding(env: ReturnType<typeof makeR21Env>, messageId: string): Promise<FakeAgent> {
    emitInbound(env.port, messageId, 'seed the scope')
    await sleep(20)
    const agent = env.host.created[0]
    if (agent === undefined) throw new Error('agent missing')
    env.host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
    env.port.opened[0]?.open({})
    env.host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
    await sleep(40)
    return agent
  }

  it('R21-a: a stream whose ready callback never fires is salvaged by the watchdog into one plain message', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 60, replyFinishTimeoutMs: 5000 })
    const { host, port, reportLines, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21a')

      // Host-autonomous round: its own stream only opens at the first delta.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'salvaged answer' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)
      // Parked on the ready gate: nothing delivered yet, nothing lost either.
      expect(port.sent.filter(m => typeof m.input.markdown === 'string')).toHaveLength(0)

      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
      await until(() => port.sent.some(m => m.input.markdown === 'salvaged answer'))

      const salvage = port.sent.find(m => m.input.markdown === 'salvaged answer')
      expect(salvage?.to).toBe('oc_chat1')
      // Degraded delivery keeps the threading contract (R17/R20 anchors).
      expect(salvage?.options).toEqual({ replyTo: 'om_r21a', replyInThread: true })
      expect(reportLines.some(line => line.includes('not ready within'))).toBe(true)
      // Nothing ever flowed through the never-handed-over streaming card.
      expect(port.opened[1]?.chunks).toEqual([])
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R21-b: a late-but-arriving ready callback still streams through controller.append (no regression)', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 3000, replyFinishTimeoutMs: 5000 })
    const { host, port, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21b')

      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'Hello ' } },
      })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'world' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)
      expect(port.opened[1]?.chunks).toEqual([])

      // The SDK's markdown callback arrives late but within the watchdog window.
      port.opened[1]?.open({})
      await until(() => port.opened[1]?.chunks.join('') === 'Hello world')

      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
      await sleep(80)
      // Content went through the stream; no plain-message fallback was sent.
      expect(port.sent.filter(m => typeof m.input.markdown === 'string')).toHaveLength(0)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R21-c: turn/start reclaims a leftover dead stream, logs it, and the new round renders fresh', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 120, replyFinishTimeoutMs: 5000 })
    const { host, port, reportLines, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21c')

      // Round two opens a stream that never becomes ready and never ends.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'orphan draft' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)

      // Round three starts although round two never ended: the payload-bearing
      // leftover must be reclaimed (and salvaged), not written into forever.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 3 } })
      await until(() => reportLines.some(line => line.includes('stale stream reclaimed')))

      // Round three renders through a brand-new stream, not the dead one.
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 3, chunk: { type: 'text-delta', text: 'fresh answer' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(3)
      port.opened[2]?.open({})
      await until(() => port.opened[2]?.chunks.join('') === 'fresh answer')
      expect(port.opened[1]?.chunks).toEqual([])

      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'complete' } } })
      // The orphaned buffer was salvaged by the old stream's bounded finish…
      await until(() => port.sent.some(m => m.input.markdown === 'orphan draft'))
      expect(port.sent.find(m => m.input.markdown === 'orphan draft')?.options)
        .toEqual({ replyTo: 'om_r21c', replyInThread: true })
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R21-d: interleaved events render strictly in arrival order per binding (serialized queue)', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 5000 })
    const { host, port, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21d')

      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'A-slow' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)
      // The first append is slow, the second fast: WITHOUT serialization the
      // fast chunk would overtake the slow one inside the controller.
      port.opened[1]?.open({ delays: [40, 0] })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'B-fast' } },
      })
      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
      await until(() => port.opened[1]?.chunks.join('') === 'A-slowB-fast')
      expect(port.opened[1]?.chunks).toEqual(['A-slow', 'B-fast'])

      // The queue drained cleanly: the next autonomous round flows right after.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 3 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 3, chunk: { type: 'text-delta', text: 'C-last' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(3)
      port.opened[2]?.open({})
      await until(() => port.opened[2]?.chunks.join('') === 'C-last')
      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'complete' } } })
      await sleep(80)
      expect(port.sent.filter(m => typeof m.input.markdown === 'string')).toHaveLength(0)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R21-e: a delayed open rejection still salvages the buffer as one plain message', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 3000, replyFinishTimeoutMs: 5000 })
    const { host, port, reportLines, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21e')

      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'doomed draft' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)

      // The stream request fails only AFTER the open call hung a while — the
      // classic "long silence, then error" shape behind the R21 symptom.
      setTimeout(() => port.opened[1]?.failOpen(new Error('sdk exploded')), 40)
      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })

      await until(() => port.sent.some(m => m.input.markdown === 'doomed draft'))
      expect(port.sent.find(m => m.input.markdown === 'doomed draft')?.options)
        .toEqual({ replyTo: 'om_r21e', replyInThread: true })
      expect(reportLines.some(line => line.includes('stream open failed'))).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R21-f: convergence cap bounds finish when settlement hangs; partial stream is not resent', async () => {
    const env = makeR21Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 100 })
    const { host, port, dispose } = env
    try {
      const agent = await seedBinding(env, 'om_r21f')

      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'part-' } },
      })
      await sleep(10)
      expect(port.opened).toHaveLength(2)
      // The controller works, but the send promise never settles (settle-stage
      // hang) and the 'tail' chunk is refused by the card.
      port.opened[1]?.open({ rejectChunks: ['tail'], holdSettle: true })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'tail' } },
      })
      await until(() => port.opened[1]?.chunks.join('') === 'part-')

      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'complete' } } })
      // Round three can only proceed once turn/end — and its bounded finish —
      // has resolved; a wedged finish would stall the serialized queue here
      // and this poll would hit its own timeout instead.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 3 } })
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 3, chunk: { type: 'text-delta', text: 'post-cap answer' } },
      })
      await until(() => port.opened.length === 3, 1500)
      port.opened[2]?.open({})
      await until(() => port.opened[2]?.chunks.join('') === 'post-cap answer')

      await sleep(250)
      // Partially-streamed turns are NOT duplicated as a full fallback message.
      expect(port.sent.filter(m => typeof m.input.markdown === 'string')).toHaveLength(0)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R22: card-mode timeout convergence + render-queue/reply-target      */
/* memory hygiene                                                      */
/* ------------------------------------------------------------------ */

describe('bridge: R22 card-mode convergence and memory hygiene', () => {
  /**
   * A port whose placeholder `send` and/or `updateCard` round-trips can be
   * held open forever — modeling every hang shape R22 §2.1 guards against
   * without waiting out real 10s/30s windows.
   */
  class HangingCardPort extends FakePort {
    /** When set, placeholder card sends never settle (hung creation). */
    holdPlaceholder = false
    /** When set, updateCard calls never settle (hung re-render). */
    holdUpdate = false
    /** When set, updateCard throws synchronously (defective port). */
    throwUpdate = false
    /** updateCard invocations, counted even while hanging. */
    updateAttempts = 0

    override async send(
      to: string,
      input: Record<string, unknown>,
      options?: { replyTo?: string; replyInThread?: boolean },
    ): Promise<{ messageId: string }> {
      if (this.holdPlaceholder && input.card !== undefined) {
        await new Promise<void>(() => {})
      }
      return super.send(to, input, options)
    }

    override updateCard(messageId: string, card: object): Promise<void> {
      this.updateAttempts += 1
      if (this.throwUpdate) throw new Error('card refused synchronously')
      if (this.holdUpdate) return new Promise<void>(() => {})
      return super.updateCard(messageId, card)
    }
  }

  function makeR22Env(timing: BridgeTimingOptions) {
    const workspace = mkdtempSync(join(tmpdir(), 'feishu4dsh-r22-'))
    const config = resolveConfig({ appId: 'cli_test', appSecret: 'secret', workspace, output: 'card' })
    const port = new HangingCardPort()
    const host = fakeHost()
    const reportLines: string[] = []
    const dispose = installBridge(
      host,
      config,
      port,
      resolveAuthorization(config),
      line => reportLines.push(line),
      {},
      timing,
    )
    return { workspace, config, port, host, reportLines, dispose }
  }

  function emitInbound(port: HangingCardPort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  /** Drive one complete non-streaming turn through session/event. */
  function driveTurn(host: ReturnType<typeof fakeHost>, sessionId: string, turn: number, text: string): void {
    host.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn } })
    host.emit('session/event', { id: sessionId }, {
      type: 'assistant/message',
      data: { turn, message: { content: [{ type: 'text', text }] } },
    })
    host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn, reason: { kind: 'complete' } } })
  }

  /** Poll until a condition holds; fails loudly instead of hanging forever. */
  async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('R22 condition not met within timeout')
      await sleep(5)
    }
  }

  it('R22-a: a placeholder that never settles condemns the card at the ready window; finish delivers exactly one markdown fallback', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 60, replyFinishTimeoutMs: 5000 })
    const { host, port, reportLines, dispose } = env
    try {
      port.holdPlaceholder = true
      emitInbound(port, 'om_r22a', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')

      // The pre-opened placeholder hangs; the turn must still converge.
      driveTurn(host, agent.id, 1, 'salvaged card answer')
      await until(() => port.sent.some(m => m.input.markdown === 'salvaged card answer'))

      // Exactly one delivery, through the markdown fallback path.
      const markdowns = port.sent.filter(m => typeof m.input.markdown === 'string')
      expect(markdowns).toHaveLength(1)
      expect(markdowns[0]?.to).toBe('oc_chat1')
      expect(markdowns[0]?.options).toEqual({ replyTo: 'om_r22a', replyInThread: true })
      // No card id ever existed, so no update could run either.
      expect(port.cardUpdates).toHaveLength(0)
      expect(reportLines.some(line => line.includes('placeholder card not ready within'))).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R22-b: an updateCard that hangs hits the convergence cap and degrades to exactly one markdown send', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 80 })
    const { host, port, reportLines, dispose } = env
    try {
      emitInbound(port, 'om_r22b', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')
      // The placeholder itself arrived fine; only the re-render hangs.
      expect(port.sent.some(m => m.input.card !== undefined)).toBe(true)

      port.holdUpdate = true
      driveTurn(host, agent.id, 1, 'capped card answer')
      await until(() => port.sent.some(m => m.input.markdown === 'capped card answer'))

      // Exactly one degradation send; the hung update was attempted once.
      const markdowns = port.sent.filter(m => typeof m.input.markdown === 'string')
      expect(markdowns).toHaveLength(1)
      expect(markdowns[0]?.options).toEqual({ replyTo: 'om_r22b', replyInThread: true })
      expect(port.updateAttempts).toBe(1)
      expect(reportLines.some(line => line.includes('card update did not settle within'))).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R22-c: /new drains the scope render-queue entry and purges its unconsumed reply anchors', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 5000 })
    const { host, port, dispose } = env
    try {
      emitInbound(port, 'om_r22c', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')
      const state = dispose.state
      // The inbound turn left one unconsumed anchor behind (no user/message
      // restoration yet), and one session event creates the queue tail.
      expect(state.replyTargets.size).toBeGreaterThan(0)
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
      await sleep(20)
      expect(state.renderQueues.size).toBe(1)

      emitInbound(port, 'om_r22c_new', '/new')
      await sleep(30)

      // Both bookkeeping structures for THIS scope are gone again…
      expect(state.renderQueues.size).toBe(0)
      expect(state.replyTargets.size).toBe(0)
      // …while the command still confirmed normally.
      expect(port.sent.some(m => String(m.input.markdown ?? '').includes('新会话'))).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R22-d: dispose empties renderQueues/chats/sessionScopes/replyTargets/streamedTurns', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 5000 })
    const { host, port, dispose } = env
    try {
      emitInbound(port, 'om_r22d', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')
      const state = dispose.state
      // Populate all five collections before teardown.
      host.emit('session/event', { id: agent.id }, {
        type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: 'draft' } },
      })
      await sleep(20)
      expect(state.chats.size).toBeGreaterThan(0)
      expect(state.sessionScopes.size).toBeGreaterThan(0)
      expect(state.replyTargets.size).toBeGreaterThan(0)
      expect(state.streamedTurns.size).toBeGreaterThan(0)
      expect(state.renderQueues.size).toBeGreaterThan(0)

      await dispose()

      expect(state.renderQueues.size).toBe(0)
      expect(state.chats.size).toBe(0)
      expect(state.sessionScopes.size).toBe(0)
      expect(state.replyTargets.size).toBe(0)
      expect(state.streamedTurns.size).toBe(0)
    } finally {
      // Idempotent: a second dispose over empty tables is a no-op.
      await dispose().catch(() => undefined)
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R22-e: turn/end prunes stale reply anchors beyond the backstop cap, oldest first', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 5000 })
    const { host, port, dispose } = env
    try {
      emitInbound(port, 'om_r22e', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')
      const state = dispose.state
      // Stuff the map past the cap with synthetic stale anchors.
      state.replyTargets.set('real_anchor', { scopeKey: 'oc_scope', messageId: 'om_r22e' })
      for (let i = 0; i < REPLY_TARGETS_MAX + 20; i++) {
        state.replyTargets.set(`stale_${i}`, { scopeKey: 'oc_scope', messageId: `om_stale_${i}` })
      }
      // Seed anchor + real_anchor + 120 synthetic = 122 entries.
      expect(state.replyTargets.size).toBe(REPLY_TARGETS_MAX + 22)

      // Any completed turn runs the deterministic sweep.
      host.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
      host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'complete' } } })
      await sleep(30)

      expect(state.replyTargets.size).toBe(REPLY_TARGETS_MAX)
      // The OLDEST surplus entries were dropped, insertion order preserved.
      expect(state.replyTargets.has('real_anchor')).toBe(false)
      expect(state.replyTargets.has('stale_19')).toBe(false)
      expect(state.replyTargets.has('stale_20')).toBe(true)
      expect(state.replyTargets.has(`stale_${REPLY_TARGETS_MAX + 19}`)).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })

  it('R22-f: a synchronously throwing updateCard degrades to exactly one markdown fallback (legacy catch parity)', async () => {
    const env = makeR22Env({ replyReadyTimeoutMs: 5000, replyFinishTimeoutMs: 5000 })
    const { host, port, reportLines, dispose } = env
    try {
      emitInbound(port, 'om_r22f', 'seed the scope')
      await sleep(20)
      const agent = host.created[0]
      if (agent === undefined) throw new Error('agent missing')
      // The placeholder itself arrived fine; only the re-render throws.
      expect(port.sent.some(m => m.input.card !== undefined)).toBe(true)

      port.throwUpdate = true
      driveTurn(host, agent.id, 1, 'sync-throw card answer')
      await until(() => port.sent.some(m => m.input.markdown === 'sync-throw card answer'))

      // Exactly one degradation send — the synchronous throw must not escape
      // finish() and leave the answer undelivered (pre-R22 catch parity).
      const markdowns = port.sent.filter(m => typeof m.input.markdown === 'string')
      expect(markdowns).toHaveLength(1)
      expect(markdowns[0]?.options).toEqual({ replyTo: 'om_r22f', replyInThread: true })
      expect(port.updateAttempts).toBe(1)
      expect(reportLines.some(line => line.includes('card update failed'))).toBe(true)
    } finally {
      await dispose()
      rmSync(env.workspace, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R25: send_file threads under the current topic anchor               */
/* ------------------------------------------------------------------ */

describe('bridge: R25 send_file threads under the current topic anchor', () => {
  interface InboundSpec {
    chatId: string
    chatType: 'p2p' | 'group'
    messageId: string
    threadId?: string
  }

  function emitInbound(port: FakePort, content: string, spec: InboundSpec): void {
    port.emit('message', {
      messageId: spec.messageId,
      chatId: spec.chatId,
      chatType: spec.chatType,
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
      ...(spec.threadId === undefined ? {} : { threadId: spec.threadId }),
    })
  }

  /** Invoke the bridge-registered send_file tool as the given agent. */
  async function sendFileViaTool(
    host: ReturnType<typeof fakeHost>,
    agent: FakeAgent,
    path: string,
  ): Promise<unknown> {
    const tool = host.registeredTools.find(t => t.name === 'send_file')
    if (tool === undefined) throw new Error('send_file tool not registered')
    return tool.execute({ path }, { agent: { session: { id: agent.id } }, signal: undefined })
  }

  function lastFileMessage(port: FakePort): SentMessage | undefined {
    return port.sent.filter(m => 'file' in m.input).at(-1)
  }

  it('R25-a: a file sent in a p2p topic threads under the inbound message', async () => {
    const { workspace, host, port } = makeEnv({ sessionScope: 'chat-thread' })
    writeFileSync(join(workspace, 'a.txt'), 'hello')
    emitInbound(port, 'send me the file', {
      chatId: 'oc_dm1', chatType: 'p2p', messageId: 'm_dm_anchor', threadId: 'om_topic1',
    })
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    expect(await sendFileViaTool(host, agent, 'a.txt')).toEqual({ sent: true })

    // The file used to be the ONLY anchor-less output and fell at the chat
    // root of the DM; it must thread under the topic's inbound message now.
    const fileMessage = lastFileMessage(port)
    expect(fileMessage).toBeDefined()
    expect(fileMessage?.to).toBe('oc_dm1')
    expect(fileMessage?.options).toEqual({ replyTo: 'm_dm_anchor', replyInThread: true })
  })

  it('R25-b: after group approval, the file lands in the same topic as its card', async () => {
    const { workspace, host, port } = makeEnv({ sessionScope: 'chat-thread' })
    writeFileSync(join(workspace, 'a.txt'), 'hello')
    emitInbound(port, 'send the report', {
      chatId: 'oc_chat1', chatType: 'group', messageId: 'm_grp_anchor', threadId: 'om_topic1',
    })
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    const pending = sendFileViaTool(host, agent, 'a.txt')
    await sleep(10)

    const cardMessage = port.sent.find(m => 'card' in m.input)
    expect(cardMessage).toBeDefined()
    expect(cardMessage?.options).toEqual({ replyTo: 'm_grp_anchor', replyInThread: true })

    // Approve through the card's approve button payload, as the chat driver.
    const cardObject = cardMessage?.input.card as {
      elements: { tag: string; actions?: { value: Record<string, unknown> }[] }[]
    }
    const row = cardObject.elements.find(el => el.tag === 'action')
    const approve = row?.actions?.find(b => (b.value as { decision?: string }).decision === 'approve')
    port.emit('cardAction', {
      messageId: cardMessage?.messageId,
      chatId: 'oc_chat1',
      operator: { openId: 'ou_user', name: 'User' },
      action: { value: approve?.value, tag: 'button' },
    })

    expect(await pending).toEqual({ sent: true })
    const fileMessage = lastFileMessage(port)
    expect(fileMessage).toBeDefined()
    // Card and file share ONE anchor: both land inside the asking topic.
    expect(fileMessage?.options).toEqual({ replyTo: 'm_grp_anchor', replyInThread: true })
  })

  it('R25-c: a stale session’s file send degrades to unthreaded delivery', async () => {
    const { workspace, host, port } = makeEnv({ sessionScope: 'chat-thread', workspaceRoots: [tmpdir()] })
    writeFileSync(join(workspace, 'a.txt'), 'hello')
    emitInbound(port, 'task before switch', {
      chatId: 'oc_dm1', chatType: 'p2p', messageId: 'm_old',
    })
    await sleep(20)
    const oldAgent = host.created[0]
    if (oldAgent === undefined) throw new Error('agent missing')

    const sibling = mkdtempSync(join(tmpdir(), 'feishu4dsh-r25c-'))
    try {
      // /cd re-points the binding (same object) at another workspace; give the
      // new cwd the same file so the stale agent's path still resolves.
      writeFileSync(join(sibling, 'a.txt'), 'hello')
      emitInbound(port, `/cd ${sibling}`, {
        chatId: 'oc_dm1', chatType: 'p2p', messageId: 'm_cd_cmd',
      })
      await sleep(20)
      expect(await sendFileViaTool(host, oldAgent, 'a.txt')).toEqual({ sent: true })

      // R17 semantics: a stale session gets NO anchor — root delivery, no
      // crash. (A group stale send parks on its anchor-less approval card by
      // design; the p2p branch shows the degraded delivery immediately.)
      const fileMessage = lastFileMessage(port)
      expect(fileMessage).toBeDefined()
      expect(fileMessage?.options).toBeUndefined()
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ */
/* R26: /status statistics block                                       */
/* ------------------------------------------------------------------ */

describe('bridge: R26 /status statistics block', () => {
  function emitInbound(port: FakePort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  function lastStatusText(port: FakePort): string {
    return port.sent
      .filter(m => typeof m.input.markdown === 'string')
      .map(m => m.input.markdown as string)
      .at(-1) ?? ''
  }

  it('R26-a: shows preset, effort, turns and token totals from the session log', async () => {
    const { host, port } = makeEnv({ sessionScope: 'chat-thread' })
    emitInbound(port, 'm1', 'hello')
    await sleep(20)
    const agent = host.created[0]
    if (agent === undefined) throw new Error('agent missing')

    agent.sessionEvents = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [] }, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 } },
      },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 7 } } } },
      {
        type: 'assistant/message',
        data: { turn: 2, message: { content: [] }, usage: { inputTokens: 8, outputTokens: 2 } },
      },
    ]

    await textMessage(port, '/status')
    const statusText = lastStatusText(port)
    expect(statusText).toContain('会话粒度：按话题（chat-thread）')
    expect(statusText).toContain('模式：standard')
    expect(statusText).toContain('推理强度：default')
    expect(statusText).toContain('轮次：2 · 步：2')
    expect(statusText).toContain('Token 累计：输入 1,020 · 输出 107 · 缓存读 500 · 推理 7')
  })

  it('R26-b: an old host without the session log degrades to “—”', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/status')
    const statusText = lastStatusText(port)
    expect(statusText).toContain('模式：standard')
    expect(statusText).toContain('轮次：— · 步：—')
    expect(statusText).toContain('Token 累计：—')
    // The prospective-session case (no agent at all) degrades the same way.
    expect(statusText).not.toContain('undefined')
  })
})

/* ------------------------------------------------------------------ */
/* R27: /mode — view / set the scope's agent preset                    */
/* ------------------------------------------------------------------ */

describe('bridge: R27 /mode preset command', () => {
  function emitInbound(port: FakePort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  function lastText(port: FakePort): string {
    return port.sent
      .filter(m => typeof m.input.markdown === 'string')
      .map(m => m.input.markdown as string)
      .at(-1) ?? ''
  }

  it('R27-a: /mode minimal persists the override and the next session uses it', async () => {
    const persisted: Record<string, string>[] = []
    const { host, port } = makeEnv({}, {
      onPresetChange: async (_scopeKey, preset) => { persisted.push({ preset }) },
    })
    emitInbound(port, 'm1', 'hello')
    await sleep(20)
    const first = host.created[0]
    expect(first?.preset).toBe('standard')

    await textMessage(port, '/mode minimal')
    expect(lastText(port)).toContain('已切换到 minimal 模式')

    // The replacement session is created lazily on the next message.
    emitInbound(port, 'm2', 'hello again')
    await sleep(20)
    const second = host.created[1]
    expect(second).toBeDefined()
    expect(second?.preset).toBe('minimal')
    // A preset change means a NEW session: generation advanced, id differs.
    expect(second?.id).not.toBe(first?.id)
    expect(persisted.some(p => p.preset === 'minimal')).toBe(true)
  })

  it('R27-b: /mode view shows current, next and deployment default', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/mode')
    const text = lastText(port)
    expect(text).toContain('当前会话模式：standard')
    expect(text).toContain('下次新会话模式：standard')
    expect(text).toContain('部署默认：standard')
  })

  it('R27-c: an unknown preset answers usage; /new semantics stay intact', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/mode turbo')
    expect(lastText(port)).toContain('用法：/mode')

    // /new still resets without touching the preset.
    await textMessage(port, '/new')
    emitInbound(port, 'm2', 'again')
    await sleep(20)
    expect(host.created[1]?.preset).toBe('standard')
  })

  it('R27-d: the approver list gates /mode like /model and /cd', async () => {
    const { host, port } = makeEnv({ approvers: ['ou_admin'] })
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/mode minimal', { senderId: 'ou_user' })
    expect(lastText(port)).toContain('无权切换会话模式')

    await textMessage(port, '/mode minimal', { senderId: 'ou_admin' })
    expect(lastText(port)).toContain('已切换到 minimal 模式')
    emitInbound(port, 'm2', 'again')
    await sleep(20)
    expect(host.created[1]?.preset).toBe('minimal')
  })

  it('R27-e: /status reflects the scope preset after the switch', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/mode minimal')
    emitInbound(port, 'm2', 'hello again')
    await sleep(20)
    await textMessage(port, '/status')
    const statusText = port.sent
      .filter(m => typeof m.input.markdown === 'string')
      .map(m => m.input.markdown as string)
      .at(-1) ?? ''
    expect(statusText).toContain('模式：minimal')
  })
})

/* ------------------------------------------------------------------ */
/* R28: /model effort — per-model reasoning effort                     */
/* ------------------------------------------------------------------ */

describe('bridge: R28 /model effort per-model reasoning effort', () => {
  function emitInbound(port: FakePort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  function texts(port: FakePort): string[] {
    return port.sent
      .filter(m => typeof m.input.markdown === 'string')
      .map(m => m.input.markdown as string)
  }

  it('R28-a: /model effort high sets, persists and displays the model preference', async () => {
    const persisted: Record<string, string>[] = []
    const { host, port } = makeEnv({}, {
      onModelEffortsChange: async efforts => { persisted.push(efforts) },
    })
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p_default', model: 'm_default' }),
    })
    const installed = captureSelections(host)
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/model effort high')
    expect(texts(port).at(-1)).toContain('已将 m_default 的推理强度设为 high')
    expect(persisted.some(p => p['p_default/m_default'] === 'high')).toBe(true)

    // The composed selection carries the effort for the next request.
    expect(installed[0]?.selection.current).toEqual({
      provider: 'p_default', model: 'm_default', reasoningEffort: 'high',
    })

    // /model overview and /status both show the preference with its source.
    await textMessage(port, '/model')
    expect(texts(port).at(-1)).toContain('推理强度：high（模型偏好）')
    await textMessage(port, '/status')
    expect(texts(port).at(-1)).toContain('推理强度：high（模型偏好）')
  })

  it('R28-b: /model effort default clears the override; view shows the source', async () => {
    const persisted: Record<string, string>[] = []
    const { host, port } = makeEnv({}, {
      onModelEffortsChange: async efforts => { persisted.push(efforts) },
    })
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    })
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/model effort low')
    await textMessage(port, '/model effort')
    expect(texts(port).at(-1)).toContain('推理强度：low（模型偏好）')

    await textMessage(port, '/model effort default')
    expect(texts(port).at(-1)).toContain('已恢复 m1 的推理强度为默认')
    expect(persisted.at(-1)).toEqual({})

    await textMessage(port, '/model effort')
    expect(texts(port).at(-1)).toContain('推理强度：default')
  })

  it('R28-c: unknown levels answer usage; unknown model answers guidance', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/model effort turbo')
    expect(texts(port).at(-1)).toContain('用法：/model effort')

    // `medium` is not in the owner enumeration (default/low/high/max) — same usage.
    await textMessage(port, '/model effort medium')
    expect(texts(port).at(-1)).toContain('用法：/model effort')

    // No default model service and no logged header: no model is known.
    await textMessage(port, '/model effort high')
    expect(texts(port).at(-1)).toContain('尚未确定模型')
  })

  it('R28-d: the approver list gates /model effort; switching models follows', async () => {
    const { host, port } = makeEnv({ approvers: ['ou_admin'] })
    host.services.set('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    })
    emitInbound(port, 'm1', 'hello')
    await sleep(20)

    await textMessage(port, '/model effort high', { senderId: 'ou_user' })
    expect(texts(port).at(-1)).toContain('无权切换模型')

    await textMessage(port, '/model effort high', { senderId: 'ou_admin' })
    expect(texts(port).at(-1)).toContain('已将 m1 的推理强度设为 high')

    // Switching to another model: the preference of THAT model applies
    // (empty here), so the effort falls back to default, not to m1's high.
    // (The switch itself is approver-gated too — send it as ou_admin.)
    await textMessage(port, '/model p2/m2', { senderId: 'ou_admin' })
    await textMessage(port, '/model effort')
    expect(texts(port).at(-1)).toContain('推理强度：default')
  })
})

/* ------------------------------------------------------------------ */
/* R29: /session — list / switch / rename / archive                    */
/* ------------------------------------------------------------------ */

describe('bridge: R29 /session registry, switch, rename, archive', () => {
  function emitInbound(port: FakePort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  function texts(port: FakePort): string[] {
    return port.sent
      .filter(m => typeof m.input.markdown === 'string')
      .map(m => m.input.markdown as string)
  }

  function lastText(port: FakePort): string {
    return texts(port).at(-1) ?? ''
  }

  function mountArchiveService(host: ReturnType<typeof fakeHost>): { archived: Set<string>; archivedCalls: string[] } {
    const archived = new Set<string>()
    const archivedCalls: string[] = []
    host.services.set('workspaceRegistry', {
      resolveByPath: async () => undefined,
      create: async () => undefined,
      archivedSessionIds: () => [...archived],
      archiveSession: async (sessionId: string) => {
        archived.add(sessionId)
        archivedCalls.push(sessionId)
      },
    })
    return { archived, archivedCalls }
  }

  it('R29-a: sessions register with auto titles; /new keeps the old one listed', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', '修复登录页的会话跳转问题')
    await sleep(20)
    await textMessage(port, '/new')
    emitInbound(port, 'm2', '第二个会话')
    await sleep(20)

    await textMessage(port, '/session')
    const list = lastText(port)
    expect(list).toContain('会话列表')
    expect(list).toContain('0828 修复登录页的会话跳转问题')
    expect(list).toContain('0828 第二个会话')
    // The CURRENT session carries the cursor.
    const currentLine = list.split('\n').find(l => l.startsWith('●'))
    expect(currentLine).toContain('0828 第二个会话')
  })

  it('R29-b: /session <n> stops the task, re-points, and the next message resumes the old session', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', '第一个会话')
    await sleep(20)
    const firstSessionId = host.created[0]?.id
    expect(firstSessionId).toBe('feishu-' + firstSessionId!.slice('feishu-'.length))

    await textMessage(port, '/new')
    emitInbound(port, 'm2', '第二个会话')
    await sleep(20)
    const secondAgent = host.created[1]
    expect(secondAgent?.id).not.toBe(firstSessionId)

    // /session numbering: gen desc, current first.
    await textMessage(port, '/session')
    expect(lastText(port)).toMatch(/● 1 · 0828 第二个会话/)

    await textMessage(port, '/session 2')
    expect(lastText(port)).toContain('已停止当前任务，并切换到「0828 第一个会话」')
    // D1: the superseded agent was cancelled with the switch cause.
    expect(secondAgent?.cancels).toContain('session switch')

    emitInbound(port, 'm3', '回到旧会话')
    await sleep(20)
    expect(host.created[2]?.id).toBe(firstSessionId)
  })

  it('R29-c: /session rename wins over the auto title and /status shows it', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', '原始自动标题')
    await sleep(20)

    await textMessage(port, '/session rename 需求讨论')
    expect(lastText(port)).toContain('当前会话已重命名为「需求讨论」')

    await textMessage(port, '/status')
    expect(lastText(port)).toContain('会话：需求讨论 (')

    // Hints no longer upgrade a user title.
    emitInbound(port, 'm2', 'hint should not rename')
    await sleep(20)
    await textMessage(port, '/session')
    expect(lastText(port)).toContain('需求讨论')
  })

  it('R29-d: /session archive by number and by age share the host archive set', async () => {
    const { dispose, host, port } = makeEnv()
    const { archived, archivedCalls } = mountArchiveService(host)
    emitInbound(port, 'm1', '旧会话')
    await sleep(20)
    const firstSessionId = host.created[0]?.id
    await textMessage(port, '/new')
    emitInbound(port, 'm2', '新会话')
    await sleep(20)

    // Backdate the FIRST session so `archive old` (2 days) selects it.
    const state = dispose.state
    for (const records of Object.values(state.chatSessions)) {
      for (const record of records) {
        if (record.sessionId === firstSessionId) record.lastActiveAt = Date.now() - 3 * 86_400_000
      }
    }

    await textMessage(port, '/session archive old')
    expect(lastText(port)).toContain('已归档 1 个陈旧会话')
    expect(archivedCalls).toEqual([firstSessionId])
    expect(archived.has(firstSessionId!)).toBe(true)

    // The default list hides it; `all` shows it with the tag.
    await textMessage(port, '/session')
    expect(lastText(port)).not.toContain('旧会话')
    await textMessage(port, '/session all')
    expect(lastText(port)).toContain('[已归档]')

    // Re-archiving a listed-but-already-archived session reports no-op.
    await textMessage(port, '/session all')
    const allText = lastText(port)
    expect(allText).toContain('2 · ')
    await textMessage(port, '/session archive 2')
    expect(lastText(port)).toContain('已在归档中')

    // Archived sessions remain switchable (no unarchive upstream yet).
    await textMessage(port, '/session all')
    await textMessage(port, '/session 2')
    expect(lastText(port)).toContain('已停止当前任务，并切换到「0828 旧会话」')
  })

  it('R29-e: the approver list gates switch / rename / archive', async () => {
    const { host, port } = makeEnv({ approvers: ['ou_admin'] })
    mountArchiveService(host)
    emitInbound(port, 'm1', '会话一')
    await sleep(20)

    await textMessage(port, '/session rename X', { senderId: 'ou_user' })
    expect(lastText(port)).toContain('无权切换/重命名/归档会话')

    await textMessage(port, '/session archive 1', { senderId: 'ou_user' })
    expect(lastText(port)).toContain('无权切换/重命名/归档会话')

    await textMessage(port, '/session rename 正题', { senderId: 'ou_admin' })
    expect(lastText(port)).toContain('当前会话已重命名为「正题」')
  })

  it('R29-f: without the host archive API the command degrades gracefully', async () => {
    const { host, port } = makeEnv()
    emitInbound(port, 'm1', '会话一')
    await sleep(20)

    await textMessage(port, '/session archive 1')
    expect(lastText(port)).toContain('当前部署不支持会话归档')
  })

  it('R29-g: the active-generation pointer survives a restart (persistence)', async () => {
    const captured: { sessions: unknown; activeGen: unknown }[] = []
    const first = makeEnv({}, {
      onSessionsChange: async payload => { captured.push(payload) },
    })
    emitInbound(first.port, 'm1', '第一个会话')
    await sleep(20)
    const originalSessionId = first.host.created[0]?.id
    await textMessage(first.port, '/new')
    emitInbound(first.port, 'm2', '第二个会话')
    await sleep(20)
    const newSessionId = first.host.created[1]?.id
    await first.dispose()
    expect(captured.length).toBeGreaterThan(0)

    // A fresh bridge (the post-restart world) seeded from the persisted
    // payload must resume the session the chat was actually ON (gen 1).
    const config = { ...first.config, chatSessions: captured.at(-1)!.sessions, chatActiveGen: captured.at(-1)!.activeGen }
    const secondPort = new FakePort()
    const secondHost = fakeHost()
    installBridge(secondHost, config, secondPort, resolveAuthorization(config), () => undefined)
    emitInboundFor(secondPort, 'm3', '重启后继续')
    await sleep(20)
    expect(secondHost.created[0]?.id).toBe(newSessionId)
    expect(secondHost.created[0]?.id).not.toBe(originalSessionId)
  })

  function emitInboundFor(port: FakePort, messageId: string, content: string): void {
    port.emit('message', {
      messageId,
      chatId: 'oc_chat1',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'User',
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    })
  }

  it('R29-i: sessions are attached to their workspace for dsh web grouping', async () => {
    const attached: string[] = []
    const { host, port, workspace } = makeEnv()
    host.services.set('workspaceRegistry', {
      resolveByPath: async () => ({
        id: 'w1',
        path: workspace,
        attachSession: async (sessionId: string) => { attached.push(sessionId) },
      }),
      create: async () => undefined,
    })
    emitInbound(port, 'm1', '需要分组')
    await sleep(20)

    // Without attachSession accounting, dsh web shows channel sessions as
    // ungrouped; the channel now attaches every created/resumed session.
    expect(attached).toEqual([host.created[0]?.id])
  })

  it('R29-j: archiving refuses sessions not created on the Feishu side', async () => {
    const { dispose, host, port } = makeEnv()
    mountArchiveService(host)
    emitInbound(port, 'm1', '会话一')
    await sleep(20)

    // A dsh-web-created session must never be archivable from the channel.
    const state = dispose.state
    for (const records of Object.values(state.chatSessions)) {
      records.push({
        gen: 9,
        sessionId: 'session-web-created-1',
        title: '0828 web 会话',
        titleIsAuto: true,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
    }

    await textMessage(port, '/session all')
    const allLine = lastText(port).split('\n').find(l => l.includes('web 会话'))
    expect(allLine).toBeDefined()

    const numberOfWebSession = lastText(port).split('\n').find(l => l.includes('web 会话'))?.trim().split(' ')[0]
    await textMessage(port, `/session archive ${numberOfWebSession}`)
    expect(lastText(port)).toContain('仅可归档飞书端创建的会话')
  })

  it('R29-h: unknown list numbers and bare archive answer usage', async () => {
    const { host, port } = makeEnv()
    mountArchiveService(host)
    emitInbound(port, 'm1', '会话一')
    await sleep(20)

    await textMessage(port, '/session 9')
    expect(lastText(port)).toContain('列表中没有第 9 个会话')

    await textMessage(port, '/session archive')
    expect(lastText(port)).toContain('用法：/session archive')

    await textMessage(port, '/session 0')
    expect(lastText(port)).toContain('用法：/session')
  })
})
