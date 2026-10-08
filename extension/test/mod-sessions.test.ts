/**
 * Unit tests for the names a reported session's subagents go under.
 *
 * The mod spawns a subagent under a name its transcript's meta file doesn't carry (a teammate's
 * name in the team, a workflow agent's place in its run): the transcript's lines must go under it
 * too, or they land on a node that doesn't exist.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { markModSession, forgetModSession, nameReportedAgent, reportedAgentName } from '../src/mod-sessions'
import { agentIdFromFile } from '../src/subagent-watcher'
import { workflowAgentName } from '../src/constants'

describe('reported agent names', () => {
  it('are kept per session until it is forgotten', () => {
    markModSession('s1')
    nameReportedAgent('s1', 'a4c6', 'Review an adapter #2')
    assert.equal(reportedAgentName('s1', 'a4c6'), 'Review an adapter #2')
    assert.equal(reportedAgentName('s2', 'a4c6'), undefined)
    forgetModSession('s1')
    assert.equal(reportedAgentName('s1', 'a4c6'), undefined)
  })

  it('are found by the id in the transcript\'s file name', () => {
    assert.equal(agentIdFromFile('/p/session/subagents/agent-a4c607504e3e10fba.jsonl'), 'a4c607504e3e10fba')
    assert.equal(agentIdFromFile('/p/session/subagents/notes.jsonl'), undefined)
  })
})

describe('workflowAgentName', () => {
  it('names an agent by its task and place, and by its run when that name is taken', () => {
    const first = { runId: 'wf_aaaa7f3a', index: 1 }
    assert.equal(workflowAgentName('Review an adapter', first, ['main', 'Explore']), 'Review an adapter #1')
    const again = { runId: 'wf_bbbb91c2', index: 1 }
    assert.equal(workflowAgentName('Review an adapter', again, ['Review an adapter #1']), 'Review an adapter #1 91c2')
  })
})
