import * as http from 'http'
import * as vscode from 'vscode'
import { AgentEvent, emitSubagentSpawn } from './protocol'
import {
  ORCHESTRATOR_NAME, PREVIEW_MAX, RESULT_MAX, MESSAGE_MAX, resolveSubagentChildName,
  SESSION_ID_DISPLAY, FAILED_RESULT_MAX, HOOK_MAX_BODY_SIZE,
  SUBAGENT_ID_SUFFIX_LENGTH, HOOK_SERVER_HOST, HOOK_SERVER_NOT_STARTED,
  generateSubagentFallbackName,
} from './constants'
import { summarizeInput, summarizeResult, extractFilePath, buildDiscovery } from './tool-summarizer'
import { estimateTokenCost } from './token-estimator'
import { createLogger } from './logger'
import { markModSession, forgetModSession } from './mod-sessions'

const log = createLogger('HookServer')

/**
 * Lightweight HTTP server that receives Claude Code hook events.
 *
 * Claude Code hooks POST JSON payloads for events like PreToolUse, PostToolUse,
 * SubagentStart, SubagentStop, SessionStart, Stop, etc.
 *
 * We transform these into AgentEvent format and emit them.
 */

/** Port 0 = let OS assign a random available port */

interface HookPayload {
  session_id: string
  transcript_path?: string
  cwd?: string
  hook_event_name: string
  // PreToolUse / PostToolUse
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_use_id?: string
  tool_response?: string | { content: string } | Array<{ text?: string }>
  // PostToolUseFailure: the failure is in `error`, not `tool_response`
  error?: string
  is_interrupt?: boolean
  // SubagentStart / SubagentStop
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  // PermissionRequest carries tool_name and tool_input, as PreToolUse does
  // Notification
  notification_type?: string
  message?: string
  title?: string
  // Sent by the agent-flow-bridge mod rather than a settings.json command hook
  agent_flow_source?: 'mod'
  // ModelStep (mod only): one model request's model and usage as the API reported them
  model?: string
  usage?: ModelUsage | null
  step?: number
  stop_reason?: string | null
  /** What the whole session has cost, as /cost totals it, when the request ended */
  session_cost_usd?: number
  // ModelOutput (mod only): a text or thinking block as it streams, sent again as it grows
  stream_id?: string
  role?: 'assistant' | 'thinking'
  content?: string
  is_final?: boolean
  // SubagentStart (mod only): the task as the Agent tool named it, and the agent whose call started it
  description?: string
  parent_agent_id?: string
  // Generic
  [key: string]: unknown
}

interface ModelUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the hook server remembers per session — cleaned up on SessionEnd to prevent unbounded growth */
interface SessionHookState {
  startTime: number
  agentNames: Map<string, string> // agent_id → friendly name
  /** agent_id → the name of the agent that started it, where the mod said */
  agentParents: Map<string, string>
  /** Hooks run async, so a fast tool's PostToolUse can arrive before its PreToolUse. Tracked by
   *  tool_use_id: 'started' once its start is shown, 'ended' once an early end was shown with a
   *  start made up for it, so the late PreToolUse is dropped. Matched pairs are removed. */
  toolUses: Map<string, 'started' | 'ended'>
  /** Once PermissionRequest is seen, the generic permission Notification is redundant — and it
   *  always names the orchestrator, even when a subagent is the one asking. */
  sawPermissionRequest: boolean
  /** The agent-flow-bridge mod reports this session: the command hooks' copies of its events are dropped */
  isModFed: boolean
  /** Each agent's model as last reported (by name), so a change is shown once */
  models: Map<string, string>
  /** Each agent's measured usage so far (by name), per model: sent whole with every request, so
   *  a page that connects late still shows it all */
  usageTotals: Map<string, { steps: number; byModel: Map<string, ModelUsage> }>
}

export class HookServer implements vscode.Disposable {
  private server: http.Server | null = null
  private port: number
  /** Per-session state — cleaned up on SessionEnd/Stop to prevent unbounded growth */
  private sessionState = new Map<string, SessionHookState>()

  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()

  readonly onEvent = this._onEvent.event

