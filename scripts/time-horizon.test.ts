import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '../web/lib/agent-types'
import { timeHorizon, formatDuration, longest, predictConsumption, parallelism } from '../web/lib/time-horizon'

const ev = (time: number, type: SimulationEvent['type'], payload: Record<string, unknown> = {}): SimulationEvent =>
  ({ time, type, payload: { agent: 'orchestrator', ...payload } })

const spawn = ev(0, 'agent_spawn', { name: 'orchestrator', isMain: true })
const step = (time: number, stopReason: string, usage: Record<string, number> = {}) =>
  ev(time, 'model_step', { stopReason, model: 'unknown-model', usage: { output_tokens: 0, ...usage } })

test('a turn splits into thinking, tools, subagents and permission; between turns is waiting', () => {
  const h = timeHorizon([
    spawn,
    ev(10, 'message', { role: 'user' }),           // 0-10 waiting
    ev(15, 'tool_call_start', { tool: 'Bash' }),     // 10-15 thinking
    ev(20, 'permission_requested'),                  // 15-20 tools
    ev(30, 'tool_call_end', { tool: 'Bash' }),       // 20-30 permission
    ev(32, 'tool_call_start', { tool: 'Agent' }),    // 30-32 thinking
    ev(33, 'tool_call_start', { tool: 'Read' }),     // 32-33 subagents
    ev(34, 'tool_call_end', { tool: 'Read' }),       // 33-34 subagents (it outranks the read)
    ev(50, 'tool_call_end', { tool: 'Agent' }),      // 34-50 subagents
    step(55, 'end_turn'),                            // 50-55 thinking
  ], 70)                                             // 55-70 waiting
  assert.deepEqual(h.totals, { thinking: 12, tools: 5, subagents: 18, permission: 10, waiting: 25 })
  assert.equal(h.elapsed, 70)
  assert.equal(h.turns, 1)
  assert.deepEqual(h.segments.map(s => s.kind), ['waiting', 'thinking', 'tools', 'permission', 'thinking', 'subagents', 'thinking', 'waiting'])
})

test('other agents, hidden tools and a duplicated start do not change the main agent’s time', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user' }),
    ev(5, 'tool_call_start', { tool: 'Bash' }),
    ev(6, 'tool_call_start', { tool: 'Bash' }),      // the same call, from the hook and the transcript
    ev(7, 'tool_call_start', { agent: 'explorer', tool: 'Read' }),
    ev(8, 'tool_call_start', { tool: 'SubagentHandback' }),
    ev(10, 'tool_call_end', { tool: 'Bash' }),
    step(12, 'end_turn'),
  ], 12)
  assert.deepEqual(h.totals, { thinking: 7, tools: 5, subagents: 0, permission: 0, waiting: 0 })
})

test('a guessed permission wait counts as the tool still running', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user' }),
    ev(2, 'tool_call_start', { tool: 'Bash' }),
    ev(5, 'permission_requested', { isGuess: true }),
    ev(20, 'tool_call_end', { tool: 'Bash' }),
  ], 20)
  assert.deepEqual(h.totals, { thinking: 2, tools: 18, subagents: 0, permission: 0, waiting: 0 })
})

test('the answer reported after the request that ended the turn does not start another', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user' }),
    step(10, 'end_turn'),
    ev(10, 'message', { role: 'assistant' }),
    ev(10, 'message', { role: 'thinking' }),
    ev(40, 'message', { role: 'user' }),
    step(45, 'end_turn'),
  ], 60)
  assert.deepEqual(h.totals, { thinking: 15, tools: 0, subagents: 0, permission: 0, waiting: 45 })
  assert.equal(h.turns, 2)
})

test('a session picked up mid-turn counts its activity as a turn', () => {
  const h = timeHorizon([spawn, ev(4, 'tool_call_start', { tool: 'Bash' }), ev(6, 'tool_call_end', { tool: 'Bash' })], 10)
  assert.deepEqual(h.totals, { thinking: 4, tools: 2, subagents: 0, permission: 0, waiting: 4 })
  assert.equal(h.turns, 1)
})

test('the cache lasts its TTL from the start of the request that last used it', () => {
  const opus = (time: number, usage: Record<string, number>, stopReason = 'tool_use') =>
    ev(time, 'model_step', { stopReason, model: 'claude-opus-5-5', usage: { output_tokens: 755, ...usage } })
  // Opus 5.5 in EcoLogits: 75.5 tokens/s and 3.43 s to the first token, so 755 tokens took 13.43 s
  let h = timeHorizon([spawn, opus(100, { cache_creation_input_tokens: 5000, cache_creation_1h_input_tokens: 5000 })], 100)
  assert.equal(h.cache?.ttl, 3600)
  assert.ok(Math.abs(h.cache!.expiresAt - (100 - 13.43 + 3600)) < 1e-9)
  assert.equal(h.cache?.tokens, 5000)

  // A read keeps the 1-hour TTL and refreshes it
  h = timeHorizon([spawn,
    opus(100, { cache_creation_input_tokens: 5000, cache_creation_1h_input_tokens: 5000 }),
    opus(400, { cache_read_input_tokens: 5000 }),
  ], 400)
  assert.equal(h.cache?.ttl, 3600)
  assert.ok(Math.abs(h.cache!.expiresAt - (400 - 13.43 + 3600)) < 1e-9)

  // A 5-minute write
  h = timeHorizon([spawn, opus(50, { cache_creation_input_tokens: 800 })], 50)
  assert.equal(h.cache?.ttl, 300)
})

