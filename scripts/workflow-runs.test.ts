import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent } from '../web/lib/agent-types'
import { asWorkflow, latestOfRun, workflowRuns } from '../web/lib/workflow'

const agent = (name: string, parentId: string | null, workflow?: { runId: string; index: number }, opacity = 1) =>
  ({ id: name, name, parentId, opacity, ...(workflow ? { workflow } : {}) }) as Agent

test('an agent_spawn\'s workflow is read only when whole', () => {
  assert.deepEqual(asWorkflow({ runId: 'wf_a', index: 2 }), { runId: 'wf_a', index: 2 })
  assert.equal(asWorkflow({ runId: 'wf_a' }), undefined)
  assert.equal(asWorkflow({ runId: '', index: 1 }), undefined)
  assert.equal(asWorkflow(undefined), undefined)
})

test('a workflow\'s agent spawns beside the one its run started last before it, under the same parent', () => {
  const agents = [
    agent('A #1', 'main', { runId: 'wf_a', index: 1 }),
    agent('A #3', 'main', { runId: 'wf_a', index: 3 }),
    agent('B #1', 'main', { runId: 'wf_b', index: 1 }),
    agent('Explore', 'main'),
    agent('A #2 elsewhere', 'other', { runId: 'wf_a', index: 2 }),
  ]
  assert.equal(latestOfRun(agents, 'main', { runId: 'wf_a', index: 2 })?.name, 'A #1')
  assert.equal(latestOfRun(agents, 'main', { runId: 'wf_a', index: 4 })?.name, 'A #3')
  assert.equal(latestOfRun(agents, 'main', { runId: 'wf_a', index: 1 }), undefined)
  assert.equal(latestOfRun(agents, 'main', { runId: 'wf_c', index: 2 }), undefined)
})

test('a run is drawn through its visible agents in the order the script started them', () => {
  const runs = workflowRuns([
    agent('B #2', 'main', { runId: 'wf_a', index: 2 }),
    agent('A #1', 'main', { runId: 'wf_a', index: 1 }),
    agent('C #1', 'main', { runId: 'wf_b', index: 1 }),
    agent('faded #3', 'main', { runId: 'wf_a', index: 3 }, 0),
    agent('Explore', 'main'),
    agent('A #4 elsewhere', 'other', { runId: 'wf_a', index: 4 }),
  ])
  // One run's agents under another parent are laid out beside it: a line of their own
  assert.deepEqual(runs.map(r => r.map(a => a.name)), [['A #1', 'B #2'], ['C #1'], ['A #4 elsewhere']])
})
