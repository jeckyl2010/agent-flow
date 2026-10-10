/**
 * Unit tests for a subagent's spawn as the relay emits it: what the bridge mod read of its type
 * reaches the web with it.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emitSubagentSpawn, type AgentEvent } from '../src/protocol'

function spawned(options?: Parameters<typeof emitSubagentSpawn>[5]): Record<string, unknown> {
  const events: AgentEvent[] = []
  emitSubagentSpawn({ emit: e => events.push(e), elapsed: () => 1 }, 'orchestrator', 'Review', 'Review the diff', 's1', options)
  return events.find(e => e.type === 'agent_spawn')!.payload
}

describe('emitSubagentSpawn', () => {
  it('carries the autoCompactWindow its agent file sets', () => {
    assert.equal(spawned({ autoCompactWindow: 150_000 }).autoCompactWindow, 150_000)
  })

  it('leaves it out where none was read', () => {
    assert.equal('autoCompactWindow' in spawned(), false)
    assert.equal('autoCompactWindow' in spawned({ isTeammate: true }), false)
  })
})
