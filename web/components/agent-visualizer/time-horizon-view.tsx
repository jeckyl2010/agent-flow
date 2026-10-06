'use client'

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { compactionLabel } from '@/lib/compaction'
import { Z, type Agent, type SimulationEvent } from '@/lib/agent-types'
import { FRAME_RATE } from '@/lib/canvas-constants'
import { frameLimiter } from '@/lib/frame-limiter'
import { COLORS } from '@/lib/colors'
import { formatCount } from '@/lib/utils'
import {
  timeHorizon, formatDuration, longest, predictConsumption, parallelism, runKey, TIME_KINDS,
  type Consumption, type TimeHorizon, type TimeKind,
} from '@/lib/time-horizon'
import { sessionCosts } from '@/lib/session-costs'
import { cachedPromptCost } from '@/lib/model-pricing'
import { chosenGrid, sessionImpacts, midpoint, formatImpact } from '@/lib/eco-impact'
import { createScene, shipColor, KIND_COLOR, type Hover, type Scene, type SceneInput } from './time-horizon-scene'
import { createGlScene, type Backdrop, type GlScene } from './time-horizon/gl/scene'

const KIND_STYLE: Record<TimeKind, { label: string; about: string }> = {
  thinking: { label: 'Thinking', about: 'The model reasoning and writing' },
  tools: { label: 'Tools', about: 'Tools running: commands, reads, edits, searches' },
  subagents: { label: 'Subagents', about: 'Waiting on subagents it sent out' },
  permission: { label: 'Permission', about: 'A permission dialog waiting for you' },
  waiting: { label: 'Waiting for you', about: 'Between turns: your move' },
}

/**
 * The view's backdrop, `radial-gradient(ellipse at 42% 52%, …)` over the whole view, placed in the
 * canvas's pixels: its center, and radii through the farthest corner (CSS's default size), keeping
 * the aspect of the farthest sides. By layout offsets, which the view's entrance doesn't move
 */
function backdropIn(canvas: HTMLElement, root: HTMLElement): Backdrop {
  let x = 0, y = 0
  for (let el: HTMLElement | null = canvas; el && el !== root; el = el.offsetParent as HTMLElement | null) { x += el.offsetLeft; y += el.offsetTop }
  const W = root.clientWidth, H = root.clientHeight
  return { cx: W * 0.42 - x, cy: H * 0.52 - y, rx: Math.SQRT2 * W * 0.58, ry: Math.SQRT2 * H * 0.52 }
}

/** A card's place on the canvas: the point it opens beside, and the canvas's size when it opened */
interface Placed { at: [number, number]; bounds: [number, number] }

