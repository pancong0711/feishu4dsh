import { describe, expect, it } from 'vitest'
import { buildSettingsScope, writeModelEfforts } from '../src/runtime.js'
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

  it('wraps mutate with the entry-id namespace (R55-D2)', async () => {
    const mutations: Array<[string, readonly { op: string; path: readonly string[] }[]]> = []
    const scope = buildSettingsScope(
      {
        update: async () => undefined,
        mutate: async (ns, ops) => { mutations.push([ns, ops]) },
      },
      () => undefined,
    )
    await scope!.mutate([{ op: 'unset', path: ['modelEfforts', 'p/m'] }])
    expect(mutations).toEqual([['feishu4dsh', [{ op: 'unset', path: ['modelEfforts', 'p/m'] }]]])
  })

  it('uses unset operations when a model effort key is removed (R55-D2)', async () => {
    const updates: object[] = []
    const mutations: Array<readonly { op: string; path: readonly string[]; value?: unknown }[]> = []
    const scope = {
      update: async (patch: object) => { updates.push(patch) },
      mutate: async (ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => { mutations.push(ops) },
    }
    await writeModelEfforts(scope, { 'p2/m2': 'low' }, ['p1/m1'])
    expect(updates).toEqual([])
    expect(mutations).toEqual([[
      { op: 'unset', path: ['modelEfforts', 'p1/m1'] },
      { op: 'set', path: ['modelEfforts', 'p2/m2'], value: 'low' },
    ]])

    await writeModelEfforts(scope, { 'p2/m2': 'high' })
    expect(updates).toEqual([{ modelEfforts: { 'p2/m2': 'high' } }])
  })

  it('rejects removals loudly when the host has no mutate API', async () => {
    const scope = buildSettingsScope({ update: async () => undefined }, () => undefined)
    await expect(scope!.mutate([{ op: 'unset', path: ['modelEfforts', 'p/m'] }]))
      .rejects.toThrow('settings.mutate API 不可用')
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
