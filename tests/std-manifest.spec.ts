/**
 * R19-a regression tests: dsh-std dual-track manifest invariants.
 *
 * Guards the anti-drift contracts introduced in stage 1:
 *  ① dsh-plugin.json structure & required fields (Community draft v0.15);
 *  ② contributes.commands align exactly with src/strings.ts channelCommands
 *     (zh-CN → title, en-US → description; slug order identical);
 *  ③ scripts/check-manifest.mjs exits non-zero on broken fixtures and passes
 *     the real repo — including "thin entry imports no host package".
 *
 * Manifest conventions documented here because JSON cannot carry comments:
 * `requires.contracts` stays an empty array until the R19-b spike measures
 * adapter-dsh's published supports (v0.15 schema allows empty/omitted), and
 * the manifest declares zero permissions.
 * @module tests/std-manifest
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { strings } from '../src/strings.js'
import {
  checkProject,
  deriveExpectedCommands,
  extractChannelCommandBlocks,
} from '../scripts/check-manifest.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINT_SCRIPT = join(REPO_ROOT, 'scripts', 'check-manifest.mjs')
const MANIFEST_PATH = join(REPO_ROOT, 'dsh-plugin.json')

const readManifest = (): any => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

/** Minimal zh/en command tables embedded in fixture strings.ts stubs. */
const FIXTURE_ZH = [
  '/help — 查看命令列表',
  '/ws add <路径> — 添加工作区（测试）',
  '/model <provider>/<model> — 切换模型（测试）',
]
const FIXTURE_EN = [
  '/help — list commands',
  '/ws add <path> — add a workspace (fixture)',
  '/model <provider>/<model> — switch model (fixture)',
]

const FIXTURE_HOST_SRC = [
  '/** Thin std entry fixture. */',
  "import type { Config } from '../config.js'",
  "import { apply } from '../runtime.js'",
  'export default function activate(context: Parameters<typeof apply>[0], config: Config = {}): void {',
  '  apply(context, config)',
  '}',
].join('\n')

interface FixtureOverrides {
  manifest?: Record<string, unknown>
  hostSrc?: string
  omitBuildArtifact?: boolean
}

