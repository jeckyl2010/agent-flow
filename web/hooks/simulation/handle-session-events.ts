import type { Agent, RateLimit } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { compactionLabel, foldCompaction } from '@/lib/compaction'
import { asString, asNumber, asBoolean } from './types'
import type { MutableEventState } from './process-event'

/** Compactions kept per agent for the wormhole log */
const MAX_COMPACTIONS = 50
/** Messages kept per agent: one in flight is drawn for a few seconds */
const MAX_SENT_MESSAGES = 8

const optNumber = (v: unknown) => (typeof v === 'number' ? v : undefined)
const optString = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

function findMain(agents: Map<string, Agent>): Agent | undefined {
  for (const a of agents.values()) if (a.isMain) return a
  return undefined
}

function addMarker(state: MutableEventState, agent: Agent, time: number, label: string, color: string): void {
  const entry = state.timelineEntries.get(agent.id)
  if (entry) state.timelineEntries.set(agent.id, { ...entry, markers: [...(entry.markers ?? []), { time, label, color }] })
}

/**
 * A context compaction: from the bridge mod as it starts and as it ends (or is skipped), from a
 * transcript once it ended. The context drops to what it left; the wormhole is drawn from this.
 */
export function handleContextCompaction(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agent = state.agents.get(asString(payload.agent))
  if (!agent) return
  const list = foldCompaction(agent.compactions ?? [], payload, currentTime)
  if (!list) return
  const isHistory = asBoolean(payload.isHistory)

  const latest = list.at(-1)!
  const updates: Partial<Agent> = { compactions: list.slice(-MAX_COMPACTIONS) }
  // What the next request starts from; a compaction from before keeps the fill read since
  if (latest.phase === 'done' && !isHistory && latest.tokensAfter !== undefined) updates.tokensUsed = latest.tokensAfter
  state.agents.set(agent.id, { ...agent, ...updates })

  if (!isHistory && latest.phase !== 'running') {
    addMarker(state, agent, currentTime, latest.phase === 'skipped' ? 'compaction skipped' : `⟲ ${compactionLabel(latest)}`, COLORS.wormholeGlow)
  }
}

/** The main conversation as Claude Code measured it: the real context window, where it compacts,
 *  and how much of each rate-limit window the account has used */
export function handleSessionMeasure(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const main = findMain(state.agents)
  if (!main) return
  const window = asNumber(payload.contextWindow)
  const rateLimits = Array.isArray(payload.rateLimits)
    ? (payload.rateLimits as RateLimit[]).filter(r => typeof r?.kind === 'string' && typeof r.percentUsed === 'number')
    : main.rateLimits
  state.agents.set(main.id, {
    ...main,
    ...(window > 0 ? { tokensMax: window } : {}),
    compactThreshold: optNumber(payload.compactThreshold) ?? main.compactThreshold,
    rateLimits,
  })
}

/** A message one agent sent another (SendMessage): drawn from the sender to the recipient */
export function handleAgentMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const from = state.agents.get(asString(payload.from))
  const to = asString(payload.to)
  if (!from || !state.agents.has(to) || to === from.id) return
  const sent = [...(from.sentMessages ?? []), { to, time: currentTime, text: asString(payload.text) }]
  state.agents.set(from.id, { ...from, sentMessages: sent.slice(-MAX_SENT_MESSAGES) })
}

/** A turn that ended without an answer: the model refused, or an API error ended it */
export function handleTurnFailed(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agent = state.agents.get(asString(payload.agent))
  if (!agent) return
  const reason = payload.reason === 'refusal' ? 'refusal' : 'error'
  state.agents.set(agent.id, {
    ...agent,
    failure: { reason, time: currentTime, category: optString(payload.category), explanation: optString(payload.explanation) },
  })
  addMarker(state, agent, currentTime, reason === 'refusal' ? 'refused' : 'API error', COLORS.error)
}
