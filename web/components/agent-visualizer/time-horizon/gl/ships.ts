/**
 * Subagents on the time horizon, through the painter: ships launched from the disk, swinging round
 * the hole while they work, sparking with each request and landing where they returned; and their
 * lanes in the past. The same flights as the 2D ships; only the drawing differs.
 */
import { runKey, type TimeHorizon } from '@/lib/time-horizon'
import { DISK_COS, DISK_SIN, SAMPLES, U_NOW, shipColor, spiral, type View } from '../shared'
import { glowAt } from './disk'
import type { Painter } from '../../gl/painter'

export function createShips(v: View, wake: (ms: number) => void) {
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
  const diskPoint = (h: TimeHorizon, t: number): [number, number] => {
    const { theta, r } = spiral(v.pastU(h, Math.max(h.start, Math.min(t, h.start + h.elapsed))))
    return v.project(r, theta)
  }

  /** Each subagent's time out, a thin lane beside the disk: overlapping lanes are parallel work */
  function drawLanes(p: Painter, h: TimeHorizon, front: boolean) {
    if (front) laneHits = []
    for (const run of h.subagents) {
      const u0 = v.pastU(h, Math.max(run.start, h.start)), u1 = v.pastU(h, run.end ?? h.start + h.elapsed)
      const i0 = Math.max(0, Math.floor(u0 * SAMPLES)), i1 = Math.min(Math.round(U_NOW * SAMPLES), Math.ceil(u1 * SAMPLES))
      const color = shipColor(run.model)
      const key = runKey(run)
      const lift = 12 + (slot(key) % 3) * 6
      // A stroke for each stretch of the lane on this half
      let open = false
      let last = { theta: 0, r: 0 }
      for (let i = i0; i < i1; i++) {
        const a = spiral(i / SAMPLES)
        const on = (Math.sin(a.theta) > 0) === front
        if (on) {
          if (!open) { p.path(); open = true }
          const [x, y] = v.project(a.r + lift, a.theta)
          p.to(x, y, 1.5 * v.scale, color, 0.55 * v.beaming(a.theta))
          if (i % 4 === 0) laneHits.push({ key, x, y })
          last = a
          continue
        }
        if (open) { closeLane(p, i, lift, color, last); open = false }
      }
      if (open) closeLane(p, i1, lift, color, last)
    }
  }
  /** A lane's stretch ends at the sample after its last, as each of its pieces did */
  function closeLane(p: Painter, i: number, lift: number, color: string, prev: { theta: number }) {
    const b = spiral(i / SAMPLES)
    const [x, y] = v.project(b.r + lift, b.theta)
    p.to(x, y, 1.5 * v.scale, color, 0.55 * v.beaming(prev.theta))
    p.stroke(true)
  }

  const hull = new Float32Array(8)
  /**
   * Subagents in flight: launched from the disk where they were sent out, swinging round the hole
   * while they work, sparking with each of their requests, and flying back to land on the disk
   * where they returned, in a flash. Size is what they've written; color, their model.
   */
  function drawShips(p: Painter, h: TimeHorizon, now: number, dt: number) {
    shipHits = []
    for (const run of h.subagents) {
      const key = runKey(run)
      let f = flights.get(key)
      if (!f) {
        // Out already when the view opened: in orbit. Back already: only its lane
        f = { launchedAt: shipsSeen ? now : now - LAUNCH_MS, landed: !shipsSeen && run.end !== undefined, trail: [], requests: run.requests }
        flights.set(key, f)
        if (shipsSeen) wake(LAUNCH_MS + 500)
      }
      if (f.landed) continue
      if (run.end !== undefined && f.returnedAt === undefined) { f.returnedAt = now; wake(LAUNCH_MS + 1000) }

      const orbit = orbitPoint(slot(key), now)
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
          continue
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
        wake(800)
      }

      f.trail.push(pos)
      if (f.trail.length > 46) f.trail.shift()
      if (f.trail.length > 1) {
        p.path()
        for (let i = 0; i < f.trail.length; i++) {
          const t = Math.max(1, i) / f.trail.length
          p.to(f.trail[i][0], f.trail[i][1], t * 2.6 * v.scale, color, t * t * 0.55)
        }
        p.stroke(true)
      }

      const size = (3 + Math.log2(1 + run.outputTokens) / 3.2) * v.scale
      const [px, py] = f.trail.length > 1 ? f.trail[f.trail.length - 2] : [pos[0] - 1, pos[1]]
      glowAt(p, pos[0], pos[1], color, size * 1.6 + 14)
      const heading = Math.atan2(pos[1] - py, pos[0] - px)
      const cos = Math.cos(heading), sin = Math.sin(heading)
      const put = (k: number, lx: number, ly: number) => { hull[2 * k] = pos[0] + lx * cos - ly * sin; hull[2 * k + 1] = pos[1] + lx * sin + ly * cos }
      put(0, size * 1.6, 0); put(1, -size, -size); put(2, -size * 0.4, 0); put(3, -size, size)
      p.fill(hull, color, 1, false)
      p.text(run.name.length > 18 ? `${run.name.slice(0, 17)}…` : run.name, pos[0] + size + 6, pos[1] - size - 2, Math.max(8.5, 9 * v.scale), false, 'left', color + 'cc')
      shipHits.push({ key, x: pos[0], y: pos[1] })
    }
    shipsSeen = true

    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i]
      sp.x += sp.vx * dt; sp.y += sp.vy * dt
      sp.life -= dt / 700
      if (sp.life <= 0) { sparks.splice(i, 1); continue }
      p.disc(sp.x, sp.y, 1.4 * v.scale, sp.color, sp.life * 0.9, true)
    }
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
