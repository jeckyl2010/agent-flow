import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared.ts'

// The desktop app serves the page and its relay from one origin
export default defineConfig(createBuildConfig({
  outDir: '../app/dist/webview',
  entry: 'app-entry.tsx',
  name: 'AgentFlowApp',
  flags: { demo: false },
}))
