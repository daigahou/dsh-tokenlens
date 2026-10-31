/**
 * Provider-store unit tests: the management page persists overrides here, so
 * the file must round-trip safely, be tolerant of junk, and merge predictably.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  DETAILS_WINDOWS,
  defaultProviderStoreFile,
  loadProviderStore,
  mergeProviderOverride,
  sanitizeOverride,
  saveProviderStore,
  sanitizeSettings,
} from '../lib/provider-store.mjs'

test('provider store defaults to $DSH_HOME/dsh-tokenlens/providers.json', () => {
  assert.equal(defaultProviderStoreFile('C:\\users\\x\\.dsh'), join('C:\\users\\x\\.dsh', 'dsh-tokenlens', 'providers.json'))
})

test('loadProviderStore tolerates a missing, malformed or junk file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const missing = join(dir, 'missing.json')
  assert.deepEqual(loadProviderStore(missing), { version: 1, providers: {}, customProviders: {}, settings: { labelStyle: 'full', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto', detailsWindow: 'total' } })
  const malformed = join(dir, 'malformed.json')
  await writeFile(malformed, '{not json', 'utf8')
  assert.deepEqual(loadProviderStore(malformed), { version: 1, providers: {}, customProviders: {}, settings: { labelStyle: 'full', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto', detailsWindow: 'total' } })
  const junk = join(dir, 'junk.json')
  await writeFile(junk, JSON.stringify({ version: 1, providers: { openrouter: { enabled: 'yes', apiKey: 42, baseURL: 'x' }, bad: null } }), 'utf8')
  const store = loadProviderStore(junk)
  assert.deepEqual(store.providers.openrouter, { baseURL: 'x' })
  assert.equal(store.providers.bad, undefined)
})

test('saveProviderStore writes atomically and round-trips sanitized overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'providers.json')
  const saved = saveProviderStore(file, {
    settings: { labelStyle: 'short', detailsWindow: 'last7Days' },
    // (settings persist alongside provider overrides)
    providers: {
      openrouter: { enabled: true, apiKey: '  sk-or-test  ', baseURL: 'https://openrouter.ai' },
      moonshot: { enabled: false, junk: 'ignored' },
    },
  })
  assert.deepEqual(saved.providers.openrouter, {
    enabled: true,
    apiKey: 'sk-or-test',
    baseURL: 'https://openrouter.ai',
  })
  assert.deepEqual(loadProviderStore(file).providers, saved.providers)
  assert.equal(saved.settings.labelStyle, 'short')
  assert.equal(loadProviderStore(file).settings.labelStyle, 'short')
  assert.equal(saved.settings.detailsWindow, 'last7Days', 'the v1.2.1 明细 window is persisted')
  assert.equal(loadProviderStore(file).settings.detailsWindow, 'last7Days')
})

test('sanitizeOverride keeps only known, correctly typed fields', () => {
  assert.deepEqual(
    sanitizeOverride({ enabled: true, apiKey: 'k', apiKeyRef: ' REF ', baseURL: ' u ', usagePath: '', junk: 1, label: '  My OpenCode ', shortLabel: ' MO ' }),
    { enabled: true, apiKey: 'k', apiKeyRef: 'REF', label: 'My OpenCode', shortLabel: 'MO', baseURL: 'u' },
  )
  assert.deepEqual(sanitizeOverride(null), {})
})

test('mergeProviderOverride: override wins, missing values keep the profile config', () => {
  const merged = mergeProviderOverride(
    { enabled: true, baseURL: 'https://profile.example', consoleUrl: 'https://console.example' },
    { enabled: false, baseURL: '' },
  )
  assert.deepEqual(merged, { enabled: false, baseURL: 'https://profile.example', consoleUrl: 'https://console.example' })
  assert.deepEqual(mergeProviderOverride(undefined, { enabled: true }), { enabled: true })
})


test('display settings sanitize to known defaults', () => {
  assert.deepEqual(DETAILS_WINDOWS, ['today', 'last7Days', 'second', 'total'])
  assert.deepEqual(sanitizeSettings({ labelStyle: 'full' }), DEFAULT_SETTINGS)
  assert.deepEqual(sanitizeSettings({ labelStyle: 'nope' }), DEFAULT_SETTINGS)
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS)
  assert.equal(sanitizeSettings({ defaultView: 'data' }).defaultView, 'data')
  assert.equal(sanitizeSettings({ defaultScope: 'all' }).defaultScope, 'all')
  assert.equal(sanitizeSettings({ detailsExpanded: 'collapsed' }).detailsExpanded, 'collapsed')
  assert.equal(sanitizeSettings({ detailsWindow: 'today' }).detailsWindow, 'today')
  assert.equal(sanitizeSettings({ detailsWindow: 'last7Days' }).detailsWindow, 'last7Days')
  assert.equal(sanitizeSettings({ detailsWindow: 'second' }).detailsWindow, 'second')
  assert.equal(sanitizeSettings({ detailsWindow: 'total' }).detailsWindow, 'total')
  assert.equal(sanitizeSettings({ detailsWindow: 'junk' }).detailsWindow, 'total')
  assert.equal(sanitizeSettings({ defaultView: 'junk', defaultScope: 'x', detailsExpanded: 'y', detailsWindow: 'z' }).defaultView, 'chart')
})
