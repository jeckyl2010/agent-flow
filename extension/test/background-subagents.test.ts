/**
 * Unit tests for subagents run in the background and forks, as a transcript records them: a
 * background agent's Agent call answers at once, so its end comes from the task notification the
 * main conversation gets later. Also whether idle compaction can run where a session ran, and why a
 * permission dialog asks.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { emitSubagentSpawn, type AgentEvent } from '../src/protocol'
import { TranscriptParser, parseTaskNotification } from '../src/transcript-parser'
import { createWatchedSession } from '../src/watched-session'
import { ORCHESTRATOR_NAME } from '../src/constants'
import { canIdleCompact, idleCompactionSetting, isCompactionDisabled, isVersionAtLeast } from '../src/idle-compaction'
import { permissionWhy } from '../src/permission-why'

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
  const line = (entry: Record<string, unknown>) =>
    parser.processTranscriptLine(JSON.stringify(entry), ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, 's1', session.seenMessageHashes)
  return { session, events, line }
}

const agentCall = (id: string, input: Record<string, unknown>) => ({
  type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] },
})
const agentResult = (id: string, text: string) => ({
  type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
})
const notification = (id: string) => ({
  type: 'user', uuid: `n-${id}`, message: { role: 'user', content: [
    '<task-notification>', `<task-id>a590dd</task-id>`, `<tool-use-id>${id}</tool-use-id>`,
    '<status>completed</status>', '<summary>Agent "Review the plan" finished</summary>', '</task-notification>',
  ].join('\n') },
})

describe('subagents in the background', () => {
  it('a background launch keeps its agent out until the task notification says it ended', () => {
    const { events, line } = setup()
    line(agentCall('tu-1', { description: 'Review the plan', prompt: 'Review it', subagent_type: 'reviewer' }))
    line(agentResult('tu-1', 'Async agent launched successfully. (This tool result is internal metadata)\nagentId: a590dd'))

    assert.deepEqual(events.filter(e => e.type === 'agent_status').map(e => e.payload),
      [{ name: 'Review the plan', status: 'running', background: true }])
    assert.equal(events.some(e => e.type === 'subagent_return' || e.type === 'agent_complete'), false)

    line(notification('tu-1'))
    const ends = events.filter(e => e.type === 'subagent_return' || e.type === 'agent_complete')
    assert.deepEqual(ends.map(e => [e.type, e.payload.child ?? e.payload.name]), [
      ['subagent_return', 'Review the plan'], ['agent_complete', 'Review the plan'],
    ])
    assert.equal(ends[0]!.payload.summary, 'Agent "Review the plan" finished')
  })

  it('an agent run in the foreground ends with its call, as before', () => {
    const { events, line } = setup()
    line(agentCall('tu-2', { description: 'Find the config', prompt: 'Look', subagent_type: 'Explore' }))
    line(agentResult('tu-2', 'The config is in src/config.ts'))
    assert.deepEqual(events.filter(e => e.type === 'subagent_return' || e.type === 'agent_complete').map(e => e.type),
      ['subagent_return', 'agent_complete'])
  })

  it('a fork, and an agent asked to run in the background, are spawned as such', () => {
    const { events, line } = setup()
    line(agentCall('tu-3', { description: 'Explore', prompt: 'Look', subagent_type: 'fork' }))
    line(agentCall('tu-4', { description: 'Write docs', prompt: 'Write', subagent_type: 'writer', run_in_background: true }))
    const spawns = events.filter(e => e.type === 'agent_spawn').map(e => [e.payload.fork, e.payload.background])
    assert.deepEqual(spawns, [[true, undefined], [undefined, true]])
  })

  it('a notification for no launch it knows of changes nothing', () => {
    const { events, line } = setup()
    line(notification('tu-unknown'))
    assert.equal(events.some(e => e.type === 'subagent_return'), false)
  })

  it('reads a task notification’s call, status and summary', () => {
    assert.deepEqual(parseTaskNotification(notification('tu-9').message.content as string),
      { toolUseId: 'tu-9', status: 'completed', summary: 'Agent "Review the plan" finished' })
    assert.equal(parseTaskNotification('Just a message'), undefined)
  })

  it('emitSubagentSpawn carries fork and background only when set', () => {
    const events: AgentEvent[] = []
    const spawn = (options?: Parameters<typeof emitSubagentSpawn>[5]) => {
      emitSubagentSpawn({ emit: e => events.push(e), elapsed: () => 1 }, 'orchestrator', 'Explore', 'Explore', 's1', options)
      return events.filter(e => e.type === 'agent_spawn').at(-1)!.payload
    }
    assert.deepEqual([spawn({ fork: true }).fork, spawn({ background: true }).background], [true, true])
    const plain = spawn()
    assert.equal('fork' in plain || 'background' in plain, false)
  })
})

describe('idle compaction', () => {
  it('a session in VS Code before 2.1.314 is told it gets none, once', () => {
    const { events, line } = setup()
    const said = (text: string) => ({ type: 'user', uuid: text, entrypoint: 'claude-vscode', version: '2.1.312', cwd: '/nowhere', message: { role: 'user', content: text } })
    line(said('first'))
    line(said('second'))
    assert.deepEqual(events.filter(e => e.type === 'session_measure').map(e => e.payload),
      [{ agent: ORCHESTRATOR_NAME, idleCompaction: false }])
  })

  it('a session in VS Code on 2.1.314 is told it can', () => {
    const { events, line } = setup()
    line({ type: 'user', uuid: 'u1', entrypoint: 'claude-vscode', version: '2.1.314', cwd: '/nowhere', message: { role: 'user', content: 'hi' } })
    assert.deepEqual(events.filter(e => e.type === 'session_measure').map(e => e.payload),
      [{ agent: ORCHESTRATOR_NAME, idleCompaction: true }])
  })

  it('runs in the terminal unless a settings file turns it off, the project’s over the user’s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-idle-'))
    const home = path.join(dir, 'home')
    const project = path.join(dir, 'project')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    try {
      assert.equal(canIdleCompact('cli', '2.1.314', project, home), true)
      assert.equal(canIdleCompact('sdk-ts', '2.1.314', project, home), false)

      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ idleCompaction: false }))
      assert.equal(canIdleCompact('cli', '2.1.314', project, home), false)

      fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ idleCompaction: true }))
      assert.equal(idleCompactionSetting(project, home), true)
      assert.equal(canIdleCompact('cli', '2.1.314', project, home), true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs in VS Code and the desktop app’s Code tab from 2.1.314', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-idle-'))
    try {
      assert.equal(canIdleCompact('claude-vscode', '2.1.314', dir, dir), true)
      assert.equal(canIdleCompact('claude-desktop', '2.1.320', dir, dir), true)
      assert.equal(canIdleCompact('claude-vscode', '2.1.312', dir, dir), false)
      assert.equal(canIdleCompact('claude-desktop', undefined, dir, dir), false)
      assert.equal(canIdleCompact('sdk-py', '2.1.314', dir, dir), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compares Claude Code versions', () => {
    assert.equal(isVersionAtLeast('2.1.314', '2.1.314'), true)
    assert.equal(isVersionAtLeast('2.2.0', '2.1.314'), true)
    assert.equal(isVersionAtLeast('2.1.99', '2.1.314'), false)
    assert.equal(isVersionAtLeast('2.1.315-dev', '2.1.314'), true)
    assert.equal(isVersionAtLeast('garbage', '2.1.314'), false)
  })

  it('is off, with auto-compaction, where any settings file’s env sets DISABLE_COMPACT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-idle-'))
    const home = path.join(dir, 'home')
    const project = path.join(dir, 'project')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
    try {
      fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { DISABLE_COMPACT: 'false' } }))
      assert.equal(isCompactionDisabled(project, home), false)

      // Since 2.1.311 a file can only turn it on: the user's holds over the project's `false`
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { DISABLE_COMPACT: '1' } }))
      assert.equal(isCompactionDisabled(project, home), true)
      assert.equal(canIdleCompact('cli', '2.1.314', project, home), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tells the web auto-compaction is off where a settings file turns all compaction off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-idle-'))
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { DISABLE_COMPACT: 'true' } }))
    try {
      const { events, line } = setup()
      line({ type: 'user', uuid: 'u1', entrypoint: 'cli', cwd: dir, message: { role: 'user', content: 'hi' } })
      assert.deepEqual(events.filter(e => e.type === 'session_measure').map(e => e.payload),
        [{ agent: ORCHESTRATOR_NAME, idleCompaction: false, autoCompact: false }])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('why a permission dialog asks', () => {
  it('names the hook that asked, and says when only you can approve it', () => {
    assert.equal(permissionWhy({ hook: 'PreToolUse', reason: 'Migrations change the shared database', decider: 'person' }),
      'A PreToolUse hook asks: Migrations change the shared database · only you can approve it')
    assert.equal(permissionWhy({ decider: 'person' }), 'Only you can approve it')
  })

  it('names a setting’s check in words where it can, by its key otherwise', () => {
    assert.equal(permissionWhy({ setting: 'permissions.blockReadsOutsideWorkingDirectories' }), 'It reads outside the working directories')
    assert.equal(permissionWhy({ setting: 'sandbox.network' }), 'Setting sandbox.network')
  })

  it('keeps the organization’s requirement and a rule first', () => {
    assert.equal(permissionWhy({ ceiling: 'ask', rule: 'Bash(git push:*)', hook: 'PreToolUse' }), 'Your organization requires approval')
    assert.equal(permissionWhy({ rule: 'Bash(git push:*)', hook: 'PreToolUse' }), 'Rule Bash(git push:*)')
  })
})
