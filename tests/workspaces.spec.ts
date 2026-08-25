import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCatalog, isAllowed, listWorkspaces, resolveCdTarget, registeredPathsOf, normalizeWorkspacePath, resolveWorkspaceDirectory } from '../src/workspaces.js'

let root: string
let defaultWs: string
let sibling: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'feishu4dsh-ws-'))
  defaultWs = join(root, 'proj-default')
  sibling = join(root, 'proj-sibling')
  outside = await mkdtemp(join(tmpdir(), 'feishu4dsh-out-'))
  await mkdir(defaultWs, { recursive: true })
  await mkdir(sibling, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('buildCatalog', () => {
  it('canonicalizes the default and folds registered workspaces', async () => {
    const catalog = await buildCatalog(defaultWs, [sibling], [])
    expect(catalog.defaultWorkspace.path).toBe(defaultWs)
    expect(catalog.defaultWorkspace.name).toBe('proj-default')
    expect(catalog.defaultWorkspace.isDefault).toBe(true)
    expect(catalog.known).toHaveLength(1)
    expect(catalog.known[0]?.path).toBe(sibling)
    expect(catalog.known[0]?.isDefault).toBe(false)
  })

  it('dedupes the default out of registered paths', async () => {
    const catalog = await buildCatalog(defaultWs, [defaultWs, sibling], [])
    expect(catalog.known).toHaveLength(1)
  })
})

describe('isAllowed', () => {
  it('always admits the default and registered workspaces', async () => {
    const catalog = await buildCatalog(defaultWs, [sibling], [])
    expect(isAllowed(defaultWs, catalog)).toBe(true)
    expect(isAllowed(sibling, catalog)).toBe(true)
  })

  it('with no roots, rejects arbitrary paths', async () => {
    const catalog = await buildCatalog(defaultWs, [], [])
    expect(isAllowed(outside, catalog)).toBe(false)
    expect(isAllowed(join(root, 'anything'), catalog)).toBe(false)
  })

  it('with roots, admits paths inside a root', async () => {
    const catalog = await buildCatalog(defaultWs, [], [root])
    expect(isAllowed(sibling, catalog)).toBe(true)
    expect(isAllowed(join(root, 'subproject'), catalog)).toBe(true)
    expect(isAllowed(outside, catalog)).toBe(false)
  })
})

describe('listWorkspaces', () => {
  it('marks current and default, stable order, deduped', async () => {
    const catalog = await buildCatalog(defaultWs, [sibling], [])
    const list = listWorkspaces(catalog, sibling)
    expect(list).toHaveLength(2)
    expect(list[0]?.path).toBe(defaultWs)
    expect(list[0]?.isDefault).toBe(true)
    expect(list[0]?.current).toBe(false)
    expect(list[1]?.path).toBe(sibling)
    expect(list[1]?.current).toBe(true)
  })
})

describe('resolveCdTarget', () => {
  it('resolves an exact registered name', async () => {
    const catalog = await buildCatalog(defaultWs, [sibling], [])
    const resolved = await resolveCdTarget('proj-sibling', catalog)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.entry.path).toBe(sibling)
  })

  it('refuses empty input', async () => {
    const catalog = await buildCatalog(defaultWs, [], [])
    const resolved = await resolveCdTarget('   ', catalog)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.refusal.code).toBe('empty')
  })

  it('resolves a relative path against the default parent when inside a root', async () => {
    const catalog = await buildCatalog(defaultWs, [], [root])
    const resolved = await resolveCdTarget('proj-sibling', catalog)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.entry.path).toBe(sibling)
  })

  it('refuses a path that exists but is not allowed', async () => {
    const catalog = await buildCatalog(defaultWs, [], [])
    const resolved = await resolveCdTarget(outside, catalog)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.refusal.code).toBe('not_allowed')
  })

  it('refuses a missing path as not found', async () => {
    const catalog = await buildCatalog(defaultWs, [], [root])
    const resolved = await resolveCdTarget('no-such-dir', catalog)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.refusal.code).toBe('not_found')
  })

  it('refuses ambiguous names', async () => {
    const a = join(root, 'x', 'app'); const b = join(root, 'y', 'app')
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true })
    const catalog = await buildCatalog(defaultWs, [a, b], [])
    const resolved = await resolveCdTarget('app', catalog)
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.refusal.code).toBe('ambiguous')
      if (resolved.refusal.code === 'ambiguous') expect(resolved.refusal.matches).toHaveLength(2)
    }
  })
})

