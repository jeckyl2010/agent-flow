'use client'

import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import {
  formatImpact, impactEquivalent, midpoint,
  type GridShare, type ImpactKind, type Range, type SessionImpacts,
} from '@/lib/eco-impact'
import { zoneName } from '@/lib/inference-zone'

const SIZE = 64
const RING_R = SIZE / 2 + 5
const RING_C = 2 * Math.PI * RING_R

interface MoonSpec {
  kind: ImpactKind
  label: string
  color: string
  icon: ReactNode
  about: string
}

const iconProps = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const MOONS: readonly MoonSpec[] = [
  {
    kind: 'energy', label: 'Electricity', color: COLORS.ecoEnergy,
    icon: <svg {...iconProps}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>,
    about: 'Energy the GPUs and servers drew to generate the answers, data center overhead included.',
  },
  {
    kind: 'gwp', label: 'Carbon footprint', color: COLORS.ecoCarbon,
    icon: <svg {...iconProps}><path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 8a4.5 4.5 0 0 1-.5 10z" /></svg>,
    about: 'Greenhouse gases from generating that electricity, plus a share of building the hardware.',
  },
  {
    kind: 'wcf', label: 'Water', color: COLORS.ecoWater,
    icon: <svg {...iconProps}><path d="M12 2.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>,
    about: 'Water evaporated to cool the data center and to produce its electricity.',
  },
  {
    kind: 'adpe', label: 'Metals & minerals', color: COLORS.ecoMetals,
    icon: <svg {...iconProps}><path d="M6 3h12l4 6-10 12L2 9z" /><path d="M2 9h20" /></svg>,
    about: 'Depletion of scarce metals and minerals, in antimony equivalent: mostly the hardware’s.',
  },
  {
    kind: 'pe', label: 'Primary energy', color: COLORS.ecoFossil,
    icon: <svg {...iconProps}><path d="M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 4.5-5 8 0 4.3 3 7 7 7z" /></svg>,
    about: 'Primary energy behind it, fossil fuels foremost: extracted, burned and lost on the way.',
  },
]

/** Index of the 1–2–5 step at or below the value: the milestones a moon celebrates crossing */
function milestoneIndex(v: number): number {
  if (v <= 0) return -Infinity
  const decade = Math.floor(Math.log10(v))
  const m = v / 10 ** decade
  return decade * 3 + (m >= 5 ? 2 : m >= 2 ? 1 : 0)
}

function milestoneValue(i: number): number {
  const decade = Math.floor(i / 3)
  return [1, 2, 5][i - decade * 3] * 10 ** decade
}

/** How far the value is from its last milestone to the next, 0 to 1, on a log scale */
function milestoneProgress(v: number): number {
  const i = milestoneIndex(v)
  if (!Number.isFinite(i)) return 0
  const lo = milestoneValue(i)
  const hi = milestoneValue(i + 1)
  return Math.log(v / lo) / Math.log(hi / lo)
}

/** How often a count-up shows a new figure: each repaints the moon's glowing text and ring */
const TWEEN_STEP_MS = 50

/** Eases toward the target; snaps when it falls (seeking back, a new session) */
function useTweened(target: number, ms = 900): number {
  const [value, setValue] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    if (target <= current.current) {
      current.current = target
      setValue(target)
      return
    }
    const from = current.current
    const start = performance.now()
    let raf = 0
    let shown = -Infinity
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms)
      current.current = from + (target - from) * (1 - (1 - k) ** 3)
      if (k === 1 || now - shown >= TWEEN_STEP_MS) { shown = now; setValue(current.current) }
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return value
}

interface Delta { id: number; text: string }

let nextDeltaId = 0

/** Down the top right of the main view, or across the top over the time horizon's black hole */
type MoonLayout = 'column' | 'row'

