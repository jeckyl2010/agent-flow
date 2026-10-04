/**
 * The black hole: the inner flow of hot gas, its far side lensed into a halo over and under the
 * shadow; the shadow and its photon ring; and Hawking radiation, each request escaping as light.
 */
import { COLORS } from '@/lib/colors'
import type { TimeHorizon } from '@/lib/time-horizon'
import { DISK_ANGLE, GAS, GAS_IN, GAS_OUT, GAS_TILT, HOLE_R, hex, type Photon, type Puff, type View } from './shared'

export function createHole(v: View) {
  const photons: Photon[] = []
  /** The latest request already radiated: requests before the view opened don't burst */
  let radiatedUntil: number | undefined
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
    const latest = h.emissions.at(-1)?.time ?? -Infinity
    if (radiatedUntil === undefined || latest < radiatedUntil) radiatedUntil = latest
    for (const e of h.emissions) {
      if (e.time <= radiatedUntil) continue
      emit(Math.round(Math.min(40, 6 + Math.log2(1 + e.outputTokens) * 3)))
    }
    radiatedUntil = latest
    if (!v.reducedMotion && Math.random() < dt * 0.004) emit(1)

    ctx.globalCompositeOperation = 'lighter'
    for (let i = photons.length - 1; i >= 0; i--) {
      const p = photons[i]
      if (!v.reducedMotion) {
        p.r += p.speed * dt
        p.angle += 0.00004 * dt
        p.life -= dt / 4200
      }
      if (p.life <= 0) { photons.splice(i, 1); continue }
      // Escaping light, redshifted as it climbs out: warm white turning violet and fading
      const x = v.cx + Math.cos(p.angle) * p.r * v.scale
      const y = v.cy + Math.sin(p.angle) * p.r * v.scale
      const color = p.violet ? COLORS.timeSubagents : COLORS.horizonHot
      ctx.fillStyle = color + hex(p.life * 0.8)
      ctx.beginPath(); ctx.arc(x, y, p.size * v.scale * (0.6 + p.life * 0.6), 0, Math.PI * 2); ctx.fill()
      // A short streak back toward the horizon
      ctx.strokeStyle = color + hex(p.life * 0.25)
      ctx.lineWidth = p.size * v.scale * 0.7
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(v.cx + Math.cos(p.angle) * (p.r - 14) * v.scale, v.cy + Math.sin(p.angle) * (p.r - 14) * v.scale)
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  const gasCos = Math.cos(DISK_ANGLE), gasSin = Math.sin(DISK_ANGLE)
  /** A point of the gas disk, seen almost edge on */
  const projectGas = (r: number, theta: number, z: number): [number, number] => {
    const x = r * Math.cos(theta), y = r * Math.sin(theta) * GAS_TILT + z
    return [v.cx + (x * gasCos - y * gasSin) * v.scale, v.cy + (x * gasSin + y * gasCos) * v.scale]
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
    if (pass === 'near' && !v.reducedMotion) {
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
      const r = HOLE_R * v.scale
      const halo = ctx.createRadialGradient(v.cx, v.cy, r * 1.12, v.cx, v.cy, r * 2.5)
      halo.addColorStop(0, COLORS.horizonHot + '00')
      halo.addColorStop(0.08, COLORS.horizonHot + hex(0.2 + v.flare * 0.1))
      halo.addColorStop(0.45, COLORS.horizonLight + hex(0.09))
      halo.addColorStop(1, COLORS.horizonLight + '00')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 2.5, 0, Math.PI * 2); ctx.fill()
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
        const path = v.batch.at(color, a, width * v.scale)
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
      fibre(t => [v.cx + Math.cos(t + DISK_ANGLE) * rho * v.scale, v.cy + Math.sin(t + DISK_ANGLE) * rho * v.scale], Math.min(1, alpha * 2.2), p.width * 1.2)
      fibre(t => [v.cx + Math.cos(-t + DISK_ANGLE) * rho * 0.9 * v.scale, v.cy + Math.sin(-t + DISK_ANGLE) * rho * 0.9 * v.scale], Math.min(1, alpha * 1.3), p.width * 0.9)
    }
    v.batch.stroke(ctx)
    ctx.globalCompositeOperation = 'source-over'
  }

  function drawHole(ctx: CanvasRenderingContext2D, now: number) {
    const r = HOLE_R * v.scale
    // Bloom
    const bloom = ctx.createRadialGradient(v.cx, v.cy, r * 0.9, v.cx, v.cy, r * 3.2)
    bloom.addColorStop(0, COLORS.horizonLight + hex(0.16 + v.flare * 0.12))
    bloom.addColorStop(1, COLORS.horizonLight + '00')
    ctx.fillStyle = bloom
    ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 3.2, 0, Math.PI * 2); ctx.fill()

    // The shadow: larger than the horizon, darkening into it
    const shadow = ctx.createRadialGradient(v.cx, v.cy, r * 0.96, v.cx, v.cy, r * 1.25)
    shadow.addColorStop(0, COLORS.horizonVoid + 'ff')
    shadow.addColorStop(0.35, COLORS.horizonVoid + 'b0')
    shadow.addColorStop(1, COLORS.horizonVoid + '00')
    ctx.fillStyle = shadow
    ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 1.25, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = COLORS.horizonVoid
    ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 0.97, 0, Math.PI * 2); ctx.fill()

    // The photon ring: uneven and alive, brighter on the side turning toward us, flaring as it feeds.
    // One stroke with its brightness in a conic gradient, so it stays smooth all the way round
    ctx.globalCompositeOperation = 'lighter'
    const glowAt = (a: number) => {
      const turbulence = 0.85 + 0.15 * Math.sin(a * 3 + now * 0.0021) * Math.sin(a * 7 - now * 0.0013)
      return Math.min(1, (0.8 - 0.2 * Math.cos(a)) * turbulence * (1 + v.flare * 0.8))
    }
    const ring = (color: string, alpha: number, width: number) => {
      const g = ctx.createConicGradient(0, v.cx, v.cy)
      for (let i = 0; i <= 48; i++) g.addColorStop(i / 48, color + hex(glowAt((i / 48) * Math.PI * 2) * alpha))
      ctx.strokeStyle = g
      ctx.lineWidth = width * v.scale
      ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 1.02, 0, Math.PI * 2); ctx.stroke()
    }
    ring(COLORS.horizonLight, 0.16, 5 + v.flare * 6)
    ring(COLORS.horizonHot, 0.45, 2)
    ring(COLORS.horizonHot, 1, 0.9)
    // A fainter inner ring, light that went round once more
    ctx.strokeStyle = COLORS.horizonHot + hex(0.18 + v.flare * 0.15)
    ctx.lineWidth = 0.8 * v.scale
    ctx.beginPath(); ctx.arc(v.cx, v.cy, r * 0.985, 0, Math.PI * 2); ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }

  return { emit, drawRadiation, drawGas, drawHole }
}
