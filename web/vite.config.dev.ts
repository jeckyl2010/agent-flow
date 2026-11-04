import { defineConfig } from 'vite'
import { baseConfig } from './vite.config.shared.ts'
import { DEFAULT_RELAY_PORT } from '../extension/src/constants.ts'

/** `pnpm run dev` follows the dev relay (AGENT_FLOW_DEMO=0); `pnpm run dev:demo` plays the demo */
export default defineConfig({
  ...baseConfig({ demo: process.env.AGENT_FLOW_DEMO !== '0', relayPort: DEFAULT_RELAY_PORT }),
  // localhost only, as everything Agent Flow serves; the next port up when 3000 is taken
  server: { host: 'localhost', port: 3000 },
})