/** The black hole, drawn every frame; the data arrives through a ref so the loop never restarts */
function HorizonCanvas({ input, agents }: { input: SceneInput; agents: Map<string, Agent> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  /** The scene's hit tests and pointer, whichever renderer draws it */
  const sceneRef = useRef<Omit<Scene, 'draw'> | null>(null)
  const [hover, setHover] = useState<Hover | undefined>()
  const [overHole, setOverHole] = useState(false)
  /** Where the insights card opens, beside the hole; closed when undefined */
  const [insightsAt, setInsightsAt] = useState<Placed | undefined>()
  const [overHex, setOverHex] = useState(false)
  /** The prompt whose card is open, by its turn's start (list positions shift when the event log
   *  drops its oldest events), and where its hexagon is */
  const [promptCard, setPromptCard] = useState<(Placed & { start: number }) | undefined>()
  const [overShip, setOverShip] = useState(false)
  /** The subagent whose card is open, by its run's key, and where it was clicked */
  const [shipCard, setShipCard] = useState<(Placed & { key: string }) | undefined>()

  // A compaction while the view is open: the hole flares and throws off gas, the detail swallowed
  const compactions = input.horizon.compactions.length
  const compactionsSeen = useRef(compactions)
  useEffect(() => {
    if (compactions > compactionsSeen.current) sceneRef.current?.pulse()
    compactionsSeen.current = compactions
  }, [compactions])
  /** The canvas's size, read when a card opens: cards keep inside it */
  const boundsNow = (): [number, number] => [canvasRef.current?.clientWidth ?? 0, canvasRef.current?.clientHeight ?? 0]

  // Escape closes a card before it closes the view
  const cardOpen = !!insightsAt || !!promptCard || !!shipCard
  const cardOpenRef = useRef(cardOpen)
  cardOpenRef.current = cardOpen
  useEffect(() => {
    if (!cardOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setInsightsAt(undefined)
      setPromptCard(undefined)
      setShipCard(undefined)
    }
    // In the capture phase, so it runs before the view's own Escape
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cardOpen])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // On the GPU where WebGL 2 is there; the 2D scene otherwise, or when asked for (?horizon=2d)
    const gl = new URLSearchParams(window.location.search).get('horizon') === '2d' ? undefined : createGlScene(canvas, reduced)
    const ctx = gl ? null : canvas.getContext('2d')
    if (!gl && !ctx) return
    const scene: Scene | GlScene = gl ?? createScene(reduced)
    sceneRef.current = scene
    let raf = 0
    const limit = frameLimiter()
    /** The view's backdrop, in the canvas's pixels: the GL canvas is opaque, so it draws it too */
    let backdrop: Backdrop | undefined
    let sized = ''
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      // A card open over the scene is something being read: the scene stays awake under it
      if (gl && cardOpenRef.current) gl.engage(1000)
      if (!limit(now, gl ? gl.frameRate() : FRAME_RATE.horizon)) return
      const dpr = window.devicePixelRatio || 1
      const { clientWidth: w, clientHeight: h } = canvas
      if (gl) {
        const root = canvas.closest<HTMLElement>('[data-horizon-root]')
        if (root && sized !== `${w}|${h}|${root.clientWidth}|${root.clientHeight}`) {
          sized = `${w}|${h}|${root.clientWidth}|${root.clientHeight}`
          backdrop = backdropIn(canvas, root)
        }
        gl.draw(inputRef.current, now, w, h, dpr, backdrop)
        return
      }
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ;(scene as Scene).draw(ctx!, inputRef.current, now, w, h)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); gl?.dispose() }
  }, [])

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    sceneRef.current?.pointer((x / rect.width) * 2 - 1, (y / rect.height) * 2 - 1)
    const ship = sceneRef.current?.shipAt(x, y)
    setOverShip(!!ship)
    const hex = ship ? undefined : sceneRef.current?.hexAt(x, y)
    sceneRef.current?.hoverHex(hex?.start)
    setOverHex(!!hex)
    const hit = ship || hex ? undefined : sceneRef.current?.hit(x, y, inputRef.current)
    setHover(prev => (prev?.start === hit?.start ? prev : hit))
    setOverHole(!ship && !hex && !hit && !!sceneRef.current?.holeAt(x, y))
  }

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    const ship = scene?.shipAt(x, y)
    if (ship) {
      setInsightsAt(undefined); setPromptCard(undefined)
      setShipCard(prev => (prev?.key === ship.key ? undefined : { ...ship, at: [ship.x, ship.y], bounds: boundsNow() }))
      return
    }
    setShipCard(undefined)
    const hex = scene?.hexAt(x, y)
    if (hex) {
      setInsightsAt(undefined)
      setPromptCard(prev => (prev?.start === hex.start ? undefined : { start: hex.start, at: [hex.x, hex.y], bounds: boundsNow() }))
      return
    }
    setPromptCard(undefined)
    if (!scene || hover || !scene.holeAt(x, y)) {
      setInsightsAt(undefined)
      return
    }
    scene.pulse()
    setInsightsAt(prev => (prev ? undefined : { at: scene.holeCenter(), bounds: boundsNow() }))
  }

  const h = input.horizon
  const promptIndex = promptCard ? h.turnLog.findIndex(t => t.start === promptCard.start) : -1
  const shipIndex = shipCard ? h.subagents.findIndex(run => runKey(run) === shipCard.key) : -1
  return (
    <div data-horizon-canvas className="relative w-full h-full">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ cursor: hover || overHole || overHex || overShip ? 'pointer' : 'default' }}
        onMouseMove={onMove} onClick={onClick}
        onMouseLeave={() => {
          setHover(undefined); setOverHole(false); setOverHex(false); setOverShip(false)
          sceneRef.current?.hit(-1e6, -1e6, inputRef.current); sceneRef.current?.hoverHex(undefined)
        }} />
      {insightsAt && (
        <HoleInsights h={h} agents={agents} consumption={input.consumption} at={insightsAt.at} bounds={insightsAt.bounds}
          onClose={() => setInsightsAt(undefined)} />
      )}
      {shipCard && shipIndex >= 0 && (
        <SubagentCard h={h} index={shipIndex} at={shipCard.at} bounds={shipCard.bounds} onClose={() => setShipCard(undefined)} />
      )}
      {promptCard && promptIndex >= 0 && (
        <PromptCard h={h} index={promptIndex} at={promptCard.at} bounds={promptCard.bounds} onClose={() => setPromptCard(undefined)} />
      )}
      {hover && (
        <div className="glass-card absolute font-mono pointer-events-none"
          style={{ left: hover.x + 16, top: hover.y - 54, padding: '8px 10px', borderColor: KIND_COLOR[hover.kind] + '66' }}>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider" style={{ color: KIND_COLOR[hover.kind] }}>
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: KIND_COLOR[hover.kind], boxShadow: `0 0 6px ${KIND_COLOR[hover.kind]}` }} />
            {KIND_STYLE[hover.kind].label.toUpperCase()}
          </div>
          <div className="mt-1 text-[13px] font-semibold" style={{ color: COLORS.holoHot }}>{formatDuration(hover.end - hover.start)}</div>
          <div className="text-[9px]" style={{ color: COLORS.textDim }}>
            T−{formatDuration(h.start + h.elapsed - hover.start)} → {hover.end >= h.start + h.elapsed ? 'NOW' : `T−${formatDuration(h.start + h.elapsed - hover.end)}`}
          </div>
        </div>
      )}
    </div>
  )
}

