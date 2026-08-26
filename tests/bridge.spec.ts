import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BridgeHost, BridgeHooks } from '../src/bridge.js'
import { installBridge } from '../src/bridge.js'
import { resolveConfig } from '../src/config.js'
import type { ResolvedConfig } from '../src/config.js'
import { resolveAuthorization } from '../src/acl.js'
import type { ChannelPort } from '../src/adapter.js'
import type { HostAgent, HostAgentOptions, HostRequestHeaderConfig, HostSession, HostUserMessage } from '../src/host.js'
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
  /**
   * When set, the fake session advertises `requestHeader()` (R7); leaving it
   * undefined models an older host whose sessions have no such capability.
   */
  headerReader?: () => { config?: HostRequestHeaderConfig } | undefined
  constructor(readonly id: string) {}
  get session(): HostSession {
    return this.headerReader === undefined
      ? { id: this.id }
      : { id: this.id, requestHeader: this.headerReader }
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
  async downloadResource(fileKey: string): Promise<Buffer> {
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
  const host: BridgeHost & {
    created: FakeAgent[]
    emit(name: string, ...args: unknown[]): unknown[]
    services: Map<string, unknown>
  } = {
    created,
    services,
    agents: {
      async resume(): Promise<never> { throw new Error('nothing to resume in tests') },
      async create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: HostAgentOptions; setup?: (ctx: { get(): undefined }) => Promise<void> }) {
        if (options.setup !== undefined) await options.setup({ get: () => undefined, on: () => () => undefined })
        const agent = new FakeAgent(options.sessionId)
        agent.cwd = options.meta?.cwd
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
