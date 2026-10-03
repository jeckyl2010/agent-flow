import { Agent, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { MODEL_TAG, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { EFFORT_LEVELS, effortColor, effortLevel } from '@/lib/effort'
import { alphaHex, formatModelName } from '@/lib/utils'
import { drawHexagon } from './draw-misc'

const GLYPHS = '▓▒░<>/\\#*+=01'

/**
 * The text of a tag mid-decode: characters resolve left to right from what it read before,
 * through flickering glyphs, to what it reads now.
 */
export function decodeText(target: string, from: string, progress: number, time: number): string {
  if (progress >= 1) return target
  const len = Math.max(target.length, from.length)
  let out = ''
  for (let i = 0; i < len; i++) {
    const start = (i / len) * MODEL_TAG.decodeSpread
    if (progress >= start + MODEL_TAG.decodeWindow) {
      out += target[i] ?? ''
    } else if (progress >= start) {
      out += target[i] === ' ' ? ' ' : GLYPHS[(Math.floor(time * MODEL_TAG.flickerHz) * 7 + i * 13) % GLYPHS.length]
    } else {
      out += from[i] ?? ' '
    }
  }
  return out.trimEnd()
}

/**
 * Under each agent the bridge mod measured: the model and effort its latest request ran with, as
 * a holographic chip with one hex pip per effort level. A change decodes into place with a sweep
 * across the chip and a hexagonal shockwave from the node.
 */
export function drawModelTags(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  simTime: number,
) {
  for (const agent of agents.values()) {
    const tag = agent.modelTag
    // Drawn on a completed agent too, fading with its node: a short-lived subagent still shows
    // what it ran on
    if (!tag || agent.opacity < MIN_VISIBLE_OPACITY) continue

    const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const age = simTime - tag.changedAt
    const decode = Math.min(1, Math.max(0, age / MODEL_TAG.decodeS))
    const color = effortColor(tag.effort)
    const level = effortLevel(tag.effort)

    // Shockwave on a change (not when the tag first appears)
    if (tag.previousLabel && age >= 0 && age < MODEL_TAG.shockS) {
      drawShockwave(ctx, agent, r, age / MODEL_TAG.shockS, color)
    }

    const name = formatModelName(tag.model).toUpperCase()
    const label = level || !tag.effort ? name : `${name} · ${tag.effort.toUpperCase()}`
    const fromName = tag.previousLabel?.split(' · ')[0] ?? ''
    const text = decodeText(label, fromName, decode, simTime)

    ctx.save()
    ctx.globalAlpha = agent.opacity * Math.min(1, age / MODEL_TAG.fadeInS + 0.25)
    ctx.font = `${MODEL_TAG.fontSize}px monospace`
    const textW = ctx.measureText(label).width
    const pipsW = level ? EFFORT_LEVELS.length * MODEL_TAG.pipSpacing + MODEL_TAG.pipGap : 0
    // The share of the latest request's input the prompt cache served, as the cache ring shows it
    const hit = agent.spend?.lastCacheHit
    const cacheText = hit !== undefined ? `${Math.round(hit * 100)}%` : ''
    const cacheW = cacheText ? ctx.measureText(cacheText).width + MODEL_TAG.cacheGap : 0
    const chipW = textW + pipsW + cacheW + MODEL_TAG.padX * 2
    const chipH = MODEL_TAG.height
    const chipX = agent.x - chipW / 2
    const chipY = agent.y + r + (agent.tokensUsed > 0 ? MODEL_TAG.yOffsetBelowBar : MODEL_TAG.yOffset)

    // Chip
    ctx.beginPath()
    ctx.roundRect(chipX, chipY, chipW, chipH, MODEL_TAG.radius)
    ctx.fillStyle = COLORS.cardBgDark
    ctx.fill()
    ctx.strokeStyle = color + alphaHex(0.35)
    ctx.lineWidth = 0.6
    ctx.stroke()

    // Text
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = decode < 1 ? COLORS.holoHot : COLORS.textPrimary
    ctx.fillText(text, chipX + MODEL_TAG.padX, chipY + chipH / 2 + 0.5)

    // Effort pips: one hex per level, lit up to this one
    if (level) {
      const pipY = chipY + chipH / 2
      const firstX = chipX + MODEL_TAG.padX + textW + MODEL_TAG.pipGap + MODEL_TAG.pipRadius
      for (let i = 0; i < EFFORT_LEVELS.length; i++) {
        const x = firstX + i * MODEL_TAG.pipSpacing
        drawHexagon(ctx, x, pipY, MODEL_TAG.pipRadius)
        if (i < level) {
          // Lit pips light up one after another as the tag decodes
          const lit = Math.min(1, Math.max(0, decode * EFFORT_LEVELS.length - i))
          ctx.fillStyle = color + alphaHex(0.25 + 0.75 * lit)
          ctx.shadowColor = color
          ctx.shadowBlur = 4 * lit
          ctx.fill()
          ctx.shadowBlur = 0
        } else {
          ctx.strokeStyle = COLORS.holoBase + alphaHex(0.25)
          ctx.lineWidth = 0.5
          ctx.stroke()
        }
      }
    }

    if (cacheText) {
      ctx.textAlign = 'right'
      ctx.fillStyle = COLORS.complete + alphaHex(0.8)
      ctx.fillText(cacheText, chipX + chipW - MODEL_TAG.padX, chipY + chipH / 2 + 0.5)
    }

    // A bright sweep crosses the chip while it decodes
    if (decode < 1) {
      const sweepX = chipX + decode * chipW
      const grad = ctx.createLinearGradient(sweepX - 8, 0, sweepX + 2, 0)
      grad.addColorStop(0, color + '00')
      grad.addColorStop(1, color + alphaHex(0.8))
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(chipX, chipY, chipW, chipH, MODEL_TAG.radius)
      ctx.clip()
      ctx.fillStyle = grad
      ctx.fillRect(sweepX - 8, chipY, 10, chipH)
      ctx.restore()
    }

    ctx.restore()
  }
}

/** A hexagonal ring expanding from the node, sparks thrown from its corners */
function drawShockwave(ctx: CanvasRenderingContext2D, agent: Agent, r: number, progress: number, color: string) {
  const eased = 1 - (1 - progress) ** 2
  const radius = r + 2 + eased * MODEL_TAG.shockTravel
  const alpha = agent.opacity * (1 - progress)

  ctx.save()
  ctx.globalAlpha = alpha
  drawHexagon(ctx, agent.x, agent.y, radius)
  ctx.strokeStyle = color
  ctx.lineWidth = 2.2 * (1 - progress) + 0.4
  ctx.shadowColor = color
  ctx.shadowBlur = 12 * (1 - progress)
  ctx.stroke()

  ctx.shadowBlur = 0
  ctx.fillStyle = color
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2
    const d = radius + eased * 10
    ctx.beginPath()
    ctx.arc(agent.x + Math.cos(angle) * d, agent.y + Math.sin(angle) * d, 1.6 * (1 - progress), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
