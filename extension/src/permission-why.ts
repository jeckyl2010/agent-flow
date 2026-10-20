/**
 * Why a permission dialog asks, in a few words, from what the agent-flow-bridge mod read of the
 * check that asked.
 */

/** What the bridge mod says of the check behind a permission dialog */
export interface PermissionAsk {
  /** `ask` where the organization's administrators require an approval */
  ceiling?: string
  /** The settings rule that decided, as written */
  rule?: string
  /** The classic hook event whose hook asked (`PreToolUse`), and the setting whose check did */
  hook?: string
  setting?: string
  /** `person` where only a person may answer it, no classifier (2.1.304+) */
  decider?: string
  reason?: string
}

/** What a setting's own check asking means, where its key alone wouldn't say */
const SETTING_WHY: Record<string, string> = {
  'permissions.blockReadsOutsideWorkingDirectories': 'It reads outside the working directories',
}

/** Why a permission dialog asks, in a few words: the organization's requirement, the settings
 *  rule, the hook or setting that asked, or the check's own reason; and where only a person may
 *  answer it, no classifier (mod only) */
export function permissionWhy(payload: PermissionAsk): string | undefined {
  const why = payload.ceiling === 'ask' ? 'Your organization requires approval'
    : payload.rule ? `Rule ${payload.rule}`
    : payload.hook ? `A ${payload.hook} hook asks${payload.reason ? `: ${payload.reason}` : ''}`
    : payload.setting ? SETTING_WHY[payload.setting] ?? `Setting ${payload.setting}`
    : payload.reason
  if (payload.decider !== 'person') return why
  return why ? `${why} · only you can approve it` : 'Only you can approve it'
}
