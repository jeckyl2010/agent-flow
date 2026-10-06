import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { FX } from '@/lib/agent-types'
import { WORMHOLE } from '@/lib/canvas-constants'
import { COLORS } from '@/lib/colors'
import type { VisualEffect } from './draw-effects'

/** A semantic state transition detected between frames. */
export type StateTransition =
  | { kind: 'agent_spawn' }
  | { kind: 'agent_complete' }
  | { kind: 'tool_start' }
  | { kind: 'tool_complete' }
  | { kind: 'tool_error' }
  | { kind: 'compaction_open' }
  /** `delay`: seconds until the jump is drawn, for one seen only ended, which opens first */
  | { kind: 'compaction_jump'; delay: number }

/** The key a compaction's state is kept under beside its agent's, in the agent states map */
const compactionKey = (id: string) => `${id}\u0000compaction`

/**
 * Compare previous and current agent/tool states and return both visual effects
 * and semantic transitions.
 *
 * This is a pure function: it reads the previous state maps, computes results,
 * and returns the effects, transitions, and updated state maps.
 *
 * Both the canvas (for visuals) and the audio system (for sounds) consume
 * these results, keeping detection logic in a single place.
 */
export function detectStateChanges(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  prevAgentStates: Map<string, string>,
  prevToolStates: Map<string, string>,
): {
  effects: VisualEffect[]
  transitions: StateTransition[]
  newAgentStates: Map<string, string>
  newToolStates: Map<string, string>
} {
  const effects: VisualEffect[] = []
  const transitions: StateTransition[] = []
  const newAgentStates = new Map<string, string>()
  const newToolStates = new Map<string, string>()

  for (const [id, agent] of agents) {
    newAgentStates.set(id, agent.state)
    const oldState = prevAgentStates.get(id)

    // Spawn: new agent (wasn't in prev)
    if (!oldState) {
      transitions.push({ kind: 'agent_spawn' })
      if (agent.opacity < 0.5) {
        effects.push({
          type: 'spawn', x: agent.x, y: agent.y,
          color: COLORS.holoBase, age: 0, duration: FX.spawnDuration,
        })
      }
    }

    // A compaction from the session's own time (not history): opening, then jumping
    const latest = agent.compactions?.at(-1)
    if (latest) {
      const key = compactionKey(id)
      const now = `${agent.compactions!.length}:${latest.phase}`
      newAgentStates.set(key, now)
      const before = prevAgentStates.get(key)
      if (!latest.isHistory && before !== now) {
        if (latest.phase === 'running') transitions.push({ kind: 'compaction_open' })
        else if (latest.phase === 'done') {
          // Seen running, it jumps now; seen only ended (a transcript), it opens first
          const wasRunning = before === `${agent.compactions!.length}:running`
          if (!wasRunning) transitions.push({ kind: 'compaction_open' })
          transitions.push({ kind: 'compaction_jump', delay: wasRunning ? 0 : WORMHOLE.open })
        }
      }
    }

    // Complete: just became complete
    if (oldState && oldState !== 'complete' && agent.state === 'complete') {
      transitions.push({ kind: 'agent_complete' })
      effects.push({
        type: 'complete', x: agent.x, y: agent.y,
        color: COLORS.complete, age: 0, duration: FX.completeDuration,
      })
    }
  }

  for (const [id, tool] of toolCalls) {
    newToolStates.set(id, tool.state)
    const oldState = prevToolStates.get(id)

    // Tool just started running
    if (!oldState && tool.state === 'running') {
      transitions.push({ kind: 'tool_start' })
    }

    // Tool just completed
    if (oldState === 'running' && tool.state === 'complete') {
      transitions.push({ kind: 'tool_complete' })
      const particleData: VisualEffect['particles'] = []
      for (let i = 0; i < FX.shatterCount; i++) {
        particleData.push({
          angle: (i / FX.shatterCount) * Math.PI * 2 + Math.random() * 0.5,
          speed: FX.shatterSpeed.min + Math.random() * FX.shatterSpeed.range,
          size: FX.shatterSize.min + Math.random() * FX.shatterSize.range,
        })
      }
      effects.push({
        type: 'shatter', x: tool.x, y: tool.y,
        color: COLORS.return, age: 0, duration: FX.shatterDuration,
        particles: particleData,
      })
    }

    // Tool errored
    if (oldState === 'running' && tool.state === 'error') {
      transitions.push({ kind: 'tool_error' })
    }
  }

  return { effects, transitions, newAgentStates, newToolStates }
}
