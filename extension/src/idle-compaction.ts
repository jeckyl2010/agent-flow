/**
 * Whether Claude Code's idle compaction (2.1.299+) can run in a session the transcript alone
 * reports: it runs in the terminal, and since 2.1.314 in VS Code and the desktop app's Code tab,
 * and not where settings.json sets `"idleCompaction": false`
 * (the `/config` row since 2.1.302) or `DISABLE_COMPACT` in a settings file's `env` turns off all
 * compaction. The bridge mod reads these from the engine instead.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** The transcript's `entrypoint` of a session run in the terminal */
const TERMINAL_ENTRYPOINT = 'cli'
/** The entrypoints of VS Code's and the desktop app's Code tab, where idle compaction runs too
 *  since 2.1.314 */
const APP_ENTRYPOINTS = new Set(['claude-vscode', 'claude-desktop'])
const APP_IDLE_COMPACTION_SINCE = '2.1.314'

/** The settings files that can set it, highest precedence first: the project's local, the
 *  project's, the user's. Managed settings aren't read */
function settingsFiles(cwd: string | undefined, home: string): string[] {
  return [
    ...(cwd ? [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json')] : []),
    path.join(home, '.claude', 'settings.json'),
  ]
}

/** `idleCompaction` as the first settings file that sets it has it, or undefined where none does */
export function idleCompactionSetting(cwd: string | undefined, home = os.homedir()): boolean | undefined {
  for (const file of settingsFiles(cwd, home)) {
    try {
      const value = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).idleCompaction
      if (typeof value === 'boolean') return value
    } catch { /* no such file, or not JSON */ }
  }
  return undefined
}

/** Whether a settings file's `env` sets DISABLE_COMPACT, which turns off all compaction. Since
 *  2.1.311 a settings file can only turn it on, so any file that does wins. Not read: the variable
 *  in the environment Claude Code was started in, which only the bridge mod sees */
export function isCompactionDisabled(cwd: string | undefined, home = os.homedir()): boolean {
  return settingsFiles(cwd, home).some(file => {
    try {
      const env = (JSON.parse(fs.readFileSync(file, 'utf8')) as { env?: Record<string, unknown> }).env
      const value = env?.DISABLE_COMPACT
      return typeof value === 'string' && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
    } catch { return false } // no such file, or not JSON
  })
}

/** Whether `version` (`2.1.314`) is `min` or later; an unreadable one counts as older */
export function isVersionAtLeast(version: string | undefined, min: string): boolean {
  const parts = (v: string) => v.split(/[.-]/, 3).map(Number)
  const have = version ? parts(version) : []
  if (have.length < 3 || have.some(n => !Number.isFinite(n))) return false
  const want = parts(min)
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i]! > want[i]!
  return true
}

/** Whether idle compaction can run in a session of this entrypoint, Claude Code version and
 *  working directory */
export function canIdleCompact(entrypoint: string, version: string | undefined, cwd: string | undefined, home?: string): boolean {
  const isSurface = entrypoint === TERMINAL_ENTRYPOINT
    || (APP_ENTRYPOINTS.has(entrypoint) && isVersionAtLeast(version, APP_IDLE_COMPACTION_SINCE))
  return isSurface && idleCompactionSetting(cwd, home) !== false && !isCompactionDisabled(cwd, home)
}
