import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { endsWithParent, type SimulationEvent } from '../web/lib/agent-types'
import { timeHorizon } from '../web/lib/time-horizon'

const ev = (time: number, type: SimulationEvent['type'], payload: Record<string, unknown> = {}): SimulationEvent =>
  ({ time, type, payload: { agent: 'orchestrator', ...payload } })

/** The main agent sends a reviewer out and its turn ends at 10; the reviewer works on until 100 */
function sentOut(spawn: Record<string, unknown>, extra: SimulationEvent[] = []): SimulationEvent[] {
  return [
    ev(0, 'agent_spawn', { name: 'orchestrator', isMain: true }),
    ev(0, 'message', { role: 'user' }),
    ev(2, 'tool_call_start', { tool: 'Agent' }),
    ev(2, 'agent_spawn', { name: 'reviewer', task: 'Review', ...spawn }),
    ev(3, 'tool_call_end', { tool: 'Agent' }),
    ...extra,
    ev(10, 'model_step', { stopReason: 'end_turn', usage: { output_tokens: 0 } }),
    ev(50, 'tool_call_start', { agent: 'reviewer', tool: 'Read' }),
    ev(51, 'tool_call_end', { agent: 'reviewer', tool: 'Read' }),
    ev(100, 'subagent_return', { child: 'reviewer', summary: 'done' }),
  ]
}

test('a background subagent’s time after the turn ends is the subagent’s, not waiting for you', () => {
  const h = timeHorizon(sentOut({ background: true }), 120)
  assert.deepEqual(h.totals, { thinking: 9, tools: 0, subagents: 91, permission: 0, waiting: 20 })
})

test('an agent the transcript says went to the background counts the same', () => {
  const h = timeHorizon(sentOut({}, [ev(3, 'agent_status', { name: 'reviewer', status: 'running', background: true })]), 120)
  assert.equal(h.totals.subagents, 91)
})

test('without the flag, time between turns stays waiting', () => {
  assert.equal(timeHorizon(sentOut({}), 120).totals.waiting, 110)
})

test('the session’s end ends the agents still out', () => {
  const events = sentOut({ background: true }).filter(e => e.type !== 'subagent_return')
  const h = timeHorizon([...events, ev(60, 'agent_complete', { name: 'orchestrator', sessionEnd: true })], 120)
  assert.equal(h.subagents[0]!.end, 60)
  assert.equal(h.totals.waiting, 60)
})

test('a resume keeps Claude Code’s estimate and what the first request then wrote', () => {
  const h = timeHorizon([
    ev(0, 'agent_spawn', { name: 'orchestrator', isMain: true }),
    ev(1, 'session_resume', { source: 'resume', idleSeconds: 11_520, contextTokens: 412_000, cacheExpired: true, estimatedUsd: 2.06 }),
    ev(5, 'model_step', { model: 'claude-opus-5-5', stopReason: 'tool_use', usage: { output_tokens: 10, cache_creation_input_tokens: 409_000, cache_creation_1h_input_tokens: 409_000 } }),
    ev(9, 'model_step', { model: 'claude-opus-5-5', stopReason: 'end_turn', usage: { output_tokens: 10, cache_read_input_tokens: 409_000, cache_creation_input_tokens: 800 } }),
  ], 10)
  assert.deepEqual(h.resume, {
    time: 1, source: 'resume', idleSeconds: 11_520, contextTokens: 412_000, cacheExpired: true, estimatedUsd: 2.06,
    firstWrite: { tokens: 409_000, oneHour: 409_000, model: 'claude-opus-5-5' },
  })
})

test('a main turn’s end finishes its subagents, but not those in the background; the session’s end finishes all', () => {
  assert.equal(endsWithParent({}, false), true)
  assert.equal(endsWithParent({ isBackground: true }, false), false)
  assert.equal(endsWithParent({ isBackground: true }, true), true)
})
