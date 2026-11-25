/**
 * Thin lifecycle wrapper around the public `@she/client` package.
 *
 * feishu4dsh never imports SHE core/control/store/broker internals. This module
 * only owns config validation, optional token-file loading, health/hello
 * probing and structured failures for the channel layer.
 * @module feishu4dsh/integrations/she/client
 */

import { readFile, stat } from 'node:fs/promises'
import { SheClient, SheClientError } from '@she/client'
import {
  CHANNEL_CAPABILITIES_V1,
  GATEWAY_PROTOCOL_VERSION,
  missingCapabilities,
  type CapabilitySet,
  type GatewayHealth,
  type GatewayWelcome,
  type SheErrorCode,
} from '@she/protocol'
import {
  SheConfigError,
  resolveSheIntegrationConfig,
  type SheIntegrationConfig,
  type SheIntegrationConfigInput,
  type SheIntegrationEnvironment,
} from './config.js'

/** Stable failure categories the Feishu command/render layer can present. */
export type SheProbeFailureCode =
  | SheErrorCode
  | 'transport_error'
  | 'disabled'
  | 'insecure_token_file'
  | 'internal'

export interface SheProbeFailure {
  readonly ok: false
  readonly code: SheProbeFailureCode
  readonly message: string
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface SheProbeSuccess {
  readonly ok: true
  readonly health: GatewayHealth
  readonly welcome: GatewayWelcome
  /** Required capabilities the server did not advertise. */
  readonly missing: readonly string[]
}

export type SheProbeResult = SheProbeSuccess | SheProbeFailure

/** Minimal client surface needed by the probe/test seam. */
export interface SheProbeClient {
  health(signal?: AbortSignal): Promise<GatewayHealth>
  hello(input?: Partial<import('@she/protocol').GatewayHello>): Promise<GatewayWelcome>
}

export interface SheProbeOptions {
  /** Capabilities the integration requires for a given feature set. */
  readonly requiredCapabilities?: readonly string[]
  readonly signal?: AbortSignal
}

function failure(
  code: SheProbeFailureCode,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
): SheProbeFailure {
  return {
    ok: false,
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  }
}

function asFailure(error: unknown): SheProbeFailure {
  if (error instanceof SheClientError) {
    return failure(
      error.code,
      error.message,
      error.retryable,
      error.details,
    )
  }
  if (error instanceof SheConfigError) {
    return failure('invalid_request', error.message)
  }
  return failure('internal', error instanceof Error ? error.message : String(error))
}

/**
 * Load a bearer token from a 0600/0400 file. Missing file = no token.
 * A readable-by-others token file fails closed rather than being used.
 */
export async function readSheTokenFile(path: string): Promise<string | undefined> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const permissions = info.mode & 0o777
  if ((permissions & 0o077) !== 0) {
    throw new SheConfigError(`SHE token file ${path} must not be readable by group/others`)
  }
  const token = (await readFile(path, 'utf8')).trim()
  if (token === '') throw new SheConfigError(`SHE token file ${path} is empty`)
  return token
}

/**
 * Create a client from resolved config. The caller owns its lifetime and must
 * call `close()` during plugin teardown.
 */
export async function createSheClient(config: SheIntegrationConfig): Promise<SheClient> {
  if (!config.enabled) throw new SheConfigError('SHE integration is disabled')
  const token = await readSheTokenFile(config.tokenFile)
  return new SheClient({
    socketPath: config.socketPath,
    ...(token === undefined ? {} : { token }),
    timeoutMs: config.timeoutMs,
    capabilities: CHANNEL_CAPABILITIES_V1,
  })
}

/** Convenience helper that resolves config and probes a real client. */
export async function probeSheIntegration(
  input: SheIntegrationConfigInput = {},
  env: SheIntegrationEnvironment = process.env,
  options: SheProbeOptions = {},
): Promise<SheProbeResult> {
  let config: SheIntegrationConfig
  try {
    config = resolveSheIntegrationConfig(input, env)
  } catch (error) {
    return asFailure(error)
  }
  if (!config.enabled) return failure('disabled', 'SHE integration is disabled')
  let client: SheClient | undefined
  try {
    client = await createSheClient(config)
    return await probeSheClient(client, options)
  } catch (error) {
    return asFailure(error)
  } finally {
    await client?.close().catch(() => undefined)
  }
}

/**
 * Health + hello negotiation against an already-created client.
 *
 * Transport errors, auth failures and protocol mismatches stay distinct so
 * `/she doctor` can explain the next action instead of returning a generic
 * "unavailable".
 */
export async function probeSheClient(
  client: SheProbeClient,
  options: SheProbeOptions = {},
): Promise<SheProbeResult> {
  try {
    const health = await client.health(options.signal)
    const welcome = await client.hello()
    if (welcome.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
      return failure(
        'protocol_mismatch',
        `SHE speaks ${welcome.protocolVersion}; this gateway requires ${GATEWAY_PROTOCOL_VERSION}`,
        false,
        { expected: GATEWAY_PROTOCOL_VERSION, actual: welcome.protocolVersion },
      )
    }
    const missing = missingCapabilities(
      options.requiredCapabilities ?? [],
      welcome.capabilities as CapabilitySet,
    )
    return { ok: true, health, welcome, missing }
  } catch (error) {
    return asFailure(error)
  }
}
