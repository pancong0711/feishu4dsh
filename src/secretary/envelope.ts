/**
 * Fixed prompt envelope and user-visible excerpt helpers.
 *
 * The user's request is appended verbatim under an explicit marker; the
 * envelope only adds execution boundaries (workspace, report path, forbidden
 * actions). No summary, rewrite, or model-side intention inference happens
 * here.
 * @module feishu4dsh/secretary/envelope
 */

import { createHash } from 'node:crypto'
import type { EnvelopeInput, SecretaryAttachmentRef } from './types.js'

/** Safe 20-code-point excerpt for boards; never a summary. */
export function excerptTwenty(raw: string): string {
  const chars = Array.from(raw.trim())
  return chars.slice(0, 20).join('')
}

/** Stable SHA-256 of the exact user request. */
export function hashRequest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Fixed forbidden operations for every SHE task in MVP. */
export const SHE_FORBIDDEN = [
  '不要 commit、push、merge、deploy 或改写 git 历史（除非用户在任务中明确要求且执行环境另行授权）',
  '不要读取 .env、.env.*、*.key、*.pem、密钥、token、cookie 或未授权的真实 PII',
  '不要访问工作区之外的路径，不要通过符号链接逃逸',
  '不要使用 sudo，不要执行 rm -rf，不要自行安装依赖',
  '不要使用 webfetch 或外部网络（除非任务明确要求且权限规则允许）',
  '不要调用 task/subagent 创建新的执行代理',
] as const

function attachmentLines(attachments: readonly SecretaryAttachmentRef[]): string {
  if (attachments.length === 0) return '- (none)'
  return attachments
    .map(file => `- ${file.pathInWorktree} (${file.fileName}, ${file.bytes} bytes, sha256=${file.sha256})`)
    .join('\n')
}

/**
 * Build the versioned prompt envelope. The caller must pass the exact user
 * text; this function deliberately performs no natural-language processing.
 */
export function buildEnvelope(input: EnvelopeInput): string {
  return [
    '[she/v1]',
    `task_id: ${input.taskId}`,
    `topic_id: ${input.topicId}`,
    `workspace: ${input.workspacePath}`,
    `worktree: ${input.worktreePath}`,
    `mode: execute`,
    `write_scope: ${input.worktreePath}`,
    `report_path: ${input.reportPath}`,
    `return_format: markdown`,
    `session_policy: reuse`,
    'forbidden:',
    ...SHE_FORBIDDEN.map(item => `- ${item}`),
    'attachments:',
    attachmentLines(input.attachments),
    '',
    '请根据下方用户原文执行。完成后在 report_path 写一份 Markdown 报告；',
    '报告中的技术结论保持原样，不要编造未执行的验证。',
    '',
    '[user_request_raw]',
    input.rawRequest,
  ].join('\n')
}
