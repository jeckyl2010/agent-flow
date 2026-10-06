import { Agent, NODE, type Compaction } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { WORMHOLE as W, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { compactionDrop, compactionLabel, wormholeFrame, type WormholeFrame } from '@/lib/compaction'
import { alphaHex } from '@/lib/utils'
import { drawHexagon } from './draw-misc'

const TAU = Math.PI * 2
const a = (alpha: number) => alphaHex(Math.max(0, Math.min(1, alpha)))
const easeOut = (x: number) => 1 - (1 - x) ** 3
const easeIn = (x: number) => x * x * x
/** A fixed fraction per index, so each fragment keeps its own lane frame to frame */
const lane = (n: number, salt: number) => {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** The latest compaction of each agent that is drawn now, with where it is */
function* wormholes(agents: Map<string, Agent>, simTime: number): Generator<[Agent, Compaction, WormholeFrame]> {
  for (const agent of agents.values()) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const latest = agent.compactions?.at(-1)
    const frame = latest && wormholeFrame(latest, simTime)
    if (frame) yield [agent, latest, frame]
  }
}

/** Whether a wormhole is drawn now: the canvas keeps drawing at full rate while one is */
export function isWormholeOpen(agents: Map<string, Agent>, simTime: number): boolean {
  return !wormholes(agents, simTime).next().done
}

/**
 * Beneath the nodes: a compaction's wormhole while it is open. The throat darkens around the
 * agent's node, ringed by its lensed light; the conversation spirals in along its arms, fragments
 * of it falling in, and arcs of starlight bent round it. At the jump all of it is pulled in.
 */
export function drawWormholesBelow(ctx: CanvasRenderingContext2D, agents: Map<string, Agent>, simTime: number) {
  for (const [agent, , frame] of wormholes(agents, simTime)) {
    const collapse = frame.jump === undefined ? 0 : Math.min(1, frame.jump / (W.jump * W.collapse))
    if (collapse >= 1) continue
    const scale = frame.open * (1 - easeIn(collapse))
    if (scale <= 0.01) continue
    const nodeR = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    // Pulled in faster as it collapses
    const t = frame.t + collapse * 1.5
    const throatR = nodeR * W.throat * (0.55 + 0.45 * scale)
    const reach = nodeR * W.reach * scale
    const { x, y } = agent
    const fade = agent.opacity

    ctx.save()

    // The glow it bends round itself
    const glow = ctx.createRadialGradient(x, y, throatR * 0.8, x, y, reach * 1.15)
    glow.addColorStop(0, COLORS.wormholeGlow + a(0.34 * scale * fade))
    glow.addColorStop(0.45, COLORS.wormholeGlow + a(0.1 * scale * fade))
    glow.addColorStop(1, COLORS.wormholeGlow + '00')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y, reach * 1.15, 0, TAU)
    ctx.fill()

    // The spiral arms: light flowing inward along a logarithmic spiral, brighter near the throat
    const flow = t * 2.2
    for (let arm = 0; arm < W.arms; arm++) {
      const base = (arm / W.arms) * TAU + t * W.spin * TAU
      for (let j = 0; j < W.armDots; j++) {
        const u = ((j + flow) % W.armDots) / W.armDots // 0 at the rim of its reach, 1 at the throat
        const r = reach * (throatR / reach) ** u
        const angle = base + W.winding * Math.log(reach / r)
        const alpha = scale * fade * (0.12 + 0.75 * u) * Math.min(1, u * 6)
        ctx.beginPath()
        ctx.arc(x + Math.cos(angle) * r, y + Math.sin(angle) * r, 0.6 + 1.5 * u, 0, TAU)
        ctx.fillStyle = (u > 0.62 ? COLORS.wormholeRim : COLORS.horizonLight) + a(alpha)
        ctx.fill()
      }
    }

    // Fragments of the conversation falling in, each streaking along its own lane
    ctx.lineCap = 'round'
    for (let n = 0; n < W.fragments; n++) {
      const p = (t / W.fallTime + lane(n, 1)) % 1
      const at = (q: number) => {
        const r = reach - (reach - throatR) * q ** 1.7
        const angle = lane(n, 2) * TAU + W.winding * Math.log(reach / r) + t * W.spin * TAU
        return [x + Math.cos(angle) * r, y + Math.sin(angle) * r] as const
      }
      const [hx, hy] = at(p)
      const [tx, ty] = at(Math.max(0, p - 0.07))
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.strokeStyle = (lane(n, 3) > 0.5 ? COLORS.horizonLight : COLORS.wormholeRim) + a(scale * fade * 0.85 * Math.min(1, p * 5) * (1 - p) ** 0.4)
      ctx.lineWidth = 0.6 + 1.1 * p
      ctx.stroke()
    }

    // The throat: dark, under the node
    const throat = ctx.createRadialGradient(x, y, 0, x, y, throatR)
    throat.addColorStop(0, COLORS.wormholeCore + a(0.96 * fade))
    throat.addColorStop(0.8, COLORS.wormholeCore + a(0.9 * fade * scale))
    throat.addColorStop(1, COLORS.wormholeGlow + a(0.35 * fade * scale))
    ctx.fillStyle = throat
    ctx.beginPath()
    ctx.arc(x, y, throatR, 0, TAU)
    ctx.fill()

    // Starlight lensed round it, in arcs that orbit faster than the arms
    for (let i = 0; i < W.arcs; i++) {
      const start = t * W.spin * TAU * 1.8 + (i / W.arcs) * TAU
      ctx.beginPath()
      ctx.arc(x, y, throatR * (1.14 + i * 0.09), start, start + 0.7 + 0.3 * i)
      ctx.strokeStyle = COLORS.horizonLight + a(0.65 * scale * fade)
      ctx.lineWidth = 1.4
      ctx.shadowColor = COLORS.horizonLight
      ctx.shadowBlur = 6
      ctx.stroke()
    }

    // The Einstein ring at its rim, and a fainter one breathing further out
    ctx.beginPath()
    ctx.arc(x, y, throatR, 0, TAU)
    ctx.strokeStyle = COLORS.wormholeRim + a(0.95 * scale * fade)
    ctx.lineWidth = 1.8
    ctx.shadowColor = COLORS.wormholeGlow
    ctx.shadowBlur = 14
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, throatR * 1.55 + Math.sin(t * 2.4) * 1.5, 0, TAU)
    ctx.strokeStyle = COLORS.wormholeRim + a(0.22 * scale * fade)
    ctx.lineWidth = 0.8
    ctx.shadowBlur = 0
    ctx.stroke()

    ctx.restore()
  }
}

