import { Agent, ToolCallNode, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { COST_DRAW, COST_PANEL, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { modelPrice } from '@/lib/model-pricing'
import { sessionCosts, estimatedCost, formatCost } from '@/lib/session-costs'
import { formatTokens } from '@/lib/utils'
import { truncateText } from './draw-misc'

/** Tool name -> color for mini cost bar */
export function toolTypeColor(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return COLORS.contextUser
  if (n.includes('edit') || n.includes('write')) return COLORS.contextReasoning
  if (n.includes('bash')) return COLORS.tool
  return COLORS.contextSubagent
}

/** Pre-group tool calls by agentId to avoid O(agents * toolCalls) per frame */
function groupToolsByAgent(toolCalls: Map<string, ToolCallNode>): Map<string, ToolCallNode[]> {
  const grouped = new Map<string, ToolCallNode[]>()
  for (const tc of toolCalls.values()) {
    if (!tc.tokenCost) continue
    let list = grouped.get(tc.agentId)
    if (!list) { list = []; grouped.set(tc.agentId, list) }
    list.push(tc)
  }
  return grouped
}

export function drawCostLabels(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const toolsByAgent = groupToolsByAgent(toolCalls)
  const costs = sessionCosts(agents).byAgent

  for (const [id, agent] of agents) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const figure = costs.get(id)
    if (!figure) continue
    const cost = figure.cost
    if (cost < COST_DRAW.minDisplayCost) continue

    const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const pillY = agent.y - r - COST_DRAW.pillYOffset

    // Floating cost pill: `~` for an estimate
    const label = formatCost(figure, cost < 0.01 ? 4 : 3)
    ctx.font = 'bold 9px monospace'
    const labelW = ctx.measureText(label).width
    const pillW = labelW + COST_DRAW.pillPadding
    const pillH = COST_DRAW.pillHeight
    const pillX = agent.x - pillW / 2

    ctx.save()
    ctx.globalAlpha = agent.opacity * 0.9

    // Pill background
    ctx.fillStyle = COLORS.costPillBg
    ctx.strokeStyle = COLORS.costPillStroke
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, COST_DRAW.pillRadius)
    ctx.fill()
    ctx.stroke()

    // Cost text
    ctx.fillStyle = COLORS.costText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, agent.x, pillY + pillH / 2)

    // Mini tool-type cost bar below the pill
    const agentTools = toolsByAgent.get(agent.id)
    if (agentTools && agentTools.length > 0) {
      // Group by tool type
      const byType = new Map<string, number>()
      let totalToolTokens = 0
      for (const tc of agentTools) {
        const tokens = tc.tokenCost || 0
        const key = tc.toolName
        byType.set(key, (byType.get(key) || 0) + tokens)
        totalToolTokens += tokens
      }
      if (totalToolTokens > 0) {
        const barW = Math.min(pillW + COST_DRAW.miniBarMaxExtra, COST_DRAW.miniBarMax)
        const barH = COST_DRAW.miniBarHeight
        const barX = agent.x - barW / 2
        const barY = pillY + pillH + COST_DRAW.miniBarGap

        // Bar background
        ctx.fillStyle = COLORS.holoBorder06
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, COST_DRAW.miniBarRadius)
        ctx.fill()

        // Segments
        let segX = barX
        for (const [toolName, tokens] of byType) {
          const segW = (tokens / totalToolTokens) * barW
          if (segW < 1) continue
          ctx.fillStyle = toolTypeColor(toolName)
          ctx.globalAlpha = agent.opacity * 0.7
          ctx.beginPath()
          ctx.roundRect(segX, barY, segW, barH, COST_DRAW.miniBarRadius)
          ctx.fill()
          segX += segW
        }
      }
    }

    ctx.restore()
  }
}

/** Across the agents the API measured: the share of input the prompt cache served, and the $ it saved */
function cacheSummary(agents: Agent[]): { hitRatio: number; saved: number } | undefined {
  let read = 0, inputs = 0, saved = 0
  for (const a of agents) {
    if (!a.spend) continue
    read += a.spend.cacheRead
    inputs += a.spend.input + a.spend.cacheRead + a.spend.cacheWrite
    const p = modelPrice(a.model)
    saved += a.spend.cacheRead * (p.input - p.cacheRead) / 1_000_000
  }
  return inputs > 0 ? { hitRatio: read / inputs, saved } : undefined
}

