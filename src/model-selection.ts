/**
 * Per-agent model selection (R7/R8): the pure logic behind `/status`'s
 * "real current model" display and `/model`'s session-scoped live switch.
 *
 * The host's `installModelSelection` (web/headless `selectionFor`) routes the
 * agent's next request to `selection.current`; this module builds that mutable
 * selection, reads what a session actually ran last from its request header,
 * and decides what `/status` should display. No host imports here.
 * @module feishu4dsh/model-selection
 */

import type { HostAgentOptions, HostModelSelection, HostRequestHeaderConfig, HostSession } from './host.js'

/** A mutable per-agent selection handed to the host's installer. */
export interface MutableSelection {
  /** The pinned choice; when unset the getter falls back lazily. */
  current: HostModelSelection | undefined
  assembled: unknown
}

/**
 * Reasoning-effort levels `/model effort` accepts (R28). `default` is the
 * RESET value, not a wire value: it means the request carries NO explicit
 * `reasoning_effort` and the model's built-in behaviour applies. Align with
 * dsh when its enumeration grows (owner enumeration: default/low/high/max).
 */
export const EFFORT_LEVELS = ['default', 'low', 'high', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Resolve the reasoning effort a composed selection should carry: reads the
 * per-model preference table and returns undefined for "no preference" —
 * which keeps the base selection (and thus the host default) intact.
 */
export type EffortResolver = (selection: HostModelSelection) => string | undefined

/** Narrow a request-header payload into a concrete selection, if usable. */
function headerToSelection(config: HostRequestHeaderConfig | undefined): HostModelSelection | undefined {
  const provider = config?.provider
  const model = config?.model
  if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
  return config?.reasoningEffort === undefined
    ? { provider, model }
    : { provider, model, reasoningEffort: config.reasoningEffort }
}

/**
 * What this session actually ran last, from its logged request header.
 * Returns undefined on older hosts (no `requestHeader`), before any turn,
 * or when the logged header carries no usable provider/model.
 */
export function readLoggedSelection(
  session: Pick<HostSession, 'requestHeader'> | undefined,
): HostModelSelection | undefined {
  const read = session?.requestHeader
  if (typeof read !== 'function') return undefined
  try {
    return headerToSelection(read()?.config)
  } catch {
    // A broken host hook must never break /status; fall through to defaults.
    return undefined
  }
}

/** Render one selection as `provider/model` (bare `model` without a provider). */
export function formatSelection(selection: {
  readonly model?: string | undefined
  readonly provider?: string | undefined
}): string | undefined {
  const model = selection.model
  if (model === undefined || model === '') return undefined
  return selection.provider === undefined || selection.provider === ''
    ? model
    : `${selection.provider}/${model}`
}

/** The deployment default as a concrete selection, or undefined when unadvertised. */
export function defaultSelectionOf(defaults: HostAgentOptions | undefined): HostModelSelection | undefined {
  if (defaults === undefined) return undefined
  const provider = defaults.provider
  const model = defaults.model
  if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
  return { provider, model }
}

/** One lazy fallback chain: session log first, deployment default second. */
export type SelectionFallback = () => HostModelSelection | undefined

/**
 * Build the mutable selection installed via the host's `installModelSelection`.
 * Mirrors the web host's `selectionFor`: an explicit pick wins; otherwise the
 * getter resolves lazily (session log → default), so `/model` only has to set
 * `current` and the next step routes there.
 */
export class AgentModelSelection implements MutableSelection {
  private picked: HostModelSelection | undefined

  constructor(
    private readonly fallback: SelectionFallback,
    private readonly effortOf?: EffortResolver,
  ) {}

  get current(): HostModelSelection | undefined {
    const base = this.picked ?? this.fallback()
    if (base === undefined || base.reasoningEffort !== undefined || this.effortOf === undefined) return base
    // R28: compose the per-model preference WITHOUT overwriting an explicit
    // effort the base already carries (log or default). The channel keeps the
    // preference table, so both installer paths see the same composition.
    const effort = this.effortOf(base)
    return effort === undefined ? base : { ...base, reasoningEffort: effort }
  }

  set current(next: HostModelSelection | undefined) {
    this.picked = next
  }

  /** Whether the operator pinned an explicit model on this session. */
  get pinned(): boolean {
    return this.picked !== undefined
  }

  /** Drop the pin; the getter falls back to log/default again. */
  reset(): void {
    this.current = undefined
  }

  assembled: unknown = undefined
}

export function createAgentModelSelection(fallback: SelectionFallback, effortOf?: EffortResolver): AgentModelSelection {
  return new AgentModelSelection(fallback, effortOf)
}


/**
 * Install the same per-agent mutable selection used by dsh's Web/headless
 * entry points, but WITHOUT depending on a host-provided `installModelSelection`
 * service (which dsh does not expose as a Cordis service).
 *
 * It registers two waterfall listeners on the agent's scoped Cordis context:
 * 1. `system-prompt/assemble` — snapshot the selected model and inject
 *    provider/model variables into the assembled prompt;
 * 2. `agent/request` — force the next request to route to the selected model.
 *
 * Returns a disposer; when the agent context is disposed, its listeners die
 * with it, so callers may ignore the disposer.
 */
export function installAgentModelSelection(
  agentCtx: { on(event: string, listener: (...args: never[]) => unknown): () => void },
  selection: AgentModelSelection,
): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (...args: never[]) => {
    const next = args[2] as unknown as () => Promise<{ variables?: Record<string, unknown> }>
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...(assembled?.variables ?? {}),
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (...args: never[]) => {
    const next = args[1] as unknown as () => Promise<Record<string, unknown>>
    const resolved = await next()
    const selected = selection.assembled as HostModelSelection | undefined
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved ?? {}
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}

/** What `/status` should show about the model, plus where it came from. */
export interface ModelDisplay {
  readonly text: string
  /**
   * True when this is the deployment default shown because the session never
   * ran a turn (and nothing was pinned); renders with the “尚未开始对话” tag.
   */
  readonly isDefaultNotStarted: boolean
}

/**
 * Resolve the model line for `/status`.
 *
 * Priority: pinned `/model` choice → session's logged request header →
 * deployment default. When the session cannot even be asked (older host,
 * no agent yet) the default is shown WITHOUT the not-started tag — same
 * output as before R7.
 */
export function displayedModelOf(
  selection: MutableSelection | undefined,
  session: Pick<HostSession, 'requestHeader'> | undefined,
  defaults: HostModelSelection | undefined,
): ModelDisplay | undefined {
  const hasPin = (selection as { pinned?: boolean } | undefined)?.pinned === true
  if (hasPin) {
    const pinned = selection?.current
    const text = pinned === undefined ? undefined : formatSelection(pinned)
    if (text !== undefined) return { text, isDefaultNotStarted: false }
  }
  if (typeof session?.requestHeader === 'function') {
    const logged = readLoggedSelection(session)
    if (logged !== undefined) {
      const text = formatSelection(logged)
      if (text !== undefined) return { text, isDefaultNotStarted: false }
    }
    // Asked and found nothing: the session has not started a turn yet.
    const text = formatSelection(defaults ?? {})
    return text === undefined ? undefined : { text, isDefaultNotStarted: true }
  }
  // Cannot ask (no agent yet, or an old host): behave exactly as before R7.
  const text = formatSelection(defaults ?? {})
  return text === undefined ? undefined : { text, isDefaultNotStarted: false }
}

/**
 * Parse a `/model <provider>/<model>` target: provider is everything before
 * the FIRST slash, model the rest (so slashed model names survive). Missing
 * slash or an empty half refuses.
 */
export function parseModelTarget(raw: string): HostModelSelection | undefined {
  const text = raw.trim()
  const slash = text.indexOf('/')
  if (slash <= 0 || slash >= text.length - 1) return undefined
  const provider = text.slice(0, slash).trim()
  const model = text.slice(slash + 1).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}
