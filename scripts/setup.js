#!/usr/bin/env node
/**
 * Standalone setup script for Agent Flow.
 *
 * Performs the same hook configuration that the VS Code extension does on
 * activation, so developers can run the webview in dev mode without needing
 * to launch the extension in the debugger first.
 *
 * What it does:
 *   1. Installs the hook forwarding script at ~/.claude/agent-flow/hook.mjs
 *   2. Configures Claude Code hooks in ~/.claude/settings.json
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
// .mjs: Node loads it as an ES module whatever package.json lies above it, such as a
// "type": "module" one in the home directory, which made the old hook.js fail.
const HOOK_SCRIPT_PATH = path.join(DISCOVERY_DIR, 'hook.mjs')
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

const HOOK_TIMEOUT_S = 2
const HOOK_SAFETY_MARGIN_MS = 500
const HOOK_FORWARD_TIMEOUT_MS = 1000
const HOOK_COMMAND_MARKER = 'agent-flow/hook.mjs'
// Hooks from before v4 run hook.js: still ours, and replaced when setup runs
const LEGACY_HOOK_COMMAND_MARKER = 'agent-flow/hook.js'

// ─── Resolve node path ──────────────────────────────────────────────────────

function resolveNodePath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'command'
    const args = process.platform === 'win32' ? ['node'] : ['-v', 'node']
    const result = execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000 }).trim()
    const firstLine = result.split(/\r?\n/)[0].trim()
    if (firstLine) return firstLine
  } catch {}
  return 'node'
}

// ─── Hook script content (mirrors extension/src/discovery.ts) ───────────────

function getHookScriptContent() {
  return `#!/usr/bin/env node
// Agent Flow hook forwarder v4 — installed by the Agent Flow setup script.
// Claude Code invokes this as a command hook. It reads a discovery directory to
// find live extension instances, checks their PIDs, and forwards the event via
// HTTP POST. Dead instances are cleaned up automatically.
// v4: an ES module, hook.mjs: Node loads it as one whatever package.json lies above it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

setTimeout(() => process.exit(0), ${HOOK_TIMEOUT_S * 1000 - HOOK_SAFETY_MARGIN_MS});

const DIR = path.join(os.homedir(), '.claude', 'agent-flow');
const IS_WIN = process.platform === 'win32';

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch { process.exit(0); }
  if (!cwd) process.exit(0);

  const resolvedCwd = normPath(cwd);

  let allFiles;
  try {
    allFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
  } catch { process.exit(0); }
  if (!allFiles.length) process.exit(0);

  const matches = [];
  for (const file of allFiles) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }
    if (!d.workspace || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, file, wsLen: ws.length });
    }
  }

  if (!matches.length) process.exit(0);

  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  const targets = matches.filter(m => m.wsLen === bestLen);

  let pending = targets.length;
  for (const { d } of targets) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const req = http.request({
      hostname: '127.0.0.1', port: d.port, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: ${HOOK_FORWARD_TIMEOUT_MS},
    }, res => { res.resume(); res.on('end', finish); });
    req.on('error', finish);
    req.on('timeout', () => { req.destroy(); });
    req.write(input);
    req.end();
  }

  function done() { if (--pending <= 0) process.exit(0); }
});
`
}

// ─── Install hook script ────────────────────────────────────────────────────

function ensureHookScript() {
  if (!fs.existsSync(DISCOVERY_DIR)) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  }

  const script = getHookScriptContent()
  try {
    if (fs.existsSync(HOOK_SCRIPT_PATH) && fs.readFileSync(HOOK_SCRIPT_PATH, 'utf8') === script) {
      console.log('Hook script already up to date:', HOOK_SCRIPT_PATH)
      return
    }
  } catch {}

  const tmpPath = HOOK_SCRIPT_PATH + `.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, script, { mode: 0o755 })
  fs.renameSync(tmpPath, HOOK_SCRIPT_PATH)
  console.log('Installed hook script:', HOOK_SCRIPT_PATH)
}

// ─── Configure Claude Code hooks ────────────────────────────────────────────

function isAgentFlowHook(entry) {
  return entry.hooks?.some(h =>
    h.command?.includes(HOOK_COMMAND_MARKER) ||
    h.command?.includes(LEGACY_HOOK_COMMAND_MARKER) ||
    h.url?.startsWith('http://127.0.0.1:'),
  )
}

/** Ours, and running the current script: not a legacy hook.js or HTTP hook, which setup replaces. */
function isCurrentAgentFlowHook(entry) {
  return !!entry.hooks?.some(h => h.command?.includes(HOOK_COMMAND_MARKER))
}

function configureHooks() {
  const nodePath = resolveNodePath()
  const hookCommand = `"${nodePath}" "${HOOK_SCRIPT_PATH}"`
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const events = [
    'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd',
  ]

  let settings = {}
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    }
  } catch {
    console.log('Could not read existing settings, starting fresh')
  }

  const existingHooks = settings.hooks || {}
  for (const event of events) {
    const existing = existingHooks[event] || []
    const filtered = existing.filter(entry => !isAgentFlowHook(entry))
    existingHooks[event] = [...filtered, hookEntry]
  }
  settings.hooks = existingHooks

  const dir = path.dirname(SETTINGS_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
  console.log('Configured Claude Code hooks in:', SETTINGS_PATH)
}

// ─── Detection ──────────────────────────────────────────────────────────────

function isAlreadySetup() {
  // Check hook script exists
  if (!fs.existsSync(HOOK_SCRIPT_PATH)) return false

  // Check hooks are configured in settings.json
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return false
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'))
    const hooks = settings.hooks
    if (!hooks || typeof hooks !== 'object') return false
    // Hooks that still run the old hook.js count as not set up, so they're replaced
    return Object.values(hooks).some(entries => {
      if (!Array.isArray(entries)) return false
      return entries.some(entry => isCurrentAgentFlowHook(entry))
    })
  } catch {
    return false
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** Ensure hooks are configured, skip silently if already set up. */
function ensureSetup() {
  if (isAlreadySetup()) return
  console.log('Setting up agent hooks...')
  ensureHookScript()
  configureHooks()
  console.log('')
}

module.exports = { ensureSetup }

// Run directly: node scripts/setup.js [--force]
if (require.main === module) {
  const force = process.argv.includes('--force')

  if (!force && isAlreadySetup()) {
    console.log('Agent Flow is already set up. Run with --force to reconfigure.')
    process.exit(0)
  }

  console.log('Setting up Agent Flow...\n')
  ensureHookScript()
  configureHooks()
  console.log('\nDone! New sessions will stream events to Agent Flow.')
}
