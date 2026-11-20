import { describe, expect, it } from 'vitest'
import { buildEnvelope, excerptTwenty, hashRequest, SHE_FORBIDDEN } from '../src/secretary/envelope.js'

describe('secretary envelope', () => {
  it('excerpts by Unicode code point without rewriting', () => {
    const raw = '😀ABCDEFGHIJKLMNOPQRSTU'
    expect(Array.from(raw)).toHaveLength(22)
    expect(Array.from(excerptTwenty(raw))).toHaveLength(20)
    expect(excerptTwenty('  abc  ')).toBe('abc')
  })

  it('hashes the exact request and keeps it verbatim under the marker', () => {
    const raw = '修复登录问题\n不要改其它文件'
    const envelope = buildEnvelope({
      taskId: 'task-1',
      topicId: 'topic-1',
      workspacePath: '/repo',
      worktreePath: '/worktrees/topic-1',
      reportPath: '/worktrees/topic-1/.secretary/reports/task-1.md',
      attachments: [],
      rawRequest: raw,
    })
    expect(hashRequest(raw)).toHaveLength(64)
    expect(envelope).toContain('[she/v1]')
    expect(envelope).toContain('report_path: /worktrees/topic-1/.secretary/reports/task-1.md')
    expect(envelope.endsWith(`[user_request_raw]\n${raw}`)).toBe(true)
    for (const forbidden of SHE_FORBIDDEN) expect(envelope).toContain(forbidden)
  })
})
