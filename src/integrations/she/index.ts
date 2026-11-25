/**
 * Optional SHE control-plane integration surface.
 *
 * This module is not activated by the ordinary Feishu chat path. Consumers
 * must opt in explicitly and treat SHE absence as a recoverable integration
 * failure, never as a reason to break normal dsh chat.
 * @module feishu4dsh/integrations/she
 */

export {
  SheConfigError,
  defaultSheSocketPath,
  defaultSheTokenFile,
  resolveSheIntegrationConfig,
} from './config.js'
export type {
  SheIntegrationConfig,
  SheIntegrationConfigInput,
  SheIntegrationEnvironment,
} from './config.js'

export {
  createSheClient,
  probeSheClient,
  probeSheIntegration,
  readSheTokenFile,
} from './client.js'
export type {
  SheProbeClient,
  SheProbeFailure,
  SheProbeFailureCode,
  SheProbeOptions,
  SheProbeResult,
  SheProbeSuccess,
} from './client.js'

export {
  actorFromFeishu,
  commandInvocationFromFeishu,
  conversationFromFeishu,
  interactionResponseFromFeishu,
  replyContextFromFeishu,
} from './gateway.js'
export type {
  FeishuChatType,
  FeishuSheCommandInput,
  FeishuSheContext,
  FeishuSheInteractionInput,
} from './gateway.js'

export {
  forwardSheCommand,
  isSheCommand,
  normalizeSheCommandText,
} from './commands.js'
export type { ForwardSheCommandInput, SheCommandClient } from './commands.js'

export {
  parseSheCardInteraction,
  renderCommandResult,
  renderIntent,
  renderServerEvent,
  renderTaskEvent,
} from './render.js'
export type { FeishuRenderOutput, ParsedSheCardInteraction } from './render.js'

export {
  FeishuSheAdapter,
} from './adapter.js'
export { createFeishuSheRenderPort } from './feishu-port.js'
export type {
  FeishuRenderPort,
  FeishuSheAdapterOptions,
  SheGatewayAdapter,
  SheGatewayInboundSink,
  SheRenderReceipt,
} from './adapter.js'

export {
  FileSheEventCursorStore,
  MemorySheEventCursorStore,
  pumpSheEvents,
} from './events.js'
export type {
  SheEventCursorStore,
  SheEventPumpOptions,
  SheEventSink,
  SheEventSource,
} from './events.js'

export { SheIntegrationRuntime } from './runtime.js'
export type {
  SheIntegrationRuntimeOptions,
  SheRuntimeClient,
  SheRuntimeStartFailure,
  SheRuntimeStartResult,
  SheRuntimeStartSuccess,
  SheRuntimeState,
} from './runtime.js'
