import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { channelOptions } from '../src/adapter.js'
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
