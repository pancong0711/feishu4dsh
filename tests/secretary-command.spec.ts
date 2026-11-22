import { describe, expect, it } from 'vitest'
import { parseSheCommand } from '../src/secretary/command.js'

describe('secretary command parser', () => {
  it('treats an empty command as help', () => {
    expect(parseSheCommand('')).toEqual({ kind: 'help' })
    expect(parseSheCommand('help')).toEqual({ kind: 'help' })
  })

  it('preserves the raw submit body and supports attachments-free usage', () => {
    expect(parseSheCommand('submit 修复登录问题\n并补测试')).toEqual({
      kind: 'submit',
      raw: '修复登录问题\n并补测试',
    })
    expect(parseSheCommand('submit')).toEqual({ kind: 'invalid', reason: 'submit_usage' })
  })

  it('parses init/doctor and rejects malformed init arguments', () => {
    expect(parseSheCommand('init')).toEqual({ kind: 'init' })
    expect(parseSheCommand('init demo')).toEqual({ kind: 'init', repoName: 'demo' })
    expect(parseSheCommand('init demo extra')).toEqual({ kind: 'invalid', reason: 'init_usage' })
    expect(parseSheCommand('doctor')).toEqual({ kind: 'doctor' })
  })

  it('parses continue, list, status, report, stop and resume', () => {
    expect(parseSheCommand('continue 1 第二项任务')).toEqual({ kind: 'continue', topic: '1', raw: '第二项任务' })
    expect(parseSheCommand('list')).toEqual({ kind: 'list' })
    expect(parseSheCommand('list 1')).toEqual({ kind: 'list', topic: '1' })
    expect(parseSheCommand('status 1.2')).toEqual({ kind: 'status', reference: '1.2' })
    expect(parseSheCommand('report 1.2')).toEqual({ kind: 'report', reference: '1.2' })
    expect(parseSheCommand('stop 1.2')).toEqual({ kind: 'stop', reference: '1.2' })
    expect(parseSheCommand('resume 1')).toEqual({ kind: 'resume', reference: '1' })
  })

  it('parses topic rename/remove with explicit flags', () => {
    expect(parseSheCommand('topic rename 1 5')).toEqual({ kind: 'rename', oldRef: '1', newLabel: '5', force: false })
    expect(parseSheCommand('topic rename 1 5 --force')).toEqual({ kind: 'rename', oldRef: '1', newLabel: '5', force: true })
    expect(parseSheCommand('topic remove 1')).toEqual({ kind: 'remove', reference: '1', purge: false })
    expect(parseSheCommand('topic remove 1 --purge')).toEqual({ kind: 'remove', reference: '1', purge: true })
  })

  it('rejects malformed bodies without guessing', () => {
    expect(parseSheCommand('continue 1')).toEqual({ kind: 'invalid', reason: 'continue_usage' })
    expect(parseSheCommand('unknown')).toEqual({ kind: 'invalid', reason: 'unknown' })
    expect(parseSheCommand('topic rename 1')).toEqual({ kind: 'invalid', reason: 'rename_usage' })
  })
})
