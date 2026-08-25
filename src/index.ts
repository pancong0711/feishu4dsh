/**
 * Feishu/Lark IM channel for DeepSeek Harness: each chat drives its own dsh
 * agent session, committed assistant output returns as progressive replies,
 * and approval questions become interactive cards answered by buttons.
 *
 * Architecture: the official Feishu SDK carries the transport half (long
 * connection or webhook, dedup, batching, policy, streaming); the bridge in
 * this package is the glue layer that maps normalized messages onto dsh
 * agent sessions and renders the session log back into the chat.
 * @module feishu4dsh
 */

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'feishu4dsh'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['agents']

export { Config } from './config.js'
export type { ResolvedConfig } from './config.js'
export { apply } from './runtime.js'
