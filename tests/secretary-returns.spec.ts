import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptTaskReturn, buildTaskReturn } from '../src/secretary/returns.js'
import type { SecretaryTask, SecretaryTopic } from '../src/secretary/types.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

describe('SHE return/accept bundle', () => {
  it('returns report/patch/changed/new/outputs then accepts and stages only project paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-returns-'))
    const project = join(dir, 'project')
    const worktree = join(dir, 'worktree')
    try {
      mkdirSync(project)
      git(project, 'init', '-q')
      git(project, 'config', 'user.name', 'test')
      git(project, 'config', 'user.email', 'test@example.com')
      writeFileSync(join(project, 'README.md'), 'old\n')
      git(project, 'add', 'README.md')
      git(project, 'commit', '-qm', 'init')
      git(project, 'worktree', 'add', '-q', '-b', 'she/test', worktree)

      writeFileSync(join(worktree, 'README.md'), 'new\n')
      mkdirSync(join(worktree, 'src'), { recursive: true })
      writeFileSync(join(worktree, 'src', 'added.ts'), 'export const x = 1\n')
      mkdirSync(join(worktree, '.secretary', 'reports'), { recursive: true })
      writeFileSync(join(worktree, '.secretary', 'reports', 'task-1.md'), '# report\n')
      mkdirSync(join(worktree, '.secretary', 'outputs', 'task-1'), { recursive: true })
      writeFileSync(join(worktree, '.secretary', 'outputs', 'task-1', 'notes.md'), 'notes\n')

      const topic = {
        id: 'topic-1', displayNo: '1', workspacePath: project, worktreePath: worktree,
      } as unknown as SecretaryTopic
      const task = {
        id: 'task-1', seq: 1, status: 'succeeded', reportPath: join(worktree, '.secretary', 'reports', 'task-1.md'),
      } as unknown as SecretaryTask

      const returned = await buildTaskReturn({ projectRoot: project, topic, task })
      expect(returned.returnDir).toBe(join(project, 'she_returns', 'task-1'))
      expect(returned.changedFiles).toBe(1)
      expect(returned.newFiles).toBe(1)
      expect(existsSync(join(returned.returnDir, 'REPORT.md'))).toBe(true)
      expect(existsSync(join(returned.returnDir, 'CHANGES.patch'))).toBe(true)
      expect(existsSync(join(returned.returnDir, 'outputs', 'notes.md'))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(returned.returnDir, 'manifest.json'), 'utf8')) as {
        affectedPaths: string[]
      }
      expect(manifest.affectedPaths.sort()).toEqual(['README.md', 'src/added.ts'])

      const accepted = await acceptTaskReturn({ projectRoot: project, taskId: 'task-1' })
      expect(accepted.appliedPatch).toBe(true)
      expect(accepted.copiedNewFiles).toBe(1)
      expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('new\n')
      expect(readFileSync(join(project, 'src', 'added.ts'), 'utf8')).toBe('export const x = 1\n')
      const staged = git(project, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
      expect(staged).toEqual(['README.md', 'src/added.ts'])
      // Returns must never be staged.
      expect(git(project, 'diff', '--cached', '--name-only')).not.toContain('she_returns')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects return for a non-succeeded task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-returns-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(repo)
      git(repo, 'init', '-q')
      const topic = { worktreePath: repo, workspacePath: repo, displayNo: '1' } as unknown as SecretaryTopic
      const task = { id: 't', seq: 1, status: 'running', reportPath: join(repo, 'r.md') } as unknown as SecretaryTask
      await expect(buildTaskReturn({ projectRoot: repo, topic, task })).rejects.toThrow(/not succeeded/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unsafe paths in a returned manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-returns-'))
    const project = join(dir, 'project')
    try {
      mkdirSync(project)
      git(project, 'init', '-q')
      const returnDir = join(project, 'she_returns', 'task-1')
      mkdirSync(returnDir, { recursive: true })
      writeFileSync(join(returnDir, 'manifest.json'), JSON.stringify({
        version: 1,
        taskId: 'task-1',
        display: '1.1',
        status: 'succeeded',
        sourceRepo: project,
        worktreePath: project,
        createdAt: 1,
        report: null,
        patch: null,
        changedFiles: [],
        newFiles: [{ path: '../escape.txt', status: 'added', returnPath: 'new-files/escape.txt' }],
        outputs: [],
        affectedPaths: ['../escape.txt'],
      }))
      await expect(acceptTaskReturn({ projectRoot: project, taskId: 'task-1' })).rejects.toThrow(/unsafe relative path/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
