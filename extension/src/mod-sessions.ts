/**
 * Sessions the agent-flow-bridge mod reports, shared across this process's watchers.
 *
 * The mod sends the engine's own events (a permission request exactly when its dialog shows),
 * so for these sessions the watchers' inferences from the transcript are not needed.
 */

const modSessions = new Set<string>()
/** sessionId → agentId → the name the mod's subagent was spawned under */
const reportedNames = new Map<string, Map<string, string>>()

export function markModSession(sessionId: string): void {
  modSessions.add(sessionId)
}

export function forgetModSession(sessionId: string): void {
  modSessions.delete(sessionId)
  reportedNames.delete(sessionId)
}

/** Records the name a reported subagent was spawned under (a teammate's name in the team, a
 *  workflow agent's place in its run), which its transcript's meta file doesn't carry */
export function nameReportedAgent(sessionId: string, agentId: string, name: string): void {
  let names = reportedNames.get(sessionId)
  if (!names) reportedNames.set(sessionId, names = new Map())
  names.set(agentId, name)
}

/** The name a reported subagent was spawned under, or undefined before its spawn is reported */
export function reportedAgentName(sessionId: string, agentId: string): string | undefined {
  return reportedNames.get(sessionId)?.get(agentId)
}

export function isModSession(sessionId: string): boolean {
  return modSessions.has(sessionId)
}
