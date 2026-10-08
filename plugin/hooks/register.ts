import type { EngineInterface, Register, TurnStepServerToolUse } from 'claude-code'

/**
 * Sends this session's events to a running Agent Flow (VS Code extension, `pnpm run dev` or
 * `npx agent-flow-app`), in the payload shape its hook server already reads from the
 * settings.json command hooks, so it needs no new endpoint.
 *
 * What it adds over those hooks: a tool's start and end come from one wrapped call, so they
 * arrive in order; a permission request is the engine's own `ask` verdict; a subagent is known
 * by the id its tool calls carry; and each model request reports its model and real usage
 * (`ModelStep`), which the command hooks never see.
 *
 * Every payload carries `agent_flow_source: 'mod'`: the hook server then ignores the command
 * hooks' copies for that session.
 */

type Payload = Record<string, unknown> & { hook_event_name: string }
type Target = { port: number; workspace: string }

/** How often the agents' states are read while any is out */
const STATUS_INTERVAL_MS = 1_000
/** An agent's status that ends it: it is reported stopped */
const ENDED = new Set(['completed', 'failed', 'killed'])

/** How long a discovery scan is trusted before the folder is read again */
const DISCOVERY_TTL_MS = 5_000
/** Payloads kept while no Agent Flow is running; the oldest are dropped past this */
const QUEUE_MAX = 500
/** How often a growing text or thinking block is sent again */
const OUTPUT_INTERVAL_MS = 250
/** The longest text sent per block, as the transcript parser cuts a message (MESSAGE_MAX) */
const OUTPUT_MAX = 2_000
/** What SendMessage calls the session's main agent: the lead's name in a team, or `main` */
const LEAD_ADDRESSES = new Set(['team-lead', 'main'])
/** A POST not answered by then is given up, so an instance that went away cannot stall the queue */
const POST_TIMEOUT_MS = 1_000

let sessionId: string | undefined
let cwd = ''
/** The cwd with symlinks resolved, as the discovery files spell their workspace */
let realCwd = ''
let queue: Payload[] = []
let isFlushScheduled = false
let targets: Target[] = []
let scannedAt = -Infinity
/** tool_use_id → the subagent whose call it is, for engines before 2.1.290, whose permission check
 *  carries no agentId */
const toolAgents = new Map<string, string>()
/** agentId → its type, as the command hooks' `agent_type` */
const agentTypes = new Map<string, string>()
/** Teammates (agent teams), by agentId: they idle between messages, so a turn's end isn't theirs */
const teammates = new Set<string>()
/** agentId → the status last sent for it, from `$.agent.list()` */
const statuses = new Map<string, string>()
let statusTimer: { cancel(): void } | undefined
/** The context window last measured, and the fill at which auto-compaction runs in it (absent when
 *  it's off): the threshold is read again only when the window changes, as on a /model switch */
let measuredWindow = 0
let compactThreshold: number | undefined
/** tool_use_id → the `ask` verdict its permission check returned, until the call ends */
const asks = new Map<string, { tool: string; agentId?: string; reason?: string; rule?: string; ceiling?: string }>()
/**
 * How this session reaches Claude, as Claude Code's environment sets it up: Anthropic's API, or
 * Amazon Bedrock, Google Vertex AI or Microsoft Foundry, and the region. The footprint is figured
 * at that region's grid. Vertex's per-model region overrides (VERTEX_REGION_CLAUDE_*) aren't read:
 * a name has to be spelled out to read it.
 *
 * A base URL that isn't the platform's own is a gateway (LiteLLM, a company proxy): what answered,
 * and where, is the gateway's to say. Only its host is sent
 */
type Inference = { platform: 'anthropic' | 'bedrock' | 'vertex' | 'foundry'; region?: string; gateway?: string }
let inference: Inference = { platform: 'anthropic' }

/** The host of a base URL that isn't the platform's own, or undefined */
function gatewayHost(url: string | undefined, own: RegExp): string | undefined {
  if (!url) return undefined
  try {
    const { host, hostname } = new URL(url)
    return own.test(hostname) ? undefined : host
  } catch {
    return undefined
  }
}

