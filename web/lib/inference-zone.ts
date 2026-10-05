/**
 * Where a model request ran, as the EcoLogits electricity mix it's figured at. Anthropic's own API
 * runs in the USA, as EcoLogits has it; Claude on Amazon Bedrock and Google Vertex AI runs in the
 * region the session is set up for, or across a geography its model ID names. Only the grid
 * changes: the data centers' PUE and WUE stay EcoLogits' figures for Anthropic.
 */

/** How Claude Code reached Claude, as the bridge mod reads it from Claude Code's environment */
export interface InferenceSite {
  platform: 'anthropic' | 'bedrock' | 'vertex' | 'foundry'
  /** The region the session is set up for: AWS_REGION, or Vertex's CLOUD_ML_REGION */
  region?: string
}

export interface InferenceZone {
  /** An EcoLogits electricity mix: a country, `EEE` (the EU's), `USA` or `WOR` (the world's) */
  zone: string
  /** Where that came from, for the moons' card: "Bedrock eu-west-1", "Anthropic API" */
  basis: string
}

/** Amazon Bedrock's regions, by country: exact names first, then by prefix */
const AWS_REGIONS: Record<string, string> = {
  'eu-west-1': 'IRL', 'eu-west-2': 'GBR', 'eu-west-3': 'FRA', 'eu-central-1': 'DEU', 'eu-central-2': 'CHE',
  'eu-north-1': 'SWE', 'eu-south-1': 'ITA', 'eu-south-2': 'ESP',
  'ap-northeast-1': 'JPN', 'ap-northeast-2': 'KOR', 'ap-northeast-3': 'JPN', 'ap-south-1': 'IND', 'ap-south-2': 'IND',
  'ap-southeast-1': 'SGP', 'ap-southeast-2': 'AUS', 'ap-southeast-3': 'IDN', 'ap-southeast-4': 'AUS', 'ap-east-1': 'HKG',
  'sa-east-1': 'BRA', 'me-central-1': 'ARE', 'me-south-1': 'BHR', 'il-central-1': 'ISR', 'af-south-1': 'ZAF',
  'mx-central-1': 'MEX',
}
const AWS_PREFIXES: ReadonlyArray<[string, string]> = [['us-', 'USA'], ['ca-', 'CAN']]

/**
 * Bedrock's cross-region inference profiles, by the geography their model ID starts with: a
 * request may run in any region of it, so a geography of countries is figured at its average
 * where EcoLogits has one (the EU's), and at the world's where it doesn't
 */
const BEDROCK_GEOGRAPHIES: Record<string, string> = {
  eu: 'EEE', us: 'USA', 'us-gov': 'USA', ca: 'CAN', jp: 'JPN', au: 'AUS', apac: 'WOR', global: 'WOR',
}

/** Google Cloud's regions, by country */
const GCP_REGIONS: Record<string, string> = {
  'europe-west1': 'BEL', 'europe-west2': 'GBR', 'europe-west3': 'DEU', 'europe-west4': 'NLD', 'europe-west6': 'CHE',
  'europe-west8': 'ITA', 'europe-west9': 'FRA', 'europe-west10': 'DEU', 'europe-west12': 'ITA',
  'europe-north1': 'FIN', 'europe-north2': 'SWE', 'europe-central2': 'POL', 'europe-southwest1': 'ESP',
  'asia-northeast1': 'JPN', 'asia-northeast2': 'JPN', 'asia-northeast3': 'KOR', 'asia-east1': 'TWN', 'asia-east2': 'HKG',
  'asia-south1': 'IND', 'asia-south2': 'IND', 'asia-southeast1': 'SGP', 'asia-southeast2': 'IDN',
  'australia-southeast1': 'AUS', 'australia-southeast2': 'AUS', 'southamerica-east1': 'BRA',
  'northamerica-northeast1': 'CAN', 'northamerica-northeast2': 'CAN', 'me-west1': 'ISR', 'me-central1': 'QAT',
  'me-central2': 'SAU', 'africa-south1': 'ZAF',
  // Multi-regions: the EU's, the USA's; `global` may run anywhere
  eu: 'EEE', us: 'USA', global: 'WOR',
}

const ANTHROPIC: InferenceZone = { zone: 'USA', basis: 'Anthropic API' }

function awsZone(region: string): string | undefined {
  return AWS_REGIONS[region] ?? AWS_PREFIXES.find(([p]) => region.startsWith(p))?.[1]
}

/**
 * The zone a request to `model` was figured at. Bedrock: a cross-region profile's geography in its
 * model ID first (`eu.anthropic.claude-…`, or an ARN's `inference-profile/eu.…`), then the region
 * (an ARN's, else the session's). Vertex: its region. Anthropic's API and Microsoft Foundry, which
 * runs Claude on Anthropic's servers: the USA. A region that maps to nothing: the USA, as EcoLogits
 */
export function inferenceZone(model: string | undefined, site: InferenceSite | undefined): InferenceZone {
  const id = (model ?? '').toLowerCase()
  const geo = /(?:^|\/)(us-gov|eu|us|ca|jp|au|apac|global)\.anthropic\./.exec(id)?.[1]
  if (site?.platform === 'bedrock' || geo || id.includes('arn:aws')) {
    if (geo) return { zone: BEDROCK_GEOGRAPHIES[geo], basis: `Bedrock ${geo}.* (cross-region)` }
    const region = /arn:aws[a-z-]*:bedrock:([a-z0-9-]+):/.exec(id)?.[1] ?? site?.region
    const zone = region ? awsZone(region) : undefined
    return zone ? { zone, basis: `Bedrock ${region}` } : { zone: 'USA', basis: 'Bedrock, region unknown' }
  }
  if (site?.platform === 'vertex') {
    const region = site.region?.toLowerCase()
    const zone = region ? GCP_REGIONS[region] ?? (region.startsWith('us-') ? 'USA' : undefined) : undefined
    return zone ? { zone, basis: `Vertex AI ${region}` } : { zone: 'USA', basis: 'Vertex AI, region unknown' }
  }
  if (site?.platform === 'foundry') return { zone: 'USA', basis: 'Microsoft Foundry (Anthropic’s servers)' }
  return ANTHROPIC
}

/** Every zone this maps to: the mixes the data must hold */
export const INFERENCE_ZONES: readonly string[] = [...new Set([
  'USA', 'WOR', 'EEE',
  ...Object.values(AWS_REGIONS), ...AWS_PREFIXES.map(([, z]) => z),
  ...Object.values(BEDROCK_GEOGRAPHIES), ...Object.values(GCP_REGIONS),
])].sort()

const ZONE_NAMES: Record<string, string> = {
  USA: 'US', WOR: 'world average', EEE: 'EU average', IRL: 'Irish', GBR: 'UK', FRA: 'French', DEU: 'German',
  CHE: 'Swiss', SWE: 'Swedish', ITA: 'Italian', ESP: 'Spanish', BEL: 'Belgian', NLD: 'Dutch', FIN: 'Finnish',
  POL: 'Polish', CAN: 'Canadian', JPN: 'Japanese', KOR: 'Korean', IND: 'Indian', SGP: 'Singaporean', AUS: 'Australian',
  IDN: 'Indonesian', HKG: 'Hong Kong', TWN: 'Taiwanese', BRA: 'Brazilian', ARE: 'UAE', BHR: 'Bahraini', ISR: 'Israeli',
  ZAF: 'South African', MEX: 'Mexican', QAT: 'Qatari', SAU: 'Saudi',
}

/** A grid as the moons' card names it: "EU average", "Swedish" */
export function zoneName(zone: string): string {
  return ZONE_NAMES[zone] ?? zone
}
