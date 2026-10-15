/**
 * Unit tests for compactions read from Claude Code transcripts: a `compact_boundary` entry is
 * shown as one, and the context estimate starts over from it, history from before it included.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AgentEvent } from '../src/protocol'
import { TranscriptParser } from '../src/transcript-parser'
import { createWatchedSession } from '../src/watched-session'
import { ORCHESTRATOR_NAME, SYSTEM_PROMPT_BASE_TOKENS } from '../src/constants'

const boundary = {
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: '2026-10-06T10:00:00.000Z',
  compactMetadata: { trigger: 'auto', preTokens: 967_619, postTokens: 13_246, durationMs: 27_585 },
}
const said = (text: string) => ({ type: 'user', uuid: text, message: { role: 'user', content: text.repeat(400) } })

function setup() {
  const session = createWatchedSession('s1', '/nowhere.jsonl', { label: 's1', lastActivityTime: 0 })
  const events: AgentEvent[] = []
  const parser = new TranscriptParser({
    emit: event => { events.push(event) },
    elapsed: () => 5,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  })
  return { session, events, parser }
}

describe('compactions in a transcript', () => {
  it('a compaction written as it happens is shown, and the estimate starts over', () => {
    const { session, events, parser } = setup()
    parser.processTranscriptLine(JSON.stringify(said('before')), ORCHESTRATOR_NAME, new Map(), new Set(), 's1', new Set())
    assert.ok(session.contextBreakdown.userMessages > 0)

    parser.processTranscriptLine(JSON.stringify(boundary), ORCHESTRATOR_NAME, new Map(), new Set(), 's1', new Set())

    assert.equal(session.contextBreakdown.userMessages, 0)
    assert.equal(session.contextBreakdown.systemPrompt, SYSTEM_PROMPT_BASE_TOKENS)
    const shown = events.find(e => e.type === 'context_compaction')
    assert.deepEqual(shown?.payload, {
      agent: ORCHESTRATOR_NAME, phase: 'end', trigger: 'auto',
      tokensBefore: 967_619, tokensAfter: 13_246, durationMs: 27_585, at: '2026-10-06T10:00:00.000Z',
    })
  })

  it('compactions from before it was watched are listed as history, and only what followed is counted', () => {
    const { session, events, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-compaction-'))
    const file = path.join(dir, 's1.jsonl')
    fs.writeFileSync(file, [said('old'), boundary, said('new')].map(l => JSON.stringify(l)).join('\n') + '\n')
    try {
      const entries = parser.prescanExistingContent(file, fs.statSync(file).size, session)
      parser.emitCatchUpEntries(entries, session, 's1')

      // Only the message after the compaction is in the context
      const oneMessage = setup()
      oneMessage.parser.processTranscriptLine(JSON.stringify(said('new')), ORCHESTRATOR_NAME, new Map(), new Set(), 's1', new Set())
      assert.equal(session.contextBreakdown.userMessages, oneMessage.session.contextBreakdown.userMessages)

      const history = events.filter(e => e.type === 'context_compaction')
      assert.equal(history.length, 1)
      assert.equal(history[0].payload.isHistory, true)
      assert.equal(history[0].payload.tokensAfter, 13_246)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an auto compaction 50 to 60 minutes after the latest entry is idle compaction’s; one sooner stays auto', () => {
    const at = (iso: string, line: object) => JSON.stringify({ ...line, timestamp: iso })
    const triggers = (lastEntry: string) => {
      const { events, parser } = setup()
      parser.processTranscriptLine(at(lastEntry, said('before')), ORCHESTRATOR_NAME, new Map(), new Set(), 's1', new Set())
      parser.processTranscriptLine(JSON.stringify(boundary), ORCHESTRATOR_NAME, new Map(), new Set(), 's1', new Set())
      return events.find(e => e.type === 'context_compaction')?.payload.trigger
    }
    // The boundary is written at 10:00
    assert.equal(triggers('2026-10-06T09:06:00.000Z'), 'idle')
    assert.equal(triggers('2026-10-06T09:58:00.000Z'), 'auto')
    assert.equal(triggers('2026-10-06T07:00:00.000Z'), 'auto') // resumed hours later: not idle's
  })

  it('a compaction from before it was watched is told idle by the entry before it', () => {
    const { session, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-compaction-'))
    const file = path.join(dir, 's1.jsonl')
    fs.writeFileSync(file, [{ ...said('old'), timestamp: '2026-10-06T09:05:30.000Z' }, boundary].map(l => JSON.stringify(l)).join('\n') + '\n')
    try {
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      assert.deepEqual(session.pastCompactions.map(c => c.trigger), ['idle'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
