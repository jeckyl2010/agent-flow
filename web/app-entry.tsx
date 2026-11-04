import { createRoot } from 'react-dom/client'
import { AgentVisualizer } from './components/agent-visualizer'
import './globals.css'

// The desktop app and `pnpm run dev`: no VS Code API, events come from a relay over SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
root.render(<AgentVisualizer />)
