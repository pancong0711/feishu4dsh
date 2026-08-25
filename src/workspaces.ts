/**
 * Workspace resolution, listing, and admission control for the `/ws` and
 * `/cd` commands.
 *
 * Everything here is PURE: it consumes a pre-built catalog and returns a
 * decision. It never touches the host, the file system beyond canonicalizing
 * a path, or the chat. The bridge owns the side effects (creating/resuming
 * the right session, persisting the selection, registering the workspace).
 *
 * Why this matters: dsh roots each agent session in a workspace and confines
 * writes to it. Until now every chat shared ONE configured workspace. This
 * module is what lets a chat point the agent at a different directory
 * (e.g. from a phone), while keeping the admission strict: a `/cd` target is
 * accepted only if it is the default workspace, a registered workspace, or
 * inside an explicitly-allowed root.
 * @module feishu4dsh/workspaces
 */

import { basename, isAbsolute, resolve } from 'node:path'
import { dirname } from 'node:path'
import { realpath } from 'node:fs/promises'

/** One workspace the channel can reason about. */
export interface WorkspaceEntry {
  /** Display / match name; normally the canonical basename of the path. */
  readonly name: string
  /** Canonical absolute path. */
  readonly path: string
  /** Whether this is the deployment's default workspace. */
  readonly isDefault: boolean
}

/** One workspace annotated for display. */
export interface WorkspaceInfo extends WorkspaceEntry {
  /** Whether the chat is currently rooted here. */
  readonly current: boolean
}

/** Why `/cd` rejected its target. */
export type CdRefusal =
  | { readonly code: 'empty' }
  | { readonly code: 'ambiguous'; readonly matches: readonly WorkspaceEntry[] }
  | { readonly code: 'not_found' }
  | { readonly code: 'not_allowed' }

/** The resolved inputs workspace decisions need. */
export interface WorkspaceCatalog {
  /** The deployment's default workspace. */
  readonly defaultWorkspace: WorkspaceEntry
  /** Registered / previously-seen workspaces, excluding the default. */
  readonly known: readonly WorkspaceEntry[]
  /** Allowed directory prefixes, canonical where resolvable. May be empty. */
  readonly roots: readonly string[]
}

/**
 * Canonicalize a path: resolve symlinks when possible, falling back to
 * lexical resolution so a not-yet-existing path still gets a stable form.
 *
 * Before falling back, it also retries once with a light cleanup of stray
 * spaces inside the final path segment. This guards against a common phone /
 * copy-paste mistake where a directory like `20260730-示例目录` is saved as
 * `20260730 - 示例目录` (with spaces); what looks like a Chinese-display
 * glitch is actually an invalid path that, if kept verbatim, would desync the
 * `/status` workspace from the Agent's real sandbox directory.
 *
 * @param path - the path to canonicalize.
 * @returns the canonical absolute path, or the lexical resolve of `path` when
 *   neither the original nor the cleaned form exists on disk.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    // Retry once, with stray spaces stripped from inside the final segment
    // (e.g. `20260730 - 示例目录` -> `20260730-示例目录`). Only rewrites the
    // basename, so legitimate spaces in ancestors are preserved.
    const cleaned = cleanStrayBasenameSpaces(path)
    if (cleaned !== path) {
      try {
        return await realpath(cleaned)
      } catch {
        // fall through
      }
    }
    return resolve(path)
  }
}

/**
 * Remove stray spaces inside the final path segment only, e.g.
 * `20260730 - 示例目录` -> `20260730-示例目录`. Whitespace in ancestor
 * directories is left untouched.
 * @param path - the absolute path to normalize.
 * @returns the path with basename-internal spaces removed, or `path` when the
 *   basename has no spaces.
 */
function cleanStrayBasenameSpaces(path: string): string {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const base = slash === -1 ? path : path.slice(slash + 1)
  const cleaned = base.replace(/[ \t]+/g, '')
  return cleaned === base ? path : dir + cleaned
}

/**
 * Resolve a candidate path to a directory that ACTUALLY exists on disk, for
 * use as an Agent's working workspace (where the sandbox writes are allowed).
 *
 * Unlike {@link canonicalPath} — which tolerates and lexically resolves
 * missing paths for catalog listing — this returns `undefined` when the path
 * (and its stray-space-cleaned form) does not name a real directory. The
 * caller then falls back to a known-good workspace instead of rooting the
 * Agent at a non-existent directory (which desyncs `/status` from the actual
 * sandbox cwd).
 *
 * @param path - candidate workspace path.
 * @returns the realpath of an existing directory, or `undefined` when neither
 *   the original nor the stray-space-cleaned form exists on disk.
 */
export async function resolveWorkspaceDirectory(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    const cleaned = cleanStrayBasenameSpaces(path)
    if (cleaned === path) return undefined
    try {
      return await realpath(cleaned)
    } catch {
      return undefined
    }
  }
}