async function readInference($: EngineInterface): Promise<Inference> {
  const on = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false'
  const via = (gateway: string | undefined) => (gateway ? { gateway } : {})
  if (on(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))) {
    const region = await $.env.get('AWS_REGION') ?? await $.env.get('AWS_DEFAULT_REGION')
    const gateway = gatewayHost(await $.env.get('ANTHROPIC_BEDROCK_BASE_URL'), /\.amazonaws\.com(\.cn)?$/)
    return { platform: 'bedrock', ...(region ? { region } : {}), ...via(gateway) }
  }
  if (on(await $.env.get('CLAUDE_CODE_USE_VERTEX'))) {
    const region = await $.env.get('CLOUD_ML_REGION')
    const gateway = gatewayHost(await $.env.get('ANTHROPIC_VERTEX_BASE_URL'), /(^|\.)googleapis\.com$/)
    return { platform: 'vertex', ...(region ? { region } : {}), ...via(gateway) }
  }
  if (on(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))) {
    return { platform: 'foundry', ...via(gatewayHost(await $.env.get('ANTHROPIC_FOUNDRY_BASE_URL'), /\.azure\.com$/)) }
  }
  return { platform: 'anthropic', ...via(gatewayHost(await $.env.get('ANTHROPIC_BASE_URL'), /^api\.anthropic\.com$/)) }
}

