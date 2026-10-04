/**
 * The time horizon's scene, drawn on a canvas every frame: a black hole whose accretion disk is
 * the session's timeline. Now (T+0) sits out on the disk; the session so far trails back to the
 * rim, and the time to come spirals in to the horizon, where the context window fills.
 *
 * Matter falls along the disk toward the horizon, colored by the moment it passes; the side
 * turning toward the viewer burns brighter; stars behind the hole bend around it.
 */
import { COLORS } from '@/lib/colors'
import { formatDuration, runKey, type Consumption, type TimeHorizon, type TimeKind } from '@/lib/time-horizon'

export const KIND_COLOR: Record<TimeKind, string> = {
  thinking: COLORS.timeThinking,
  tools: COLORS.timeTools,
  subagents: COLORS.timeSubagents,
  permission: COLORS.timePermission,
  waiting: COLORS.timeWaiting,
}

// Disk geometry, in scene units: the scene is scaled to fit its canvas
const SCENE_W = 1120
const SCENE_H = 540
const R_OUT = 480
const R_IN = 150
const TURNS = 2.6
const TILT = 0.3
const DISK_ANGLE = (-7 * Math.PI) / 180
const HOLE_R = 44
/** The hot inner flow, between the horizon and the timeline */
const GAS_IN = HOLE_R * 1.15
const GAS_OUT = 250
const GAS = 1400
/** The gas disk is seen almost edge on, as Gargantua's is: a thin band across the shadow */
const GAS_TILT = 0.07
const THETA_0 = Math.PI * 0.62
const SAMPLES = 1400
const MATTER = 320
const STARS = 260

interface Star { x: number; y: number; size: number; depth: number; phase: number; warm: boolean }
interface Mote { u: number; offset: number; size: number }
/** A puff of hot gas in the inner flow: it orbits at its own Keplerian speed and drifts inward */
interface Puff { r: number; theta: number; z: number; width: number; age: number; phase: number }
/** A star wandering too close: torn into a stream as it spirals in */
interface Victim { angle: number; r: number; trail: Array<[number, number]>; size: number }
/** Light from something swallowed, spreading from where it crossed */
interface Flash { x: number; y: number; age: number }
/** Hawking radiation: light leaking out from just above the horizon */
interface Photon { angle: number; r: number; speed: number; life: number; size: number; violet: boolean }
export interface Hover { kind: TimeKind; start: number; end: number; x: number; y: number }

export interface SceneInput {
  horizon: TimeHorizon
  /** When the context fills at its recent rate: where the disk's future runs into the horizon */
  consumption?: Consumption
  /** The cache's remaining share of its lifetime, 0 to 1; undefined without a measured request */
  cacheFraction?: number
  cacheLabel: string
  cacheWarm: boolean
}

export interface Scene {
  draw(ctx: CanvasRenderingContext2D, input: SceneInput, now: number, width: number, height: number): void
  /** The stretch of the disk under a canvas point, if any */
  hit(x: number, y: number, input: SceneInput): Hover | undefined
  pointer(x: number, y: number): void
  /** Whether a canvas point is on the black hole or its halo */
  holeAt(x: number, y: number): boolean
  /** Where the hole is on the canvas */
  holeCenter(): [number, number]
  /** The ring flares, as when it swallows something */
  pulse(): void
  /** The prompt hexagon under a canvas point: its turn, by when it started, and where it is */
  hexAt(x: number, y: number): { start: number; x: number; y: number } | undefined
  /** Lights a prompt hexagon, by its turn's start, or none */
  hoverHex(start: number | undefined): void
  /** The subagent under a canvas point, a ship in flight or its lane in the past: its run's key, and where */
  shipAt(x: number, y: number): { key: string; x: number; y: number } | undefined
}

/** Subagents by model: small cool scouts to warm heavy ones */
export function shipColor(model?: string): string {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return '#7fe0ff'
  if (m.includes('sonnet')) return '#c9a0ff'
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return '#ffd59e'
  return '#e8eefc'
}

const hex = (a: number) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

/**
 * Strokes that share a style, gathered into one path each and drawn in one call:
 * thousands of small strokes, each its own trip to the GPU with its own style, become a few
 * dozen. Opacity is rounded to 1/24 steps and widths to a quarter pixel: no difference to the eye.
 */
class Batch {
  /** By color, then by rounded opacity and width packed into one number: looked up without
   *  building a string for each of the thousands of strokes a frame */
  private byColor = new Map<string, Map<number, Path2D>>()

  /** The path to add to for this style */
  at(color: string, alpha: number, width = 0): Path2D {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 24)
    const w = Math.round(width * 4)
    let styles = this.byColor.get(color)
    if (!styles) { styles = new Map(); this.byColor.set(color, styles) }
    const key = w * 32 + a
    let path = styles.get(key)
    if (!path) { path = new Path2D(); styles.set(key, path) }
    return path
  }

  stroke(ctx: CanvasRenderingContext2D) {
    for (const [color, styles] of this.byColor) {
      for (const [key, path] of styles) {
        const a = key % 32, w = Math.floor(key / 32)
        if (a === 0 || w === 0) continue
        ctx.strokeStyle = color + hex(a / 24)
        ctx.lineWidth = w / 4
        ctx.stroke(path)
      }
      styles.clear()
    }
  }
}

