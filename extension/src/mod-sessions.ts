/**
 * Sessions the agent-flow-bridge mod reports, shared across this process's watchers.
 *
 * The mod sends the engine's own events (a permission request exactly when its dialog shows),
 * so for these sessions the watchers' inferences from the transcript are not needed.
 */

const modSessions = new Set<string>()

export function markModSession(sessionId: string): void {
  modSessions.add(sessionId)
}

export function forgetModSession(sessionId: string): void {
  modSessions.delete(sessionId)
}

export function isModSession(sessionId: string): boolean {
  return modSessions.has(sessionId)
}
