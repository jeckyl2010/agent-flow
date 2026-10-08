'use client'

import { CARD, Z, type AgentState, type Compaction, type TurnFailure, type WorkflowPlace } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName } from '@/lib/utils'
import { compactionLabel } from '@/lib/compaction'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar } from './shared-ui'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    model?: string
    tokensUsed: number
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
    pendingPermission?: string
    permissionWhy?: string
    isTeammate?: boolean
    workflow?: WorkflowPlace
    compactions?: Compaction[]
    compactThreshold?: number
    failure?: TurnFailure
  }
  onClose: () => void
}

/** Where the context compacts, and what its compactions did */
function CompactionLine({ compactions, threshold, tokensMax }: { compactions?: Compaction[]; threshold?: number; tokensMax: number }) {
  const done = compactions?.filter(c => c.phase === 'done') ?? []
  const running = compactions?.at(-1)?.phase === 'running'
  if (!threshold && done.length === 0 && !running) return null
  const last = done.at(-1)
  return (
    <div className="mt-1 text-[9px] font-mono flex justify-between gap-2" style={{ color: COLORS.wormholeGlow }}>
      <span>{running ? '⟲ compacting…' : last ? `⟲ ${done.length}× · last ${compactionLabel(last)}` : ''}</span>
      {threshold && tokensMax > 0 && <span style={{ color: COLORS.textDim }}>compacts at {Math.round((threshold / tokensMax) * 100)}%</span>}
    </div>
  )
}

export function AgentDetailCard({
  agent,
  onClose,
}: AgentDetailCardProps) {
  const contextPercent = Math.round((agent.tokensUsed / agent.tokensMax) * 100)
  const stateColor = getStateColor(agent.state)

  // Fixed position: middle-left of the screen (below message feed panel)
  const left = CARD.margin
  const top = typeof window !== 'undefined' ? Math.max(100, (window.innerHeight - CARD.detail.height) / 2) : 300

  return (
    <GlassCard
      visible={true}
      className="agent-detail-card"
      style={{
        position: 'absolute',
        left,
        top,
        width: CARD.detail.width,
        zIndex: Z.detailCard,
      }}
    >
      <PanelHeader onClose={onClose} className="mb-3">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
        />
        <div className="flex flex-col">
          <span className="text-xs font-mono" style={{ color: COLORS.textPrimary }}>
            {agent.name}
          </span>
          {agent.model && (
            <span className="text-[9px] font-mono" style={{ color: COLORS.textDim }}>
              {formatModelName(agent.model)}
            </span>
          )}
        </div>
      </PanelHeader>

      {/* Context bar */}
      <div className="mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[10px]" style={{ color: COLORS.textMuted }}>Context</span>
          <span className="text-[10px] font-mono" style={{ color: COLORS.textDim }}>
            {formatTokens(agent.tokensUsed)} / {formatTokens(agent.tokensMax)} ({contextPercent}%)
          </span>
        </div>
        <ProgressBar percent={contextPercent} color={stateColor} />
        <CompactionLine compactions={agent.compactions} threshold={agent.compactThreshold} tokensMax={agent.tokensMax} />
      </div>

      {/* Stats row */}
      <div className="flex gap-3 mb-3 text-[10px] font-mono" style={{ color: COLORS.textDim }}>
        <span>{agent.toolCalls} tools</span>
        <span>{agent.timeAlive.toFixed(1)}s alive</span>
        <span className="capitalize" style={{ color: stateColor }}>{agent.state}</span>
        {agent.isTeammate && <span style={{ color: COLORS.textMuted }}>teammate</span>}
        {agent.workflow && (
          <span style={{ color: COLORS.textMuted }} title={`Agent #${agent.workflow.index} of workflow run ${agent.workflow.runId}`}>
            workflow
          </span>
        )}
      </div>

      {/* Current tool */}
      {agent.currentTool && (
        <div
          className="mb-3 px-2 py-1.5 rounded text-[10px] font-mono flex items-center gap-2"
          style={{
            background: COLORS.toolIndicatorBg,
            border: `1px solid ${COLORS.toolIndicatorBorder}`,
            color: COLORS.toolIndicatorText,
          }}
        >
          <span className="animate-spin inline-block">⚙</span>
          {agent.currentTool}
        </div>
      )}

      {/* What it waits for the user to allow */}
      {agent.state === 'waiting_permission' && agent.pendingPermission && (
        <div
          className="mb-3 px-2 py-1.5 rounded text-[10px] font-mono break-all"
          style={{
            border: `1px solid ${COLORS.waiting_permission}`,
            color: COLORS.waiting_permission,
          }}
        >
          Waiting for you to allow {agent.pendingPermission}
          {agent.permissionWhy && <div className="mt-1 opacity-75">{agent.permissionWhy}</div>}
        </div>
      )}

      {/* Its latest turn ended without an answer */}
      {agent.failure && agent.state !== 'thinking' && agent.state !== 'tool_calling' && (
        <div
          className="mb-3 px-2 py-1.5 rounded text-[10px] font-mono"
          style={{ border: `1px solid ${COLORS.error}`, color: COLORS.error }}
        >
          {agent.failure.reason === 'refusal'
            ? `Refused${agent.failure.category ? ` (${agent.failure.category})` : ''}`
            : 'The turn ended on an API error'}
          {agent.failure.explanation && <div className="mt-1 opacity-75">{agent.failure.explanation}</div>}
        </div>
      )}

    </GlassCard>
  )
}