/** What /agent-flow reports */
const stats = { sent: 0, failed: 0, dropped: 0, lastError: '' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    cwd = e.cwd
    realCwd = ''
    inference = await readInference($).catch(() => ({ platform: 'anthropic' as const }))
    send($, { hook_event_name: 'SessionStart' })
    await $.command.register({ name: 'agent-flow', description: 'Shows where the Agent Flow bridge sends this session’s events.' })
    return next(e)
  })

  on('command.run', { command: 'agent-flow' }, async $ => {
    scannedAt = -Infinity
    const found = await discover($)
    const where = found.length > 0
      ? found.map(t => `port ${t.port} (${t.workspace})`).join(', ')
      : `no Agent Flow is watching ${realCwd || cwd}`
    return { text: [
      `Agent Flow bridge: ${where}.`,
      `Sent ${stats.sent}, failed ${stats.failed}, dropped ${stats.dropped}, queued ${queue.length}.`,
      ...(stats.lastError ? [`Last error: ${stats.lastError}`] : []),
    ].join('\n') }
  })

  on('session.end', async ($, e, next) => {
    send($, { hook_event_name: 'SessionEnd', reason: e.reason, session_id: e.sessionId })
    sessionId = undefined // a /clear goes on under a new id, with no session.start
    toolAgents.clear()
    agentTypes.clear()
    asks.clear()
    teammates.clear()
    statuses.clear()
    statusTimer?.cancel()
    statusTimer = undefined
    measuredWindow = 0
    compactThreshold = undefined
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A plugin's own $.tool.call is not the model's work
    if (next.origin.plugin !== 'engine') return next(e)

    const { tool, tool_use_id, agentId, ...rest } = e
    const { consent: _consent, ...input } = rest as Record<string, unknown> // the person's words, not the tool's
    const call = { tool_name: tool, tool_input: input, tool_use_id, ...agentFields(agentId) }
    if (tool_use_id && agentId) toolAgents.set(tool_use_id, agentId)
    send($, { hook_event_name: 'PreToolUse', ...call })

    try {
      const ran = await next(e)
      if (ran.deny !== undefined) {
        send($, { hook_event_name: 'PostToolUseFailure', ...call, error: ran.deny })
      } else if (ran.isError) {
        send($, { hook_event_name: 'PostToolUseFailure', ...call, error: ran.text ?? '' })
      } else {
        send($, { hook_event_name: 'PostToolUse', ...call, tool_response: ran.text ?? '' })
      }
      return ran
    } catch (error) {
      send($, {
        hook_event_name: 'PostToolUseFailure', ...call,
        error: error instanceof Error ? error.message : String(error),
        is_interrupt: next.signal.aborted,
      })
      throw error
    } finally {
      if (tool_use_id) {
        toolAgents.delete(tool_use_id)
        asks.delete(tool_use_id)
      }
    }
  })

  // An `ask` goes to the mode's decider (auto mode's classifier may allow it unseen), so the
  // request is sent only once a dialog shows; the verdict is kept for its reason, its rule and the
  // organization's ceiling (since 2.1.290: `ask` when its administrators require an approval).
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id) {
      asks.set(e.tool_use_id, {
        tool: e.tool, agentId: e.agentId ?? toolAgents.get(e.tool_use_id),
        reason: verdict.reason, rule: verdict.rule, ceiling: verdict.ceiling,
      })
    }
    return verdict
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    // The dialog's event names no call: it is the latest ask for this tool in this agent's loop
    const asked = [...asks].reverse().find(([, a]) => a.tool === e.tool_name && a.agentId === e.agent_id)
    send($, {
      hook_event_name: 'PermissionRequest',
      tool_name: e.tool_name, tool_input: e.tool_input, ...agentFields(e.agent_id),
      ...(asked ? { tool_use_id: asked[0], reason: asked[1].reason, rule: asked[1].rule, ceiling: asked[1].ceiling } : {}),
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      // Since 2.1.289 a teammate's spawn comes here too, with its name in the team, and since
      // 2.1.292 a workflow script's, with its run and its place in it; older engines leave these out
      agentTypes.set(spawned.agentId, e.subagentType)
      if (e.isTeammate) teammates.add(spawned.agentId)
      send($, {
        hook_event_name: 'SubagentStart',
        agent_id: spawned.agentId, agent_type: e.subagentType,
        tool_use_id: e.tool_use_id, description: e.description, model: spawned.model,
        // absent when the main loop started it
        parent_agent_id: e.parentAgentId ?? toolAgents.get(e.tool_use_id),
        ...(e.isTeammate ? { is_teammate: true, agent_name: e.name } : {}),
        ...(e.workflow ? { workflow_run_id: e.workflow.runId, workflow_agent_index: e.workflow.agentIndex } : {}),
      })
      watchStatuses($)
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    // A teammate's turn ends each time it answers; it ends when its status says so
    if (e.agentId && teammates.has(e.agentId)) return next(e)
    if (e.agentId) {
      // The report it handed back (filled in auto mode too since 2.1.290), cut as a block of output is
      send($, {
        hook_event_name: 'SubagentStop', ...agentFields(e.agentId),
        reason: e.reason, duration_ms: e.durationMs,
        ...(e.answer.trim() ? { answer: e.answer.slice(0, OUTPUT_MAX) } : {}),
      })
      agentTypes.delete(e.agentId)
      statuses.delete(e.agentId)
    } else {
      send($, {
        hook_event_name: 'Stop', reason: e.reason, duration_ms: e.durationMs,
        // What the API said of a refusal that ended the turn, the classifier's category and why
        ...(e.reason === 'refusal' ? { refusal: e.refusal } : {}),
      })
    }
    return next(e)
  })

  // The main conversation's context as the engine measured it, after each turn: its fill, the real
  // window (where the UI would guess it from the model's family) and the rate-limit windows
  on('session.measure', async ($, e, next) => {
    const { context, rateLimits, changed } = e
    if (changed.includes('context') && context.window !== measuredWindow) {
      measuredWindow = context.window
      // `summary` counts locally and sends nothing to the API
      const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
      compactThreshold = usage?.context.breakdown?.autoCompactThreshold
    }
    if (changed.includes('context') || changed.includes('rateLimits')) {
      send($, {
        hook_event_name: 'SessionMeasure',
        context_window: context.window,
        ...(context.tokens !== undefined ? { context_tokens: context.tokens } : {}),
        ...(compactThreshold !== undefined ? { compact_threshold: compactThreshold } : {}),
        rate_limits: rateLimits,
      })
    }
    return next(e)
  })

  // A compaction as it starts and ends: the UI shows it running (a summary can take half a minute)
  // and the context it left. One computed ahead of time (`precompute`) changes nothing yet
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    const fields = { trigger: e.trigger, ...agentFields(e.agentId) }
    send($, { hook_event_name: 'Compaction', phase: 'start', ...fields, messages_before: e.messages.length })
    const startedAt = Date.now()
    try {
      const done = await next(e)
      send($, done.skip !== undefined
        ? { hook_event_name: 'Compaction', phase: 'skipped', ...fields, reason: done.skip }
        : {
            hook_event_name: 'Compaction', phase: 'end', ...fields,
            messages_before: e.messages.length, messages_after: done.messages.length,
            ...(done.tokensBefore !== undefined ? { tokens_before: done.tokensBefore } : {}),
            ...(done.tokensAfter !== undefined ? { tokens_after: done.tokensAfter } : {}),
            duration_ms: Date.now() - startedAt,
          })
      return done
    } catch (error) {
      send($, { hook_event_name: 'Compaction', phase: 'skipped', ...fields, reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })

  // A message the model sends another agent (SendMessage), as the UI draws it between the two: the
  // recipient by its agent id, or none for the main agent. A session elsewhere isn't drawn
  on('session.send', async ($, e, next) => {
    if (e.origin.kind === 'model') {
      const to = e.to.replace(/ \[[^\]]*\]$/, '') // a listing's " [ref]"
      const toAgentId = agentTypes.has(to) ? to
        : LEAD_ADDRESSES.has(to) ? undefined
        : (await $.agent.list().catch(() => [])).find(a => a.name === to || a.teammateId === to)?.id
      if (toAgentId || LEAD_ADDRESSES.has(to)) {
        send($, {
          hook_event_name: 'AgentMessage', ...agentFields(e.agentId),
          ...(toAgentId ? { to_agent_id: toAgentId } : {}), text: e.text.slice(0, OUTPUT_MAX),
        })
      }
    }
    return next(e)
  })

  // Passes every chunk on untouched. Text and thinking are sent as they grow (`ModelOutput`, one
  // stream per content block, the UI updating it in place); the stop chunk carries the usage. The
  // tools the API ran itself (the advisor) pass no `tool.call`: the response lists them once whole.
  on('turn.step', async function* ($, e, next) {
    const blocks = new Map<number, OutputBlock>()
    const sendBlock = (index: number, block: OutputBlock, isFinal: boolean) => {
      const content = block.text.slice(0, OUTPUT_MAX)
      if (!content.trim() || (content === block.sent && !isFinal)) return
      block.sent = content
      block.sentAt = Date.now()
      send($, {
        hook_event_name: 'ModelOutput', ...agentFields(e.agentId),
        stream_id: `${e.turnId}:${e.index}:${index}`, role: block.role, content, is_final: isFinal,
      })
    }
    const finish = () => {
      for (const [index, block] of blocks) sendBlock(index, block, true)
      blocks.clear()
    }

    try {
      const stream = next(e)
      let item = await stream.next()
      for (; !item.done; item = await stream.next()) {
        const chunk = item.value
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          let block = blocks.get(chunk.index)
          if (!block) {
            block = { role: chunk.kind === 'text' ? 'assistant' : 'thinking', text: '', sent: '', sentAt: 0 }
            blocks.set(chunk.index, block)
          }
          block.text += chunk.text
          if (Date.now() - block.sentAt >= OUTPUT_INTERVAL_MS) sendBlock(chunk.index, block, false)
        } else if (chunk.kind === 'stop') {
          finish()
          send($, {
            hook_event_name: 'ModelStep', ...agentFields(e.agentId),
            turn_id: e.turnId, step: e.index, model: chunk.usage?.model ?? e.model, effort: e.effort,
            stop_reason: chunk.stopReason, usage: chunk.usage, inference,
          })
        }
        yield chunk
      }
      for (const use of item.value.serverToolUses ?? []) sendServerToolUse($, use, e.agentId)
      return item.value
    } finally {
      finish() // an interrupted step still shows what it said
    }
  })
}

