/**
 * User-managed provider overrides for the usage plugin.
 *
 * The management page writes here instead of touching the user-owned profile
 * patch. Precedence at read time: an override from this store wins over the
 * profile/config value; built-in defaults still fill every missing field.
 *
 * File shape (version 1):
 *
 *   { "version": 1,
 *     "providers": {
 *       "openrouter": { "enabled": true, "apiKey": "sk-or-…" },
 *       "moonshot":   { "baseURL": "https://api.moonshot.ai/v1" }
 *     } }
 *
 * The file is written atomically (tmp + rename) and contains secrets, so it is
 * created with owner-only permissions where the platform supports it.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sanitizeCustomProvider } from './custom-provider.mjs'

export const STORE_VERSION = 1

/** Chip label style the management page can select. */
export const LABEL_STYLES = ['short', 'full']

/** Default display settings. */
export const DISPLAY_VIEWS = ['chart', 'data']
export const STATS_SCOPES = ['provider', 'all']
export const DETAILS_DEFAULTS = ['auto', 'expanded', 'collapsed']

/** Default display settings (management 插件设置 tab). */
export const DEFAULT_SETTINGS = {
  labelStyle: 'full',
  defaultView: 'chart',
  defaultScope: 'provider',
  detailsExpanded: 'auto',
}

/** The default override file: `$DSH_HOME/dsh-tokenlens/providers.json`. */
export function defaultProviderStoreFile(dshHome) {
  return join(dshHome, 'dsh-tokenlens', 'providers.json')
}

/** Read the store; a missing or unreadable file is an empty store (never throws). */
export function loadProviderStore(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') {
      return { version: STORE_VERSION, providers: {}, customProviders: {}, settings: { ...DEFAULT_SETTINGS } }
    }
    const providers = {}
    for (const [id, value] of Object.entries(parsed.providers ?? {})) {
      if (typeof id !== 'string' || id === '' || value === null || typeof value !== 'object') continue
      providers[id] = sanitizeOverride(value)
    }
    return {
      version: STORE_VERSION,
      providers,
      customProviders: sanitizeCustomProviders(parsed.customProviders),
      settings: sanitizeSettings(parsed.settings),
    }
  } catch {
    return { version: STORE_VERSION, providers: {}, customProviders: {}, settings: { ...DEFAULT_SETTINGS } }
  }
}

/** Persist the store atomically; returns the normalized document written. */
export function saveProviderStore(file, store) {
  const document = {
    version: STORE_VERSION,
    settings: sanitizeSettings(store.settings),
    customProviders: sanitizeCustomProviders(store.customProviders),
    providers: Object.fromEntries(
      Object.entries(store.providers ?? {}).map(([id, value]) => [id, sanitizeOverride(value)]),
    ),
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  try {
    chmodSync(temp, 0o600)
  } catch {
    /* POSIX-only nicety; Windows ACLs are inherited */
  }
  renameSync(temp, file)
  return document
}

/** Custom provider definitions keyed by id (validated on every read/write). */
export function sanitizeCustomProviders(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id === '') continue
    const def = sanitizeCustomProvider({ ...value, providerId: id })
    if (def !== null && def.providerId === id) out[id] = def
  }
  return out
}

/** Only the display settings the management page may set. */
export function sanitizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    labelStyle: LABEL_STYLES.includes(source.labelStyle) ? source.labelStyle : DEFAULT_SETTINGS.labelStyle,
    defaultView: DISPLAY_VIEWS.includes(source.defaultView) ? source.defaultView : DEFAULT_SETTINGS.defaultView,
    defaultScope: STATS_SCOPES.includes(source.defaultScope) ? source.defaultScope : DEFAULT_SETTINGS.defaultScope,
    detailsExpanded: DETAILS_DEFAULTS.includes(source.detailsExpanded)
      ? source.detailsExpanded
      : DEFAULT_SETTINGS.detailsExpanded,
  }
}

/** Only the fields the management page may set, with type guards. */
export function sanitizeOverride(value) {
  const out = {}
  const source = value !== null && typeof value === 'object' ? value : {}
  if (typeof source.enabled === 'boolean') out.enabled = source.enabled
  if (typeof source.apiKey === 'string' && source.apiKey.trim() !== '') out.apiKey = source.apiKey.trim()
  if (typeof source.apiKeyRef === 'string' && source.apiKeyRef.trim() !== '') out.apiKeyRef = source.apiKeyRef.trim()
  if (typeof source.label === 'string' && source.label.trim() !== '') out.label = source.label.trim().slice(0, 40)
  if (typeof source.shortLabel === 'string' && source.shortLabel.trim() !== '') {
    out.shortLabel = source.shortLabel.trim().slice(0, 12)
  }
  for (const key of ['baseURL', 'consoleUrl', 'usagePath', 'balancePath', 'creditsPath', 'subscriptionsPath', 'whoamiPath']) {
    if (typeof source[key] === 'string' && source[key].trim() !== '') out[key] = source[key].trim()
  }
  return out
}

/** Merge one override over the profile config for a provider. */
export function mergeProviderOverride(configured, override) {
  const merged = { ...(configured !== null && typeof configured === 'object' ? configured : {}) }
  if (override !== null && typeof override === 'object') {
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined && value !== null && value !== '') merged[key] = value
    }
  }
  return merged
}
