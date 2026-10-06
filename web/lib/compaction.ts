/**
 * Context compactions, as the canvas draws them (a wormhole) and the wormhole log lists them.
 */
import type { Compaction } from './agent-types'
import { WORMHOLE } from './canvas-constants'
import { formatCount } from './utils'

/** `967k → 13k` */
export function compactionLabel(c: Pick<Compaction, 'tokensBefore' | 'tokensAfter'>): string {
  if (c.tokensBefore === undefined || c.tokensAfter === undefined) return 'compacted'
  return `${formatCount(c.tokensBefore)} → ${formatCount(c.tokensAfter)}`
}

/** The share of the context a compaction let go, 0 to 1; undefined without both counts */
export function compactionDrop(c: Pick<Compaction, 'tokensBefore' | 'tokensAfter'>): number | undefined {
  if (!c.tokensBefore || c.tokensAfter === undefined) return undefined
  return Math.max(0, 1 - c.tokensAfter / c.tokensBefore)
}

/** Where a compaction's wormhole is at `simTime`: how open its throat is (0 to 1), the seconds since
 *  it began, and once it jumped, the seconds since. Undefined while nothing of it is drawn */
export interface WormholeFrame {
  open: number
  t: number
  jump?: number
}

const easeOut = (x: number) => 1 - (1 - x) ** 3

export function wormholeFrame(c: Compaction, simTime: number): WormholeFrame | undefined {
  if (c.isHistory) return undefined
  if (c.phase === 'running') {
    const t = simTime - c.startTime
    return t < 0 ? undefined : { open: easeOut(Math.min(1, t / WORMHOLE.open)), t }
  }
  const end = c.endTime ?? c.startTime
  const since = simTime - end
  if (c.phase === 'skipped') {
    return since < 0 || since >= WORMHOLE.close ? undefined : { open: 1 - since / WORMHOLE.close, t: simTime - c.startTime }
  }
  // Seen only once it ended (a transcript records no start): it opens, then jumps
  const preRoll = end - c.startTime < WORMHOLE.open ? WORMHOLE.open : 0
  if (since < 0 || since >= preRoll + WORMHOLE.jump) return undefined
  if (since < preRoll) return { open: easeOut(since / WORMHOLE.open), t: since }
  return { open: 1, t: simTime - c.startTime + preRoll, jump: since - preRoll }
}

const optNumber = (v: unknown) => (typeof v === 'number' ? v : undefined)
const optString = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/**
 * A `context_compaction` event folded into an agent's compactions: a start opens one; an end, or a
 * skip, closes the one running; an end with none running (a transcript records only its end) is
 * one of its own. Undefined when it changes nothing (a start reported twice, a stray skip).
 */
export function foldCompaction(list: readonly Compaction[], payload: Record<string, unknown>, time: number): Compaction[] | undefined {
  const phase = optString(payload.phase) ?? 'end'
  const runningAt = list.findLastIndex(c => c.phase === 'running')
  const fields: Partial<Compaction> = {
    trigger: optString(payload.trigger),
    tokensBefore: optNumber(payload.tokensBefore),
    tokensAfter: optNumber(payload.tokensAfter),
    durationMs: optNumber(payload.durationMs),
    reason: optString(payload.reason),
  }
  const known = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))

  if (phase === 'start') {
    return runningAt === -1 ? [...list, { phase: 'running', startTime: time, trigger: fields.trigger, at: optString(payload.at) }] : undefined
  }
  if (runningAt !== -1) {
    const next = [...list]
    next[runningAt] = { ...list[runningAt], ...known, phase: phase === 'skipped' ? 'skipped' : 'done', endTime: time }
    return next
  }
  if (phase !== 'end') return undefined
  return [...list, { ...known, phase: 'done', startTime: time, endTime: time, at: optString(payload.at), ...(payload.isHistory === true ? { isHistory: true } : {}) }]
}