export function drawCostSummaryPanel(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const agentList = Array.from(agents.values()).filter(a => a.tokensUsed > 0)
  if (agentList.length === 0) return

  // Compute totals
  const totalTokens = agentList.reduce((s, a) => s + a.tokensUsed, 0)

  // Per-agent breakdown sorted by cost desc
  const costs = sessionCosts(agents)
  const agentBreakdown = agentList
    .map(a => {
      const figure = costs.byAgent.get(a.id) ?? { cost: 0, isExact: false }
      return { name: a.name, tokens: a.tokensUsed, cost: figure.cost, figure }
    })
    .sort((a, b) => b.cost - a.cost)
  const totalCost = costs.total.cost
  const cache = cacheSummary(agentList)

  // Per-tool-type breakdown, costed at the owning agent's model rate
  const toolBreakdown = new Map<string, { tokens: number; cost: number }>()
  for (const [, tc] of toolCalls) {
    if (tc.tokenCost) {
      const entry = toolBreakdown.get(tc.toolName) || { tokens: 0, cost: 0 }
      entry.tokens += tc.tokenCost
      entry.cost += estimatedCost(tc.tokenCost, agents.get(tc.agentId)?.model)
      toolBreakdown.set(tc.toolName, entry)
    }
  }
  const toolList = Array.from(toolBreakdown.entries())
    .map(([name, { tokens, cost }]) => ({ name, tokens, cost }))
    .sort((a, b) => b.cost - a.cost)

  // Panel dimensions — positioned top-right
  const dpr = ctx.canvas.width / ctx.canvas.offsetWidth
  const canvasW = ctx.canvas.width / dpr
  const panelW = COST_PANEL.width
  const panelX = canvasW - panelW - COST_PANEL.xMargin
  const panelY = COST_PANEL.yStart
  const lineH = COST_PANEL.lineHeight
  const headerH = COST_PANEL.headerHeight
  const sectionGap = COST_PANEL.sectionGap
  const agentRows = Math.min(agentBreakdown.length, COST_PANEL.maxRows)
  const toolRows = Math.min(toolList.length, COST_PANEL.maxRows)
  const cacheRowH = cache ? lineH : 0
  const panelH = headerH + cacheRowH + (agentRows * lineH) + sectionGap + (toolRows > 0 ? 14 + toolRows * lineH : 0) + 12

  ctx.save()

  // Panel background
  ctx.fillStyle = COLORS.panelBg
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(panelX, panelY, panelW, panelH, COST_PANEL.borderRadius)
  ctx.fill()
  ctx.stroke()

  let y = panelY + 8

  // Header: total cost
  ctx.font = 'bold 11px monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.costText
  const totalLabel = formatCost(costs.total, 3)
  ctx.fillText(totalLabel, panelX + COST_PANEL.contentPadding, y)

  ctx.font = '9px monospace'
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(`${formatTokens(totalTokens)} tokens`, panelX + COST_PANEL.contentPadding + ctx.measureText(totalLabel).width + 14, y + 2)

  y += headerH

  // Prompt cache: the share of measured input it served, and what that saved over full-price input
  if (cache) {
    ctx.font = '8px monospace'
    ctx.fillStyle = COLORS.costTextDim
    ctx.fillText(
      `cache ${Math.round(cache.hitRatio * 100)}% · saved $${cache.saved.toFixed(3)}`,
      panelX + COST_PANEL.contentPadding, y,
    )
    y += cacheRowH
  }

  // Per-agent breakdown
  const barW = panelW - COST_PANEL.contentPadding * 2
  for (let i = 0; i < agentRows; i++) {
    const a = agentBreakdown[i]

    // Mini bar background
    const ratio = totalCost > 0 ? a.cost / totalCost : 0
    ctx.fillStyle = COLORS.holoBorder06
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Bar fill
    ctx.fillStyle = a.name.includes('main') || agentBreakdown.length === 1
      ? COLORS.barFillMain
      : COLORS.barFillSub
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Agent name
    ctx.font = '8px monospace'
    ctx.fillStyle = COLORS.textPrimary
    ctx.textAlign = 'left'
    ctx.fillText(truncateText(ctx, a.name, barW - 50), panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, y + 3)

    // Cost
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.costText
    ctx.fillText(formatCost(a.figure, 3), panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, y + 3)

    y += lineH
  }

  // Per-tool-type breakdown
  if (toolList.length > 0) {
    y += sectionGap

    ctx.font = '8px monospace'
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText('BY TOOL', panelX + COST_PANEL.contentPadding, y)
    y += 14

    for (let i = 0; i < toolRows; i++) {
      const t = toolList[i]
      const ratio = totalCost > 0 ? t.cost / totalCost : 0

      // Background
      ctx.fillStyle = COLORS.panelSeparator
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()

      // Fill
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.globalAlpha = 0.2
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()
      ctx.globalAlpha = 1

      // Tool name
      ctx.font = '8px monospace'
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.textAlign = 'left'
      ctx.fillText(truncateText(ctx, t.name, barW - 50), panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, y + 3)

      // Cost
      ctx.textAlign = 'right'
      ctx.fillStyle = COLORS.costTextDim
      ctx.fillText(`$${t.cost.toFixed(3)}`, panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, y + 3)

      y += lineH
    }
  }

  ctx.restore()
}