/**
 * Build a catalog from the deployment's default workspace, the host's
 * registered workspaces, workspaces the user added via `/ws add`, and the
 * configured allowed roots.
 * @param defaultPath - configured default workspace (canonical or not).
 * @param registeredPaths - paths the host already registers as workspaces.
 * @param roots - allowed directory prefixes from configuration.
 * @param userWorkspaces - workspace paths added at runtime via `/ws add`.
 * @returns the catalog decisions are made against.
 */
export async function buildCatalog(
  defaultPath: string,
  registeredPaths: readonly string[],
  roots: readonly string[],
  userWorkspaces: readonly string[] = [],
): Promise<WorkspaceCatalog> {
  const defaultCanonical = await canonicalPath(defaultPath)
  const defaultWorkspace: WorkspaceEntry = {
    name: basename(defaultCanonical),
    path: defaultCanonical,
    isDefault: true,
  }

  const known: WorkspaceEntry[] = []
  const knownSeen = new Set<string>()
  for (const raw of [...registeredPaths, ...userWorkspaces]) {
    const canonical = await canonicalPath(raw)
    if (canonical === defaultCanonical) continue
    if (knownSeen.has(canonical)) continue
    knownSeen.add(canonical)
    known.push({ name: basename(canonical), path: canonical, isDefault: false })
  }

  const canonicalRoots: string[] = []
  for (const root of roots) {
    const trimmed = root.trim()
    if (trimmed === '') continue
    canonicalRoots.push(await canonicalPath(trimmed))
  }

  return { defaultWorkspace, known, roots: canonicalRoots }
}

/**
 * Whether one canonical path is admissible as a `/cd` target.
 * Admitted = the default workspace, a registered workspace, or (when roots
 * are configured) inside one of the allowed roots. With no roots configured,
 * ONLY explicitly-trusted workspaces are admitted — arbitrary paths are not.
 * @param canonical - canonical path to test.
 * @param catalog - the catalog to test against.
 * @returns whether the path may become the chat's workspace.
 */
export function isAllowed(canonical: string, catalog: WorkspaceCatalog): boolean {
  if (canonical === catalog.defaultWorkspace.path) return true
  for (const entry of catalog.known) {
    if (entry.path === canonical) return true
  }
  for (const root of catalog.roots) {
    if (canonical === root) return true
    if (canonical.startsWith(root.endsWith('/') ? root : `${root}/`)) return true
  }
  return false
}

/**
 * List every workspace the channel knows about, annotated with which one the
 * chat is currently rooted in. Stable order: default first, then the rest.
 * @param catalog - the catalog to list.
 * @param currentPath - the chat's current canonical workspace path.
 * @returns the annotated list.
 */
export function listWorkspaces(catalog: WorkspaceCatalog, currentPath: string): WorkspaceInfo[] {
  const seen = new Set<string>()
  const out: WorkspaceInfo[] = []
  const push = (entry: WorkspaceEntry): void => {
    if (seen.has(entry.path)) return
    seen.add(entry.path)
    out.push({ ...entry, current: entry.path === currentPath })
  }
  push(catalog.defaultWorkspace)
  for (const entry of catalog.known) push(entry)
  return out
}

/**
 * Resolve one `/cd` argument to a workspace, or refuse with a reason.
 * Priority: (1) an exact NAME match among known workspaces; (2) a path. A
 * path is resolved relative to the default workspace's parent directory, so
 * sibling projects are reachable, then admitted via {@link isAllowed}.
 * @param raw - the `/cd` argument.
 * @param catalog - the catalog to resolve against.
 * @returns the workspace, or the refusal.
 */
export async function resolveCdTarget(
  raw: string,
  catalog: WorkspaceCatalog,
): Promise<{ ok: true; entry: WorkspaceEntry } | { ok: false; refusal: CdRefusal }> {
  const target = raw.trim()
  if (target === '') return { ok: false, refusal: { code: 'empty' } }

  // (1) Name match wins when unambiguous.
  const candidates: WorkspaceEntry[] = []
  const all = [catalog.defaultWorkspace, ...catalog.known]
  for (const entry of all) {
    if (entry.name === target) candidates.push(entry)
  }
  if (candidates.length === 1) return { ok: true, entry: candidates[0]! }
  if (candidates.length > 1) return { ok: false, refusal: { code: 'ambiguous', matches: candidates } }

  // (2) Treat it as a path, relative to the default workspace's parent so
  // sibling projects are reachable by short name.
  const candidatePath = isAbsolute(target)
    ? target
    : resolve(dirname(catalog.defaultWorkspace.path), target)
  let canonical: string
  try {
    canonical = await realpath(candidatePath)
  } catch {
    return { ok: false, refusal: { code: 'not_found' } }
  }
  if (!isAllowed(canonical, catalog)) return { ok: false, refusal: { code: 'not_allowed' } }

  // Prefer the registered name when the canonical path matches one.
  for (const entry of all) {
    if (entry.path === canonical) return { ok: true, entry }
  }
  return { ok: true, entry: { name: basename(canonical), path: canonical, isDefault: false } }
}

/** Extract the registered paths the host advertises, tolerating absence. */
export function registeredPathsOf(
  registry: { list?(): readonly { path: string }[] } | undefined,
): string[] {
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry.list().map(workspace => workspace.path)
  } catch {
    return []
  }
}
