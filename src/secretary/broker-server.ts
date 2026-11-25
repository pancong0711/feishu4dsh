/**
 * Local Unix-socket HTTP server for the sandbox broker. It deliberately does
 * not listen on TCP: the broker is a host-local, security-sensitive service
 * with a narrow API, not a generic Docker proxy. The socket is chmod 0600.
 * @module feishu4dsh/secretary/broker-server
 */

import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { BrokerError, type BrokerMessageArtifact, type BrokerSendMessageInput, type SandboxBrokerService } from './broker.js'

const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024

type Json = Record<string, unknown>

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

async function readJson(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Json> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) throw new BrokerError('too_large', 'request body too large')
    chunks.push(buf)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BrokerError('invalid_request', 'request body must be a JSON object')
    }
    return parsed as Json
  } catch (error) {
    throw error instanceof BrokerError ? error : new BrokerError('invalid_request', 'invalid JSON body')
  }
}

function seedArtifacts(value: unknown): BrokerMessageArtifact[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BrokerError('invalid_request', 'artifacts must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new BrokerError('invalid_request', `artifact ${index} is not an object`)
    const item = entry as Record<string, unknown>
    if (typeof item.path !== 'string') throw new BrokerError('invalid_request', `artifact ${index} needs path`)
    return {
      path: item.path,
      ...(typeof item.fromOutbox === 'string' ? { fromOutbox: item.fromOutbox } : {}),
      ...(typeof item.text === 'string' ? { text: item.text } : {}),
      ...(typeof item.base64 === 'string' ? { base64: item.base64 } : {}),
    }
  })
}

/** Build and start the broker's Unix-socket HTTP server. */
export async function listenBroker(
  service: SandboxBrokerService,
  socketPath: string,
): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  await unlink(socketPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://broker.local')
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (method === 'GET' && url.pathname === '/v1/health') {
        return sendJson(res, 200, { ok: true, schema: 1 })
      }
      if (method === 'POST' && url.pathname === '/v1/main') {
        const body = await readJson(req)
        const actorId = typeof body.actorId === 'string' ? body.actorId : service.mainId
        return sendJson(res, 200, { actor: await service.setMainActor(actorId) })
      }
      if (method === 'GET' && url.pathname === '/v1/next-name') {
        const suffix = url.searchParams.get('suffix') ?? undefined
        return sendJson(res, 200, { name: await service.nextName(suffix) })
      }
      if (method === 'GET' && url.pathname === '/v1/sandboxes') {
        return sendJson(res, 200, { sandboxes: await service.list() })
      }
      if (method === 'POST' && url.pathname === '/v1/sandboxes/register') {
        const body = await readJson(req)
        if (typeof body.descriptor !== 'string') throw new BrokerError('invalid_request', 'descriptor path is required')
        return sendJson(res, 201, { sandbox: await service.registerDescriptor(body.descriptor) })
      }
      if (parts[0] === 'v1' && parts[1] === 'sandboxes' && parts[2] !== undefined) {
        const name = parts[2]
        if (parts.length === 3 && method === 'GET') {
          const info = await service.info(name)
          return info === undefined ? sendJson(res, 404, { error: 'not_found' }) : sendJson(res, 200, { sandbox: info })
        }
        if (parts.length === 4 && parts[3] === 'stats' && method === 'GET') {
          return sendJson(res, 200, { stats: await service.stats(name) })
        }
        if (parts.length === 4 && method === 'POST') {
          if (parts[3] === 'start') { await service.start(name); return sendJson(res, 200, { ok: true }) }
          if (parts[3] === 'stop') { await service.stop(name); return sendJson(res, 200, { ok: true }) }
          if (parts[3] === 'restart') { await service.restart(name); return sendJson(res, 200, { ok: true }) }
        }
        if (parts.length === 4 && parts[3] === 'messages' && method === 'POST') {
          const body = await readJson(req)
          const input: BrokerSendMessageInput = {
            from: typeof body.from === 'string' ? body.from : '',
            to: name,
            rootTaskId: typeof body.rootTaskId === 'string' ? body.rootTaskId : '',
            ...(typeof body.parentTaskId === 'string' ? { parentTaskId: body.parentTaskId } : {}),
            ...(typeof body.messageId === 'string' ? { messageId: body.messageId } : {}),
            ...(typeof body.ttlSeconds === 'number' ? { ttlSeconds: body.ttlSeconds } : {}),
            artifacts: seedArtifacts(body.artifacts),
          }
          return sendJson(res, 201, { message: await service.sendMessage(input) })
        }
        if (parts.length === 3 && method === 'DELETE') {
          await service.destroy(name)
          return sendJson(res, 200, { ok: true, dataRetained: true })
        }
      }
      return sendJson(res, 404, { error: 'not_found' })
    })().catch(error => {
      const status = error instanceof BrokerError
        ? error.code === 'not_found' ? 404
          : error.code === 'forbidden' ? 403
            : error.code === 'conflict' || error.code === 'message_exists' ? 409
              : error.code === 'too_large' ? 413
                : 400
        : 500
      sendJson(res, status, { error: error instanceof BrokerError ? error.code : 'internal', message: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  await chmod(socketPath, 0o600)
  return server
}