/** A tool the API ran inside a request (since 2.1.290), as a call that started and ended. Both are
 *  known only once the response is whole, so they are sent together; one the response ended before
 *  answering (a stream cut short, a turn paused) is sent as interrupted */
function sendServerToolUse($: EngineInterface, use: TurnStepServerToolUse, agentId: string | undefined): void {
  const call = { tool_name: use.name, tool_input: use.input, tool_use_id: use.id, ...agentFields(agentId) }
  send($, { hook_event_name: 'PreToolUse', ...call })
  if (use.endedAt === undefined) {
    send($, { hook_event_name: 'PostToolUseFailure', ...call, error: 'The response ended before its result', is_interrupt: true })
  } else {
    send($, { hook_event_name: 'PostToolUse', ...call, tool_response: '' })
  }
}

/** Reads the agents' states once a second while any is out, and sends each change: `idle` and
 *  `waiting` (since 2.1.289) the engine's own, where the transcript could only guess */
function watchStatuses($: EngineInterface): void {
  if (statusTimer) return
  statusTimer = $.clock.every(STATUS_INTERVAL_MS, () => { void readStatuses($) })
}

async function readStatuses($: EngineInterface): Promise<void> {
  const agents = await $.agent.list().catch(() => undefined)
  if (!agents) return
  const listed = new Set<string>()
  for (const a of agents) {
    if (!agentTypes.has(a.id)) continue // spawned before the bridge saw it, or not by a model
    listed.add(a.id)
    if (statuses.get(a.id) === a.status) continue
    statuses.set(a.id, a.status)
    send($, { hook_event_name: 'AgentStatus', ...agentFields(a.id), status: a.status })
    if (ENDED.has(a.status) && teammates.has(a.id)) endTeammate($, a.id, a.status)
  }
  // A teammate gone from the list has ended too
  for (const id of teammates) if (!listed.has(id)) endTeammate($, id, 'completed')
  if (agentTypes.size === 0) {
    statusTimer?.cancel()
    statusTimer = undefined
  }
}

