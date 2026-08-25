/**
 * UI copy in zh-CN and en-US. Channel-owned strings render in the READER's
 * language when `locale` is `auto`; host-provided content is never rewritten.
 * @module feishu4dsh/strings
 */

import type { Config } from './config.js'

export type Locale = 'zh-CN' | 'en-US'

/** Every channel-owned string, both languages. */
export interface Strings {
  thinking: string
  processHeader: string
  toolCallLine: (toolName: string) => string
  toolCallCountLine: (toolName: string, count: number) => string
  toolCallSummary: (parts: readonly string[]) => string
  usageSummary: (input: string, output: string, cacheRead: string | undefined, cacheWrite: string | undefined, reasoning: string | undefined) => string
  approvalTitle: string
  approvalReasonLabel: string
  approveButton: string
  denyButton: string
  approvalApprovedBy: (name: string) => string
  approvalDeniedBy: (name: string) => string
  approvalTimedOut: string
  approvalWrongChat: string
  fileReceivedNote: (pathInWorkspace: string, size: string) => string
  imageReceivedNote: string
  unsupportedMediaNote: (kind: string) => string
  mediaTotalTooLargeNote: (limit: string) => string
  helpTitle: string
  /** Section header for commands owned by this channel. */
  helpChannelHeader: string
  /** Section header for commands delegated to the dsh host. */
  helpHostHeader: string
  /** Inline source tag for a channel-owned command line. */
  helpChannelTag: string
  /** Inline source tag for a dsh host command line. */
  helpHostTag: string
  /** Channel-owned command lines (`/cmd — description`), one per entry. */
  channelCommands: readonly string[]
  statusTitle: string
  statusSession: (sessionId: string) => string
  statusScope: (scope: string) => string
  statusWorkspace: (name: string, path: string) => string
  statusModel: (model: string) => string
  /* Model display & switching (/model, R7/R8). */
  modelTitle: string
  /** Marker appended when the shown model comes from this session; '' = none. */
  modelSourceSession: string
  modelDefaultNotStarted: string
  modelSwitched: (provider: string, model: string) => string
  modelSaveDefaultDone: (provider: string, model: string) => string
  modelSaveDefaultUnsupported: string
  modelUnsupported: string
  modelUnknown: string
  modelNoPermission: string
  modelUsage: string
  /* Workspace listing & switching (/ws, /cd). */
  wsTitle: string
  wsEmpty: string
  wsCurrentTag: string
  wsDefaultTag: string
  cdUsage: string
  cdSwitched: (name: string, path: string) => string
  cdNotFound: (target: string) => string
  cdNotAllowed: (target: string) => string
  cdAmbiguous: (target: string, names: string) => string
  cdNoPermission: string
  /* Workspace management (/ws add, /ws remove). */
  wsUsage: string
  wsAddUsage: string
  wsRemoveUsage: string
  wsNoPermission: string
  wsAdded: (name: string, path: string) => string
  wsRemoved: (name: string, path: string) => string
  wsNotUserAdded: (target: string) => string
  wsNotDirectory: (target: string) => string
  newSessionDone: string
  stopped: string
  nothingToStop: string
  turnFailed: (detail: string) => string
  sendFileApprovalTitle: string
  sendFileApprovalDetail: (pathInWorkspace: string, workspaceName: string, size: string) => string
  outsideWorkspaceRefusal: string
  fileNotFoundRefusal: string
  notAFileRefusal: string
  tooLargeRefusal: (size: string, limit: string) => string
  commandUnknown: (line: string) => string
}

