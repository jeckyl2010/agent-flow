import type { Agent } from './agent-types'
import { blendedRate } from './model-pricing'

/** An estimate from a token count, at the model's blended rate */
export function estimatedCost(tokens: number, model?: string): number {
  return (tokens / 1_000_000) * blendedRate(model)
}

export interface CostFigure {
  cost: number
  /** Every request is counted at its own prices; otherwise partly or wholly estimated */
  isExact: boolean
}

export interface SessionCosts {
  byAgent: Map<string, CostFigure>
  total: CostFigure
}

/**
 * What each agent and the session cost, and which figures are exact.
 *
 * An agent the bridge mod reported from its start is exact: its requests priced from the API's
 * usage. Others are estimated from token counts. The session's total is exact when Claude Code
 * reported its cost (as /cost totals it, every request of the session); the main agent's share
 * is then that total less its subagents', exact when all of theirs are.
 */
export function sessionCosts(agents: Map<string, Agent>): SessionCosts {
  const byAgent = new Map<string, CostFigure>()
  let main: Agent | undefined
  let subTotal = 0
  let subsExact = true
  for (const [id, a] of agents) {
    const figure = a.spend
      ? { cost: a.spend.cost, isExact: a.spend.isComplete }
      : { cost: estimatedCost(a.tokensUsed, a.model), isExact: a.tokensUsed === 0 }
    byAgent.set(id, figure)
    if (a.isMain) {
      main = a
    } else {
      subTotal += figure.cost
      subsExact &&= figure.isExact
    }
  }

  const sessionCost = main?.sessionCostUsd
  if (main && sessionCost !== undefined) {
    if (subsExact) byAgent.set(main.id, { cost: Math.max(0, sessionCost - subTotal), isExact: true })
    return { byAgent, total: { cost: sessionCost, isExact: true } }
  }
  let total = 0
  let isExact = true
  for (const f of byAgent.values()) {
    total += f.cost
    isExact &&= f.isExact
  }
  return { byAgent, total: { cost: total, isExact } }
}

/** `$0.123`, or `~$0.123` for an estimate */
export function formatCost(figure: CostFigure, digits: number): string {
  return `${figure.isExact ? '' : '~'}$${figure.cost.toFixed(digits)}`
}
