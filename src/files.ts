/**
 * Media crossing the trust boundary in both directions.
 *
 * Inbound: platform resources are UNTRUSTED bytes; they land in an inbox
 * folder inside the workspace, grouped per message, append-only. The agent
 * reads them like any other file.
 *
 * Outbound: the agent asks to send a workspace path. The path check here
 * answers "may these bytes leave at all" — canonicalize first, then ask
 * "inside the container?"; the reverse order lets `<ws>/link -> /etc/shadow`
 * escape. Whether the human approves the send is the bridge's gate, not
 * this module's.
 * @module feishu4dsh/files
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { formatBytes, sanitizeFileName, shortHash } from './util.js'
import type { Strings } from './strings.js'

/** Inbox root inside one workspace, relative to it. */
export const INBOX_DIRNAME = '.feishu4dsh/inbox'

/** Why one inbound file could not be stored. */
export type InboundRefusal =
  | { readonly code: 'too_large'; readonly bytes: number; readonly limit: number }
  | { readonly code: 'io_error'; readonly detail: string }

/** One stored inbound file. */
export interface InboundFile {
  /** Absolute path the bytes live at. */
  readonly path: string
  /** Where it sits relative to the workspace root. */
  readonly pathInWorkspace: string
  readonly bytes: number
  readonly fileName: string
}

/**
 * Store one inbound resource in the message's inbox group.
 * @param workspace - canonical workspace directory.
 * @param messageKey - grouping key, e.g. `<epoch>-<hash(messageId)>`.
 * @param fileName - platform-reported name (untrusted).
 * @param data - file bytes, already size-checked by the caller when cheap.
 * @param maxBytes - hard inbound size limit.
 * @returns the stored file, or the refusal.
 */
export async function storeInboundFile(
  workspace: string,
  messageKey: string,
  fileName: string,
  data: Uint8Array,
  maxBytes: number,
): Promise<{ ok: true; file: InboundFile } | { ok: false; refusal: InboundRefusal }> {
  if (data.byteLength > maxBytes) {
    return { ok: false, refusal: { code: 'too_large', bytes: data.byteLength, limit: maxBytes } }
  }
  const safeName = sanitizeFileName(fileName, `file-${shortHash(messageKey, 6)}`)
  const dir = join(workspace, INBOX_DIRNAME, messageKey)
  const path = join(dir, safeName)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, data)
  } catch (error) {
    return { ok: false, refusal: { code: 'io_error', detail: error instanceof Error ? error.message : String(error) } }
  }
  return {
    ok: true,
    file: {
      path,
      pathInWorkspace: `${INBOX_DIRNAME}/${messageKey}/${safeName}`,
      bytes: data.byteLength,
      fileName: safeName,
    },
  }
}

/** Why one outbound path cannot be sent. */
export type OutboundRefusal =
  | { readonly code: 'outside_workspace' }
  | { readonly code: 'not_found' }
  | { readonly code: 'not_a_file' }
  | { readonly code: 'too_large'; readonly bytes: number; readonly limit: number }

/** One file cleared for sending. */
export interface OutboundFile {
  /** Canonical path the bytes come from. */
  readonly path: string
  /** Name shown in the chat: the canonical basename. */
  readonly fileName: string
  readonly bytes: number
  /** The path relative to the workspace; never the host absolute prefix. */
  readonly pathInWorkspace: string
  /** The workspace directory's basename, for humans. */
  readonly workspaceName: string
}

/**
 * Check whether one requested path may leave the workspace, and describe it
 * when so. The caller reads the bytes; this module never does.
 * @param requested - model-authored path (untrusted input).
 * @param workspace - canonical workspace directory.
 * @param maxBytes - hard outbound size limit.
 * @returns the cleared file, or the refusal.
 */
