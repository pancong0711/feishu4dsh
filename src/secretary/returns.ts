/**
 * Task return/accept: move OpenCode worktree results back into the channel-side
 * project as an inspectable bundle, then optionally apply that bundle to the
 * project working tree.
 *
 * Two deliberately separate stages:
 *   1. `return`: write only `<project>/she_returns/<task-id>/` (no source edits).
 *   2. `accept`: validate and apply the bundle, then stage affected paths only.
 *
 * This module never commits, pushes, merges or force-overwrites project files.
 * All paths from a bundle are treated as untrusted and must stay relative to
 * the project root. Symlinked ancestors are rejected.
 * @module feishu4dsh/secretary/returns
 */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SecretaryTask, SecretaryTopic } from './types.js'

const execFileAsync = promisify(execFile)
const RETURNS_DIRNAME = 'she_returns'
const MANIFEST_VERSION = 1

export interface TaskReturnFile {
  readonly path: string
  readonly status: 'modified' | 'deleted' | 'added'
  readonly returnPath?: string
  readonly sha256?: string
}

export interface TaskReturnManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly taskId: string
  readonly display: string
  readonly status: string
  readonly sourceRepo: string
  readonly worktreePath: string
  readonly createdAt: number
  readonly report: string | null
  readonly patch: string | null
  readonly changedFiles: readonly TaskReturnFile[]
  readonly newFiles: readonly TaskReturnFile[]
  readonly outputs: readonly string[]
  readonly affectedPaths: readonly string[]
}

export interface TaskReturnResult {
  readonly taskId: string
  readonly display: string
  readonly returnDir: string
  readonly reportPath?: string
  readonly patchPath?: string
  readonly changedFiles: number
  readonly newFiles: number
  readonly outputs: number
}

export interface TaskAcceptResult {
  readonly taskId: string
  readonly display: string
  readonly returnDir: string
  readonly appliedPatch: boolean
  readonly copiedNewFiles: number
  readonly stagedPaths: readonly string[]
}

export type SecretaryReturnErrorCode =
  | 'not_found'
  | 'not_succeeded'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'unsafe_path'
  | 'project_conflict'
  | 'apply_conflict'
  | 'git_failed'

export class SecretaryReturnError extends Error {
  constructor(readonly code: SecretaryReturnErrorCode, message: string) {
    super(message)
    this.name = 'SecretaryReturnError'
  }
}

function git(cwd: string, args: readonly string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  return execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer,
    encoding: 'utf8',
  }).then(result => result.stdout)
}

function safeRelativePath(path: string): string {
  if (path === '' || isAbsolute(path) || path.includes('\0')) throw new SecretaryReturnError('unsafe_path', `invalid relative path: ${path}`)
  const normalized = path.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..' || segment === '' || segment === '.')) {
    throw new SecretaryReturnError('unsafe_path', `unsafe relative path: ${path}`)
  }
  return normalized
}

