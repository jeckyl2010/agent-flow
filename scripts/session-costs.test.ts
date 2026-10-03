import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent, AgentSpend } from '../web/lib/agent-types'
import { sessionCosts, formatCost } from '../web/lib/session-costs'

function agent(id: string, fields: Partial<Agent> = {}): Agent {
  return { id, name: id, isMain: false, tokensUsed: 0, model: 'claude-opus-5-5', ...fields } as Agent
}

function spend(cost: number, isComplete: boolean): AgentSpend {
  return { cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 1, isComplete }
}

const agents = (...list: Agent[]) => new Map(list.map(a => [a.id, a]))

test('with the session’s cost, the total is exact and the main agent gets the rest', () => {
  const costs = sessionCosts(agents(
    agent('main', { isMain: true, sessionCostUsd: 5, spend: spend(1, false) }),
    agent('sub', { spend: spend(1.5, true) }),
  ))
  assert.deepEqual(costs.total, { cost: 5, isExact: true })
  assert.deepEqual(costs.byAgent.get('main'), { cost: 3.5, isExact: true })
  assert.deepEqual(costs.byAgent.get('sub'), { cost: 1.5, isExact: true })
})

test('a subagent not watched from its start keeps the main agent an estimate', () => {
  const costs = sessionCosts(agents(
    agent('main', { isMain: true, sessionCostUsd: 5, spend: spend(1, false) }),
    agent('sub', { spend: spend(1.5, false) }),
  ))
  assert.deepEqual(costs.total, { cost: 5, isExact: true })
  assert.deepEqual(costs.byAgent.get('main'), { cost: 1, isExact: false })
  assert.equal(costs.byAgent.get('sub')!.isExact, false)
})

test('without the session’s cost, the total sums the agents and is exact only if they all are', () => {
  const partial = sessionCosts(agents(
    agent('main', { isMain: true, spend: spend(1, false) }),
    agent('sub', { spend: spend(2, true) }),
  ))
  assert.deepEqual(partial.total, { cost: 3, isExact: false })

  const estimated = sessionCosts(agents(agent('main', { isMain: true, tokensUsed: 1_000_000 })))
  // Opus 5.5 blended: 0.75 × $4 + 0.25 × $20
  assert.deepEqual(estimated.total, { cost: 8, isExact: false })
})

test('an estimate is marked with ~', () => {
  assert.equal(formatCost({ cost: 1.23456, isExact: true }, 3), '$1.235')
  assert.equal(formatCost({ cost: 1.23456, isExact: false }, 2), '~$1.23')
})
