#!/usr/bin/env node
/**
 * Zero-dependency structural lint for `dsh-plugin.json` (dsh-std Community
 * v0.15). Complements the CI advisory step (real `@dsh-std/manifest` schema
 * validation) with a hard, offline gate that needs no network and no deps.
 *
 * Checks:
 *   1. manifest exists, parses, and carries the required six fields
 *      ($schema / manifestVersion / id / name / version / facets);
 *   2. $schema URN + manifestVersion pin Community draft v0.15; id is
 *      reverse-domain; facets.host.{entry,apiVersion} well-formed;
 *   3. facets.host.entry points at an existing build artifact (run after
 *      `tsc -b`);
 *   4. name/version match package.json (single source of truth);
 *   5. contributes.commands align 1:1 with the zh-CN/en-US `channelCommands`
 *      in src/strings.ts — convention: command id =
 *      `<manifest id>.command.<slug>`, title = zh-CN copy, description =
 *      en-US copy;
 *   6. no permissions declared; requires.contracts stays an array (empty
 *      until the R19-b spike measures adapter-dsh's published supports —
 *      JSON cannot carry comments, so this note lives here by design);
 *   7. src/std/host.ts is a thin entry: <=80 lines, `export default`,
 *      imports only relative modules ending in `.js`, never any host package
 *      (`@deepseek-ai/*`).
 *
 * Usage: node scripts/check-manifest.mjs [projectRoot]   (default: repo root)
 * Exits non-zero on any broken input (fixtures included).
 * @module scripts/check-manifest
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_URN = 'urn:dsh-std:community-draft:dsh-plugin:0.15'
const MANIFEST_VERSION = '0.15'
const REQUIRED_TOP = ['$schema', 'manifestVersion', 'id', 'name', 'version', 'facets']
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/
const API_VERSION_PATTERN = /^v[1-9][0-9]*(?:(?:alpha|beta)[1-9][0-9]*)?$/
const HOST_PACKAGE_PREFIX = '@deepseek-ai/'
const MAX_ENTRY_LINES = 80
/** Separator used by every `channelCommands` line: "usage — copy". */
const LINE_SEPARATOR = ' \u2014 '
/** const name in src/strings.ts → locale key of that block. */
const LOCALE_OF_CONST = { zhCN: 'zh-CN', enUS: 'en-US' }

/**
 * Extract every `channelCommands: [...]` literal from the strings source.
 * @param source - raw text of src/strings.ts.
 * @returns blocks as `{ locale, lines }`; locale is null when the owning
 *   const is not a known locale table.
 */
export function extractChannelCommandBlocks(source) {
  const blocks = []
  const owners = [...source.matchAll(/const\s+(\w+)\s*:\s*Strings\s*=/g)]
  for (const match of source.matchAll(/channelCommands\s*:\s*\[/g)) {
    const start = match.index + match[0].length
    const end = source.indexOf(']', start)
    if (end === -1) break
    const owner = owners.filter(o => o.index < match.index).pop()
    const locale = owner ? LOCALE_OF_CONST[owner[1]] ?? null : null
    const lines = [...source.slice(start, end).matchAll(/'((?:[^'\\]|\\.)*)'/g)]
      .map(q => q[1].replaceAll("\\'", "'"))
    blocks.push({ locale, lines })
  }
  return blocks
}

/**
 * Parse one help line into its command slug and human copy.
 * @param line - e.g. `/ws add <路径> — 添加一个可用工作区`.
 * @returns `{ slug, description }`, or `{ error }` when unparsable.
 */
export function parseChannelCommandLine(line) {
  const at = line.indexOf(LINE_SEPARATOR)
  if (at === -1) return { error: `missing "${LINE_SEPARATOR.trim()}" separator: ${line}` }
  const usage = line.slice(0, at)
  const description = line.slice(at + LINE_SEPARATOR.length).trim()
  if (!usage.startsWith('/')) return { error: `command does not start with "/": ${line}` }
  // Drop <placeholder> arguments; a placeholder pair joined by punctuation
  // (`<provider>/<model>`) leaves stray separators behind, so keep only
  // word-like tokens when joining the slug.
  const slug = usage.slice(1).replace(/<[^>]*>/g, ' ').split(/\s+/)
    .filter(token => /^[a-z0-9-]+$/i.test(token))
    .join('-').toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { error: `cannot derive a slug from: ${line}` }
  return { slug, description }
}

