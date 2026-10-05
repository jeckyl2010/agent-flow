/**
 * The black hole, through the painter: the inner flow of hot gas, its far side lensed into a halo
 * over and under the shadow; the shadow and its photon ring; and Hawking radiation, each request
 * escaping as light. The same motion as the 2D hole; only the drawing differs.
 */
import { COLORS } from '@/lib/colors'
import type { TimeHorizon } from '@/lib/time-horizon'
import { DISK_ANGLE, GAS, GAS_IN, GAS_OUT, GAS_TILT, HOLE_R, type Photon, type Puff, type View } from '../shared'
import type { Painter } from '../../gl/painter'

/** The 2D scene drew its strokes in opacity steps of 1/24, dropping those that rounded to none */
const FAINTEST = 1 / 48

export function createHole(v: View, wake: (ms: number) => void) {
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
  function drawRadiation(p: Painter, h: TimeHorizon, dt: number) {
    const latest = h.emissions.at(-1)?.time ?? -Infinity
    if (radiatedUntil === undefined || latest < radiatedUntil) radiatedUntil = latest
    for (const e of h.emissions) {
      if (e.time <= radiatedUntil) continue
      emit(Math.round(Math.min(40, 6 + Math.log2(1 + e.outputTokens) * 3)))
      // As long as the burst's light takes to fade
      wake(4200)
    }
    radiatedUntil = latest
    if (!v.reducedMotion && Math.random() < dt * 0.004) emit(1)

    for (let i = photons.length - 1; i >= 0; i--) {
      const ph = photons[i]
      if (!v.reducedMotion) {
        ph.r += ph.speed * dt
        ph.angle += 0.00004 * dt
        ph.life -= dt / 4200
      }
      if (ph.life <= 0) { photons.splice(i, 1); continue }
      // Escaping light, redshifted as it climbs out: warm white turning violet and fading
      const cos = Math.cos(ph.angle), sin = Math.sin(ph.angle)
      const x = v.cx + cos * ph.r * v.scale
      const y = v.cy + sin * ph.r * v.scale
      const color = ph.violet ? COLORS.timeSubagents : COLORS.horizonHot
      p.disc(x, y, ph.size * v.scale * (0.6 + ph.life * 0.6), color, ph.life * 0.8, true)
      // A short streak back toward the horizon
      p.line(x, y, v.cx + cos * (ph.r - 14) * v.scale, v.cy + sin * (ph.r - 14) * v.scale, ph.size * v.scale * 0.7, color, ph.life * 0.25, true)
    }
  }

  const gasCos = Math.cos(DISK_ANGLE), gasSin = Math.sin(DISK_ANGLE)
  /** The film kept only a little of the Doppler asymmetry: so does this */
  const mildBeam = (theta: number) => 0.8 - 0.2 * Math.cos(theta)

  /**
   * The inner flow: hot gas orbiting at Keplerian speed (ω ∝ r^-3/2), so each clump it's born in
   * shears into a fibre; heating as it falls and fading through the horizon. Drawn in three passes:
   * the far half of the disk (behind the shadow), its light bent over the top and under the bottom
   * of the shadow, and the near half crossing in front of it.
   */
  function drawGas(p: Painter, dt: number, now: number, pass: 'far' | 'lensed' | 'near') {
    if (pass === 'near' && !v.reducedMotion) {
      if (now > clumpUntil) { clumpAngle = Math.random() * Math.PI * 2; clumpUntil = now + 250 + Math.random() * 400 }
      for (let i = 0; i < gas.length; i++) {
        const g = gas[i]
        g.theta += dt * 0.0016 * (GAS_IN / g.r) ** 1.5
        // Drifting in, quicker near the horizon, with a little turbulence
        g.r -= dt * (0.006 + 0.03 * (GAS_IN / g.r) ** 3) + Math.sin(g.theta * 4 + g.phase + now * 0.0013) * 0.0008 * dt
        g.age = Math.min(1, g.age + dt / 900)
        if (g.r < HOLE_R * 0.98) gas[i] = newPuff(false)
      }
    }
    const s = v.scale
    if (pass === 'lensed') {
      // The halo's glowing body, under its fibres
      const r = HOLE_R * s
      p.radial(v.cx, v.cy, r * 1.12, r * 2.5, [
        [0, COLORS.horizonHot, 0],
        [0.08, COLORS.horizonHot, Math.min(1, 0.2 + v.flare * 0.1)],
        [0.45, COLORS.horizonLight, 0.09],
        [1, COLORS.horizonLight, 0],
      ], true)
    }
    for (const g of gas) {
      const behind = Math.sin(g.theta) < 0
      if (pass === 'far' && !behind) continue
      if (pass === 'near' && behind) continue
      if (pass === 'lensed' && !behind) continue
      const f = (g.r - GAS_IN) / (GAS_OUT - GAS_IN)
      const heat = Math.max(0, Math.min(1, 1 - f))
      const fade = g.age * Math.max(0, Math.min(1, (g.r - HOLE_R) / (HOLE_R * 0.25)))
      const alpha = (0.05 + heat * heat * 0.22) * mildBeam(g.theta) * fade
      if (alpha < 0.01) continue
      const color = GAS_COLORS[Math.min(3, Math.floor(heat * 3.99))]
      // A fibre: the stretch of orbit the gas swept through, longer where it moves faster
      const sweep = 0.06 + 0.3 * (GAS_IN / g.r)
      if (pass !== 'lensed') {
        const a = Math.min(1, alpha * 1.5)
        if (a < FAINTEST) continue
        p.path()
        for (let i = 0; i <= 4; i++) {
          const t = g.theta - sweep * (1 - i / 4)
          const x = g.r * Math.cos(t), y = g.r * Math.sin(t) * GAS_TILT + g.z
          p.to(v.cx + (x * gasCos - y * gasSin) * s, v.cy + (x * gasSin + y * gasCos) * s, g.width * 1.2 * s, color, a)
        }
        p.stroke(true)
        continue
      }
      // The far side's light, bent into a ring round the shadow: over the top, and under the bottom
      const rho = HOLE_R * (1.22 + 0.95 * f ** 0.8)
      const over = Math.min(1, alpha * 2.2), under = Math.min(1, alpha * 1.3)
      if (over >= FAINTEST) {
        p.path()
        for (let i = 0; i <= 4; i++) {
          const t = g.theta - sweep * (1 - i / 4) + DISK_ANGLE
          p.to(v.cx + Math.cos(t) * rho * s, v.cy + Math.sin(t) * rho * s, g.width * 1.2 * s, color, over)
        }
        p.stroke(true)
      }
      if (under >= FAINTEST) {
        p.path()
        for (let i = 0; i <= 4; i++) {
          const t = -(g.theta - sweep * (1 - i / 4)) + DISK_ANGLE
          p.to(v.cx + Math.cos(t) * rho * 0.9 * s, v.cy + Math.sin(t) * rho * 0.9 * s, g.width * 0.9 * s, color, under)
        }
        p.stroke(true)
      }
    }
  }

  function drawHole(p: Painter, now: number) {
    const r = HOLE_R * v.scale
    // Bloom
    p.radial(v.cx, v.cy, r * 0.9, r * 3.2, [[0, COLORS.horizonLight, Math.min(1, 0.16 + v.flare * 0.12)], [1, COLORS.horizonLight, 0]], false)

    // The shadow: larger than the horizon, darkening into it
    p.radial(v.cx, v.cy, r * 0.96, r * 1.25, [[0, COLORS.horizonVoid, 1], [0.35, COLORS.horizonVoid, 0xb0 / 255], [1, COLORS.horizonVoid, 0]], false)
    p.disc(v.cx, v.cy, r * 0.97, COLORS.horizonVoid, 1, false)

    // The photon ring: uneven and alive, brighter on the side turning toward us, flaring as it feeds
    const glowAt = (a: number) => {
      const turbulence = 0.85 + 0.15 * Math.sin(a * 3 + now * 0.0021) * Math.sin(a * 7 - now * 0.0013)
      return Math.min(1, (0.8 - 0.2 * Math.cos(a)) * turbulence * (1 + v.flare * 0.8))
    }
    const ring = (color: string, alpha: number, width: number) => {
      p.path()
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2
        p.to(v.cx + Math.cos(a) * r * 1.02, v.cy + Math.sin(a) * r * 1.02, width * v.scale, color, Math.min(1, glowAt(a) * alpha))
      }
      p.stroke(true, true)
    }
    ring(COLORS.horizonLight, 0.16, 5 + v.flare * 6)
    ring(COLORS.horizonHot, 0.45, 2)
    ring(COLORS.horizonHot, 1, 0.9)
    // A fainter inner ring, light that went round once more
    p.path()
    const inner = Math.min(1, 0.18 + v.flare * 0.15)
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2
      p.to(v.cx + Math.cos(a) * r * 0.985, v.cy + Math.sin(a) * r * 0.985, 0.8 * v.scale, COLORS.horizonHot, inner)
    }
    p.stroke(true, true)
  }

  return { emit, drawRadiation, drawGas, drawHole }
}
