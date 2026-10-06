/**
 * Where a session's time went, and how long its prompt cache stays warm: read from the event
 * log, from the main agent's point of view, so the parts add up to the time Agent Flow watched.
 *
 * A turn runs from your message until the model ends its turn (a request that stops with
 * `end_turn`, or Claude Code's Stop hook); outside a turn, the session is waiting for you. Within
 * one, every moment is the most specific thing happening: a permission dialog, then a subagent
 * running, then a tool, and otherwise the model thinking and writing.
 */
import { HIDDEN_TOOLS, type SimulationEvent } from './agent-types'
import { findModel } from './eco-impact'

export type TimeKind = 'thinking' | 'tools' | 'subagents' | 'permission' | 'waiting'

export const TIME_KINDS: readonly TimeKind[] = ['thinking', 'tools', 'subagents', 'permission', 'waiting']

export interface TimeSegment {
  kind: TimeKind
  start: number
  end: number
}

export interface PromptCache {
  /** s: 300 or 3600 */
  ttl: number
  /** Simulation time the main agent's cache expires, unless a request starts before */
  expiresAt: number
  /** Tokens the latest request read from it or wrote to it: what a cold start would resend */
  tokens: number
  /** The model that request ran on, whose prices a read or a rewrite pays */
  model?: string
}

export interface TimeHorizon {
  /** Time per kind, s */
  totals: Record<TimeKind, number>
  /** The session's moments in order, each run of one kind merged */
  segments: TimeSegment[]
  /** The span covered, s: from the first event to now */
  elapsed: number
  start: number
  turns: number
  cache?: PromptCache
  /** Every agent's model requests, in order: what the session wrote, and when */
  emissions: Emission[]
  /** Each turn: your prompt, and what it set off */
  turnLog: Turn[]
  /** The main agent's context after each of its requests since its last compaction, tokens: it
   *  grows until it is compacted again */
  context: ContextSample[]
  /** The fill at which Claude Code compacts the main agent's context, as it measured it */
  compactThreshold?: number
  /** The main agent's compactions while Agent Flow watched, in order: each a wormhole on the disk */
  compactions: CompactionMark[]
  /** Each subagent the session sent out, in order */
  subagents: SubagentRun[]
}

export interface SubagentRun {
  name: string
  start: number
  /** When it came back; undefined while it runs */
  end?: number
  task?: string
  model?: string
  /** What it brought back */
  summary?: string
  requests: number
  tools: number
  outputTokens: number
}

/** A run's identity: names repeat (several `Explore` subagents), a name and its start don't */
export const runKey = (run: SubagentRun) => `${run.name}@${run.start}`

export interface Turn {
  start: number
  /** When the model ended the turn; undefined while it runs */
  end?: number
  /** Your message that started it, when one did */
  prompt?: string
  /** Time spent working on it, s: everything but waiting for you */
  work: number
  /** Model requests during it, every agent's */
  requests: number
  /** Tool calls the main agent made */
  tools: number
  outputTokens: number
}

export interface CompactionMark {
  time: number
  trigger?: string
  tokensBefore?: number
  tokensAfter?: number
}

export interface ContextSample {
  time: number
  tokens: number
}

