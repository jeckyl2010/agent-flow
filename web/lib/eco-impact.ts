/**
 * Environmental impacts of the session's model requests, after EcoLogits' LLM inference
 * methodology (https://ecologits.ai/latest/methodology/llm_inference/, ecologits/impacts/llm.py).
 *
 * EcoLogits figures a request from its output tokens alone: generating them is what runs the GPUs.
 * Input and cache reads are not counted. Anthropic does not publish its models' sizes, so the
 * parameter counts are EcoLogits' estimates, given as ranges; every impact is a min–max range.
 * The data (web/lib/data/ecologits.json) is refreshed by scripts/update-ecologits-data.ts.
 */
import type { Agent } from './agent-types'
import { inferenceZone } from './inference-zone'
import data from './data/ecologits.json'

export interface Range {
  min: number
  max: number
}

export interface EcoImpacts {
  /** kWh */
  energy: Range
  /** Global warming potential, kgCO2eq */
  gwp: Range
  /** Abiotic depletion of elements (metals & minerals), kgSbeq */
  adpe: Range
  /** Primary energy (fossil fuels and other sources), MJ */
  pe: Range
  /** Water consumption, L */
  wcf: Range
}

export type ImpactKind = keyof EcoImpacts

type ValueOrRange = number | Range

interface ModelEntry {
  name: string
  architecture:
    | { type: 'dense'; parameters: ValueOrRange }
    | { type: 'moe'; parameters: { total: ValueOrRange; active: ValueOrRange } }
  deployment?: { tps: number; ttft: number }
}

interface ElectricityMix {
  name: string
  adpe: number
  pe: number
  gwp: number
  wue: number
}

// The constants of ecologits/impacts/llm.py
const QUANTIZATION_BITS = 16
const GPU_ENERGY_ALPHA = 1.1665273170451914e-06
const GPU_ENERGY_BETA = -0.011205921025579175
const GPU_ENERGY_GAMMA = 4.052928146734005e-05
const LATENCY_ALPHA = 0.0006785088094353663
const LATENCY_BETA = 0.0003119310311688259
const LATENCY_GAMMA = 0.019473717579473387
const GPU_MEMORY = 80 // GB
const GPU_EMBODIED = { gwp: 273, adpe: 0.00895, pe: 3721 }
const SERVER_GPUS = 8
const SERVER_POWER = 1.2 // kW
const SERVER_EMBODIED = { gwp: 5700, adpe: 0.37, pe: 70000 }
const HARDWARE_LIFESPAN = 3 * 365 * 24 * 60 * 60 // s
const BATCH_SIZE = 64

const MODELS = data.models as ModelEntry[]
const ALIASES = new Map(data.aliases.map(a => [a.name, a.alias]))
const MIXES = data.electricityMixes as ElectricityMix[]

/** Where Anthropic's requests are figured: EcoLogits puts its data centers in the USA */
const DEFAULT_ZONE = data.provider.location

const lo = (v: ValueOrRange) => (typeof v === 'number' ? v : v.min)
const hi = (v: ValueOrRange) => (typeof v === 'number' ? v : v.max)

/** The EcoLogits entry for a model ID: `claude-opus-5-5`, `claude-opus-5-5[1m]`, `claude-haiku-4-5`, … */
export function findModel(modelId: string | undefined): ModelEntry | undefined {
  if (!modelId) return undefined
  const id = modelId.toLowerCase().replace(/\[.*\]$/, '')
  const name = ALIASES.get(id) ?? id
  // The longest name the ID contains: `claude-opus-5-5-…` is Opus 5.5, not Opus 5
  let best: ModelEntry | undefined
  for (const m of MODELS) {
    if (name.includes(m.name) && (!best || m.name.length > best.name.length)) best = m
  }
  return best
}

interface Point {
  activeParams: number
  totalParams: number
  pue: number
  wue: number
}

/** One end of the range: ecologits' compute_llm_impacts_dag, for `requests` requests together.
 *  Every term is linear in output tokens and latency, so the requests can be summed first. */