test('every agent’s requests are emissions', () => {
  const h = timeHorizon([
    spawn,
    ev(1, 'model_step', { usage: { output_tokens: 120 } }),
    ev(2, 'model_step', { agent: 'explorer', usage: { output_tokens: 30 } }),
    ev(9, 'model_step', { usage: { output_tokens: 5 } }),
  ], 5)
  assert.deepEqual(h.emissions, [{ time: 1, outputTokens: 120 }, { time: 2, outputTokens: 30 }])
})

test('the longest stretch of a kind', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user' }),
    ev(2, 'tool_call_start', { tool: 'Bash' }), ev(9, 'tool_call_end', { tool: 'Bash' }),
    ev(10, 'tool_call_start', { tool: 'Read' }), ev(12, 'tool_call_end', { tool: 'Read' }),
    step(13, 'end_turn'),
  ], 20)
  assert.equal(longest(h, 'tools'), 7)
  assert.equal(longest(h, 'waiting'), 7)
  assert.equal(longest(h, 'subagents'), 0)
})

test('each turn keeps its prompt and what it set off', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user', content: 'fix the bug' }),
    ev(2, 'tool_call_start', { tool: 'Bash' }),
    ev(3, 'tool_call_start', { tool: 'Bash' }),        // the same call, reported twice
    ev(6, 'tool_call_end', { tool: 'Bash' }),
    ev(7, 'model_step', { stopReason: 'tool_use', usage: { output_tokens: 40 } }),
    ev(8, 'model_step', { agent: 'explorer', usage: { output_tokens: 10 } }),
    step(10, 'end_turn', { output_tokens: 5 }),
    ev(30, 'message', { role: 'user', content: 'thanks' }),
  ], 34)
  assert.equal(h.turnLog.length, 2)
  assert.deepEqual(h.turnLog[0], { start: 0, end: 10, prompt: 'fix the bug', work: 10, requests: 3, tools: 1, outputTokens: 55 })
  assert.deepEqual(h.turnLog[1], { start: 30, prompt: 'thanks', work: 4, requests: 0, tools: 0, outputTokens: 0 })
})

test('the main agent’s context is sampled after each of its requests', () => {
  const h = timeHorizon([
    spawn,
    ev(5, 'model_step', { usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 98 } }),
    ev(6, 'model_step', { agent: 'explorer', usage: { input_tokens: 9 } }),
  ], 10)
  assert.deepEqual(h.context, [{ time: 5, tokens: 1300 }])
})

test('the context fills at the rate it has been growing', () => {
  // 1000 tokens a minute, 400k into a 1M window: 600 minutes to go
  const samples = [0, 60, 120, 180].map((t, i) => ({ time: t, tokens: 400_000 - 3000 + i * 1000 }))
  const c = predictConsumption(samples, 1_000_000, 180)!
  assert.ok(Math.abs(c.rate - 1000) < 1e-6)
  assert.ok(Math.abs(c.eta - 600 * 60) < 1e-6)
  assert.equal(c.fill, 0.4)
  // Not growing, or too little to go on: no prediction
  assert.equal(predictConsumption(samples.map(s => ({ ...s, tokens: 5000 })), 1_000_000, 180), undefined)
  assert.equal(predictConsumption(samples.slice(0, 2), 1_000_000, 180), undefined)
})

test('subagents are tracked from dispatch to return', () => {
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user', content: 'research it' }),
    ev(1, 'subagent_dispatch', { parent: 'orchestrator', child: 'scout', task: 'Map the payment flow' }),
    ev(1, 'agent_spawn', { agent: undefined, name: 'scout', parent: 'orchestrator' }),
    ev(2, 'model_detected', { agent: 'scout', model: 'claude-haiku-4-5' }),
    ev(3, 'tool_call_start', { agent: 'scout', tool: 'Grep' }),
    ev(4, 'model_step', { agent: 'scout', usage: { output_tokens: 300 } }),
    ev(9, 'subagent_return', { child: 'scout', parent: 'orchestrator', summary: 'Three services, one queue' }),
    ev(9, 'agent_complete', { agent: undefined, name: 'scout' }),
  ], 12)
  assert.deepEqual(h.subagents, [{
    name: 'scout', start: 1, end: 9, task: 'Map the payment flow', model: 'claude-haiku-4-5',
    summary: 'Three services, one queue', requests: 1, tools: 1, outputTokens: 300,
  }])
})

test('subagents in parallel pack more agent time than the wall clock', () => {
  // As the relay sends them: a spawn and a completion name the agent, with no `agent` field
  const sub = (name: string, from: number, to?: number) => [
    ev(from, 'agent_spawn', { agent: undefined, name, parent: 'orchestrator' }),
    ...(to === undefined ? [] : [ev(to, 'agent_complete', { agent: undefined, name })]),
  ]
  const h = timeHorizon([
    spawn,
    ev(0, 'message', { role: 'user' }),
    ev(2, 'tool_call_start', { tool: 'Agent' }),
    ...sub('a', 2, 12), ...sub('b', 2, 10), ...sub('c', 4),
    ev(12, 'tool_call_end', { tool: 'Agent' }),
  ].sort((x, y) => x.time - y.time), 20)
  // Main: thinking 0-2 and 12-20; subagents 10 + 8 + 16 (c still out)
  const p = parallelism(h)
  assert.equal(p.agentTime, 10 + 10 + 8 + 16)
  assert.equal(p.peak, 3)
})

test('durations read as m:ss or h:mm:ss', () => {
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3723.9), '1:02:03')
  assert.equal(formatDuration(-4), '0:00')
})
