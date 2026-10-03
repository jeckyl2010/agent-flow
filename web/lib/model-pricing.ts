/**
 * Per-model token prices, for spend the API measured (the agent-flow-bridge mod's per-request
 * usage) and the blended rate that estimates fall back on.
 *
 * Prices are $ per million tokens, Anthropic first-party API rates. Versions within a family
 * differ (Opus 5.5 costs less than Opus 5; cache reads are not one multiple of input), so entries
 * match model IDs version-first. Matched against lower-cased IDs; first match wins.
 */

export interface ModelPrice {
  input: number
  output: number
  /** A cache read, per million tokens */
  cacheRead: number
}

/** The API's usage for one model request, as the bridge mod reports it */
export interface StepUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** A cache write with the default 5-minute TTL costs this multiple of input */
export const CACHE_WRITE_MULTIPLIER = 1.25

const MODEL_PRICES: ReadonlyArray<{ pattern: RegExp; price: ModelPrice }> = [
  { pattern: /(fable|mythos)-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
  { pattern: /(fable|mythos)-5/, price: { input: 10, output: 50, cacheRead: 1 } },
  { pattern: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { pattern: /opus-(5|4-[5-8])/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { pattern: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { pattern: /sonnet-4/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { pattern: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  { pattern: /gpt-\d/, price: { input: 1.75, output: 14, cacheRead: 0.175 } }, // gpt-5.x codex
]

/** Unknown models are priced as a Sonnet-class model */
const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3 }

export function modelPrice(model?: string): ModelPrice {
  if (model) {
    const id = model.toLowerCase()
    for (const { pattern, price } of MODEL_PRICES) {
      if (pattern.test(id)) return price
    }
  }
  return FALLBACK_PRICE
}

/** $ per million tokens for an estimate that has no input/output split: 0.75 × input + 0.25 × output */
export function blendedRate(model?: string): number {
  const { input, output } = modelPrice(model)
  return 0.75 * input + 0.25 * output
}

/** What one model request cost, in $ */
export function stepCost(usage: StepUsage, model?: string): number {
  const p = modelPrice(model)
  return (
    usage.input_tokens * p.input
    + usage.output_tokens * p.output
    + usage.cache_read_input_tokens * p.cacheRead
    + usage.cache_creation_input_tokens * p.input * CACHE_WRITE_MULTIPLIER
  ) / 1_000_000
}

/** The share of a request's input the prompt cache served, 0 to 1; undefined with no input */
export function cacheHitRatio(usage: StepUsage): number | undefined {
  const inputs = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return inputs > 0 ? usage.cache_read_input_tokens / inputs : undefined
}
