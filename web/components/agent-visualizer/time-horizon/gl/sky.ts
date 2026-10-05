/**
 * The time horizon's sky, through the painter: stars that drift, bend round the hole and are drawn
 * in and swallowed; the hex grid; stars torn apart as they spiral in; and the flash of anything
 * swallowed. The same motion as the 2D sky; only the drawing differs.
 */
import { COLORS } from '@/lib/colors'
import { HOLE_R, STARS, type Star, type Victim, type View } from '../shared'
import type { Painter } from '../../gl/painter'

export function createSky(v: View) {
  const stars: Star[] = Array.from({ length: STARS }, () => ({
    x: Math.random(), y: Math.random(), size: Math.random() * 1.4 + 0.3,
    depth: Math.random(), phase: Math.random() * Math.PI * 2, warm: Math.random() < 0.25,
  }))
  const victims: Victim[] = []
  let nextVictimAt = 0

  function drawStars(p: Painter, w: number, hgt: number, now: number, dt: number) {
    const holeR = HOLE_R * v.scale
    for (const s of stars) {
      // Drifting, with parallax toward the pointer, and twinkling below, unless motion is reduced
      const drift = v.reducedMotion ? 0 : now * 0.000004 * (0.3 + s.depth)
      let x = ((s.x + drift) % 1) * w + v.pointer[0] * 12 * s.depth
      let y = s.y * hgt + v.pointer[1] * 8 * s.depth
      const dx = x - v.cx, dy = y - v.cy
      const d = Math.hypot(dx, dy)
      // Gravity: a star that strays close is drawn in, swirling, and swallowed
      if (!v.reducedMotion && d < holeR * 9) {
        const pull = Math.min(3, 0.004 * dt * (holeR * 9 / d) ** 2)
        s.x += ((-dx / d) * pull + (-dy / d) * pull * 0.9) / w
        s.y += ((-dy / d) * pull + (dx / d) * pull * 0.9) / hgt
        if (d < holeR * 1.08) {
          v.flare = Math.min(1.5, v.flare + 0.06)
          s.x = Math.random(); s.y = Math.random() < 0.5 ? 0.02 : 0.98
          continue
        }
      }
      if (d < holeR * 1.05) continue
      // Gravitational lensing: light passing near the hole is bent outward around it
      const bent = d + (holeR * holeR * 1.6) / d
      x = v.cx + (dx / d) * bent
      y = v.cy + (dy / d) * bent
      const twinkle = v.reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(now * 0.0015 * (0.5 + s.depth) + s.phase)
      const near = Math.max(0, 1 - (d - holeR) / (holeR * 3))
      // Smeared into the ring and gone as it crosses
      const vanishing = Math.min(1, (d - holeR * 1.05) / (holeR * 0.5))
      const alpha = Math.max(0, Math.min(1, ((0.12 + s.depth * 0.5) * twinkle + near * 0.4) * vanishing))
      p.disc(x, y, s.size * (0.6 + s.depth * 0.6) * (1 + near * 0.8), s.warm ? COLORS.horizonLight : COLORS.holoBase, alpha, false)
    }
  }

  /** Every so often a star strays in and is torn apart: stretched into a stream that spirals down */
  function drawVictims(p: Painter, now: number, dt: number) {
    const holeR = HOLE_R * v.scale
    if (!v.reducedMotion && now > nextVictimAt) {
      if (nextVictimAt > 0) victims.push({ angle: Math.random() * Math.PI * 2, r: 220 + Math.random() * 90, trail: [], size: 1.6 + Math.random() * 1.6 })
      nextVictimAt = now + 7000 + Math.random() * 7000
    }
    for (let i = victims.length - 1; i >= 0; i--) {
      const victim = victims[i]
      // Faster and faster as it falls: the orbit tightens and the stream stretches
      victim.angle += dt * 0.0025 * (88 / victim.r) ** 1.5
      victim.r -= dt * 0.06 * (88 / victim.r)
      const x = v.cx + Math.cos(victim.angle) * victim.r * v.scale
      const y = v.cy + Math.sin(victim.angle) * victim.r * v.scale * 0.62
      victim.trail.push([x, y])
      if (victim.trail.length > 90) victim.trail.shift()
      // The stream: one stroke, widening and brightening toward the star
      const n = victim.trail.length
      if (n > 1) {
        p.path()
        for (let j = 0; j < n; j++) {
          const f = Math.max(1, j) / n
          p.to(victim.trail[j][0], victim.trail[j][1], f * victim.size * 2.2 * v.scale, f > 0.7 ? COLORS.horizonHot : COLORS.horizonLight, f * f * 0.55)
        }
        p.stroke(true)
      }
      p.disc(x, y, victim.size * v.scale, COLORS.horizonHot, 1, true)
      if (Math.hypot(x - v.cx, y - v.cy) < holeR * 1.02) {
        v.flare = Math.min(1.5, v.flare + 1)
        v.flashes.push({ x, y, age: 0 })
        victims.splice(i, 1)
      }
    }
  }

  function drawFlashes(p: Painter, dt: number) {
    for (let i = v.flashes.length - 1; i >= 0; i--) {
      const f = v.flashes[i]
      f.age += dt / 900
      if (f.age >= 1) { v.flashes.splice(i, 1); continue }
      const radius = (6 + f.age * 26) * v.scale
      p.radial(f.x, f.y, 0, radius, [[0, COLORS.horizonHot, (1 - f.age) * 0.75], [1, COLORS.horizonLight, 0]], true, 32)
    }
  }

  /** The hex grid: placed once for a size of view, then drawn each frame, breathing as a whole */
  let grid: { key: string; hexes: Array<[number, number, number]>; size: number } | undefined
  function drawHexGrid(p: Painter, w: number, hgt: number, now: number) {
    // Laid out around the view's center, without the pointer's parallax: the parallax only moves it
    const gx = w / 2, gy = hgt / 2
    const key = `${w}|${hgt}|${v.scale.toFixed(3)}`
    if (grid?.key !== key) {
      const size = 46 * v.scale
      const hh = size * Math.sqrt(3)
      const hexes: Array<[number, number, number]> = []
      for (let x = -size; x < w + size; x += size * 1.5) {
        const col = Math.round(x / (size * 1.5))
        for (let y = -hh; y < hgt + hh; y += hh) {
          const yy = y + (col % 2 ? hh / 2 : 0)
          const d = Math.hypot(x - gx, yy - gy) / (Math.max(w, hgt) * 0.55)
          // Strongest in a band around the disk, fading at the edges and into the hole
          const a = 0.07 * Math.max(0, 1 - Math.abs(d - 0.55) * 2.2)
          if (a >= 0.008) hexes.push([x, yy, a])
        }
      }
      grid = { key, hexes, size }
    }
    const breath = v.reducedMotion ? 0.85 : 0.75 + 0.25 * Math.sin(now * 0.0008)
    const ox = v.cx - gx, oy = v.cy - gy, r = grid.size * 0.42
    for (const [x, y, a] of grid.hexes) {
      p.path()
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i
        p.to(ox + x + r * Math.cos(ang), oy + y + r * Math.sin(ang), 0.5, COLORS.holoBase, a * breath)
      }
      p.stroke(false, true)
    }
  }

  return { drawStars, drawVictims, drawFlashes, drawHexGrid }
}
