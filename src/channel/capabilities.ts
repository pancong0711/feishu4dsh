/**
 * Platform-neutral channel capability declarations.
 *
 * This module is the first seam for sharing Feishu-side channel capabilities
 * with an external gateway/control-plane. It deliberately has no
 * dependency on the Feishu SDK, dsh host contracts, Docker, or SHE protocol
 * internals. Platform adapters (currently the Feishu implementation) declare
 * what they can do; consumers negotiate against this set and fall back to
 * universally available text when a capability is absent.
 * @module feishu4dsh/channel/capabilities
 */

/** Version of the capability declaration itself. */
export const CHANNEL_CAPABILITY_VERSION = 1 as const

/**
 * Stable capability identifiers.
 *
 * Keep these semantic and platform-neutral. Feishu-specific card JSON,
 * button payloads, or file APIs must not leak into this list.
 */
export type ChannelCapability =
  | 'text.inbound'
  | 'text.outbound'
  | 'markdown.outbound'
  | 'stream.outbound'
  | 'card.outbound'
  | 'form.outbound'
  | 'selector.outbound'
  | 'approval.interactive'
  | 'file.inbound'
  | 'file.outbound'
  | 'thread.reply'
  | 'mention'
  | 'reaction'

/** A channel's advertised, versioned capability set. */
export interface ChannelCapabilitySet {
  readonly protocolVersion: typeof CHANNEL_CAPABILITY_VERSION
  /** Platform identifier, e.g. `feishu`; consumers must not branch on it if a capability exists. */
  readonly platform: string
  readonly capabilities: readonly ChannelCapability[]
  /** Optional namespaced extension identifiers (e.g. `feishu.card-v2`). */
  readonly extensions?: readonly string[]
}

/** Canonical v1 capability names. Consumers negotiate against this additive set. */
export const CHANNEL_CAPABILITIES_V1: readonly ChannelCapability[] = [
  'text.inbound',
  'text.outbound',
  'markdown.outbound',
  'stream.outbound',
  'card.outbound',
  'form.outbound',
  'selector.outbound',
  'approval.interactive',
  'file.inbound',
  'file.outbound',
  'thread.reply',
  'mention',
  'reaction',
]

/** True when the capability list contains `capability`, with duplicate-safe semantics. */
export function hasChannelCapability(
  set: Pick<ChannelCapabilitySet, 'capabilities'>,
  capability: ChannelCapability,
): boolean {
  return set.capabilities.includes(capability)
}

/**
 * Build a deduplicated capability set in stable declaration order.
 * Unknown strings are rejected by TypeScript at compile time; this function
 * only guards accidental runtime duplicates.
 */
export function createChannelCapabilitySet(input: {
  readonly platform: string
  readonly capabilities: readonly ChannelCapability[]
  readonly extensions?: readonly string[]
}): ChannelCapabilitySet {
  const capabilities = CHANNEL_CAPABILITIES_V1.filter(capability => input.capabilities.includes(capability))
  const extensions = input.extensions === undefined
    ? undefined
    : [...new Set(input.extensions.filter(extension => extension.trim() !== ''))]
  return {
    protocolVersion: CHANNEL_CAPABILITY_VERSION,
    platform: input.platform,
    capabilities,
    ...(extensions === undefined || extensions.length === 0 ? {} : { extensions }),
  }
}

/** Current Feishu channel adapter's advertised semantic capabilities. */
export function feishuChannelCapabilitySet(): ChannelCapabilitySet {
  return createChannelCapabilitySet({
    platform: 'feishu',
    capabilities: CHANNEL_CAPABILITIES_V1,
    extensions: ['feishu.thread-anchor', 'feishu.card-actions', 'feishu.file-approval'],
  })
}

/**
 * Return a minimal fallback capability set: text inbound/outbound only.
 * A gateway can use this when the remote side does not advertise capabilities.
 */
export function minimalChannelCapabilitySet(platform: string): ChannelCapabilitySet {
  return createChannelCapabilitySet({
    platform,
    capabilities: ['text.inbound', 'text.outbound'],
  })
}
