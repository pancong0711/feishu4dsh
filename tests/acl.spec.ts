import { describe, expect, it } from 'vitest'
import { resolveAuthorization, mayApprove, describeAuthorization } from '../src/acl.js'

describe('resolveAuthorization', () => {
  it('builds sets from the configured lists', () => {
    const auth = resolveAuthorization({
      senderAllowlist: ['ou_a', 'ou_b'],
      groupAllowlist: ['oc_g'],
      approvers: ['ou_admin'],
    })
    expect(auth.directSenders.has('ou_a')).toBe(true)
    expect(auth.groups.has('oc_g')).toBe(true)
    expect(auth.approvers.has('ou_admin')).toBe(true)
  })
})

describe('mayApprove', () => {
  it('named approvers decide when configured', () => {
    const auth = resolveAuthorization({ senderAllowlist: [], groupAllowlist: [], approvers: ['ou_admin'] })
    expect(mayApprove(auth, 'ou_admin', false)).toBe(true)
    expect(mayApprove(auth, 'ou_driver', true)).toBe(false)
  })

  it('the chat driver decides when no approver list exists', () => {
    const auth = resolveAuthorization({ senderAllowlist: [], groupAllowlist: [], approvers: [] })
    expect(mayApprove(auth, 'ou_anyone', true)).toBe(true)
    expect(mayApprove(auth, 'ou_anyone', false)).toBe(false)
  })
})

describe('describeAuthorization', () => {
  it('states an open reach', () => {
    const auth = resolveAuthorization({ senderAllowlist: [], groupAllowlist: [], approvers: [] })
    const line = describeAuthorization(auth)
    expect(line).toContain('anyone the app is visible to')
    expect(line).toContain('any group the bot joins')
  })

  it('states a narrowed reach', () => {
    const auth = resolveAuthorization({ senderAllowlist: ['ou_a'], groupAllowlist: ['oc_g'], approvers: ['ou_x', 'ou_y'] })
    const line = describeAuthorization(auth)
    expect(line).toContain('1 allowlisted sender(s)')
    expect(line).toContain('1 allowlisted group(s)')
    expect(line).toContain('2 named approver(s)')
  })
})
