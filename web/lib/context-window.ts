import { DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, MODEL_FAMILY_CONTEXT } from './canvas-constants'
import { canonicalModelId } from './utils'

export interface ContextWindowOptions {
  /** CLAUDE_CODE_DISABLE_1M_CONTEXT: every window is at most 200K */
  disable1MContext?: boolean
  /** CLAUDE_CODE_MAX_CONTEXT_TOKENS: the window of a `claude-` model ID Claude Code doesn't recognize */
  maxContextTokens?: number
}

/** The context window Claude Code assumes for a model. A family it recognizes has its own; since
 *  2.1.326 an ID it doesn't, such as a gateway's `claude-sonnet-latest` or another vendor's, gets
 *  1M, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` sets it for one that starts with `claude-`. Where the
 *  mod reports the session's real window, that stands over this estimate */
export function contextWindowSize(modelId: string | undefined, options: ContextWindowOptions = {}): number {
  const { disable1MContext = false, maxContextTokens } = options
  const capped = (size: number) => disable1MContext ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size
  if (!modelId) return capped(FALLBACK_CONTEXT_SIZE)
  const id = canonicalModelId(modelId)
  for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
    if (pattern.test(id)) return capped(size)
  }
  if (maxContextTokens && maxContextTokens > 0 && id.startsWith('claude-')) return maxContextTokens
  return capped(FALLBACK_CONTEXT_SIZE)
}
