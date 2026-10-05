import type { Agent, AgentSpend, ModelOutput, ModelStepPulse, ModelTag } from '@/lib/agent-types'
import type { InferenceSite } from '@/lib/inference-zone'
import { effortColor } from '@/lib/effort'
import { modelTagLabel } from '@/lib/utils'
import { stepCost, cacheHitRatio, type StepUsage } from '@/lib/model-pricing'
import { HEARTBEAT } from '@/lib/canvas-constants'
import { asString } from './types'
import type { MutableEventState } from './process-event'

function asUsage(v: unknown): StepUsage | undefined {
  if (!v || typeof v !== 'object') return undefined
  const u = v as Record<string, unknown>
  const n = (k: string) => (typeof u[k] === 'number' ? u[k] as number : 0)
  return {
    input_tokens: n('input_tokens'),
    output_tokens: n('output_tokens'),
    cache_read_input_tokens: n('cache_read_input_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'),
    cache_creation_1h_input_tokens: n('cache_creation_1h_input_tokens'),
  }
}

/** Where the request ran, as the bridge mod reports it: `{ platform, region? }` */
function asSite(v: unknown): InferenceSite | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { platform, region, gateway } = v as { platform?: unknown; region?: unknown; gateway?: unknown }
  if (platform !== 'anthropic' && platform !== 'bedrock' && platform !== 'vertex' && platform !== 'foundry') return undefined
  return {
    platform,
    ...(typeof region === 'string' && region ? { region } : {}),
    ...(typeof gateway === 'string' && gateway ? { gateway } : {}),
  }
}

/** The agent's usage so far as the relay totals it, per model: `{ steps, byModel: [{ model, ...usage }] }` */
function spendFromTotals(v: unknown, isComplete: boolean): Omit<AgentSpend, 'lastCacheHit'> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { steps, byModel } = v as { steps?: unknown; byModel?: unknown }
  if (typeof steps !== 'number' || !Array.isArray(byModel)) return undefined
  const spend = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps, isComplete, byModel: [] as ModelOutput[] }
  for (const entry of byModel) {
    const usage = asUsage(entry)
    if (!usage) continue
    const model = typeof (entry as { model?: unknown }).model === 'string' ? (entry as { model: string }).model : undefined
    const requests = (entry as { requests?: unknown }).requests
    if (model) spend.byModel.push({
      model, output: usage.output_tokens,
      // Older relays sent no count per model: a single model made them all
      requests: typeof requests === 'number' ? requests : byModel.length === 1 ? steps : 0,
    })
    spend.cost += stepCost(usage, model)
    spend.input += usage.input_tokens
    spend.output += usage.output_tokens
    spend.cacheRead += usage.cache_read_input_tokens
    spend.cacheWrite += usage.cache_creation_input_tokens
  }
  return spend
}

/** Adds one request to what the agent had: for events that carry no totals (the demo scenario) */
function addStep(prev: AgentSpend | undefined, usage: StepUsage, cost: number, model?: string): Omit<AgentSpend, 'lastCacheHit'> {
  const byModel = (prev?.byModel ?? []).map(m => ({ ...m }))
  if (model) {
    const entry = byModel.find(m => m.model === model)
    if (entry) { entry.output += usage.output_tokens; entry.requests++ }
    else byModel.push({ model, output: usage.output_tokens, requests: 1 })
  }
  return {
    byModel,
    cost: (prev?.cost ?? 0) + cost,
    input: (prev?.input ?? 0) + usage.input_tokens,
    output: (prev?.output ?? 0) + usage.output_tokens,
    cacheRead: (prev?.cacheRead ?? 0) + usage.cache_read_input_tokens,
    cacheWrite: (prev?.cacheWrite ?? 0) + usage.cache_creation_input_tokens,
    steps: (prev?.steps ?? 0) + 1,
    isComplete: prev?.isComplete ?? true,
  }
}

/** One model request the API measured (the agent-flow-bridge mod): the agent's spend, and a pulse
 *  for its heartbeat; the session's cost goes on the main agent. */
export function handleModelStep(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const agent = state.agents.get(agentName)
  const usage = asUsage(payload.usage)
  if (!agent || !usage) return

  const model = typeof payload.model === 'string' ? payload.model : agent.model
  const effort = typeof payload.effort === 'string' ? payload.effort : undefined
  const cost = stepCost(usage, model)
  const totals = spendFromTotals(payload.totals, payload.isComplete === true) ?? addStep(agent.spend, usage, cost, model)
  const spend: AgentSpend = {
    ...totals,
    lastCacheHit: cacheHitRatio(usage) ?? agent.spend?.lastCacheHit,
    inference: asSite(payload.inference) ?? agent.spend?.inference,
  }
  const pulse: ModelStepPulse = {
    time: currentTime,
    outputTokens: usage.output_tokens,
    stopReason: typeof payload.stopReason === 'string' ? payload.stopReason : '',
    cost,
    effort,
  }
  const recentSteps = [...(agent.recentSteps ?? []), pulse].slice(-HEARTBEAT.maxPulses)
  const modelTag = model ? nextModelTag(agent, model, effort, currentTime, state) : agent.modelTag
  state.agents.set(agentName, { ...agent, spend, recentSteps, modelTag })

  if (typeof payload.sessionCostUsd === 'number') {
    const main = findMain(state.agents)
    if (main) state.agents.set(main.id, { ...main, sessionCostUsd: payload.sessionCostUsd })
  }
}

/** The agent's model tag after this request: a change restarts its animation and marks the timeline */
function nextModelTag(
  agent: Agent,
  model: string,
  effort: string | undefined,
  currentTime: number,
  state: MutableEventState,
): ModelTag {
  const prev = agent.modelTag
  if (prev && prev.model === model && prev.effort === effort) return prev

  const label = modelTagLabel(model, effort)
  if (prev) {
    const entry = state.timelineEntries.get(agent.id)
    if (entry) {
      const marker = { time: currentTime, label, color: effortColor(effort) }
      state.timelineEntries.set(agent.id, { ...entry, markers: [...(entry.markers ?? []), marker] })
    }
  }
  return { model, effort, changedAt: currentTime, previousLabel: prev ? modelTagLabel(prev.model, prev.effort) : undefined }
}

function findMain(agents: Map<string, Agent>): Agent | undefined {
  for (const a of agents.values()) if (a.isMain) return a
  return undefined
}
