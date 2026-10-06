'use client'

import { useMemo } from 'react'
import type { Agent, Compaction, RateLimit, SimulationEvent } from '@/lib/agent-types'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatCount } from '@/lib/utils'
import { compactionDrop, compactionLabel, foldCompaction } from '@/lib/compaction'
import { timeHorizon, predictConsumption, formatDuration } from '@/lib/time-horizon'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar, stopPropagationHandlers } from './shared-ui'

const WIDTH = 300

interface WormholeLogProps {
  visible: boolean
  agents: Map<string, Agent>
  events: readonly SimulationEvent[]
  currentTime: number
  onClose: () => void
}

/** A compaction and the agent whose context it was */
interface Jump extends Compaction {
  agent: string
  isMain: boolean
}

const RATE_LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour window', seven_day: '7-day window', spend_limit: 'Spend limit' }

/** Every compaction the event log holds, newest first, each with the agent whose context it was */
function jumpsFrom(events: readonly SimulationEvent[], agents: Map<string, Agent>): Jump[] {
  const byAgent = new Map<string, Compaction[]>()
  for (const e of events) {
    if (e.type !== 'context_compaction') continue
    const key = String(e.payload.agent)
    const folded = foldCompaction(byAgent.get(key) ?? [], e.payload, e.time)
    if (folded) byAgent.set(key, folded)
  }
  const all: Jump[] = []
  for (const [key, list] of byAgent) {
    const agent = agents.get(key)
    for (const c of list) all.push({ ...c, agent: agent?.name ?? key, isMain: agent?.isMain ?? false })
  }
  // Newest first: by when it happened where known, else by the session's clock
  return all.sort((x, y) => (y.at && x.at && y.at !== x.at ? y.at.localeCompare(x.at) : (y.endTime ?? y.startTime) - (x.endTime ?? x.startTime)))
}

/** `14:05`, today's; with the date when it isn't */
function clock(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

/** `in 2h 10m` */
function untilReset(iso: string | undefined): string {
  if (!iso) return ''
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  if (!Number.isFinite(s)) return ''
  if (s <= 0) return 'resetting'
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h > 24 ? `resets in ${Math.round(h / 24)}d` : h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}

/** A small wormhole, for the card's title */
function WormholeGlyph({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: size, height: size,
        background: `radial-gradient(circle, ${COLORS.wormholeCore} 0 42%, ${COLORS.wormholeRim} 50%, ${COLORS.wormholeGlow}66 64%, transparent 72%)`,
        boxShadow: `0 0 8px ${COLORS.wormholeGlow}88`,
      }}
    />
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] tracking-[0.2em] mb-1" style={{ color: COLORS.textMuted }}>{children}</div>
}

/**
 * The wormhole log: how far the main agent's context is from compacting again, and when it will at
 * the rate it grows; the account's rate-limit windows; and every compaction so far, the session's
 * own and those from before Agent Flow watched.
 */
export function WormholeLog({ visible, agents, events, currentTime, onClose }: WormholeLogProps) {
  const main = useMemo(() => [...agents.values()].find(a => a.isMain), [agents])
  // Only while shown: the forecast reads the whole event log
  const horizon = useMemo(() => (visible ? timeHorizon(events, currentTime) : undefined), [visible, events, currentTime])

  // From the event log, not the agents: a subagent's node, and its compactions with it, is gone
  // once it finished and faded
  const jumps = useMemo(() => (visible ? jumpsFrom(events, agents) : []), [visible, events, agents])

  const done = jumps.filter(j => j.phase === 'done')
  const running = jumps.find(j => j.phase === 'running')
  const foldedAway = done.reduce((sum, j) => sum + Math.max(0, (j.tokensBefore ?? 0) - (j.tokensAfter ?? 0)), 0)

  return (
    <div className="absolute" {...stopPropagationHandlers}
      style={{ top: 52, left: '50%', marginLeft: -WIDTH / 2, width: WIDTH, zIndex: Z.sidePanel, pointerEvents: visible ? 'auto' : 'none' }}>
      <GlassCard visible={visible} className="font-mono" style={{ padding: 14 }}>
        <PanelHeader onClose={onClose} className="mb-3">
          <WormholeGlyph />
          <span className="text-[11px] font-semibold tracking-[0.25em]" style={{ color: COLORS.wormholeRim }}>WORMHOLE LOG</span>
        </PanelHeader>

        {main && <NextJump main={main} running={running} horizon={horizon} currentTime={currentTime} />}
        {main?.rateLimits && main.rateLimits.length > 0 && <Limits limits={main.rateLimits} />}

        <div className="pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
          <SectionTitle>PAST JUMPS · {done.length}</SectionTitle>
          {done.length === 0 ? (
            <div className="text-[10px]" style={{ color: COLORS.textDim }}>No compactions yet: the whole conversation is still in view</div>
          ) : (
            <>
              <div className="text-[10px] mb-2" style={{ color: COLORS.textDim }}>
                {formatCount(foldedAway)} tokens folded away in {done.length} jump{done.length === 1 ? '' : 's'}
              </div>
              <div className="flex flex-col gap-1.5 overflow-y-auto pr-1" style={{ maxHeight: 220 }}>
                {done.map((j, i) => <JumpRow key={`${j.agent}-${j.at ?? j.startTime}-${i}`} jump={j} />)}
              </div>
            </>
          )}
        </div>
      </GlassCard>
    </div>
  )
}

