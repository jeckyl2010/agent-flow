import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import type { UserConfig } from 'vite'

/** How a page built from this source finds its events (web/env.d.ts) */
export interface Flags {
  /** Plays the demo session, rather than follow a relay's */
  demo: boolean
  /** The relay's port, on 127.0.0.1; left out, the page's own origin */
  relayPort?: number
}

/** What every page built from this source shares: the dev server's, the webview's, the app's */
export function baseConfig(flags: Flags): UserConfig {
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve(import.meta.dirname) } },
    define: {
      'import.meta.env.AGENT_FLOW_DEMO': JSON.stringify(flags.demo ? '1' : '0'),
      'import.meta.env.AGENT_FLOW_RELAY_PORT': JSON.stringify(flags.relayPort === undefined ? '' : String(flags.relayPort)),
    },
  }
}

interface BuildTarget {
  outDir: string
  entry: string
  name: string
  flags: Flags
}

export function createBuildConfig(target: BuildTarget): UserConfig {
  const base = baseConfig(target.flags)
  return {
    ...base,
    publicDir: false,
    build: {
      outDir: resolve(import.meta.dirname, target.outDir),
      emptyOutDir: true,
      lib: {
        entry: resolve(import.meta.dirname, target.entry),
        formats: ['iife'],
        name: target.name,
        fileName: () => 'index',
      },
      // @ts-expect-error — cssFileName is valid in Vite 8 but not yet in @types
      cssFileName: 'index',
      sourcemap: false,
      minify: true,
      rollupOptions: {
        output: {
          entryFileNames: 'index.js',
          assetFileNames: (info: { names?: string[] }) => {
            if (info.names?.[0]?.endsWith('.css')) return 'index.css'
            return '[name].[ext]'
          },
        },
      },
    },
    define: {
      ...base.define,
      'process.env.NODE_ENV': '"production"',
    },
  }
}