  constructor(port?: number) {
    this.port = port ?? 0
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST') {
          let body = ''
          let oversized = false
          req.on('data', (chunk: Buffer) => {
            if (oversized) return
            body += chunk.toString()
            if (body.length > HOOK_MAX_BODY_SIZE) {
              oversized = true
              body = ''
              log.warn('Request body exceeded size limit, discarding')
            }
          })
          req.on('end', () => {
            if (!oversized) {
              try {
                const parsed: unknown = JSON.parse(body)
                if (!parsed || typeof parsed !== 'object' || !('session_id' in parsed) || !('hook_event_name' in parsed)
                    || typeof (parsed as HookPayload).session_id !== 'string'
                    || typeof (parsed as HookPayload).hook_event_name !== 'string') {
                  log.warn('Invalid hook payload: missing session_id or hook_event_name')
                } else {
                  this.handleHook(parsed as HookPayload)
                }
              } catch (e) {
                log.error('Failed to parse payload:', e)
              }
            }
            // Always return 200 with empty body — we're observing, not blocking.
            // Empty body = "success, no output" per Claude Code docs.
            // Returning JSON (even '{}') triggers schema parsing which can cause issues.
            res.writeHead(200)
            res.end()
          })
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('Agent Visualizer Hook Server')
        }
      })

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Another instance already owns this port — skip instead of incrementing
          // to a port nobody sends to. The session watcher handles all events via JSONL.
          log.info(`Port ${this.port} in use (another instance owns it) — skipping hook server`)
          this.server?.close()
          this.server = null
          resolve(HOOK_SERVER_NOT_STARTED)
        } else {
          reject(err)
        }
      })

      this.server.listen(this.port, HOOK_SERVER_HOST, () => {
        const addr = this.server!.address() as { port: number }
        this.port = addr.port
        log.info(`Listening on http://127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  private getOrCreateSession(sessionId: string): SessionHookState {
    let state = this.sessionState.get(sessionId)
    if (!state) {
      state = { startTime: Date.now(), agentNames: new Map(), agentParents: new Map(), toolUses: new Map(), sawPermissionRequest: false, isModFed: false, models: new Map(), usageTotals: new Map() }
      this.sessionState.set(sessionId, state)
    }
    return state
  }

  private elapsedSeconds(sessionId?: string): number {
    const startTime = sessionId ? (this.sessionState.get(sessionId)?.startTime ?? Date.now()) : Date.now()
    return (Date.now() - startTime) / 1000
  }

  private handleHook(payload: HookPayload): void {
    const eventName = payload.hook_event_name
    log.debug(eventName, payload.tool_name || payload.agent_type || '')

    if (payload.agent_flow_source === 'mod') {
      this.getOrCreateSession(payload.session_id).isModFed = true
      markModSession(payload.session_id)
    } else if (this.sessionState.get(payload.session_id)?.isModFed) {
      return
    }

    switch (eventName) {
      case 'SessionStart':
        this.handleSessionStart(payload)
        break
      case 'PreToolUse':
        this.startToolUse(payload)
        break
      case 'PostToolUse':
        this.endsToolUse(payload)
        this.handlePostToolUse(payload)
        break
      case 'PostToolUseFailure':
        this.endsToolUse(payload)
        this.handlePostToolUseFailure(payload)
        break
      case 'PermissionRequest':
        this.handlePermissionRequest(payload)
        break
      case 'SubagentStart':
        this.handleSubagentStart(payload)
        break
      case 'SubagentStop':
        this.handleSubagentStop(payload)
        break
      case 'Notification':
        this.handleNotification(payload)
        break
      case 'Stop':
        this.handleStop(payload)
        break
      case 'SessionEnd':
        this.handleSessionEnd(payload)
        break
      case 'ModelStep':
        this.handleModelStep(payload)
        break
      case 'ModelOutput':
        this.handleModelOutput(payload)
        break
    }
  }

  private handleSessionStart(payload: HookPayload): void {
    this.getOrCreateSession(payload.session_id)

    this.emit({
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: ORCHESTRATOR_NAME,
        isMain: true,
        task: `Session ${payload.session_id.slice(0, SESSION_ID_DISPLAY)}`,
      },
    }, payload.session_id)
  }

  /** A tool's start, unless its end arrived first and was already shown with a start made up for it. */
  private startToolUse(payload: HookPayload): void {
    const id = payload.tool_use_id
    const uses = this.sessionState.get(payload.session_id)?.toolUses
    if (id && uses?.get(id) === 'ended') {
      uses.delete(id)
      return
    }
    this.handlePreToolUse(payload) // creates the session when this is its first event
    if (id) this.getOrCreateSession(payload.session_id).toolUses.set(id, 'started')
  }

  /** Before a tool's end is shown: if its start hasn't arrived yet, show one now, so the call
   *  doesn't stay running once the late PreToolUse comes and is dropped. */
  private endsToolUse(payload: HookPayload): void {
    const id = payload.tool_use_id
    if (!id) return
    const uses = this.sessionState.get(payload.session_id)?.toolUses
    if (uses?.get(id) === 'started') {
      uses.delete(id)
      return
    }
    this.handlePreToolUse(payload) // PostToolUse carries the same tool_name and tool_input
    this.getOrCreateSession(payload.session_id).toolUses.set(id, 'ended')
  }

  private handlePreToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const args = summarizeInput(toolName, payload.tool_input)

    // If this is the first event and no session start was received, auto-spawn
    if (!this.sessionState.has(payload.session_id)) {
      this.handleSessionStart(payload)
    }

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_start',
      payload: {
        agent: agentName,
        tool: toolName,
        args,
        preview: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
      },
    }, payload.session_id)
  }

  private handlePostToolUse(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    const result = payload.tool_response ? summarizeResult(payload.tool_response) : ''
    const tokenCost = estimateTokenCost(toolName, result)

    // Build discovery for file-related tools
    const discovery = buildDiscovery(toolName, extractFilePath(payload.tool_input), result)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: result.slice(0, RESULT_MAX),
        tokenCost,
        ...(discovery ? { discovery } : {}),
      },
    }, payload.session_id)
  }

  private handlePostToolUseFailure(payload: HookPayload): void {
    const agentName = this.resolveAgentName(payload)
    const toolName = payload.tool_name || 'unknown'
    // Claude Code sends the failure as `error`; `tool_response` is kept for older versions that sent it there.
    const reason = typeof payload.error === 'string' ? payload.error
      : payload.tool_response ? summarizeResult(payload.tool_response) : ''
    const label = payload.is_interrupt ? '[INTERRUPTED]' : '[FAILED]'

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        result: `${label} ${reason.slice(0, FAILED_RESULT_MAX)}`,
        tokenCost: 0,
        // The UI shows a failure in its error state; an interrupt was the user's choice, not a failure.
        isError: !payload.is_interrupt,
        errorMessage: reason.slice(0, FAILED_RESULT_MAX) || undefined,
      },
    }, payload.session_id)
  }

  private handleSubagentStart(payload: HookPayload): void {
    if (payload.agent_flow_source === 'mod') {
      this.spawnReportedSubagent(payload)
      return
    }

    // Track agent_id → name mapping for SubagentStop resolution, but do not
    // emit agent_spawn here.  The transcript parser independently spawns the
    // subagent using its description field (via resolveSubagentChildName),
    // which produces the user-facing name.  Emitting a second spawn from the
    // hook creates a duplicate node with a generic name like
    // "general-purpose-ab75a" alongside the correctly-named node.
    const agentType = payload.agent_type || 'subagent'
    const agentId = payload.agent_id || ''
    const sessionAgents = this.getOrCreateSession(payload.session_id).agentNames
    const childName = agentId ? `${agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}` : generateSubagentFallbackName(String(Date.now()), sessionAgents.size + 1)

    sessionAgents.set(agentId, childName)
  }

  /** The mod's subagent, named as the transcript parser names it (by its task), so the rest of the
   *  pipeline agrees, and spawned now: the transcript side leaves a reported session's subagents to us. */
  private spawnReportedSubagent(payload: HookPayload): void {
    const agentId = payload.agent_id
    if (!agentId) return
    const state = this.getOrCreateSession(payload.session_id)
    const childName = resolveSubagentChildName({ description: payload.description, subagent_type: payload.agent_type })
    const parentName = (payload.parent_agent_id && state.agentNames.get(payload.parent_agent_id)) || ORCHESTRATOR_NAME
    state.agentNames.set(agentId, childName)
    state.agentParents.set(agentId, parentName)
    emitSubagentSpawn({
      emit: (event, sessionId) => this.emit(event, sessionId),
      elapsed: sessionId => this.elapsedSeconds(sessionId),
    }, parentName, childName, payload.description || childName, payload.session_id)
    if (payload.model) {
      state.models.set(childName, payload.model)
      this.emit({
        time: this.elapsedSeconds(payload.session_id),
        type: 'model_detected',
        payload: { agent: childName, model: payload.model },
      }, payload.session_id)
    }
  }

  private handleSubagentStop(payload: HookPayload): void {
    const agentId = payload.agent_id || ''
    const sessionAgents = this.sessionState.get(payload.session_id)?.agentNames
    const childName = sessionAgents?.get(agentId) || 'subagent'
    // agent_id names the subagent stopping, not its parent
    const parentName = this.sessionState.get(payload.session_id)?.agentParents.get(agentId) || ORCHESTRATOR_NAME

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'subagent_return',
      payload: { child: childName, parent: parentName, summary: `${payload.agent_type} complete` },
    }, payload.session_id)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: childName },
    }, payload.session_id)
  }

  /** What is waiting for the user's approval, by the agent that asked: the tool and its input. */
  private handlePermissionRequest(payload: HookPayload): void {
    this.getOrCreateSession(payload.session_id).sawPermissionRequest = true
    const toolName = payload.tool_name || 'unknown'
    const args = summarizeInput(toolName, payload.tool_input)

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'permission_requested',
      payload: {
        agent: this.resolveAgentName(payload),
        tool: toolName,
        args,
        message: `${toolName}: ${args}`.slice(0, PREVIEW_MAX),
        title: 'Permission needed',
      },
    }, payload.session_id)
  }

  private handleNotification(payload: HookPayload): void {
    if (payload.notification_type !== 'permission_prompt') return
    // Claude Code without PermissionRequest (older versions) still says so here, if less precisely
    if (this.sessionState.get(payload.session_id)?.sawPermissionRequest) return

    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'permission_requested',
      payload: {
        agent: ORCHESTRATOR_NAME,
        message: payload.message || 'Permission needed',
        title: payload.title || 'Permission needed',
      },
    }, payload.session_id)
  }

  private handleStop(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME },
    }, payload.session_id)
  }

  /** A text or thinking block as it streams; the UI updates the message with its streamId in place. */
  private handleModelOutput(payload: HookPayload): void {
    if (!payload.stream_id || !payload.content) return
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'message',
      payload: {
        agent: this.resolveAgentName(payload),
        role: payload.role === 'thinking' ? 'thinking' : 'assistant',
        content: payload.content.slice(0, MESSAGE_MAX),
        streamId: payload.stream_id,
        isPartial: !payload.is_final,
      },
    }, payload.session_id)
  }

  /** An agent's model and context fill, from the usage the API reported for its latest request. */
  private handleModelStep(payload: HookPayload): void {
    const state = this.getOrCreateSession(payload.session_id)
    // A subagent that started before this server did has no node of its own: left out, rather
    // than counted as the main agent's
    if (payload.agent_id && !state.agentNames.has(payload.agent_id)) return
    const time = this.elapsedSeconds(payload.session_id)
    const agent = this.resolveAgentName(payload)

    if (payload.model && payload.model !== state.models.get(agent)) {
      state.models.set(agent, payload.model)
      this.emit({ time, type: 'model_detected', payload: { agent, model: payload.model } }, payload.session_id)
    }

    const usage = payload.usage
    if (!usage) return
    const totals = this.addUsage(state, agent, payload.model || 'unknown', usage)
    // One model request as the API reported it: the UI draws its heartbeat and prices the totals
    this.emit({
      time,
      type: 'model_step',
      payload: {
        agent,
        model: payload.model,
        step: payload.step,
        stopReason: payload.stop_reason,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        },
        totals,
        // A subagent's totals are whole when this server saw it start; the main agent's never are
        // known to be, so its exact figure comes from the session's cost less its subagents'
        isComplete: !!payload.agent_id,
        ...(typeof payload.session_cost_usd === 'number' ? { sessionCostUsd: payload.session_cost_usd } : {}),
      },
    }, payload.session_id)
    // Everything the request read, plus what it wrote: the context the next request starts from
    const tokens = usage.input_tokens + usage.cache_read_input_tokens
      + usage.cache_creation_input_tokens + usage.output_tokens
    this.emit({
      time,
      type: 'context_update',
      payload: { agent, tokens, isMeasured: true },
    }, payload.session_id)
  }

  private addUsage(state: SessionHookState, agent: string, model: string, usage: ModelUsage) {
    let totals = state.usageTotals.get(agent)
    if (!totals) {
      totals = { steps: 0, byModel: new Map() }
      state.usageTotals.set(agent, totals)
    }
    totals.steps++
    const sum = totals.byModel.get(model) ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    totals.byModel.set(model, {
      input_tokens: sum.input_tokens + usage.input_tokens,
      output_tokens: sum.output_tokens + usage.output_tokens,
      cache_read_input_tokens: sum.cache_read_input_tokens + usage.cache_read_input_tokens,
      cache_creation_input_tokens: sum.cache_creation_input_tokens + usage.cache_creation_input_tokens,
    })
    return {
      steps: totals.steps,
      byModel: [...totals.byModel].map(([m, u]) => ({ model: m, ...u })),
    }
  }

  private handleSessionEnd(payload: HookPayload): void {
    this.emit({
      time: this.elapsedSeconds(payload.session_id),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
    }, payload.session_id)

    // Clean up per-session state to prevent unbounded Map growth
    this.sessionState.delete(payload.session_id)
    forgetModSession(payload.session_id)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private resolveAgentName(payload: HookPayload): string {
    // If this event has an agent_id, look it up in the session's agent names.
    if (payload.agent_id) {
      const name = this.sessionState.get(payload.session_id)?.agentNames.get(payload.agent_id)
      if (name) return name
    }
    return ORCHESTRATOR_NAME
  }

  private emit(event: AgentEvent, sessionId?: string): void {
    this._onEvent.fire(sessionId ? { ...event, sessionId } : event)
  }

  dispose(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.sessionState.clear()
    this._onEvent.dispose()
  }
}
