/**
 * Plugin configuration: the schemastery schema the host resolves, and the
 * plain-object form every runtime module consumes.
 * @module feishu4dsh/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Resolved plugin configuration, one instance per mounted row. */
export interface Config {
  /** Feishu/Lark app id (`cli_...`). */
  appId?: string
  /** Feishu/Lark app secret. */
  appSecret?: string
  /** Tenant domain: `feishu` (default) or `lark`. */
  domain?: 'feishu' | 'lark'
  /** Transport: `websocket` long connection (default) or `webhook`. */
  connectionMode?: 'websocket' | 'webhook'
  /** Webhook verification token (webhook mode only). */
  verificationToken?: string
  /** Webhook encrypt key (webhook mode only). */
  encryptKey?: string
  /** Local listen port for the webhook transport. */
  webhookPort?: number
  /** Working directory the agent session starts in. */
  workspace?: string
  /** Directory prefixes `/cd` may enter; empty = only trusted workspaces. */
  workspaceRoots?: string[]
  /** Runtime map of scopeKey → workspace path; managed by `/cd`, not edited by hand. */
  chatWorkspaces?: Record<string, string>
  /** Runtime list of workspace paths added via `/ws add`; managed, not hand-edited. */
  userWorkspaces?: string[]
  /** Session granularity. */
  sessionScope?: 'chat' | 'chat-thread' | 'chat-sender'
  /** Group chats need an @ mention to trigger the bot. */
  requireMention?: boolean
  /** How one turn renders in the chat. */
  output?: 'stream' | 'card'
  /** Show tool-call process lines while a turn runs. */
  showProcess?: boolean
  /** Inbound files land in `<workspace>/.feishu4dsh/inbox/`. */
  receiveFiles?: boolean
  /** Largest single inbound file accepted. */
  maxReceiveFileBytes?: number
  /** Largest total inbound media bytes accepted per message. */
  maxMessageReceiveBytes?: number
  /** Also save inbound images to the workspace inbox. */
  saveImagesToInbox?: boolean
  /** Deliver inbound images to the model (needs a vision-capable route). */
  attachImages?: boolean
  /** Let the agent send workspace files back to the chat. */
  sendFiles?: boolean
  /** Largest single outbound file accepted. */
  maxSendFileBytes?: number
  /** How long an approval card waits before failing closed, in ms. */
  approvalTimeoutMs?: number
  /** UI copy: follow the reader's Feishu language, or pin one. */
  locale?: 'auto' | 'zh-CN' | 'en-US'
  /** Sender open_ids allowed to DM; empty serves anyone the app can see. */
  senderAllowlist?: string[]
  /** Group chat_ids allowed; empty serves any group. */
  groupAllowlist?: string[]
  /** open_ids that may click approve/deny; empty lets the chat driver decide. */
  approvers?: string[]
}

/** The schemastery schema exported as the Cordis plugin `Config`. */
export const Config = Schema.object({
  appId: Schema.string(),
  appSecret: Schema.string().role('secret'),
  domain: Schema.union(['feishu', 'lark']).default('feishu'),
  connectionMode: Schema.union(['websocket', 'webhook']).default('websocket'),
  verificationToken: Schema.string().role('secret'),
  encryptKey: Schema.string().role('secret'),
  webhookPort: Schema.number().default(3081),
  workspace: Schema.string(),
  workspaceRoots: Schema.array(String).default([]),
  // Hidden runtime state managed by `/cd`; kept `any` so the schema's
  // inferred type stays portable (no dependency on cosmokit's Dict).
  chatWorkspaces: Schema.any().default({}).hidden(),
  // Hidden runtime state managed by `/ws add` / `/ws remove`.
  userWorkspaces: Schema.array(String).default([]).hidden(),
  sessionScope: Schema.union(['chat', 'chat-thread', 'chat-sender']).default('chat'),
  requireMention: Schema.boolean().default(true),
  output: Schema.union(['stream', 'card']).default('stream'),
  showProcess: Schema.boolean().default(true),
  receiveFiles: Schema.boolean().default(true),
  maxReceiveFileBytes: Schema.number().default(20 * 1024 * 1024),
  maxMessageReceiveBytes: Schema.number().default(1024 * 1024 * 1024),
  saveImagesToInbox: Schema.boolean().default(true),
  attachImages: Schema.boolean().default(false),
  sendFiles: Schema.boolean().default(true),
  maxSendFileBytes: Schema.number().default(20 * 1024 * 1024),
  approvalTimeoutMs: Schema.number().default(300_000),
  locale: Schema.union(['auto', 'zh-CN', 'en-US']).default('auto'),
  senderAllowlist: Schema.array(String).default([]),
  groupAllowlist: Schema.array(String).default([]),
  approvers: Schema.array(String).default([]),
})