export interface Emission {
  time: number
  outputTokens: number
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
/** A second start of a running tool this soon after the first is the same call, reported twice */
const DUPLICATE_START_S = 3
const CACHE_5M = 300
const CACHE_1H = 3600

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

/** A request's generation time, from EcoLogits' measured speed for its model: its cache lifetime
 *  counts from when it started, not when it was reported */
function generationSeconds(model: string, outputTokens: number): number {
  const d = findModel(model)?.deployment
  return d ? d.ttft + outputTokens / d.tps : 0
}

export function timeHorizon(events: readonly SimulationEvent[], now: number): TimeHorizon {
  const totals: Record<TimeKind, number> = { thinking: 0, tools: 0, subagents: 0, permission: 0, waiting: 0 }
  const segments: TimeSegment[] = []
  let main = 'orchestrator'
  for (const e of events) {
    if (e.type === 'agent_spawn' && e.payload.isMain === true) { main = str(e.payload.name) || main; break }
  }

  let inTurn = false
  let turns = 0
  let waitingPermission = false
  /** Running tool → when it started, per name: a name started twice runs until both end */
  const running = new Map<string, number[]>()
  let cache: PromptCache | undefined
  let ttl = CACHE_5M
  const emissions: Emission[] = []
  const turnLog: Turn[] = []
  const context: ContextSample[] = []
  let compactThreshold: number | undefined
  const compactions: CompactionMark[] = []
  const subagents: SubagentRun[] = []
  /** The run of each subagent still out, by name */
  const out = new Map<string, SubagentRun>()
  /** Tasks the dispatch named, for the spawn that follows it */
  const dispatched = new Map<string, string>()

  const kindNow = (): TimeKind => {
    if (!inTurn) return 'waiting'
    if (waitingPermission) return 'permission'
    for (const name of running.keys()) if (SUBAGENT_TOOLS.has(name)) return 'subagents'
    return running.size > 0 ? 'tools' : 'thinking'
  }

  const start = events.length > 0 ? Math.min(events[0].time, now) : now
  let t = start
  const advance = (to: number) => {
    const end = Math.min(to, now)
    if (end <= t) return
    const kind = kindNow()
    totals[kind] += end - t
    const last = segments.at(-1)
    if (last && last.kind === kind && last.end === t) last.end = end
    else segments.push({ kind, start: t, end })
    t = end
  }
  const beginTurn = (time: number, prompt?: string) => {
    if (inTurn) return
    inTurn = true
    turns++
    turnLog.push({ start: time, prompt, work: 0, requests: 0, tools: 0, outputTokens: 0 })
  }
  const endTurn = (time: number) => {
    const turn = turnLog.at(-1)
    if (inTurn && turn && turn.end === undefined) turn.end = time
    inTurn = false
    waitingPermission = false
    running.clear()
  }

  for (const e of events) {
    if (e.time > now) break
    advance(e.time)
    const p = e.payload
    // Subagents: sent out, working, and back
    const sub = out.get(str(p.agent))
    switch (e.type) {
      case 'subagent_dispatch':
        dispatched.set(str(p.child), str(p.task))
        break
      case 'agent_spawn':
        if (p.isMain !== true && str(p.name)) {
          const name = str(p.name)
          const run: SubagentRun = {
            name, start: e.time, task: str(p.task) || dispatched.get(name) || undefined,
            model: str(p.model) || undefined, requests: 0, tools: 0, outputTokens: 0,
          }
          subagents.push(run)
          out.set(name, run)
        }
        break
      case 'model_detected':
        if (sub) sub.model = str(p.model) || sub.model
        break
      case 'model_step':
        if (sub) {
          sub.requests++
          sub.outputTokens += num(((p.usage ?? {}) as Record<string, unknown>).output_tokens)
          sub.model = str(p.model) || sub.model
        }
        break
      case 'tool_call_start':
        if (sub && !HIDDEN_TOOLS.has(str(p.tool))) sub.tools++
        break
      case 'subagent_return': {
        const back = out.get(str(p.child))
        if (back) {
          back.summary = str(p.summary) || back.summary
          back.end ??= e.time
          out.delete(back.name)
        }
        break
      }
      case 'agent_complete': {
        const done = out.get(str(p.name))
        if (done) { done.end ??= e.time; out.delete(done.name) }
        break
      }
    }

    if (e.type === 'model_step') {
      const output = num(((p.usage ?? {}) as Record<string, unknown>).output_tokens)
      emissions.push({ time: e.time, outputTokens: output })
      const turn = inTurn ? turnLog.at(-1) : undefined
      if (turn) { turn.requests++; turn.outputTokens += output }
    }
    const agent = str(p.agent) || str(p.name)
    if (agent !== main) continue

    switch (e.type) {
      case 'message':
        // Your message starts a turn. The model's doesn't: its answer is often reported just
        // after the request that ended the turn
        if (p.role === 'user') beginTurn(e.time, str(p.content) || undefined)
        break
      case 'tool_call_start': {
        const tool = str(p.tool)
        if (HIDDEN_TOOLS.has(tool)) break
        beginTurn(e.time)
        waitingPermission = false
        const starts = running.get(tool) ?? []
        if (starts.some(s => e.time - s < DUPLICATE_START_S)) break
        running.set(tool, [...starts, e.time])
        turnLog.at(-1)!.tools++
        break
      }
      case 'tool_call_end': {
        const starts = running.get(str(p.tool))
        if (starts) {
          starts.shift()
          if (starts.length === 0) running.delete(str(p.tool))
        }
        waitingPermission = false
        break
      }
      case 'permission_requested':
        beginTurn(e.time)
        // A guess from a tool gone quiet is as likely a slow command: its time stays the tool's
        if (p.isGuess !== true) waitingPermission = true
        break
      case 'agent_idle':
        waitingPermission = false
        break
      case 'session_measure':
        compactThreshold = num(p.compactThreshold) || compactThreshold
        break
      case 'context_compaction':
        // What grew before is gone: the fit starts again from what the compaction left
        if (p.phase === 'end' && p.isHistory !== true) {
          compactions.push({
            time: e.time, trigger: str(p.trigger) || undefined,
            tokensBefore: typeof p.tokensBefore === 'number' ? p.tokensBefore : undefined,
            tokensAfter: typeof p.tokensAfter === 'number' ? p.tokensAfter : undefined,
          })
          context.length = 0
          if (num(p.tokensAfter) > 0) context.push({ time: e.time, tokens: num(p.tokensAfter) })
        }
        break
      case 'model_step': {
        const usage = (p.usage ?? {}) as Record<string, unknown>
        const written = num(usage.cache_creation_input_tokens)
        const oneHour = num(usage.cache_creation_1h_input_tokens)
        if (oneHour > 0) ttl = CACHE_1H
        else if (written > 0) ttl = CACHE_5M
        // A read refreshes the entry at its own TTL; a request that neither read nor wrote leaves it
        const tokens = num(usage.cache_read_input_tokens) + written
        if (tokens > 0) {
          const startedAt = e.time - generationSeconds(str(p.model), num(usage.output_tokens))
          cache = { ttl, expiresAt: startedAt + ttl, tokens, model: str(p.model) || undefined }
        }
        // What the next request starts from: all it read, plus what it wrote
        const window = tokens + num(usage.input_tokens) + num(usage.output_tokens)
        if (window > 0) context.push({ time: e.time, tokens: window })
        if (p.stopReason === 'end_turn') endTurn(e.time)
        else beginTurn(e.time)
        break
      }
      case 'agent_complete':
        endTurn(e.time)
        break
    }
  }
  advance(now)

  // A turn's work: its time in segments other than waiting for you
  for (const turn of turnLog) {
    const end = turn.end ?? now
    for (const seg of segments) {
      if (seg.kind === 'waiting' || seg.end <= turn.start || seg.start >= end) continue
      turn.work += Math.min(seg.end, end) - Math.max(seg.start, turn.start)
    }
  }

  return { totals, segments, elapsed: Math.max(0, now - start), start, turns, cache, emissions, turnLog, context, compactThreshold, compactions, subagents }
}

/** `1:02:03`, or `2:03` under an hour */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The longest unbroken stretch of one kind, s */
export function longest(h: TimeHorizon, kind: TimeKind): number {
  let best = 0
  for (const s of h.segments) if (s.kind === kind) best = Math.max(best, s.end - s.start)
  return best
}

export interface Consumption {
  /** s from now until the context window is full, at the recent rate */
  eta: number
  /** Tokens per minute the context has been growing */
  rate: number
  /** How full it is now, 0 to 1 */
  fill: number
}

/** How recent the context growth the prediction follows: the last 20 minutes */
const RATE_WINDOW_S = 1200
/** Further out than a week, the context isn't really closing in */
const MAX_ETA_S = 7 * 24 * 3600

/**
 * When the context window fills at the rate it has been growing (a least-squares fit over the
 * recent requests), and with it the moment the session's detail is compacted away. Undefined
 * while it isn't growing, or with too little to go on.
 */
export function predictConsumption(context: readonly ContextSample[], windowSize: number, now: number): Consumption | undefined {
  const recent = context.filter(c => c.time >= now - RATE_WINDOW_S)
  if (recent.length < 3 || windowSize <= 0) return undefined
  const n = recent.length
  const mt = recent.reduce((s, c) => s + c.time, 0) / n
  const mk = recent.reduce((s, c) => s + c.tokens, 0) / n
  let num = 0, den = 0
  for (const c of recent) { num += (c.time - mt) * (c.tokens - mk); den += (c.time - mt) ** 2 }
  const perSecond = den > 0 ? num / den : 0
  const current = recent[n - 1].tokens
  const fill = Math.min(1, current / windowSize)
  if (perSecond <= 0) return undefined
  const eta = (windowSize - current) / perSecond - (now - recent[n - 1].time)
  if (eta > MAX_ETA_S) return undefined
  return { eta: Math.max(0, eta), rate: perSecond * 60, fill }
}

export interface Parallelism {
  /** Agent time in the span, s: the main agent working, plus every subagent's time out */
  agentTime: number
  /** The most subagents out at once */
  peak: number
}

/**
 * How much agent time the session packed into its span. The main agent's own work (thinking and
 * tools; while it waits on subagents, they're the ones working) plus each subagent's time out.
 * With subagents in parallel it passes the wall clock: more time goes by for them than for you.
 */
export function parallelism(h: TimeHorizon): Parallelism {
  const now = h.start + h.elapsed
  let agentTime = h.totals.thinking + h.totals.tools
  const edges: Array<[number, number]> = []
  for (const run of h.subagents) {
    const from = Math.max(run.start, h.start), to = Math.min(run.end ?? now, now)
    if (to <= from) continue
    agentTime += to - from
    edges.push([from, 1], [to, -1])
  }
  // Ends before starts at the same moment: one back as another leaves isn't two out at once
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0, peak = 0
  for (const [, step] of edges) { current += step; peak = Math.max(peak, current) }
  return { agentTime, peak }
}
