import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextWindowSize } from '../web/lib/context-window'

test('a recognized family keeps its own window', () => {
  assert.equal(contextWindowSize('claude-opus-5-5'), 1_000_000)
  assert.equal(contextWindowSize('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(contextWindowSize('us.anthropic.claude-sonnet-5-5-v1:0'), 1_000_000)
})

test('a model ID Claude Code does not recognize gets 1M (2.1.326+), or 200K with the 1M context off', () => {
  assert.equal(contextWindowSize('claude-sonnet-latest'), 1_000_000)
  assert.equal(contextWindowSize('some-vendor-model'), 1_000_000)
  assert.equal(contextWindowSize(undefined), 1_000_000)
  assert.equal(contextWindowSize('some-vendor-model', { disable1MContext: true }), 200_000)
  assert.equal(contextWindowSize('claude-opus-5-5', { disable1MContext: true }), 200_000)
})

test('CLAUDE_CODE_MAX_CONTEXT_TOKENS sets the window of an unrecognized claude- ID only', () => {
  const options = { maxContextTokens: 300_000 }
  assert.equal(contextWindowSize('claude-sonnet-latest', options), 300_000)
  assert.equal(contextWindowSize('claude-opus-5-5', options), 1_000_000)
  assert.equal(contextWindowSize('some-vendor-model', options), 1_000_000)
})
