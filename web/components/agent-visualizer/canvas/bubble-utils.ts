import type { MessageBubble } from '@/lib/agent-types'
import { BUBBLE_FADE_IN, BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_TYPE_S } from '@/lib/canvas-constants'

/**
 * Compute the effective alpha for a message bubble given its age,
 * agent opacity, and whether it is a thinking bubble.
 *
 * Returns 0 when the bubble should be skipped entirely.
 */
export function bubbleAlpha(age: number, agentOpacity: number): number {
  if (age > BUBBLE_HOLD + BUBBLE_FADE_OUT) return 0

  let alpha: number
  if (age < BUBBLE_FADE_IN) {
    alpha = age / BUBBLE_FADE_IN
  } else if (age < BUBBLE_HOLD) {
    alpha = 1
  } else {
    alpha = 1 - (age - BUBBLE_HOLD) / BUBBLE_FADE_OUT
  }

  alpha = Math.max(0, Math.min(1, alpha)) * agentOpacity * 0.9
  return alpha
}

/**
 * How many characters of a streamed bubble show at `time`: typing from what showed when its
 * latest text arrived to the whole of it over BUBBLE_TYPE_S, about as long as the mod waits
 * between sends, so the text keeps moving rather than jumping.
 */
export function revealedChars(
  bubble: Pick<MessageBubble, 'text' | 'revealFrom' | 'revealAt'>,
  time: number,
): number {
  const { text, revealFrom, revealAt } = bubble
  if (revealFrom === undefined || revealAt === undefined) return text.length
  const progress = Math.min(1, Math.max(0, (time - revealAt) / BUBBLE_TYPE_S))
  return Math.min(text.length, Math.round(revealFrom + (text.length - revealFrom) * progress))
}
