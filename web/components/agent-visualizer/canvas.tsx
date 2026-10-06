'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { Agent, Particle, Edge, Discovery, DepthParticle } from '@/lib/agent-types'
import type { SimulationState } from '@/hooks/simulation/types'
import { getStateColor } from '@/lib/colors'
import { ANIM_SPEED, FRAME_RATE, PERF_OVERLAY, PERF_OVERLAY_ENABLED } from '@/lib/canvas-constants'
import { frameLimiter } from '@/lib/frame-limiter'
import { activityTracker } from '@/lib/activity'
import { BloomRenderer, canvasFilterBlurs } from './bloom-renderer'
import { GlBloom } from './gl-bloom'
import { Painter } from './gl/painter'
import { GlContext2D } from './gl/context2d'
import { createDepthParticles, updateDepthParticles, drawBackground } from './background-layer'
import {
  type VisualEffect,
  drawTetherLine,
  drawEffects,
  drawAgents,
  drawMessageBubblesWorld,
  drawEdges, getActiveEdgeIds,
  drawParticles, buildEdgeMap,
  drawToolCalls,
  drawDiscoveries, drawDiscoveryConnections,
  drawCostLabels, drawCostSummaryPanel, drawHeartbeats, drawModelTags,
  drawWormholesBelow, drawWormholesAbove, isWormholeOpen,
  drawAgentMessages, isMessageInFlight,
  detectStateChanges as detectStateChangesPure,
} from './canvas/index'
import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { useCanvasInteraction } from '@/hooks/use-canvas-interaction'

interface CanvasProps {
  /** Ref to simulation state — read every frame without React re-renders */
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  hoveredAgentId: string | null
  showStats: boolean
  showHexGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  selectedToolCallId?: string | null
  onDiscoveryClick?: (discoveryId: string | null) => void
  selectedDiscoveryId?: string | null
  showCostOverlay?: boolean
  /** Covered by another view: nothing is drawn until it's shown again */
  paused?: boolean
}