function impactsAt(p: Point, model: ModelEntry, outputTokens: number, requests: number, mix: ElectricityMix) {
  const gpuEnergyPerToken =
    (GPU_ENERGY_ALPHA * Math.exp(GPU_ENERGY_BETA * BATCH_SIZE) * p.activeParams + GPU_ENERGY_GAMMA) / 1000
  const gpuEnergy = outputTokens * gpuEnergyPerToken

  const d = model.deployment
  const latency = d
    ? outputTokens / d.tps + requests * d.ttft
    : outputTokens * (LATENCY_ALPHA * p.activeParams + LATENCY_BETA * BATCH_SIZE + LATENCY_GAMMA)

  const requiredMemory = 1.2 * p.totalParams * QUANTIZATION_BITS / 8
  const gpus = 2 ** Math.ceil(Math.log2(Math.ceil(requiredMemory / GPU_MEMORY)))

  const serverEnergy = (latency / 3600) * SERVER_POWER * (gpus / SERVER_GPUS) / BATCH_SIZE
  const itEnergy = serverEnergy + gpus * gpuEnergy
  const energy = p.pue * itEnergy

  const embodied = (key: 'gwp' | 'adpe' | 'pe') => {
    const hardware = (gpus / SERVER_GPUS) * SERVER_EMBODIED[key] + gpus * GPU_EMBODIED[key]
    return latency * hardware / (HARDWARE_LIFESPAN * BATCH_SIZE)
  }
  return {
    energy,
    gwp: energy * mix.gwp + embodied('gwp'),
    adpe: energy * mix.adpe + embodied('adpe'),
    pe: energy * mix.pe + embodied('pe'),
    wcf: itEnergy * (p.wue + p.pue * mix.wue),
  }
}

/** What generating `outputTokens` over `requests` requests took, or undefined for a model
 *  EcoLogits has no estimate for */
export function llmImpacts(
  modelId: string | undefined,
  outputTokens: number,
  requests = 1,
  zone = DEFAULT_ZONE,
): EcoImpacts | undefined {
  const model = findModel(modelId)
  const mix = MIXES.find(m => m.name === zone)
  if (!model || !mix) return undefined

  const arch = model.architecture
  const total = arch.type === 'moe' ? arch.parameters.total : arch.parameters
  const active = arch.type === 'moe' ? arch.parameters.active : arch.parameters
  const { pue, wue } = data.provider
  const min = impactsAt({ activeParams: lo(active), totalParams: lo(total), pue: pue.min, wue: wue.min }, model, outputTokens, requests, mix)
  const max = impactsAt({ activeParams: hi(active), totalParams: hi(total), pue: pue.max, wue: wue.max }, model, outputTokens, requests, mix)
  return {
    energy: { min: min.energy, max: max.energy },
    gwp: { min: min.gwp, max: max.gwp },
    adpe: { min: min.adpe, max: max.adpe },
    pe: { min: min.pe, max: max.pe },
    wcf: { min: min.wcf, max: max.wcf },
  }
}

const IMPACT_KINDS: readonly ImpactKind[] = ['energy', 'gwp', 'wcf', 'adpe', 'pe']

function zeroImpacts(): EcoImpacts {
  const z = () => ({ min: 0, max: 0 })
  return { energy: z(), gwp: z(), adpe: z(), pe: z(), wcf: z() }
}

export function midpoint(r: Range): number {
  return (r.min + r.max) / 2
}

/** A grid the session's requests were figured at, and the output tokens figured at it */
export interface GridShare { zone: string; basis: string; outputTokens: number }

export interface SessionImpacts {
  total: EcoImpacts
  /** The grids it was figured at, most output first */
  grids: GridShare[]
  /** The gateways its requests went through (their hosts): the model and region are as asked */
  gateways: string[]
  /** Output tokens counted: those of agents whose model EcoLogits estimates */
  outputTokens: number
  /** Agents whose requests were measured but whose model has no estimate (Codex, unknown models) */
  uncountedAgents: number
  /** Some agents' requests were not all measured, or not measured at all */
  isPartial: boolean
}

/**
 * The session's impacts, from each agent's measured requests: per model where the usage says how
 * it split (an agent can switch models), otherwise all at its latest model. Agents without
 * measured usage add nothing. Each part is figured at the grid where it ran (Anthropic's API in
 * the USA, Bedrock or Vertex in their region), or at `zone` for all of them when one is chosen.
 */
