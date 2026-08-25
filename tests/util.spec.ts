import { describe, expect, it } from 'vitest'
import { sanitizeFileName, formatBytes, shortHash, timingSafeEqualString } from '../src/util.js'
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
