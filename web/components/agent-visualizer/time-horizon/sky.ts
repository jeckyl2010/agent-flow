/**
 * The time horizon's sky: stars that drift, bend round the hole and are drawn in and swallowed; the
 * hex grid; stars torn apart as they spiral in; and the flash of anything swallowed.
 */
import { COLORS } from '@/lib/colors'
import { HOLE_R, STARS, hex, type Star, type Victim, type View } from './shared'

export function createSky(v: View) {
  const stars: Star[] = Array.from({ length: STARS }, () => ({
    x: Math.random(), y: Math.random(), size: Math.random() * 1.4 + 0.3,
    depth: Math.random(), phase: Math.random() * Math.PI * 2, warm: Math.random() < 0.25,
  }))
  const victims: Victim[] = []
  let nextVictimAt = 0

  function drawStars(ctx: CanvasRenderingContext2D, w: number, hgt: number, now: number, dt: number) {
    const holeR = HOLE_R * v.scale
    for (const s of stars) {
      // Drift, with parallax toward the pointer
      // Drifting, and twinkling below, unless motion is reduced
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
      // One circle at a time: circles have a fast path that a batched path of many would lose
      ctx.fillStyle = (s.warm ? COLORS.horizonLight : COLORS.holoBase) + hex(((0.12 + s.depth * 0.5) * twinkle + near * 0.4) * vanishing)
      ctx.beginPath()
      ctx.arc(x, y, s.size * (0.6 + s.depth * 0.6) * (1 + near * 0.8), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Every so often a star strays in and is torn apart: stretched into a stream that spirals down */
  function drawVictims(ctx: CanvasRenderingContext2D, now: number, dt: number) {
    const holeR = HOLE_R * v.scale
    if (!v.reducedMotion && now > nextVictimAt) {
      if (nextVictimAt > 0) victims.push({ angle: Math.random() * Math.PI * 2, r: 220 + Math.random() * 90, trail: [], size: 1.6 + Math.random() * 1.6 })
      nextVictimAt = now + 7000 + Math.random() * 7000
    }
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'butt'
    for (let i = victims.length - 1; i >= 0; i--) {
      const victim = victims[i]
      // Faster and faster as it falls: the orbit tightens and the stream stretches
      victim.angle += dt * 0.0025 * (88 / victim.r) ** 1.5
      victim.r -= dt * 0.06 * (88 / victim.r)
      const x = v.cx + Math.cos(victim.angle) * victim.r * v.scale
      const y = v.cy + Math.sin(victim.angle) * victim.r * v.scale * 0.62
      victim.trail.push([x, y])
      if (victim.trail.length > 90) victim.trail.shift()
      for (let j = 1; j < victim.trail.length; j++) {
        const f = j / victim.trail.length
        ctx.strokeStyle = (f > 0.7 ? COLORS.horizonHot : COLORS.horizonLight) + hex(f * f * 0.55)
        ctx.lineWidth = f * victim.size * 2.2 * v.scale
        ctx.beginPath(); ctx.moveTo(victim.trail[j - 1][0], victim.trail[j - 1][1]); ctx.lineTo(victim.trail[j][0], victim.trail[j][1]); ctx.stroke()
      }
      ctx.fillStyle = COLORS.horizonHot
      ctx.beginPath(); ctx.arc(x, y, victim.size * v.scale, 0, Math.PI * 2); ctx.fill()
      if (Math.hypot(x - v.cx, y - v.cy) < holeR * 1.02) {
        v.flare = Math.min(1.5, v.flare + 1)
        v.flashes.push({ x, y, age: 0 })
        victims.splice(i, 1)
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawFlashes(ctx: CanvasRenderingContext2D, dt: number) {
    ctx.globalCompositeOperation = 'lighter'
    for (let i = v.flashes.length - 1; i >= 0; i--) {
      const f = v.flashes[i]
      f.age += dt / 900
      if (f.age >= 1) { v.flashes.splice(i, 1); continue }
      const radius = (6 + f.age * 26) * v.scale
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
    const key = `${w}|${hgt}|${dpr}|${v.scale.toFixed(3)}`
    if (gridCache?.key !== key) {
      const canvas = gridCache?.canvas ?? document.createElement('canvas')
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(hgt * dpr)
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const size = 46 * v.scale
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
          const path = v.batch.at(COLORS.holoBase, a, 0.5)
          for (let i = 0; i < 6; i++) {
            const ang = (Math.PI / 3) * i
            const px = x + size * 0.42 * Math.cos(ang), py = yy + size * 0.42 * Math.sin(ang)
            if (i === 0) path.moveTo(px, py)
            else path.lineTo(px, py)
          }
          path.closePath()
        }
      }
      v.batch.stroke(g)
      gridCache = { canvas, key }
    }
    ctx.save()
    ctx.globalAlpha = v.reducedMotion ? 0.85 : 0.75 + 0.25 * Math.sin(now * 0.0008)
    ctx.drawImage(gridCache.canvas, v.cx - gx, v.cy - gy, w, hgt)
    ctx.restore()
  }

  return { drawStars, drawVictims, drawFlashes, drawHexGrid }
}