export function sessionImpacts(agents: Map<string, Agent>, zone?: string): SessionImpacts {
  const total = zeroImpacts()
  const grids = new Map<string, GridShare>()
  const gateways = new Set<string>()
  let outputTokens = 0
  let uncountedAgents = 0
  let isPartial = false
  for (const a of agents.values()) {
    if (!a.spend) {
      if (a.tokensUsed > 0) isPartial = true
      continue
    }
    if (!a.spend.isComplete) isPartial = true
    if (a.spend.inference?.gateway) gateways.add(a.spend.inference.gateway)
    const parts = a.spend.byModel?.length
      ? a.spend.byModel
      : [{ model: a.modelTag?.model ?? a.model ?? '', output: a.spend.output, requests: a.spend.steps }]
    let counted = false
    for (const part of parts) {
      const site = zone && hasMix(zone)
        ? { zone, basis: 'chosen' }
        : inferenceZone(part.model, a.spend.inference)
      // A grid the data doesn't hold: the USA's, as EcoLogits figures Anthropic
      const at = hasMix(site.zone) ? site : { zone: DEFAULT_ZONE, basis: `${site.basis}, no data for ${site.zone}` }
      const impacts = llmImpacts(part.model, part.output, part.requests, at.zone)
      if (!impacts) continue
      counted = true
      outputTokens += part.output
      const key = `${at.zone}|${at.basis}`
      const share = grids.get(key) ?? { zone: at.zone, basis: at.basis, outputTokens: 0 }
      share.outputTokens += part.output
      grids.set(key, share)
      for (const k of IMPACT_KINDS) {
        total[k].min += impacts[k].min
        total[k].max += impacts[k].max
      }
    }
    if (!counted) uncountedAgents++
  }
  return {
    total, grids: [...grids.values()].sort((x, y) => y.outputTokens - x.outputTokens),
    gateways: [...gateways], outputTokens, uncountedAgents, isPartial,
  }
}

/** Whether the data holds a zone's electricity mix */
export function hasMix(zone: string): boolean {
  return MIXES.some(m => m.name === zone)
}

/**
 * A grid chosen for every request in place of where they ran: `?grid=EEE` in the URL, or kept as
 * `agent-flow.grid` in this browser's storage. Undefined when none is, or the data has no such grid
 */
export function chosenGrid(): string | undefined {
  if (typeof window === 'undefined') return undefined
  let grid = new URLSearchParams(window.location.search).get('grid') ?? undefined
  try {
    if (grid) window.localStorage.setItem('agent-flow.grid', grid)
    else grid = window.localStorage.getItem('agent-flow.grid') ?? undefined
  } catch { /* no storage: the URL's alone */ }
  if (grid === 'auto') {
    try { window.localStorage.removeItem('agent-flow.grid') } catch { /* nothing kept */ }
    return undefined
  }
  return grid && hasMix(grid.toUpperCase()) ? grid.toUpperCase() : undefined
}

/** The zones the data holds, for choosing one */
export function mixZones(): string[] {
  return MIXES.map(m => m.name)
}

// ─── Display ────────────────────────────────────────────────────────────────

/** A value in the unit that reads best, at 3 significant digits */
export function formatImpact(kind: ImpactKind, value: number): { value: string; unit: string } {
  const scales: Record<ImpactKind, ReadonlyArray<[number, string]>> = {
    energy: [[1, 'kWh'], [1e-3, 'Wh'], [1e-6, 'mWh']],
    gwp: [[1, 'kgCO₂eq'], [1e-3, 'gCO₂eq'], [1e-6, 'mgCO₂eq']],
    wcf: [[1, 'L'], [1e-3, 'mL']],
    adpe: [[1e-6, 'mgSbeq'], [1e-9, 'µgSbeq'], [1e-12, 'ngSbeq']],
    pe: [[1, 'MJ'], [1e-3, 'kJ'], [1e-6, 'J']],
  }
  const list = scales[kind]
  const [factor, unit] = list.find(([f]) => value >= f) ?? list.at(-1)!
  return { value: String(Number((value / factor).toPrecision(3))), unit }
}

/** Something familiar the value amounts to: rough, for a sense of scale */
export function impactEquivalent(kind: ImpactKind, value: number): string | undefined {
  const n = (x: number) => (x >= 10 ? Math.round(x).toLocaleString() : x.toPrecision(2))
  switch (kind) {
    case 'energy': return `≈ ${n(value / 0.015)} smartphone charges`
    case 'gwp': {
      const km = value / 0.17 // an average petrol car, kgCO2eq per km
      return km >= 1 ? `≈ ${n(km)} km in a petrol car` : `≈ ${n(km * 1000)} m in a petrol car`
    }
    case 'wcf': return `≈ ${n(value / 0.5)} half-litre bottles`
    case 'pe': return `≈ ${n(value / 34.2 * 1000)} mL of petrol burned`
    default: return undefined
  }
}
