/**
 * Unit tests for the request records 2.1.300+ transcripts carry: the main thread's system prompt and
 * tool definitions, measured from the shape its requests were sent with, replace the guess.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TranscriptParser } from '../src/transcript-parser'
import { createWatchedSession } from '../src/watched-session'
import { CHARS_PER_TOKEN, ORCHESTRATOR_NAME, SYSTEM_PROMPT_BASE_TOKENS } from '../src/constants'

const system = [{ type: 'text', text: 'You are Claude Code. '.repeat(1000) }]
const tools = [{ name: 'Bash', description: 'Runs a command. '.repeat(2000), input_schema: { type: 'object' } }]
const shape = { type: 'api-request-shape', sessionId: 's1', shapeHash: 'h1', shape: { system, tools } }
const request = (querySource: string, shapeHash = 'h1') => ({ type: 'api-request', sessionId: 's1', id: 'r1', querySource, shapeHash, params: {} })
const measured = Math.ceil((JSON.stringify(system) + JSON.stringify(tools)).length / CHARS_PER_TOKEN)

function setup() {
  const session = createWatchedSession('s1', '/nowhere.jsonl', { label: 's1', lastActivityTime: 0 })
  let updates = 0
  const parser = new TranscriptParser({
    emit: () => {},
    elapsed: () => 5,
    getSession: () => session,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => { updates++ },
  })
  const read = (line: object, agent = ORCHESTRATOR_NAME) => parser.processTranscriptLine(JSON.stringify(line), agent, new Map(), new Set(), 's1', new Set())
  return { session, parser, read, updates: () => updates }
}

describe('request records in a transcript', () => {
  it('the main thread’s request measures the system prompt and tools it was sent with', () => {
    const { session, read, updates } = setup()
    read(shape)
    assert.equal(session.contextBreakdown.systemPrompt, SYSTEM_PROMPT_BASE_TOKENS) // not used yet
    read(request('repl_main_thread:outputStyle:Explanatory'))
    assert.equal(session.contextBreakdown.systemPrompt, measured)
    assert.equal(updates(), 1)
    read(request('repl_main_thread'))
    assert.equal(updates(), 1) // unchanged: nothing sent again
  })

  it('a subagent’s request, another source’s or an unknown shape changes nothing', () => {
    const { session, read } = setup()
    read(shape)
    read(request('agent:builtin:Explore'))
    read(request('compact'))
    read(request('repl_main_thread', 'unseen'))
    read(shape, 'Explore the code')
    read(request('repl_main_thread'), 'Explore the code')
    assert.equal(session.contextBreakdown.systemPrompt, SYSTEM_PROMPT_BASE_TOKENS)
  })

  it('a transcript read from the start is measured by its requests', () => {
    const { session, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-request-shape-'))
    const file = path.join(dir, 's1.jsonl')
    fs.writeFileSync(file, [shape, request('repl_main_thread')].map(l => JSON.stringify(l)).join('\n') + '\n')
    try {
      parser.prescanExistingContent(file, fs.statSync(file).size, session)
      assert.equal(session.contextBreakdown.systemPrompt, measured)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
