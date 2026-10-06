import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const WORKSPACE = '/work/app'

/** One Agent Flow watching WORKSPACE (port 4001) and one elsewhere (4002); answers what flush and discovery call */
function agentFlow(on: On, env: Record<string, string> = {}) {
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
  on('fs.read', (_$, e) => ({
    value: e.path.endsWith('aaa-1.json')
      ? JSON.stringify({ port: 4001, pid: 1, workspace: WORKSPACE })
      : JSON.stringify({ port: 4002, pid: 2, workspace: '/elsewhere' }),
  }))

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
  let finishAgentCall = () => {}
  on('tool.call', () => new Promise(resolve => {
    finishAgentCall = () => resolve({ result: {} as never, text: 'done' } as never)
  }))

  // The parent subagent's Agent call is open while its child spawns, as in a session
  const agentCall = $.tool.call({ tool: 'Agent', tool_use_id: 'tu-agent', agentId: 'parent-1', description: 'Find the config', prompt: 'Look' } as never)
  await clock.settle()
  await $.agent.spawn({ tool_use_id: 'tu-agent', prompt: 'Look', description: 'Find the config', subagentType: 'Explore' } as never)
  finishAgentCall()
  await agentCall
  await clock.settle()

  expect(posts.map(p => p.body).find(b => b.hook_event_name === 'SubagentStart')).toEqual(expect.objectContaining({
    agent_id: 'child-1', agent_type: 'Explore', description: 'Find the config', parent_agent_id: 'parent-1',
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