/**
 * Above the nodes: the jump. A flash as the throat closes, a wave of space thrown outward, the node
 * echoed outward three times (the déjà vu), and what the compaction did, rising: `⟲ 967k → 13k`.
 */
export function drawWormholesAbove(ctx: CanvasRenderingContext2D, agents: Map<string, Agent>, simTime: number) {
  for (const [agent, compaction, frame] of wormholes(agents, simTime)) {
    if (frame.jump === undefined) continue
    const collapseS = W.jump * W.collapse
    const after = frame.jump - collapseS // seconds since the throat closed
    const nodeR = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const { x, y } = agent
    const fade = agent.opacity

    ctx.save()

    // The point it closes to, brightening
    if (after < 0) {
      const p = frame.jump / collapseS
      const r = nodeR * 0.25 + nodeR * 0.6 * easeIn(p)
      const point = ctx.createRadialGradient(x, y, 0, x, y, r)
      point.addColorStop(0, COLORS.holoHot + a(p * fade))
      point.addColorStop(1, COLORS.wormholeGlow + '00')
      ctx.fillStyle = point
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
      ctx.restore()
      continue
    }

    const span = W.jump - collapseS
    const s = after / span // 0 to 1 over the rest of the jump

    // The flash
    const flashS = W.jump * W.flash
    if (after < flashS) {
      const f = after / flashS
      const r = nodeR * (1.2 + 3.4 * easeOut(f))
      const flash = ctx.createRadialGradient(x, y, 0, x, y, r)
      flash.addColorStop(0, COLORS.holoHot + a((1 - f) * 0.95 * fade))
      flash.addColorStop(0.35, COLORS.wormholeRim + a((1 - f) * 0.55 * fade))
      flash.addColorStop(1, COLORS.wormholeGlow + '00')
      ctx.fillStyle = flash
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
    }

    // The wave thrown outward, and a gold one just behind it
    for (const [lag, color, width] of [[0, COLORS.wormholeGlow, 3.2], [0.06, COLORS.horizonLight, 1.4]] as const) {
      const w = s - lag
      if (w <= 0 || w >= 1) continue
      ctx.beginPath()
      ctx.arc(x, y, nodeR * (1 + W.shockTravel * easeOut(w)), 0, TAU)
      ctx.strokeStyle = color + a((1 - w) ** 1.5 * 0.85 * fade)
      ctx.lineWidth = width * (1 - w) + 0.3
      ctx.shadowColor = color
      ctx.shadowBlur = 10 * (1 - w)
      ctx.stroke()
    }
    ctx.shadowBlur = 0

    // Déjà vu: the node, echoed outward, each echo later, fainter and turned a little further
    const echoLife = 1.3
    for (let e = 1; e <= W.echoes; e++) {
      const te = (after - e * W.echoDelay) / echoLife
      if (te <= 0 || te >= 1) continue
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(e * 0.13 * easeOut(te))
      drawHexagon(ctx, 0, 0, nodeR * (1 + easeOut(te) * (0.7 + 0.45 * e)))
      ctx.strokeStyle = COLORS.wormholeRim + a((1 - te) * 0.6 * 0.7 ** (e - 1) * fade)
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }

    // What it did, rising and fading
    const fadeIn = Math.min(1, after / 0.25)
    const fadeOut = s > 0.7 ? 1 - (s - 0.7) / 0.3 : 1
    const alpha = fadeIn * fadeOut * fade
    if (alpha > 0.01) {
      const ly = y - nodeR * 1.7 - W.labelRise * easeOut(s)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = 'bold 10px monospace'
      ctx.shadowColor = COLORS.wormholeGlow
      ctx.shadowBlur = 8
      ctx.fillStyle = COLORS.wormholeRim + a(alpha)
      ctx.fillText(`⟲ ${compactionLabel(compaction)}`, x, ly)
      const drop = compactionDrop(compaction)
      ctx.font = '7px monospace'
      ctx.shadowBlur = 0
      ctx.fillStyle = COLORS.horizonLight + a(alpha * 0.85)
      ctx.fillText(drop === undefined ? 'context compacted' : `context −${Math.round(drop * 100)}%`, x, ly + 11)
    }

    ctx.restore()
  }
}
