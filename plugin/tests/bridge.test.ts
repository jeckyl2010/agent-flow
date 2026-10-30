import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const WORKSPACE = '/work/app'

/** One Agent Flow watching WORKSPACE (port 4001) and one elsewhere (4002); answers what flush and discovery call */
function agentFlow(on: On, env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me', ...env })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: `${WORKSPACE}/src` }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, realPath: `${WORKSPACE}/src` } as never }))
  on('fs.list', () => ({ value: [
    { name: 'aaa-1.json', kind: 'file', size: 1 },
    { name: 'bbb-2.json', kind: 'file', size: 1 },
    { name: 'workspaces.json', kind: 'file', size: 1 },
  ] as never }))
  on('fs.read', (_$, e) => {
    if (e.path in files) return { value: files[e.path]! }
    if (e.path.endsWith('.md')) throw new Error(`ENOENT: ${e.path}`)
    return { value: e.path.endsWith('aaa-1.json')
      ? JSON.stringify({ port: 4001, pid: 1, workspace: WORKSPACE })
      : JSON.stringify({ port: 4002, pid: 2, workspace: '/elsewhere' }) }
  })

  const posts: { url: string; body: Record<string, unknown> }[] = []
  on('http.fetch', (_$, e) => {
    posts.push({ url: e.url, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  return { clock, posts }
}

test('a tool call reaches the Agent Flow watching its workspace, start then end', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('tool.call', () => ({ result: { stdout: 'hi' } as never, text: 'hi' } as never))

  await $.tool.call({ tool: 'Bash', command: 'echo hi', tool_use_id: 'tu-1' } as never)
  await clock.settle()

  expect(posts.map(p => p.url)).toEqual(['http://127.0.0.1:4001/', 'http://127.0.0.1:4001/'])
  expect(posts.map(p => p.body.hook_event_name)).toEqual(['PreToolUse', 'PostToolUse'])
  expect(posts[0]!.body).toEqual(expect.objectContaining({
    session_id: 'session-1', agent_flow_source: 'mod', tool_name: 'Bash',
    tool_use_id: 'tu-1', tool_input: { command: 'echo hi' },
  }))
  expect(posts[1]!.body.tool_response).toEqual('hi')
})

test('a call refused before it ran is sent as blocked; one that ran and failed is not', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('tool.call', (_$, e) => (e.tool_use_id === 'tu-1'
    ? { deny: 'Blocked by auto mode' }
    : { result: {} as never, text: 'exit 1', isError: true }) as never)

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-1' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: 'tu-2' } as never).catch(() => undefined)
  await clock.settle()

  const ends = posts.map(p => p.body).filter(b => b.hook_event_name === 'PostToolUseFailure')
  expect(ends.map(b => [b.tool_use_id, b.blocked])).toEqual([['tu-1', true], ['tu-2', undefined]])
  expect(ends[0]!.error).toEqual('Blocked by auto mode')
})

test('a permission request is sent when the dialog shows', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('classic.PermissionRequest', () => ({}))

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
  await clock.settle()

  expect(posts.map(p => p.body)).toEqual([expect.objectContaining({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
  })])
})

test('an Agent Flow that never answers does not stall the events after it', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: WORKSPACE }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, realPath: WORKSPACE } as never }))
  on('fs.list', () => ({ value: [{ name: 'aaa-1.json', kind: 'file', size: 1 }] as never }))
  on('fs.read', () => ({ value: JSON.stringify({ port: 4001, pid: 1, workspace: WORKSPACE }) }))
  const answered: string[] = []
  let calls = 0
  on('http.fetch', (_$, e) => {
    if (calls++ === 0) return new Promise(() => {}) // the first instance hangs
    answered.push(JSON.parse(e.init?.body ?? '{}').hook_event_name)
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  on('tool.call', () => ({ result: { stdout: '' } as never, text: '' } as never))

  await $.tool.call({ tool: 'Bash', command: 'true', tool_use_id: 'tu-1' } as never)
  await clock.advance(1_000)

  expect(answered).toEqual(['PostToolUse'])
})

