/**
 * Git worktree allocation for SHE topics.
 * @module feishu4dsh/secretary/worktree
 */

import { execFile } from 'node:child_process'
import { access, mkdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeAllocator } from './types.js'
import { sanitizeFileName, shortHash } from '../util.js'

const execFileAsync = promisify(execFile)

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Allocate/reuse one worktree per topic under the configured root. */
export class GitWorktreeAllocator implements WorktreeAllocator {
  constructor(private readonly worktreeRoot: string) {}

  async ensure(input: {
    readonly workspacePath: string
    readonly topicId: string
    readonly titleExcerpt: string
  }): Promise<{ worktreePath: string; branch: string }> {
    const repoRoot = await realpath(await git(['rev-parse', '--show-toplevel'], input.workspacePath))
    const project = sanitizeFileName(basename(repoRoot), 'project')
    const short = shortHash(input.topicId, 8)
    const worktreePath = join(this.worktreeRoot, project, short)
    const branch = `she/${short}`

    if (await exists(worktreePath)) {
      // A registered worktree is reusable; an unrelated leftover directory is
      // not silently adopted (git worktree add would fail and surface it).
      try {
        const registered = await git(['worktree', 'list', '--porcelain'], repoRoot)
        if (registered.split('\n').includes(`worktree ${worktreePath}`)) {
          return { worktreePath, branch }
        }
      } catch {
        // Fall through to the normal failure path below.
      }
    }

    await mkdir(join(this.worktreeRoot, project), { recursive: true })
    let branchExists = true
    try {
      await git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
    } catch {
      branchExists = false
    }
    if (branchExists) {
      await git(['worktree', 'add', worktreePath, branch], repoRoot)
    } else {
      await git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repoRoot)
    }
    return { worktreePath, branch }
  }

  async remove(input: { readonly workspacePath: string; readonly worktreePath: string }): Promise<void> {
    const repoRoot = await realpath(await git(['rev-parse', '--show-toplevel'], input.workspacePath))
    await git(['worktree', 'remove', '--force', input.worktreePath], repoRoot)
  }
}