function endTeammate($: EngineInterface, agentId: string, reason: string): void {
  send($, { hook_event_name: 'SubagentStop', ...agentFields(agentId), reason })
  teammates.delete(agentId)
  agentTypes.delete(agentId)
  statuses.delete(agentId)
}

type OutputBlock = { role: 'assistant' | 'thinking'; text: string; sent: string; sentAt: number }

function agentFields(agentId: string | undefined): Record<string, string> {
  if (!agentId) return {}
  const type = agentTypes.get(agentId)
  return type ? { agent_id: agentId, agent_type: type } : { agent_id: agentId }
}

/** Queues a payload; the queue is sent after the hook's dispatch, so no tool waits on the network. */
function send($: EngineInterface, fields: Payload): void {
  // Stamped now: a payload queued before a /clear belongs to the session that ended
  queue.push(sessionId ? { session_id: sessionId, ...fields } : fields)
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX)
  scheduleFlush($)
}

function scheduleFlush($: EngineInterface): void {
  if (isFlushScheduled) return
  isFlushScheduled = true
  $.clock.after(0, () => { void flush($) })
}

async function flush($: EngineInterface): Promise<void> {
  try {
    if (!sessionId) sessionId = await $.session.id()
    if (!cwd) cwd = await $.session.cwd()
    if (!realCwd) realCwd = (await $.fs.stat(cwd, { resolve: true })).realPath ?? cwd
    while (queue.length > 0) {
      const found = await discover($)
      if (found.length === 0) {
        // Nothing is listening; the transcript watcher catches Agent Flow up when it starts
        stats.dropped += queue.length
        queue = []
        return
      }
      const payload = queue.shift()!
      // A request's end carries what the whole session has cost, as /cost totals it: read as it
      // is sent, so it includes the request
      if (payload.hook_event_name === 'ModelStep') payload.session_cost_usd = await sessionCost($)
      const body = JSON.stringify({
        ...payload, session_id: payload.session_id ?? sessionId, cwd, agent_flow_source: 'mod',
      })
      for (const { port } of found) {
        try {
          await post($, `http://127.0.0.1:${port}/`, body)
          stats.sent++
        } catch (error) {
          stats.failed++
          stats.lastError = `port ${port}: ${error instanceof Error ? error.message : String(error)}`
          scannedAt = -Infinity // that instance is gone: the next payload reads the discovery folder again
        }
      }
    }
  } catch (error) {
    stats.lastError = error instanceof Error ? error.message : String(error)
    stats.dropped += queue.length
    queue = [] // a failure before sending would otherwise retry at once, forever
  } finally {
    isFlushScheduled = false
    if (queue.length > 0) scheduleFlush($)
  }
}

async function sessionCost($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

async function post($: EngineInterface, url: string, body: string): Promise<void> {
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(POST_TIMEOUT_MS, () => reject(new Error(`no answer in ${POST_TIMEOUT_MS} ms`)))
  })
  try {
    await Promise.race([
      $.http.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
      timeout,
    ])
  } finally {
    timer?.cancel()
  }
}

/**
 * The Agent Flow instances watching this session's directory, found as hook.mjs finds them: the
 * discovery files in ~/.claude/agent-flow/, the most specific workspace containing the cwd.
 */
async function discover($: EngineInterface): Promise<Target[]> {
  if (Date.now() - scannedAt < DISCOVERY_TTL_MS) return targets
  scannedAt = Date.now()
  targets = []
  const home = await $.env.get('HOME') ?? await $.env.get('USERPROFILE')
  if (!home) return targets
  const dir = `${home}/.claude/agent-flow`
  let entries
  try { entries = await $.fs.list(dir) } catch { return targets }

  const matches: Target[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === 'workspaces.json') continue
    try {
      const d = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`))) as Partial<Target>
      if (typeof d.port !== 'number' || typeof d.workspace !== 'string') continue
      if (realCwd === d.workspace || realCwd.startsWith(d.workspace.replace(/[\\/]$/, '') + '/')) {
        matches.push({ port: d.port, workspace: d.workspace })
      }
    } catch { /* a file being written, or not ours */ }
  }
  const longest = Math.max(0, ...matches.map(m => m.workspace.length))
  targets = matches.filter(m => m.workspace.length === longest)
  return targets
}