describe('registeredPathsOf', () => {
  it('tolerates absence and broken registries', () => {
    expect(registeredPathsOf(undefined)).toEqual([])
    expect(registeredPathsOf({})).toEqual([])
    const broken = { list: () => { throw new Error('boom') } }
    expect(registeredPathsOf(broken)).toEqual([])
  })

  it('reads paths from a working registry', () => {
    const registry = { list: () => [{ path: '/a' }, { path: '/b' }] }
    expect(registeredPathsOf(registry)).toEqual(['/a', '/b'])
  })
})

describe('R14 中文路径兼容（normalizeWorkspacePath）', () => {
  it('strips full-width space U+3000 in every segment', () => {
    expect(normalizeWorkspacePath('/home/user/20260730　-　示例目录')).toBe('/home/user/20260730-示例目录')
    expect(normalizeWorkspacePath('/home/user/A　B/读　书')).toBe('/home/user/AB/读书')
  })

  it('strips ASCII spaces, tabs and NBSP-like whitespace', () => {
    expect(normalizeWorkspacePath('/home/user/20260730 - 示例目录')).toBe('/home/user/20260730-示例目录')
    expect(normalizeWorkspacePath('/home/user/a\tb/c d')).toBe('/home/user/ab/cd')
    expect(normalizeWorkspacePath('/home/user/a\u00a0b')).toBe('/home/user/ab')
  })

  it('NFC-normalizes composed forms onto one spelling', () => {
    // 'café' 的 NFD 形式（e + U+0301）折叠为 NFC 的 é；中文路径里也常见
    // 全角/半角混合，NFC 保证比较键唯一。
    const nfd = 'café'.normalize('NFD')
    expect(normalizeWorkspacePath(nfd)).toBe('café'.normalize('NFC'))
  })

  it('preserves separators and leading slashes', () => {
    expect(normalizeWorkspacePath('/a//b c/')).toBe('/a//bc/')
  })

  it('keeps an already-canonical path unchanged', () => {
    const p = '/home/user/20260730-示例目录'
    expect(normalizeWorkspacePath(p)).toBe(p)
  })
})

describe('R14 中文路径兼容（目录解析）', () => {
  let wsRoot: string

  beforeEach(async () => {
    wsRoot = await mkdtemp(join(tmpdir(), 'feishu4dsh-r14-'))
    // 磁盘上只存在「无空格」的真实目录；配置值里带空格/全角空格的拼写都是坏值。
    // 真实名含连字符：`目标-项目`；坏拼写 `目标 - 项目` / `目标　-　项目` 去空格后回到原名。
    await mkdir(join(wsRoot, '读书', '目标-项目'), { recursive: true })
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('resolveWorkspaceDirectory finds dirs misspelled with full-width spaces', async () => {
    const misspelled = join(wsRoot, '读\u3000书', '目标　-　项目')
    expect(await resolveWorkspaceDirectory(misspelled)).toBe(join(wsRoot, '读书', '目标-项目'))
  })

  it('resolveWorkspaceDirectory finds dirs misspelled with stray ASCII spaces', async () => {
    const misspelled = join(wsRoot, '读 书', '目标 - 项目')
    expect(await resolveWorkspaceDirectory(misspelled)).toBe(join(wsRoot, '读书', '目标-项目'))
  })

  it('resolveWorkspaceDirectory keeps a verbatim existing path (legit spaces win)', async () => {
    await mkdir(join(wsRoot, '读 书', '目标-项目'), { recursive: true })
    const legit = join(wsRoot, '读 书', '目标-项目')
    expect(await resolveWorkspaceDirectory(legit)).toBe(await realpath(legit))
  })

  it('resolveWorkspaceDirectory returns undefined when no spelling exists', async () => {
    expect(await resolveWorkspaceDirectory(join(wsRoot, '不存在'))).toBeUndefined()
  })
})