test('a streamed answer is sent as it grows, then whole, then the request’s usage', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.25 } } }))
  const { clock, posts } = agentFlow(on)
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'Hel' } as never
    yield { kind: 'text', index: 0, text: 'lo' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage } as never
    return { turnId: 't1', index: 0, answer: 'Hello', toolUses: [], stopReason: 'end_turn', usage }
  })

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) { /* read it all */ }
  await clock.settle()

  const outputs = posts.map(p => p.body).filter(b => b.hook_event_name === 'ModelOutput')
  expect(outputs.at(-1)).toEqual(expect.objectContaining({ stream_id: 't1:0:0', role: 'assistant', content: 'Hello', is_final: true }))
  expect(outputs.every(o => o.stream_id === 't1:0:0')).toBe(true)
  expect(posts.at(-1)!.body).toEqual(expect.objectContaining({ hook_event_name: 'ModelStep', model: 'claude-opus-5-5', effort: 'high', usage, session_cost_usd: 1.25 }))
})

test('a session on Amazon Bedrock reports its region with each request', async ($, on) => {
  const { clock, posts } = agentFlow(on, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'eu.anthropic.claude-opus-4-7' }
  on('turn.step', async function* () {
    yield { kind: 'stop', stopReason: 'end_turn', usage } as never
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })

  await $.session.start({ cwd: `${WORKSPACE}/src` } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'eu.anthropic.claude-opus-4-7', messageCount: 1 } as never)) { /* read it all */ }
  await clock.settle()

  const step = posts.map(p => p.body).find(b => b.hook_event_name === 'ModelStep')
  expect(step).toEqual(expect.objectContaining({ inference: { platform: 'bedrock', region: 'eu-west-1' } }))
})

for (const [name, env, gateway] of [
  ['a gateway in front of Anthropic is named by its host', { ANTHROPIC_BASE_URL: 'http://localhost:4000/v1?key=secret' }, 'localhost:4000'],
  ['Anthropic’s own address is no gateway', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, undefined],
  ['a gateway in front of Bedrock is named, its region kept', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', ANTHROPIC_BEDROCK_BASE_URL: 'https://llm.corp.example' }, 'llm.corp.example'],
] as const) {
  test(name, async ($, on) => {
    const { clock, posts } = agentFlow(on, env as Record<string, string>)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    on('turn.step', async function* () {
      yield { kind: 'stop', stopReason: 'end_turn', usage } as never
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage }
    })

    await $.session.start({ cwd: `${WORKSPACE}/src` } as never)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) { /* read it all */ }
    await clock.settle()

    const sent = posts.map(p => p.body).find(b => b.hook_event_name === 'ModelStep')!.inference as Record<string, unknown>
    expect(sent.gateway).toBe(gateway)
  })
}

test('a subagent started from a subagent names its parent', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'child-1' }))

  await $.agent.spawn({
    tool_use_id: 'tu-agent', prompt: 'Look', description: 'Find the config', subagentType: 'Explore', parentAgentId: 'parent-1',
  } as never)
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'SubagentStart')).toEqual(expect.objectContaining({
    agent_id: 'child-1', agent_type: 'Explore', description: 'Find the config', parent_agent_id: 'parent-1',
  }))
})

test('a workflow script\'s agent is sent with its run and its place in it', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'wf-agent-2' }))

  await $.agent.spawn({
    tool_use_id: 'tu-wf', prompt: 'Review', description: 'Review a file', subagentType: 'general-purpose',
    workflow: { runId: 'wf_abc', agentIndex: 2 },
  } as never)
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'SubagentStart')).toEqual(expect.objectContaining({
    agent_id: 'wf-agent-2', workflow_run_id: 'wf_abc', workflow_agent_index: 2,
  }))
})