/** A segment into a batched path */
const segment = (path: Path2D, x0: number, y0: number, x1: number, y1: number) => { path.moveTo(x0, y0); path.lineTo(x1, y1) }

/**
 * Where now sits on the disk. Outside it, the session so far trails back to the rim; inside it,
 * the time still to come spirals in to the horizon, where the context window fills and the
 * session's detail is compacted away.
 */
const U_NOW = 0.42

/** Where u (0 at the rim, U_NOW at now, 1 at the horizon) sits on the disk: its angle and radius */
function spiral(u: number): { theta: number; r: number } {
  return { theta: THETA_0 + u * TURNS * 2 * Math.PI, r: R_OUT - u * (R_OUT - R_IN) }
}

export function createScene(reducedMotion: boolean): Scene {
  const stars: Star[] = Array.from({ length: STARS }, () => ({
    x: Math.random(), y: Math.random(), size: Math.random() * 1.4 + 0.3,
    depth: Math.random(), phase: Math.random() * Math.PI * 2, warm: Math.random() < 0.25,
  }))
  const motes: Mote[] = Array.from({ length: MATTER }, () => ({
    u: Math.random(), offset: (Math.random() - 0.5) * 16, size: Math.random() * 1.6 + 0.5,
  }))
  const trail: Array<[number, number]> = []
  /** Reused every frame: strokes and fills gathered by style, then drawn together */
  const batch = new Batch()
  const cores = new Batch()
  const photons: Photon[] = []
  const victims: Victim[] = []
  // Gas is born in clumps; orbiting faster inside than out, each clump shears into a filament
  let clumpAngle = Math.random() * Math.PI * 2
  let clumpUntil = 0
  const newPuff = (anywhere: boolean): Puff => ({
    r: anywhere ? GAS_IN + (GAS_OUT - GAS_IN) * Math.random() ** 1.5 : GAS_OUT - Math.random() * 40,
    theta: anywhere ? Math.random() * Math.PI * 2 : clumpAngle + (Math.random() - 0.5) * 1.4,
    z: (Math.random() - 0.5) * 2.4,
    width: 0.5 + Math.random() * 1.2,
    age: anywhere ? 1 : 0,
    phase: Math.random() * Math.PI * 2,
  })
  const gas: Puff[] = Array.from({ length: GAS }, () => newPuff(true))
  /** Hot gas by temperature: orange at the rim to white-hot at the horizon */
  const GAS_COLORS = ['#ff8a4a', '#ffb27a', '#ffd9b0', '#fff4e8']
  const flashes: Flash[] = []
  /** The photon ring flares when the hole swallows something, then settles */
  let flare = 0
  let nextVictimAt = 0
  /** The latest request already radiated: requests before the view opened don't burst */
  let radiatedUntil: number | undefined
  let pointer: [number, number] = [0, 0]
  let lastNow = 0
  let hovered: Hover | undefined
  // Screen positions of the disk's samples, from the latest frame, for hit testing
  /** The disk's samples on screen this frame: allocated once and rewritten in place, not 1,400
   *  new pairs a frame for the garbage collector */
  const projected: Array<[number, number]> = Array.from({ length: SAMPLES + 1 }, () => [0, 0])

  // The camera: scale, center, and a slight parallax tilt toward the pointer
  let scale = 1, cx = 0, cy = 0, tilt = TILT
  const cosA = Math.cos(DISK_ANGLE), sinA = Math.sin(DISK_ANGLE)
  const project = (r: number, theta: number): [number, number] => {
    const x = r * Math.cos(theta)
    const y = r * Math.sin(theta) * tilt
    return [cx + (x * cosA - y * sinA) * scale, cy + (x * sinA + y * cosA) * scale]
  }
  /** Brighter on the side turning toward the viewer, as Doppler beaming makes it */
  const beaming = (theta: number) => 0.62 - 0.38 * Math.cos(theta)

  /** Where a past moment sits on the disk */
  const pastU = (h: TimeHorizon, t: number) => U_NOW * (t - h.start) / h.elapsed
  /** The past moment at a point of the disk outside now */
  const timeAtU = (h: TimeHorizon, u: number) => h.start + (u / U_NOW) * h.elapsed

  /** Prompt hexagons as last drawn, for hit testing, and the one lit by the pointer, by turn start:
   *  list positions shift when the event log drops its oldest events */
  let hexes: Array<{ start: number; x: number; y: number }> = []
  let litHex: number | undefined
  /** When each turn's hexagon first appeared while the view was open, by turn start: it pops in */
  const poppedAt = new Map<number, number>()
  let seenStarts: Set<number> | undefined

  function kindAt(h: TimeHorizon, u: number): TimeKind {
    const t = timeAtU(h, u)
    const segs = h.segments
    let lo = 0, hi = segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (segs[mid].start <= t) lo = mid
      else hi = mid - 1
    }
    return segs[lo]?.kind ?? 'waiting'
  }

  function drawStars(ctx: CanvasRenderingContext2D, w: number, hgt: number, now: number, dt: number) {
    const holeR = HOLE_R * scale
    for (const s of stars) {
      // Drift, with parallax toward the pointer
      // Drifting, and twinkling below, unless motion is reduced
      const drift = reducedMotion ? 0 : now * 0.000004 * (0.3 + s.depth)
      let x = ((s.x + drift) % 1) * w + pointer[0] * 12 * s.depth
      let y = s.y * hgt + pointer[1] * 8 * s.depth
      const dx = x - cx, dy = y - cy
      const d = Math.hypot(dx, dy)
      // Gravity: a star that strays close is drawn in, swirling, and swallowed
      if (!reducedMotion && d < holeR * 9) {
        const pull = Math.min(3, 0.004 * dt * (holeR * 9 / d) ** 2)
        s.x += ((-dx / d) * pull + (-dy / d) * pull * 0.9) / w
        s.y += ((-dy / d) * pull + (dx / d) * pull * 0.9) / hgt
        if (d < holeR * 1.08) {
          flare = Math.min(1.5, flare + 0.06)
          s.x = Math.random(); s.y = Math.random() < 0.5 ? 0.02 : 0.98
          continue
        }
      }
      if (d < holeR * 1.05) continue
      // Gravitational lensing: light passing near the hole is bent outward around it
      const bent = d + (holeR * holeR * 1.6) / d
      x = cx + (dx / d) * bent
      y = cy + (dy / d) * bent
      const twinkle = reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(now * 0.0015 * (0.5 + s.depth) + s.phase)
      const near = Math.max(0, 1 - (d - holeR) / (holeR * 3))
      // Smeared into the ring and gone as it crosses
      const vanishing = Math.min(1, (d - holeR * 1.05) / (holeR * 0.5))
      // One circle at a time: circles have a fast path that a batched path of many would lose
      ctx.fillStyle = (s.warm ? COLORS.horizonLight : COLORS.holoBase) + hex(((0.12 + s.depth * 0.5) * twinkle + near * 0.4) * vanishing)
      ctx.beginPath()
      ctx.arc(x, y, s.size * (0.6 + s.depth * 0.6) * (1 + near * 0.8), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Every so often a star strays in and is torn apart: stretched into a stream that spirals down */
  function drawVictims(ctx: CanvasRenderingContext2D, now: number, dt: number) {
    const holeR = HOLE_R * scale
    if (!reducedMotion && now > nextVictimAt) {
      if (nextVictimAt > 0) victims.push({ angle: Math.random() * Math.PI * 2, r: 220 + Math.random() * 90, trail: [], size: 1.6 + Math.random() * 1.6 })
      nextVictimAt = now + 7000 + Math.random() * 7000
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    for (let i = victims.length - 1; i >= 0; i--) {
      const v = victims[i]
      // Faster and faster as it falls: the orbit tightens and the stream stretches
      v.angle += dt * 0.0025 * (88 / v.r) ** 1.5
      v.r -= dt * 0.06 * (88 / v.r)
      const x = cx + Math.cos(v.angle) * v.r * scale
      const y = cy + Math.sin(v.angle) * v.r * scale * 0.62
      v.trail.push([x, y])
      if (v.trail.length > 90) v.trail.shift()
      for (let j = 1; j < v.trail.length; j++) {
        const f = j / v.trail.length
        ctx.strokeStyle = (f > 0.7 ? COLORS.horizonHot : COLORS.horizonLight) + hex(f * f * 0.55)
        ctx.lineWidth = f * v.size * 2.2 * scale
        ctx.beginPath(); ctx.moveTo(v.trail[j - 1][0], v.trail[j - 1][1]); ctx.lineTo(v.trail[j][0], v.trail[j][1]); ctx.stroke()
      }
      ctx.fillStyle = COLORS.horizonHot
      ctx.beginPath(); ctx.arc(x, y, v.size * scale, 0, Math.PI * 2); ctx.fill()
      if (Math.hypot(x - cx, y - cy) < holeR * 1.02) {
        flare = Math.min(1.5, flare + 1)
        flashes.push({ x, y, age: 0 })
        victims.splice(i, 1)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawFlashes(ctx: CanvasRenderingContext2D, dt: number) {
    ctx.globalCompositeOperation = 'lighter'
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]
      f.age += dt / 900
      if (f.age >= 1) { flashes.splice(i, 1); continue }
      const radius = (6 + f.age * 26) * scale
      const glow = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius)
      glow.addColorStop(0, COLORS.horizonHot + hex((1 - f.age) * 0.75))
      glow.addColorStop(1, COLORS.horizonLight + '00')
      ctx.fillStyle = glow
      ctx.beginPath(); ctx.arc(f.x, f.y, radius, 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  /** The hex grid doesn't change from frame to frame: it's drawn once, and again only when the
   *  view is resized or moves, then copied in, breathing as a whole */
  let gridCache: { canvas: HTMLCanvasElement; key: string } | undefined
  function drawHexGrid(ctx: CanvasRenderingContext2D, w: number, hgt: number, now: number) {
    const dpr = ctx.getTransform().a || 1
    // Drawn around the view's center, without the pointer's parallax: the parallax only moves
    // the finished image, so the cache holds while the pointer moves
    const gx = w / 2, gy = hgt / 2
    const key = `${w}|${hgt}|${dpr}|${scale.toFixed(3)}`
    if (gridCache?.key !== key) {
      const canvas = gridCache?.canvas ?? document.createElement('canvas')
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hgt * dpr)
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const size = 46 * scale
      const hh = size * Math.sqrt(3)
      g.lineWidth = 0.5
      for (let x = -size; x < w + size; x += size * 1.5) {
        const col = Math.round(x / (size * 1.5))
        for (let y = -hh; y < hgt + hh; y += hh) {
          const yy = y + (col % 2 ? hh / 2 : 0)
          const d = Math.hypot(x - gx, yy - gy) / (Math.max(w, hgt) * 0.55)
          // Strongest in a band around the disk, fading at the edges and into the hole
          const a = 0.07 * Math.max(0, 1 - Math.abs(d - 0.55) * 2.2)
          if (a < 0.008) continue
          const path = batch.at(COLORS.holoBase, a, 0.5)
          for (let i = 0; i < 6; i++) {
            const ang = (Math.PI / 3) * i
            const px = x + size * 0.42 * Math.cos(ang), py = yy + size * 0.42 * Math.sin(ang)
            if (i === 0) path.moveTo(px, py)
            else path.lineTo(px, py)
          }
          path.closePath()
        }
      }
      batch.stroke(g)
      gridCache = { canvas, key }
    }
    ctx.save()
    ctx.globalAlpha = reducedMotion ? 0.85 : 0.75 + 0.25 * Math.sin(now * 0.0008)
    ctx.drawImage(gridCache.canvas, cx - gx, cy - gy, w, hgt)
    ctx.restore()
  }

  /** The timeline ribbon: only the half behind the hole, or only the half in front of it */
  function drawDisk(ctx: CanvasRenderingContext2D, h: TimeHorizon, front: boolean) {
    ctx.globalCompositeOperation = 'lighter'
    // Butt caps: round ones overlap between the short segments and bead under additive light
    ctx.lineCap = 'butt'
    for (const seg of h.segments) {
      const u0 = pastU(h, seg.start)
      const u1 = pastU(h, seg.end)
      const i0 = Math.floor(u0 * SAMPLES), i1 = Math.min(Math.round(U_NOW * SAMPLES), Math.ceil(u1 * SAMPLES))
      const color = KIND_COLOR[seg.kind]
      const isWaiting = seg.kind === 'waiting'
      const isHovered = hovered && hovered.start === seg.start
      for (let i = i0; i < i1; i++) {
        const a = spiral(i / SAMPLES)
        if ((Math.sin(a.theta) > 0) !== front) continue
        const [x0, y0] = projected[i], [x1, y1] = projected[i + 1]
        const beam = beaming(a.theta) * (isHovered ? 1.6 : 1)
        // Wide soft glow, then a hot core
        segment(batch.at(color, (isWaiting ? 0.035 : 0.075) * beam, (isWaiting ? 7 : 13) * scale), x0, y0, x1, y1)
        segment(cores.at(color, (isWaiting ? 0.22 : 0.42) * beam, (isWaiting ? 1.2 : 2.6) * scale), x0, y0, x1, y1)
      }
    }
    batch.stroke(ctx)
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
    const flow = reducedMotion ? 0 : now * 0.012
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    for (let i = iNow; i < iEnd; i++) {
      // Dashes, drifting inward over time
      if (Math.floor((i - flow) / 7) % 2 !== 0) continue
      const { theta } = spiral(i / SAMPLES)
      if ((Math.sin(theta) > 0) !== front) continue
      const along = (i - iNow) / (iEnd - iNow)
      const fade = input.consumption ? 0.55 + 0.45 * along : 1 - along
      const [x0, y0] = projected[i], [x1, y1] = projected[i + 1]
      segment(batch.at(COLORS.horizonHot, 0.32 * beaming(theta) * fade, 1.6 * scale), x0, y0, x1, y1)
    }
    batch.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  // ─── Subagents ────────────────────────────────────────────────────────────
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
    const theta = (k * 1.7) + (reducedMotion ? 0 : now * 0.00055 * (250 / r) ** 1.5)
    const x = r * Math.cos(theta), y = r * Math.sin(theta) * tiltK
    return [cx + (x * cosA - y * sinA) * scale, cy + (x * sinA + y * cosA) * scale]
  }
  /** Where a moment of the past sits on the disk: ships leave and land there */
  const diskPoint = (h: TimeHorizon, t: number): [number, number] => {
    const { theta, r } = spiral(pastU(h, Math.max(h.start, Math.min(t, h.start + h.elapsed))))
    return project(r, theta)
  }

  /** Each subagent's time out, a thin lane beside the disk: overlapping lanes are parallel work */
  function drawLanes(ctx: CanvasRenderingContext2D, h: TimeHorizon, front: boolean) {
    if (front) laneHits = []
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    h.subagents.forEach(run => {
      const u0 = pastU(h, Math.max(run.start, h.start)), u1 = pastU(h, run.end ?? h.start + h.elapsed)
      const i0 = Math.floor(u0 * SAMPLES), i1 = Math.min(Math.round(U_NOW * SAMPLES), Math.ceil(u1 * SAMPLES))
      const color = shipColor(run.model)
      const lift = 12 + (slot(runKey(run)) % 3) * 6
      for (let i = i0; i < i1; i++) {
        const a = spiral(i / SAMPLES), b = spiral((i + 1) / SAMPLES)
        if ((Math.sin(a.theta) > 0) !== front) continue
        const [x0, y0] = project(a.r + lift, a.theta), [x1, y1] = project(b.r + lift, b.theta)
        segment(batch.at(color, 0.55 * beaming(a.theta), 1.5 * scale), x0, y0, x1, y1)
        if (i % 4 === 0) laneHits.push({ key: runKey(run), x: x0, y: y0 })
      }
    })
    batch.stroke(ctx)
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
          flashes.push({ x: to[0], y: to[1], age: 0 })
          flare = Math.min(1.5, flare + 0.4)
          return
        }
      }

      const color = shipColor(run.model)
      // A spark for each request it makes
      if (run.requests > f.requests) {
        for (let i = 0; i < 6 * (run.requests - f.requests) && i < 24; i++) {
          const a = Math.random() * Math.PI * 2, v = 0.03 + Math.random() * 0.05
          sparks.push({ x: pos[0], y: pos[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, color })
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
        ctx.lineWidth = t * 2.6 * scale
        ctx.beginPath(); ctx.moveTo(f.trail[i - 1][0], f.trail[i - 1][1]); ctx.lineTo(f.trail[i][0], f.trail[i][1]); ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'

      const size = (3 + Math.log2(1 + run.outputTokens) / 3.2) * scale
      const [px, py] = f.trail.length > 1 ? f.trail[f.trail.length - 2] : [pos[0] - 1, pos[1]]
      ctx.save()
      ctx.translate(pos[0], pos[1])
      ctx.rotate(Math.atan2(pos[1] - py, pos[0] - px))
      ctx.fillStyle = color
      ctx.shadowColor = color
      ctx.shadowBlur = 14
      ctx.beginPath()
      ctx.moveTo(size * 1.6, 0); ctx.lineTo(-size, -size); ctx.lineTo(-size * 0.4, 0); ctx.lineTo(-size, size)
      ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.font = `${Math.max(8.5, 9 * scale)}px monospace`
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
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.4 * scale, 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  /** Matter falling along the disk, quicker as it nears the horizon */
  function drawMatter(ctx: CanvasRenderingContext2D, h: TimeHorizon, dt: number, front: boolean) {
    ctx.globalCompositeOperation = 'lighter'
    for (const m of motes) {
      if (front && !reducedMotion) {
        m.u += dt * 0.000018 * (1 + 4 * m.u * m.u)
        if (m.u >= 1) { m.u = 0; m.offset = (Math.random() - 0.5) * 16 }
      }
      const { theta, r } = spiral(m.u)
      if ((Math.sin(theta) > 0) !== front) continue
      const [x, y] = project(r + m.offset, theta)
      const fade = Math.min(1, m.u * 20) * Math.min(1, (1 - m.u) * 12)
      // The past carries its colors; what's still to come is pale
      const kind = m.u > U_NOW ? undefined : kindAt(h, m.u)
      ctx.fillStyle = kind
        ? KIND_COLOR[kind] + hex((kind === 'waiting' ? 0.3 : 0.65) * beaming(theta) * fade)
        : COLORS.horizonHot + hex(0.22 * beaming(theta) * fade)
      ctx.beginPath()
      ctx.arc(x, y, m.size * scale * (1 + m.u * 0.8), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function emit(count: number) {
    for (let i = 0; i < count; i++) {
      photons.push({
        angle: Math.random() * Math.PI * 2, r: HOLE_R * 1.04, speed: 0.025 + Math.random() * 0.05,
        life: 1, size: Math.random() * 1.6 + 0.6, violet: Math.random() < 0.35,
      })
    }
  }

  /** Each request the session made escapes as a burst sized by what it wrote; a faint glow between */
  function drawRadiation(ctx: CanvasRenderingContext2D, h: TimeHorizon, dt: number) {
    const latest = h.emissions.length ? h.emissions[h.emissions.length - 1].time : -Infinity
    if (radiatedUntil === undefined || latest < radiatedUntil) radiatedUntil = latest
    for (const e of h.emissions) {
      if (e.time <= radiatedUntil) continue
      emit(Math.round(Math.min(40, 6 + Math.log2(1 + e.outputTokens) * 3)))
    }
    radiatedUntil = latest
    if (!reducedMotion && Math.random() < dt * 0.004) emit(1)

    ctx.globalCompositeOperation = 'lighter'
    for (let i = photons.length - 1; i >= 0; i--) {
      const p = photons[i]
      if (!reducedMotion) {
        p.r += p.speed * dt
        p.angle += 0.00004 * dt
        p.life -= dt / 4200
      }
      if (p.life <= 0) { photons.splice(i, 1); continue }
      // Escaping light, redshifted as it climbs out: warm white turning violet and fading
      const x = cx + Math.cos(p.angle) * p.r * scale
      const y = cy + Math.sin(p.angle) * p.r * scale
      const color = p.violet ? COLORS.timeSubagents : COLORS.horizonHot
      ctx.fillStyle = color + hex(p.life * 0.8)
      ctx.beginPath(); ctx.arc(x, y, p.size * scale * (0.6 + p.life * 0.6), 0, Math.PI * 2); ctx.fill()
      // A short streak back toward the horizon
      ctx.strokeStyle = color + hex(p.life * 0.25)
      ctx.lineWidth = p.size * scale * 0.7
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(cx + Math.cos(p.angle) * (p.r - 14) * scale, cy + Math.sin(p.angle) * (p.r - 14) * scale)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  const gasCos = Math.cos(DISK_ANGLE), gasSin = Math.sin(DISK_ANGLE)
  /** A point of the gas disk, seen almost edge on */
  const projectGas = (r: number, theta: number, z: number): [number, number] => {
    const x = r * Math.cos(theta), y = r * Math.sin(theta) * GAS_TILT + z
    return [cx + (x * gasCos - y * gasSin) * scale, cy + (x * gasSin + y * gasCos) * scale]
  }
  /** The film kept only a little of the Doppler asymmetry: so does this */
  const mildBeam = (theta: number) => 0.8 - 0.2 * Math.cos(theta)

  /**
   * The inner flow: hot gas orbiting at Keplerian speed (ω ∝ r^-3/2), so each clump it's born in
   * shears into a fibre; heating as it falls and fading through the horizon. Drawn in three passes:
   * the far half of the disk (behind the shadow), its light bent over the top and under the bottom
   * of the shadow, and the near half crossing in front of it.
   */
  function drawGas(ctx: CanvasRenderingContext2D, dt: number, now: number, pass: 'far' | 'lensed' | 'near') {
    if (pass === 'near' && !reducedMotion) {
      if (now > clumpUntil) { clumpAngle = Math.random() * Math.PI * 2; clumpUntil = now + 250 + Math.random() * 400 }
      for (let i = 0; i < gas.length; i++) {
        const p = gas[i]
        p.theta += dt * 0.0016 * (GAS_IN / p.r) ** 1.5
        // Drifting in, quicker near the horizon, with a little turbulence
        p.r -= dt * (0.006 + 0.03 * (GAS_IN / p.r) ** 3) + Math.sin(p.theta * 4 + p.phase + now * 0.0013) * 0.0008 * dt
        p.age = Math.min(1, p.age + dt / 900)
        if (p.r < HOLE_R * 0.98) gas[i] = newPuff(false)
      }
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    if (pass === 'lensed') {
      // The halo's glowing body, under its fibres
      const r = HOLE_R * scale
      const halo = ctx.createRadialGradient(cx, cy, r * 1.12, cx, cy, r * 2.5)
      halo.addColorStop(0, COLORS.horizonHot + '00')
      halo.addColorStop(0.08, COLORS.horizonHot + hex(0.2 + flare * 0.1))
      halo.addColorStop(0.45, COLORS.horizonLight + hex(0.09))
      halo.addColorStop(1, COLORS.horizonLight + '00')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.5, 0, Math.PI * 2); ctx.fill()
    }
    for (const p of gas) {
      const behind = Math.sin(p.theta) < 0
      if (pass === 'far' && !behind) continue
      if (pass === 'near' && behind) continue
      if (pass === 'lensed' && !behind) continue
      const f = (p.r - GAS_IN) / (GAS_OUT - GAS_IN)
      const heat = Math.max(0, Math.min(1, 1 - f))
      const fade = p.age * Math.max(0, Math.min(1, (p.r - HOLE_R) / (HOLE_R * 0.25)))
      const alpha = (0.05 + heat * heat * 0.22) * mildBeam(p.theta) * fade
      if (alpha < 0.01) continue
      const color = GAS_COLORS[Math.min(3, Math.floor(heat * 3.99))]
      // A fibre: the stretch of orbit the gas swept through, longer where it moves faster
      const sweep = 0.06 + 0.3 * (GAS_IN / p.r)
      const fibre = (point: (theta: number) => [number, number], a: number, width: number) => {
        const path = batch.at(color, a, width * scale)
        for (let i = 0; i <= 4; i++) {
          const [x, y] = point(p.theta - sweep * (1 - i / 4))
          if (i === 0) path.moveTo(x, y)
          else path.lineTo(x, y)
        }
      }
      if (pass !== 'lensed') {
        fibre(t => projectGas(p.r, t, p.z), Math.min(1, alpha * 1.5), p.width * 1.2)
        continue
      }
      // The far side's light, bent into a ring round the shadow: over the top, and under the bottom
      const rho = HOLE_R * (1.22 + 0.95 * f ** 0.8)
      fibre(t => [cx + Math.cos(t + DISK_ANGLE) * rho * scale, cy + Math.sin(t + DISK_ANGLE) * rho * scale], Math.min(1, alpha * 2.2), p.width * 1.2)
      fibre(t => [cx + Math.cos(-t + DISK_ANGLE) * rho * 0.9 * scale, cy + Math.sin(-t + DISK_ANGLE) * rho * 0.9 * scale], Math.min(1, alpha * 1.3), p.width * 0.9)
    }
    batch.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawHole(ctx: CanvasRenderingContext2D, now: number) {
    const r = HOLE_R * scale
    // Bloom
    const bloom = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 3.2)
    bloom.addColorStop(0, COLORS.horizonLight + hex(0.16 + flare * 0.12))
    bloom.addColorStop(1, COLORS.horizonLight + '00')
    ctx.fillStyle = bloom
    ctx.beginPath(); ctx.arc(cx, cy, r * 3.2, 0, Math.PI * 2); ctx.fill()

    // The shadow: larger than the horizon, darkening into it
    const shadow = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.25)
    shadow.addColorStop(0, COLORS.horizonVoid + 'ff')
    shadow.addColorStop(0.35, COLORS.horizonVoid + 'b0')
    shadow.addColorStop(1, COLORS.horizonVoid + '00')
    ctx.fillStyle = shadow
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = COLORS.horizonVoid
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.97, 0, Math.PI * 2); ctx.fill()

    // The photon ring: uneven and alive, brighter on the side turning toward us, flaring as it feeds.
    // One stroke with its brightness in a conic gradient, so it stays smooth all the way round
    ctx.globalCompositeOperation = 'lighter'
    const glowAt = (a: number) => {
      const turbulence = 0.85 + 0.15 * Math.sin(a * 3 + now * 0.0021) * Math.sin(a * 7 - now * 0.0013)
      return Math.min(1, (0.8 - 0.2 * Math.cos(a)) * turbulence * (1 + flare * 0.8))
    }
    const ring = (color: string, alpha: number, width: number) => {
      const g = ctx.createConicGradient(0, cx, cy)
      for (let i = 0; i <= 48; i++) g.addColorStop(i / 48, color + hex(glowAt((i / 48) * Math.PI * 2) * alpha))
      ctx.strokeStyle = g
      ctx.lineWidth = width * scale
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.02, 0, Math.PI * 2); ctx.stroke()
    }
    ring(COLORS.horizonLight, 0.16, 5 + flare * 6)
    ring(COLORS.horizonHot, 0.45, 2)
    ring(COLORS.horizonHot, 1, 0.9)
    // A fainter inner ring, light that went round once more
    ctx.strokeStyle = COLORS.horizonHot + hex(0.18 + flare * 0.15)
    ctx.lineWidth = 0.8 * scale
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.985, 0, Math.PI * 2); ctx.stroke()
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
      const { theta, r } = spiral(pastU(h, turn.start))
      const [x, y] = project(r, theta)
      hexes.push({ start: turn.start, x, y })
      const intensity = Math.min(1, Math.log10(1 + turn.work) / Math.log10(1 + 1800))
      const spin = reducedMotion ? 0 : now * (0.0002 + 0.004 * intensity)
      const poppedFrom = poppedAt.get(turn.start)
      const pop = poppedFrom !== undefined ? Math.max(0, 1 - (now - poppedFrom) / 900) : 0
      const running = turn.end === undefined
      const lit = litHex === turn.start
      const size = (6 + intensity * 3 + pop * 8 + (lit ? 2 : 0)) * scale
      if (pop > 0) {
        hexPath(ctx, x, y, size + (1 - pop) * 40 * scale, spin)
        ctx.strokeStyle = COLORS.holoBright + hex(pop * 0.8)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      if (running && !reducedMotion) {
        const pulse = (now % 1800) / 1800
        hexPath(ctx, x, y, size + pulse * 14 * scale, spin)
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

    ctx.font = `${Math.max(9, 10 * scale)}px monospace`
    ctx.textAlign = 'center'
    // Back toward the rim: how long ago
    const back = tickStep(h.elapsed)
    for (let t = back; t < h.elapsed - back * 0.3; t += back) {
      const { theta, r } = spiral(pastU(h, h.start + h.elapsed - t))
      if (Math.sin(theta) < 0.2) continue
      const [x, y] = project(r + 26, theta)
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
        const [x, y] = project(r + 22, theta)
        ctx.fillStyle = COLORS.horizonLight + 'aa'
        ctx.fillText(`T+${span(t)}`, x, y)
      }
    }
  }

  function drawNow(ctx: CanvasRenderingContext2D, input: SceneInput, now: number) {
    const { theta, r } = spiral(U_NOW)
    const [x, y] = project(r, theta)
    const pulse = reducedMotion ? 0.5 : (now % 2600) / 2600
    // A hexagonal shockwave, every few seconds
    if (!reducedMotion) {
      hexPath(ctx, x, y, (8 + pulse * 46) * scale)
      ctx.strokeStyle = COLORS.horizonHot + hex(0.7 * (1 - pulse))
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    hexPath(ctx, x, y, 7 * scale)
    ctx.fillStyle = COLORS.horizonHot
    ctx.shadowColor = COLORS.horizonHot
    ctx.shadowBlur = 14
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.font = `bold ${Math.max(9, 10 * scale)}px monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = COLORS.horizonHot
    ctx.fillText('NOW · T+0', x + 12 * scale, y + 4)

    const start = spiral(0)
    const [sx, sy] = project(start.r, start.theta)
    ctx.textAlign = 'center'
    ctx.fillStyle = COLORS.textDim
    ctx.fillText(`T−${formatDuration(input.horizon.elapsed)} · START`, sx, sy - 14 * scale)

    // Where the future meets the horizon: the context full, the session's detail gone
    ctx.font = `${Math.max(9, 10 * scale)}px monospace`
    const c = input.consumption
    if (c) {
      const end = spiral(1)
      const [ex, ey] = project(end.r, end.theta)
      ctx.textAlign = 'left'
      ctx.fillStyle = COLORS.timePermission
      ctx.shadowColor = COLORS.timePermission
      ctx.shadowBlur = 8
      ctx.beginPath(); ctx.arc(ex, ey, 3 * scale, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
      ctx.fillText(`T+${span(c.eta)} · CONTEXT FULL`, ex + 10 * scale, ey - 8 * scale)
    } else {
      const fade = spiral(U_NOW + 0.12)
      const [fx, fy] = project(fade.r + 22, fade.theta)
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
    const theta = (reducedMotion ? 1 : now / 1000) * (2 * Math.PI / (warm ? 34 : 8))
    const color = warm ? COLORS.horizonHot : COLORS.timePermission

    ctx.setLineDash([2 * scale, 7 * scale])
    ctx.strokeStyle = color + hex(0.22)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i <= 120; i++) {
      const [x, y] = project(r, (i / 120) * Math.PI * 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])

    const [x, y] = project(r, theta)
    trail.push([x, y])
    if (trail.length > 40) trail.shift()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = color + hex((i / trail.length) * 0.5)
      ctx.lineWidth = (i / trail.length) * 3 * scale
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
    ctx.moveTo(8 * scale, 0); ctx.lineTo(-5 * scale, -4.5 * scale); ctx.lineTo(-2 * scale, 0); ctx.lineTo(-5 * scale, 4.5 * scale)
    ctx.closePath(); ctx.fill()
    ctx.restore()
    ctx.font = `${Math.max(9, 10 * scale)}px monospace`
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(input.cacheLabel, x + 12 * scale, y + 16 * scale)
  }

  return {
    pointer(x, y) { pointer = [x, y] },
    holeAt(x, y) { return Math.hypot(x - cx, y - cy) < HOLE_R * 2.3 * scale },
    holeCenter() { return [cx, cy] },
    pulse() {
      flare = Math.min(1.5, flare + 1.2)
      emit(24)
    },
    hexAt(x, y) {
      let best: { start: number; x: number; y: number } | undefined, bestD = (12 * scale) ** 2
      for (const hx of hexes) {
        const d = (hx.x - x) ** 2 + (hx.y - y) ** 2
        if (d < bestD) { bestD = d; best = hx }
      }
      return best
    },
    hoverHex(start) { litHex = start },
    shipAt(x, y) {
      let best: { key: string; x: number; y: number } | undefined, bestD = (14 * scale) ** 2
      for (const hit of [...shipHits, ...laneHits]) {
        const d = (hit.x - x) ** 2 + (hit.y - y) ** 2
        if (d < bestD) { bestD = d; best = hit }
      }
      return best
    },

    hit(x, y, input) {
      const h = input.horizon
      if (h.elapsed <= 0) return (hovered = undefined)
      let best = -1, bestD = (14 * scale) ** 2
      const overHole = Math.hypot(x - cx, y - cy) < HOLE_R * scale
      // Only the past can be hovered: the future is still to come
      const iNow = Math.round(U_NOW * SAMPLES)
      for (let i = 0; i <= iNow; i++) {
        // The far side of the disk is hidden where the hole covers it
        if (overHole && Math.sin(spiral(i / SAMPLES).theta) <= 0) continue
        const dx = projected[i][0] - x, dy = projected[i][1] - y
        const d = dx * dx + dy * dy
        if (d < bestD) { bestD = d; best = i }
      }
      if (best < 0) return (hovered = undefined)
      const t = timeAtU(h, best / SAMPLES)
      const seg = h.segments.find(s => s.start <= t && t <= s.end)
      hovered = seg && { kind: seg.kind, start: seg.start, end: seg.end, x: projected[best][0], y: projected[best][1] }
      return hovered
    },

    draw(ctx, input, now, w, hgt) {
      const h = input.horizon
      const dt = lastNow ? Math.min(now - lastNow, 100) : 16
      lastNow = now
      scale = Math.min(w / SCENE_W, hgt / SCENE_H)
      cx = w / 2 + pointer[0] * 6
      cy = hgt / 2 + pointer[1] * 4
      tilt = TILT + pointer[1] * 0.025

      ctx.clearRect(0, 0, w, hgt)
      flare *= Math.exp(-dt / 700)
      drawStars(ctx, w, hgt, now, dt)
      drawHexGrid(ctx, w, hgt, now)
      if (h.elapsed <= 0) {
        drawVictims(ctx, now, dt); drawGas(ctx, dt, now, 'far'); drawHole(ctx, now)
        drawGas(ctx, dt, now, 'lensed'); drawGas(ctx, dt, now, 'near'); drawFlashes(ctx, dt)
        return
      }

      for (let i = 0; i <= SAMPLES; i++) {
        const { theta, r } = spiral(i / SAMPLES)
        const x = r * Math.cos(theta), y = r * Math.sin(theta) * tilt
        projected[i][0] = cx + (x * cosA - y * sinA) * scale
        projected[i][1] = cy + (x * sinA + y * cosA) * scale
      }
      drawDisk(ctx, h, false)
      drawLanes(ctx, h, false)
      drawFuture(ctx, input, now, false)
      drawMatter(ctx, h, dt, false)
      drawVictims(ctx, now, dt)
      drawGas(ctx, dt, now, 'far')
      drawHole(ctx, now)
      drawGas(ctx, dt, now, 'lensed')
      drawRadiation(ctx, h, dt)
      drawGas(ctx, dt, now, 'near')
      drawDisk(ctx, h, true)
      drawLanes(ctx, h, true)
      drawFuture(ctx, input, now, true)
      drawMatter(ctx, h, dt, true)
      drawMarkers(ctx, input, now)
      drawCache(ctx, input, now)
      drawShips(ctx, h, now, dt)
      drawNow(ctx, input, now)
      drawFlashes(ctx, dt)
    },
  }
}