function Moon({ spec, range, index, footnote, grid, layout }: {
  spec: MoonSpec; range: Range; index: number; footnote: string; grid?: GridLabel; layout: MoonLayout
}) {
  const target = midpoint(range)
  const shown = useTweened(target)
  const [pulse, setPulse] = useState(0)
  const [burst, setBurst] = useState(0)
  const [deltas, setDeltas] = useState<Delta[]>([])
  const [hovered, setHovered] = useState(false)
  const previous = useRef(target)

  useEffect(() => {
    const before = previous.current
    previous.current = target
    if (before <= 0 || target <= before) return
    const d = formatImpact(spec.kind, target - before)
    setPulse(p => p + 1)
    const delta = { id: nextDeltaId++, text: `+${d.value} ${d.unit}` }
    setDeltas(list => [...list.slice(-2), delta])
    if (milestoneIndex(target) > milestoneIndex(before)) setBurst(b => b + 1)
  }, [target, spec.kind])

  const { value, unit } = formatImpact(spec.kind, shown)
  const progress = milestoneProgress(shown)
  const lo = formatImpact(spec.kind, range.min)
  const hi = formatImpact(spec.kind, range.max)
  const equivalent = impactEquivalent(spec.kind, target)
  const c = spec.color

  return (
    <div
      className="eco-moon relative"
      style={{ width: SIZE, height: SIZE, zIndex: hovered ? 2 : undefined, animation: `eco-enter 0.6s ${index * 0.08}s cubic-bezier(.2,1.4,.4,1) both` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Still at rest: a moon animates when its value changes, never continuously. Endless motion
          kept the GPU recompositing it every frame, the biggest cost of an idle view */}
      <div className="absolute inset-0">
        {/* Progress toward the next 1–2–5 milestone */}
        <svg className="absolute pointer-events-none" width={RING_R * 2 + 4} height={RING_R * 2 + 4}
          style={{ left: SIZE / 2 - RING_R - 2, top: SIZE / 2 - RING_R - 2, transform: 'rotate(-90deg)', overflow: 'visible' }}>
          <circle cx={RING_R + 2} cy={RING_R + 2} r={RING_R} fill="none" stroke={c + '18'} strokeWidth={1.5} />
          {/* Its glow, a wide faint stroke under it: a drop-shadow filter is redrawn each time it moves */}
          <circle cx={RING_R + 2} cy={RING_R + 2} r={RING_R} fill="none" stroke={c + '30'} strokeWidth={5}
            strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - progress)} />
          <circle cx={RING_R + 2} cy={RING_R + 2} r={RING_R} fill="none" stroke={c} strokeWidth={1.5}
            strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - progress)}
            style={{ opacity: 0.85 }} />
        </svg>

        {/* Milestone: shockwaves and sparks */}
        {burst > 0 && (
          <div key={`burst-${burst}`} className="absolute inset-0 pointer-events-none">
            {[0, 0.18].map(delay => (
              <div key={delay} className="absolute inset-0 rounded-full"
                style={{ border: `2px solid ${c}`, animation: `eco-ripple 1.1s ${delay}s ease-out both` }} />
            ))}
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="absolute rounded-full"
                style={{
                  width: 3, height: 3, left: SIZE / 2 - 1.5, top: SIZE / 2 - 1.5, background: c, boxShadow: `0 0 4px ${c}`,
                  ['--a' as string]: `${i * 36 + 8}deg`,
                  animation: `eco-spark 0.9s ${0.05 + (i % 3) * 0.04}s ease-out both`,
                }} />
            ))}
          </div>
        )}

        {/* The moon */}
        <div key={`pulse-${pulse}`} className="absolute inset-0 rounded-full flex flex-col items-center justify-center font-mono"
          style={{
            background: `radial-gradient(circle at 35% 30%, ${c}2e, ${COLORS.ecoMoonBg} 62%)`,
            border: `1px solid ${c}55`,
            boxShadow: `0 0 14px ${c}22, inset 0 0 10px ${c}14`,
            animation: pulse ? 'eco-breathe 0.7s ease-out' : undefined,
          }}>
          {pulse > 0 && <div className="absolute inset-0 rounded-full pointer-events-none"
            style={{ boxShadow: `0 0 22px ${c}, inset 0 0 14px ${c}88`, animation: 'eco-flash 0.9s ease-out both' }} />}
          <span style={{ color: c, opacity: 0.8, lineHeight: 1 }}>{spec.icon}</span>
          <span className="text-[14px] font-semibold tabular-nums" style={{ color: COLORS.holoHot, lineHeight: 1.25, textShadow: `0 0 6px ${c}88` }}>
            {value}
          </span>
          <span className="text-[8.5px]" style={{ color: c, opacity: 0.85, lineHeight: 1 }}>{unit}</span>
        </div>
      </div>

      {/* What each update added, drifting away from the moon: beside it in the column, under it in the row */}
      {deltas.map(d => (
        <div key={d.id} className="eco-delta-chip absolute font-mono text-[9px] whitespace-nowrap pointer-events-none"
          style={{
            ...(layout === 'column'
              ? { right: SIZE + 10, top: SIZE / 2 - 6, animation: 'eco-delta-rise 1.6s ease-out both' }
              : { left: -50, width: SIZE + 100, top: SIZE + 12, textAlign: 'center', animation: 'eco-delta-fall 1.6s ease-out both' }),
            color: c, textShadow: `0 0 6px ${c}`,
          }}
          onAnimationEnd={() => setDeltas(list => list.filter(x => x.id !== d.id))}>
          {d.text}
        </div>
      ))}

      {hovered && (
        <div className="glass-card absolute font-mono pointer-events-none"
          style={{
            ...(layout === 'column' ? { right: SIZE + 14, top: -6 } : { left: SIZE / 2 - 115, top: SIZE + 16 }),
            width: 230, padding: 10, zIndex: 1, borderColor: c + '40',
          }}>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider" style={{ color: c }}>
            {spec.icon}{spec.label.toUpperCase()}
          </div>
          <div className="mt-1.5 text-[16px] font-semibold" style={{ color: COLORS.holoHot }}>
            ~{formatImpact(spec.kind, target).value} <span className="text-[10px]" style={{ color: c }}>{formatImpact(spec.kind, target).unit}</span>
          </div>
          <div className="text-[9px]" style={{ color: COLORS.textDim }}>
            range {lo.value} {lo.unit} – {hi.value} {hi.unit}
          </div>
          {equivalent && <div className="mt-1 text-[9px]" style={{ color: COLORS.textPrimary }}>{equivalent}</div>}
          {grid && (
            <div className="mt-1.5 text-[9px] leading-snug" style={{ color: COLORS.textPrimary }}>
              <span style={{ color: c }}>⌖</span> {grid.name} · <span style={{ color: COLORS.textDim }}>{grid.basis}</span>
            </div>
          )}
          <div className="mt-2 text-[9px] leading-snug" style={{ color: COLORS.textDim }}>{spec.about}</div>
          <div className="mt-2 pt-2 text-[8.5px] leading-snug" style={{ color: COLORS.textMuted, borderTop: `1px solid ${COLORS.holoBorder08}` }}>
            {footnote}
          </div>
        </div>
      )}
    </div>
  )
}

