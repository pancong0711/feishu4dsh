import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { resolveConfig } from '../src/config.js'
import { channelOptions, createFeishuPort } from '../src/adapter.js'
import type { Authorization } from '../src/acl.js'

/** Minimal authorization value; channelOptions only reads the two sets. */
function fakeAuthorization(): Authorization {
  return { directSenders: new Set<string>(), groups: new Set<string>(), approvers: new Set<string>() }
}

describe('channelOptions safety pipeline', () => {
  it('keeps the per-chat serial queue enabled', () => {
    const options = channelOptions(resolveConfig({ appId: 'cli_a', appSecret: 's' }), fakeAuthorization())
    expect(options.safety?.chatQueue?.enabled).toBe(true)
  })

  // Regression: a topic (thread) message arriving within the SDK's default
  // 600 ms text-batch window of a non-topic message was merged into one
  // representative keeping the LAST message's identity — thread_id lost, so
  // the answer was scoped and replied to the private-chat root instead of
  // the topic. The batching window must stay closed.
  it('closes the inbound text-batching window to preserve per-message attribution', () => {
    const options = channelOptions(resolveConfig({ appId: 'cli_a', appSecret: 's' }), fakeAuthorization())
    expect(options.safety?.batch?.text?.delayMs).toBe(0)
  })
})

// R24 regression: user-uploaded resources 400 on the legacy bot-scoped
// endpoints (`234008 not resource sender`). The port must call the
// message-scoped API with (message_id, file_key, type) first and only fall
// back to `channel.downloadResource` when that call fails (bot-self uploads,
// card payloads, …). The channel created by `createFeishuPort` never
// connects here; its raw client methods are stubbed, so the test is offline.
describe('createFeishuPort.downloadResource (R24 message-scoped fetch)', () => {
  it('downloads via messageResource.get with (message_id, file_key, type) and falls back to the legacy API on 400', async () => {
    const port = createFeishuPort(
      resolveConfig({ appId: 'cli_a', appSecret: 's' }),
      fakeAuthorization(),
      () => undefined,
    )
    const resourceApi = port.channel.rawClient.im.v1.messageResource
    const resourceSpy = vi.spyOn(resourceApi, 'get')
    const fallbackSpy = vi.spyOn(port.channel, 'downloadResource')
      .mockResolvedValue(Buffer.from('fallback-bytes'))

    // First call (400 on the message-scoped endpoint) → legacy fallback wins.
    const http400 = new Error('Request failed with status code 400')
    Object.assign(http400, { response: { status: 400 } })
    resourceSpy
      .mockRejectedValueOnce(http400)
      .mockResolvedValueOnce({
        writeFile: async () => undefined,
        getReadableStream: () => Readable.from([Buffer.from('scoped-bytes')]),
        headers: {},
      })

    try {
      const data = await port.downloadResource('file_key', 'file', 'om_msg_1')
      expect(data.toString()).toBe('fallback-bytes')
      expect(resourceSpy).toHaveBeenCalledTimes(1)
      expect(resourceSpy).toHaveBeenCalledWith({
        path: { message_id: 'om_msg_1', file_key: 'file_key' },
        params: { type: 'file' },
      })
      expect(fallbackSpy).toHaveBeenCalledTimes(1)
      expect(fallbackSpy).toHaveBeenCalledWith('file_key', 'file')

      // Second call succeeds → bytes come from the message-scoped stream and
      // the legacy path stays untouched.
      const ok = await port.downloadResource('img_key', 'image', 'om_msg_2')
      expect(ok.toString()).toBe('scoped-bytes')
      expect(resourceSpy).toHaveBeenCalledTimes(2)
      expect(resourceSpy).toHaveBeenLastCalledWith({
        path: { message_id: 'om_msg_2', file_key: 'img_key' },
        params: { type: 'image' },
      })
      expect(fallbackSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
