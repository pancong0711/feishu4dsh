/**
 * Configuration for the optional SHE control-plane integration.
 *
 * This module is deliberately independent of dsh/Feishu runtime state. It
 * resolves the explicit Unix socket path, optional token file and timeout from
 * a small namespaced config object so ordinary Feishu chat never depends on
 * SHE being present.
 * @module feishu4dsh/integrations/she/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Minimal environment shape needed to resolve stable default paths. */
export interface SheIntegrationEnvironment {
  readonly XDG_RUNTIME_DIR?: string
  readonly HOME?: string
}

/** Raw user-facing config for the optional SHE integration. */
export interface SheIntegrationConfigInput {
  /** Default false: SHE must be opted in explicitly. */
  readonly enabled?: boolean
  /** Explicit control-plane Unix socket path; never guessed by @she/client itself. */
  readonly socketPath?: string
  /** Optional 0600 bearer-token file. */
  readonly tokenFile?: string
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number
}

/** Fully resolved integration config. */
export interface SheIntegrationConfig {
  readonly enabled: boolean
  readonly socketPath: string
  readonly tokenFile: string
  readonly timeoutMs: number
}

export class SheConfigError extends Error {
  readonly code: 'invalid_request'

  constructor(message: string) {
    super(message)
    this.name = 'SheConfigError'
    this.code = 'invalid_request'
  }
}

/** Resolve the documented runtime socket default. */
export function defaultSheSocketPath(env: SheIntegrationEnvironment = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim()
  if (runtimeDir !== undefined && runtimeDir !== '') {
    return join(runtimeDir, 'she', 'control.sock')
  }
  return join(env.HOME?.trim() || homedir(), '.local', 'run', 'she', 'control.sock')
}

/** Resolve the documented optional token-file default. */
export function defaultSheTokenFile(env: SheIntegrationEnvironment = process.env): string {
  return join(env.HOME?.trim() || homedir(), '.config', 'she', 'token')
}

function requireAbsolute(label: string, value: string): string {
  if (!isAbsolute(value)) throw new SheConfigError(`${label} must be an absolute path`)
  return value
}

/**
 * Resolve and validate the SHE integration config.
 *
 * Disabled is the default. Paths are still validated so a bad opt-in config
 * fails loudly before a connection attempt; disabling SHE never touches the
 * ordinary Feishu chat path.
 */
export function resolveSheIntegrationConfig(
  input: SheIntegrationConfigInput = {},
  env: SheIntegrationEnvironment = process.env,
): SheIntegrationConfig {
  const enabled = input.enabled ?? false
  const socketPath = requireAbsolute(
    'she.socketPath',
    input.socketPath?.trim() || defaultSheSocketPath(env),
  )
  const tokenFile = requireAbsolute(
    'she.tokenFile',
    input.tokenFile?.trim() || defaultSheTokenFile(env),
  )
  const timeoutMs = input.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new SheConfigError('she.timeoutMs must be a positive integer')
  }
  return { enabled, socketPath, tokenFile, timeoutMs }
}
