import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent, AgentSpend } from '../web/lib/agent-types'
import { inferenceZone, INFERENCE_ZONES } from '../web/lib/inference-zone'
import { hasMix, llmImpacts, sessionImpacts } from '../web/lib/eco-impact'

test("Anthropic's API, and no word of where: the US grid, as EcoLogits figures Anthropic", () => {
  assert.deepEqual(inferenceZone('claude-opus-5-5', undefined), { zone: 'USA', basis: 'Anthropic API' })
  assert.deepEqual(inferenceZone('claude-opus-5-5', { platform: 'anthropic' }), { zone: 'USA', basis: 'Anthropic API' })
})

test("Bedrock: a cross-region profile's geography first, then the region", () => {
  const bedrock = (region?: string) => ({ platform: 'bedrock' as const, ...(region ? { region } : {}) })
  assert.equal(inferenceZone('eu.anthropic.claude-opus-4-7', bedrock('us-east-1')).zone, 'EEE')
  assert.equal(inferenceZone('global.anthropic.claude-sonnet-4-6', bedrock('eu-west-1')).zone, 'WOR')
  assert.equal(inferenceZone('anthropic.claude-opus-4-7', bedrock('eu-north-1')).zone, 'SWE')
  assert.equal(inferenceZone('anthropic.claude-opus-4-7', bedrock('us-west-2')).zone, 'USA')
  // An ARN names its own region, and a profile ARN its geography
  assert.equal(inferenceZone('arn:aws:bedrock:eu-central-1:123:application-inference-profile/x', bedrock()).zone, 'DEU')
  assert.equal(inferenceZone('arn:aws:bedrock:eu-west-1:123:inference-profile/eu.anthropic.claude-opus-4-7', bedrock()).zone, 'EEE')
  // A geography prefix tells Bedrock even when the setup wasn't read
  assert.equal(inferenceZone('eu.anthropic.claude-opus-4-7', undefined).zone, 'EEE')
  assert.deepEqual(inferenceZone('anthropic.claude-opus-4-7', bedrock()), { zone: 'USA', basis: 'Bedrock, region unknown' })
})

test('Vertex: its region, a multi-region, or anywhere for global', () => {
  assert.equal(inferenceZone('claude-opus-4-7', { platform: 'vertex', region: 'europe-west1' }).zone, 'BEL')
  assert.equal(inferenceZone('claude-opus-4-7', { platform: 'vertex', region: 'eu' }).zone, 'EEE')
  assert.equal(inferenceZone('claude-opus-4-7', { platform: 'vertex', region: 'global' }).zone, 'WOR')
  assert.equal(inferenceZone('claude-opus-4-7', { platform: 'vertex', region: 'us-east5' }).zone, 'USA')
})

test("Microsoft Foundry runs Claude on Anthropic's servers: the US grid", () => {
  assert.equal(inferenceZone('claude-opus-4-7', { platform: 'foundry' }).zone, 'USA')
})

test('the data holds a mix for every zone a request can be figured at', () => {
  for (const zone of INFERENCE_ZONES) assert.ok(hasMix(zone), `no electricity mix for ${zone}`)
})

const agent = (spend: Partial<AgentSpend>): Agent => ({
  id: 'main', name: 'main', state: 'thinking', isMain: true, tokensUsed: 1, tokensMax: 1,
  spend: { cost: 0, input: 0, output: 1000, cacheRead: 0, cacheWrite: 0, steps: 1, isComplete: true,
    byModel: [{ model: 'claude-opus-5-5', output: 1000, requests: 1 }], ...spend },
} as Agent)

test("the session's footprint is figured at the grid where its requests ran, and says which", () => {
  const eu = sessionImpacts(new Map([['main', agent({ inference: { platform: 'bedrock', region: 'eu-north-1' } })]]))
  const us = sessionImpacts(new Map([['main', agent({})]]))
  assert.deepEqual(eu.grids, [{ zone: 'SWE', basis: 'Bedrock eu-north-1', outputTokens: 1000 }])
  assert.deepEqual(us.grids, [{ zone: 'USA', basis: 'Anthropic API', outputTokens: 1000 }])
  // The same electricity, a cleaner grid
  assert.equal(eu.total.energy.min, us.total.energy.min)
  assert.ok(eu.total.gwp.min < us.total.gwp.min / 3)
  assert.deepEqual(eu.total.gwp, llmImpacts('claude-opus-5-5', 1000, 1, 'SWE')!.gwp)
})

test('a chosen grid figures every request at it', () => {
  const chosen = sessionImpacts(new Map([['main', agent({ inference: { platform: 'bedrock', region: 'eu-north-1' } })]]), 'FRA')
  assert.deepEqual(chosen.grids, [{ zone: 'FRA', basis: 'chosen', outputTokens: 1000 }])
})

test("through a gateway the region is unknown: the world's grid, unless the request names its geography", () => {
  assert.deepEqual(inferenceZone('claude-opus-5-5', { platform: 'anthropic', gateway: 'localhost:4000' }),
    { zone: 'WOR', basis: 'via localhost:4000, region unknown' })
  assert.deepEqual(inferenceZone('anthropic.claude-opus-4-7', { platform: 'bedrock', region: 'eu-north-1', gateway: 'llm.corp' }),
    { zone: 'WOR', basis: 'via llm.corp, region unknown' })
  assert.equal(inferenceZone('eu.anthropic.claude-opus-4-7', { platform: 'bedrock', gateway: 'llm.corp' }).zone, 'EEE')
})

test('the session names the gateways its requests went through', () => {
  const via = sessionImpacts(new Map([['main', agent({ inference: { platform: 'anthropic', gateway: 'localhost:4000' } })]]))
  assert.deepEqual(via.gateways, ['localhost:4000'])
  assert.deepEqual(via.grids, [{ zone: 'WOR', basis: 'via localhost:4000, region unknown', outputTokens: 1000 }])
  assert.deepEqual(sessionImpacts(new Map([['main', agent({})]])).gateways, [])
})
