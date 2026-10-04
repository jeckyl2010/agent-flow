/**
 * The time horizon's disk, the session's timeline: the past colored by what it was doing, the
 * future spiralling in to the horizon, matter falling along it, your prompts as hexagons, now,
 * the time labels, and the prompt cache in orbit. Hit tests for hovering it and its hexagons.
 */
import { COLORS } from '@/lib/colors'
import { formatDuration, type TimeHorizon, type TimeKind } from '@/lib/time-horizon'
import {
  Batch, HOLE_R, KIND_COLOR, MATTER, R_IN, R_OUT, SAMPLES, U_NOW, hex, segment, spiral,
  type Hover, type Mote, type SceneInput, type View,
} from './shared'

export function createDisk(v: View) {
  const motes: Mote[] = Array.from({ length: MATTER }, () => ({
    u: Math.random(), offset: (Math.random() - 0.5) * 16, size: Math.random() * 1.6 + 0.5,
  }))
  /** The disk's hot cores, stroked after its glow */
  const cores = new Batch()
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

  /** The timeline ribbon: only the half behind the hole, or only the half in front of it */
  function drawDisk(ctx: CanvasRenderingContext2D, h: TimeHorizon, front: boolean) {
    ctx.globalCompositeOperation = 'lighter'
    // Butt caps: round ones overlap between the short segments and bead under additive light
    ctx.lineCap = 'butt'
    for (const seg of h.segments) {
      const u0 = v.pastU(h, seg.start)
      const u1 = v.pastU(h, seg.end)
      const i0 = Math.floor(u0 * SAMPLES), i1 = Math.min(Math.round(U_NOW * SAMPLES), Math.ceil(u1 * SAMPLES))
      const color = KIND_COLOR[seg.kind]
      const isWaiting = seg.kind === 'waiting'
      const isHovered = hovered && hovered.start === seg.start
      for (let i = i0; i < i1; i++) {
        const a = spiral(i / SAMPLES)
        if ((Math.sin(a.theta) > 0) !== front) continue
        const [x0, y0] = v.projected[i], [x1, y1] = v.projected[i + 1]
        const beam = v.beaming(a.theta) * (isHovered ? 1.6 : 1)
        // Wide soft glow, then a hot core
        segment(v.batch.at(color, (isWaiting ? 0.035 : 0.075) * beam, (isWaiting ? 7 : 13) * v.scale), x0, y0, x1, y1)
        segment(cores.at(color, (isWaiting ? 0.22 : 0.42) * beam, (isWaiting ? 1.2 : 2.6) * v.scale), x0, y0, x1, y1)
      }
    }
    v.batch.stroke(ctx)
    cores.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  /**
   * The time to come: a dashed path from now into the horizon, flowing inward, reaching it when
   * the context window fills. While the context isn't growing it fades out a little way in
   */
  function drawFuture(ctx: CanvasRenderingContext2D, input: SceneInput, now: number, front: boolean) {
    const iNow = Math.round(U_NOW * SAMPLES)
    const iEnd = input.consumption ? SAMPLES : Math.round((U_NOW + 0.12) * SAMPLES)
    const flow = v.reducedMotion ? 0 : now * 0.012
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    for (let i = iNow; i < iEnd; i++) {
      // Dashes, drifting inward over time
      if (Math.floor((i - flow) / 7) % 2 !== 0) continue
      const { theta } = spiral(i / SAMPLES)
      if ((Math.sin(theta) > 0) !== front) continue
      const along = (i - iNow) / (iEnd - iNow)
      const fade = input.consumption ? 0.55 + 0.45 * along : 1 - along
      const [x0, y0] = v.projected[i], [x1, y1] = v.projected[i + 1]
      segment(v.batch.at(COLORS.horizonHot, 0.32 * v.beaming(theta) * fade, 1.6 * v.scale), x0, y0, x1, y1)
    }
    v.batch.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  /** Matter falling along the disk, quicker as it nears the horizon */
  function drawMatter(ctx: CanvasRenderingContext2D, h: TimeHorizon, dt: number, front: boolean) {
    ctx.globalCompositeOperation = 'lighter'
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
      ctx.fillStyle = kind
        ? KIND_COLOR[kind] + hex((kind === 'waiting' ? 0.3 : 0.65) * v.beaming(theta) * fade)
        : COLORS.horizonHot + hex(0.22 * v.beaming(theta) * fade)
      ctx.beginPath()
      ctx.arc(x, y, m.size * v.scale * (1 + m.u * 0.8), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rotation = 0) {
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i - Math.PI / 2 + rotation
      if (i === 0) ctx.moveTo(x + size * Math.cos(ang), y + size * Math.sin(ang))
      else ctx.lineTo(x + size * Math.cos(ang), y + size * Math.sin(ang))
    }
    ctx.closePath()
  }

  /** A span at a glance: 12m, 3.5h, 2.1d */
  const span = (t: number) => (t < 3600 ? `${Math.round(t / 60)}m` : t < 86400 ? `${+(t / 3600).toFixed(1)}h` : `${+(t / 86400).toFixed(1)}d`)
  const tickStep = (total: number) => [60, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400].find(s => total / s <= 6) ?? 172800

  /**
   * A hexagon where each of your prompts started a turn, spinning as fast as the work it set off:
   * a quick question turns lazily, a long run of tools spins hard. A new one pops in with a
   * shockwave; the turn still running glows. Then the time, back to the rim and on to the horizon
   */
  function drawMarkers(ctx: CanvasRenderingContext2D, input: SceneInput, now: number) {
    const h = input.horizon
    // Turns there when the view opened are just there; ones that arrive after pop in
    const opening = seenStarts === undefined
    seenStarts ??= new Set()
    for (const turn of h.turnLog) {
      if (seenStarts.has(turn.start)) continue
      seenStarts.add(turn.start)
      if (!opening) poppedAt.set(turn.start, now)
    }

    hexes = []
    h.turnLog.forEach(turn => {
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
      if (pop > 0) {
        hexPath(ctx, x, y, size + (1 - pop) * 40 * v.scale, spin)
        ctx.strokeStyle = COLORS.holoBright + hex(pop * 0.8)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      if (running && !v.reducedMotion) {
        const pulse = (now % 1800) / 1800
        hexPath(ctx, x, y, size + pulse * 14 * v.scale, spin)
        ctx.strokeStyle = COLORS.holoBright + hex(0.5 * (1 - pulse))
        ctx.lineWidth = 1
        ctx.stroke()
      }
      hexPath(ctx, x, y, size, spin)
      ctx.fillStyle = COLORS.void + 'd0'
      ctx.fill()
      ctx.strokeStyle = lit ? COLORS.holoHot : COLORS.holoBright
      ctx.lineWidth = lit ? 2 : 1.4
      ctx.shadowColor = COLORS.holoBright
      ctx.shadowBlur = lit || running ? 10 : 4 * intensity
      ctx.stroke()
      ctx.shadowBlur = 0
      // The work inside: a core that fills with it
      hexPath(ctx, x, y, size * 0.45 * intensity, -spin * 1.5)
      ctx.fillStyle = COLORS.holoBright + hex(0.35 + 0.5 * intensity)
      ctx.fill()
    })

    ctx.font = `${Math.max(9, 10 * v.scale)}px monospace`
    ctx.textAlign = 'center'
    // Back toward the rim: how long ago
    const back = tickStep(h.elapsed)
    for (let t = back; t < h.elapsed - back * 0.3; t += back) {
      const { theta, r } = spiral(v.pastU(h, h.start + h.elapsed - t))
      if (Math.sin(theta) < 0.2) continue
      const [x, y] = v.project(r + 26, theta)
      ctx.fillStyle = COLORS.textDim
      ctx.fillText(`T−${span(t)}`, x, y)
    }
    // On toward the horizon: how long until
    const c = input.consumption
    if (c && c.eta > 0) {
      const ahead = tickStep(c.eta)
      for (let t = ahead; t < c.eta - ahead * 0.3; t += ahead) {
        const { theta, r } = spiral(U_NOW + (1 - U_NOW) * (t / c.eta))
        if (Math.sin(theta) < 0.2) continue
        const [x, y] = v.project(r + 22, theta)
        ctx.fillStyle = COLORS.horizonLight + 'aa'
        ctx.fillText(`T+${span(t)}`, x, y)
      }
    }
  }

  function drawNow(ctx: CanvasRenderingContext2D, input: SceneInput, now: number) {
    const { theta, r } = spiral(U_NOW)
    const [x, y] = v.project(r, theta)
    const pulse = v.reducedMotion ? 0.5 : (now % 2600) / 2600
    // A hexagonal shockwave, every few seconds
    if (!v.reducedMotion) {
      hexPath(ctx, x, y, (8 + pulse * 46) * v.scale)
      ctx.strokeStyle = COLORS.horizonHot + hex(0.7 * (1 - pulse))
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    hexPath(ctx, x, y, 7 * v.scale)
    ctx.fillStyle = COLORS.horizonHot
    ctx.shadowColor = COLORS.horizonHot
    ctx.shadowBlur = 14
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.font = `bold ${Math.max(9, 10 * v.scale)}px monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = COLORS.horizonHot
    ctx.fillText('NOW · T+0', x + 12 * v.scale, y + 4)

    const start = spiral(0)
    const [sx, sy] = v.project(start.r, start.theta)
    ctx.textAlign = 'center'
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(`T−${formatDuration(input.horizon.elapsed)} · START`, sx, sy - 14 * v.scale)

    // Where the future meets the horizon: the context full, the session's detail gone
    ctx.font = `${Math.max(9, 10 * v.scale)}px monospace`
    const c = input.consumption
    if (c) {
      const end = spiral(1)
      const [ex, ey] = v.project(end.r, end.theta)
      ctx.textAlign = 'left'
      ctx.fillStyle = COLORS.timePermission
      ctx.shadowColor = COLORS.timePermission
      ctx.shadowBlur = 8
      ctx.beginPath(); ctx.arc(ex, ey, 3 * v.scale, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
      ctx.fillText(`T+${span(c.eta)} · CONTEXT FULL`, ex + 10 * v.scale, ey - 8 * v.scale)
    } else {
      const fade = spiral(U_NOW + 0.12)
      const [fx, fy] = v.project(fade.r + 22, fade.theta)
      ctx.textAlign = 'center'
      ctx.fillStyle = COLORS.textMuted
      ctx.fillText('CONTEXT STEADY · NO INSPIRAL', fx, fy)
    }
  }

  /** The prompt cache in orbit: its orbit decays toward the horizon as the cache ages */
  function drawCache(ctx: CanvasRenderingContext2D, input: SceneInput, now: number) {
    if (input.cacheFraction === undefined) return
    const warm = input.cacheWarm
    const r = warm ? R_IN + 24 + input.cacheFraction * (R_OUT - R_IN - 24) : HOLE_R * 1.18
    const theta = (v.reducedMotion ? 1 : now / 1000) * (2 * Math.PI / (warm ? 34 : 8))
    const color = warm ? COLORS.horizonHot : COLORS.timePermission

    ctx.setLineDash([2 * v.scale, 7 * v.scale])
    ctx.strokeStyle = color + hex(0.22)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i <= 120; i++) {
      const [x, y] = v.project(r, (i / 120) * Math.PI * 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])

    const [x, y] = v.project(r, theta)
    trail.push([x, y])
    if (trail.length > 40) trail.shift()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = color + hex((i / trail.length) * 0.5)
      ctx.lineWidth = (i / trail.length) * 3 * v.scale
      ctx.beginPath(); ctx.moveTo(trail[i - 1][0], trail[i - 1][1]); ctx.lineTo(trail[i][0], trail[i][1]); ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
    const [px, py] = trail.length > 1 ? trail[trail.length - 2] : [x - 1, y]
    const heading = Math.atan2(y - py, x - px)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(heading)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.moveTo(8 * v.scale, 0); ctx.lineTo(-5 * v.scale, -4.5 * v.scale); ctx.lineTo(-2 * v.scale, 0); ctx.lineTo(-5 * v.scale, 4.5 * v.scale)
    ctx.closePath(); ctx.fill()
    ctx.restore()
    ctx.font = `${Math.max(9, 10 * v.scale)}px monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(input.cacheLabel, x + 12 * v.scale, y + 16 * v.scale)
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
      if (overHole && Math.sin(spiral(i / SAMPLES).theta) <= 0) continue
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
