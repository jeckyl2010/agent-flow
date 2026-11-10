import { COLORS } from '@/lib/colors'
import { HIDDEN_TOOLS, type ToolCallNode } from '@/lib/agent-types'
import { TOOL_DEDUP_WINDOW_S } from '@/lib/canvas-constants'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, asString, asBoolean, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || args?.split(' ')[0] || ''
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  if (HIDDEN_TOOLS.has(asString(payload.tool))) return
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const args = asString(payload.args)
  const inputData = (payload.inputData && typeof payload.inputData === 'object' && !Array.isArray(payload.inputData))
    ? payload.inputData as Record<string, unknown> : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    // Dedup: skip if there's already a running tool call for the same agent+tool
    // created within the last 3 seconds (race between Hook Server and Session Watcher)
    let isDuplicate = false
    for (const tc of state.toolCalls.values()) {
      if (tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running' && !tc.background && (currentTime - tc.startTime) < TOOL_DEDUP_WINDOW_S) {
        isDuplicate = true
        break
      }
    }
    if (isDuplicate) return

    state.agents.set(agentName, {
      ...agent,
      state: 'tool_calling',
      currentTool: toolName,
      pendingPermission: undefined,
      toolCalls: agent.toolCalls + 1
    })

    const toolId = `tool-${agentName}-${toolName}-${currentTime}`

    const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, currentTime)

    state.toolCalls.set(toolId, {
      id: toolId, agentId: agentName, toolName,
      state: 'running',
      args,
      inputData,
      x: pos.x,
      y: pos.y,
      startTime: currentTime,
      opacity: 0,
    })

    state.edges.push({ id: `edge-${toolId}`, from: agentName, to: toolId, type: 'tool', opacity: 0 })

    state.particles.push({
      id: `p-tc-${currentTime}-${toolId}`,
      edgeId: `edge-${toolId}`, progress: 0,
      type: 'tool_call', color: COLORS.tool,
      size: 4, trailLength: 0.15,
      label: `${toolName} ${args}`.slice(0, LABEL_LEN_PARTICLE),
    })

    // Timeline block
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'tool_call', label: `${toolName}: ${args}`.slice(0, LABEL_LEN_TIMELINE), color: COLORS.tool }, ctx)
    }

    // Track file attention
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const filePath = extractFilePath(inputData, args)
      if (filePath) {
        const prev = state.fileAttention.get(filePath)
        const updated = prev
          ? { ...prev, agents: [...prev.agents] }
          : { path: filePath, reads: 0, edits: 0, totalTokens: 0, lastAccessed: currentTime, agents: [] as string[] }
        if (toolName === 'Read') updated.reads++
        else updated.edits++
        updated.lastAccessed = currentTime
        if (!updated.agents.includes(agentName)) updated.agents.push(agentName)
        state.fileAttention.set(filePath, updated)
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_call', content: `> ${toolName} ${args}`, timestamp: currentTime,
      toolName, inputData,
    })
  }
}

