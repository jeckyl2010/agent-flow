import type { ContextBreakdown } from '@/lib/agent-types'
import type { ConversationMessage } from './types'
import { appendConversation, asString, asNumber, asBoolean, LABEL_LEN_NAME, LABEL_LEN_TASK, LABEL_LEN_BUBBLE, MAX_BUBBLES } from './types'
import type { MutableEventState } from './process-event'
import { revealedChars } from '@/components/agent-visualizer/canvas/bubble-utils'
import { BUBBLE_FADE_IN } from '@/lib/canvas-constants'

/** A user message that is only Claude Code's note for an attached image or pasted text */
const ATTACHMENT_NOTE = /^\[(Image|Pasted text)\b[^\]]*\]\s*$/

export function handleMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const content = asString(payload.content)
  const role = typeof payload.role === 'string' ? payload.role : undefined
  // A block the agent-flow-bridge mod streams arrives again as it grows: same streamId, longer content
  const streamId = typeof payload.streamId === 'string' ? payload.streamId : undefined
  const isStreaming = streamId !== undefined && asBoolean(payload.isPartial)

  // Map role to conversation message type
  const msgType: ConversationMessage['type'] =
    role === 'user' ? 'user' :
    role === 'thinking' ? 'thinking' :
    'assistant'

  // Rename main agent to the first user message (more recognizable than "orchestrator"), not to
  // the note Claude Code adds for an attachment ("[Image: original 3000x1796, …]")
  if (role === 'user' && !ATTACHMENT_NOTE.test(content)) {
    const msgAgentForName = state.agents.get(agentName)
    if (msgAgentForName && msgAgentForName.isMain && msgAgentForName.name === agentName) {
      const shortName = content.slice(0, LABEL_LEN_NAME).replace(/\n/g, ' ').trim()
      state.agents.set(agentName, { ...msgAgentForName, name: shortName || agentName, task: content.slice(0, LABEL_LEN_TASK) })
    }
  }

  // Update agent state and push message bubble to queue
  const msgAgent = state.agents.get(agentName)
  if (msgAgent) {
    const bubbleRole: 'user' | 'thinking' | 'assistant' = role === 'user' ? 'user' : role === 'thinking' ? 'thinking' : 'assistant'
    const updates: Partial<typeof msgAgent> = {}

    {
      // Truncate thinking for graph bubbles (full text in message feed panel)
      const bubbleText = bubbleRole === 'thinking' ? content.slice(0, LABEL_LEN_BUBBLE) + (content.length > LABEL_LEN_BUBBLE ? '...' : '') : content
      const streamed = streamId ? msgAgent.messageBubbles.findIndex(b => b.streamId === streamId) : -1
      // Dedup: skip if last bubble has the same text (dual event source race)
      const lastBubble = msgAgent.messageBubbles.at(-1)
      if (streamed !== -1) {
        const bubbles = [...msgAgent.messageBubbles]
        const old = bubbles[streamed]
        // A new object drops the old text's layout caches. It stays up while it grows: its hold
        // restarts, already faded in, and it types on from what was showing
        bubbles[streamed] = {
          text: bubbleText, role: old.role, streamId, isStreaming,
          time: Math.max(old.time, currentTime - BUBBLE_FADE_IN),
          revealFrom: revealedChars(old, currentTime), revealAt: currentTime,
        }
        updates.messageBubbles = bubbles
      } else if (!lastBubble || lastBubble.text !== bubbleText) {
        const streamed = streamId ? { streamId, isStreaming, revealFrom: 0, revealAt: currentTime } : {}
        const newBubbles = [...msgAgent.messageBubbles, { text: bubbleText, time: currentTime, role: bubbleRole, ...streamed }]
        updates.messageBubbles = newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles
      }
    }

    if (msgAgent.state !== 'complete' && msgAgent.state !== 'tool_calling') {
      if (role === 'user' || role === 'thinking' || role === 'assistant') {
        updates.state = 'thinking'
      }
    }
    if (Object.keys(updates).length > 0) {
      state.agents.set(agentName, { ...msgAgent, ...updates })
    }
  }

  if (streamId) {
    const id = `stream:${streamId}`
    const msgs = state.conversations.get(agentName)
    const at = msgs ? msgs.findIndex(m => m.id === id) : -1
    if (msgs && at !== -1) {
      const updated = [...msgs]
      updated[at] = { ...updated[at], content }
      state.conversations.set(agentName, updated)
      return
    }
    appendConversation(state.conversations, agentName, { id, type: msgType, content, timestamp: currentTime })
    return
  }
  appendConversation(state.conversations, agentName, { type: msgType, content, timestamp: currentTime })
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const tokens = asNumber(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  // Counts the API measured (the agent-flow-bridge mod's) win over the transcript's estimates
  const isMeasured = asBoolean(payload.isMeasured)
  const agent = state.agents.get(agentName)
  if (agent) {
    const keepsMeasured = agent.isTokensMeasured && !isMeasured
    state.agents.set(agentName, {
      ...agent,
      tokensUsed: keepsMeasured ? agent.tokensUsed : tokens,
      isTokensMeasured: agent.isTokensMeasured || isMeasured,
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      state: agent.state === 'complete' ? 'complete' : 'thinking'
    })
  }
}
