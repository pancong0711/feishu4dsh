/**
 * Deployment authorization: who this channel answers, and who may settle an
 * approval. Narrowing facts only — the transport policy enforces reach, this
 * module decides the card-level permissions the bridge can not see.
 * @module feishu4dsh/acl
 */

import type { ResolvedConfig } from './config.js'

/** Who this deployment answers; every set empty means "anyone in reach". */
export interface Authorization {
  /** open_ids allowed to DM; empty serves anyone the app is visible to. */
  readonly directSenders: ReadonlySet<string>
  /** chat_ids of served groups; empty serves any group. */
  readonly groups: ReadonlySet<string>
  /** open_ids allowed to click approve/deny; empty = the chat driver. */
  readonly approvers: ReadonlySet<string>
}

/**
 * Fold the configured lists into the runtime authorization view.
 * @param config - resolved plugin configuration.
 * @returns the authorization this deployment runs under.
 */
export function resolveAuthorization(config: Pick<ResolvedConfig, 'senderAllowlist' | 'groupAllowlist' | 'approvers'>): Authorization {
  return {
    directSenders: new Set(config.senderAllowlist),
    groups: new Set(config.groupAllowlist),
    approvers: new Set(config.approvers),
  }
}

/**
 * Whether one operator may settle one pending approval card.
 *
 * With a configured approver list ONLY listed operators decide. Without one,
 * whoever drives the chat decides — and "drives" is answered by the caller,
 * which passes `isChatDriver`. This keeps the rule testable without a chat.
 * @param authorization - deployment authorization.
 * @param operatorOpenId - the clicker's open_id.
 * @param isChatDriver - whether the clicker is driving the session's chat.
 * @returns whether the click settles the card.
 */
export function mayApprove(
  authorization: Authorization,
  operatorOpenId: string,
  isChatDriver: boolean,
): boolean {
  if (authorization.approvers.size > 0) return authorization.approvers.has(operatorOpenId)
  return isChatDriver
}

/**
 * One operator-visible line stating the channel's reach; the security fact
 * the operator must see at boot.
 * @param authorization - deployment authorization.
 * @returns the console line.
 */
export function describeAuthorization(authorization: Authorization): string {
  const dmText = authorization.directSenders.size === 0
    ? 'anyone the app is visible to'
    : `${authorization.directSenders.size} allowlisted sender(s)`
  const groupText = authorization.groups.size === 0
    ? 'any group the bot joins'
    : `${authorization.groups.size} allowlisted group(s)`
  const approverText = authorization.approvers.size === 0
    ? 'whoever drives the chat'
    : `${authorization.approvers.size} named approver(s)`
  return `feishu4dsh reach: DMs from ${dmText}; groups: ${groupText}; approvals by ${approverText}`
}
