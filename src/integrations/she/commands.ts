/**
 * `/she` command boundary: feishu4dsh only recognises and forwards the
 * command; SHE remains the single source of truth for subcommands and help.
 * @module feishu4dsh/integrations/she/commands
 */

import type { SheClient } from '@she/client'
import type { GatewayCommandResult } from '@she/protocol'
import { commandInvocationFromFeishu, type FeishuSheCommandInput } from './gateway.js'

/** The only client surface needed to forward a command. */
export type SheCommandClient = Pick<SheClient, 'command'>

/**
 * Return the normalised command line when the message starts with `/she`.
 * Subcommands are intentionally NOT parsed here; unknown future commands must
 * pass through without requiring a feishu4dsh release.
 */
export function normalizeSheCommandText(text: string): string | undefined {
  const line = text.trim()
  if (line === '/she') return '/she'
  return line.startsWith('/she ') ? line : undefined
}

export function isSheCommand(text: string): boolean {
  return normalizeSheCommandText(text) !== undefined
}

export interface ForwardSheCommandInput extends FeishuSheCommandInput {
  readonly text: string
}

/**
 * Forward one `/she ...` command to the control plane.
 * @returns the gateway result, or undefined when the message is not a SHE command.
 */
export async function forwardSheCommand(
  client: SheCommandClient,
  input: ForwardSheCommandInput,
  signal?: AbortSignal,
): Promise<GatewayCommandResult | undefined> {
  const rawCommand = normalizeSheCommandText(input.text)
  if (rawCommand === undefined) return undefined
  return await client.command(commandInvocationFromFeishu({ ...input, rawCommand }), signal)
}
