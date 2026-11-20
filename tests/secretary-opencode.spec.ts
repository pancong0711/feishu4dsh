import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { OpenCodeClient, OpenCodeExecutor } from '../src/secretary/opencode.js'
import type { ExecutorSessionContext } from '../src/secretary/types.js'

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

describe('OpenCode adapter', () => {
  it('uses Basic auth and the verified HttpApi request/response shapes', async () => {
    const seen: { method?: string; url?: string; auth?: string; body?: unknown }[] = []
    const server = createServer(async (req, res) => {
      const body = req.method === 'POST' ? await readJson(req) : undefined
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/session/active') {
        res.end(JSON.stringify({ data: {} }))
        return
      }
      if (req.url === '/api/session' && req.method === 'POST') {
        res.end(JSON.stringify({ data: { id: 'ses_test' } }))
        return
      }
      if (req.url === '/api/session/ses_test/prompt') {
        res.end(JSON.stringify({ data: { id: 'msg_test' } }))
        return
      }
      if (req.url === '/api/session/ses_test/message?limit=20&order=desc') {
        res.end(JSON.stringify({ data: [{ type: 'assistant', content: [{ type: 'text', text: 'done' }] }] }))
        return
      }
      if (req.url === '/api/session/ses_test') {
        res.end(JSON.stringify({ data: { id: 'ses_test', outcome: 'succeeded', time: { busy: 0, idle: 10 } } }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no test address')
    try {
      const client = new OpenCodeClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        username: 'opencode',
        credential: 'unit-test',
      })
      const executor = new OpenCodeExecutor(client)
      const context: ExecutorSessionContext = {
        topicId: 't1',
        directory: '/tmp/worktree',
        title: 'SHE 1 test',
        model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
        permissionRules: [{ action: 'external_directory', resource: '*', effect: 'deny' }],
      }
      expect(await executor.createOrResumeSession(context)).toEqual({ sessionId: 'ses_test' })
      expect(await executor.submit({ sessionId: 'ses_test', text: 'hello' })).toEqual({ messageId: 'msg_test' })
      expect(await executor.status('ses_test')).toMatchObject({ state: 'succeeded', lastAssistantText: 'done' })

      const create = seen.find(item => item.url === '/api/session' && item.method === 'POST')
      expect(create?.auth).toBe(`Basic ${Buffer.from('opencode:unit-test').toString('base64')}`)
      expect(create?.body).toMatchObject({
        title: 'SHE 1 test',
        model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
        location: { directory: '/tmp/worktree' },
      })
      const prompt = seen.find(item => item.url === '/api/session/ses_test/prompt')
      expect(prompt?.body).toEqual({ text: 'hello', delivery: 'queue' })
    } finally {
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })

  it('maps an unauthenticated daemon to a stable error', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401
      res.end(JSON.stringify({ _tag: 'UnauthorizedError', message: 'Authentication required' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no test address')
    try {
      const client = new OpenCodeClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        username: 'opencode',
        credential: 'wrong',
      })
      await expect(client.getSession('ses_missing')).rejects.toMatchObject({ code: 'unauthorized' })
    } finally {
      server.close()
      await once(server, 'close').catch(() => undefined)
    }
  })
})
