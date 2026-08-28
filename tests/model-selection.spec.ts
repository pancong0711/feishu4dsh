import { describe, expect, it } from 'vitest'
import type { HostModelSelection, HostRequestHeaderConfig, HostSession } from '../src/host.js'
import {
  createAgentModelSelection,
  EFFORT_LEVELS,
  defaultSelectionOf,
  displayedModelOf,
  formatSelection,
  parseModelTarget,
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
