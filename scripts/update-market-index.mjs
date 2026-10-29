// Add one published version to market/index.json (the DSH plugin market index).
//
//   node scripts/update-market-index.mjs 1.0.5     # or v1.0.5
//
// Reads the publish time and engines.dsh from the npm registry, keeps the
// existing entries, and writes the index back. Used by the release workflow after
// `npm publish`, and safe to run locally. Exits 0 without changes when the
// version is already listed.
//
// npm can take a few minutes to make a fresh release visible. When the registry
// still does not report it after MARKET_INDEX_ATTEMPTS tries, PUBLISH_TIMESTAMP
// (Unix seconds, supplied by the release workflow as `date +%s`) is used instead;
// the local package.json provides engines.dsh in that case.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-tokenlens'
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}`
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ATTEMPTS = Number(process.env.MARKET_INDEX_ATTEMPTS ?? 12)
const DELAY_MS = Number(process.env.MARKET_INDEX_DELAY_MS ?? 5000)
const FALLBACK_TIMESTAMP = Number(process.env.PUBLISH_TIMESTAMP ?? 0)

const raw = String(process.argv[2] ?? '').trim()
const version = raw.replace(/^v/, '')
if (!SEMVER.test(version)) {
  console.error(`usage: node scripts/update-market-index.mjs <version>  (got ${JSON.stringify(raw)})`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexFile = join(root, 'market', 'index.json')
const index = JSON.parse(readFileSync(indexFile, 'utf8'))
const plugin = Array.isArray(index.plugins) ? index.plugins.find((entry) => entry.name === PACKAGE) : undefined
if (plugin === undefined) {
  console.error(`market/index.json does not list ${PACKAGE}`)
  process.exit(1)
}
plugin.versions ??= []
if (plugin.versions.some((entry) => entry.version === version)) {
  console.log(`${PACKAGE}@${version} is already listed in market/index.json`)
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url, attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'dsh-tokenlens-market-index' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(attempt * 2000)
    }
  }
  throw lastError
}

let meta = null
let publishedAt
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  meta = await fetchJson(REGISTRY)
  const candidate = meta.time?.[version]
  if (meta.versions?.[version] !== undefined && typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))) {
    publishedAt = candidate
    break
  }
  if (attempt < ATTEMPTS) {
    console.warn(`npm registry has not published ${PACKAGE}@${version} yet (attempt ${attempt}/${ATTEMPTS}), retrying in ${DELAY_MS}ms`)
    await sleep(DELAY_MS)
  }
}
if (publishedAt === undefined && Number.isInteger(FALLBACK_TIMESTAMP) && FALLBACK_TIMESTAMP > 0) {
  publishedAt = new Date(FALLBACK_TIMESTAMP * 1000).toISOString()
  console.warn(`npm registry did not report ${PACKAGE}@${version}; using PUBLISH_TIMESTAMP ${publishedAt}`)
}
if (publishedAt === undefined) {
  console.error(`npm registry did not report ${PACKAGE}@${version} within ${ATTEMPTS} attempts`)
  process.exit(1)
}

const entry = {
  version,
  publishTimestamp: Math.floor(Date.parse(publishedAt) / 1000),
  source: { type: 'npm' },
}
// Prefer the published package's engines.dsh; fall back to the local package.json.
let dshRange = meta?.versions?.[version]?.engines?.dsh
if (typeof dshRange !== 'string' || dshRange === '') {
  try {
    dshRange = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.engines?.dsh
  } catch {
    dshRange = undefined
  }
}
if (typeof dshRange === 'string' && dshRange !== '') entry.engines = { dsh: dshRange }
plugin.versions.push(entry)
plugin.versions.sort((a, b) => (b.publishTimestamp ?? 0) - (a.publishTimestamp ?? 0))

writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`added ${PACKAGE}@${version} (published ${publishedAt}) to market/index.json`)