const zhCN: Strings = {
  thinking: '正在处理…',
  processHeader: '执行过程',
  toolCallLine: toolName => `调用工具 ${toolName}`,
  toolCallCountLine: (toolName, count) => `调用工具 ${toolName} × ${count} 次`,
  toolCallSummary: parts => parts.join('、'),
  usageSummary: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Token：输入 ${input} · 输出 ${output}${cacheRead === undefined ? '' : ` · 缓存读 ${cacheRead}`}${cacheWrite === undefined ? '' : ` · 缓存写 ${cacheWrite}`}${reasoning === undefined ? '' : ` · 推理 ${reasoning}`}`,
  approvalTitle: '⚠️ 需要确认操作',
  approvalReasonLabel: '原因',
  approveButton: '✅ 允许',
  denyButton: '❌ 拒绝',
  approvalApprovedBy: name => `已由 ${name} 允许`,
  approvalDeniedBy: name => `已由 ${name} 拒绝`,
  approvalTimedOut: '超时未确认，已按拒绝处理',
  approvalWrongChat: '此卡片仅可在原会话中操作',
  fileReceivedNote: (path, size) => `[已收到文件 ${path}（${size}），可用工具读取]`,
  imageReceivedNote: '[已收到图片，但当前未开启视觉能力，未交给模型]',
  unsupportedMediaNote: kind => `[收到暂不支持处理的消息类型：${kind}]`,
  mediaTotalTooLargeNote: limit => `[本次消息附件总大小超过限制：${limit}，已跳过后续附件]`,
  helpTitle: '可用命令',
  helpChannelHeader: 'feishu4dsh 频道命令',
  helpHostHeader: 'dsh 宿主命令',
  helpChannelTag: '频道',
  helpHostTag: 'dsh',
  channelCommands: [
    '/help — 查看命令列表',
    '/new — 开启新会话（清空上下文）',
    '/stop — 停止当前任务',
    '/status — 查看会话 / 当前工作区 / 模型',
    '/ws — 列出可用工作区',
    '/ws add <路径> — 添加一个可用工作区（手机上添加）',
    '/ws remove <名称或路径> — 移除一个已添加的工作区',
    '/cd <名称或路径> — 切换当前会话的工作区',
    '/model <provider>/<model> — 切换当前会话模型',
  ],
  statusTitle: '会话状态',
  statusSession: id => `会话：${id}`,
  statusScope: scope => `会话粒度：${scope}`,
  statusWorkspace: (name, path) => `工作区：${name}\n  路径：${path}`,
  statusModel: model => `模型：${model}`,
  modelTitle: '模型',
  modelSourceSession: '',
  modelDefaultNotStarted: '（默认，尚未开始对话）',
  modelSwitched: (provider, model) => `已切换当前会话模型为 ${provider}/${model}，将在下一轮对话生效。`,
  modelSaveDefaultDone: (provider, model) => `已把部署默认模型保存为 ${provider}/${model}。`,
  modelSaveDefaultUnsupported: '当前部署不支持保存默认模型（缺少 agentDefaultModel.saveSelection 服务）。',
  modelUnsupported: '当前部署不支持切换模型（缺少 installModelSelection 服务）。',
  modelUnknown: '暂无已知模型（部署未声明默认模型，会话也尚未开始对话）。',
  modelNoPermission: '当前发送者无权切换模型（需为配置的审批人/授权用户）。',
  modelUsage: '用法：/model（查看当前模型） · /model <provider>/<model>（切换会话模型） · /model default（写入部署默认）',
  wsTitle: '可用工作区',
  wsEmpty: '当前没有可用的工作区。',
  wsCurrentTag: '当前',
  wsDefaultTag: '默认',
  cdUsage: '用法：/cd <工作区名称或路径>（/ws 查看可用工作区）',
  cdSwitched: (name, path) => `已切换工作区到「${name}」（${path}）。后续消息将在新工作区中继续。`,
  cdNotFound: target => `找不到工作区「${target}」（目录不存在？）`,
  cdNotAllowed: target => `「${target}」不在允许的工作区范围内。可用 /ws add <路径> 添加，或在配置 workspaceRoots 中添加允许的目录。`,
  cdAmbiguous: (target, names) => `「${target}」对应多个工作区，请改用完整路径：${names}`,
  cdNoPermission: '当前发送者无权切换工作区（需为配置的审批人/授权用户）。',
  wsUsage: '用法：/ws（列出） · /ws add <路径>（添加） · /ws remove <名称或路径>（移除）',
  wsAddUsage: '用法：/ws add <工作区目录的绝对路径>',
  wsRemoveUsage: '用法：/ws remove <工作区名称或路径>',
  wsNoPermission: '当前发送者无权管理工作区（需为配置的审批人/授权用户）。',
  wsAdded: (name, path) => `已添加工作区「${name}」（${path}）。可用 /cd ${name} 切换过去。`,
  wsRemoved: (name, path) => `已移除工作区「${name}」（${path}）。`,
  wsNotUserAdded: target => `「${target}」不是通过 /ws add 添加的，无法移除（默认/宿主注册的工作区不可移除）。`,
  wsNotDirectory: target => `「${target}」不是一个已存在的目录，无法添加为工作区。`,
  newSessionDone: '已开启新会话，上下文已清空。',
  stopped: '已停止当前任务。',
  nothingToStop: '当前没有进行中的任务。',
  turnFailed: detail => `本轮执行失败：${detail}`,
  sendFileApprovalTitle: '📎 发送文件确认',
  sendFileApprovalDetail: (path, wsName, size) => `Agent 请求发送文件\n位置：${wsName} 内 ${path}\n大小：${size}`,
  outsideWorkspaceRefusal: 'The path is outside the workspace; only files inside it can be sent.',
  fileNotFoundRefusal: 'No such file in the workspace.',
  notAFileRefusal: 'That path is not a regular file.',
  tooLargeRefusal: (size, limit) => `The file is ${size}, over the ${limit} limit.`,
  commandUnknown: line => `未知命令：${line}（/help 查看可用命令）`,
}

const enUS: Strings = {
  thinking: 'Working…',
  processHeader: 'Process',
  toolCallLine: toolName => `calling ${toolName}`,
  toolCallCountLine: (toolName, count) => `calling ${toolName} × ${count}`,
  toolCallSummary: parts => parts.join(', '),
  usageSummary: (input, output, cacheRead, cacheWrite, reasoning) =>
    `Tokens: ${input} in · ${output} out${cacheRead === undefined ? '' : ` · cache read ${cacheRead}`}${cacheWrite === undefined ? '' : ` · cache write ${cacheWrite}`}${reasoning === undefined ? '' : ` · reasoning ${reasoning}`}`,
  approvalTitle: '⚠️ Approval required',
  approvalReasonLabel: 'Reason',
  approveButton: '✅ Allow',
  denyButton: '❌ Deny',
  approvalApprovedBy: name => `Allowed by ${name}`,
  approvalDeniedBy: name => `Denied by ${name}`,
  approvalTimedOut: 'No response in time; treated as denied',
  approvalWrongChat: 'This card only works in its original chat',
  fileReceivedNote: (path, size) => `[received file ${path} (${size}); read it with your tools]`,
  imageReceivedNote: '[received an image, but vision is disabled; not passed to the model]',
  unsupportedMediaNote: kind => `[received an unsupported message type: ${kind}]`,
  mediaTotalTooLargeNote: limit => `[total attachments for this message exceed the limit: ${limit}; skipped the rest]`,
  helpTitle: 'Commands',
  helpChannelHeader: 'feishu4dsh channel commands',
  helpHostHeader: 'dsh host commands',
  helpChannelTag: 'channel',
  helpHostTag: 'dsh',
  channelCommands: [
    '/help — list commands',
    '/new — start a fresh session (clears context)',
    '/stop — stop the current task',
    '/status — show session / current workspace / model',
    '/ws — list available workspaces',
    '/ws add <path> — add a workspace (from your phone)',
    '/ws remove <name or path> — remove an added workspace',
    '/cd <name or path> — switch the current workspace',
    '/model <provider>/<model> — switch the session model',
  ],
  statusTitle: 'Session status',
  statusSession: id => `Session: ${id}`,
  statusScope: scope => `Scope: ${scope}`,
  statusWorkspace: (name, path) => `Workspace: ${name}\n  Path: ${path}`,
  statusModel: model => `Model: ${model}`,
  modelTitle: 'Model',
  modelSourceSession: '',
  modelDefaultNotStarted: ' (default; no turn yet)',
  modelSwitched: (provider, model) => `Switched the session model to ${provider}/${model}; takes effect on the next turn.`,
  modelSaveDefaultDone: (provider, model) => `Saved ${provider}/${model} as the deployment default model.`,
  modelSaveDefaultUnsupported: 'This deployment cannot save a default model (agentDefaultModel.saveSelection missing).',
  modelUnsupported: 'This deployment does not support switching models (installModelSelection service missing).',
  modelUnknown: 'No model is known yet (the deployment advertises no default and no turn has run).',
  modelNoPermission: 'This sender may not switch models (must be a configured approver / authorized user).',
  modelUsage: 'Usage: /model (show current) · /model <provider>/<model> (switch this session) · /model default (save as deployment default)',
  wsTitle: 'Workspaces',
  wsEmpty: 'No workspaces available.',
  wsCurrentTag: 'current',
  wsDefaultTag: 'default',
  cdUsage: 'Usage: /cd <workspace name or path> (use /ws to list them)',
  cdSwitched: (name, path) => `Switched to workspace "${name}" (${path}). New messages continue there.`,
  cdNotFound: target => `Workspace "${target}" not found (does the directory exist?)`,
  cdNotAllowed: target => `"${target}" is not within the allowed workspaces. Use /ws add <path> to add it, or add its directory to workspaceRoots.`,
  cdAmbiguous: (target, names) => `"${target}" matches several workspaces; use a full path instead: ${names}`,
  cdNoPermission: 'This sender may not switch workspaces (must be a configured approver / authorized user).',
  wsUsage: 'Usage: /ws (list) · /ws add <path> (add) · /ws remove <name or path> (remove)',
  wsAddUsage: 'Usage: /ws add <absolute path to a workspace directory>',
  wsRemoveUsage: 'Usage: /ws remove <workspace name or path>',
  wsNoPermission: 'This sender may not manage workspaces (must be a configured approver / authorized user).',
  wsAdded: (name, path) => `Added workspace "${name}" (${path}). Use /cd ${name} to switch to it.`,
  wsRemoved: (name, path) => `Removed workspace "${name}" (${path}).`,
  wsNotUserAdded: target => `"${target}" was not added via /ws add and cannot be removed (default / host-registered workspaces are protected).`,
  wsNotDirectory: target => `"${target}" is not an existing directory and cannot be added as a workspace.`,
  newSessionDone: 'Started a new session; context cleared.',
  stopped: 'Stopped the current task.',
  nothingToStop: 'Nothing is running right now.',
  turnFailed: detail => `This turn failed: ${detail}`,
  sendFileApprovalTitle: '📎 Send file',
  sendFileApprovalDetail: (path, wsName, size) => `The agent wants to send a file\nAt: ${path} in ${wsName}\nSize: ${size}`,
  outsideWorkspaceRefusal: 'The path is outside the workspace; only files inside it can be sent.',
  fileNotFoundRefusal: 'No such file in the workspace.',
  notAFileRefusal: 'That path is not a regular file.',
  tooLargeRefusal: (size, limit) => `The file is ${size}, over the ${limit} limit.`,
  commandUnknown: line => `Unknown command: ${line} (try /help)`,
}

const table: Record<Locale, Strings> = { 'zh-CN': zhCN, 'en-US': enUS }

/**
 * Resolve the effective locale. `auto` without a reader hint defaults to
 * zh-CN (the primary audience); any explicit zh-flavoured hint keeps zh-CN
 * and any other hint selects en-US.
 * @param configured - the deployment's locale knob.
 * @param readerHint - optional hint about the reader's client language.
 * @returns the locale whose copy gets rendered.
 */
export function resolveLocale(configured: Config['locale'], readerHint?: string): Locale {
  if (configured === 'zh-CN' || configured === 'en-US') return configured
  if (readerHint === undefined || readerHint === '') return 'zh-CN'
  return readerHint.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Copy for one locale. */
export function strings(locale: Locale): Strings {
  return table[locale]
}
