/**
 * Subagents on the time horizon: ships launched from the disk, swinging round the hole while they
 * work, sparking with each request and landing where they returned; and their lanes in the past.
 */
import { runKey, type TimeHorizon } from '@/lib/time-horizon'
import { getGlowSprite } from '../canvas/render-cache'
import { DISK_COS, DISK_SIN, SAMPLES, U_NOW, hex, segment, shipColor, spiral, type View } from './shared'

export function createShips(v: View) {


  /** A ship's flight, kept across frames: launched when it was first seen out, landed when it came back */
  interface Flight { launchedAt?: number; returnedAt?: number; landed: boolean; trail: Array<[number, number]>; requests: number }
  const flights = new Map<string, Flight>()
  interface Spark { x: number; y: number; vx: number; vy: number; life: number; color: string }
  const sparks: Spark[] = []
  /** Ships and lane points as last drawn, for hit testing */
  let shipHits: Array<{ key: string; x: number; y: number }> = []
  let laneHits: Array<{ key: string; x: number; y: number }> = []
  let shipsSeen = false
  const LAUNCH_MS = 1700

  /** A ship's place in the sky, from its run: list positions shift when the event log drops its
   *  oldest events, and a ship in flight would jump to another orbit */
  const slot = (key: string) => {
    let hsh = 0
    for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) >>> 0
    return hsh % 12
  }
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
  /** Each ship its own slingshot orbit round the hole: radius, tilt and phase by its place in line */
  function orbitPoint(k: number, now: number): [number, number] {
    const r = 210 + (k % 4) * 40
    const tiltK = 0.3 + ((k % 3) - 1) * 0.13
    const theta = (k * 1.7) + (v.reducedMotion ? 0 : now * 0.00055 * (250 / r) ** 1.5)
    const x = r * Math.cos(theta), y = r * Math.sin(theta) * tiltK
    return [v.cx + (x * DISK_COS - y * DISK_SIN) * v.scale, v.cy + (x * DISK_SIN + y * DISK_COS) * v.scale]
  }
  /** Where a moment of the past sits on the disk: ships leave and land there */
  const diskPoint = (h: TimeHorizon, t: number): [number, number] => {
    const { theta, r } = spiral(v.pastU(h, Math.max(h.start, Math.min(t, h.start + h.elapsed))))
    return v.project(r, theta)
  }

  /** Each subagent's time out, a thin lane beside the disk: overlapping lanes are parallel work */
  function drawLanes(ctx: CanvasRenderingContext2D, h: TimeHorizon, front: boolean) {
    if (front) laneHits = []
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    h.subagents.forEach(run => {
      const u0 = v.pastU(h, Math.max(run.start, h.start)), u1 = v.pastU(h, run.end ?? h.start + h.elapsed)
      const i0 = Math.floor(u0 * SAMPLES), i1 = Math.min(Math.round(U_NOW * SAMPLES), Math.ceil(u1 * SAMPLES))
      const color = shipColor(run.model)
      const lift = 12 + (slot(runKey(run)) % 3) * 6
      for (let i = i0; i < i1; i++) {
        const a = spiral(i / SAMPLES), b = spiral((i + 1) / SAMPLES)
        if ((Math.sin(a.theta) > 0) !== front) continue
        const [x0, y0] = v.project(a.r + lift, a.theta), [x1, y1] = v.project(b.r + lift, b.theta)
        segment(v.batch.at(color, 0.55 * v.beaming(a.theta), 1.5 * v.scale), x0, y0, x1, y1)
        if (i % 4 === 0) laneHits.push({ key: runKey(run), x: x0, y: y0 })
      }
    })
    v.batch.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  /**
   * Subagents in flight: launched from the disk where they were sent out, swinging round the hole
   * while they work, sparking with each of their requests, and flying back to land on the disk
   * where they returned, in a flash. Size is what they've written; color, their model.
   */
  function drawShips(ctx: CanvasRenderingContext2D, h: TimeHorizon, now: number, dt: number) {
    shipHits = []
    h.subagents.forEach(run => {
      let f = flights.get(runKey(run))
      if (!f) {
        // Out already when the view opened: in orbit. Back already: only its lane
        f = { launchedAt: shipsSeen ? now : now - LAUNCH_MS, landed: !shipsSeen && run.end !== undefined, trail: [], requests: run.requests }
        flights.set(runKey(run), f)
      }
      if (f.landed) return
      if (run.end !== undefined && f.returnedAt === undefined) f.returnedAt = now

      const orbit = orbitPoint(slot(runKey(run)), now)
      let pos = orbit
      const launch = Math.min(1, (now - (f.launchedAt ?? now)) / LAUNCH_MS)
      if (launch < 1) {
        const from = diskPoint(h, run.start)
        const e = ease(launch)
        pos = [from[0] + (orbit[0] - from[0]) * e, from[1] + (orbit[1] - from[1]) * e]
      }
      if (f.returnedAt !== undefined) {
        const back = Math.min(1, (now - f.returnedAt) / LAUNCH_MS)
        const to = diskPoint(h, run.end!)
        const e = ease(back)
        pos = [orbit[0] + (to[0] - orbit[0]) * e, orbit[1] + (to[1] - orbit[1]) * e]
        if (back >= 1) {
          f.landed = true
          v.flashes.push({ x: to[0], y: to[1], age: 0 })
          v.flare = Math.min(1.5, v.flare + 0.4)
          return
        }
      }

      const color = shipColor(run.model)
      // A spark for each request it makes
      if (run.requests > f.requests) {
        for (let i = 0; i < 6 * (run.requests - f.requests) && i < 24; i++) {
          const a = Math.random() * Math.PI * 2, speed = 0.03 + Math.random() * 0.05
          sparks.push({ x: pos[0], y: pos[1], vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 1, color })
        }
        f.requests = run.requests
      }

      f.trail.push(pos)
      if (f.trail.length > 46) f.trail.shift()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'butt'
      for (let i = 1; i < f.trail.length; i++) {
        const t = i / f.trail.length
        ctx.strokeStyle = color + hex(t * t * 0.55)
        ctx.lineWidth = t * 2.6 * v.scale
        ctx.beginPath(); ctx.moveTo(f.trail[i - 1][0], f.trail[i - 1][1]); ctx.lineTo(f.trail[i][0], f.trail[i][1]); ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'

      const size = (3 + Math.log2(1 + run.outputTokens) / 3.2) * v.scale
      const [px, py] = f.trail.length > 1 ? f.trail[f.trail.length - 2] : [pos[0] - 1, pos[1]]
      const glow = getGlowSprite(color, size * 1.6 + 14, '66', '00')
      ctx.drawImage(glow, pos[0] - glow.width / 2, pos[1] - glow.height / 2)
      ctx.save()
      ctx.translate(pos[0], pos[1])
      ctx.rotate(Math.atan2(pos[1] - py, pos[0] - px))
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(size * 1.6, 0); ctx.lineTo(-size, -size); ctx.lineTo(-size * 0.4, 0); ctx.lineTo(-size, size)
      ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.font = `${Math.max(8.5, 9 * v.scale)}px monospace`
      ctx.textAlign = 'left'
      ctx.fillStyle = color + 'cc'
      ctx.fillText(run.name.length > 18 ? `${run.name.slice(0, 17)}…` : run.name, pos[0] + size + 6, pos[1] - size - 2)
      shipHits.push({ key: runKey(run), x: pos[0], y: pos[1] })
    })
    shipsSeen = true

    ctx.globalCompositeOperation = 'lighter'
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i]
      sp.x += sp.vx * dt; sp.y += sp.vy * dt
      sp.life -= dt / 700
      if (sp.life <= 0) { sparks.splice(i, 1); continue }
      ctx.fillStyle = sp.color + hex(sp.life * 0.9)
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.4 * v.scale, 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

    function shipAt(x: number, y: number): { key: string; x: number; y: number } | undefined {
    let best: { key: string; x: number; y: number } | undefined, bestD = (14 * v.scale) ** 2
    for (const hit of [...shipHits, ...laneHits]) {
      const d = (hit.x - x) ** 2 + (hit.y - y) ** 2
      if (d < bestD) { bestD = d; best = hit }
    }
    return best
  }

  return { drawLanes, drawShips, shipAt }
}
