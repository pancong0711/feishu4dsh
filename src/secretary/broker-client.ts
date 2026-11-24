/**
 * Tiny client for the local Unix-socket broker. The client intentionally has
 * no generic Docker surface: it can only call broker endpoints.
 * @module feishu4dsh/secretary/broker-client
 */

import { request } from 'node:http'

export interface BrokerClientOptions {
  readonly socketPath: string
  readonly timeoutMs?: number
}

export async function brokerRequest(
  options: BrokerClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: options.socketPath,
      path,
      method,
      headers: payload === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: options.timeoutMs ?? 15_000,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = text === '' ? {} : JSON.parse(text) as unknown
        if ((response.statusCode ?? 500) >= 400) {
          const detail = typeof parsed === 'object' && parsed !== null && 'message' in parsed
            ? String((parsed as { message?: unknown }).message ?? text)
            : text
          reject(new Error(`broker ${response.statusCode}: ${detail}`))
          return
        }
        resolve(parsed)
      })
    })
    req.on('timeout', () => req.destroy(new Error('broker request timed out')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

export class SandboxBrokerClient {
  constructor(private readonly options: BrokerClientOptions) {}

  health(): Promise<unknown> { return brokerRequest(this.options, 'GET', '/v1/health') }
  registerMain(actorId?: string): Promise<unknown> { return brokerRequest(this.options, 'POST', '/v1/main', actorId === undefined ? {} : { actorId }) }
  nextName(suffix?: string): Promise<unknown> {
    const query = suffix === undefined ? '' : `?suffix=${encodeURIComponent(suffix)}`
    return brokerRequest(this.options, 'GET', `/v1/next-name${query}`)
  }
  list(): Promise<unknown> { return brokerRequest(this.options, 'GET', '/v1/sandboxes') }
  info(name: string): Promise<unknown> { return brokerRequest(this.options, 'GET', `/v1/sandboxes/${encodeURIComponent(name)}`) }
  stats(name: string): Promise<unknown> { return brokerRequest(this.options, 'GET', `/v1/sandboxes/${encodeURIComponent(name)}/stats`) }
  register(descriptor: string): Promise<unknown> { return brokerRequest(this.options, 'POST', '/v1/sandboxes/register', { descriptor }) }
  start(name: string): Promise<unknown> { return brokerRequest(this.options, 'POST', `/v1/sandboxes/${encodeURIComponent(name)}/start`) }
  stop(name: string): Promise<unknown> { return brokerRequest(this.options, 'POST', `/v1/sandboxes/${encodeURIComponent(name)}/stop`) }
  restart(name: string): Promise<unknown> { return brokerRequest(this.options, 'POST', `/v1/sandboxes/${encodeURIComponent(name)}/restart`) }
  destroy(name: string): Promise<unknown> { return brokerRequest(this.options, 'DELETE', `/v1/sandboxes/${encodeURIComponent(name)}`) }
  sendMessage(name: string, body: unknown): Promise<unknown> { return brokerRequest(this.options, 'POST', `/v1/sandboxes/${encodeURIComponent(name)}/messages`, body) }
}