/**
 * Build the exact `contributes.commands` list implied by both locales.
 * @param zhLines - zh-CN channelCommands lines.
 * @param enLines - en-US channelCommands lines.
 * @param pluginId - manifest id used as the command id namespace.
 * @returns `{ commands, errors }`; commands are ordered like the zh list.
 */
export function deriveExpectedCommands(zhLines, enLines, pluginId) {
  const errors = []
  const parse = lines => lines.map(parseChannelCommandLine)
  const [zh, en] = [parse(zhLines), parse(enLines)]
  for (const parsed of [...zh, ...en]) {
    if (parsed.error !== undefined) errors.push(`strings.ts: ${parsed.error}`)
  }
  if (zh.length !== en.length) errors.push(`channelCommands count mismatch: zh-CN ${zh.length} vs en-US ${en.length}`)
  const commands = []
  for (let index = 0; index < zh.length && index < en.length; index += 1) {
    if (zh[index].slug !== en[index].slug) {
      errors.push(`command order mismatch at #${index + 1}: zh "/${zh[index].slug}" vs en "/${en[index].slug}"`)
      continue
    }
    commands.push({
      id: `${pluginId}.command.${zh[index].slug}`,
      title: zh[index].description,
      description: en[index].description,
    })
  }
  return { commands, errors }
}

