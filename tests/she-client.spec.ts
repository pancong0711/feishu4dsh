import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SheClient } from '@she/client'
import {
  CHANNEL_CAPABILITIES_V1,
  GATEWAY_PROTOCOL_VERSION,
  makeCapabilitySet,
  type GatewayHealth,
  type GatewayWelcome,
} from '@she/protocol'
import {
  probeSheClient,
  probeSheIntegration,
  type SheProbeClient,
} from '../src/integrations/she/index.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function health(): GatewayHealth {
  return {
    status: 'ok',
    service: 'she-control-plane',
    version: '0.1.0',
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    capabilities: makeCapabilitySet(CHANNEL_CAPABILITIES_V1),
    checkedAt: 1_700_000_000_000,
  }
}

function welcome(): GatewayWelcome {
  return {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    capabilities: makeCapabilitySet(CHANNEL_CAPABILITIES_V1),
  }
}

async function startSocketServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ socketPath: string; server: Server }> {
  const dir = await mkdtemp(join(tmpdir(), 'she-client-'))
  cleanup.push(dir)
  const socketPath = join(dir, 'control.sock')
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => handler(request, response, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return { socketPath, server }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

describe('SHE probe client', () => {
  it('performs health and hello against the real public client', async () => {
    const { socketPath, server } = await startSocketServer((request, response) => {
      if (request.method === 'GET' && request.url === '/v1/health') return json(response, 200, health())
      if (request.method === 'POST' && request.url === '/v1/hello') return json(response, 200, welcome())
      json(response, 404, { ok: false, error: { code: 'not_found', message: 'missing', retryable: false } })
    })
    const client = new SheClient({ socketPath })
    const result = await probeSheClient(client, { requiredCapabilities: ['text.outbound', 'card.outbound'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.missing).toEqual([])
    await client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('separates protocol mismatch and missing capabilities from transport errors', async () => {
    const mismatched: SheProbeClient = {
      health: async () => health(),
      hello: async () => ({ ...welcome(), protocolVersion: 'gateway.v2' as typeof GATEWAY_PROTOCOL_VERSION }),
    }
    await expect(probeSheClient(mismatched)).resolves.toMatchObject({
      ok: false,
      code: 'protocol_mismatch',
    })

    const textOnly: SheProbeClient = {
      health: async () => health(),
      hello: async () => ({ ...welcome(), capabilities: makeCapabilitySet(['text.outbound']) }),
    }
    const result = await probeSheClient(textOnly, { requiredCapabilities: ['card.outbound'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.missing).toEqual(['card.outbound'])

    const unavailable = await probeSheIntegration({
      enabled: true,
      socketPath: join(tmpdir(), 'definitely-missing-she-control.sock'),
      tokenFile: join(tmpdir(), 'definitely-missing-she-token'),
    })
    expect(unavailable).toMatchObject({ ok: false, code: 'transport_error', retryable: true })
  })

  it('returns disabled without attempting a connection', async () => {
    await expect(probeSheIntegration()).resolves.toMatchObject({ ok: false, code: 'disabled' })
  })
})
