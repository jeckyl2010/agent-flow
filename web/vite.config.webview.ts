import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared.ts'
import { DEFAULT_RELAY_PORT } from '../extension/src/constants.ts'

export default defineConfig(createBuildConfig({
  outDir: '../extension/dist/webview',
  entry: 'webview-entry.tsx',
  name: 'AgentFlowWebview',
  define: {
    'import.meta.env.AGENT_FLOW_DEMO': '"1"',
    'import.meta.env.AGENT_FLOW_RELAY_PORT': JSON.stringify(String(DEFAULT_RELAY_PORT)),
    'import.meta.env.AGENT_FLOW_STANDALONE': '"0"',
  },
}))
