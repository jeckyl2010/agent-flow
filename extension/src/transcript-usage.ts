/**
 * Model usage as Claude Code's transcript records it: each assistant entry carries its request's
 * `message.usage`. A request with several content blocks is written as several entries with the
 * same `message.id`, each carrying the whole request's usage, so a request is counted once by id.
 *
 * For sessions the agent-flow-bridge mod doesn't report, this is where Agent Flow learns what the
 * API measured: output tokens (which the environmental impacts are figured from) and prices.
 */

import { isFastUsage, LONG_PROMPT_TOKENS, type ModelUsage, type UsageTotals, type WatchedSession } from './protocol'

export interface TranscriptStep {
  model: string
  usage: ModelUsage
  stopReason?: string
  effort?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Tokens a request wrote to the cache with the 1-hour TTL, from the API's `cache_creation`
 *  breakdown (or a flat count, as this module passes it on) */
export function oneHourWrites(usage: Record<string, unknown>): number {
  if (typeof usage.cache_creation_1h_input_tokens === 'number') return usage.cache_creation_1h_input_tokens
  const c = usage.cache_creation
  return isRecord(c) && typeof c.ephemeral_1h_input_tokens === 'number' ? c.ephemeral_1h_input_tokens : 0
}

function sumUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  return {
    input_tokens: (a?.input_tokens ?? 0) + b.input_tokens,
    output_tokens: (a?.output_tokens ?? 0) + b.output_tokens,
    cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + b.cache_read_input_tokens,
    cache_creation_input_tokens: (a?.cache_creation_input_tokens ?? 0) + b.cache_creation_input_tokens,
    cache_creation_1h_input_tokens: (a?.cache_creation_1h_input_tokens ?? 0) + (b.cache_creation_1h_input_tokens ?? 0),
  }
}

/** Adds one request to an agent's totals, per model; returns the agent's totals */
export function addUsage(all: Map<string, UsageTotals>, agentName: string, model: string, usage: ModelUsage): UsageTotals {
  let totals = all.get(agentName)
  if (!totals) {
    totals = { steps: 0, byModel: new Map() }
    all.set(agentName, totals)
  }
  totals.steps++
  const sum = totals.byModel.get(model)
  // Summed, the requests can't say which were long or fast: those are kept apart as well, to be priced
  const part = pricedPart(usage)
  const longPrompt = part === 'long_prompt' ? sumUsage(sum?.long_prompt, usage) : sum?.long_prompt
  const fast = part === 'fast' ? sumUsage(sum?.fast, usage) : sum?.fast
  totals.byModel.set(model, {
    ...sumUsage(sum, usage),
    requests: (sum?.requests ?? 0) + 1,
    ...(longPrompt ? { long_prompt: longPrompt } : {}),
    ...(fast ? { fast } : {}),
  })
  return totals
}

/** The part of a model's totals, priced apart, that a request is counted in besides the whole: at
 *  most one, as no model has both a fast mode and a long-prompt card */
function pricedPart(usage: ModelUsage): 'fast' | 'long_prompt' | undefined {
  if (usage.speed === 'fast') return 'fast'
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return prompt > LONG_PROMPT_TOKENS ? 'long_prompt' : undefined
}

/** An agent's totals as a model_step carries them: `{ steps, byModel: [{ model, ...usage }] }` */
export function totalsPayload(totals: UsageTotals) {
  return {
    steps: totals.steps,
    byModel: Array.from(totals.byModel, ([model, usage]) => ({ model, ...usage })),
  }
}

/** One request's usage from the API's `usage` (in a transcript, or as the mod passes it on) */
export function toModelUsage(u: object): ModelUsage {
  const raw = u as Record<string, unknown>
  const n = (k: string) => (typeof raw[k] === 'number' ? raw[k] as number : 0)
  return {
    input_tokens: n('input_tokens'),
    output_tokens: n('output_tokens'),
    cache_read_input_tokens: n('cache_read_input_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'),
    cache_creation_1h_input_tokens: oneHourWrites(raw),
    ...(isFastUsage(raw) ? { speed: 'fast' as const } : {}),
  }
}

/** The request a parsed assistant entry belongs to, with its id; undefined for any other entry */
export function parseTranscriptStep(parsed: unknown): { id: string; step: TranscriptStep } | undefined {
  if (!isRecord(parsed) || parsed.type !== 'assistant' || !isRecord(parsed.message)) return undefined
  const msg = parsed.message
  if (typeof msg.id !== 'string' || !isRecord(msg.usage)) return undefined
  return {
    id: msg.id,
    step: {
      model: typeof msg.model === 'string' ? msg.model : 'unknown',
      usage: toModelUsage(msg.usage),
      stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
      effort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
    },
  }
}

/** Counts the request a parsed entry belongs to into the agent's totals, the first time it is
 *  seen; returns it then, and undefined for an entry already counted or not a request's.
 *
 *  Before 2.1.307 a subagent's transcript could first record a streamed request with the output
 *  tokens counted at its start: a later entry of it that reports more adds the difference */
export function recordTranscriptUsage(
  parsed: unknown,
  agentName: string,
  session: WatchedSession,
): TranscriptStep | undefined {
  const found = parseTranscriptStep(parsed)
  if (!found) return undefined
  const { model, usage } = found.step
  const counted = session.usageOutputs.get(found.id)
  if (counted !== undefined) {
    const sum = session.usageTotals.get(agentName)?.byModel.get(model)
    if (sum && usage.output_tokens > counted) {
      sum.output_tokens += usage.output_tokens - counted
      const part = pricedPart(usage)
      const partSum = part && sum[part]
      if (partSum) partSum.output_tokens += usage.output_tokens - counted
      session.usageOutputs.set(found.id, usage.output_tokens)
    }
    return undefined
  }
  session.usageOutputs.set(found.id, usage.output_tokens)
  addUsage(session.usageTotals, agentName, model, usage)
  return found.step
}

/** A `model_step` payload, as the bridge mod's: the request, and the agent's totals so far */
export function modelStepPayload(agentName: string, step: TranscriptStep, totals: UsageTotals): Record<string, unknown> {
  return {
    agent: agentName,
    model: step.model,
    ...(step.effort !== undefined ? { effort: step.effort } : {}),
    stopReason: step.stopReason,
    usage: step.usage,
    totals: totalsPayload(totals),
    // The transcript is read from its start: every request the agent made is counted
    isComplete: true,
  }
}