interface GridLabel {
  /** "EU average grid", or "Swedish grid and others" when requests ran in more than one place */
  name: string
  /** Why: "Bedrock eu.* (cross-region)", "Anthropic API", "chosen" */
  basis: string
}

/** The grid most of the session's output was figured at, named for the moons */
function gridLabel(grids: GridShare[]): GridLabel | undefined {
  const [first] = grids
  if (!first) return undefined
  const more = grids.length > 1 ? ' and others' : ''
  const name = `${zoneName(first.zone)} grid`
  return { name: `${name}${more}`, basis: first.basis === 'chosen' ? 'chosen for all requests' : first.basis }
}

/** The space between moons, the same in the column and the row */
const GAP = 26
/** The time horizon's side panel: the row centres over the black hole beside it */
const HORIZON_PANEL = 330
/** The column's place: under the top bar, at the right edge */
const COLUMN_TOP = 64
const COLUMN_RIGHT = 22

function useViewport(): [number, number] | undefined {
  const [size, setSize] = useState<[number, number]>()
  useEffect(() => {
    const read = () => setSize([window.innerWidth, window.innerHeight])
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return size
}

/**
 * The session's environmental footprint, after EcoLogits: five moons that count up as requests
 * come in, flash what each added, and burst on crossing a 1–2–5 milestone. They stand in a column
 * at the top right of the main view, stepping aside for a right-hand panel (`rightInset`), and fly
 * into a row over the black hole when the time horizon opens, and back when it closes.
 */
export const EcoMoons = memo(function EcoMoons({ impacts, layout, rightInset = 0 }: {
  impacts: SessionImpacts; layout: MoonLayout; rightInset?: number
}) {
  const viewport = useViewport()
  if (impacts.outputTokens === 0 || !viewport) return null

  const notes = ['EcoLogits estimate from output tokens only: input and cache reads are not counted. Model sizes are estimated, hence the range.']
  // The grid the electricity was figured at: where the requests ran, or the one chosen
  const grid = gridLabel(impacts.grids)
  if (impacts.uncountedAgents > 0) notes.push(`${impacts.uncountedAgents} agent${impacts.uncountedAgents > 1 ? 's' : ''} on a model EcoLogits doesn’t cover left out.`)
  if (impacts.isPartial) notes.push('Some requests weren’t measured, so this is a floor.')
  const footnote = notes.join(' ')

  const width = viewport[0]
  const n = MOONS.length
  const rowLeft = (width - HORIZON_PANEL) / 2 - (n * SIZE + (n - 1) * GAP) / 2

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: layout === 'row' ? Z.horizon + 1 : Z.info }}>
      {MOONS.map((spec, i) => {
        const x = layout === 'column' ? width - COLUMN_RIGHT - SIZE - rightInset : rowLeft + i * (SIZE + GAP)
        const y = layout === 'column' ? COLUMN_TOP + i * (SIZE + GAP) : 56
        return (
          <div key={spec.kind} className="eco-flight absolute pointer-events-auto"
            style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px)`, transition: `transform 0.9s cubic-bezier(.65,0,.35,1) ${i * 0.07}s` }}>
            <Moon spec={spec} range={impacts.total[spec.kind]} index={i} footnote={footnote} grid={grid} layout={layout} />
          </div>
        )
      })}
    </div>
  )
})
