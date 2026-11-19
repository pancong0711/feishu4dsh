import { describe, expect, it } from 'vitest'
import type { HostModelSelection, HostRequestHeaderConfig, HostSession } from '../src/host.js'
import {
  createAgentModelSelection,
  EFFORT_LEVELS,
  installAgentModelSelection,
  defaultSelectionOf,
  displayedModelOf,
  formatSelection,
  parseModelTarget,
  readLoggedRoute,
  readLoggedSelection,
} from '../src/model-selection.js'

/** A fake session whose `requestHeader()` resolves to whatever the reader says. */
function sessionWith(reader: () => { config?: HostRequestHeaderConfig } | undefined): Pick<HostSession, 'requestHeader'> {
  return { requestHeader: reader }
}

describe('model-selection: effort composition (R28)', () => {
  it('composes the per-model effort preference into the lazy fallback', () => {
    const selection = createAgentModelSelection(
      () => ({ provider: 'p1', model: 'm1' }),
      sel => (sel.model === 'm1' ? 'high' : undefined),
    )
    expect(selection.current).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })

  it('never overwrites an explicit effort the base already carries', () => {
    const selection = createAgentModelSelection(
      () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'low' }),
      () => 'high',
    )
    expect(selection.current).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('a pinned model still receives the composed effort', () => {
    const selection = createAgentModelSelection(() => ({ provider: 'p1', model: 'm1' }), () => 'max')
    selection.current = { provider: 'p2', model: 'm2' }
    expect(selection.current).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'max' })
  })

  it('an undefined resolver result keeps the base selection untouched', () => {
    const selection = createAgentModelSelection(() => ({ provider: 'p1', model: 'm1' }), () => undefined)
    expect(selection.current).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('EFFORT_LEVELS stays aligned with the owner enumeration (D4/D8)', () => {
    expect(EFFORT_LEVELS).toEqual(['default', 'low', 'high', 'max'])
  })
})

describe('model-selection: parseModelTarget', () => {
  it('parses provider/model on the first slash and trims whitespace', () => {
    expect(parseModelTarget(' p2/m2 ')).toEqual({ provider: 'p2', model: 'm2' })
    expect(parseModelTarget('openrouter/deepseek/r1')).toEqual({ provider: 'openrouter', model: 'deepseek/r1' })
  })

  it('refuses a provider containing whitespace (R43)', () => {
    // `/model remove p/m` must not become provider "remove p".
    expect(parseModelTarget('remove p9/m9')).toBeUndefined()
    expect(parseModelTarget('rm p9/m9')).toBeUndefined()
  })

  it('refuses a missing slash or empty halves', () => {
    expect(parseModelTarget('abc')).toBeUndefined()
    expect(parseModelTarget('')).toBeUndefined()
    expect(parseModelTarget('p/')).toBeUndefined()
    expect(parseModelTarget('/m')).toBeUndefined()
    expect(parseModelTarget('/')).toBeUndefined()
    expect(parseModelTarget('  /  ')).toBeUndefined()
  })
})