/** Build a self-consistent mini project root for the lint script. */
function makeFixture(overrides: FixtureOverrides = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'feishu4dsh-manifest-'))
  const id = 'io.example.fixture'
  const commands = deriveExpectedCommands(FIXTURE_ZH, FIXTURE_EN, id).commands
  const manifest = {
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15',
    id,
    name: 'fixture-plugin',
    version: '1.0.0',
    facets: { host: { entry: 'lib/std/host.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes: { commands },
    ...overrides.manifest,
  }
  writeFileSync(join(root, 'dsh-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // package.json always carries the BASE identity so overrides can simulate
  // drift between it and dsh-plugin.json.
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }, null, 2)}\n`)
  mkdirSync(join(root, 'src', 'std'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'strings.ts'),
    [
      '// Fixture stub: text-only, parsed by scripts/check-manifest.mjs.',
      'const zhCN: Strings = {',
      '  channelCommands: [',
      ...FIXTURE_ZH.map(line => `    '${line.replaceAll("'", "\\'")}',`),
      '  ],',
      '}',
      'const enUS: Strings = {',
      '  channelCommands: [',
      ...FIXTURE_EN.map(line => `    '${line.replaceAll("'", "\\'")}',`),
      '  ],',
      '}',
    ].join('\n'),
  )
  if (!overrides.omitBuildArtifact) {
    mkdirSync(join(root, 'lib', 'std'), { recursive: true })
    writeFileSync(join(root, 'lib', 'std', 'host.js'), '// build artifact placeholder\n')
  }
  writeFileSync(join(root, 'src', 'std', 'host.ts'), overrides.hostSrc ?? FIXTURE_HOST_SRC)
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function runLint(target: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [LINT_SCRIPT, target], { encoding: 'utf8' })
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
}

const cleanupDirs: string[] = []
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop(), { recursive: true, force: true })
})

describe('R19-a ① dsh-plugin.json structure', () => {
  it('carries every required v0.15 field with pinned values', () => {
    const manifest = readManifest()
    expect(manifest.$schema).toBe('urn:dsh-std:community-draft:dsh-plugin:0.15')
    expect(manifest.manifestVersion).toBe('0.15')
    expect(manifest.id).toBe('io.github.pancong0711.feishu4dsh')
    expect(typeof manifest.name).toBe('string')
    expect(typeof manifest.version).toBe('string')
    expect(manifest.facets?.host).toEqual({ entry: 'lib/std/host.js', apiVersion: 'v1alpha1' })
  })

  it('uses a reverse-domain id without path traversal in the facet entry', () => {
    const manifest = readManifest()
    expect(manifest.id).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/)
    const entry = manifest.facets.host.entry as string
    expect(entry.startsWith('/')).toBe(false)
    expect(entry.split('/')).not.toContain('..')
  })

  it('stays in sync with package.json and declares neither permissions nor contracts yet', () => {
    const manifest = readManifest()
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(pkg.name)
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.permissions ?? []).toEqual([])
    expect(manifest.requires?.contracts ?? []).toEqual([]) // backfilled after R19-b
  })

  it('passes the structural lint on this repository', () => {
    expect(checkProject(REPO_ROOT)).toMatchObject({ ok: true, errors: [] })
  })
})

describe('R19-a ② commands align with channelCommands', () => {
  it('extracts both locale blocks from strings.ts verbatim', () => {
    const blocks = extractChannelCommandBlocks(readFileSync(join(REPO_ROOT, 'src', 'strings.ts'), 'utf8'))
    expect(blocks).toEqual([
      { locale: 'zh-CN', lines: [...strings('zh-CN').channelCommands] },
      { locale: 'en-US', lines: [...strings('en-US').channelCommands] },
    ])
  })

  it('declares exactly one manifest command per channel command, both locales', () => {
    const manifest = readManifest()
    const derived = deriveExpectedCommands(
      [...strings('zh-CN').channelCommands],
      [...strings('en-US').channelCommands],
      manifest.id,
    )
    expect(derived.errors).toEqual([])
    expect(manifest.contributes.commands).toEqual(derived.commands)
    // Spot-check the convention on one entry: title=zh copy, description=en copy.
    expect(manifest.contributes.commands).toContainEqual({
      id: `${manifest.id}.command.ws-add`,
      title: '添加一个可用工作区（手机上添加）',
      description: 'add a workspace (from your phone)',
    })
  })

  it('flags drift between the two locale command lists', () => {
    const derived = deriveExpectedCommands(['/help — 查看命令列表'], ['/new — start fresh'], 'io.example.fixture')
    expect(derived.errors.length).toBeGreaterThan(0)
    expect(derived.commands).toEqual([])
  })
})

describe('R19-a ③ check-manifest.mjs fixtures', () => {
  it('accepts a well-formed fixture project', () => {
    const { root, cleanup } = makeFixture()
    try {
      const { status, output } = runLint(root)
      expect(status, output).toBe(0)
    } finally {
      cleanup()
    }
  })

  it.each([
    ['missing required field', { version: undefined }, 'version'],
    ['malformed reverse-domain id', { id: 'Feishu4Dsh' }, 'reverse-domain'],
    ['version drift vs package.json', { version: '9.9.9' }, 'version mismatch'],
  ] as const)('rejects %s', (_label, patch, needle) => {
    const { root, cleanup } = makeFixture({ manifest: patch })
    cleanupDirs.push(root)
    const { status, output } = runLint(root)
    expect(status, output).not.toBe(0)
    expect(output).toContain(needle)
  })

  it('rejects command drift against channelCommands', () => {
    const { root, cleanup } = makeFixture({
      manifest: {
        contributes: {
          commands: [{ id: 'io.example.fixture.command.help', title: '查看命令列表', description: 'list commands' }],
        },
      },
    })
    cleanupDirs.push(root)
    const { status, output } = runLint(root)
    expect(status, output).not.toBe(0)
    expect(output).toContain('commands')
  })

  it('rejects a missing facets.host.entry artifact', () => {
    const { root, cleanup } = makeFixture({ omitBuildArtifact: true })
    cleanupDirs.push(root)
    const { status, output } = runLint(root)
    expect(status, output).not.toBe(0)
    expect(output).toContain('artifact missing')
  })

  it('rejects a thin entry that imports a host package or drops the .js suffix', () => {
    const badImport = makeFixture({
      hostSrc: `${FIXTURE_HOST_SRC}\nimport type { Context } from '@deepseek-ai/cordis'\n`,
    })
    cleanupDirs.push(badImport.root)
    const missingSuffix = makeFixture({ hostSrc: FIXTURE_HOST_SRC.replace("'../config.js'", "'../config'") })
    cleanupDirs.push(missingSuffix.root)
    const first = runLint(badImport.root)
    expect(first.status, first.output).not.toBe(0)
    expect(first.output).toContain('@deepseek-ai/cordis')
    const second = runLint(missingSuffix.root)
    expect(second.status, second.output).not.toBe(0)
    expect(second.output).toContain('.js')
  })

  it('rejects a thin entry over the 80-line budget', () => {
    const filler = Array.from({ length: 85 }, (_, index) => `// filler line ${index}`)
    const { root, cleanup } = makeFixture({ hostSrc: filler.join('\n') })
    cleanupDirs.push(root)
    const { status, output } = runLint(root)
    expect(status, output).not.toBe(0)
    expect(output).toContain('80')
  })

  it('passes the CLI on the real repository once built', () => {
    const built = existsSync(join(REPO_ROOT, 'lib', 'std', 'host.js'))
    // Fresh checkouts run vitest before tsc -b (CI orders lint after Build);
    // skip rather than fail on a never-built tree.
    if (!built && !existsSync(join(REPO_ROOT, 'lib'))) return
    const { status, output } = runLint(REPO_ROOT)
    expect(status, output).toBe(0)
  })
})

describe('R19-a ④ thin standard entry discipline', () => {
  it('keeps src/std/host.ts within 80 lines, default-exported, free of host packages', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'std', 'host.ts'), 'utf8')
    const lines = source.split('\n')
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    expect(lines.length).toBeLessThanOrEqual(80)
    expect(source).toMatch(/^export default\b/m)
    // Scan import/export statements only — prose may mention the prefix.
    const importLines = lines.filter(line => /^\s*(?:import|export)\b/.test(line))
    expect(importLines.filter(line => line.includes('@deepseek-ai/'))).toEqual([])
    expect(source).toContain('../runtime.js')
  })
})
