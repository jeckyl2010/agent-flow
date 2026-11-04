/// <reference types="vite/client" />

/** Set at build time from each Vite config's flags (vite.config.shared.ts baseConfig) */
interface ImportMetaEnv {
  /** `0` follows a relay's sessions; `1` plays the demo */
  readonly AGENT_FLOW_DEMO: '0' | '1'
  /** The relay's port on 127.0.0.1; empty for the page's own origin */
  readonly AGENT_FLOW_RELAY_PORT: string
}