test('a teammate is sent with its name, its states as they change, and its end from its status', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'mate-1', teammateId: 'researcher@team' }))
  let status = 'running'
  on('agent.list', () => ({ value: status === 'gone' ? [] : [
    { id: 'mate-1', description: 'Research the API', type: 'teammate', status, name: 'researcher' },
    { id: 'someone-else', description: 'Not ours', type: 'Explore', status: 'idle' },
  ] as never }))

  await $.agent.spawn({
    tool_use_id: 'tu-team', prompt: 'Research', description: 'Research the API', subagentType: 'teammate',
    isTeammate: true, name: 'researcher', parentAgentId: undefined,
  } as never)
  await clock.advance(1_000)
  status = 'idle'
  await clock.advance(1_000)
  await clock.advance(1_000) // unchanged: not sent again
  status = 'gone'
  await clock.advance(1_000)
  await clock.settle()

  const sent = posts.map(p => p.body)
  expect(sent.find(b => b.hook_event_name === 'SubagentStart')).toEqual(expect.objectContaining({
    agent_id: 'mate-1', is_teammate: true, agent_name: 'researcher',
  }))
  expect(sent.filter(b => b.hook_event_name === 'AgentStatus').map(b => [b.agent_id, b.status]))
    .toEqual([['mate-1', 'running'], ['mate-1', 'idle']])
  expect(sent.filter(b => b.hook_event_name === 'SubagentStop').map(b => b.agent_id)).toEqual(['mate-1'])
})

test('a tool the API ran itself is sent as a call that started and ended', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  on('turn.step', async function* () {
    yield { kind: 'stop', stopReason: 'end_turn', usage } as never
    return {
      turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage,
      serverToolUses: [
        { id: 'srv-1', name: 'advisor', input: { question: 'Which?' }, startedAt: 10, endedAt: 40 },
        { id: 'srv-2', name: 'advisor', input: {}, startedAt: 50 },
      ],
    }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'sub-1' } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  await clock.settle()

  expect((item.value as { serverToolUses?: unknown[] }).serverToolUses).toHaveLength(2) // the result is passed on
  expect(posts.map(p => p.body).filter(b => b.tool_name === 'advisor').map(b => [b.hook_event_name, b.tool_use_id, b.agent_id]))
    .toEqual([
      ['PreToolUse', 'srv-1', 'sub-1'], ['PostToolUse', 'srv-1', 'sub-1'],
      ['PreToolUse', 'srv-2', 'sub-1'], ['PostToolUseFailure', 'srv-2', 'sub-1'],
    ])
})

test('a permission request names the subagent from its check, and the organization’s ceiling', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('tool.check', () => ({ decision: 'ask', reason: 'Connector tool', ceiling: 'ask' }))
  on('classic.PermissionRequest', () => ({}))

  await $.tool.check({ tool: 'mcp__crm__update', input: {}, tool_use_id: 'tu-9', agentId: 'sub-1', ceiling: 'ask' } as never)
  await $.classic.PermissionRequest({ tool_name: 'mcp__crm__update', tool_input: {}, agent_id: 'sub-1' } as never)
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'PermissionRequest')).toEqual(expect.objectContaining({
    agent_id: 'sub-1', tool_use_id: 'tu-9', reason: 'Connector tool', ceiling: 'ask',
  }))
})

test('a subagent’s end carries the report it handed back', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({ answer: 'Found it in config/app.ts', durationMs: 900, isAborted: false, turnId: 't2', agentId: 'sub-1', reason: 'answer' } as never)
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'SubagentStop')).toEqual(expect.objectContaining({
    agent_id: 'sub-1', answer: 'Found it in config/app.ts',
  }))
})

/** The notifications the bridge raised, each sent */
function notifications(on: On) {
  const raised: { text: string; title?: string }[] = []
  on('ui.notify', (_$, e) => {
    raised.push({ text: e.text, title: e.title })
    return { value: { isSent: true, channel: 'kitty' } }
  })
  return raised
}