describe('model-selection: readLoggedSelection', () => {
  it('returns undefined without a session, capability, config, or halves', () => {
    expect(readLoggedSelection(undefined)).toBeUndefined()
    expect(readLoggedSelection({} as Pick<HostSession, 'requestHeader'>)).toBeUndefined() // old host: no method
    expect(readLoggedSelection(sessionWith(() => undefined))).toBeUndefined()
    expect(readLoggedSelection(sessionWith(() => ({})))).toBeUndefined()
    expect(readLoggedSelection(sessionWith(() => ({ config: { model: 'm1' } })))).toBeUndefined()
    expect(readLoggedSelection(sessionWith(() => ({ config: { provider: 'p1' } })))).toBeUndefined()
    const boom = (): never => { throw new Error('host broke') }
    expect(readLoggedSelection({ requestHeader: boom })).toBeUndefined()
  })

  it('readLoggedRoute strips the previous effort so it cannot shadow /model effort', () => {
    const session = sessionWith(() => ({
      config: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    }))
    expect(readLoggedRoute(session)).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('reads provider/model (and reasoningEffort when logged)', () => {
    expect(readLoggedSelection(sessionWith(() => ({ config: { provider: 'p1', model: 'm1' } }))))
      .toEqual({ provider: 'p1', model: 'm1' })
    expect(readLoggedSelection(sessionWith(() => ({ config: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }))))
      .toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  })
})

describe('model-selection: AgentModelSelection', () => {
  it('falls back lazily while unpinned and prefers the pin once set', () => {
    let fallback: HostModelSelection | undefined = { provider: 'pd', model: 'md' }
    const selection = createAgentModelSelection(() => fallback)
    expect(selection.pinned).toBe(false)
    expect(selection.current).toEqual({ provider: 'pd', model: 'md' })

    selection.current = { provider: 'p2', model: 'm2' }
    expect(selection.pinned).toBe(true)
    expect(selection.current).toEqual({ provider: 'p2', model: 'm2' })
    // The fallback is no longer consulted.
    fallback = undefined
    expect(selection.current).toEqual({ provider: 'p2', model: 'm2' })

    // Resetting drops the pin; with no default left the getter yields undefined.
    selection.reset()
    expect(selection.pinned).toBe(false)
    expect(selection.current).toBeUndefined()
  })
})

describe('model-selection: displayedModelOf', () => {
  const defaults: HostModelSelection = { provider: 'pd', model: 'md' }

  it('pin wins over the logged header and over defaults', () => {
    const pinned = createAgentModelSelection(() => defaults)
    pinned.current = { provider: 'p_new', model: 'm_new' }
    const shown = displayedModelOf(
      pinned,
      sessionWith(() => ({ config: { provider: 'p_old', model: 'm_old' } })),
      defaults,
    )
    expect(shown).toEqual({ text: 'p_new/m_new', isDefaultNotStarted: false })
  })

  it('logged header beats the default and carries no tag', () => {
    const shown = displayedModelOf(
      undefined,
      sessionWith(() => ({ config: { provider: 'p1', model: 'm1' } })),
      defaults,
    )
    expect(shown).toEqual({ text: 'p1/m1', isDefaultNotStarted: false })
  })

  it('asked-but-empty header tags the default as not-started', () => {
    for (const reader of [(): undefined => undefined, () => ({}), (): never => { throw new Error('x') }]) {
      expect(displayedModelOf(undefined, sessionWith(reader), defaults))
        .toEqual({ text: 'pd/md', isDefaultNotStarted: true })
    }
  })

  it('without the capability the default shows untagged (pre-R7 behaviour)', () => {
    expect(displayedModelOf(undefined, undefined, defaults))
      .toEqual({ text: 'pd/md', isDefaultNotStarted: false })
    expect(displayedModelOf(undefined, {}, defaults)) // session object without requestHeader
      .toEqual({ text: 'pd/md', isDefaultNotStarted: false })
  })

  it('renders nothing when nothing is known', () => {
    expect(displayedModelOf(undefined, undefined, undefined)).toBeUndefined()
    expect(displayedModelOf(createAgentModelSelection(() => undefined), undefined, undefined)).toBeUndefined()
  })
})

describe('model-selection: local host-waterfall installer (R55)', () => {
  type Handler = (...args: never[]) => unknown
  function eventBus() {
    const handlers = new Map<string, Handler>()
    return {
      ctx: {
        on(event: string, listener: Handler) {
          handlers.set(event, listener)
          return () => handlers.delete(event)
        },
      },
      async call(event: string, ...args: unknown[]): Promise<unknown> {
        const handler = handlers.get(event)
        if (handler === undefined) throw new Error(`missing handler: ${event}`)
        return (handler as (...args: unknown[]) => unknown)(...args)
      },
    }
  }

  it('injects the composed effort through the real agent/request waterfall', async () => {
    const bus = eventBus()
    const selection = createAgentModelSelection(
      () => ({ provider: 'p1', model: 'm1' }),
      () => 'high',
    )
    const dispose = installAgentModelSelection(bus.ctx, selection)
    try {
      const assembled = await bus.call(
        'system-prompt/assemble', {}, {},
        async () => ({ variables: { existing: true } }),
      ) as { variables: Record<string, unknown> }
      expect(assembled.variables).toEqual({ existing: true, provider: 'p1', model: 'm1' })
      const request = await bus.call(
        'agent/request', {},
        async () => ({ provider: 'old', model: 'old', reasoningEffort: 'low', maxTokens: 9 }),
      ) as Record<string, unknown>
      expect(request).toEqual({
        provider: 'p1', model: 'm1', reasoningEffort: 'high', maxTokens: 9,
      })
    } finally {
      dispose()
    }
  })

  it('appends the same model-switch notice as dsh on a route change', async () => {
    const bus = eventBus()
    const selection = createAgentModelSelection(() => ({ provider: 'p1', model: 'm1' }))
    selection.assembled = { provider: 'p2', model: 'm2' }
    const dispose = installAgentModelSelection(bus.ctx, selection)
    try {
      const decision = await bus.call(
        'agent/pre-step',
        {
          agent: { session: { requestHeader: () => ({ config: { provider: 'p1', model: 'm1' } }) } },
          messages: [],
          step: 2,
          signal: { aborted: false },
        },
        async () => ({ kind: 'enter', messages: [] }),
      ) as { kind: string; messages: { role: string; content: { text: string }[]; source: { kind: string } }[] }
      expect(decision.kind).toBe('enter')
      expect(decision.messages).toHaveLength(1)
      expect(decision.messages[0]?.role).toBe('user')
      expect(decision.messages[0]?.source.kind).toBe('model-selection')
      expect(decision.messages[0]?.content[0]?.text).toContain('p1/m1')
      expect(decision.messages[0]?.content[0]?.text).toContain('p2/m2')
    } finally {
      dispose()
    }
  })
})

describe('model-selection: formatting & default folding', () => {
  it('formats with or without a provider and refuses empty models', () => {
    expect(formatSelection({ provider: 'p1', model: 'm1' })).toBe('p1/m1')
    expect(formatSelection({ model: 'm1' })).toBe('m1')
    expect(formatSelection({ provider: 'p1', model: '' })).toBeUndefined()
    expect(formatSelection({})).toBeUndefined()
  })

  it('folds agent options into a concrete default only when complete', () => {
    expect(defaultSelectionOf(undefined)).toBeUndefined()
    expect(defaultSelectionOf({})).toBeUndefined()
    expect(defaultSelectionOf({ model: 'm1' })).toBeUndefined()
    expect(defaultSelectionOf({ provider: '', model: 'm1' })).toBeUndefined()
    expect(defaultSelectionOf({ provider: 'p1', model: 'm1' })).toEqual({ provider: 'p1', model: 'm1' })
  })
})
