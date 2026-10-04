import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent, AgentSpend } from '../web/lib/agent-types'
import { llmImpacts, findModel, sessionImpacts, formatImpact, midpoint, type EcoImpacts } from '../web/lib/eco-impact'

// Reference values from EcoLogits itself (Python, llm_impacts with request_latency=inf), at the
// commit web/lib/data/ecologits.json was taken from: [min, max] of energy, gwp, adpe, pe, wcf
type Ref = Array<[number, number]>

function assertMatches(actual: EcoImpacts | undefined, expected: Ref) {
  assert.ok(actual)
  const kinds = ['energy', 'gwp', 'adpe', 'pe', 'wcf'] as const
  kinds.forEach((k, i) => {
    for (const [end, j] of [['min', 0], ['max', 1]] as const) {
      const got = actual[k][end]
      const want = expected[i][j]
      assert.ok(Math.abs(got - want) <= Math.abs(want) * 1e-9, `${k}.${end}: ${got} != ${want}`)
    }
  })
}

test('matches EcoLogits for Opus 5.5 at the world mix (its calculator: 4.53 kWh, 2.14 kgCO2eq, 20.5 L)', () => {
  const impacts = llmImpacts('claude-opus-5-5', 1_000_000, 1, 'WOR')
  assertMatches(impacts, [
    [3.104792800774164, 5.947602906940018],
    [1.4918979047114935, 2.7947293482662428],
    [3.906858941404565e-06, 3.945208449736742e-06],
    [8.905599795430255, 16.260233821091937],
    [12.503826654508591, 28.455210497192713],
  ])
  assert.equal(midpoint(impacts!.energy).toFixed(2), '4.53')
  assert.equal(midpoint(impacts!.gwp).toFixed(2), '2.14')
  assert.equal(midpoint(impacts!.wcf).toFixed(1), '20.5')
})

test('matches EcoLogits for a dense model through its alias, in the USA', () => {
  assertMatches(llmImpacts('claude-haiku-4-5', 800), [
    [5.02015056945229e-05, 0.0001309739273638615],
    [2.156688153203016e-05, 5.4885223164779476e-05],
    [1.3206266575977885e-10, 2.671380952888758e-10],
    [0.0005150906554203801, 0.0013263645731711648],
    [0.00016322347152736375, 0.000524997958454682],
  ])
})

test('requests figured together equal the sum of each', () => {
  // EcoLogits for 120, 900 and 3000 output tokens, summed
  assertMatches(llmImpacts('claude-fable-5-1', 4020, 3), [
    [0.03702031391366862, 0.08314279103863373],
    [0.015206953008036862, 0.03293643321487345],
    [5.833552347061093e-08, 6.288089359127623e-08],
    [0.37102274910752286, 0.8178757564850349],
    [0.12036659200604452, 0.33327087638017056],
  ])
})

test('model IDs find the most specific entry', () => {
  assert.equal(findModel('claude-opus-5-5')?.name, 'claude-opus-5-5')
  assert.equal(findModel('claude-opus-5-5[1m]')?.name, 'claude-opus-5-5')
  assert.equal(findModel('claude-opus-5')?.name, 'claude-opus-5')
  assert.equal(findModel('claude-sonnet-4-5-20250929')?.name, 'claude-sonnet-4-5-20250929')
  assert.equal(findModel('claude-haiku-4-5')?.name, 'claude-haiku-4-5-20251001')
  assert.equal(findModel('gpt-5.3-codex'), undefined)
  assert.equal(findModel(undefined), undefined)
})

function spend(output: number, steps: number, isComplete = true): AgentSpend {
  return { cost: 0, input: 0, output, cacheRead: 0, cacheWrite: 0, steps, isComplete }
}

function agent(id: string, fields: Partial<Agent>): Agent {
  return { id, name: id, isMain: false, tokensUsed: 0, ...fields } as Agent
}

test('the session sums its measured agents and says what it left out', () => {
  const agents = new Map([
    ['main', agent('main', { isMain: true, model: 'claude-opus-5-5', spend: spend(2000, 4) })],
    ['sub', agent('sub', { model: 'claude-opus-5-5', spend: spend(500, 1) })],
    ['codex', agent('codex', { model: 'gpt-5.3-codex', spend: spend(300, 1) })],
  ])
  const s = sessionImpacts(agents)
  const whole = llmImpacts('claude-opus-5-5', 2500, 5)!
  assert.ok(Math.abs(s.total.energy.max - whole.energy.max) < 1e-15)
  assert.equal(s.outputTokens, 2500)
  assert.equal(s.uncountedAgents, 1)
  assert.equal(s.isPartial, false)

  agents.set('late', agent('late', { tokensUsed: 1200 }))
  assert.equal(sessionImpacts(agents).isPartial, true)
})

test('values read in the unit that fits', () => {
  assert.deepEqual(formatImpact('energy', 4.526), { value: '4.53', unit: 'kWh' })
  assert.deepEqual(formatImpact('energy', 0.1), { value: '100', unit: 'Wh' })
  assert.deepEqual(formatImpact('gwp', 0.0021), { value: '2.1', unit: 'gCO₂eq' })
  assert.deepEqual(formatImpact('wcf', 0.25), { value: '250', unit: 'mL' })
  assert.deepEqual(formatImpact('adpe', 3.93e-6), { value: '3.93', unit: 'mgSbeq' })
  assert.deepEqual(formatImpact('pe', 0), { value: '0', unit: 'J' })
})
