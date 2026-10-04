/**
 * A new session to watch. The extension's watcher and the standalone relay both build sessions;
 * one constructor keeps them from drifting apart (a field added to one and not the other once
 * crashed the relay on its first transcript line).
 */
import type { WatchedSession } from './protocol'
import { SYSTEM_PROMPT_BASE_TOKENS } from './constants'

export function createWatchedSession(
  sessionId: string,
  filePath: string,
  { label, lastActivityTime }: { label: string; lastActivityTime: number },
): WatchedSession {
  return {
    sessionId,
    filePath,
    fileWatcher: null,
    pollTimer: null,
    fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    usageSeenIds: new Set(),
    usageTotals: new Map(),
    sessionDetected: false,
    sessionCompleted: false,
    lastActivityTime,
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: null,
    label,
    labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null,
    permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}