test('a subagent type whose file sets autoCompactWindow is sent with it; the project’s file over the user’s', async ($, on) => {
  const { clock, posts } = agentFlow(on, {}, {
    // The session's cwd is ${WORKSPACE}/src, as the engine starts it
    [`${WORKSPACE}/src/.claude/agents/reviewer.md`]: '---\nname: reviewer\nautoCompactWindow: 150_000\n---\nReview.',
    '/home/me/.claude/agents/reviewer.md': '---\nname: reviewer\nautoCompactWindow: 300000\n---\n',
    '/home/me/.claude/agents/tiny.md': '---\nname: tiny\nautoCompactWindow: 5000\n---\n', // out of range
  })
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))

  await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Look', description: 'Review', subagentType: 'reviewer' } as never)
  await $.agent.spawn({ tool_use_id: 'tu-2', prompt: 'Look', description: 'Tiny', subagentType: 'tiny' } as never)
  await $.agent.spawn({ tool_use_id: 'tu-3', prompt: 'Look', description: 'Explore', subagentType: 'Explore' } as never)
  await clock.settle()

  const starts = posts.map(p => p.body).filter(b => b.hook_event_name === 'SubagentStart')
  expect(starts.map(b => b.auto_compact_window)).toEqual([150_000, undefined, undefined])
})

for (const [label, version, expected] of [
  ['lowers CLAUDE_CODE_AUTO_COMPACT_WINDOW from 2.1.312, and never raises it', '2.1.312', [150_000, 200_000]],
  ['gives way to CLAUDE_CODE_AUTO_COMPACT_WINDOW before 2.1.312', '2.1.311', [undefined, undefined]],
] as const) {
  test(`an agent file’s autoCompactWindow ${label}`, async ($, on) => {
    const { clock, posts } = agentFlow(on, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' }, {
      '/home/me/.claude/agents/small.md': '---\nautoCompactWindow: 150000\n---\n',
      '/home/me/.claude/agents/large.md': '---\nautoCompactWindow: 400000\n---\n',
    })
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
    on('session.version', () => ({ value: { version, base: version } }) as never)
    on('settings.read', () => ({ value: {} }) as never)
    let n = 0
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `agent-${++n}` }))

    await $.session.start({ cwd: `${WORKSPACE}/src`, surface: 'terminal', isInteractive: true } as never)
    await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Look', description: 'Small', subagentType: 'small' } as never)
    await $.agent.spawn({ tool_use_id: 'tu-2', prompt: 'Look', description: 'Large', subagentType: 'large' } as never)
    await clock.settle()

    const starts = posts.map(p => p.body).filter(b => b.hook_event_name === 'SubagentStart')
    expect(starts.map(b => b.auto_compact_window)).toEqual([...expected])
  })
}

test('a refused turn, a failed subagent and a rate-limit window 90% used each raise one notification', async ($, on) => {
  const { clock } = agentFlow(on)
  const raised = notifications(on)
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => e as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'sub-1' }))

  await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Build', description: 'Build the app', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'sub-1', reason: 'error' } as never)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't2', reason: 'refusal', refusal: { category: 'cyber', explanation: null } } as never)
  const limits = (percentUsed: number, resetIn = 125 * 60_000) => ({
    context: { window: 1_000_000, tokens: 1000 }, changed: ['rateLimits'],
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: new Date(Date.now() + resetIn).toISOString() }],
  })
  await $.session.measure(limits(85) as never)
  await $.session.measure(limits(91) as never)
  // The same window, its reset a little apart (across a minute's turn): told once
  await $.session.measure(limits(95, 125 * 60_000 + 31_000) as never)
  await clock.settle()

  expect(raised).toEqual([
    { text: 'A subagent failed: Build the app', title: 'Agent Flow' },
    { text: 'Claude refused the turn (cyber)', title: 'Agent Flow' },
    { text: expect.stringMatching(/^5-hour limit 91% used, resets in 2 h [45] m$/), title: 'Agent Flow' },
  ])
})

test('no notification is raised with the notify option off', { options: { notify: false } }, async ($, on) => {
  const { clock } = agentFlow(on)
  const raised = notifications(on)
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'refusal', refusal: { category: null, explanation: null } } as never)
  await clock.settle()

  expect(raised).toEqual([])
})

test('a resumed subagent is sent as the same agent, resumed', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'sub-1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Build', description: 'Build the app', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ answer: 'built', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'sub-1', reason: 'completed' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu-2', prompt: 'Now test it', description: 'Build the app', subagentType: 'general-purpose',
    resume: { agentId: 'sub-1' },
  } as never)
  await clock.settle()

  const starts = posts.map(p => p.body).filter(b => b.hook_event_name === 'SubagentStart')
  expect(starts.map(b => [b.agent_id, b.resumed])).toEqual([['sub-1', undefined], ['sub-1', true]])
  expect(starts[1]).toEqual(expect.objectContaining({ agent_type: 'general-purpose', description: 'Build the app' }))
})

