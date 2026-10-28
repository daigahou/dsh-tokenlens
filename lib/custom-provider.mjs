/**
 * Custom usage adapters declared from the management page.
 *
 * DSH model settings only expose a provider's id/name/models, not its usage
 * endpoint. A user can therefore teach the plugin how to read an arbitrary
 * provider: a small declarative definition (URL + JSON field paths) stored in
 * providers.json and turned into a generic balance/windows adapter here.
 *
 * Definition shape:
 *
 *   { providerId: 'my-gateway', label: 'My Gateway', kind: 'balance' | 'windows',
 *     apiKeyRef: 'MY_GATEWAY_API_KEY', baseURL: 'https://api.example.com',
 *     usagePath: '/v1/credits',
 *     // balance adapters:
 *     amountPath: 'data.balance', currency: 'USD', grantedPath: 'data.granted',
 *     toppedUpPath: 'data.paid',
 *     // windows adapters:
 *     percentScale: 'percent' | 'fraction',
 *     windows: { rolling: { percentPath: 'data.limits.0.percent', resetPath: 'data.limits.0.reset' },
 *                weekly:  { … }, monthly: { … } } }
 */
import { parseTimestamp, UsageError } from './go-usage.mjs'
import { joinUrl, makeWindow, toNumber } from './providers.mjs'

export const CUSTOM_KINDS = ['balance', 'windows']
const CUSTOM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const WINDOW_IDS = ['rolling', 'weekly', 'monthly']

/** Read a dot/bracket path (`data.limits.0.percent`) out of a JSON value. */
export function getJsonPath(value, path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined
  let current = value
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)]
    } else if (typeof current === 'object') {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}

const text = (value, max) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : ''

/** Validate + normalize a custom provider definition; throws `UsageError('parse')`. */
export function validateCustomProvider(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const providerId = text(source.providerId, 64).toLowerCase()
  if (!CUSTOM_ID.test(providerId)) {
    throw new UsageError('parse', 'custom provider id must match [a-z0-9][a-z0-9._-]{0,63}', { retryable: false })
  }
  const label = text(source.label, 40)
  if (label === '') {
    throw new UsageError('parse', 'custom provider label is required (max 40 characters)', { retryable: false })
  }
  const kind = text(source.kind, 16)
  if (!CUSTOM_KINDS.includes(kind)) {
    throw new UsageError('parse', 'custom provider kind must be "balance" or "windows"', { retryable: false })
  }
  const baseURL = text(source.baseURL, 300)
  if (!/^https?:\/\//i.test(baseURL)) {
    throw new UsageError('parse', 'custom provider baseURL must be an http(s) URL', { retryable: false })
  }
  let usagePath = text(source.usagePath, 300)
  if (usagePath === '') throw new UsageError('parse', 'custom provider usagePath is required', { retryable: false })
  if (!usagePath.startsWith('/')) usagePath = `/${usagePath}`
  const def = {
    providerId,
    label,
    shortLabel: text(source.shortLabel, 12) || label.slice(0, 4).toUpperCase(),
    kind,
    baseURL,
    usagePath,
    apiKeyRef: text(source.apiKeyRef, 120),
    consoleUrl: text(source.consoleUrl, 300),
    note: text(source.note, 200),
  }
  if (kind === 'balance') {
    def.amountPath = text(source.amountPath, 200)
    if (def.amountPath === '') {
      throw new UsageError('parse', 'balance adapters need an amountPath (JSON field path)', { retryable: false })
    }
    def.currency = text(source.currency, 8).toUpperCase() || 'USD'
    def.grantedPath = text(source.grantedPath, 200)
    def.toppedUpPath = text(source.toppedUpPath, 200)
  } else {
    const windows = source.windows !== null && typeof source.windows === 'object' ? source.windows : {}
    def.percentScale = source.percentScale === 'fraction' ? 'fraction' : 'percent'
    def.windows = {}
    let hasWindow = false
    for (const id of WINDOW_IDS) {
      const entry = windows[id]
      if (entry === null || typeof entry !== 'object') continue
      const percentPath = text(entry.percentPath, 200)
      if (percentPath === '') continue
      def.windows[id] = { percentPath, resetPath: text(entry.resetPath, 200) }
      hasWindow = true
    }
    if (!hasWindow) {
      throw new UsageError('parse', 'window adapters need at least one percentPath (rolling/weekly/monthly)', {
        retryable: false,
      })
    }
  }
  return def
}

/** Sanitize one definition for storage; `null` when it is unusable. */
export function sanitizeCustomProvider(raw) {
  try {
    return validateCustomProvider(raw)
  } catch {
    return null
  }
}

/** A generic adapter for one custom provider definition. */
export function makeCustomAdapter(def) {
  const kind = def.kind
  return {
    kind,
    async read({ fetchJson, now = Date.now() }) {
      const payload = await fetchJson(joinUrl(def.baseURL, def.usagePath))
      if (kind === 'balance') {
        const amount = toNumber(getJsonPath(payload, def.amountPath))
        if (amount === null) {
          throw new UsageError('parse', `custom provider ${def.providerId}: amountPath ${def.amountPath} is not a number`)
        }
        const balance = { amount, currency: def.currency || 'USD' }
        const granted = def.grantedPath === '' ? null : toNumber(getJsonPath(payload, def.grantedPath))
        if (granted !== null) balance.granted = granted
        const toppedUp = def.toppedUpPath === '' ? null : toNumber(getJsonPath(payload, def.toppedUpPath))
        if (toppedUp !== null) balance.toppedUp = toppedUp
        return { kind: 'balance', windows: emptyWindows(now), balance, available: true }
      }
      // windows
      const windows = emptyWindows(now)
      let found = false
      for (const id of WINDOW_IDS) {
        const entry = def.windows[id]
        if (entry === undefined) continue
        let percent = toNumber(getJsonPath(payload, entry.percentPath))
        if (percent === null) continue
        if (def.percentScale === 'fraction') percent *= 100
        windows[id] = makeWindow(
          id,
          { percent, resetsAt: entry.resetPath === '' ? undefined : getJsonPath(payload, entry.resetPath) },
          now,
        )
        found = true
      }
      if (!found) {
        throw new UsageError('parse', `custom provider ${def.providerId}: no configured percentPath resolved to a number`)
      }
      return { kind: 'windows', windows }
    },
  }
}

/** All windows present as null. */
export function emptyWindows(now) {
  const windows = {}
  for (const id of WINDOW_IDS) windows[id] = null
  void now
  return windows
}

/** Parse a reset value the way the built-in adapters do (epoch ms / ISO / seconds). */
export function normalizeReset(value) {
  return parseTimestamp(value)
}
