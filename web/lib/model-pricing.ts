/**
 * Per-model token prices, for spend the API measured (the agent-flow-bridge mod's per-request
 * usage) and the blended rate that estimates fall back on.
 *
 * Prices are $ per million tokens, Anthropic first-party API rates. Versions within a family
 * differ (Opus 5.5 costs less than Opus 5; cache reads are not one multiple of input), so entries
 * match model IDs version-first. Matched against lower-cased IDs; first match wins.
 *
 * Some models have a second rate card for long prompts (Haiku 5.5: 5× past 100K tokens). The
 * prompt is the request's whole input, cache reads and writes included; output and the cache's
 * rates follow the card the prompt chose.
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
  /** The part of cache_creation_input_tokens written with the 1-hour TTL; absent when the
   *  source doesn't break writes down by TTL, which then count as 5-minute ones */
  cache_creation_1h_input_tokens?: number
}

/** A cache write with the default 5-minute TTL costs this multiple of input */
export const CACHE_WRITE_MULTIPLIER = 1.25
/** A cache write with the 1-hour TTL costs this multiple of input */
export const CACHE_WRITE_1H_MULTIPLIER = 2

/** Where Haiku 5.5's long-prompt card starts. The relay keeps the usage of prompts past it apart
 *  (extension/src/protocol.ts LONG_PROMPT_TOKENS), so a card at another length needs it there too */
export const LONG_PROMPT_ABOVE = 100_000

/** The rate card a prompt longer than `above` tokens is billed at */
interface LongContextPrice {
  above: number
  price: ModelPrice
}

const MODEL_PRICES: ReadonlyArray<{ pattern: RegExp; price: ModelPrice; longContext?: LongContextPrice }> = [
  { pattern: /(fable|mythos)-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
  { pattern: /(fable|mythos)-5/, price: { input: 10, output: 50, cacheRead: 1 } },
  { pattern: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { pattern: /opus-(5|4-[5-8])/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { pattern: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { pattern: /sonnet-4/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  {
    pattern: /haiku-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    longContext: { above: LONG_PROMPT_ABOVE, price: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  },
  { pattern: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  { pattern: /gpt-\d/, price: { input: 1.75, output: 14, cacheRead: 0.175 } }, // gpt-5.x codex
]

/** Unknown models are priced as a Sonnet-class model */
const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheRead: 0.3 }

/** A model's prices for a prompt of `promptTokens` (the whole input); left out, the standard card */
export function modelPrice(model?: string, promptTokens = 0): ModelPrice {
  if (model) {
    const id = model.toLowerCase()
    for (const { pattern, price, longContext } of MODEL_PRICES) {
      if (!pattern.test(id)) continue
      return longContext && promptTokens > longContext.above ? longContext.price : price
    }
  }
  return FALLBACK_PRICE
}

/** What resending a cached prompt costs, $: read while the cache is warm, written to it again
 *  (at the write rate of its TTL) once it has lapsed */
export function cachedPromptCost(tokens: number, ttlSeconds: number, model?: string): { warm: number; cold: number } {
  const p = modelPrice(model, tokens)
  const write = ttlSeconds >= 3600 ? CACHE_WRITE_1H_MULTIPLIER : CACHE_WRITE_MULTIPLIER
  return { warm: (tokens * p.cacheRead) / 1e6, cold: (tokens * p.input * write) / 1e6 }
}

/** $ per million tokens for an estimate that has no input/output split: 0.75 × input + 0.25 × output,
 *  at the standard card (an estimate doesn't know its prompts' lengths) */
export function blendedRate(model?: string): number {
  const { input, output } = modelPrice(model)
  return 0.75 * input + 0.25 * output
}

/** A request's prompt: its whole input, cache reads and writes included */
function promptTokens(usage: StepUsage): number {
  return usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

/** What one model request cost, in $ */
export function stepCost(usage: StepUsage, model?: string): number {
  return usageCost(usage, modelPrice(model, promptTokens(usage)))
}

/**
 * What many requests cost, in $, from their usage summed: `longPrompt` is the part of it whose
 * prompts were long (the relay's LONG_PROMPT_TOKENS, which a model's long-prompt card starts
 * above), priced at that card; the rest at the standard one
 */
export function totalCost(usage: StepUsage, model?: string, longPrompt?: StepUsage): number {
  if (!longPrompt) return usageCost(usage, modelPrice(model))
  const rest: StepUsage = {
    input_tokens: usage.input_tokens - longPrompt.input_tokens,
    output_tokens: usage.output_tokens - longPrompt.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens - longPrompt.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens - longPrompt.cache_creation_input_tokens,
    cache_creation_1h_input_tokens: (usage.cache_creation_1h_input_tokens ?? 0) - (longPrompt.cache_creation_1h_input_tokens ?? 0),
  }
  return usageCost(rest, modelPrice(model)) + usageCost(longPrompt, modelPrice(model, Infinity))
}

function usageCost(usage: StepUsage, p: ModelPrice): number {
  const oneHour = Math.min(usage.cache_creation_1h_input_tokens ?? 0, usage.cache_creation_input_tokens)
  return (
    usage.input_tokens * p.input
    + usage.output_tokens * p.output
    + usage.cache_read_input_tokens * p.cacheRead
    + (usage.cache_creation_input_tokens - oneHour) * p.input * CACHE_WRITE_MULTIPLIER
    + oneHour * p.input * CACHE_WRITE_1H_MULTIPLIER
  ) / 1_000_000
}

/** The share of a request's input the prompt cache served, 0 to 1; undefined with no input */
export function cacheHitRatio(usage: StepUsage): number | undefined {
  const inputs = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return inputs > 0 ? usage.cache_read_input_tokens / inputs : undefined
}
