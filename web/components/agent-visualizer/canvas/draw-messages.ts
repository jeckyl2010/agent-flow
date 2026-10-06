import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { alphaHex } from '@/lib/utils'
import { truncateText } from './draw-misc'

/** Seconds a message takes to cross, and to fade once it arrived */
const TRAVEL_S = 1.4
const LINGER_S = 0.8
/** How far the arc bows out, as a share of the distance */
const BOW = 0.22
const TRAIL = 6
const LABEL_MAX_W = 120

const a = (alpha: number) => alphaHex(Math.max(0, Math.min(1, alpha)))
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)

/** Whether a message is in flight now: the canvas keeps drawing at full rate while one is */
export function isMessageInFlight(agents: Map<string, Agent>, simTime: number): boolean {
  for (const agent of agents.values()) {
    for (const m of agent.sentMessages ?? []) if (simTime - m.time < TRAVEL_S + LINGER_S) return true
  }
  return false
}

/**
 * Messages agents send each other (SendMessage): a bowed arc from the sender to the recipient,
 * along which the message travels with a trail and a few words of it, ringing the recipient as it
 * arrives.
 */
export function drawAgentMessages(ctx: CanvasRenderingContext2D, agents: Map<string, Agent>, simTime: number) {
  for (const from of agents.values()) {
    if (!from.sentMessages || from.opacity < MIN_VISIBLE_OPACITY) continue
    for (const m of from.sentMessages) {
      const age = simTime - m.time
      if (age < 0 || age >= TRAVEL_S + LINGER_S) continue
      const to = agents.get(m.to)
      if (!to || to.opacity < MIN_VISIBLE_OPACITY) continue

      const dx = to.x - from.x, dy = to.y - from.y
      const cx = (from.x + to.x) / 2 - dy * BOW, cy = (from.y + to.y) / 2 + dx * BOW
      const at = (q: number) => {
        const u = 1 - q
        return [u * u * from.x + 2 * u * q * cx + q * q * to.x, u * u * from.y + 2 * u * q * cy + q * q * to.y] as const
      }
      const p = Math.min(1, age / TRAVEL_S)
      const fade = age > TRAVEL_S ? 1 - (age - TRAVEL_S) / LINGER_S : 1

      ctx.save()
      // The arc, faint
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.quadraticCurveTo(cx, cy, to.x, to.y)
      ctx.strokeStyle = COLORS.dispatch + a(0.22 * fade)
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      ctx.stroke()
      ctx.setLineDash([])

      // The message and its trail
      const q = easeInOut(p)
      for (let i = TRAIL; i >= 0; i--) {
        const [px, py] = at(Math.max(0, q - i * 0.025))
        ctx.beginPath()
        ctx.arc(px, py, i === 0 ? 3.2 : 2.2 * (1 - i / (TRAIL + 1)), 0, Math.PI * 2)
        ctx.fillStyle = (i === 0 ? COLORS.holoHot : COLORS.dispatch) + a(fade * (i === 0 ? 1 : 0.6 * (1 - i / (TRAIL + 1))))
        if (i === 0) { ctx.shadowColor = COLORS.dispatch; ctx.shadowBlur = 10 }
        ctx.fill()
        ctx.shadowBlur = 0
      }

      // A few of its words, beside it
      if (m.text) {
        const [px, py] = at(q)
        ctx.font = '7px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = COLORS.dispatch + a(0.9 * fade)
        ctx.fillText(truncateText(ctx, `✉ ${m.text.replace(/\s+/g, ' ')}`, LABEL_MAX_W), px, py - 6)
      }

      // It arrives
      if (age > TRAVEL_S) {
        const r = age - TRAVEL_S
        ctx.beginPath()
        ctx.arc(to.x, to.y, 24 + r * 30, 0, Math.PI * 2)
        ctx.strokeStyle = COLORS.dispatch + a(fade * 0.7)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      ctx.restore()
    }
  }
}
