// Add one published version to market/index.json (the DSH plugin market index).
//
//   node scripts/update-market-index.mjs 1.0.5     # or v1.0.5
//
// Reads the publish time and engines.dsh from the npm registry, keeps the
// existing entries, and writes the index back. Used by the release workflow after
// `npm publish`, and safe to run locally. Exits 0 without changes when the
// version is already listed.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-tokenlens'
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}`
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

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

async function fetchJson(url, attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'dsh-tokenlens-market-index' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
  throw lastError
}

const meta = await fetchJson(REGISTRY)
const publishedAt = meta.time?.[version]
if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
  console.error(`npm registry does not report a publish time for ${PACKAGE}@${version}`)
  process.exit(1)
}

const entry = {
  version,
  publishTimestamp: Math.floor(Date.parse(publishedAt) / 1000),
  source: { type: 'npm' },
}
const dshRange = meta.versions?.[version]?.engines?.dsh
if (typeof dshRange === 'string' && dshRange !== '') entry.engines = { dsh: dshRange }
plugin.versions.push(entry)
plugin.versions.sort((a, b) => (b.publishTimestamp ?? 0) - (a.publishTimestamp ?? 0))

writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log(`added ${PACKAGE}@${version} (published ${publishedAt}) to market/index.json`)
