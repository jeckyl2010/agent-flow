import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { defineConfig } from 'vite'

/** `pnpm run dev` and `pnpm run dev:demo`: the app served from source on :3000. `dev` sets
 *  AGENT_FLOW_DEMO=0 and AGENT_FLOW_RELAY_PORT to follow the dev relay; `dev:demo` plays the demo */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': import.meta.dirname } },
  // localhost only, as everything Agent Flow serves; the next port up when 3000 is taken
  server: { host: 'localhost', port: 3000 },
  define: {
    'import.meta.env.AGENT_FLOW_DEMO': JSON.stringify(process.env.AGENT_FLOW_DEMO ?? '1'),
    'import.meta.env.AGENT_FLOW_RELAY_PORT': JSON.stringify(process.env.AGENT_FLOW_RELAY_PORT ?? ''),
    'import.meta.env.AGENT_FLOW_STANDALONE': '"0"',
  },
})
