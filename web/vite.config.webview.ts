import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared.ts'

// Inside VS Code the extension posts the events: the page follows no relay of its own
export default defineConfig(createBuildConfig({
  outDir: '../extension/dist/webview',
  entry: 'webview-entry.tsx',
  name: 'AgentFlowWebview',
  flags: { demo: true },
}))
