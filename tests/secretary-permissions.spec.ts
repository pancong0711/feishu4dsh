import { describe, expect, it } from 'vitest'
import { SHE_PERMISSION_RULES } from '../src/secretary/permissions.js'

describe('SHE permission rules', () => {
  it('uses the action ids OpenCode actually checks', () => {
    const shell = SHE_PERMISSION_RULES.filter(rule => rule.action === 'shell')
    expect(shell.length).toBeGreaterThan(0)
    expect(shell.some(rule => rule.resource === '*git commit*' && rule.effect === 'deny')).toBe(true)
    expect(shell.some(rule => rule.resource === '*git push*' && rule.effect === 'deny')).toBe(true)
    // `bash` was the original wrong guess: OpenCode's real shell action id is
    // `shell`, so a `bash` rule is silently ignored.
    expect(SHE_PERMISSION_RULES.some(rule => rule.action === 'bash')).toBe(false)
    expect(SHE_PERMISSION_RULES.some(rule => rule.action === 'subagent' && rule.effect === 'deny')).toBe(true)
  })

  it('keeps file-tool and external-directory denials as defense in depth', () => {
    expect(SHE_PERMISSION_RULES).toContainEqual({ action: 'external_directory', resource: '*', effect: 'deny' })
    expect(SHE_PERMISSION_RULES).toContainEqual({ action: 'read', resource: '*.env', effect: 'deny' })
    expect(SHE_PERMISSION_RULES).toContainEqual({ action: 'webfetch', resource: '*', effect: 'deny' })
    expect(SHE_PERMISSION_RULES).toContainEqual({ action: 'websearch', resource: '*', effect: 'deny' })
  })
})
