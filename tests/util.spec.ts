import { describe, expect, it } from 'vitest'
import { sanitizeFileName, formatBytes, shortHash, timingSafeEqualString, splitWithCodeFences } from '../src/util.js'
import { resolveLocale } from '../src/strings.js'

describe('sanitizeFileName', () => {
  it('strips path traversal', () => {
    expect(sanitizeFileName('../../etc/passwd', 'f')).toBe('passwd')
    expect(sanitizeFileName('a/b/c.txt', 'f')).toBe('c.txt')
    expect(sanitizeFileName('\\win\\path.txt', 'f')).toBe('path.txt')
  })

  it('strips control chars and leading dots', () => {
    expect(sanitizeFileName('...hidden', 'f')).toBe('hidden')
    expect(sanitizeFileName('\u0000evil', 'f')).toBe('evil')
    expect(sanitizeFileName('   ', 'f')).toBe('f')
    expect(sanitizeFileName('', 'f')).toBe('f')
  })

  it('caps very long names', () => {
    const name = 'x'.repeat(500) + '.txt'
    expect(sanitizeFileName(name, 'f').length).toBeLessThanOrEqual(120)
  })
})

describe('formatBytes', () => {
  it('renders units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
    expect(formatBytes(-1)).toBe('?')
  })
})

describe('shortHash', () => {
  it('is stable and bounded', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'))
    expect(shortHash('abc', 8)).toHaveLength(8)
    expect(shortHash('abc')).not.toBe(shortHash('abd'))
  })
})

describe('timingSafeEqualString', () => {
  it('compares safely', () => {
    expect(timingSafeEqualString('secret', 'secret')).toBe(true)
    expect(timingSafeEqualString('secret', 'secret2')).toBe(false)
    expect(timingSafeEqualString('', '')).toBe(true)
  })
})

describe('resolveLocale', () => {
  it('honours a pinned locale', () => {
    expect(resolveLocale('en-US', 'zh')).toBe('en-US')
    expect(resolveLocale('zh-CN', 'fr')).toBe('zh-CN')
  })

  it('auto defaults to zh-CN without a hint', () => {
    expect(resolveLocale('auto')).toBe('zh-CN')
    expect(resolveLocale('auto', '')).toBe('zh-CN')
  })

  it('auto follows the reader hint', () => {
    expect(resolveLocale('auto', 'zh-Hans')).toBe('zh-CN')
    expect(resolveLocale('auto', 'en')).toBe('en-US')
    expect(resolveLocale('auto', 'ja')).toBe('en-US')
  })
})

describe('splitWithCodeFences (R48)', () => {
  it('returns the text untouched when within the limit', () => {
    expect(splitWithCodeFences('hello', 3000)).toEqual(['hello'])
  })

  it('splits under the limit and preserves the concatenation', () => {
    const text = 'x'.repeat(7000)
    const chunks = splitWithCodeFences(text, 3000)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3000)
    expect(chunks.join('')).toBe(text)
  })

  it('closes and reopens a fenced block at a boundary', () => {
    const text = 'head\n\n```ts\n' + 'const a = 1\n'.repeat(400) + '```\n'
    const chunks = splitWithCodeFences(text, 3000)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      const fences = (c.match(/^```/gm) ?? []).length
      expect(fences % 2).toBe(0) // balanced inside every chunk
    }
    // The reopening chunk restores the original language tag.
    expect(chunks[1]?.startsWith('```ts')).toBe(true)
  })

  it('prefers breaking before a heading when near the limit', () => {
    const filler = 'line\n'.repeat(600)
    const text = `${filler}## Next section\nbody`
    const chunks = splitWithCodeFences(text, 3000)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[1]?.startsWith('## Next section')).toBe(true)
  })

  it('hard-wraps a single line longer than the limit', () => {
    const text = 'x'.repeat(7000)
    const chunks = splitWithCodeFences(text, 3000)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3000)
    expect(chunks.join('')).toBe(text)
  })

  it('never emits a chunk over the limit, even inside a long fence', () => {
    const body = '```ts\n' + 'X'.repeat(9000) + '\n```'
    const chunks = splitWithCodeFences(body, 3000)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3000)
      // every chunk opens and closes its own fence
      expect((c.match(/^```/gm) ?? []).length % 2).toBe(0)
    }
  })

  it('keeps blank lines (markdown paragraph breaks)', () => {
    const body = 'para\n\n'.repeat(2000)
    const chunks = splitWithCodeFences(body, 3000)
    // Rejoining the chunks with newlines reconstructs the source.
    expect(chunks.join('\n')).toBe(body)
  })

  it('degrades safely under a tiny limit (progress guaranteed)', () => {
    const chunks = splitWithCodeFences('X'.repeat(100), 10)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10)
    expect(chunks.join('')).toBe('X'.repeat(100))
  })

  it('holds both invariants across generated inputs (size + fence balance)', () => {
    // Deterministic pseudo-random generator (no external dependency).
    let seed = 4242
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const LIMIT = 3000
    for (let t = 0; t < 400; t++) {
      const parts: string[] = []
      const n = Math.floor(rnd() * 40)
      for (let i = 0; i < n; i++) {
        const k = rnd()
        if (k < 0.15) parts.push('')
        else if (k < 0.3) parts.push('```' + (rnd() < 0.5 ? 'js' : ''))
        else if (k < 0.65) parts.push('x'.repeat(Math.floor(rnd() * LIMIT * 2)))
        else parts.push('word '.repeat(Math.floor(rnd() * 40)))
      }
      const body = parts.join('\n')
      const sourceFences = (body.match(/^```/gm) ?? []).length
      if (sourceFences % 2 !== 0) continue // only balanced sources are meaningful
      const chunks = splitWithCodeFences(body, LIMIT)
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(LIMIT)
        expect((c.match(/^```/gm) ?? []).length % 2).toBe(0)
      }
    }
  })
})
