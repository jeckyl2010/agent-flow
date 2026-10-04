/**
 * Refreshes web/lib/data/ecologits.json from EcoLogits (https://github.com/mlco2/ecologits,
 * MPL-2.0): its Anthropic model estimates, and the electricity mixes the impacts are figured at.
 *
 *   node --import tsx scripts/update-ecologits-data.ts [git ref]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'mlco2/ecologits'
const ref = process.argv[2] ?? 'main'
const OUT = join(import.meta.dirname, '../web/lib/data/ecologits.json')

/** Mixes kept: EcoLogits figures Anthropic in the USA; WOR is its calculator's default */
const ZONES = ['USA', 'WOR']

/** Anthropic's data centers, as EcoLogits' PROVIDER_CONFIG_MAP has them (ecologits/tracers/utils.py) */
const PROVIDER = {
  location: 'USA',
  pue: { min: 1.09, max: 1.14 },
  wue: { min: 0.13, max: 0.999 },
}

async function fetchJson(path: string): Promise<any> {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const commitRes = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`)
  const commit = commitRes.ok ? ((await commitRes.json()) as { sha: string }).sha : ref
  const models = await fetchJson('ecologits/data/models.json')
  const mixes = await fetchJson('ecologits/data/electricity_mixes.json')

  const anthropic = (models.models as any[])
    .filter(m => m.provider === 'anthropic')
    .map(m => ({ name: m.name, architecture: m.architecture, deployment: m.deployment, warnings: m.warnings }))
  const aliases = (models.aliases as any[])
    .filter(a => a.provider === 'anthropic')
    .map(a => ({ name: a.name, alias: a.alias }))
  const electricityMixes = (mixes.electricity_mixes as any[])
    .filter(m => ZONES.includes(m.name))
    .map(({ name, adpe, pe, gwp, wue }) => ({ name, adpe, pe, gwp, wue }))

  const data = {
    source: `https://github.com/${REPO}/tree/${commit}`,
    license: 'MPL-2.0',
    provider: PROVIDER,
    models: anthropic,
    aliases,
    electricityMixes,
  }
  writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n')
  console.log(`${anthropic.length} models, ${aliases.length} aliases, ${electricityMixes.length} mixes from ${commit}`)
}

main().catch(err => { console.error(err); process.exit(1) })
