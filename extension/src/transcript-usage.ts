/**
 * Model usage as Claude Code's transcript records it: each assistant entry carries its request's
 * `message.usage`. A request with several content blocks is written as several entries with the
 * same `message.id`, each carrying the whole request's usage, so a request is counted once by id.
 *
 * For sessions the agent-flow-bridge mod doesn't report, this is where Agent Flow learns what the
 * API measured: output tokens (which the environmental impacts are figured from) and prices.
 */

import type { ModelUsage, UsageTotals, WatchedSession } from './protocol'

export interface TranscriptStep {
  model: string
  usage: ModelUsage
  stopReason?: string
  effort?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** The request a parsed assistant entry belongs to, with its id; undefined for any other entry */
export function parseTranscriptStep(parsed: unknown): { id: string; step: TranscriptStep } | undefined {
  if (!isRecord(parsed) || parsed.type !== 'assistant' || !isRecord(parsed.message)) return undefined
  const msg = parsed.message
  if (typeof msg.id !== 'string' || !isRecord(msg.usage)) return undefined
  const u = msg.usage
  const n = (k: string) => (typeof u[k] === 'number' ? u[k] as number : 0)
  return {
    id: msg.id,
    step: {
      model: typeof msg.model === 'string' ? msg.model : 'unknown',
      usage: {
        input_tokens: n('input_tokens'),
        output_tokens: n('output_tokens'),
        cache_read_input_tokens: n('cache_read_input_tokens'),
        cache_creation_input_tokens: n('cache_creation_input_tokens'),
      },
      stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
      effort: typeof parsed.effort === 'string' ? parsed.effort : undefined,
    },
  }
}

/** Counts the request a parsed entry belongs to into the agent's totals, the first time it is
 *  seen; returns it then, and undefined for an entry already counted or not a request's */
export function recordTranscriptUsage(
  parsed: unknown,
  agentName: string,
  session: WatchedSession,
): TranscriptStep | undefined {
  const found = parseTranscriptStep(parsed)
  if (!found || session.usageSeenIds.has(found.id)) return undefined
  session.usageSeenIds.add(found.id)
  const { step } = found
  const usage = step.usage

  let totals = session.usageTotals.get(agentName)
  if (!totals) {
    totals = { steps: 0, byModel: new Map() }
    session.usageTotals.set(agentName, totals)
  }
  totals.steps++
  const sum = totals.byModel.get(step.model)
  totals.byModel.set(step.model, sum
    ? {
      input_tokens: sum.input_tokens + usage.input_tokens,
      output_tokens: sum.output_tokens + usage.output_tokens,
      cache_read_input_tokens: sum.cache_read_input_tokens + usage.cache_read_input_tokens,
      cache_creation_input_tokens: sum.cache_creation_input_tokens + usage.cache_creation_input_tokens,
    }
    : usage)
  return step
}

/** A `model_step` payload, as the bridge mod's: the request, and the agent's totals so far */
export function modelStepPayload(agentName: string, step: TranscriptStep, totals: UsageTotals): Record<string, unknown> {
  return {
    agent: agentName,
    model: step.model,
    ...(step.effort !== undefined ? { effort: step.effort } : {}),
    stopReason: step.stopReason,
    usage: step.usage,
    totals: {
      steps: totals.steps,
      byModel: Array.from(totals.byModel, ([model, usage]) => ({ model, ...usage })),
    },
    // The transcript is read from its start: every request the agent made is counted
    isComplete: true,
  }
}