test('an auto compaction 54 minutes after the last turn is sent as idle; one at the threshold as auto', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('turn.start', (_$, e) => e as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', (_$, e) => ({ messages: e.messages, tokensBefore: 240_000, tokensAfter: 12_000 }) as never)
  const turn = async (id: string) => {
    await $.turn.start({ text: 'go', turnId: id } as never)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: id, reason: 'completed' } as never)
  }
  const compact = () => $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)

  await clock.advance(1_000)
  await turn('t1')
  await clock.advance(54 * 60_000)
  await compact()
  await turn('t2')
  await compact()
  await clock.settle()

  const ends = posts.map(p => p.body).filter(b => b.hook_event_name === 'Compaction' && b.phase === 'end')
  expect(ends.map(b => b.trigger)).toEqual(['idle', 'auto'])
})

test('a fork and a background agent are sent as such', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))

  await $.agent.spawn({ tool_use_id: 'tu-1', prompt: 'Look', description: 'Explore', subagentType: 'fork', fork: true, background: true } as never)
  await $.agent.spawn({ tool_use_id: 'tu-2', prompt: 'Look', description: 'Review', subagentType: 'reviewer', fork: false, background: false } as never)
  await clock.settle()

  const starts = posts.map(p => p.body).filter(b => b.hook_event_name === 'SubagentStart')
  expect(starts.map(b => [b.fork, b.background])).toEqual([[true, true], [undefined, undefined]])
})

test('a call its tool held read-only says so at its end; a dialog says which hook asked and who may answer', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  // The call checks again as it runs (2.1.308's test engine too): by then the person has approved.
  // The engine names the plugin whose hook asked; here the test's hook stands in for one
  const asked = new Set<string>()
  on('tool.check', (_$, e) => (e.tool === 'Read' || asked.has(e.tool_use_id!)
    ? { decision: 'allow' }
    : (asked.add(e.tool_use_id!), { decision: 'ask', reason: 'Migrations change the shared database', hook: 'PreToolUse', plugin: 'migration-guard' })) as never)
  on('tool.call', () => ({ result: {} as never, text: 'ok' }) as never)
  on('classic.PermissionRequest', () => ({}))

  // Each call's check, as the engine runs it before the tool
  await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'tu-read', isReadOnly: true } as never)
  await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts', tool_use_id: 'tu-read' } as never)
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'tu-bash' } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npx prisma migrate dev' } })
  await $.tool.call({ tool: 'Bash', command: 'npx prisma migrate dev', tool_use_id: 'tu-bash' } as never)
  await clock.settle()

  const bodies = posts.map(p => p.body)
  const ends = bodies.filter(b => b.hook_event_name === 'PostToolUse')
  expect(ends.map(b => [b.tool_name, b.read_only])).toEqual([['Read', true], ['Bash', undefined]])
  expect(bodies.find(b => b.hook_event_name === 'PermissionRequest')).toEqual(expect.objectContaining({
    tool_use_id: 'tu-bash', hook: 'PreToolUse', decider: 'person', reason: 'Migrations change the shared database',
  }))
})

test('a resumed conversation is sent with how long it sat and what re-caching it costs', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({
    session_id: 'session-2', source: 'resume', seconds_since_last_response: 11_520,
    context_tokens: 412_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 2.06,
  } as never)
  await $.classic.SessionStart({ session_id: 'session-3', source: 'startup' } as never)
  await clock.settle()

  expect(posts.map(p => p.body).filter(b => b.hook_event_name === 'SessionResume')).toEqual([expect.objectContaining({
    session_id: 'session-2', source: 'resume', seconds_since_last_response: 11_520,
    context_tokens: 412_000, prompt_cache_likely_expired: true, estimated_cache_write_usd: 2.06,
  })])
})

