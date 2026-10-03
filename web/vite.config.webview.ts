import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared.ts'
import { DEFAULT_RELAY_PORT } from '../extension/src/constants.ts'

export default defineConfig(createBuildConfig({
  outDir: '../extension/dist/webview',
  entry: 'webview-entry.tsx',
  name: 'AgentFlowWebview',
  define: {
    'process.env.NEXT_PUBLIC_DEMO': '"1"',
    'process.env.NEXT_PUBLIC_RELAY_PORT': JSON.stringify(String(DEFAULT_RELAY_PORT)),
    'process.env.AGENT_FLOW_STANDALONE': '"0"',
  },
}))