/** Whether both credential fields are present and non-empty. */
export function hasCredentials(config: Config): config is Config & { appId: string; appSecret: string } {
  return typeof config.appId === 'string' && config.appId !== ''
    && typeof config.appSecret === 'string' && config.appSecret !== ''
}

/**
 * Normalize a Cordis-resolved config into the plain form the runtime reads:
 * apply schema defaults for anything missing, trim list entries, and pin
 * numbers to sane lower bounds.
 * @param config - validated plugin configuration.
 * @returns the runtime view with every field present.
 */
export function resolveConfig(config: Config): Required<Config> {
  const numberAtLeast = (value: number | undefined, minimum: number, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return value >= minimum ? value : minimum
  }
  // A non-positive size is not a tuning choice; fall back to the default.
  const sizeOrDefault = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const cleanList = (value: string[] | undefined): string[] =>
    (value ?? []).map(item => String(item).trim()).filter(item => item !== '')
  // NOTE (R10): this only trims leading/trailing whitespace and drops empty
  // entries. It intentionally does NOT check that a path names a real
  // directory or normalize stray internal spaces (e.g. `20260730 - 示例目录`):
  // the runtime validates every workspace path against the filesystem when a
  // binding is built (`bridge.ensureBinding`) and falls back to the default
  // workspace for invalid ones, so a bad saved value can never desync
  // `/status` from the Agent's real sandbox directory.
  const cleanChatWorkspaces = (value: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, path] of Object.entries(value ?? {})) {
      const trimmedPath = String(path).trim()
      if (key.trim() !== '' && trimmedPath !== '') out[key] = trimmedPath
    }
    return out
  }
  return {
    appId: config.appId ?? '',
    appSecret: config.appSecret ?? '',
    domain: config.domain ?? 'feishu',
    connectionMode: config.connectionMode ?? 'websocket',
    verificationToken: config.verificationToken ?? '',
    encryptKey: config.encryptKey ?? '',
    webhookPort: numberAtLeast(config.webhookPort, 1, 3081),
    workspace: config.workspace ?? process.cwd(),
    workspaceRoots: cleanList(config.workspaceRoots),
    chatWorkspaces: cleanChatWorkspaces(config.chatWorkspaces),
    userWorkspaces: cleanList(config.userWorkspaces),
    sessionScope: config.sessionScope ?? 'chat',
    requireMention: config.requireMention ?? true,
    output: config.output ?? 'stream',
    showProcess: config.showProcess ?? true,
    receiveFiles: config.receiveFiles ?? true,
    maxReceiveFileBytes: sizeOrDefault(config.maxReceiveFileBytes, 20 * 1024 * 1024),
    maxMessageReceiveBytes: sizeOrDefault(config.maxMessageReceiveBytes, 1024 * 1024 * 1024),
    saveImagesToInbox: config.saveImagesToInbox ?? true,
    attachImages: config.attachImages ?? false,
    sendFiles: config.sendFiles ?? true,
    maxSendFileBytes: sizeOrDefault(config.maxSendFileBytes, 20 * 1024 * 1024),
    approvalTimeoutMs: numberAtLeast(config.approvalTimeoutMs, 10_000, 300_000),
    locale: config.locale ?? 'auto',
    senderAllowlist: cleanList(config.senderAllowlist),
    groupAllowlist: cleanList(config.groupAllowlist),
    approvers: cleanList(config.approvers),
  }
}

export type ResolvedConfig = Required<Config>
