import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SHE_BOOTSTRAP_SCHEMA,
  bootstrapWorkspaceOf,
  parseBootstrapState,
  readBootstrapState,
  withBootstrapScope,
  writeBootstrapState,
  type SecretaryBootstrapState,
} from '../src/secretary/bootstrap.js'

function sampleState(): SecretaryBootstrapState {
  return {
    schema: SHE_BOOTSTRAP_SCHEMA,
    initializedAt: 1,
    updatedAt: 1,
    runtime: {
      root: '/srv/opencode-she/worktrees/she-runtime',
      worktreeRoot: '/srv/opencode-she/worktrees/she-runtime/worktrees',
      reposRoot: '/srv/opencode-she/worktrees/repos',
    },
    opencode: {
      url: 'http://127.0.0.1:49375',
      username: 'opencode',
      passwordFile: '/srv/opencode-she/secrets/opencode-service.json',
    },
    model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'high' },
    scopes: {},
  }
}

describe('SHE bootstrap state', () => {
  it('writes atomically with 0600 and reads back a normalized state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-bootstrap-'))
    const file = join(dir, 'state.json')
    try {
      const state = withBootstrapScope(sampleState(), 'chat§workspace', '/src/repo', '/shared/repo', 10)
      await writeBootstrapState(file, state)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 1, scopes: { 'chat§workspace': { shadowRepo: '/shared/repo' } } })
      const read = await readBootstrapState(file)
      expect(read).toEqual(state)
      expect(bootstrapWorkspaceOf(read, 'chat§workspace')).toBe('/shared/repo')
      expect(bootstrapWorkspaceOf(read, 'missing')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for a missing file and fails closed on malformed/unsafe state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-bootstrap-'))
    try {
      expect(await readBootstrapState(join(dir, 'missing.json'))).toBeUndefined()
      const badPath = join(dir, 'bad.json')
      writeFileSync(badPath, '{"schema":1}')
      await expect(readBootstrapState(badPath)).rejects.toThrow(/timestamps|missing runtime/)
      const unsafe = sampleState() as unknown as Record<string, unknown>
      const opencode = unsafe.opencode as Record<string, unknown>
      opencode.url = 'http://example.com:49375'
      expect(() => parseBootstrapState(unsafe)).toThrow(/loopback/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
