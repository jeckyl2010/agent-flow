import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '../web/lib/agent-types'
import { WORMHOLE } from '../web/lib/canvas-constants'
import type { Agent } from '../web/lib/agent-types'
import { IDLE_COMPACT, compactionDrop, compactionLabel, foldCompaction, idleCompactionIn, triggerLabel, wormholeFrame } from '../web/lib/compaction'
import { timeHorizon, predictConsumption } from '../web/lib/time-horizon'

test('a compaction is labelled by what it did', () => {
  assert.equal(compactionLabel({ tokensBefore: 967_619, tokensAfter: 13_246 }), '968k → 13.2k')
  assert.equal(compactionLabel({}), 'compacted')
  assert.equal(Math.round(compactionDrop({ tokensBefore: 100, tokensAfter: 6 })! * 100), 94)
})

test('a compaction seen running opens, then jumps when it ends', () => {
  const running = { phase: 'running' as const, startTime: 10 }
  assert.equal(wormholeFrame(running, 9), undefined)
  assert.ok(wormholeFrame(running, 10.2)!.open < 1)
  assert.equal(wormholeFrame(running, 40)!.open, 1) // stays open while Claude Code summarizes
  const done = { phase: 'done' as const, startTime: 10, endTime: 40 }
  assert.equal(wormholeFrame(done, 40.5)!.jump, 0.5)
  assert.equal(wormholeFrame(done, 40 + WORMHOLE.jump + 0.1), undefined)
})

test('a compaction seen only ended opens first, then jumps; one from before is never drawn', () => {
  const ended = { phase: 'done' as const, startTime: 20, endTime: 20 }
  assert.equal(wormholeFrame(ended, 20.3)!.jump, undefined)
  assert.ok(Math.abs(wormholeFrame(ended, 20 + WORMHOLE.open + 0.5)!.jump! - 0.5) < 1e-9)
  assert.equal(wormholeFrame({ ...ended, isHistory: true }, 20.3), undefined)
})

test('a start and its end make one compaction', () => {
  const started = foldCompaction([], { phase: 'start', trigger: 'manual' }, 66)!
  assert.equal(started[0].phase, 'running')
  assert.equal(foldCompaction(started, { phase: 'start' }, 67), undefined) // reported twice
  const ended = foldCompaction(started, { phase: 'end', tokensBefore: 52_400, tokensAfter: 6_100 }, 70)!
  assert.deepEqual(ended, [{ phase: 'done', startTime: 66, endTime: 70, trigger: 'manual', at: undefined, tokensBefore: 52_400, tokensAfter: 6_100 }])
})

test('an end with none running is one of its own; a skip closes the one running', () => {
  assert.deepEqual(foldCompaction([], { phase: 'end', tokensAfter: 9, isHistory: true }, 0)!.map(c => [c.phase, c.isHistory]), [['done', true]])
  assert.equal(foldCompaction([], { phase: 'skipped' }, 0), undefined)
  const skipped = foldCompaction(foldCompaction([], { phase: 'start' }, 1)!, { phase: 'skipped', reason: 'nothing to compact' }, 2)!
  assert.deepEqual([skipped[0].phase, skipped[0].reason], ['skipped', 'nothing to compact'])
})

test('the time horizon fits the context since the last compaction, toward where it compacts', () => {
  const ev = (time: number, type: SimulationEvent['type'], payload: Record<string, unknown> = {}): SimulationEvent =>
    ({ time, type, payload: { agent: 'orchestrator', ...payload } })
  const step = (time: number, tokens: number) => ev(time, 'model_step', { stopReason: 'tool_use', usage: { input_tokens: tokens, output_tokens: 0 } })
  const events = [
    ev(0, 'agent_spawn', { name: 'orchestrator', isMain: true }),
    ev(1, 'session_measure', { compactThreshold: 160_000 }),
    step(10, 100_000), step(20, 120_000), step(30, 140_000),
    ev(30, 'context_compaction', { phase: 'end', tokensBefore: 140_000, tokensAfter: 10_000 }),
    step(40, 20_000), step(50, 30_000),
  ]
  const h = timeHorizon(events, 50)
  assert.equal(h.compactThreshold, 160_000)
  assert.deepEqual(h.compactions.map(c => c.time), [30])
  assert.deepEqual(h.context.map(c => c.tokens), [10_000, 20_000, 30_000])
  // 1,000 tokens a second from 30k: 130s to the threshold
  assert.equal(Math.round(predictConsumption(h.context, h.compactThreshold!, 50)!.eta), 130)
})

test('a conversation of 200K tokens or more whose turn ended is forecast to compact 54 minutes after it last did anything', () => {
  // Between turns the main agent isn't `idle` (its state stays `thinking`): its turn's end says so
  const main = { id: 'orchestrator', state: 'thinking', tokensUsed: 240_000 } as Agent
  const events: SimulationEvent[] = [
    { time: 100, type: 'message', payload: { agent: 'orchestrator' } },
    { time: 400, type: 'agent_idle', payload: { name: 'orchestrator' } }, // a transcript gone quiet, later
    { time: 410, type: 'session_measure', payload: {} }, // measured, not done: the clock goes on
  ]
  assert.equal(idleCompactionIn(main, events, 430), 100 + IDLE_COMPACT.afterS - 430)
  assert.equal(idleCompactionIn(main, events, 100 + IDLE_COMPACT.afterS + 1), undefined) // past due
  assert.equal(idleCompactionIn({ ...main, tokensUsed: 150_000 }, events, 430), undefined)
  assert.ok(idleCompactionIn({ ...main, tokensUsed: 150_000, idleCompactMin: 100_000 }, events, 430)! > 0)
  // A turn under way, or the session over
  assert.equal(idleCompactionIn(main, events.slice(0, 1), 430), undefined)
  assert.equal(idleCompactionIn(main, [...events, { time: 420, type: 'tool_call_start', payload: {} }], 430), undefined)
  assert.equal(idleCompactionIn(main, [...events, { time: 420, type: 'agent_complete', payload: { name: 'orchestrator', sessionEnd: true } }], 430), undefined)
})

test('a compaction is named by what started it', () => {
  assert.equal(triggerLabel('manual'), '/compact')
  assert.equal(triggerLabel('idle'), 'idle, before the cache lapsed')
  assert.equal(triggerLabel('auto'), 'auto')
  assert.equal(triggerLabel(undefined), 'compacted')
})
