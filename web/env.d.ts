/// <reference types="vite/client" />

/** Set at build time by each Vite config: the webview, the desktop app and the dev server */
interface ImportMetaEnv {
  /** `0` follows a relay's sessions; anything else plays the demo */
  readonly AGENT_FLOW_DEMO: string
  /** The relay's port; empty for the page's own origin */
  readonly AGENT_FLOW_RELAY_PORT: string
  /** `1` in the desktop app, which serves the page and its relay together */
  readonly AGENT_FLOW_STANDALONE: string
}
