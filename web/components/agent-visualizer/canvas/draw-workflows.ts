import { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { workflowRuns, workflowStatusLabel } from '@/lib/workflow'

/** Joins each workflow run's agents with a dashed line, in the order the script started them, so
 *  a run reads as one piece of work among the parent's other subagents */
export function drawWorkflowRuns(ctx: CanvasRenderingContext2D, agents: Map<string, Agent>) {
  for (const run of workflowRuns(agents.values())) {
    if (run.length < 2) continue
    // A stopped or failed run's line in the error color, a paused one's longer-dashed
    const status = workflowStatusLabel(run[0]!.workflow!.status)
    ctx.save()
    ctx.strokeStyle = status === 'stopped' || status === 'failed' ? COLORS.error + '50' : COLORS.holoBase + '40'
    ctx.lineWidth = 1
    ctx.setLineDash(status === 'paused' ? [6, 6] : [2, 6])
    for (let i = 1; i < run.length; i++) {
      const from = run[i - 1], to = run[i]
      ctx.globalAlpha = Math.min(from.opacity, to.opacity)
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.restore()
  }
}
