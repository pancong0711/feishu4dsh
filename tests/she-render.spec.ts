import { describe, expect, it } from 'vitest'
import {
  GATEWAY_V1_COMMAND_RESULT,
  GATEWAY_V1_FIXTURES,
  type ApprovalRenderIntent,
  type FileRenderIntent,
  type ProgressRenderIntent,
  type RenderIntent,
  type StatusRenderIntent,
} from '@she/protocol'
import {
  renderCommandResult,
  renderIntent,
  renderServerEvent,
} from '../src/integrations/she/index.js'

describe('RenderIntent -> Feishu channel primitives', () => {
  it('maps the shared protocol golden fixtures without a copied fixture', () => {
    const [text, card] = GATEWAY_V1_FIXTURES.renderIntents
    expect(text === undefined ? undefined : renderIntent(text)).toEqual({
      kind: 'text',
      text: 'SHE is healthy.',
      markdown: true,
    })
    const renderedCard = card === undefined ? undefined : renderIntent(card)
    expect(renderedCard?.kind).toBe('card')
    if (renderedCard?.kind === 'card') {
      expect(renderedCard.card).toMatchObject({ header: { title: { content: 'SHE status' } } })
      expect(JSON.stringify(renderedCard.card)).toContain('refresh')
      expect(JSON.stringify(renderedCard.card)).toContain('she')
    }
    expect(renderCommandResult(GATEWAY_V1_COMMAND_RESULT)).toHaveLength(2)
  })

  it('maps progress, status, approval and file intents', () => {
    const progress: ProgressRenderIntent = {
      kind: 'progress', renderId: 'p', sequence: 1, stage: 'run', label: 'Building', done: false,
    }
    expect(renderIntent(progress)).toEqual({ kind: 'text', text: 'run · Building', markdown: false })

    const status: StatusRenderIntent = {
      kind: 'status', renderId: 's', sequence: 1, status: 'running', label: 'Task 1.1',
    }
    expect(renderIntent(status)).toEqual({ kind: 'text', text: 'running · Task 1.1', markdown: false })

    const approval: ApprovalRenderIntent = {
      kind: 'approval', renderId: 'a', sequence: 1, interactionId: 'int-1', title: 'Approve?', body: 'Proceed',
    }
    const renderedApproval = renderIntent(approval)
    expect(renderedApproval.kind).toBe('card')
    expect(JSON.stringify(renderedApproval)).toContain('int-1')

    const file: FileRenderIntent = {
      kind: 'file',
      renderId: 'f',
      sequence: 1,
      artifact: { id: 'art-1', fileName: 'report.md', bytes: 42 },
      caption: 'report',
    }
    expect(renderIntent(file)).toEqual({
      kind: 'file',
      artifact: { id: 'art-1', fileName: 'report.md', bytes: 42 },
      caption: 'report',
      approval: 'channel-policy',
    })
  })

  it('reports unsupported intents and only maps render server events', () => {
    const unsupported = { kind: 'future', renderId: 'x', sequence: 1 } as unknown as RenderIntent
    expect(renderIntent(unsupported)).toMatchObject({ kind: 'unsupported' })
    expect(renderServerEvent(GATEWAY_V1_FIXTURES.serverEvent)).toBeUndefined()
    expect(renderServerEvent({
      type: 'render',
      target: { conversation: { id: 'c', kind: 'dm' } },
      render: GATEWAY_V1_FIXTURES.renderIntents[0]!,
    })).toMatchObject({ kind: 'text' })
  })
})

describe('SHE card interaction decoding', () => {
  it('maps form value names back to SHE field ids', async () => {
    const { parseSheCardInteraction } = await import('../src/integrations/she/index.js')
    const raw = {
      she: {
        interactionId: 'int-form',
        actionId: 'submit',
        fields: [
          { id: 'notes', name: 'f0', type: 'text' },
          { id: 'choice', name: 'f1', type: 'select' },
          { id: 'tags', name: 'f2', type: 'select' },
        ],
      },
    }
    expect(parseSheCardInteraction(raw, { f0: 'hello', f1: 'a', f2: ['x', 'y'] })).toEqual({
      interactionId: 'int-form',
      actionId: 'submit',
      values: { notes: 'hello', choice: 'a', tags: ['x', 'y'] },
    })
  })

  it('decodes button values and rejects foreign payloads', async () => {
    const { parseSheCardInteraction } = await import('../src/integrations/she/index.js')
    expect(parseSheCardInteraction({ she: { interactionId: 'i', actionId: 'approve', value: 'yes' } }))
      .toEqual({ interactionId: 'i', actionId: 'approve', values: { value: 'yes' } })
    expect(parseSheCardInteraction({ kind: 'approval', token: 't' })).toBeUndefined()
    expect(parseSheCardInteraction('not-json')).toBeUndefined()
  })
})

describe('SHE task event rendering', () => {
  it('renders milestones but suppresses noisy deltas and tool chatter', async () => {
    const { renderTaskEvent } = await import('../src/integrations/she/index.js')
    const base = {
      ...GATEWAY_V1_FIXTURES.taskEvent,
      eventId: 'event-task',
      sequence: 7,
      taskId: 'task-1',
      topicId: 'topic-1',
      cursor: 'evt:7',
      emittedAt: 1,
    }
    expect(renderTaskEvent({
      ...base,
      type: 'task.accepted',
      taskRef: '1.1',
      queuePosition: 2,
    })).toMatchObject({ kind: 'text', renderId: 'task:event-task', text: 'SHE task accepted: 1.1 (queue 2)' })
    expect(renderTaskEvent({
      ...base,
      type: 'task.completed',
      summary: 'done',
    })).toMatchObject({ kind: 'text', text: 'SHE task completed: done' })
    expect(renderTaskEvent({
      ...base,
      type: 'task.failed',
      error: { code: 'internal', message: 'boom', retryable: false },
    })).toMatchObject({ kind: 'text', text: 'SHE task failed (internal): boom' })
    expect(renderTaskEvent({
      ...base,
      type: 'agent.delta',
      text: 'partial',
      channel: 'text',
    })).toBeUndefined()
    expect(renderTaskEvent({
      ...base,
      type: 'tool.call',
      toolName: 'bash',
      status: 'started',
    })).toBeUndefined()
  })
})
