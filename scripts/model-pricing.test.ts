import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { modelPrice, blendedRate, stepCost, totalCost, cacheHitRatio, cachedPromptCost, LONG_PROMPT_ABOVE } from '../web/lib/model-pricing'
import { LONG_PROMPT_TOKENS } from '../extension/src/protocol'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
})

test('versions within a family are priced apart', () => {
  assert.deepEqual(modelPrice('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 })
  assert.deepEqual(modelPrice('claude-opus-5'), { input: 5, output: 25, cacheRead: 0.5 })
  assert.deepEqual(modelPrice('claude-opus-4-8'), { input: 5, output: 25, cacheRead: 0.5 })
  assert.deepEqual(modelPrice('claude-fable-5-1'), { input: 10, output: 50, cacheRead: 0.25 })
  assert.deepEqual(modelPrice('claude-fable-5'), { input: 10, output: 50, cacheRead: 1 })
  assert.deepEqual(modelPrice('claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.2 })
  assert.deepEqual(modelPrice('claude-sonnet-4-6'), { input: 3, output: 15, cacheRead: 0.3 })
  assert.deepEqual(modelPrice('claude-haiku-4-5-20251001'), { input: 1, output: 5, cacheRead: 0.1 })
  assert.deepEqual(modelPrice('claude-haiku-5-5'), { input: 0.1, output: 0.5, cacheRead: 0.01 })
})

test('a prompt past 100K tokens is priced at Haiku 5.5\'s long-prompt card, output and cache too', () => {
  assert.deepEqual(modelPrice('claude-haiku-5-5', 100_000), { input: 0.1, output: 0.5, cacheRead: 0.01 })
  assert.deepEqual(modelPrice('claude-haiku-5-5', 100_001), { input: 0.5, output: 2.5, cacheRead: 0.05 })
  assert.equal(modelPrice('claude-opus-5-5', 900_000).input, 4) // one card at any length
  // The prompt counts the cache: 5K new, 150K read, 1K written is a long prompt
  const long = usage(5_000, 1e6, 150_000, 1_000)
  assert.ok(Math.abs(stepCost(long, 'claude-haiku-5-5') - (5_000 * 0.5 + 1e6 * 2.5 + 150_000 * 0.05 + 1_000 * 0.5 * 1.25) / 1e6) < 1e-12)
  assert.ok(Math.abs(cachedPromptCost(150_000, 300, 'claude-haiku-5-5').warm - 150_000 * 0.05 / 1e6) < 1e-12)
})

test('the relay splits summed usage where the long-prompt card starts', () => {
  assert.equal(LONG_PROMPT_TOKENS, LONG_PROMPT_ABOVE)
})

test('summed requests are priced at the standard card, but for the part whose prompts were long', () => {
  // Two Haiku 5.5 requests of 60K each: 120K summed, but neither prompt was long
  const short = usage(1e6, 1e6)
  assert.ok(Math.abs(totalCost(short, 'claude-haiku-5-5') - 0.6) < 1e-12)
  // Of 2M input and 2M output, half came from long prompts: $0.60 + $3.00
  const all = usage(2e6, 2e6)
  assert.ok(Math.abs(totalCost(all, 'claude-haiku-5-5', usage(1e6, 1e6)) - 3.6) < 1e-12)
  assert.equal(totalCost(all, 'claude-opus-5-5', usage(1e6, 1e6)), stepCost(all, 'claude-opus-5-5'))
})

test('ids are matched case-insensitively and with suffixes', () => {
  assert.equal(modelPrice('Claude-Opus-5-5[1m]').input, 4)
  assert.equal(modelPrice('claude-mythos-5-1').cacheRead, 0.25)
})

test('unknown models are priced as Sonnet-class', () => {
  assert.deepEqual(modelPrice('some-new-model'), { input: 3, output: 15, cacheRead: 0.3 })
  assert.deepEqual(modelPrice(undefined), { input: 3, output: 15, cacheRead: 0.3 })
})

test('blended rate weighs input 3:1 over output', () => {
  assert.equal(blendedRate('claude-opus-5-5'), 8)
  assert.equal(blendedRate('claude-haiku-4-5'), 2)
  assert.equal(blendedRate('claude-haiku-5-5'), 0.2)
})

test('a step costs input, output, cache reads and 5-minute cache writes at their own prices', () => {
  // Opus 5.5: 1M input $4 + 1M output $20 + 1M cache read $0.20 + 1M cache write $5
  assert.equal(stepCost(usage(1e6, 1e6, 1e6, 1e6), 'claude-opus-5-5'), 29.2)
  assert.equal(stepCost(usage(0, 0), 'claude-opus-5-5'), 0)
})

test('1-hour cache writes cost twice the input price', () => {
  // Opus 5.5: 1M cache write, 600k of it with the 1-hour TTL: 400k × $5 + 600k × $8
  const step = { ...usage(0, 0, 0, 1e6), cache_creation_1h_input_tokens: 6e5 }
  assert.equal(stepCost(step, 'claude-opus-5-5'), 6.8)
})

test('cache hit ratio is the share of input the cache served', () => {
  assert.equal(cacheHitRatio(usage(10, 500, 90, 0)), 0.9)
  assert.equal(cacheHitRatio(usage(50, 0, 0, 50)), 0)
  assert.equal(cacheHitRatio(usage(0, 100)), undefined)
})

test('a cached prompt costs a read while warm, and a rewrite at its TTL once lapsed', () => {
  // Opus 5.5: $4 input, $0.20 cache read. A 1-hour write is 2× input, a 5-minute one 1.25×
  const hour = cachedPromptCost(100_000, 3600, 'claude-opus-5-5')
  assert.ok(Math.abs(hour.warm - 0.02) < 1e-12)
  assert.ok(Math.abs(hour.cold - 0.8) < 1e-12)
  const five = cachedPromptCost(100_000, 300, 'claude-opus-5-5')
  assert.ok(Math.abs(five.cold - 0.5) < 1e-12)
  assert.equal(five.warm, hour.warm)
})
