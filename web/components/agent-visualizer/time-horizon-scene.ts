/**
 * The time horizon's scene, drawn on a canvas every frame: a black hole whose accretion disk is
 * the session's timeline. Now (T+0) sits out on the disk; the session so far trails back to the
 * rim, and the time to come spirals in to the horizon, where the context window fills.
 *
 * Composed of layers (time-horizon/), each with its own state, drawing through a shared view:
 * the sky, the black hole, the disk, and the subagents' ships. This file sets their order.
 */
import { HOLE_R, createView, type Scene } from './time-horizon/shared'
import { createSky } from './time-horizon/sky'
import { createHole } from './time-horizon/hole'
import { createDisk } from './time-horizon/disk'
import { createShips } from './time-horizon/ships'

export { KIND_COLOR, shipColor, type Hover, type Scene, type SceneInput } from './time-horizon/shared'

export function createScene(reducedMotion: boolean): Scene {
  const v = createView(reducedMotion)
  const sky = createSky(v)
  const hole = createHole(v)
  const disk = createDisk(v)
  const ships = createShips(v)
  let lastNow = 0

  return {
    pointer(x, y) { v.pointer = [x, y] },
    holeAt(x, y) { return Math.hypot(x - v.cx, y - v.cy) < HOLE_R * 2.3 * v.scale },
    holeCenter() { return [v.cx, v.cy] },
    pulse() {
      v.flare = Math.min(1.5, v.flare + 1.2)
      hole.emit(24)
    },
    hexAt: disk.hexAt,
    hoverHex: disk.hoverHex,
    shipAt: ships.shipAt,
    hit: disk.hit,

    draw(ctx, input, now, w, hgt) {
      const h = input.horizon
      const dt = lastNow ? Math.min(now - lastNow, 100) : 16
      lastNow = now
      v.place(w, hgt)

      ctx.clearRect(0, 0, w, hgt)
      v.flare *= Math.exp(-dt / 700)
      sky.drawStars(ctx, w, hgt, now, dt)
      sky.drawHexGrid(ctx, w, hgt, now)
      if (h.elapsed <= 0) {
        sky.drawVictims(ctx, now, dt); hole.drawGas(ctx, dt, now, 'far'); hole.drawHole(ctx, now)
        hole.drawGas(ctx, dt, now, 'lensed'); hole.drawGas(ctx, dt, now, 'near'); sky.drawFlashes(ctx, dt)
        return
      }

      v.projectDisk()
      // Back to front: the far halves behind the hole, the hole, then the near halves over it
      disk.drawDisk(ctx, h, false)
      ships.drawLanes(ctx, h, false)
      disk.drawFuture(ctx, input, now, false)
      disk.drawMatter(ctx, h, dt, false)
      sky.drawVictims(ctx, now, dt)
      hole.drawGas(ctx, dt, now, 'far')
      hole.drawHole(ctx, now)
      hole.drawGas(ctx, dt, now, 'lensed')
      hole.drawRadiation(ctx, h, dt)
      hole.drawGas(ctx, dt, now, 'near')
      disk.drawDisk(ctx, h, true)
      ships.drawLanes(ctx, h, true)
      disk.drawFuture(ctx, input, now, true)
      disk.drawMatter(ctx, h, dt, true)
      disk.drawMarkers(ctx, input, now)
      disk.drawCache(ctx, input, now)
      ships.drawShips(ctx, h, now, dt)
      disk.drawNow(ctx, input, now)
      sky.drawFlashes(ctx, dt)
    },
  }
}
