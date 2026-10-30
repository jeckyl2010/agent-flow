import { CLAUDE_FAMILY_ALTERNATION } from './canvas-constants'

/** Convert a 0–1 alpha value to a two-character hex string (e.g. 0.5 → '80') */
export function alphaHex(alpha: number): string {
  return Math.floor(alpha * 255).toString(16).padStart(2, '0')
}

/** Format a token count for display (e.g. 128500 → '128k') */
export function formatTokens(tokens: number): string {
  return `${Math.floor(tokens / 1000)}k`
}

/** A count at a glance: `895`, `12.4k`, `62.3M`, `1.2B` */
export function formatCount(n: number): string {
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]
  for (const [size, unit] of units) {
    if (n >= size) return `${+(n / size).toFixed(n >= size * 100 ? 0 : 1)}${unit}`
  }
  return String(Math.round(n))
}

/** Truncate a file path to the last N segments (e.g. '/a/b/c/d.ts' → 'b/c/d.ts') */
export function truncatePath(path: string, segments = 3): string {
  return path.split('/').slice(-segments).join('/')
}

/** A model ID as Claude Code spells it, lower-cased, whatever spelling a gateway gave it:
 *  `claude-opus-4.8` is `claude-opus-4-8` (2.1.314 reads it so too) */
export function canonicalModelId(model: string): string {
  return dashedVersion(model.toLowerCase())
}

/** `4.8` in a model ID as `4-8` */
function dashedVersion(model: string): string {
  return model.replace(/(\d)\.(?=\d)/g, '$1-')
}

const PROVIDER_PREFIX = /^[a-z]+\.anthropic\./i
const VERSION_SUFFIX = /-v\d+:\d+$/i
const DATE_STAMP = /-\d{8}(?=$|-)/

const CLAUDE_NEW = new RegExp(`claude-(${CLAUDE_FAMILY_ALTERNATION})-(\\d+)(?:-(\\d+))?`, 'i')
const CLAUDE_LEGACY = new RegExp(`claude-(\\d+)(?:-(\\d+))?-(${CLAUDE_FAMILY_ALTERNATION})`, 'i')
const GPT = /gpt-(\S+?)(?:-\d{4}-\d{2}-\d{2})?$/i

function claudeLabel(family: string, major: string, minor?: string): string {
  const name = family[0].toUpperCase() + family.slice(1).toLowerCase()
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

/** Format a raw model ID for display (e.g. 'claude-opus-4-6-20250514' → 'Opus 4.6'). */
export function formatModelName(model: string): string {
  const base = model
    .replace(PROVIDER_PREFIX, '')
    .replace(VERSION_SUFFIX, '')
    .replace(DATE_STAMP, '')

  // A gateway may spell Claude's version with a dot (`claude-opus-4.8`); GPT's is always dotted
  const m = dashedVersion(base).match(CLAUDE_NEW)
  if (m) return claudeLabel(m[1], m[2], m[3])

  const legacy = base.match(CLAUDE_LEGACY)
  if (legacy) return claudeLabel(legacy[3], legacy[1], legacy[2])

  const gpt = base.match(GPT)
  if (gpt) return `GPT-${gpt[1]}`

  return base
}

/** What an agent's model tag reads: `OPUS 5.5 · HIGH` */
export function modelTagLabel(model: string, effort?: string): string {
  const name = formatModelName(model).toUpperCase()
  return effort ? `${name} · ${effort.toUpperCase()}` : name
}

/** A small amount of money with the digits that show it: $0.0066, $0.26, $1.40 */
export function formatUsd(v: number): string {
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`
}