/** What the API measured for the whole session, summed over its agents */
function measuredUsage(agents: Map<string, Agent>) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, requests = 0
  for (const a of agents.values()) {
    if (!a.spend) continue
    input += a.spend.input; output += a.spend.output
    cacheRead += a.spend.cacheRead; cacheWrite += a.spend.cacheWrite
    requests += a.spend.steps
  }
  return { input, output, cacheRead, cacheWrite, requests, mass: input + cacheRead + cacheWrite }
}

/** One reading on the insights card */
function Reading({ label, value, note, color = COLORS.holoHot }: { label: string; value: string; note?: string; color?: string }) {
  return (
    <div>
      <div className="text-[8.5px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="text-[13px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      {note && <div className="text-[8.5px] leading-snug" style={{ color: COLORS.textDim }}>{note}</div>}
    </div>
  )
}

const PROMPT_MAX = 420

/** A card's place beside a point on the canvas: to its right, or to its left where it would run
 *  off the canvas (under the side panel), and never above the top */
function placeCard(at: [number, number], bounds: [number, number], width: number, gap: number, rise: number) {
  const fitsRight = !bounds[0] || at[0] + gap + width <= bounds[0] - 8
  return { left: fitsRight ? at[0] + gap : Math.max(8, at[0] - gap - width), top: Math.max(8, at[1] - rise), width }
}

/** One of your prompts, opened from its hexagon: what you asked, and what it set off */
function PromptCard({ h, index, at, bounds, onClose }: {
  h: TimeHorizon; index: number; at: [number, number]; bounds: [number, number]; onClose: () => void
}) {
  const turn = h.turnLog[index]
  const now = h.start + h.elapsed
  const prompt = turn.prompt && turn.prompt.length > PROMPT_MAX ? `${turn.prompt.slice(0, PROMPT_MAX)}…` : turn.prompt
  return (
    <div className="glass-card absolute font-mono th-enter" onClick={e => e.stopPropagation()}
      style={{
        ...placeCard(at, bounds, 290, 18, 40), padding: 14,
        background: 'rgba(6, 8, 18, 0.94)', borderColor: COLORS.holoBright + '55', boxShadow: `0 0 24px ${COLORS.holoBright}18`,
      }}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.25em]" style={{ color: COLORS.holoBright }}>
          PROMPT {index + 1} OF {h.turnLog.length}
        </span>
        <button onClick={onClose} className="text-[11px]" style={{ color: COLORS.textMuted }} aria-label="Close prompt">✕</button>
      </div>
      <div className="text-[9px]" style={{ color: COLORS.textDim }}>
        T−{formatDuration(now - turn.start)}{turn.end === undefined ? ' · still running' : ''}
      </div>
      <div className="mt-2 text-[11px] leading-snug whitespace-pre-wrap break-words max-h-[160px] overflow-y-auto"
        style={{ color: COLORS.textPrimary, fontStyle: prompt ? 'normal' : 'italic' }}>
        {prompt ?? 'Started before Agent Flow was watching, or without a message of yours'}
      </div>
      <div className="mt-3 pt-3 grid grid-cols-2 gap-x-4 gap-y-2" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
        <Reading label="WORK" value={formatDuration(turn.work)} note="Claude working on it" color={COLORS.timeThinking} />
        <Reading label="REQUESTS" value={String(turn.requests)} note="Model calls, every agent's" />
        <Reading label="TOOL CALLS" value={String(turn.tools)} color={COLORS.timeTools} />
        <Reading label="WRITTEN" value={`${formatCount(turn.outputTokens)} tok`} color={COLORS.horizonLight} />
      </div>
    </div>
  )
}

