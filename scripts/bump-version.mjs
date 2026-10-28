/**
 * Bump the plugin version in one shot.
 *
 *   node scripts/bump-version.mjs 0.3.1 "fix: dialog hides an empty capacity row"
 *
 * Updates:
 *   - package.json          `version`
 *   - index.js              `PLUGIN_VERSION` (the status/diagnostics version)
 *   - CHANGELOG.md          prepends a `## <version> — <date>` entry with the note
 *
 * Convention (user request): every conversation that changes files bumps the
 * version — PATCH for fixes, MINOR for features, MAJOR for incompatible changes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , version, ...noteParts] = process.argv
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch> "<note>"')
  process.exit(2)
}
const note = noteParts.join(' ').trim() || '(no note)'
const root = join(import.meta.dirname, '..')

const packagePath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
if (manifest.version === version) {
  console.error(`version is already ${version}; nothing to do`)
  process.exit(1)
}
manifest.version = version
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const indexPath = join(root, 'index.js')
const index = readFileSync(indexPath, 'utf8')
if (!/export const PLUGIN_VERSION = '[^']*'/.test(index)) {
  console.error('index.js: PLUGIN_VERSION declaration not found')
  process.exit(1)
}
writeFileSync(indexPath, index.replace(/export const PLUGIN_VERSION = '[^']*'/, `export const PLUGIN_VERSION = '${version}'`), 'utf8')

const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
const today = new Date().toISOString().slice(0, 10)
const marker = '\n## '
const at = changelog.indexOf(marker)
if (at === -1) {
  writeFileSync(changelogPath, `${changelog}\n## ${version} — ${today}\n\n- ${note}\n`, 'utf8')
} else {
  const head = changelog.slice(0, at)
  const tail = changelog.slice(at)
  writeFileSync(changelogPath, `${head}\n## ${version} — ${today}\n\n- ${note}\n${tail}`, 'utf8')
}

console.log(`bumped to ${version}: package.json, index.js PLUGIN_VERSION, CHANGELOG.md`)