/** Read a JSON file, returning `{ json }` or `{ error }`. */
function readJson(path) {
  try {
    return { json: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Thin-entry discipline checks for src/std/host.ts. */
function checkThinEntry(root, errors) {
  const entrySrc = join(root, 'src', 'std', 'host.ts')
  if (!existsSync(entrySrc)) {
    errors.push('src/std/host.ts missing (declared by facets.host.entry build output)')
    return
  }
  const source = readFileSync(entrySrc, 'utf8')
  const lines = source.split('\n')
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (lines.length > MAX_ENTRY_LINES) errors.push(`src/std/host.ts has ${lines.length} lines; limit is ${MAX_ENTRY_LINES}`)
  if (!/^export default\b/m.test(source)) errors.push('src/std/host.ts must export default the activation function')
  for (const line of lines) {
    if (!/^\s*(?:import|export)\b/.test(line)) continue
    const specifier = line.match(/from\s*['"]([^'"]+)['"]/) ?? line.match(/^import\s*['"]([^'"]+)['"]/)
    const target = specifier?.[1]
    if (target === undefined) continue
    if (target.startsWith(HOST_PACKAGE_PREFIX)) errors.push(`src/std/host.ts must not import host packages: ${target}`)
    if (target.startsWith('.') && !target.endsWith('.js')) errors.push(`relative import must end with .js: ${target}`)
  }
}

/**
 * Run every structural check against a project root.
 * @param root - directory holding dsh-plugin.json / package.json / src/.
 * @returns `{ ok, errors, warnings }` with human-readable messages.
 */
export function checkProject(root = DEFAULT_ROOT) {
  const errors = []
  const warnings = []
  let manifest = undefined

  const manifestPath = join(root, 'dsh-plugin.json')
  if (!existsSync(manifestPath)) {
    errors.push('dsh-plugin.json not found at project root')
  } else {
    const loaded = readJson(manifestPath)
    if (loaded.error !== undefined) errors.push(`dsh-plugin.json is not valid JSON: ${loaded.error}`)
    else manifest = loaded.json
  }

  if (manifest !== undefined) {
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      errors.push('dsh-plugin.json must contain a JSON object')
      manifest = undefined
    } else {
      for (const key of REQUIRED_TOP) {
        if (manifest[key] === undefined) errors.push(`missing required field: ${key}`)
      }
      if (manifest.$schema !== undefined && manifest.$schema !== SCHEMA_URN) {
        errors.push(`$schema must be "${SCHEMA_URN}", got: ${manifest.$schema}`)
      }
      if (manifest.manifestVersion !== undefined && manifest.manifestVersion !== MANIFEST_VERSION) {
        errors.push(`manifestVersion must be "${MANIFEST_VERSION}", got: ${manifest.manifestVersion}`)
      }
      if (typeof manifest.id === 'string' && !ID_PATTERN.test(manifest.id)) {
        errors.push(`id must be reverse-domain (lowercase dot-separated labels): ${manifest.id}`)
      }

      const pkg = readJson(join(root, 'package.json'))
      if (pkg.error !== undefined) errors.push(`package.json unreadable: ${pkg.error}`)
      else {
        if (manifest.name !== pkg.json.name) errors.push(`name mismatch: manifest "${manifest.name}" vs package.json "${pkg.json.name}"`)
        if (manifest.version !== pkg.json.version) errors.push(`version mismatch: manifest "${manifest.version}" vs package.json "${pkg.json.version}"`)
      }

      const entry = manifest.facets?.host?.entry
      if (manifest.facets !== undefined) {
        if (typeof entry !== 'string' || entry === '') errors.push('facets.host.entry must be a non-empty relative path')
        else {
          if (isAbsolute(entry) || entry.includes('\\')) errors.push(`facets.host.entry must be a relative POSIX path: ${entry}`)
          if (entry.split('/').includes('..')) errors.push(`facets.host.entry must not traverse upward: ${entry}`)
          const artifact = join(root, entry)
          if (!existsSync(artifact)) {
            errors.push(`facets.host.entry artifact missing (run tsc -b first): ${artifact}`)
          }
        }
        const apiVersion = manifest.facets.host?.apiVersion
        if (typeof apiVersion !== 'string' || !API_VERSION_PATTERN.test(apiVersion)) {
          errors.push(`facets.host.apiVersion must look like "v1alpha1", got: ${String(apiVersion)}`)
        }
      }

      if (manifest.permissions !== undefined && !(Array.isArray(manifest.permissions) && manifest.permissions.length === 0)) {
        errors.push('permissions must be absent or an empty array: this plugin declares none')
      }
      const contracts = manifest.requires?.contracts
      if (contracts !== undefined) {
        if (!Array.isArray(contracts)) errors.push('requires.contracts must be an array')
        else if (contracts.length > 0) warnings.push('requires.contracts filled — expected only after the R19-b spike backfill')
      }

      const commands = manifest.contributes?.commands
      if (!Array.isArray(commands)) {
        errors.push('contributes.commands must be an array (aligned with strings.ts channelCommands)')
      } else {
        const stringsPath = join(root, 'src', 'strings.ts')
        if (!existsSync(stringsPath)) errors.push('src/strings.ts not found; cannot verify command alignment')
        else {
          const blocks = extractChannelCommandBlocks(readFileSync(stringsPath, 'utf8'))
          const zh = blocks.find(b => b.locale === 'zh-CN')
          const en = blocks.find(b => b.locale === 'en-US')
          if (zh === undefined || en === undefined || blocks.length !== 2) {
            errors.push(`expected exactly two channelCommands blocks (zhCN/enUS), found ${blocks.length}`)
          } else {
            const derived = deriveExpectedCommands(zh.lines, en.lines, manifest.id)
            errors.push(...derived.errors.map(message => `commands: ${message}`))
            const limit = Math.max(commands.length, derived.commands.length)
            for (let index = 0; index < limit; index += 1) {
              const actual = JSON.stringify(commands[index])
              const expected = JSON.stringify(derived.commands[index])
              if (actual !== expected) {
                errors.push(`commands[${index}] drift:\n    manifest:  ${actual}\n    expected:  ${expected}`)
                break
              }
            }
          }
        }
      }

      checkThinEntry(root, errors)
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function main() {
  const root = process.argv[2] !== undefined ? resolve(process.argv[2]) : DEFAULT_ROOT
  let report
  try {
    report = checkProject(root)
  } catch (error) {
    console.error(`[check-manifest] unexpected failure: ${error instanceof Error ? error.stack : error}`)
    process.exitCode = 1
    return
  }
  for (const warning of report.warnings) console.warn(`[check-manifest] ⚠ ${warning}`)
  for (const error of report.errors) console.error(`[check-manifest] ✘ ${error}`)
  if (report.ok) {
    console.log(`[check-manifest] ✔ dsh-plugin.json structure OK (${root})`)
  } else {
    console.error(`[check-manifest] ${report.errors.length} error(s) in ${root}`)
    process.exitCode = 1
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) main()
