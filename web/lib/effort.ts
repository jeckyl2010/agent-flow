import { COLORS } from './colors'

/** How hard a request asks the model to think, lowest first: the level is the position, 1 to 5 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** 1 (low) to 5 (max), or undefined for a numeric or unknown effort */
export function effortLevel(effort?: string): number | undefined {
  const i = EFFORT_LEVELS.indexOf(effort as typeof EFFORT_LEVELS[number])
  return i === -1 ? undefined : i + 1
}

/** Brighter and warmer as effort rises, within the holographic palette */
export function effortColor(effort?: string): string {
  switch (effortLevel(effort)) {
    case 1: return COLORS.holoBase + '99'
    case 2: return COLORS.holoBase
    case 3: return COLORS.holoBright
    case 4: return COLORS.dispatch
    case 5: return COLORS.holoHot
    default: return COLORS.holoBase
  }
}
