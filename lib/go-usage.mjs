/**
 * Pure data layer for the OpenCode Go usage endpoint.
 *
 * Upstream shape (GET https://opencode.ai/inference/go/v1/usage):
 *
 *   { "usage": {
 *       "rolling": { "status": "ok", "percent": 2,  "resetsAt": "2026-10-25T11:31:25.000Z" },
 *       "weekly":  { "status": "ok", "percent": 21, "resetsAt": "2026-10-26T00:00:00.000Z" },
 *       "monthly": { "status": "ok", "percent": 30, "resetsAt": "2026-11-09T14:08:58.000Z" }
 *   } }
 *
 * The three windows are the plan's allowance buckets: the 5-hour window counts
 * 20% of the monthly limit, the week 50%, the month 100%. The endpoint only
 * returns *percentages*, so this plugin never converts dollars: it paints what
 * the server says and nothing else.
 */

/** The windows the endpoint reports, in display order. */
export const WINDOW_IDS = ['rolling', 'weekly', 'monthly']

/** Version of the wire snapshot shape (see PROTOCOL.md). */
export const SNAPSHOT_VERSION = 3

/** A typed failure the plugin can classify, serialize and test. */
export class UsageError extends Error {
  /**
   * @param code - machine code (see PROTOCOL.md error codes).
   * @param message - human readable, never contains a secret.
   * @param extra - optional `status` (upstream HTTP status) and `retryable`.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.status = Number.isSafeInteger(extra.status) ? extra.status : undefined
    this.retryable =
      typeof extra.retryable === 'boolean' ? extra.retryable : DEFAULT_RETRYABLE[code] === true
  }
}

/** Whether a retry of this failure may help. */
const DEFAULT_RETRYABLE = {
  'missing-key': false,
  'unsupported-provider': false,
  unauthorized: false,
  forbidden: false,
  'unknown-action': false,
  disabled: false,
  internal: true,
  network: true,
  timeout: true,
  http: true,
  parse: false,
  'rate-limited': true,
  'stats-unavailable': true,
}

/** Clamp a percentage into 0..100 (rounded to two decimals); `null` when it is not a finite number. */
export function normalizePercent(value) {
  let numeric = value
  if (typeof numeric === 'string' && numeric.trim() !== '') numeric = Number(numeric)
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null
  return Math.round(Math.min(100, Math.max(0, numeric)) * 100) / 100
}

/**
 * Parse an absolute timestamp into epoch milliseconds; `null` when unusable.
 * Accepts an ISO string, epoch seconds (values below 1e11) or epoch milliseconds.
 */
export function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value > 100_000_000_000 ? value : value * 1000)
  }
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Normalize one window object. A window missing from the payload stays in the
 * snapshot with `percent: null` so the UI can show an explicit "—" instead of
 * silently shifting the other windows.
 */
export function normalizeWindow(id, raw, now) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const resetsMs = parseTimestamp(source.resetsAt)
  return {
    id,
    percent: normalizePercent(source.percent),
    status: typeof source.status === 'string' && source.status !== '' ? source.status : 'unknown',
    resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
    remainingMs: resetsMs === null ? null : Math.max(0, resetsMs - now),
  }
}

/**
 * Validate and normalize an upstream payload.
 *
 * @param payload - parsed JSON body.
 * @param now - epoch milliseconds used for the reset countdowns.
 * @returns `{ [windowId]: NormalizedWindow }` in display order.
 * @throws {UsageError} `parse` when the body has no recognizable usage object.
 */
export function parseUsagePayload(payload, now = Date.now()) {
  const usage = payload?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new UsageError('parse', 'upstream response has no usage object')
  }
  const known = WINDOW_IDS.filter((id) => usage[id] !== undefined)
  if (known.length === 0) {
    throw new UsageError('parse', 'upstream response has no usage windows')
  }
  const windows = {}
  for (const id of WINDOW_IDS) windows[id] = normalizeWindow(id, usage[id], now)
  return windows
}