function safeJoin(root: string, rel: string): string {
  const normalized = safeRelativePath(rel)
  const target = resolve(root, normalized)
  const back = relative(root, target)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    throw new SecretaryReturnError('unsafe_path', `path escapes project root: ${rel}`)
  }
  return target
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  const parts = rel.split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new SecretaryReturnError('unsafe_path', `symlink ancestor rejected: ${relative(root, current)}`)
      if (!info.isDirectory()) throw new SecretaryReturnError('unsafe_path', `non-directory ancestor rejected: ${relative(root, current)}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function copyRegularFile(source: string, target: string): Promise<string> {
  const info = await lstat(source)
  if (!info.isFile()) throw new SecretaryReturnError('unsafe_path', `not a regular file: ${source}`)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
  return createHash('sha256').update(await readFile(target)).digest('hex')
}

async function copyTree(sourceDir: string, targetDir: string): Promise<string[]> {
  if (!(await pathExists(sourceDir))) return []
  const copied: string[] = []
  const walk = async (current: string, rel: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const source = join(current, entry.name)
      if (entry.isDirectory()) {
        await mkdir(join(targetDir, childRel), { recursive: true, mode: 0o700 })
        await walk(source, childRel)
      } else if (entry.isFile()) {
        await copyRegularFile(source, join(targetDir, childRel))
        copied.push(childRel)
      }
    }
  }
  await walk(sourceDir, '')
  return copied
}

function displayOf(topic: SecretaryTopic, task: SecretaryTask): string {
  return `${topic.displayNo ?? '?'}.${task.seq}`
}

/** Build the inspectable `she_returns/<task-id>/` bundle. */
export async function buildTaskReturn(input: {
  readonly projectRoot: string
  readonly topic: SecretaryTopic
  readonly task: SecretaryTask
}): Promise<TaskReturnResult> {
  if (input.task.status !== 'succeeded') {
    throw new SecretaryReturnError('not_succeeded', `task ${displayOf(input.topic, input.task)} is not succeeded`)
  }
  const projectRoot = await realpath(input.projectRoot)
  const worktree = await realpath(input.topic.worktreePath)
  const returnRoot = join(projectRoot, RETURNS_DIRNAME)
  const returnDir = join(returnRoot, input.task.id)
  const tempDir = join(returnRoot, `.${input.task.id}.${randomUUID()}.tmp`)
  if (!relative(projectRoot, returnDir).startsWith('..')) {
    // expected; realpath containment checked below after creation
  } else {
    throw new SecretaryReturnError('unsafe_path', 'return directory escapes project root')
  }

  await mkdir(returnRoot, { recursive: true, mode: 0o700 })
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  try {
    const diffArgs = ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).secretary/**']
    const patch = await git(worktree, diffArgs)
    const patchPath = patch.trim() === '' ? undefined : join(tempDir, 'CHANGES.patch')
    if (patchPath !== undefined) await writeFile(patchPath, patch, { mode: 0o600 })

    const changedRaw = await git(worktree, ['diff', '--name-only', '-z', 'HEAD', '--', '.', ':(exclude).secretary/**'])
    const changedPaths = changedRaw.split('\0').filter(Boolean).map(safeRelativePath)
    const changedFiles: TaskReturnFile[] = []
    for (const rel of changedPaths) {
      const source = join(worktree, rel)
      let status: TaskReturnFile['status'] = 'modified'
      let sha256: string | undefined
      let returnPath: string | undefined
      if (await pathExists(source)) {
        const info = await lstat(source)
        if (!info.isFile()) throw new SecretaryReturnError('unsafe_path', `changed path is not a regular file: ${rel}`)
        returnPath = `changed-files/${rel}`
        sha256 = await copyRegularFile(source, join(tempDir, returnPath))
        status = 'modified'
      } else {
        status = 'deleted'
      }
      changedFiles.push({ path: rel, status, ...(returnPath === undefined ? {} : { returnPath }), ...(sha256 === undefined ? {} : { sha256 }) })
    }

    const untrackedRaw = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).secretary/**'])
    const newFiles: TaskReturnFile[] = []
    for (const rel of untrackedRaw.split('\0').filter(Boolean).map(safeRelativePath)) {
      const source = join(worktree, rel)
      const info = await lstat(source)
      if (!info.isFile()) throw new SecretaryReturnError('unsafe_path', `new path is not a regular file: ${rel}`)
      const returnPath = `new-files/${rel}`
      const sha256 = await copyRegularFile(source, join(tempDir, returnPath))
      newFiles.push({ path: rel, status: 'added', returnPath, sha256 })
    }

    let reportPath: string | undefined
    if (await pathExists(input.task.reportPath)) {
      const canonicalWorktree = await realpath(worktree)
      const canonicalReport = await realpath(input.task.reportPath)
      const rel = relative(canonicalWorktree, canonicalReport)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
        reportPath = join(tempDir, 'REPORT.md')
        await copyRegularFile(canonicalReport, reportPath)
      }
    }

    const outputsSource = join(worktree, '.secretary', 'outputs', input.task.id)
    const outputs = await copyTree(outputsSource, join(tempDir, 'outputs'))

    const affectedPaths = [...new Set([...changedFiles.map(file => file.path), ...newFiles.map(file => file.path)])].sort()
    const manifest: TaskReturnManifest = {
      version: MANIFEST_VERSION,
      taskId: input.task.id,
      display: displayOf(input.topic, input.task),
      status: input.task.status,
      sourceRepo: input.topic.workspacePath,
      worktreePath: worktree,
      createdAt: Date.now(),
      report: reportPath === undefined ? null : 'REPORT.md',
      patch: patchPath === undefined ? null : 'CHANGES.patch',
      changedFiles,
      newFiles,
      outputs,
      affectedPaths,
    }
    await writeFile(join(tempDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rm(returnDir, { recursive: true, force: true })
    await rename(tempDir, returnDir)
    return {
      taskId: input.task.id,
      display: manifest.display,
      returnDir,
      ...(reportPath === undefined ? {} : { reportPath: join(returnDir, 'REPORT.md') }),
      ...(patchPath === undefined ? {} : { patchPath: join(returnDir, 'CHANGES.patch') }),
      changedFiles: changedFiles.length,
      newFiles: newFiles.length,
      outputs: outputs.length,
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function readManifest(returnDir: string): Promise<TaskReturnManifest> {
  let raw: string
  try {
    raw = await readFile(join(returnDir, 'manifest.json'), 'utf8')
  } catch {
    throw new SecretaryReturnError('manifest_missing', `missing manifest.json in ${returnDir}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SecretaryReturnError('manifest_invalid', 'manifest.json is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) throw new SecretaryReturnError('manifest_invalid', 'manifest is not an object')
  const manifest = value as Partial<TaskReturnManifest>
  if (manifest.version !== MANIFEST_VERSION || typeof manifest.taskId !== 'string' || typeof manifest.display !== 'string'
    || !Array.isArray(manifest.affectedPaths) || !Array.isArray(manifest.newFiles)) {
    throw new SecretaryReturnError('manifest_invalid', 'manifest schema is invalid')
  }
  for (const path of manifest.affectedPaths) safeRelativePath(path)
  for (const file of manifest.newFiles) {
    if (typeof file?.path !== 'string' || typeof file?.returnPath !== 'string') throw new SecretaryReturnError('manifest_invalid', 'newFiles entry is invalid')
    safeRelativePath(file.path)
    safeRelativePath(file.returnPath)
  }
  return manifest as TaskReturnManifest
}

/** Apply a returned bundle to the project working tree and stage only affected paths. */
export async function acceptTaskReturn(input: {
  readonly projectRoot: string
  readonly taskId: string
}): Promise<TaskAcceptResult> {
  const projectRoot = await realpath(input.projectRoot)
  const returnDir = join(projectRoot, RETURNS_DIRNAME, input.taskId)
  const manifest = await readManifest(returnDir)
  if (manifest.taskId !== input.taskId) throw new SecretaryReturnError('manifest_invalid', 'manifest taskId mismatch')

  const newFiles = manifest.newFiles
  for (const file of newFiles) {
    const target = safeJoin(projectRoot, file.path)
    await assertNoSymlinkAncestors(projectRoot, target)
    if (await pathExists(target)) {
      const source = safeJoin(returnDir, file.returnPath ?? '')
      if (!(await pathExists(source))) throw new SecretaryReturnError('manifest_invalid', `missing returned new file: ${file.returnPath}`)
      const [a, b] = await Promise.all([readFile(source), readFile(target)])
      if (!a.equals(b)) throw new SecretaryReturnError('project_conflict', `target already exists with different content: ${file.path}`)
    }
  }

  const patchPath = join(returnDir, 'CHANGES.patch')
  const patchExists = await pathExists(patchPath)
  if (patchExists) {
    try {
      await git(projectRoot, ['apply', '--check', '--binary', patchPath])
    } catch (error) {
      throw new SecretaryReturnError('apply_conflict', `patch check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await git(projectRoot, ['apply', '--binary', patchPath])
    } catch (error) {
      throw new SecretaryReturnError('git_failed', `patch apply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let copiedNewFiles = 0
  for (const file of newFiles) {
    const target = safeJoin(projectRoot, file.path)
    if (await pathExists(target)) continue
    const source = safeJoin(returnDir, file.returnPath ?? '')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(source, target)
    copiedNewFiles += 1
  }

  if (manifest.affectedPaths.length > 0) {
    try {
      await git(projectRoot, ['add', '-A', '--', ...manifest.affectedPaths])
    } catch (error) {
      throw new SecretaryReturnError('git_failed', `git add failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    taskId: manifest.taskId,
    display: manifest.display,
    returnDir,
    appliedPatch: patchExists,
    copiedNewFiles,
    stagedPaths: manifest.affectedPaths,
  }
}
