/**
 * The time horizon's scene on the GPU: the same layers in the same order as the 2D scene
 * (time-horizon-scene.ts), each drawing into one painter, the frame sent in one draw call.
 *
 * At rest, while the session waits for you, the scene runs on a slower clock and asks for fewer
 * frames: its motion slowed to a third at a third of the frames steps as far a frame as it does
 * awake, so it stays as smooth, at a third of the cost. Anything that happens wakes it at once.
 */
import { FRAME_RATE } from '@/lib/canvas-constants'
import { HOLE_R, createView, type Scene, type SceneInput } from '../shared'
import { Painter } from '../../gl/painter'
import { createSky } from './sky'
import { createHole } from './hole'
import { createDisk } from './disk'
import { createShips } from './ships'

/** The view's backdrop in the canvas's pixels: an elliptical gradient's center and radii */
export interface Backdrop { cx: number; cy: number; rx: number; ry: number }

export interface GlScene extends Omit<Scene, 'draw'> {
  draw(input: SceneInput, now: number, width: number, height: number, dpr: number, backdrop?: Backdrop): void
  /** The frames a second it wants now: full while anything happens, fewer at rest */
  frameRate(): number
  /** Keeps it awake a while: something on top of it is being read or used */
  engage(ms: number): void
  dispose(): void
}

/** At rest, the scene's motion runs at this share of its speed */
const CALM_PACE = FRAME_RATE.horizonCalm / FRAME_RATE.horizon
/** How long the session must be still before the scene settles */
const SETTLE_MS = 3000

/** The scene drawn with WebGL 2 on this canvas; undefined where WebGL 2 isn't available */
export function createGlScene(canvas: HTMLCanvasElement, reducedMotion: boolean): GlScene | undefined {
  const p = new Painter(canvas)
  if (!p.ok) return undefined
  const v = createView(reducedMotion)
  /** Real time, as of the last frame, and the time until which the scene stays awake */
  let realNow = 0
  let awakeUntil = 0
  const wake = (ms: number) => { awakeUntil = Math.max(awakeUntil, realNow + ms) }
  const sky = createSky(v)
  const hole = createHole(v, wake)
  const disk = createDisk(v, wake)
  const ships = createShips(v, wake)
  let lastNow = 0
  /** The scene's own clock, which its motion runs by, and how fast it runs against real time */
  let clock = 0
  let pace = 1

  return {
    pointer(x, y) { v.pointer = [x, y]; wake(2000) },
    holeAt(x, y) { return Math.hypot(x - v.cx, y - v.cy) < HOLE_R * 2.3 * v.scale },
    holeCenter() { return [v.cx, v.cy] },
    pulse() {
      v.flare = Math.min(1.5, v.flare + 1.2)
      hole.emit(24)
      wake(4200)
    },
    engage: wake,
    // Fewer frames only once the motion has slowed to match: before that they would step
    frameRate: () => (realNow > awakeUntil && pace < CALM_PACE * 1.05 ? FRAME_RATE.horizonCalm : FRAME_RATE.horizon),
    hexAt: disk.hexAt,
    hoverHex: disk.hoverHex,
    shipAt: ships.shipAt,
    hit: disk.hit,
    dispose: () => p.dispose(),

    draw(input, real, w, hgt, dpr, backdrop) {
      const h = input.horizon
      const realDt = lastNow ? Math.min(real - lastNow, 100) : 16
      lastNow = realNow = real
      // Awake while Claude works: thinking, running tools, or waiting on subagents
      const kind = h.segments.at(-1)?.kind
      if (kind === 'thinking' || kind === 'tools' || kind === 'subagents') wake(SETTLE_MS)
      // Waking is quick, so what woke it plays at its speed; settling is slow, so it isn't noticed
      const target = real > awakeUntil ? CALM_PACE : 1
      pace += (target - pace) * (1 - Math.exp(-realDt / (target > pace ? 250 : 1500)))
      const dt = realDt * pace
      clock += dt
      const now = clock
      v.place(w, hgt)
      p.begin(w, hgt, dpr)
      // The canvas is opaque: it starts from the view's backdrop
      const b = backdrop ?? { cx: w / 2, cy: hgt / 2, rx: w, ry: hgt }
      p.backdrop(b.cx, b.cy, b.rx, b.ry)

      v.flare *= Math.exp(-dt / 700)
      sky.drawStars(p, w, hgt, now, dt)
      sky.drawHexGrid(p, w, hgt, now)
      if (h.elapsed <= 0) {
        sky.drawVictims(p, now, dt); hole.drawGas(p, dt, now, 'far'); hole.drawHole(p, now)
        hole.drawGas(p, dt, now, 'lensed'); hole.drawGas(p, dt, now, 'near'); sky.drawFlashes(p, dt)
        p.end()
        return
      }

      v.projectDisk()
      // Back to front: the far halves behind the hole, the hole, then the near halves over it
      disk.drawDisk(p, h, false)
      ships.drawLanes(p, h, false)
      disk.drawFuture(p, input, now, false)
      disk.drawMatter(p, h, dt, false)
      sky.drawVictims(p, now, dt)
      hole.drawGas(p, dt, now, 'far')
      hole.drawHole(p, now)
      hole.drawGas(p, dt, now, 'lensed')
      hole.drawRadiation(p, h, dt)
      hole.drawGas(p, dt, now, 'near')
      disk.drawDisk(p, h, true)
      ships.drawLanes(p, h, true)
      disk.drawFuture(p, input, now, true)
      disk.drawMatter(p, h, dt, true)
      disk.drawMarkers(p, input, now)
      disk.drawCache(p, input, now)
      ships.drawShips(p, h, now, dt)
      disk.drawNow(p, input, now)
      sky.drawFlashes(p, dt)
      p.end()
    },
  }
}
