/**
 * Unit tests for counting model usage from Claude Code transcripts.
 *
 * A request with several content blocks is written as several entries sharing `message.id`, each
 * with the whole request's usage: counting entries instead of ids would double the output tokens.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { WatchedSession } from '../src/protocol'
import { recordTranscriptUsage, modelStepPayload, oneHourWrites } from '../src/transcript-usage'

function session(): WatchedSession {
  return { usageSeenIds: new Set(), usageTotals: new Map() } as unknown as WatchedSession
}

function assistant(id: string, output: number, model = 'claude-opus-5-5', block = 'text') {
  return {
    type: 'assistant',
    effort: 'medium',
    message: {
      id, model, role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: block }],
      usage: {
        input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 }, service_tier: 'standard',
      },
    },
  }
}

describe('recordTranscriptUsage', () => {
  it('counts a request once, however many entries it is written as', () => {
    const s = session()
    const first = recordTranscriptUsage(assistant('msg_1', 657, undefined, 'thinking'), 'orchestrator', s)
    const again = recordTranscriptUsage(assistant('msg_1', 657, undefined, 'tool_use'), 'orchestrator', s)
    assert.deepEqual(first, {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2, output_tokens: 657, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation_1h_input_tokens: 6 },
      stopReason: 'end_turn',
      effort: 'medium',
    })
    assert.equal(again, undefined)
    assert.equal(s.usageTotals.get('orchestrator')?.steps, 1)
  })

  it('sums each agent per model', () => {
    const s = session()
    recordTranscriptUsage(assistant('a', 100), 'orchestrator', s)
    recordTranscriptUsage(assistant('b', 50), 'orchestrator', s)
    recordTranscriptUsage(assistant('c', 30, 'claude-haiku-4-5'), 'orchestrator', s)
    recordTranscriptUsage(assistant('d', 7), 'explorer', s)
    const totals = s.usageTotals.get('orchestrator')!
    assert.equal(totals.steps, 3)
    assert.equal(totals.byModel.get('claude-opus-5-5')?.output_tokens, 150)
    assert.equal(totals.byModel.get('claude-haiku-4-5')?.output_tokens, 30)
    assert.equal(s.usageTotals.get('explorer')?.steps, 1)
  })

  it('ignores entries that are not a request’s', () => {
    const s = session()
    assert.equal(recordTranscriptUsage({ type: 'user', message: { role: 'user', content: 'hi' } }, 'orchestrator', s), undefined)
    assert.equal(recordTranscriptUsage({ type: 'assistant', message: { id: 'x', content: [] } }, 'orchestrator', s), undefined)
    assert.equal(recordTranscriptUsage(null, 'orchestrator', s), undefined)
    assert.equal(s.usageTotals.size, 0)
  })
})

describe('modelStepPayload', () => {
  it('carries the request and the totals the way the bridge mod sends them', () => {
    const s = session()
    recordTranscriptUsage(assistant('a', 100), 'orchestrator', s)
    const step = recordTranscriptUsage(assistant('b', 40, 'claude-haiku-4-5'), 'orchestrator', s)!
    const payload = modelStepPayload('orchestrator', step, s.usageTotals.get('orchestrator')!)
    assert.equal(payload.agent, 'orchestrator')
    assert.equal(payload.model, 'claude-haiku-4-5')
    assert.equal(payload.isComplete, true)
    assert.deepEqual(payload.totals, {
      steps: 2,
      byModel: [
        { model: 'claude-opus-5-5', input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation_1h_input_tokens: 6 },
        { model: 'claude-haiku-4-5', input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation_1h_input_tokens: 6 },
      ],
    })
  })
})

describe('oneHourWrites', () => {
  it('reads the API\'s TTL breakdown, or a flat count', () => {
    assert.equal(oneHourWrites({ cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 9 } }), 9)
    assert.equal(oneHourWrites({ cache_creation_1h_input_tokens: 5 }), 5)
    assert.equal(oneHourWrites({ cache_creation_input_tokens: 12 }), 0)
  })
})
