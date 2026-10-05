/**
 * The time horizon's disk, the session's timeline, through the painter: the past colored by what it
 * was doing, the future spiralling in to the horizon, matter falling along it, your prompts as
 * hexagons, now, the time labels, and the prompt cache in orbit. Hit tests for hovering it and its
 * hexagons. The same state and motion as the 2D disk; only the drawing differs.
 */
import { COLORS } from '@/lib/colors'
import { formatDuration, type TimeHorizon, type TimeKind } from '@/lib/time-horizon'
import {
  HOLE_R, KIND_COLOR, MATTER, R_IN, R_OUT, SAMPLES, U_NOW, spiral,
  type Hover, type Mote, type SceneInput, type View,
} from '../shared'
import type { Painter } from '../../gl/painter'

/** Whether each of the disk's samples is on its near half, in front of the hole: fixed by the spiral */
const NEAR = Array.from({ length: SAMPLES + 1 }, (_, i) => Math.sin(spiral(i / SAMPLES).theta) > 0)

export function createDisk(v: View, wake: (ms: number) => void) {
  const motes: Mote[] = Array.from({ length: MATTER }, () => ({
    u: Math.random(), offset: (Math.random() - 0.5) * 16, size: Math.random() * 1.6 + 0.5,
  }))
  /** The cache ship's recent positions: its trail */
  const trail: Array<[number, number]> = []
  let hovered: Hover | undefined
  /** Prompt hexagons as last drawn, for hit testing, and the one lit by the pointer, by turn start:
   *  list positions shift when the event log drops its oldest events */
  let hexes: Array<{ start: number; x: number; y: number }> = []
  let litHex: number | undefined
  /** When each turn's hexagon first appeared while the view was open, by turn start: it pops in */
  const poppedAt = new Map<number, number>()
  let seenStarts: Set<number> | undefined
  /** The disk's beaming at each sample: fixed by the spiral */
  const beam = Array.from({ length: SAMPLES + 1 }, (_, i) => v.beaming(spiral(i / SAMPLES).theta))

  function kindAt(h: TimeHorizon, u: number): TimeKind {
    const t = v.timeAtU(h, u)
    const segs = h.segments
    let lo = 0, hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].start <= t) lo = mid
      else hi = mid - 1
    }
    return segs[lo]?.kind ?? 'waiting'
  }

  /**
   * One run of the disk's samples, from i0 to i1, on one half: a continuous strip, so the ribbon
   * has no joints to bead where its pieces overlap
   */
  function ribbon(p: Painter, i0: number, i1: number, width: number, color: string, alphaAt: (i: number) => number) {
    p.path()
    for (let i = i0; i <= i1; i++) p.to(v.projected[i][0], v.projected[i][1], width, color, alphaAt(i))
    p.stroke(true)
  }

  /** Calls `run` for each stretch of samples from i0 to i1 on the given half, and passing `keep` */
  function runs(i0: number, i1: number, front: boolean, run: (a: number, b: number) => void, keep?: (i: number) => boolean) {
    let a = -1
    for (let i = i0; i < i1; i++) {
      const ok = NEAR[i] === front && (!keep || keep(i))
      if (ok && a < 0) a = i
      if (!ok && a >= 0) { run(a, i); a = -1 }
    }
    if (a >= 0) run(a, i1)
  }

  /** The timeline ribbon: only the half behind the hole, or only the half in front of it */
  function drawDisk(p: Painter, h: TimeHorizon, front: boolean) {
    const iNow = Math.round(U_NOW * SAMPLES)
    for (const seg of h.segments) {
      const u0 = v.pastU(h, seg.start)
      const u1 = v.pastU(h, seg.end)
      const i0 = Math.max(0, Math.floor(u0 * SAMPLES)), i1 = Math.min(iNow, Math.ceil(u1 * SAMPLES))
      if (i1 <= i0) continue
      const color = KIND_COLOR[seg.kind]
      const isWaiting = seg.kind === 'waiting'
      const lift = hovered && hovered.start === seg.start ? 1.6 : 1
      const glowA = (isWaiting ? 0.035 : 0.075) * lift, coreA = (isWaiting ? 0.22 : 0.42) * lift
      // Wide soft glow, then a hot core
      runs(i0, i1, front, (a, b) => {
        ribbon(p, a, b, (isWaiting ? 7 : 13) * v.scale, color, i => glowA * beam[Math.min(i, b - 1)])
        ribbon(p, a, b, (isWaiting ? 1.2 : 2.6) * v.scale, color, i => coreA * beam[Math.min(i, b - 1)])
      })
    }
  }

  /**
   * The time to come: a dashed path from now into the horizon, flowing inward, reaching it when
   * the context window fills. While the context isn't growing it fades out a little way in
   */
  function drawFuture(p: Painter, input: SceneInput, now: number, front: boolean) {
    const iNow = Math.round(U_NOW * SAMPLES)
    const iEnd = input.consumption ? SAMPLES : Math.round((U_NOW + 0.12) * SAMPLES)
    const flow = v.reducedMotion ? 0 : now * 0.012
    const fadeAt = (i: number) => {
      const along = (i - iNow) / (iEnd - iNow)
      return input.consumption ? 0.55 + 0.45 * along : 1 - along
    }
    // Dashes, drifting inward over time
    runs(iNow, iEnd, front, (a, b) => {
      ribbon(p, a, b, 1.6 * v.scale, COLORS.horizonHot, i => 0.32 * beam[Math.min(i, b - 1)] * fadeAt(Math.min(i, b - 1)))
    }, i => Math.floor((i - flow) / 7) % 2 === 0)
  }

  /** Matter falling along the disk, quicker as it nears the horizon */
  function drawMatter(p: Painter, h: TimeHorizon, dt: number, front: boolean) {
    for (const m of motes) {
      if (front && !v.reducedMotion) {
        m.u += dt * 0.000018 * (1 + 4 * m.u * m.u)
        if (m.u >= 1) { m.u = 0; m.offset = (Math.random() - 0.5) * 16 }
      }
      const { theta, r } = spiral(m.u)
      if ((Math.sin(theta) > 0) !== front) continue
      const [x, y] = v.project(r + m.offset, theta)
      const fade = Math.min(1, m.u * 20) * Math.min(1, (1 - m.u) * 12)
      // The past carries its colors; what's still to come is pale
      const kind = m.u > U_NOW ? undefined : kindAt(h, m.u)
      const size = m.size * v.scale * (1 + m.u * 0.8)
      if (kind) p.disc(x, y, size, KIND_COLOR[kind], Math.min(1, (kind === 'waiting' ? 0.3 : 0.65) * v.beaming(theta) * fade), true)
      else p.disc(x, y, size, COLORS.horizonHot, Math.min(1, 0.22 * v.beaming(theta) * fade), true)
    }
  }

  const hexPts = new Float32Array(12)
  function hexPoints(x: number, y: number, size: number, rotation = 0): Float32Array {
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i - Math.PI / 2 + rotation
      hexPts[2 * i] = x + size * Math.cos(ang)
      hexPts[2 * i + 1] = y + size * Math.sin(ang)
    }
    return hexPts
  }
  function hexStroke(p: Painter, x: number, y: number, size: number, rotation: number, width: number, color: string, alpha: number) {
    const pts = hexPoints(x, y, size, rotation)
    p.path()
    for (let i = 0; i < 6; i++) p.to(pts[2 * i], pts[2 * i + 1], width, color, alpha)
    p.stroke(false, true)
  }

  /** A span at a glance: 12m, 3.5h, 2.1d */
  const span = (t: number) => (t < 3600 ? `${Math.round(t / 60)}m` : t < 86400 ? `${+(t / 3600).toFixed(1)}h` : `${+(t / 86400).toFixed(1)}d`)
  const tickStep = (total: number) => [60, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400].find(s => total / s <= 6) ?? 172800
  const labelSize = () => Math.max(9, 10 * v.scale)

  /**
   * A hexagon where each of your prompts started a turn, spinning as fast as the work it set off:
   * a quick question turns lazily, a long run of tools spins hard. A new one pops in with a
   * shockwave; the turn still running glows. Then the time, back to the rim and on to the horizon
   */
  function drawMarkers(p: Painter, input: SceneInput, now: number) {
    const h = input.horizon
    // Turns there when the view opened are just there; ones that arrive after pop in
    const opening = seenStarts === undefined
    seenStarts ??= new Set()
    for (const turn of h.turnLog) {
      if (seenStarts.has(turn.start)) continue
      seenStarts.add(turn.start)
      if (!opening) { poppedAt.set(turn.start, now); wake(1500) }
    }

    hexes = []
    for (const turn of h.turnLog) {
      const { theta, r } = spiral(v.pastU(h, turn.start))
      const [x, y] = v.project(r, theta)
      hexes.push({ start: turn.start, x, y })
      const intensity = Math.min(1, Math.log10(1 + turn.work) / Math.log10(1 + 1800))
      const spin = v.reducedMotion ? 0 : now * (0.0002 + 0.004 * intensity)
      const poppedFrom = poppedAt.get(turn.start)
      const pop = poppedFrom !== undefined ? Math.max(0, 1 - (now - poppedFrom) / 900) : 0
      const running = turn.end === undefined
      const lit = litHex === turn.start
      const size = (6 + intensity * 3 + pop * 8 + (lit ? 2 : 0)) * v.scale
      if (pop > 0) hexStroke(p, x, y, size + (1 - pop) * 40 * v.scale, spin, 1.5, COLORS.holoBright, pop * 0.8)
      if (running && !v.reducedMotion) {
        const pulse = (now % 1800) / 1800
        hexStroke(p, x, y, size + pulse * 14 * v.scale, spin, 1, COLORS.holoBright, 0.5 * (1 - pulse))
      }
      p.fill(hexPoints(x, y, size, spin), COLORS.void, 0xd0 / 255, false)
      // The glow: the edge drawn wide and faint under the line
      const glow = lit || running ? 1 : intensity * 0.4
      if (glow > 0.05) {
        hexStroke(p, x, y, size, spin, 9 * glow, COLORS.holoBright, 0.1 * glow)
        hexStroke(p, x, y, size, spin, 4.5 * glow, COLORS.holoBright, 0.2 * glow)
      }
      hexStroke(p, x, y, size, spin, lit ? 2 : 1.4, lit ? COLORS.holoHot : COLORS.holoBright, 1)
      // The work inside: a core that fills with it
      if (intensity > 0) p.fill(hexPoints(x, y, size * 0.45 * intensity, -spin * 1.5), COLORS.holoBright, Math.min(1, 0.35 + 0.5 * intensity), false)
    }

    const size = labelSize()
    // Back toward the rim: how long ago
    const back = tickStep(h.elapsed)
    for (let t = back; t < h.elapsed - back * 0.3; t += back) {
      const { theta, r } = spiral(v.pastU(h, h.start + h.elapsed - t))
      if (Math.sin(theta) < 0.2) continue
      const [x, y] = v.project(r + 26, theta)
      p.text(`T−${span(t)}`, x, y, size, false, 'center', COLORS.textDim)
    }
    // On toward the horizon: how long until
    const c = input.consumption
    if (c && c.eta > 0) {
      const ahead = tickStep(c.eta)
      for (let t = ahead; t < c.eta - ahead * 0.3; t += ahead) {
        const { theta, r } = spiral(U_NOW + (1 - U_NOW) * (t / c.eta))
        if (Math.sin(theta) < 0.2) continue
        const [x, y] = v.project(r + 22, theta)
        p.text(`T+${span(t)}`, x, y, size, false, 'center', COLORS.horizonLight + 'aa')
      }
    }
  }

  function drawNow(p: Painter, input: SceneInput, now: number) {
    const { theta, r } = spiral(U_NOW)
    const [x, y] = v.project(r, theta)
    const pulse = v.reducedMotion ? 0.5 : (now % 2600) / 2600
    // A hexagonal shockwave, every few seconds
    if (!v.reducedMotion) hexStroke(p, x, y, (8 + pulse * 46) * v.scale, 0, 1.5, COLORS.horizonHot, 0.7 * (1 - pulse))
    glowAt(p, x, y, COLORS.horizonHot, 7 * v.scale + 14)
    p.fill(hexPoints(x, y, 7 * v.scale), COLORS.horizonHot, 1, false)
    const size = labelSize()
    p.text('NOW · T+0', x + 12 * v.scale, y + 4, size, true, 'left', COLORS.horizonHot)

    const start = spiral(0)
    const [sx, sy] = v.project(start.r, start.theta)
    p.text(`T−${formatDuration(input.horizon.elapsed)} · START`, sx, sy - 14 * v.scale, size, true, 'center', COLORS.textDim)

    // Where the future meets the horizon: the context full, the session's detail gone
    const c = input.consumption
    if (c) {
      const end = spiral(1)
      const [ex, ey] = v.project(end.r, end.theta)
      glowAt(p, ex, ey, COLORS.timePermission, 3 * v.scale + 8)
      p.disc(ex, ey, 3 * v.scale, COLORS.timePermission, 1, false)
      p.text(`T+${span(c.eta)} · CONTEXT FULL`, ex + 10 * v.scale, ey - 8 * v.scale, size, false, 'left', COLORS.timePermission)
    } else {
      const fade = spiral(U_NOW + 0.12)
      const [fx, fy] = v.project(fade.r + 22, fade.theta)
      p.text('CONTEXT STEADY · NO INSPIRAL', fx, fy, size, false, 'center', COLORS.textMuted)
    }
  }

  const ship = new Float32Array(8)
  /** The prompt cache in orbit: its orbit decays toward the horizon as the cache ages */
  function drawCache(p: Painter, input: SceneInput, now: number) {
    if (input.cacheFraction === undefined) return
    const warm = input.cacheWarm
    const r = warm ? R_IN + 24 + input.cacheFraction * (R_OUT - R_IN - 24) : HOLE_R * 1.18
    const theta = (v.reducedMotion ? 1 : now / 1000) * (2 * Math.PI / (warm ? 34 : 8))
    const color = warm ? COLORS.horizonHot : COLORS.timePermission

    // The orbit, dotted: dashes of 2 and gaps of 7, measured along it
    const dash = 2 * v.scale, gap = 7 * v.scale
    let [lx, ly] = v.project(r, 0)
    let along = 0
    for (let i = 1; i <= 120; i++) {
      const [x, y] = v.project(r, (i / 120) * Math.PI * 2)
      const len = Math.hypot(x - lx, y - ly)
      // Each dash that starts within this piece of the orbit
      let s = Math.ceil(along / (dash + gap)) * (dash + gap) - along
      while (s < len) {
        const e = Math.min(len, s + dash)
        const f0 = s / len, f1 = e / len
        p.line(lx + (x - lx) * f0, ly + (y - ly) * f0, lx + (x - lx) * f1, ly + (y - ly) * f1, 1, color, 0x38 / 255, false)
        s += dash + gap
      }
      along += len
      lx = x; ly = y
    }

    const [x, y] = v.project(r, theta)
    trail.push([x, y])
    if (trail.length > 40) trail.shift()
    if (trail.length > 1) {
      p.path()
      for (let i = 0; i < trail.length; i++) {
        const f = Math.max(1, i) / trail.length
        p.to(trail[i][0], trail[i][1], f * 3 * v.scale, color, f * 0.5)
      }
      p.stroke(true)
    }
    const [px, py] = trail.length > 1 ? trail[trail.length - 2] : [x - 1, y]
    const heading = Math.atan2(y - py, x - px)
    glowAt(p, x, y, color, 8 * v.scale + 12)
    const cos = Math.cos(heading), sin = Math.sin(heading), s = v.scale
    const put = (k: number, lx: number, ly: number) => { ship[2 * k] = x + lx * cos - ly * sin; ship[2 * k + 1] = y + lx * sin + ly * cos }
    put(0, 8 * s, 0); put(1, -5 * s, -4.5 * s); put(2, -2 * s, 0); put(3, -5 * s, 4.5 * s)
    p.fill(ship, color, 1, false)
    p.text(input.cacheLabel, x + 12 * v.scale, y + 16 * v.scale, labelSize(), false, 'left', color)
  }

  function hexAt(x: number, y: number): { start: number; x: number; y: number } | undefined {
    let best: { start: number; x: number; y: number } | undefined, bestD = (12 * v.scale) ** 2
    for (const hx of hexes) {
      const d = (hx.x - x) ** 2 + (hx.y - y) ** 2
      if (d < bestD) { bestD = d; best = hx }
    }
    return best
  }

  function hoverHex(start: number | undefined) { litHex = start }

  function hit(x: number, y: number, input: SceneInput): Hover | undefined {
    const h = input.horizon
    if (h.elapsed <= 0) return (hovered = undefined)
    let best = -1, bestD = (14 * v.scale) ** 2
    const overHole = Math.hypot(x - v.cx, y - v.cy) < HOLE_R * v.scale
    // Only the past can be hovered: the future is still to come
    const iNow = Math.round(U_NOW * SAMPLES)
    for (let i = 0; i <= iNow; i++) {
      // The far side of the disk is hidden where the hole covers it
      if (overHole && !NEAR[i]) continue
      const dx = v.projected[i][0] - x, dy = v.projected[i][1] - y
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0) return (hovered = undefined)
    const t = v.timeAtU(h, best / SAMPLES)
    const seg = h.segments.find(s => s.start <= t && t <= s.end)
    hovered = seg && { kind: seg.kind, start: seg.start, end: seg.end, x: v.projected[best][0], y: v.projected[best][1] }
    return hovered
  }

  return { drawDisk, drawFuture, drawMatter, drawMarkers, drawNow, drawCache, hexAt, hoverHex, hit }
}

/** A soft glow around a point, as the 2D scene's cached sprite: 0x66 at its center to nothing at its edge */
export function glowAt(p: Painter, x: number, y: number, color: string, radius: number): void {
  p.glow(x, y, Math.ceil(radius), color, 0x66 / 255, false)
}