/** A subagent's log, opened from its ship or its lane: what it was sent for, and what it brought back */
function SubagentCard({ h, index, at, bounds, onClose }: {
  h: TimeHorizon; index: number; at: [number, number]; bounds: [number, number]; onClose: () => void
}) {
  const run = h.subagents[index]
  const now = h.start + h.elapsed
  const color = shipColor(run.model)
  return (
    <div className="glass-card absolute font-mono th-enter" onClick={e => e.stopPropagation()}
      style={{
        ...placeCard(at, bounds, 290, 18, 40), padding: 14,
        background: 'rgba(6, 8, 18, 0.94)', borderColor: color + '55', boxShadow: `0 0 24px ${color}18`,
      }}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.2em] truncate" style={{ color }}>{run.name.toUpperCase()}</span>
        <button onClick={onClose} className="text-[11px] ml-2" style={{ color: COLORS.textMuted }} aria-label="Close subagent">✕</button>
      </div>
      <div className="text-[9px]" style={{ color: COLORS.textDim }}>
        {run.model ?? 'Subagent'} · {run.end === undefined ? `out for ${formatDuration(now - run.start)}` : `back T−${formatDuration(now - run.end)}`}
      </div>
      {run.task && (
        <div className="mt-2">
          <div className="text-[8.5px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>SENT TO</div>
          <div className="text-[11px] leading-snug" style={{ color: COLORS.textPrimary }}>{run.task}</div>
        </div>
      )}
      {run.summary && (
        <div className="mt-2">
          <div className="text-[8.5px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>BROUGHT BACK</div>
          <div className="text-[11px] leading-snug max-h-[110px] overflow-y-auto" style={{ color: COLORS.textPrimary }}>{run.summary}</div>
        </div>
      )}
      <div className="mt-3 pt-3 grid grid-cols-2 gap-x-4 gap-y-2" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
        <Reading label="TIME OUT" value={formatDuration((run.end ?? now) - run.start)} color={color} />
        <Reading label="REQUESTS" value={String(run.requests)} />
        <Reading label="TOOL CALLS" value={String(run.tools)} color={COLORS.timeTools} />
        <Reading label="WRITTEN" value={`${formatCount(run.outputTokens)} tok`} color={COLORS.horizonLight} />
      </div>
    </div>
  )
}

