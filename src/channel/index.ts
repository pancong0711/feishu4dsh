/**
 * Stable Feishu channel facade for future gateway/control-plane integrations.
 *
 * This is intentionally narrower than `src/bridge.ts`: it exposes platform
 * capability declarations and pure Feishu-side primitives (authorization,
 * card construction, file boundary helpers, transport-facing event types).
 * It does not expose dsh host/session or SHE state.
 *
 * SHE must use the versioned gateway protocol rather than importing this
 * module directly. A future generic gateway package may consume this facade.
 * @module feishu4dsh/channel
 */

export {
  CHANNEL_CAPABILITIES_V1,
  CHANNEL_CAPABILITY_VERSION,
  createChannelCapabilitySet,
  feishuChannelCapabilitySet,
  hasChannelCapability,
  minimalChannelCapabilitySet,
} from './capabilities.js'
export type {
  ChannelCapability,
  ChannelCapabilitySet,
} from './capabilities.js'

export type {
  CardActionEvent,
  ChannelPort,
  NormalizedMessage,
  RejectEvent,
  ResourceType,
  SendInput,
  SendOptions,
  SendResult,
  StreamInput,
} from '../adapter.js'
export {
  describeAuthorization,
  mayApprove,
  resolveAuthorization,
} from '../acl.js'
export type { Authorization } from '../acl.js'
export {
  actionRow,
  approvalCard,
  card,
  collapsiblePanel,
  markdownElement,
  noteElement,
  questionCard,
  settledApprovalCard,
  settledQuestionCard,
} from '../cards.js'
export type {
  ApprovalCardOptions,
  CardButton,
  CardTemplate,
  QuestionCardCopy,
  QuestionCardItem,
} from '../cards.js'
export {
  INBOX_DIRNAME,
  SEND_FILE_TOOL,
  describeRefusalForModel,
  readOutboundFile,
  resolveOutboundFile,
  sendFileTool,
  storeInboundFile,
} from '../files.js'
export type {
  InboundFile,
  InboundRefusal,
  OutboundFile,
  OutboundRefusal,
  SendFilePorts,
} from '../files.js'