export function AgentCanvas({
  simulationRef,
  selectedAgentId, hoveredAgentId, showStats, showHexGrid, zoomToFitTrigger, pauseAutoFit,
  onAgentClick, onAgentHover, onAgentDrag, onContextMenu, onToolCallClick, selectedToolCallId, onDiscoveryClick, selectedDiscoveryId, showCostOverlay,
  paused = false,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const simTimeRef = useRef(0)
  const bloomRef = useRef<Pick<BloomRenderer, 'resize' | 'apply'> | null>(null)
  const glBloomRef = useRef<GlBloom | null>(null)
  /**
   * Drawn on the GPU while anything happens: the view's draw code through a 2D context that paints
   * with WebGL, on a canvas under the 2D one. At rest the 2D canvas draws instead: Safari redraws
   * only the parts of it that change, where a WebGL canvas is redrawn whole, a full window a frame
   */
  const glRef = useRef<{ painter: Painter; ctx: GlContext2D; always: boolean } | null>(null)
  const glCanvasRef = useRef<HTMLCanvasElement>(null)
  /** Whether the last frame was the GPU's: its canvas showing, the 2D one clear over it */
  const onGpuRef = useRef(false)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const lastFrameTimeRef = useRef(0)
  const dprRef = useRef(1)

  // Effects system
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())

  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)

  // Performance overlay state
  const perfRef = useRef({
    frames: 0,
    lastFpsUpdate: 0,
    fps: 0,
    frameTimeMs: 0,
    frameTimes: [] as number[],
    p95: 0,
  })

  // Caches for per-frame lookups — avoid rebuilding Set/Map every ~16ms
  const edgeLookupCacheRef = useRef<{
    particles: Particle[]
    edges: Edge[]
    activeEdgeIds: Set<string>
    edgeMap: Map<string, Edge>
  }>({ particles: [], edges: [], activeEdgeIds: new Set(), edgeMap: new Map() })

  // ─── Stable refs for animation loop & event handlers ────────────────────
  // Simulation data (agents, particles, etc.) is synced from simulationRef
  // at the top of each draw frame, so it's always fresh even without re-renders.
  const sim = simulationRef.current
  const makeDrawProps = (prev?: { isDragging: boolean }) => ({
    agents: sim.agents, toolCalls: sim.toolCalls,
    particles: sim.particles, edges: sim.edges, discoveries: sim.discoveries,
    selectedAgentId, hoveredAgentId, showStats, showHexGrid,
    showCostOverlay, selectedToolCallId, selectedDiscoveryId,
    simTime: sim.currentTime, pauseAutoFit, dimensions,
    onAgentDrag, onAgentClick, onAgentHover, onContextMenu,
    onToolCallClick, onDiscoveryClick, paused,
    isDragging: prev?.isDragging ?? false,
  })
  const drawPropsRef = useRef(makeDrawProps())
  drawPropsRef.current = makeDrawProps(drawPropsRef.current)

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, userHasNavigatedRef, panVelocityRef,
    screenToCanvas, doZoomToFit, updateCamera,
  } = useCanvasCamera({
    mainCanvasRef, drawPropsRef, simTimeRef, dimensions,
    agentCount: sim.agents.size, zoomToFitTrigger, selectedAgentId,
  })

  // ─── Interaction ────────────────────────────────────────────────────────
  const {
    isDragging, handlers, updateDragLerp,
  } = useCanvasInteraction({
    drawPropsRef, transformRef, userHasNavigatedRef, panVelocityRef,
    simTimeRef, screenToCanvas, doZoomToFit, mainCanvasRef,
  })

  // Keep drawPropsRef in sync with interaction state
  drawPropsRef.current.isDragging = isDragging

  // ─── Setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    // On the GPU where WebGL 2 is there, in 2D at rest: always in 2D when asked for (?main=2d),
    // always on the GPU (?main=gpu)
    const mode = new URLSearchParams(window.location.search).get('main')
    const glCanvas = glCanvasRef.current
    if (glCanvas && mode !== '2d') {
      const painter = new Painter(glCanvas)
      if (painter.ok) {
        glRef.current = { painter, ctx: new GlContext2D(glCanvas, painter, () => dprRef.current), always: mode === 'gpu' }
        // At rest, in 2D, with the 2D bloom: the GPU's is the frame's own
        bloomRef.current = new BloomRenderer(0.5)
        depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
        return () => { painter.dispose(); glRef.current = null; bloomRef.current = null }
      }
    }
    // On the GPU, laid over the canvas, where the canvas blurs with filters: there the 2D bloom
    // is the most of the frame's GPU time. Safari's canvas doesn't, and its 2D bloom (shrinking
    // and enlarging) is cheap, cheaper than blending an overlay as it composites the page
    const gl = canvasFilterBlurs() ? GlBloom.create(0.5) : null
    if (gl) containerRef.current?.appendChild(gl.canvas)
    glBloomRef.current = gl
    bloomRef.current = gl ?? new BloomRenderer(0.5)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { gl?.dispose(); glBloomRef.current = bloomRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- particles created once, resized by draw loop
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        const h = entry.contentRect.height
        setDimensions({ width: w, height: h })
        bloomRef.current?.resize(w * dpr, h * dpr)
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // While paused (the time horizon over it), the overlay would still be blended every frame
  useEffect(() => {
    if (glBloomRef.current) glBloomRef.current.canvas.style.visibility = paused ? 'hidden' : ''
  }, [paused])

  // ─── Detect state changes → spawn effects ──────────────────────────────

  const detectStateChanges = useCallback(() => {
    const { agents, toolCalls } = drawPropsRef.current
    const { effects, newAgentStates, newToolStates } = detectStateChangesPure(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    effectsRef.current.push(...effects)
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates
  }, [])

  // ─── Main draw loop ────────────────────────────────────────────────────

  // Stable ref so the rAF loop always calls the latest draw without
  // re-subscribing when the callback identity changes.
  const drawRef = useRef<(timestamp: number) => void>(() => {})

  // ─── Frame rate: full while something happens, calm when settled ──────
  const limiterRef = useRef(frameLimiter())
  /** Whether something is happening: an event, a particle or effect, the pointer. Not by itself a
   *  long-running tool (its spinner reads fine at the calm rate) or the camera: auto-fit follows
   *  the force layout, which never quite comes to rest, and refits that matter follow events */
  const activityRef = useRef(activityTracker(FRAME_RATE.activeWindowMs))
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const touch = () => activityRef.current.touch(performance.now())
    const opts = { passive: true } as const
    el.addEventListener('pointermove', touch, opts)
    el.addEventListener('pointerdown', touch, opts)
    el.addEventListener('wheel', touch, opts)
    return () => {
      el.removeEventListener('pointermove', touch)
      el.removeEventListener('pointerdown', touch)
      el.removeEventListener('wheel', touch)
    }
  }, [])

  /** How fast the view's own motion runs: all of it while something happens, slowing to a third
   *  once it's calm, and fewer frames only when it has, so the motion never steps */
  const paceRef = useRef(1)
  const restPace = FRAME_RATE.rest / 30
  const frameRate = (active: boolean) =>
    active ? FRAME_RATE.active : paceRef.current < restPace * 1.05 ? FRAME_RATE.rest : FRAME_RATE.ambient

  const isActive = useCallback((timestamp: number): boolean => {
    const s = simulationRef.current
    return activityRef.current.active(timestamp, {
      lastEvent: s.eventLog.at(-1),
      particles: s.particles.length,
      // A wormhole or a message in flight animates as an effect does
      effects: effectsRef.current.length
        + (isWormholeOpen(s.agents, simTimeRef.current) || isMessageInFlight(s.agents, simTimeRef.current) ? 1 : 0),
      dragging: drawPropsRef.current.isDragging,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, [])

  const draw = useCallback((timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    if (drawPropsRef.current.paused) return
    const active = isActive(timestamp)
    if (!limiterRef.current(timestamp, frameRate(active))) return

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    // On the GPU unless settled at rest, the calm rate's frames
    const gpu = glRef.current
    const gl = gpu && (gpu.always || active || paceRef.current >= restPace * 1.05) ? gpu : null
    const ctx = gl ? (gl.ctx as unknown as CanvasRenderingContext2D) : ctx2d

    try {
      // Sync simulation data from ref — always fresh, independent of React renders
      {
        const s = simulationRef.current
        const p = drawPropsRef.current
        p.agents = s.agents
        p.toolCalls = s.toolCalls
        p.particles = s.particles
        p.edges = s.edges
        p.discoveries = s.discoveries
        p.simTime = s.currentTime
      }

      const {
        agents, toolCalls, particles, edges, discoveries,
        selectedAgentId, hoveredAgentId, showStats, showHexGrid,
        showCostOverlay, selectedToolCallId, selectedDiscoveryId,
        simTime, pauseAutoFit, dimensions, onAgentDrag,
        isDragging,
      } = drawPropsRef.current
      const transform = transformRef.current

      // Capped as the simulation's is: after a pause (the time horizon over it), the first frame
      // back would otherwise take minutes in one step, and everything drifting would jump
      const deltaTime = lastFrameTimeRef.current
        ? Math.min((timestamp - lastFrameTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
        : ANIM_SPEED.defaultDeltaTime
      lastFrameTimeRef.current = timestamp
      // Waking is quick, so what woke it plays at its speed; settling is slow, so it isn't noticed
      const target = active ? 1 : restPace
      paceRef.current += (target - paceRef.current) * (1 - Math.exp(-(deltaTime * 1000) / (target > paceRef.current ? 250 : 1500)))
      const motion = deltaTime * paceRef.current
      timeRef.current += motion
      if (simTime != null) simTimeRef.current = simTime

      const dpr = dprRef.current
      const w = dimensions.width
      const h = dimensions.height

      if (gl) {
        gl.painter.begin(w, h, dpr)
        gl.ctx.reset()
      } else if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)
      }

      // Camera physics (inertia + auto-fit)
      updateCamera(isDragging, pauseAutoFit)

      // Floaty agent drag
      updateDragLerp(agents, onAgentDrag)

      // Detect state changes → visual effects
      detectStateChanges()

      // Update effects (mutate in place to avoid GC pressure)
      {
        const effects = effectsRef.current
        let writeIdx = 0
        for (let i = 0; i < effects.length; i++) {
          effects[i].age += deltaTime
          if (effects[i].age < effects[i].duration) {
            if (writeIdx !== i) effects[writeIdx] = effects[i]
            writeIdx++
          }
        }
        effects.length = writeIdx
      }

      ctx.clearRect(0, 0, w, h)
      updateDepthParticles(depthParticlesRef.current, motion, w, h)

      let activeAgentPos: { x: number; y: number; color: string } | undefined
      for (const [, agent] of agents) {
        if (agent.state === 'thinking' || agent.state === 'tool_calling' || agent.state === 'waiting_permission') {
          activeAgentPos = { x: agent.x, y: agent.y, color: getStateColor(agent.state) }
          break
        }
      }

      drawBackground(ctx, w, h, depthParticlesRef.current, transform, showHexGrid, timeRef.current, activeAgentPos)

      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.scale, transform.scale)

      // Pre-compute shared lookup structures — cached across frames when inputs are unchanged
      const elCache = edgeLookupCacheRef.current
      let activeEdgeIds: Set<string>
      let edgeMap: Map<string, Edge>
      if (elCache.particles === particles && elCache.edges === edges) {
        activeEdgeIds = elCache.activeEdgeIds
        edgeMap = elCache.edgeMap
      } else {
        activeEdgeIds = getActiveEdgeIds(particles)
        edgeMap = buildEdgeMap(edges)
        edgeLookupCacheRef.current = { particles, edges, activeEdgeIds, edgeMap }
      }

      drawDiscoveryConnections(ctx, discoveries, agents)
      drawEdges(ctx, edges, agents, toolCalls, activeEdgeIds, timeRef.current)
      drawToolCalls(ctx, toolCalls, timeRef.current, selectedToolCallId)
      drawDiscoveries(ctx, discoveries, agents, selectedDiscoveryId)
      drawWormholesBelow(ctx, agents, simTimeRef.current)
      drawAgentMessages(ctx, agents, simTimeRef.current)
      drawAgents(ctx, agents, selectedAgentId, hoveredAgentId, showStats, timeRef.current)
      drawHeartbeats(ctx, agents, simTimeRef.current)
      drawModelTags(ctx, agents, simTimeRef.current)
      drawMessageBubblesWorld(ctx, agents, simTimeRef.current)
      if (showCostOverlay) drawCostLabels(ctx, agents, toolCalls)
      drawParticles(ctx, particles, edgeMap, agents, toolCalls, timeRef.current)
      drawEffects(ctx, effectsRef.current)
      drawWormholesAbove(ctx, agents, simTimeRef.current)

      if (selectedAgentId) {
        const agent = agents.get(selectedAgentId)
        if (agent) drawTetherLine(ctx, agent, transform, h)
      }

      ctx.restore()

      if (showCostOverlay) drawCostSummaryPanel(ctx, agents, toolCalls)
      if (!gl && bloomRef.current) bloomRef.current.apply(canvas, ctx)

      // ─── Performance overlay (enabled via ?perf or ?stress) ──────────
      if (PERF_OVERLAY_ENABLED) {
        const perf = perfRef.current
        const frameEnd = performance.now()
        const frameMs = frameEnd - (timestamp || frameEnd)
        perf.frameTimes.push(frameMs)
        if (perf.frameTimes.length > PERF_OVERLAY.maxFrameSamples) perf.frameTimes.shift()
        perf.frames++
        perf.frameTimeMs = frameMs
        if (frameEnd - perf.lastFpsUpdate >= PERF_OVERLAY.updateIntervalMs) {
          perf.fps = perf.frames
          perf.frames = 0
          perf.lastFpsUpdate = frameEnd
          const sorted = perf.frameTimes.toSorted((a, b) => a - b)
          perf.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
        }
        const po = PERF_OVERLAY
        const textX = po.x + po.padding
        let textY = po.y + po.lineHeight + 2
        ctx.save()
        ctx.fillStyle = po.bgColor
        ctx.fillRect(po.x, po.y, po.width, po.height)
        ctx.font = po.font
        ctx.fillStyle = perf.fps < po.fpsWarning ? po.fpsWarningColor : perf.fps < po.fpsCaution ? po.fpsCautionColor : po.fpsGoodColor
        ctx.fillText(`FPS: ${perf.fps}`, textX, textY); textY += po.lineHeight
        ctx.fillStyle = po.textColor
        ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Agents: ${agents.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Tool calls: ${toolCalls.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Particles: ${particles.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Edges: ${edges.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Discoveries: ${discoveries.length}`, textX, textY)
        ctx.restore()
      }

      // On the GPU, the frame is sent now, its bloom with it, at the 2D bloom's strength
      if (gl) gl.painter.end(0.5)

      // Changing canvases: the new one's frame is drawn first, so there's no frame of neither
      if (gl && !onGpuRef.current) {
        glCanvasRef.current!.style.visibility = ''
        ctx2d.save()
        ctx2d.setTransform(1, 0, 0, 1, 0, 0)
        ctx2d.clearRect(0, 0, canvas.width, canvas.height)
        ctx2d.restore()
        onGpuRef.current = true
      } else if (!gl && onGpuRef.current) {
        glCanvasRef.current!.style.visibility = 'hidden'
        onGpuRef.current = false
      }

    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }, [detectStateChanges, updateCamera, updateDragLerp, transformRef, isActive])

  drawRef.current = draw

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRef is stable; rAF loop set up once
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden" style={{ cursor: isDragging ? 'grabbing' : 'grab' }}>
      <canvas ref={glCanvasRef} aria-hidden className="absolute inset-0 w-full h-full pointer-events-none" style={{ visibility: 'hidden' }} />
      <canvas
        ref={mainCanvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
        {...handlers}
        // Over the GPU's canvas: positioned, as it is
        className="relative w-full h-full"
      />
    </div>
  )
}
