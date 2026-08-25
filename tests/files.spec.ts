import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeInboundFile, resolveOutboundFile, sendFileTool, describeRefusalForModel, SEND_FILE_TOOL } from '../src/files.js'
import { strings } from '../src/strings.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-feishu-test-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('storeInboundFile', () => {
  it('stores under the message inbox group', async () => {
    const stored = await storeInboundFile(workspace, '123-abc', 'report.pdf', Buffer.from('hello'), 1024)
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.file.pathInWorkspace).toBe('.feishu4dsh/inbox/123-abc/report.pdf')
    expect(stored.file.bytes).toBe(5)
  })

  it('refuses oversized files', async () => {
    const stored = await storeInboundFile(workspace, 'k', 'big.bin', Buffer.alloc(10), 5)
    expect(stored.ok).toBe(false)
    if (!stored.ok) expect(stored.refusal.code).toBe('too_large')
  })

  it('sanitizes hostile names', async () => {
    const stored = await storeInboundFile(workspace, 'k', '../../etc/shadow', Buffer.from('x'), 1024)
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.file.pathInWorkspace).not.toContain('..')
    expect(stored.file.pathInWorkspace.endsWith('/shadow')).toBe(true)
  })
})

describe('resolveOutboundFile', () => {
  it('clears a regular workspace file', async () => {
    const path = join(workspace, 'report.txt')
    await writeFile(path, 'data')
    const verdict = await resolveOutboundFile('report.txt', workspace, 1024)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.file.pathInWorkspace).toBe('report.txt')
    expect(verdict.file.bytes).toBe(4)
  })

  it('refuses paths outside the workspace', async () => {
    const verdict = await resolveOutboundFile('../outside.txt', workspace, 1024)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal.code).toBe('outside_workspace')
  })

  it('refuses a symlink escaping the workspace', async () => {
    const outside = join(workspace, '..', 'outside-secret.txt')
    await writeFile(outside, 'secret').catch(() => undefined)
    await symlink(outside, join(workspace, 'link.txt')).catch(() => undefined)
    const verdict = await resolveOutboundFile('link.txt', workspace, 1024)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal.code).toBe('outside_workspace')
  })

  it('refuses missing paths and oversized files', async () => {
    const missing = await resolveOutboundFile('nope.txt', workspace, 1024)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.refusal.code).toBe('not_found')

    await writeFile(join(workspace, 'big.bin'), Buffer.alloc(100))
    const tooLarge = await resolveOutboundFile('big.bin', workspace, 50)
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.refusal.code).toBe('too_large')
  })
})

describe('sendFileTool', () => {
  it('throws refusals so the model must act on them', async () => {
    const tool = sendFileTool({
      deliver: async () => undefined,
      workspaceOf: () => workspace,
      maxBytes: 1024,
      copy: strings('en-US'),
    }) as { name: string; execute(args: unknown, exec: unknown): Promise<{ sent: true }> }
    expect(tool.name).toBe(SEND_FILE_TOOL)

    await expect(tool.execute({ path: '../nope' }, { agent: { session: { id: 's1' } } }))
      .rejects.toThrow(/outside the workspace/)
    await expect(tool.execute({}, { agent: { session: { id: 's1' } } }))
      .rejects.toThrow(/No such file/)
    await expect(tool.execute({ path: 'x' }, {}))
      .rejects.toThrow(/requires a calling agent/)
  })

  it('delivers a cleared file and surfaces failures', async () => {
    await mkdir(join(workspace, 'out'), { recursive: true })
    await writeFile(join(workspace, 'out', 'a.txt'), 'x')
    let delivered: string | undefined
    const okTool = sendFileTool({
      deliver: async (_sid, file) => { delivered = file.path; return undefined },
      workspaceOf: () => workspace,
      maxBytes: 1024,
      copy: strings('en-US'),
    }) as { execute(args: unknown, exec: unknown): Promise<{ sent: true }> }
    await expect(okTool.execute({ path: 'out/a.txt' }, { agent: { session: { id: 's1' } } }))
      .resolves.toEqual({ sent: true })
    expect(delivered).toContain('a.txt')

    const failingTool = sendFileTool({
      deliver: async () => 'The group declined to send that file.',
      workspaceOf: () => workspace,
      maxBytes: 1024,
      copy: strings('en-US'),
    }) as { execute(args: unknown, exec: unknown): Promise<{ sent: true }> }
    await expect(failingTool.execute({ path: 'out/a.txt' }, { agent: { session: { id: 's1' } } }))
      .rejects.toThrow(/declined/)
  })

  it('describes every refusal for the model', () => {
    const copy = strings('en-US')
    expect(describeRefusalForModel({ code: 'outside_workspace' }, copy)).toMatch(/outside/)
    expect(describeRefusalForModel({ code: 'not_found' }, copy)).toMatch(/No such/)
    expect(describeRefusalForModel({ code: 'not_a_file' }, copy)).toMatch(/not a regular file/)
    expect(describeRefusalForModel({ code: 'too_large', bytes: 100, limit: 50 }, copy)).toMatch(/over/)
  })
})
