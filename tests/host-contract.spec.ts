import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TURN_END_KINDS } from '../src/host.js'

/**
 * R47 (F2): the turn-close vocabulary is a HOST contract — `TurnEndReasonMap`
 * in @deepseek-ai/dsh-session types ships exactly
 * `completed | aborted | blocked | error | max-tokens` (+ null since 0.2.0).
 * The v0.12.1 incident: fixtures invented `'complete'`, the A1 hardening
 * anchored on it, and every real successful close fell into the failure
 * branch. This scan makes that class of drift CI-red instead of review-luck.
 */
describe('host contract: turn/end reason vocabulary', () => {
  const ALLOWED = new Set<string>([...TURN_END_KINDS])

  it('the shipped constant matches the host TurnEndReasonMap keys', () => {
    expect([...TURN_END_KINDS].sort()).toEqual(['aborted', 'blocked', 'completed', 'error', 'max-tokens'])
  })

  it('no src file compares reason.kind against a string outside the host vocabulary', () => {
    const offenders: string[] = []
    for (const name of readdirSync(join(import.meta.dirname, '..', 'src'))) {
      if (!name.endsWith('.ts')) continue
      const source = readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8')
      // Matches: reason.kind === 'x' / !== 'x' and kind: 'x' literal comparisons.
      for (const match of source.matchAll(/reason\.kind\s*[!=]==\s*'([a-z-]+)'/g)) {
        const literal = String(match[1])
        if (!ALLOWED.has(literal)) offenders.push(`${name}: reason.kind compared to '${literal}'`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('test fixtures may only build turn/end reasons from the same vocabulary', () => {
    // Self-check for the fixture corpus: the sweep (R47 F3) must not regress.
    const source = readFileSync(join(import.meta.dirname, 'bridge.spec.ts'), 'utf8')
    // Only turn/end reason objects — other fixtures legitimately use `kind`
    // (approval outcomes, command results), so match the nested shape.
    const found = [...source.matchAll(/reason:\s*\{[^{}]*?kind:\s*'([a-z-]+)'/g)].map(m => String(m[1]))
    const fake = found.filter(kind => !ALLOWED.has(kind))
    expect([...new Set(fake)]).toEqual([])
  })
})
