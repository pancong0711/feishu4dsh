/**
 * OpenCode HttpApi adapter (experimental surface, pinned at the schema level).
 *
 * Auth is HTTP Basic (`opencode:<password>`), matching the local daemon's
 * `service.json`. The adapter never logs request bodies, credentials, or
 * prompt text.
 * @module feishu4dsh/secretary/opencode
 */

import type {
  ExecutorAdapter,
  ExecutorSessionContext,
  ExecutorStatus,
  ExecutorSubmitInput,
} from './types.js'

export interface OpenCodeAdapterOptions {
  readonly baseUrl: string
  readonly username: string
  readonly credential: string
  readonly timeoutMs?: number
}

interface ApiEnvelope<T> {
  readonly data: T
}

interface SessionInfo {
  readonly id: string
  readonly outcome?: 'succeeded' | 'failed' | 'interrupted'
  readonly time?: { readonly busy?: number; readonly idle?: number }
  readonly title?: string
}

interface ActiveSessions {
  readonly [sessionId: string]: { readonly type?: string }
}

interface MessageInfo {
  readonly type?: string
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

function basicAuth(username: string, credential: string): string {
  return `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`
}

/** Error carrying the HTTP status and API error tag, never the credentials. */
export class OpenCodeError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'unreachable' | 'not_found' | 'http_error' | 'invalid_response',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OpenCodeError'
  }
}

/** Minimal typed client for the selected HttpApi routes. */
export class OpenCodeClient {
  private readonly baseUrl: string
  private readonly auth: string
  private readonly timeoutMs: number

  constructor(options: OpenCodeAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.auth = basicAuth(options.username, options.credential)
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.auth,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new OpenCodeError(
        'unreachable',
        `OpenCode service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status === 401) throw new OpenCodeError('unauthorized', 'OpenCode authentication failed', 401)
    if (response.status === 404) throw new OpenCodeError('not_found', 'OpenCode session not found', 404)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OpenCodeError('http_error', `OpenCode HTTP ${response.status}: ${text.slice(0, 300)}`, response.status)
    }
    if (response.status === 204) return undefined as T
    try {
      return await response.json() as T
    } catch {
      throw new OpenCodeError('invalid_response', 'OpenCode returned a non-JSON response', response.status)
    }
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const response = await this.request<ApiEnvelope<SessionInfo>>('GET', `/api/session/${encodeURIComponent(sessionId)}`)
    if (response.data === undefined || typeof response.data.id !== 'string') {
      throw new OpenCodeError('invalid_response', 'OpenCode session response has no id')
    }
    return response.data
  }

  async getActiveSessions(): Promise<ActiveSessions> {
    const response = await this.request<ApiEnvelope<ActiveSessions>>('GET', '/api/session/active')
    return response.data ?? {}
  }

  async createSession(context: ExecutorSessionContext): Promise<string> {
    const response = await this.request<ApiEnvelope<SessionInfo>>('POST', '/api/session', {
      title: context.title,
      model: context.model,
      location: { directory: context.directory },
      permissions: context.permissionRules,
    })
    if (response.data === undefined || typeof response.data.id !== 'string') {
      throw new OpenCodeError('invalid_response', 'OpenCode create-session response has no id')
    }
    return response.data.id
  }

  async prompt(sessionId: string, input: ExecutorSubmitInput): Promise<string> {
    const response = await this.request<ApiEnvelope<{ id?: string }>>(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text: input.text, delivery: 'queue' },
    )
    if (response.data === undefined || typeof response.data.id !== 'string') {
      throw new OpenCodeError('invalid_response', 'OpenCode prompt response has no message id')
    }
    return response.data.id
  }

  async messages(sessionId: string): Promise<MessageInfo[]> {
    const response = await this.request<{ data?: MessageInfo[] }>(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=20&order=desc`,
    )
    return Array.isArray(response.data) ? response.data : []
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request<{ interrupted?: boolean }>(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
    )
  }
}

/** ExecutorAdapter implementation over {@link OpenCodeClient}. */
export class OpenCodeExecutor implements ExecutorAdapter {
  constructor(private readonly client: OpenCodeClient) {}

  async createOrResumeSession(context: ExecutorSessionContext): Promise<{ sessionId: string }> {
    if (context.existingSessionId !== undefined && context.existingSessionId !== '') {
      try {
        await this.client.getSession(context.existingSessionId)
        return { sessionId: context.existingSessionId }
      } catch (error) {
        if (!(error instanceof OpenCodeError) || error.code !== 'not_found') throw error
      }
    }
    return { sessionId: await this.client.createSession(context) }
  }

  async submit(input: ExecutorSubmitInput): Promise<{ messageId: string }> {
    return { messageId: await this.client.prompt(input.sessionId, input) }
  }

  async status(sessionId: string): Promise<ExecutorStatus> {
    const [session, active] = await Promise.all([
      this.client.getSession(sessionId),
      this.client.getActiveSessions().catch(() => ({} as ActiveSessions)),
    ])
    const running = active[sessionId]?.type === 'running'
    if (running) return { state: 'running', outcome: session.outcome }

    const messages = await this.client.messages(sessionId).catch(() => [])
    const lastAssistantText = lastAssistantTextOf(messages)
    switch (session.outcome) {
      case 'succeeded':
        return { state: 'succeeded', outcome: 'succeeded', lastAssistantText }
      case 'failed':
        return { state: 'failed', outcome: 'failed', detail: lastAssistantText, lastAssistantText }
      case 'interrupted':
        return { state: 'interrupted', outcome: 'interrupted', detail: lastAssistantText, lastAssistantText }
      default:
        // No terminal outcome yet and the active map did not mark it running:
        // conservatively keep waiting rather than declaring a false success.
        return { state: 'running', lastAssistantText }
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.interrupt(sessionId)
  }
}

function lastAssistantTextOf(messages: readonly MessageInfo[]): string | undefined {
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text ?? '')
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}