for (const [label, surface, env, version, settings, expected] of [
  ['outside the terminal', null, {}, '2.1.314', {}, false],
  ['where settings.json turns it off', 'terminal', {}, '2.1.314', { idleCompaction: false }, false],
  ['in the terminal, by default', 'terminal', {}, '2.1.314', {}, undefined],
  ['in VS Code before 2.1.314', null, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, '2.1.312', {}, false],
  ['in VS Code from 2.1.314', null, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, '2.1.314', {}, undefined],
  ['in the desktop app from 2.1.314', null, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, '2.1.315', {}, undefined],
  ['on Bedrock with the 5-minute cache', 'terminal', { CLAUDE_CODE_USE_BEDROCK: '1' }, '2.1.314', {}, false],
  ['on Bedrock with ENABLE_PROMPT_CACHING_1H', 'terminal', { CLAUDE_CODE_USE_BEDROCK: '1', ENABLE_PROMPT_CACHING_1H: '1' }, '2.1.314', {}, undefined],
  ['behind a gateway with promptCacheTtl 1h', 'terminal', { ANTHROPIC_BASE_URL: 'https://llm.corp.example' }, '2.1.314', { promptCacheTtl: '1h' }, undefined],
  ['on Vertex where FORCE_PROMPT_CACHING_5M wins', 'terminal', { CLAUDE_CODE_USE_VERTEX: '1', FORCE_PROMPT_CACHING_5M: '1' }, '2.1.314', { promptCacheTtl: '1h' }, false],
] as const) {
  test(`idle compaction is said off ${label}`, async ($, on) => {
    const { clock, posts } = agentFlow(on, env as Record<string, string>)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
    on('session.measure', (_$, e) => e as never)
    on('session.version', () => ({ value: { version, base: version } }) as never)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
    on('settings.read', () => ({ value: settings }) as never)

    await $.session.start({ cwd: `${WORKSPACE}/src`, surface, isInteractive: surface === 'terminal' } as never)
    await $.session.measure({ context: { window: 1_000_000, tokens: 300_000 }, rateLimits: [], changed: ['context'] } as never)
    await clock.settle()

    const measure = posts.map(p => p.body).find(b => b.hook_event_name === 'SessionMeasure')!
    expect(measure.idle_compaction).toBe(expected)
  })
}

for (const [label, env, breakdown, expected] of [
  ['is said off where the engine says so', {}, { isAutoCompactEnabled: false }, { auto: false, idle: undefined }],
  ['is said off, idle compaction too, where DISABLE_COMPACT turns all compaction off', { DISABLE_COMPACT: '1' }, { autoCompactThreshold: 835_000, isAutoCompactEnabled: true }, { auto: false, idle: false }],
  ['goes unsaid by default', { DISABLE_COMPACT: 'false' }, { autoCompactThreshold: 835_000, isAutoCompactEnabled: true }, { auto: undefined, idle: undefined }],
] as const) {
  test(`auto-compaction ${label}`, async ($, on) => {
    const { clock, posts } = agentFlow(on, env)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
    on('session.measure', (_$, e) => e as never)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, breakdown }, rateLimits: [] } }) as never)
    on('settings.read', () => ({ value: {} }) as never)

    await $.session.start({ cwd: `${WORKSPACE}/src`, surface: 'terminal', isInteractive: true } as never)
    await $.session.measure({ context: { window: 1_000_000, tokens: 300_000 }, rateLimits: [], changed: ['context'] } as never)
    await clock.settle()

    const measure = posts.map(p => p.body).find(b => b.hook_event_name === 'SessionMeasure')!
    expect(measure.auto_compact).toBe(expected.auto)
    expect(measure.idle_compaction).toBe(expected.idle)
  })
}

test('a compaction’s end carries what its summary cost', async ($, on) => {
  const { clock, posts } = agentFlow(on)
  const usage = { input_tokens: 2_100, output_tokens: 1_850, cache_read_input_tokens: 68_000, cache_creation_input_tokens: 0 }
  on('session.compact', (_$, e) => ({ messages: e.messages, tokensBefore: 70_100, tokensAfter: 6_100, usage }) as never)

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'Compaction' && b.phase === 'end')!.usage).toEqual(usage)
})
