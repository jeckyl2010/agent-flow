/**
 * Agents a workflow script started (Claude Code 2.1.292+, through the agent-flow-bridge mod): each
 * knows its run and its place among the run's agents, so a run can be shown as one piece of work.
 */

import type { Agent, WorkflowPlace } from './agent-types'
import { MIN_VISIBLE_OPACITY } from './canvas-constants'

/** How far round its parent a workflow's agent spawns from the run's one before it, radians */
export const WORKFLOW_STEP_ANGLE = 0.35

/** An agent_spawn's `workflow`, or undefined */
export function asWorkflow(v: unknown): WorkflowPlace | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { runId, index } = v as { runId?: unknown; index?: unknown }
  return typeof runId === 'string' && runId && typeof index === 'number' && Number.isInteger(index) && index >= 1
    ? { runId, index }
    : undefined
}

/** The agent of the same run, under the same parent, that the script started last before this one */
export function latestOfRun(agents: Iterable<Agent>, parentId: string, workflow: WorkflowPlace): Agent | undefined {
  let latest: Agent | undefined
  for (const a of agents) {
    if (a.parentId !== parentId || a.workflow?.runId !== workflow.runId || a.workflow.index >= workflow.index) continue
    if (!latest || a.workflow.index > latest.workflow!.index) latest = a
  }
  return latest
}

/** Each workflow run's visible agents under one parent, in the order its script started them: as
 *  they are laid out, beside their parent */
export function workflowRuns(agents: Iterable<Agent>): Agent[][] {
  const runs = new Map<string, Agent[]>()
  for (const a of agents) {
    if (!a.workflow || a.opacity < MIN_VISIBLE_OPACITY) continue
    const key = `${a.parentId ?? ''}\0${a.workflow.runId}`
    const run = runs.get(key)
    if (run) run.push(a)
    else runs.set(key, [a])
  }
  return [...runs.values()].map(run => run.sort((a, b) => a.workflow!.index - b.workflow!.index))
}
