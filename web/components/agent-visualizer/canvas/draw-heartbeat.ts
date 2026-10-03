import { Agent, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { HEARTBEAT, CACHE_RING, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { alphaHex } from '@/lib/utils'
import { effortLevel } from '@/lib/effort'
import { drawHexagon } from './draw-misc'

/** What a request's stop reason looks like: a tool call, a finished answer, or trouble */
export function stopReasonColor(stopReason: string): string {
  switch (stopReason) {
    case 'tool_use': return COLORS.tool
    case 'end_turn':
    case 'stop_sequence': return COLORS.complete
    case 'compaction': return COLORS.dispatch
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'refusal': return COLORS.error
    default: return COLORS.holoBase
  }
}

/** 0 to 1: how big a request's pulse is, by the tokens it wrote (log scale) */
function pulseSize(outputTokens: number): number {
  return Math.min(1, Math.log10(outputTokens + 1) / Math.log10(HEARTBEAT.fullOutputTokens))
}

/**
 * The heartbeat: each model request the API measured expands as a ring from the agent's node,
 * sized by what it wrote and colored by why it stopped. And the cache ring: a thin arc for the
 * share of the latest request's input the prompt cache served.
 */
export function drawHeartbeats(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  simTime: number,
) {
  for (const agent of agents.values()) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub

    if (agent.recentSteps) {
      for (const step of agent.recentSteps) {
        const size = pulseSize(step.outputTokens)
        const travel = HEARTBEAT.minTravel + size * (HEARTBEAT.maxTravel - HEARTBEAT.minTravel)
        const color = stopReasonColor(step.stopReason)
        // A hexagon like the node it leaves, echoed once per effort level above medium
        const echoes = Math.max(0, (effortLevel(step.effort) ?? 2) - 2)
        for (let echo = 0; echo <= echoes; echo++) {
          const progress = (simTime - step.time - echo * HEARTBEAT.echoDelay) / HEARTBEAT.duration
          if (progress < 0 || progress >= 1) continue
          const eased = 1 - (1 - progress) ** 3

          ctx.save()
          ctx.globalAlpha = agent.opacity * HEARTBEAT.maxAlpha * (1 - progress) * 0.55 ** echo
          drawHexagon(ctx, agent.x, agent.y, r + HEARTBEAT.startOffset + eased * travel)
          ctx.strokeStyle = color
          ctx.lineWidth = Math.max(0.5, HEARTBEAT.maxLineWidth * (0.4 + 0.6 * size) * (1 - progress))
          ctx.shadowColor = color
          ctx.shadowBlur = 8 * (1 - progress)
          ctx.stroke()
          ctx.restore()
        }
      }
    }

    const hit = agent.spend?.lastCacheHit
    if (hit !== undefined && agent.state !== 'complete') {
      const ringR = r + (agent.isMain ? CACHE_RING.offsetMain : CACHE_RING.offsetSub)
      const start = -Math.PI / 2
      ctx.save()
      ctx.globalAlpha = agent.opacity
      ctx.lineWidth = CACHE_RING.width
      ctx.beginPath()
      ctx.arc(agent.x, agent.y, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = COLORS.complete + alphaHex(0.12)
      ctx.stroke()
      if (hit > 0) {
        ctx.beginPath()
        ctx.arc(agent.x, agent.y, ringR, start, start + hit * Math.PI * 2)
        ctx.strokeStyle = COLORS.complete + alphaHex(0.7)
        ctx.stroke()
      }
      ctx.font = '6px monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = COLORS.complete + alphaHex(0.75)
      // Lower left of the ring: the cost pill sits above the node and bubbles to its right
      const labelAngle = CACHE_RING.labelAngle
      ctx.fillText(
        `${Math.round(hit * 100)}% cached`,
        agent.x + Math.cos(labelAngle) * (ringR + CACHE_RING.labelOffset),
        agent.y + Math.sin(labelAngle) * (ringR + CACHE_RING.labelOffset),
      )
      ctx.restore()
    }
  }
}
