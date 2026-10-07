import { describe, expect, it } from 'vitest'
import { buildSettingsScope } from '../src/runtime.js'
import { Config } from '../src/config.js'

describe('runtime: buildSettingsScope (R44, dsh 0.2.0 API)', () => {
  it('wraps update with the entry-id namespace', async () => {
    const updates: Array<[string, object]> = []
    const scope = buildSettingsScope(
      { update: async (ns, patch) => { updates.push([ns, patch]) } },
      () => undefined,
    )
    await scope!.update({ chatPresets: { s: 'standard' } })
    expect(updates).toEqual([['feishu4dsh', { chatPresets: { s: 'standard' } }]])
  })

  it('returns undefined and notifies once when the host lacks the API', () => {
    const notified: string[] = []
    for (const bad of [undefined, {}, { update: 42 }]) {
      const scope = buildSettingsScope(bad as never, line => { notified.push(line) })
      expect(scope).toBeUndefined()
    }
    expect(notified).toHaveLength(3)
    expect(notified[0]).toContain('持久化已禁用')
  })

  it('the runtime-state config fields are volatile (writable through the 0.2.0 API)', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict ?? {}
    for (const field of ['chatWorkspaces', 'chatPresets', 'chatSessions', 'chatActiveGen',
      'userWorkspaces', 'modelCatalog', 'modelEfforts', 'chatReasoning']) {
      expect(dict[field]?.meta?.volatile, field).toBe(true)
    }
  })
})