/** Agent time per hour of the span, in words: minutes up to the hour, then hours, as dilation passes it */
function perHour(agentTime: number, elapsed: number): string {
  const minutes = elapsed > 0 ? (agentTime / elapsed) * 60 : 0
  return minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} hours`
}

/** What the black hole holds: the session's measured numbers, read as its physics. Opened by clicking it */
function HoleInsights({ h, agents, consumption, at, bounds, onClose }: {
  h: TimeHorizon; agents: Map<string, Agent>; consumption?: Consumption; at: [number, number]; bounds: [number, number]; onClose: () => void
}) {
  const { output, cacheRead, requests, mass } = measuredUsage(agents)
  const cost = sessionCosts(agents).total
  const energy = midpoint(sessionImpacts(agents, chosenGrid()).total.energy)
  const working = h.elapsed - h.totals.waiting
  const perTurn = h.turns > 0 ? formatImpact('energy', energy / h.turns) : undefined
  const hours = h.elapsed / 3600

  return (
    <div className="glass-card absolute font-mono th-enter" onClick={e => e.stopPropagation()}
      style={{
        ...placeCard(at, bounds, 300, 120, 170), padding: 14,
        // Opaque enough that the disk's labels don't show through it
        background: 'rgba(6, 8, 18, 0.94)',
        borderColor: COLORS.horizonLight + '55', boxShadow: `0 0 30px ${COLORS.horizonLight}18`,
      }}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.25em]" style={{ color: COLORS.horizonLight }}>EVENT HORIZON</span>
        <button onClick={onClose} className="text-[11px]" style={{ color: COLORS.textMuted }} aria-label="Close insights">✕</button>
      </div>
      <div className="text-[9px] mb-3" style={{ color: COLORS.textDim }}>The session, read as a black hole</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Reading label="MASS" value={`${formatCount(mass)} tok`} note="All it has taken in: input, cache reads and writes" />
        <Reading label="HAWKING RADIATION" value={`${formatCount(output)} tok`}
          note={mass > 0 ? `${((output / mass) * 100).toFixed(1)}% radiative efficiency: output for input` : undefined} color={COLORS.horizonLight} />
        <Reading label="CACHE" value={mass > 0 ? `${Math.round((cacheRead / mass) * 100)}%` : '–'} note="Of its input, served from the prompt cache" />
        <Reading label="COST" value={`${cost.isExact ? '' : '~'}$${cost.cost.toFixed(2)}`}
          note={hours > 0.05 ? `$${(cost.cost / hours).toFixed(2)} per hour of mission time` : undefined} color={COLORS.complete} />
        <Reading label="REQUESTS" value={String(requests)} note={requests > 0 ? `${formatCount(output / requests)} tokens written each` : undefined} />
        <Reading label="TURNS" value={String(h.turns)} note={h.turns > 0 ? `${formatDuration(working / h.turns)} of work each, on average` : undefined} />
        {h.subagents.length > 0 && (() => {
          const p = parallelism(h)
          return (
            <Reading label="PARALLELISM" value={`${p.peak} at once`}
              note={`${h.subagents.length} subagent${h.subagents.length === 1 ? '' : 's'}: ${perHour(p.agentTime, h.elapsed)} of agent time an hour`}
              color={COLORS.timeSubagents} />
          )
        })()}
        <Reading label="CONTEXT" value={consumption ? `${Math.round(consumption.fill * 100)}% full` : 'steady'}
          note={consumption ? `${h.compactThreshold ? 'Compacts' : 'Full'} in ~${formatDuration(consumption.eta)}, at ${formatCount(consumption.rate)} tokens a minute` : 'Not growing: no inspiral'}
          color={COLORS.timePermission} />
        {h.compactions.length > 0 && (
          <Reading label="WORMHOLES" value={`${h.compactions.length} jump${h.compactions.length === 1 ? '' : 's'}`}
            note={`Latest ${compactionLabel(h.compactions.at(-1)!)}: the detail before it is gone`}
            color={COLORS.wormholeRim} />
        )}
      </div>
      <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
        <div className="text-[8.5px] tracking-[0.2em] mb-1.5" style={{ color: COLORS.textMuted }}>RECORDS</div>
        {(['thinking', 'tools', 'waiting'] as const).map(kind => (
          <div key={kind} className="flex justify-between text-[10px]">
            <span style={{ color: KIND_COLOR[kind] === COLORS.timeWaiting ? COLORS.textDim : KIND_COLOR[kind] }}>
              Longest {kind === 'thinking' ? 'think' : kind === 'tools' ? 'tool run' : 'wait for you'}
            </span>
            <span className="tabular-nums" style={{ color: COLORS.textPrimary }}>{formatDuration(longest(h, kind))}</span>
          </div>
        ))}
        {perTurn && (
          <div className="flex justify-between text-[10px] mt-1.5">
            <span style={{ color: COLORS.ecoEnergy }}>Energy per turn</span>
            <span className="tabular-nums" style={{ color: COLORS.textPrimary }}>~{perTurn.value} {perTurn.unit}</span>
          </div>
        )}
      </div>
      <div className="mt-2.5 text-[8.5px] leading-snug" style={{ color: COLORS.textMuted }}>
        Mass, radiation and cost cover the whole session; times, from when Agent Flow began watching.
      </div>
    </div>
  )
}

/** The whole session in one strip, each stretch its color: the disk unrolled */
function FlightRecorder({ h }: { h: TimeHorizon }) {
  if (h.elapsed <= 0) return null
  return (
    <div className="mt-3">
      <div className="text-[9px] tracking-[0.2em] mb-1" style={{ color: COLORS.textMuted }}>FLIGHT RECORDER</div>
      <div className="relative h-[10px] rounded-sm overflow-hidden" style={{ background: COLORS.holoBg05, boxShadow: `inset 0 0 0 1px ${COLORS.holoBorder08}` }}>
        {h.segments.map(s => (
          <div key={s.start} className="absolute top-0 bottom-0" style={{
            left: `${((s.start - h.start) / h.elapsed) * 100}%`,
            width: `${Math.max(0.15, ((s.end - s.start) / h.elapsed) * 100)}%`,
            background: KIND_COLOR[s.kind],
            opacity: s.kind === 'waiting' ? 0.45 : 0.95,
            boxShadow: s.kind === 'waiting' ? undefined : `0 0 6px ${KIND_COLOR[s.kind]}`,
          }} />
        ))}
      </div>
      <div className="flex justify-between text-[8px] mt-0.5" style={{ color: COLORS.textMuted }}>
        <span>START</span><span>NOW</span>
      </div>
    </div>
  )
}

/**
 * The session's time as a black hole. Now (T+0) sits out on the accretion disk: the session so
 * far trails back to the rim, each stretch colored by what it was doing, and the time to come
 * spirals in to the horizon, where the context window fills. The prompt cache orbits in it,
 * sinking toward the horizon as it ages. Opened from the top bar.
 */
export const TimeHorizonView = memo(function TimeHorizonView({ events, agents, currentTime, onClose }: {
  events: readonly SimulationEvent[]
  agents: Map<string, Agent>
  currentTime: number
  onClose: () => void
}) {
  const h = useMemo(() => timeHorizon(events, currentTime), [events, currentTime])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const usage = measuredUsage(agents)
  const contextWindow = useMemo(() => {
    for (const a of agents.values()) if (a.isMain) return a.tokensMax
    return 0
  }, [agents])
  // Its detail is compacted away at the threshold Claude Code measured, short of the window's edge
  const consumption = predictConsumption(h.context, h.compactThreshold ?? contextWindow, currentTime)
  const dilation = parallelism(h)
  const cacheLeft = h.cache ? h.cache.expiresAt - currentTime : 0
  const cacheWarm = cacheLeft > 0
  // API list prices: on a subscription, a share of its limits rather than dollars
  const cacheCost = h.cache ? cachedPromptCost(h.cache.tokens, h.cache.ttl, h.cache.model) : undefined
  const sceneInput: SceneInput = {
    horizon: h,
    consumption,
    cacheFraction: h.cache ? Math.max(0, Math.min(1, cacheLeft / h.cache.ttl)) : undefined,
    cacheWarm,
    cacheLabel: cacheWarm ? `CACHE ${formatDuration(cacheLeft)}` : 'CACHE COLD',
  }

  return (
    <div data-horizon-root className="absolute inset-0 th-enter" style={{ zIndex: Z.horizon, background: `radial-gradient(ellipse at 42% 52%, #120c18 0%, #07071a 45%, ${COLORS.void} 80%)` }}
      onClick={e => e.stopPropagation()}>
      <div className="absolute" style={{ left: 0, right: 330, top: 44, bottom: 80 }}>
        <HorizonCanvas input={sceneInput} agents={agents} />
        {h.elapsed <= 0 && (
          <div className="absolute inset-x-0 bottom-8 text-center font-mono text-xs tracking-[0.3em]" style={{ color: COLORS.textMuted }}>
            NO TIME HAS PASSED YET
          </div>
        )}
      </div>

      <div className="glass-card absolute font-mono" style={{ top: 56, right: 16, width: 300, padding: 16 }}>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold tracking-[0.25em]" style={{ color: COLORS.horizonLight }}>TIME HORIZON</span>
          <button onClick={onClose} className="text-[11px]" style={{ color: COLORS.textMuted }} aria-label="Close time horizon">✕</button>
        </div>
        <div className="mt-3 text-[9px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>MISSION ELAPSED</div>
        <div className="text-[26px] font-semibold tabular-nums" style={{ color: COLORS.holoHot, textShadow: `0 0 12px ${COLORS.horizonLight}55` }}>
          {formatDuration(h.elapsed)}
        </div>
        <div className="text-[9px]" style={{ color: COLORS.textDim }}>{h.turns} turn{h.turns === 1 ? '' : 's'}</div>
        <FlightRecorder h={h} />

        <div className="mt-4 flex flex-col gap-2.5">
          {TIME_KINDS.map(kind => {
            const { label, about } = KIND_STYLE[kind]
            const color = KIND_COLOR[kind]
            const share = h.elapsed > 0 ? h.totals[kind] / h.elapsed : 0
            return (
              <div key={kind} title={about}>
                <div className="flex items-baseline justify-between text-[10px]">
                  <span className="flex items-center gap-1.5" style={{ color: COLORS.textPrimary }}>
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
                    {label}
                  </span>
                  <span className="tabular-nums" style={{ color: COLORS.textDim }}>
                    {formatDuration(h.totals[kind])} <span style={{ color }}>{Math.round(share * 100)}%</span>
                  </span>
                </div>
                <div className="mt-1 h-[3px] rounded-full" style={{ background: COLORS.holoBg05 }}>
                  {/* No transition: the share changes every second, and easing it kept the panel
                      animating most of the time, its glass blur redone each frame (in Safari, a
                      fifth of the GPU) */}
                  <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: color }} />
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="text-[9px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>TIME DILATION</div>
          <div className="mt-1 text-[12px]" style={{ color: COLORS.textPrimary }}>
            1 hour here = <span style={{ color: dilation.agentTime > h.elapsed ? COLORS.timeSubagents : COLORS.timeThinking }}>
              {perHour(dilation.agentTime, h.elapsed)}</span> of Claude at work
          </div>
          {h.subagents.length > 0 && (
            <div className="text-[9px] leading-snug mt-0.5" style={{ color: COLORS.textDim }}>
              {h.subagents.length} subagent{h.subagents.length === 1 ? '' : 's'}, up to {dilation.peak} at once
              {dilation.agentTime > h.elapsed ? ': more time passed for them than for you' : ''}
            </div>
          )}
        </div>

        <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="text-[9px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>PROMPT CACHE</div>
          {h.cache ? (
            <>
              <div className="mt-1 text-[12px]" style={{ color: cacheWarm ? COLORS.horizonHot : COLORS.timePermission }}>
                {cacheWarm ? `Warm · ${formatDuration(cacheLeft)} left` : `Cold · expired ${formatDuration(-cacheLeft)} ago`}
              </div>
              <div className="text-[9px] leading-snug mt-0.5" style={{ color: COLORS.textDim }}>
                {h.cache.ttl >= 3600 ? '1-hour' : '5-minute'} cache · {cacheWarm
                  ? `your next message reuses ${formatCount(h.cache.tokens)} cached tokens`
                  : `your next message writes ${formatCount(h.cache.tokens)} tokens to it again`}
              </div>
              {cacheCost && (
                <div className="text-[9px] leading-snug mt-0.5" style={{ color: COLORS.textDim }}>
                  {cacheWarm
                    ? <>Reading them: <span style={{ color: COLORS.textPrimary }}>{usd(cacheCost.warm)}</span>. Lapsed: {usd(cacheCost.cold)}, {multiple(cacheCost)} as much</>
                    : <>Writing them: <span style={{ color: COLORS.timePermission }}>{usd(cacheCost.cold)}</span>, {multiple(cacheCost)} the {usd(cacheCost.warm)} of a warm read</>}
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 text-[10px]" style={{ color: COLORS.textDim }}>No measured requests yet</div>
          )}
        </div>

        <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="text-[9px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>EVENT HORIZON</div>
          <div className="mt-1 text-[12px]" style={{ color: consumption ? COLORS.timePermission : COLORS.textPrimary }}>
            {consumption ? `Context ${h.compactThreshold ? 'compacts' : 'full'} in ~${formatDuration(consumption.eta)}` : 'Context steady'}
          </div>
          <div className="text-[9px] leading-snug mt-0.5" style={{ color: COLORS.textDim }}>
            {consumption
              ? `${Math.round(consumption.fill * 100)}% of the way to ${h.compactThreshold ? 'the compaction point' : 'the context window’s edge'}, growing ${formatCount(consumption.rate)} tokens a minute: then it compacts, and the detail is gone`
              : 'Not growing lately, so nothing is falling in'}
          </div>
        </div>

        <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="text-[9px] tracking-[0.2em]" style={{ color: COLORS.textMuted }}>HAWKING RADIATION</div>
          <div className="mt-1 text-[12px]" style={{ color: COLORS.textPrimary }}>
            <span style={{ color: COLORS.horizonHot }}>{formatCount(usage.output)}</span> tokens escaped in {usage.requests} burst{usage.requests === 1 ? '' : 's'}
          </div>
          <div className="text-[9px] leading-snug mt-0.5" style={{ color: COLORS.textDim }}>
            Each request Claude answers radiates from the horizon, sized by what it wrote
          </div>
        </div>

        <div className="mt-3 text-[8.5px] leading-snug" style={{ color: COLORS.textMuted }}>
          Now is T+0. Outside it, the session so far trails back to the rim; inside, the time to come spirals in to the horizon, where the context fills. Hexagons are your prompts, spinning with the work each set off; ships are subagents. Click any of them, or the black hole. Time is counted from when Agent Flow began watching.
        </div>
      </div>
    </div>
  )
})

/** A small amount of money with the digits that show it: $0.0066, $0.26, $1.40 */
function usd(v: number): string {
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`
}

/** How many times a warm read a cold rewrite costs: `40×` */
function multiple({ warm, cold }: { warm: number; cold: number }): string {
  return warm > 0 ? `${Math.round(cold / warm)}×` : ''
}
