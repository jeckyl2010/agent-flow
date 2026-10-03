import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ClaudeHookEntry } from './protocol'
import { HOOK_URL_PREFIX, HOOK_TIMEOUT_S } from './constants'
import {
  HOOK_COMMAND_MARKER, LEGACY_HOOK_COMMAND_MARKER,
  getHookCommand, ensureHookScript,
  addWorkspaceToManifest,
} from './discovery'
import { createLogger } from './logger'

const log = createLogger('Hooks')

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

/** Read and parse Claude Code's global settings.json. Returns null on failure. */
function readGlobalSettings(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(GLOBAL_SETTINGS_PATH)) { return null }
    return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'))
  } catch (err) {
    log.debug('Failed to read Claude settings:', err)
    return null
  }
}

/** Check whether a single hook entry belongs to Agent Flow */
function isAgentFlowHook(entry: ClaudeHookEntry): boolean {
  return !!entry.hooks?.some(h =>
    runsCurrentScript(h.command) || runsLegacyScript(h.command) ||
    h.url?.startsWith(HOOK_URL_PREFIX),
  )
}

// Normalize backslashes to forward slashes so Windows paths
// (e.g. "C:\\Users\\...\\agent-flow\\hook.mjs") match the markers.
function runsCurrentScript(command?: string): boolean {
  return !!command?.replace(/\\/g, '/').includes(HOOK_COMMAND_MARKER)
}

/** Runs the hook.js from before v4, which Node loads as an ES module under a "type": "module" home */
function runsLegacyScript(command?: string): boolean {
  return !!command?.replace(/\\/g, '/').includes(LEGACY_HOOK_COMMAND_MARKER)
}

// ─── Detection ────────────────────────────────────────────────────────────────

/** The Claude Code events Agent Flow listens to. Keep in step with scripts/setup.js. */
const HOOK_EVENTS = [
  'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
] as const

/** Whether the settings hold our hook, running hook.mjs and async, on every event: false for an
 *  install from before hook.mjs, an event or `async` was added, so it is configured again. */
function agentFlowHooksCurrent(settingsPath: string): boolean {
  try {
    const hooks = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks ?? {}
    return HOOK_EVENTS.every(event => Array.isArray(hooks[event]) && hooks[event].some((entry: ClaudeHookEntry) =>
      !!entry.hooks?.length && entry.hooks.every(h => runsCurrentScript(h.command) && h.async === true)))
  } catch {
    return false
  }
}

function hooksAlreadyConfigured(): boolean {
  // Ours in the global settings, but from an older version: configure them again
  if (hasAgentFlowHooks(GLOBAL_SETTINGS_PATH)) { return agentFlowHooksCurrent(GLOBAL_SETTINGS_PATH) }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    const projectPath = path.join(workspaceFolder, '.claude', 'settings.local.json')
    if (hasAgentFlowHooks(projectPath)) {
      // Backfill manifest for workspaces configured before the manifest existed
      addWorkspaceToManifest(workspaceFolder)
      return true
    }
  }

  return false
}

function hasAgentFlowHooks(settingsPath: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) { return false }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const hooks = settings.hooks
    if (!hooks || typeof hooks !== 'object') { return false }
    return Object.values(hooks).some((entries: unknown) => {
      if (!Array.isArray(entries)) { return false }
      return entries.some((entry: unknown) => isAgentFlowHook(entry as ClaudeHookEntry))
    })
  } catch (err) {
    log.debug('Failed to read hooks settings:', err)
    return false
  }
}

// ─── Configure ────────────────────────────────────────────────────────────────

export async function configureClaudeHooks(): Promise<void> {
  ensureHookScript()

  const hookCommand = getHookCommand()
  // async: Claude Code doesn't wait for the forwarder, so a slow or absent Agent Flow never delays
  // a session; the hook server puts a tool's start and end back in order (hook-server.ts).
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S, async: true }] }

  const hooksConfig = Object.fromEntries(HOOK_EVENTS.map(event => [event, [hookEntry]]))

  // Read existing settings
  let settings: Record<string, unknown> = readGlobalSettings() ?? {}

  // Merge hooks — preserve existing hooks, replace ours
  const existingHooks = (settings.hooks || {}) as Record<string, unknown[]>
  for (const [event, entries] of Object.entries(hooksConfig)) {
    const existing = existingHooks[event] || []
    // Remove previous agent-flow hooks (command or legacy HTTP)
    const filtered = existing.filter((entry: unknown) => !isAgentFlowHook(entry as ClaudeHookEntry))
    existingHooks[event] = [...filtered, ...entries]
  }

  settings.hooks = existingHooks

  // Write
  const dir = path.dirname(GLOBAL_SETTINGS_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')

  vscode.window.showInformationMessage(
    'Claude Code hooks configured. New sessions will stream events to Agent Flow.',
  )
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Replace legacy hooks with ones running the current script: HTTP hooks, and command hooks
 *  running the hook.js from before v4. Called once on activation.
 *  Caller must call ensureHookScript() first. */
export function migrateLegacyHooks(): void {
  const pathsToCheck: string[] = [GLOBAL_SETTINGS_PATH]
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    pathsToCheck.push(path.join(workspaceFolder, '.claude', 'settings.local.json'))
  }

  const hookCommand = getHookCommand()

  for (const settingsPath of pathsToCheck) {
    try {
      if (!fs.existsSync(settingsPath)) { continue }
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      const hooks = settings.hooks
      if (!hooks || typeof hooks !== 'object') { continue }

      let changed = false
      for (const entries of Object.values(hooks) as unknown[][]) {
        if (!Array.isArray(entries)) { continue }
        for (const entry of entries) {
          const e = entry as ClaudeHookEntry
          if (!e.hooks) { continue }
          for (const h of e.hooks) {
            if (h.url?.startsWith(HOOK_URL_PREFIX)) {
              // Replace HTTP hook with command hook
              delete h.url
              h.type = 'command'
              h.command = hookCommand
              if (h.timeout === undefined) { h.timeout = HOOK_TIMEOUT_S }
              changed = true
            } else if (runsLegacyScript(h.command)) {
              h.command = hookCommand
              changed = true
            }
          }
        }
      }

      if (changed) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
        log.info(`Migrated legacy hooks → ${HOOK_COMMAND_MARKER} in ${settingsPath}`)
        // Ensure migrated project-level hooks are tracked in the manifest
        if (workspaceFolder && settingsPath.includes(workspaceFolder)) {
          addWorkspaceToManifest(workspaceFolder)
        }
      }
    } catch (err) {
      log.error(`Failed to migrate ${settingsPath}:`, err)
    }
  }
}

// ─── Claude Code Environment ─────────────────────────────────────────────────

/** Check whether CLAUDE_CODE_DISABLE_1M_CONTEXT is set (via env or Claude Code settings). */
export function isDisable1MContext(): boolean {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') { return true }
  const settings = readGlobalSettings()
  return (settings?.env as Record<string, unknown>)?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

export async function promptHookSetupIfNeeded(_context: vscode.ExtensionContext): Promise<void> {
  if (hooksAlreadyConfigured()) { return }
  await configureClaudeHooks()
}
