/**
 * What the time horizon's layers share: the scene's geometry and constants, its types, the batched
 * strokes, and the view, the camera and effects every layer draws through.
 */
import { COLORS } from '@/lib/colors'
import type { Consumption, TimeHorizon, TimeKind } from '@/lib/time-horizon'

export const KIND_COLOR: Record<TimeKind, string> = {
  thinking: COLORS.timeThinking,
  tools: COLORS.timeTools,
  subagents: COLORS.timeSubagents,
  permission: COLORS.timePermission,
  waiting: COLORS.timeWaiting,
}

// Disk geometry, in scene units: the scene is scaled to fit its canvas
export const SCENE_W = 1120
export const SCENE_H = 540
export const R_OUT = 480
export const R_IN = 150
export const TURNS = 2.6
export const TILT = 0.3
export const DISK_ANGLE = (-7 * Math.PI) / 180
export const HOLE_R = 44
/** The hot inner flow, between the horizon and the timeline */
export const GAS_IN = HOLE_R * 1.15
export const GAS_OUT = 250
export const GAS = 1400
/** The gas disk is seen almost edge on, as Gargantua's is: a thin band across the shadow */
export const GAS_TILT = 0.07
export const THETA_0 = Math.PI * 0.62
export const SAMPLES = 1400
export const MATTER = 320
export const STARS = 260

export interface Star { x: number; y: number; size: number; depth: number; phase: number; warm: boolean }
export interface Mote { u: number; offset: number; size: number }
/** A puff of hot gas in the inner flow: it orbits at its own Keplerian speed and drifts inward */
export interface Puff { r: number; theta: number; z: number; width: number; age: number; phase: number }
/** A star wandering too close: torn into a stream as it spirals in */
export interface Victim { angle: number; r: number; trail: Array<[number, number]>; size: number }
/** Light from something swallowed, spreading from where it crossed */
export interface Flash { x: number; y: number; age: number }
/** Hawking radiation: light leaking out from just above the horizon */
export interface Photon { angle: number; r: number; speed: number; life: number; size: number; violet: boolean }
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

export const hex = (a: number) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

/**
 * Strokes that share a style, gathered into one path each and drawn in one call:
 * thousands of small strokes, each its own trip to the GPU with its own style, become a few
 * dozen. Opacity is rounded to 1/24 steps and widths to a quarter pixel: no difference to the eye.
 */
export class Batch {
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
export const segment = (path: Path2D, x0: number, y0: number, x1: number, y1: number) => { path.moveTo(x0, y0); path.lineTo(x1, y1) }

/**
 * Where now sits on the disk. Outside it, the session so far trails back to the rim; inside it,
 * the time still to come spirals in to the horizon, where the context window fills and the
 * session's detail is compacted away.
 */
export const U_NOW = 0.42

/** Where u (0 at the rim, U_NOW at now, 1 at the horizon) sits on the disk: its angle and radius */
export function spiral(u: number): { theta: number; r: number } {
  return { theta: THETA_0 + u * TURNS * 2 * Math.PI, r: R_OUT - u * (R_OUT - R_IN) }
}

/** The disk's plane, turned a little from level */
export const DISK_COS = Math.cos(DISK_ANGLE)
export const DISK_SIN = Math.sin(DISK_ANGLE)

/**
 * The camera and the effects every layer draws through. Placed each frame (`place`); the disk's
 * samples are projected once a frame (`projectDisk`) and read by the layers and hit tests.
 */
export interface View {
  readonly reducedMotion: boolean
  scale: number
  cx: number
  cy: number
  /** A slight parallax tilt toward the pointer */
  tilt: number
  pointer: [number, number]
  /** The photon ring flares when the hole swallows something, then settles */
  flare: number
  /** Light from things swallowed, spreading from where they crossed */
  flashes: Flash[]
  /** The disk's samples on screen this frame: allocated once and rewritten in place, not 1,400
   *  new pairs a frame for the garbage collector */
  projected: Array<[number, number]>
  /** Reused every frame: strokes gathered by style, then drawn together */
  batch: Batch
  project(r: number, theta: number): [number, number]
  /** Brighter on the side turning toward the viewer, as Doppler beaming makes it */
  beaming(theta: number): number
  /** Where a past moment sits on the disk */
  pastU(h: TimeHorizon, t: number): number
  /** The past moment at a point of the disk outside now */
  timeAtU(h: TimeHorizon, u: number): number
  place(width: number, height: number): void
  projectDisk(): void
}

export function createView(reducedMotion: boolean): View {
  const v: View = {
    reducedMotion,
    scale: 1, cx: 0, cy: 0, tilt: TILT,
    pointer: [0, 0],
    flare: 0,
    flashes: [],
    projected: Array.from({ length: SAMPLES + 1 }, () => [0, 0]),
    batch: new Batch(),
    project(r, theta) {
      const x = r * Math.cos(theta)
      const y = r * Math.sin(theta) * v.tilt
      return [v.cx + (x * DISK_COS - y * DISK_SIN) * v.scale, v.cy + (x * DISK_SIN + y * DISK_COS) * v.scale]
    },
    beaming: theta => 0.62 - 0.38 * Math.cos(theta),
    pastU: (h, t) => U_NOW * (t - h.start) / h.elapsed,
    timeAtU: (h, u) => h.start + (u / U_NOW) * h.elapsed,
    place(width, height) {
      v.scale = Math.min(width / SCENE_W, height / SCENE_H)
      v.cx = width / 2 + v.pointer[0] * 6
      v.cy = height / 2 + v.pointer[1] * 4
      v.tilt = TILT + v.pointer[1] * 0.025
    },
    projectDisk() {
      for (let i = 0; i <= SAMPLES; i++) {
        const { theta, r } = spiral(i / SAMPLES)
        const x = r * Math.cos(theta), y = r * Math.sin(theta) * v.tilt
        v.projected[i][0] = v.cx + (x * DISK_COS - y * DISK_SIN) * v.scale
        v.projected[i][1] = v.cy + (x * DISK_SIN + y * DISK_COS) * v.scale
      }
    },
  }
  return v
}