export async function resolveOutboundFile(
  requested: string,
  workspace: string,
  maxBytes: number,
): Promise<{ ok: true; file: OutboundFile } | { ok: false; refusal: OutboundRefusal }> {
  const base = requested.trim()
  if (base === '') return { ok: false, refusal: { code: 'not_found' } }

  let canonicalWorkspace: string
  try {
    canonicalWorkspace = await realpath(workspace)
  } catch {
    return { ok: false, refusal: { code: 'not_found' } }
  }

  // Lexical containment FIRST: an escape attempt is named as an escape even
  // when its target does not exist yet, which is the shape an injected
  // instruction takes.
  const resolved = isAbsolute(base) ? base : resolve(workspace, base)
  const lexicalRel = relative(workspace, resolved)
  if (lexicalRel === '' || lexicalRel.startsWith('..') || isAbsolute(lexicalRel)) {
    return { ok: false, refusal: { code: 'outside_workspace' } }
  }

  // Canonicalize second: a symlink inside the workspace that points out must
  // fail containment against ITS TARGET.
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch {
    return { ok: false, refusal: { code: 'not_found' } }
  }
  const rel = relative(canonicalWorkspace, canonical)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, refusal: { code: 'outside_workspace' } }
  }

  let info
  try {
    info = await stat(canonical)
  } catch {
    return { ok: false, refusal: { code: 'not_found' } }
  }
  if (!info.isFile()) return { ok: false, refusal: { code: 'not_a_file' } }
  if (info.size > maxBytes) {
    return { ok: false, refusal: { code: 'too_large', bytes: info.size, limit: maxBytes } }
  }
  return {
    ok: true,
    file: {
      path: canonical,
      fileName: basename(canonical),
      bytes: info.size,
      pathInWorkspace: rel,
      workspaceName: basename(canonicalWorkspace),
    },
  }
}

/** Read one cleared outbound file's bytes. */
export async function readOutboundFile(file: OutboundFile): Promise<Buffer> {
  return readFile(file.path)
}

/**
 * Describe an outbound refusal for the MODEL: a tool result steers the next
 * move, so refusals are thrown strings it must act on, kept in English —
 * the language models steer most reliably in.
 * @param refusal - why the path could not be cleared.
 * @param copy - channel copy.
 * @returns the model-facing sentence.
 */
export function describeRefusalForModel(refusal: OutboundRefusal, copy: Strings): string {
  switch (refusal.code) {
    case 'outside_workspace':
      return copy.outsideWorkspaceRefusal
    case 'not_found':
      return copy.fileNotFoundRefusal
    case 'not_a_file':
      return copy.notAFileRefusal
    case 'too_large':
      return copy.tooLargeRefusal(formatBytes(refusal.bytes), formatBytes(refusal.limit))
    default:
      return 'The file could not be sent.'
  }
}

/** Ports the `send_file` tool needs, injected by the bridge. */
export interface SendFilePorts {
  /** Deliver one cleared file to its chat; resolves the failure reason or undefined. */
  deliver(sessionId: string, file: OutboundFile, signal?: AbortSignal): Promise<string | undefined>
  /** The workspace one session drives, when known. */
  workspaceOf(sessionId: string): string | undefined
  readonly maxBytes: number
  readonly copy: Strings
}

/** Tool name the `send_file` definition registers under. */
export const SEND_FILE_TOOL = 'send_file'

/**
 * Build the agent-scoped `send_file` tool definition. Every refusal is
 * thrown: "too large" must reach the model as a failure it acts on, not a
 * field it may ignore.
 * @param ports - how to find the workspace and deliver the bytes.
 * @returns the definition for `tools.register` on an agent's context.
 */
export function sendFileTool(ports: SendFilePorts): object {
  return {
    name: SEND_FILE_TOOL,
    description: 'Send a file from the workspace to the current chat. Paths are workspace-relative. In group chats a human approves each send first.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the file, inside the workspace.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'boolean' } },
        required: ['sent'],
      },
      render: () => [{ type: 'text', text: 'send_file' }],
    },
    async execute(args: unknown, exec: unknown): Promise<{ sent: true }> {
      const requested = String((args as { path?: unknown } | null | undefined)?.path ?? '')
      const context = exec as { agent?: { session?: { id?: string } }; signal?: AbortSignal }
      const sessionId = context.agent?.session?.id
      if (sessionId === undefined) {
        throw new Error(`${SEND_FILE_TOOL} requires a calling agent (no chat to send to)`)
      }
      const workspace = ports.workspaceOf(sessionId)
      if (workspace === undefined) {
        throw new Error(`${SEND_FILE_TOOL} found no chat for this session, so there is nowhere to send`)
      }
      const verdict = await resolveOutboundFile(requested, workspace, ports.maxBytes)
      if (!verdict.ok) throw new Error(describeRefusalForModel(verdict.refusal, ports.copy))
      const failure = await ports.deliver(sessionId, verdict.file, context.signal)
      if (failure !== undefined) throw new Error(failure)
      return { sent: true }
    },
  }
}