export function handleToolCallEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  if (HIDDEN_TOOLS.has(asString(payload.tool))) return
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const result = asString(payload.result, 'Done')
  const tokenCost = typeof payload.tokenCost === 'number' ? payload.tokenCost : undefined
  const isError = asBoolean(payload.isError)
  const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
  const readOnly = payload.readOnly === true
  const blocked = isError && payload.blocked === true
  const unasked = blocked && payload.unasked === true
  // An MCP call that returned before its result: it goes on in the background, the agent with it
  const background = !isError && payload.background === true
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      state: isError ? 'error' : 'thinking',
      currentTool: undefined,
      pendingPermission: undefined, // allowed, or denied: either way no longer waiting
      // A measured count already includes the result; the next measurement moves it
      tokensUsed: agent.isTokensMeasured ? agent.tokensUsed : agent.tokensUsed + (tokenCost ?? 0),
      ...(readOnly ? { readOnlyCalls: (agent.readOnlyCalls ?? 0) + 1 } : {}),
    })

    const toolState: 'error' | 'complete' = isError ? 'error' : 'complete'
    for (const [id, tc] of state.toolCalls) {
      if (tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running' && !tc.background) {
        if (background) {
          state.toolCalls.set(id, { ...tc, background: true, ...(taskId ? { taskId } : {}), result, tokenCost })
          break
        }
        state.toolCalls.set(id, {
          ...tc, state: toolState, completeTime: currentTime, result, tokenCost,
          errorMessage: isError ? (errorMessage || result) : undefined,
          ...(readOnly ? { readOnly } : {}),
          ...(blocked ? { blocked } : {}),
          ...(unasked ? { unasked } : {}),
        })

        const edgeId = `edge-${id}`
        // Snap any still-traveling outgoing particle to the end
        const outIdx = state.particles.findIndex(p => p.edgeId === edgeId && p.type === 'tool_call')
        if (outIdx !== -1) state.particles[outIdx] = { ...state.particles[outIdx], progress: 0.95 }

        state.particles.push({
          id: `p-tr-${currentTime}-${id}`,
          edgeId, progress: 1,
          type: 'tool_return', color: COLORS.return,
          size: 4, trailLength: 0.15,
          label: result.slice(0, LABEL_LEN_PARTICLE),
        })
        break
      }
    }

    // Timeline block end
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      if (isError) {
        const lastBlock = entry.blocks.at(-1)
        if (lastBlock && !lastBlock.endTime) {
          lastBlock.color = COLORS.error
          lastBlock.label = `${toolName}: ${unasked ? 'REFUSED UNASKED' : blocked ? 'BLOCKED' : 'FAILED'}`
        }
      }
      pushTimelineBlock(entry, currentTime, { type: 'thinking', label: 'Thinking...', color: COLORS.thinking }, ctx)
    }

    // File attention token cost
    if (tokenCost) {
      const matchedTc = Array.from(state.toolCalls.values()).find(tc => tc.agentId === agentName && tc.toolName === toolName)
      const filePath = extractFilePath(matchedTc?.inputData, matchedTc?.args)
      if (filePath) {
        const existing = state.fileAttention.get(filePath)
        if (existing) {
          state.fileAttention.set(filePath, { ...existing, totalTokens: existing.totalTokens + tokenCost })
        }
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_result',
      content: background
        ? `< in the background${taskId ? ` as task ${taskId}` : ''}`
        : `< ${result}${tokenCost ? ` (${tokenCost} tokens)` : ''}`,
      timestamp: currentTime,
      toolName,
    })
  }
}

/** An MCP call that went on in the background has ended (its task notification): the card it kept
 *  completes, and the result travels back to its agent */
export function handleToolBackgroundEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : undefined
  const status = asString(payload.status, 'completed')
  const result = asString(payload.result, status)
  const isError = asBoolean(payload.isError)

  let found: [string, ToolCallNode] | undefined
  for (const entry of state.toolCalls) {
    const tc = entry[1]
    if (!tc.background || tc.state !== 'running' || tc.agentId !== agentName || tc.toolName !== toolName) continue
    if (taskId && tc.taskId && tc.taskId !== taskId) continue
    found = entry
    break
  }
  if (found) {
    const [id, tc] = found
    state.toolCalls.set(id, {
      ...tc, state: isError ? 'error' : 'complete', completeTime: currentTime, result,
      errorMessage: isError ? result : undefined,
    })
    state.particles.push({
      id: `p-tr-${currentTime}-${id}`,
      edgeId: `edge-${id}`, progress: 1,
      type: 'tool_return', color: isError ? COLORS.error : COLORS.return,
      size: 4, trailLength: 0.15,
      label: result.slice(0, LABEL_LEN_PARTICLE),
    })
  }

  appendConversation(state.conversations, agentName, {
    type: 'tool_result',
    content: `< ${toolName} ${status} in the background: ${result}`,
    timestamp: currentTime,
    toolName,
  })
}