/**
 * Build a successful wire snapshot (protocol v2: provider-aware).
 *
 * @param input.provider - `{ id, label, kind }`; the provider the numbers belong to.
 * @param input.plan - `{ id, label }` or null (providers that report a plan name).
 * @param input.windows - `{ rolling, weekly, monthly }`, each a window or null.
 * @param input.balance - `{ amount, currency, granted?, toppedUp? }` or null.
 * @param input.credits - `{ remaining, granted, purchased }` or null.
 * @param input.account - non-secret display account info or null.
 * @param input.fetchedAtMs - when the upstream request completed.
 * @param input.now - snapshot instant (defaults to `fetchedAtMs`).
 * @param input.latencyMs - upstream round-trip.
 * @param input.source - `api` | `cache` | `stale-cache`.
 * @param input.key - `{ ref, source, detail? }`, never the secret.
 */
export function buildSnapshot(input) {
  const now = Number.isFinite(input.now) ? input.now : input.fetchedAtMs
  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    provider: input.provider ?? null,
    plan: input.plan ?? null,
    windows: input.windows ?? null,
    balance: input.balance ?? null,
    credits: input.credits ?? null,
    account: input.account ?? null,
    // Provider-owned web pages the dialog links to (they follow the selection).
    links: input.links ?? null,
    fetchedAt: new Date(input.fetchedAtMs).toISOString(),
    ageMs: Math.max(0, now - input.fetchedAtMs),
    stale: input.source === 'stale-cache',
    latencyMs: Number.isFinite(input.latencyMs) ? input.latencyMs : null,
    source: input.source ?? 'api',
    key: input.key ?? { ref: '', source: 'none' },
  }
}

/** Re-stamp a cached snapshot as a cache hit (no upstream request). */
export function asCacheHit(snapshot, now) {
  return {
    ...snapshot,
    ok: true,
    ageMs: Math.max(0, now - Date.parse(snapshot.fetchedAt)),
    stale: false,
    source: 'cache',
    latencyMs: null,
  }
}

/** Re-stamp a cached snapshot that could not be refreshed. */
export function asStaleCache(snapshot, now) {
  return {
    ...snapshot,
    ok: false,
    ageMs: Math.max(0, now - Date.parse(snapshot.fetchedAt)),
    stale: true,
    source: 'stale-cache',
    latencyMs: null,
  }
}

/** Classify a non-2xx upstream response. */
export function classifyStatus(status) {
  if (status === 401) return { code: 'unauthorized', retryable: false }
  if (status === 403) return { code: 'forbidden', retryable: false }
  if (status === 429) return { code: 'rate-limited', retryable: true }
  return { code: 'http', retryable: status >= 500 }
}

/** Map any thrown value onto the wire error shape (never leaks a secret). */
export function errorToWire(error) {
  if (error instanceof UsageError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      retryable: error.retryable,
    }
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'timeout', message: 'the usage request timed out', retryable: true }
  }
  return {
    code: 'internal',
    message: String(error?.message ?? error ?? 'unknown error'),
    retryable: true,
  }
}

/**
 * Whether a snapshot needs no refresh: it exists, is a success, and is younger
 * than the cache TTL. Errors always force the next read to try again.
 */
export function isFresh(snapshot, now, ttlMs) {
  if (snapshot === null || snapshot === undefined) return false
  if (snapshot.ok !== true) return false
  const fetched = Date.parse(snapshot.fetchedAt)
  return Number.isFinite(fetched) && now - fetched < ttlMs
}

/**
 * The upstream URL for a configured origin and path, tolerating a base with or
 * without a trailing slash and a path with or without a leading slash.
 */
export function usageUrl(baseURL, usagePath) {
  const base = String(baseURL ?? '').trim()
  const path = String(usagePath ?? '').trim()
  if (base === '') throw new UsageError('disabled', 'no usage endpoint base URL is configured')
  const origin = base.replace(/\/+$/, '')
  const suffix = path === '' ? '/inference/go/v1/usage' : '/' + path.replace(/^\/+/, '')
  try {
    return new URL(origin + suffix).toString()
  } catch {
    throw new UsageError('parse', `invalid usage endpoint URL: ${origin}${suffix}`)
  }
}