/** How far the main agent's context is from the point it compacts at, and when it gets there */
function NextJump({ main, running, horizon, currentTime }: {
  main: Agent
  running?: Jump
  horizon?: ReturnType<typeof timeHorizon>
  currentTime: number
}) {
  // Claude Code's own threshold where the bridge mod measured it; the window's edge otherwise
  const target = main.compactThreshold ?? main.tokensMax
  const fill = target > 0 ? Math.min(1, main.tokensUsed / target) : 0
  const forecast = horizon ? predictConsumption(horizon.context, target, currentTime) : undefined
  const togo = Math.max(0, target - main.tokensUsed)

  return (
    <div className="mb-3">
      <SectionTitle>NEXT JUMP</SectionTitle>
      {running && running.isMain ? (
        <div className="text-[12px] mb-1" style={{ color: COLORS.wormholeRim }}>
          ⟲ Jumping now · {formatDuration(Math.max(0, currentTime - running.startTime))}
          <div className="text-[9px]" style={{ color: COLORS.textDim }}>Claude Code is summarizing the conversation</div>
        </div>
      ) : (
        <div className="text-[12px] mb-1" style={{ color: forecast ? COLORS.horizonLight : COLORS.textPrimary }}>
          {forecast ? `In ~${formatDuration(forecast.eta)}` : 'No jump in sight'}
          <span className="text-[9px] ml-2" style={{ color: COLORS.textDim }}>
            {forecast ? `at ${formatCount(forecast.rate)} tokens a minute` : 'the context isn’t growing lately'}
          </span>
        </div>
      )}
      <ProgressBar percent={fill * 100} color={fill > 0.85 ? COLORS.timePermission : COLORS.wormholeGlow} />
      <div className="flex justify-between mt-1 text-[9px]" style={{ color: COLORS.textDim }}>
        <span>{formatCount(main.tokensUsed)} / {formatCount(target)} · {Math.round(fill * 100)}%</span>
        <span>{formatCount(togo)} to go</span>
      </div>
      <div className="text-[9px] mt-0.5" style={{ color: COLORS.textMuted }}>
        {main.compactThreshold
          ? `Compacts at ${formatCount(main.compactThreshold)} of a ${formatCount(main.tokensMax)} window`
          : 'Measured by the Agent Flow bridge mod; until then, the window’s edge'}
      </div>
    </div>
  )
}

function Limits({ limits }: { limits: RateLimit[] }) {
  return (
    <div className="mb-3 pt-3" style={{ borderTop: `1px solid ${COLORS.holoBorder08}` }}>
      <SectionTitle>LIMITS</SectionTitle>
      <div className="flex flex-col gap-1.5">
        {limits.map(l => (
          <div key={l.kind}>
            <div className="flex justify-between text-[9px] mb-0.5">
              <span style={{ color: COLORS.textPrimary }}>{RATE_LIMIT_NAMES[l.kind] ?? l.kind}</span>
              <span style={{ color: COLORS.textDim }}>{l.percentUsed}% · {untilReset(l.resetsAt)}</span>
            </div>
            <ProgressBar percent={Math.min(100, l.percentUsed)} color={l.percentUsed >= 90 ? COLORS.error : l.percentUsed >= 70 ? COLORS.timePermission : COLORS.complete} />
          </div>
        ))}
      </div>
    </div>
  )
}

function JumpRow({ jump }: { jump: Jump }) {
  const drop = compactionDrop(jump)
  return (
    <div className="text-[10px] px-2 py-1 rounded" style={{
      background: COLORS.wormholeActiveBg,
      opacity: jump.isHistory ? 0.7 : 1,
    }}>
      <div className="flex justify-between">
        <span style={{ color: COLORS.wormholeRim }}>⟲ {compactionLabel(jump)}{drop !== undefined ? <span style={{ color: COLORS.textDim }}> · −{Math.round(drop * 100)}%</span> : null}</span>
        <span style={{ color: COLORS.textDim }}>{clock(jump.at)}</span>
      </div>
      <div className="flex justify-between text-[9px] mt-0.5" style={{ color: COLORS.textMuted }}>
        <span>
          {jump.trigger === 'manual' ? '/compact' : jump.trigger === 'auto' ? 'auto' : jump.trigger ?? 'compacted'}
          {!jump.isMain && ` · ${jump.agent}`}
          {jump.isHistory && ' · before watching'}
        </span>
        {jump.durationMs !== undefined && <span>{formatDuration(jump.durationMs / 1000)}</span>}
      </div>
    </div>
  )
}
