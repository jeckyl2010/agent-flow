import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared.ts'

export default defineConfig(createBuildConfig({
  outDir: '../app/dist/webview',
  entry: 'app-entry.tsx',
  name: 'AgentFlowApp',
  define: {
    'import.meta.env.AGENT_FLOW_DEMO': '"0"',
    'import.meta.env.AGENT_FLOW_RELAY_PORT': '""',
    'import.meta.env.AGENT_FLOW_STANDALONE': '"1"',
  },
}))
