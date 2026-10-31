/**
 * dsh-tokenlens — Host half (v2, provider-aware).
 *
 * Serves plan usage for the provider the user currently selected:
 *
 *   - `opencode-go`  — OpenCode / Go Plus allowance windows (percentages);
 *   - `commandcode`  — Command Code 5-hour/weekly dollars + monthly credits;
 *   - `deepseek`     — DeepSeek platform balance (no allowance windows).
 *
 * Three consumers, one cache:
 *
 *   - the browser half over a Connection Fetch route (`POST /api/tokenlens`)
 *     paints the composer chip and the detail dialog (usage + token statistics);
 *   - the agent through the `tokenlens_usage` tool;
 *   - other plugins through the `planUsage` service (also exposed as
 *     `tokenlens`).
 *
 * The Host is the only half that touches the credential store and the network.
 * Wire snapshots never carry a key, only its reference and source.
 */
import { buildSnapshot, asCacheHit, asStaleCache, classifyStatus, errorToWire, isFresh, UsageError } from './lib/go-usage.mjs'
import { ADAPTERS, PROVIDER_DEFAULTS, adapterFor, canonicalProviderId, providerConfig } from './lib/providers.mjs'
import { DEFAULT_KEY_REF, dshHomeOf, resolveApiKey } from './lib/key-source.mjs'
import { createUsageStats } from './lib/usage-stats.mjs'
import {
  DEFAULT_SETTINGS,
  DETAILS_DEFAULTS,
  DISPLAY_VIEWS,
  LABEL_STYLES,
  STATS_SCOPES,
  defaultProviderStoreFile,
  loadProviderStore,
  mergeProviderOverride,
  sanitizeSettings,
  saveProviderStore,
} from './lib/provider-store.mjs'
import { makeCustomAdapter, sanitizeUsageBaseURL, validateCustomProvider } from './lib/custom-provider.mjs'
import { redactEndpoint, redactPaths, redactTextPaths } from './lib/redact.mjs'

/**
 * The one browser-facing route this plugin owns.
 *
 * It lives under `/api`, the prefix route `@deepseek-ai/dsh-client-connection`
 * mounts: that route applies the Host/Origin fence and browser authentication
 * before dispatching to a registered exact Fetch path.
 */
export const BRIDGE = '/api/tokenlens'

/** Every action the browser bridge accepts. */
export const ACTIONS = [
  'snapshot',
  'refresh',
  'hello',
  'stats',
  'diagnostics',
  'providers',
  'providerUpdate',
  'providerTest',
  'settingsUpdate',
  'customProviderSave',
  'customProviderDelete',
]

/** The tool-facing subset (a model has no reason to announce a browser). */
export const TOOL_ACTIONS = ['snapshot', 'refresh', 'stats', 'diagnostics', 'status']

/** Optional services; every one is probed with `ctx.get` at use time. */
export const inject = []

/** Plugin name, for diagnostics and status files. */
export const PLUGIN_NAME = 'dsh-tokenlens'

/** Plugin version; mirrors package.json (kept here so diagnostics need no fs read). */
export const PLUGIN_VERSION = '1.2.0'

/** Documented defaults; every field of the raw row config is optional. */
const DEFAULTS = {
  enabled: true,
  defaultProvider: 'opencode-go',
  minRefreshIntervalMs: 20_000,
  timeoutMs: 15_000,
  pollIntervalMs: 120_000,
  statusFile: '',
  // Empty selects $DSH_HOME/dsh-tokenlens/providers.json.
  providerStoreFile: '',
  stats: {
    enabled: true,
    ttlMs: 30_000,
    cacheFile: '',
    dshHome: '',
    harnesses: { dsh: true, zcode: true, opencode: true, workbuddy: true, qoder: true },
    // Hide a harness whose local store is gone (uninstalled) instead of showing
    // a permanent zero row. Temporary read errors still surface an error row.
    showUninstalled: false,
    zcode: {
      dbPath: '',
      // ZCode provider ids that are known to be a DSH provider route.
      providerAliases: { 'opencode-go-chat': 'opencode-go' },
    },
    opencode: {
      dbPath: '',
      // OpenCode CLI provider ids are its own routes (zen/custom); map any that
      // are known to be a DSH provider route here. Empty by default.
      providerAliases: {},
    },
    workbuddy: {
      root: '',
      // WorkBuddy stores no provider id (model ids only), so these stay unmapped.
      providerAliases: {},
    },
    qoder: {
      home: '',
      // Qoder custom providers are resolved from settings.json base URLs
      // (api.commandcode.ai → commandcode) before these aliases apply.
      providerAliases: {},
    },
  },
  providers: {},
}

/** Merge the raw loader-row config over the defaults. */
export function normalize(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (input, fallback) =>
    typeof input === 'string' && input.trim() !== '' ? input.trim() : fallback
  const nonNegative = (input, fallback) =>
    Number.isSafeInteger(input) && input >= 0 ? input : fallback
  const positive = (input, fallback) =>
    Number.isSafeInteger(input) && input > 0 ? input : fallback

  const configured = value.providers !== null && typeof value.providers === 'object' ? value.providers : {}
  const providers = {}
  for (const id of Object.keys(PROVIDER_DEFAULTS)) {
    const merged = providerConfig(id, configured[id])
    // v1 compatibility: the flat fields configured the OpenCode route.
    if (id === 'opencode-go') {
      const legacy = {
        baseURL: value.baseURL,
        usagePath: value.usagePath,
        apiKeyRef: value.apiKeyRef,
        apiKey: value.apiKey,
      }
      for (const [key, entry] of Object.entries(legacy)) {
        if (typeof entry === 'string' && entry.trim() !== '') merged[key] = entry.trim()
      }
    }
    merged.enabled = merged.enabled !== false
    providers[id] = merged
  }

  const statsRaw = value.stats !== null && typeof value.stats === 'object' ? value.stats : {}
  const harnessesRaw =
    statsRaw.harnesses !== null && typeof statsRaw.harnesses === 'object' ? statsRaw.harnesses : {}
  const zcodeRaw = statsRaw.zcode !== null && typeof statsRaw.zcode === 'object' ? statsRaw.zcode : {}
  const opencodeRaw =
    statsRaw.opencode !== null && typeof statsRaw.opencode === 'object' ? statsRaw.opencode : {}
  const workbuddyRaw =
    statsRaw.workbuddy !== null && typeof statsRaw.workbuddy === 'object' ? statsRaw.workbuddy : {}
  const qoderRaw = statsRaw.qoder !== null && typeof statsRaw.qoder === 'object' ? statsRaw.qoder : {}
  const requestedDefault = text(value.defaultProvider, DEFAULTS.defaultProvider)
  const defaultProvider =
    providers[requestedDefault]?.enabled === true ? requestedDefault : firstEnabledProvider(providers)

  return {
    enabled: value.enabled !== false,
    defaultProvider,
    minRefreshIntervalMs: nonNegative(value.minRefreshIntervalMs, DEFAULTS.minRefreshIntervalMs),
    timeoutMs: positive(value.timeoutMs, DEFAULTS.timeoutMs),
    pollIntervalMs: nonNegative(value.pollIntervalMs, DEFAULTS.pollIntervalMs),
    statusFile: typeof value.statusFile === 'string' ? value.statusFile : DEFAULTS.statusFile,
    providerStoreFile:
      typeof value.providerStoreFile === 'string' ? value.providerStoreFile : DEFAULTS.providerStoreFile,
    stats: {
      enabled: statsRaw.enabled !== false,
      ttlMs: nonNegative(statsRaw.ttlMs, DEFAULTS.stats.ttlMs),
      cacheFile: typeof statsRaw.cacheFile === 'string' ? statsRaw.cacheFile : DEFAULTS.stats.cacheFile,
      dshHome: typeof statsRaw.dshHome === 'string' ? statsRaw.dshHome : DEFAULTS.stats.dshHome,
      showUninstalled: statsRaw.showUninstalled === true,
      // Which local harnesses feed the token statistics. Every external harness
      // is read-only and degrades to an "unavailable" row when its store is
      // absent (e.g. an uninstalled harness or a moved database).
      harnesses: {
        dsh: harnessesRaw.dsh !== false,
        zcode: harnessesRaw.zcode !== false,
        opencode: harnessesRaw.opencode !== false,
        workbuddy: harnessesRaw.workbuddy !== false,
        qoder: harnessesRaw.qoder !== false,
      },
      zcode: {
        dbPath: typeof zcodeRaw.dbPath === 'string' ? zcodeRaw.dbPath : DEFAULTS.stats.zcode.dbPath,
        providerAliases: normalizeAliases(zcodeRaw.providerAliases, DEFAULTS.stats.zcode.providerAliases),
      },
      opencode: {
        dbPath: typeof opencodeRaw.dbPath === 'string' ? opencodeRaw.dbPath : DEFAULTS.stats.opencode.dbPath,
        providerAliases: normalizeAliases(
          opencodeRaw.providerAliases,
          DEFAULTS.stats.opencode.providerAliases,
        ),
      },
      workbuddy: {
        root: typeof workbuddyRaw.root === 'string' ? workbuddyRaw.root : DEFAULTS.stats.workbuddy.root,
        providerAliases: normalizeAliases(
          workbuddyRaw.providerAliases,
          DEFAULTS.stats.workbuddy.providerAliases,
        ),
      },
      qoder: {
        home: typeof qoderRaw.home === 'string' ? qoderRaw.home : DEFAULTS.stats.qoder.home,
        providerAliases: normalizeAliases(qoderRaw.providerAliases, DEFAULTS.stats.qoder.providerAliases),
      },
    },
    providers,
  }
}

/** A `{ harnessProviderId: dshProviderId }` map, defaults included. */
function normalizeAliases(raw, defaults = {}) {
  const aliases = { ...defaults }
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === 'string' && key.trim() !== '' && typeof value === 'string' && value.trim() !== '') {
        aliases[key.trim()] = value.trim()
      }
    }
  }
  return aliases
}

/** The first enabled supported provider, or null when every one is disabled. */
function firstEnabledProvider(providers) {
  for (const id of Object.keys(PROVIDER_DEFAULTS)) {
    if (providers[id]?.enabled === true) return id
  }
  return null
}

/** The user-agent the plugin introduces itself with (upstream asks for a stable id). */
const USER_AGENT = `dsh-tokenlens/${PLUGIN_VERSION}`

/**
 * Plugin body.
 * @param ctx - Host context owning this plugin instance.
 * @param rawConfig - the Loader row's raw `config`.
 */
export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig)
  if (!config.enabled) return

  const log = (level, message) => {
    try {
      const logger = ctx.get('logger')
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') {
        logger[level](`dsh-tokenlens: ${message}`)
      }
    } catch {
      /* logging never breaks the plugin */
    }
  }
  const warn = (message) => log('warn', message)

  /** Scrub absolute paths out of free-form error strings before they leave the Host. */
  function scrubMessagePaths(value, depth = 0) {
    if (depth > 12) return value
    if (typeof value === 'string') return redactTextPaths(value)
    if (Array.isArray(value)) return value.map((entry) => scrubMessagePaths(entry, depth + 1))
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, entry] of Object.entries(value)) out[key] = scrubMessagePaths(entry, depth + 1)
      return out
    }
    return value
  }

  /** Live state, surfaced through `diagnostics` so a check needs no log file. */
  const state = {
    caches: new Map(), // providerId 鈫?{ snapshot, fetchedAtMs }
    flights: new Map(), // providerId 鈫?shared single-flight promise
    lastErrors: new Map(), // providerId 鈫?wire error of the last failed attempt
    lastAttempts: new Map(), // providerId 鈫?ISO of the last upstream attempt
    keys: new Map(), // providerId 鈫?{ ref, source, detail } (never the secret)
    requestCounts: new Map(), // providerId 鈫?successful reads
    subscribers: new Set(),
    client: null, // last browser `hello`
    bridge: { found: false, registered: false, path: BRIDGE, error: null },
    poll: { timer: null },
    status: { timer: null },
    disposed: false,
  }

  // ---- status file ---------------------------------------------------------

  /**
   * Optional JSON status file.
   *
   * A live Host plugin has no channel back to whoever is watching it: the tool
   * only becomes callable on the next agent step, and the browser route needs
   * the page's own authentication. One small JSON file per life event makes
   * activation, bridge registration and refresh failures inspectable from
   * outside the process.
   */
  let statusLatest = null
  async function flushStatus() {
    if (config.statusFile === '' || state.disposed) return
    try {
      const { mkdir, writeFile, rename } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const target = config.statusFile
      const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temporary, JSON.stringify(redactPaths(statusLatest), null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        await rename(temporary, target)
      } catch (error) {
        try {
          const { unlink } = await import('node:fs/promises')
          await unlink(temporary)
        } catch {
          /* best-effort cleanup */
        }
        throw error
      }
    } catch (error) {
      warn(`cannot write the status file: ${String(error?.message ?? error)}`)
    }
  }

  /** Record one status payload; the physical write is coalesced. */
  function noteStatus(phase, extra = {}) {
    const cached = state.caches.get(activeProviderId())
    statusLatest = {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      at: new Date().toISOString(),
      pid: process.pid,
      phase,
      bridge: { ...state.bridge },
      defaultProvider: config.defaultProvider,
      activeProvider: activeProviderId(),
      providerStoreFile,
      providerStoreSettings: sanitizeSettings(providerStore.settings),
      customProviderCount: Object.keys(customProviderDefs()).length,
      client: state.client,
      subscribers: state.subscribers.size,
      poll: { running: state.poll.timer !== null, intervalMs: config.pollIntervalMs },
      lastError: state.lastErrors.get(activeProviderId()) ?? null,
      // Persistent usage summary: a later phase (stats, client) must not erase
      // the last known windows from the diagnostics file.
      snapshot:
        cached === undefined
          ? null
          : {
              provider: cached.snapshot.provider,
              plan: cached.snapshot.plan,
              windows: cached.snapshot.windows,
              balance: cached.snapshot.balance,
              credits: cached.snapshot.credits,
              fetchedAt: cached.snapshot.fetchedAt,
            },
      ...extra,
    }
    if (config.statusFile === '') return
    if (state.status.timer !== null) return
    state.status.timer = setTimeout(() => {
      state.status.timer = null
      void flushStatus()
    }, 120)
    state.status.timer.unref?.()
  }

  // ---- provider plumbing ---------------------------------------------------

  const providerStoreFile =
    config.providerStoreFile !== '' ? config.providerStoreFile : defaultProviderStoreFile(dshHomeOf(process.env))
  let providerStore = loadProviderStore(providerStoreFile)

  /** Built-in defaults + profile config + management-page overrides. */
  function effectiveProviderConfig(providerId) {
    const id = canonicalProviderId(providerId)
    if (PROVIDER_DEFAULTS[id] === undefined) return undefined
    return providerConfig(id, mergeProviderOverride(config.providers[id], providerStore.providers[id]))
  }

  /** The custom provider definitions stored in providers.json. */
  function customProviderDefs() {
    return providerStore.customProviders ?? {}
  }

  /** The effective custom definition (store + display overrides), or undefined. */
  function effectiveCustomProvider(providerId) {
    if (typeof providerId !== 'string') return undefined
    const id = providerId.trim().toLowerCase()
    const def = customProviderDefs()[id]
    if (def === undefined) return undefined
    const overrides = providerStore.providers[id] ?? {}
    return {
      ...def,
      enabled: overrides.enabled !== false,
      label: typeof overrides.label === 'string' && overrides.label !== '' ? overrides.label : def.label,
      shortLabel:
        typeof overrides.shortLabel === 'string' && overrides.shortLabel !== '' ? overrides.shortLabel : def.shortLabel,
      consoleUrl:
        typeof overrides.consoleUrl === 'string' && overrides.consoleUrl !== '' ? overrides.consoleUrl : def.consoleUrl,
    }
  }

  /** Route a provider id to a built-in or custom adapter. */
  function adapterForProvider(providerId) {
    const custom = effectiveCustomProvider(providerId)
    if (custom !== undefined) return makeCustomAdapter(custom)
    const mapping = dshRouteMapping(String(providerId))
    if (mapping !== null) return adapterFor(mapping.adapterId)
    return adapterFor(canonicalProviderId(providerId))
  }

  /** Whether a provider has a usable credential (never exposes the secret). */
  async function providerKeyInfo(provider) {
    if (typeof provider.apiKeyRef === 'string' && provider.apiKeyRef.trim() !== '') {
      try {
        const key = await resolveApiKey({
          config: { apiKeyRef: provider.apiKeyRef, apiKey: provider.apiKey ?? '' },
          credentials: ctx.get('credentials'),
          env: process.env,
        })
        return { hasKey: typeof key.value === 'string' && key.value !== '', keySource: key.source, ref: key.ref }
      } catch {
        return { hasKey: false, keySource: 'none', ref: provider.apiKeyRef }
      }
    }
    if (provider.service !== undefined) return { hasKey: true, keySource: 'service', ref: '' }
    return { hasKey: false, keySource: 'none', ref: '' }
  }

  /** DSH llm route ids that back a usage provider (for the management page). */
  const DSH_ROUTE_IDS = {
    'opencode-go': ['opencode-go', 'opencode'],
    commandcode: ['commandcode'],
    deepseek: ['deepseek', 'deepseek-official'],
  }

  /**
   * Host signatures that identify a provider usage API from the model base URL
   * recorded in DSH model settings. This is what lets a newly configured
   * provider inherit a built-in usage adapter without any manual setup.
   */
  const AUTO_HOST_HINTS = [
    { pattern: /(^|\.)openrouter\.ai$/i, adapterId: 'openrouter' },
    { pattern: /(^|\.)moonshot\.(ai|cn)$/i, adapterId: 'moonshot' },
    { pattern: /(^|\.)siliconflow\.(cn|com)$/i, adapterId: 'siliconflow' },
    { pattern: /(^|\.)stepfun\.(com|ai)$/i, adapterId: 'stepfun' },
    { pattern: /(^|\.)novita\.ai$/i, adapterId: 'novita' },
    { pattern: /(^|\.)hyperbolic\.(xyz|ai)$/i, adapterId: 'hyperbolic' },
    { pattern: /(^|\.)deepinfra\.com$/i, adapterId: 'deepinfra' },
    { pattern: /(^|\.)bigmodel\.cn$/i, adapterId: 'zhipu-cn' },
    { pattern: /(^|\.)z\.ai$/i, adapterId: 'zai' },
    { pattern: /(^|\.)minimax\.(io|com|chat)$/i, adapterId: 'minimax' },
    { pattern: /(^|\.)deepseek\.com$/i, adapterId: 'deepseek' },
    { pattern: /(^|\.)commandcode\.ai$/i, adapterId: 'commandcode' },
    { pattern: /(^|\.)opencode\.ai$/i, adapterId: 'opencode-go' },
  ]

  /**
   * The provider profiles *actually configured* in DSH model settings.
   *
   * `ctx.llm.listProviders()` also contains routes registered dynamically by
   * other plugins (free-channel packs etc.), which are not user-configured.
   * The settings page derives "configured" from the llm-pi-ai profile
   * (`providers.<id>` entries); read the same source via configEditor.
   * Returns `null` when the composition has no configEditor (older Host).
   */
  function configuredDshProfiles() {
    try {
      const editor = ctx.get('configEditor')
      if (editor === null || editor === undefined || typeof editor.configuration !== 'function') return null
      const rows = editor.configuration()
      if (!Array.isArray(rows)) return null
      const profiles = new Map()
      let found = false
      for (const row of rows) {
        const options = row?.entry?.options ?? {}
        if (options.name !== '@deepseek-ai/dsh-llm-pi-ai' && options.id !== 'llm-pi-ai') continue
        found = true
        const providers = options.config?.providers
        if (providers === null || typeof providers !== 'object') continue
        for (const [id, profile] of Object.entries(providers)) {
          if (typeof id !== 'string' || id === '') continue
          const value = profile !== null && typeof profile === 'object' ? profile : {}
          profiles.set(id, {
            providerId: id,
            displayName: typeof value.displayName === 'string' && value.displayName !== '' ? value.displayName : '',
            apiKeyEnv: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : '',
            baseURL: typeof value.baseURL === 'string' ? value.baseURL : '',
            api: typeof value.api === 'string' ? value.api : '',
          })
        }
      }
      if (!found) return null
      // The DeepSeek account service is a configured provider too (账号与余额).
      if (ctx.get('deepseekAccount') !== undefined && !profiles.has('deepseek-account')) {
        profiles.set('deepseek-account', { providerId: 'deepseek-account', displayName: 'DeepSeek Account', apiKeyEnv: '', baseURL: '', api: '' })
      }
      return profiles
    } catch {
      return null
    }
  }

  /** Hostname of a profile base URL, or an empty string. */
  function hostOf(value) {
    if (typeof value !== 'string' || value === '') return ''
    try {
      return new URL(value).hostname.toLowerCase()
    } catch {
      return ''
    }
  }

  /**
   * Resolve how a configured DSH route reads its usage: a built-in adapter id
   * chosen by the route id itself or by the model base URL host. `null` when
   * the provider exposes no usage API the plugin understands.
   */
  function dshRouteMapping(routeId, profiles) {
    const configured = profiles ?? configuredDshProfiles()
    const profile = configured?.get(routeId)
    if (profile === undefined) return null
    const direct = canonicalProviderId(routeId)
    if (PROVIDER_DEFAULTS[direct] !== undefined && ADAPTERS[direct] !== undefined) {
      return { adapterId: direct, profile, viaHost: false }
    }
    const host = hostOf(profile.baseURL)
    for (const hint of AUTO_HOST_HINTS) {
      if (hint.pattern.test(host) && ADAPTERS[hint.adapterId] !== undefined) {
        return { adapterId: hint.adapterId, profile, viaHost: true }
      }
    }
    return null
  }

  /**
   * Effective provider config for a configured DSH route (including routes
   * whose id is not one of the built-in provider ids, e.g. a custom route named
   * `my-openrouter` that points at openrouter.ai).
   */
  function dshRouteProviderConfig(routeId, profiles) {
    const mapping = dshRouteMapping(routeId, profiles)
    if (mapping === null) return undefined
    const base = effectiveProviderConfig(mapping.adapterId)
    if (base === undefined) return undefined
    const profile = mapping.profile
    const merged = {
      ...base,
      id: routeId,
      label: profile.displayName !== '' ? profile.displayName : base.label,
      ...(profile.apiKeyEnv !== '' ? { apiKeyRef: profile.apiKeyEnv } : {}),
    }
    return mergeProviderOverride(merged, providerStore.providers[routeId] ?? {})
  }

  /** Clone of the configured profiles, if the Host can read them. */
  function configuredDshRouteIds() {
    const profiles = configuredDshProfiles()
    if (profiles === null) return null
    return new Set(profiles.keys())
  }

  /** Whether a registered llm route corresponds to one configured profile id. */
  function routeIsConfigured(routeId, configured) {
    if (configured.has(routeId)) return true
    for (const candidates of Object.values(DSH_ROUTE_IDS)) {
      if (!candidates.includes(routeId)) continue
      if (candidates.some((candidate) => configured.has(candidate))) return true
    }
    return false
  }

  /** The routes DSH model settings actually expose, in registration order. */
  function dshRouteEntries() {
    try {
      const llm = ctx.get('llm')
      if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return []
      const routes = (llm.listProviders() ?? [])
        .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
        .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id }))
      // Only routes backed by a DSH model-settings profile count as
      // "configured"; dynamically registered plugin channels do not.
      const configured = configuredDshRouteIds()
      if (configured === null) return routes
      return routes.filter((route) => routeIsConfigured(route.id, configured))
    } catch {
      return []
    }
  }

  /** Whether the composition exposes DSH model settings for this provider. */
  function dshRouteFor(providerId, dshIds) {
    const candidates = DSH_ROUTE_IDS[providerId] ?? [providerId]
    return candidates.find((id) => dshIds.has(id)) ?? null
  }

  /** The management-page overview: every built-in provider with its runtime state. */
  async function providersPayload() {
    const dshRoutes = dshRouteEntries()
    const dshIds = new Set(dshRoutes.map((route) => route.id))
    const dshProfiles = configuredDshProfiles()
    // Drop cached snapshots when the DSH model-settings profiles change, so a
    // deleted/edited provider never keeps serving stale usage numbers.
    const signature =
      dshProfiles === null
        ? ''
        : JSON.stringify(
            [...dshProfiles.values()].map((profile) => [profile.providerId, profile.apiKeyEnv, profile.baseURL]),
          )
    if (state.dshProfilesSignature !== undefined && state.dshProfilesSignature !== signature) {
      state.caches.clear()
      state.flights.clear()
      state.lastErrors.clear()
    }
    state.dshProfilesSignature = signature
    const providers = []
    for (const id of Object.keys(PROVIDER_DEFAULTS)) {
      const provider = effectiveProviderConfig(id)
      let key = await providerKeyInfo(provider)
      if (id === 'volcengine') {
        const secret = await resolveApiKey({
          config: { apiKeyRef: provider.secretAccessKeyRef ?? 'VOLCENGINE_SECRET_ACCESS_KEY' },
          credentials: ctx.get('credentials'),
          env: process.env,
        })
        key = { ...key, hasKey: key.hasKey && typeof secret.value === 'string' && secret.value !== '' }
      }
      providers.push({
        providerId: id,
        label: provider.label,
        shortLabel: provider.shortLabel ?? provider.label,
        kind: ADAPTERS[id]?.kind ?? provider.kind ?? 'unknown',
        enabled: provider.enabled !== false,
        hasKey: key.hasKey,
        keySource: key.keySource,
        apiKeyRef: provider.apiKeyRef ?? '',
        baseURL: provider.baseURL ?? '',
        consoleUrl: provider.consoleUrl ?? '',
        builtin: true,
        // Configured through DSH model settings: the management page should
        // inherit the key/base URL instead of asking for them again.
        dshManaged: dshRouteFor(id, dshIds) !== null,
        dshProviderId: dshRouteFor(id, dshIds),
        // The same detection the stats payload uses: a plan id or a real
        // percentage window, not merely a metadata kind badge.
        subscribed: providerHasSubscription(id),
      })
    }
    // DSH model settings are the source of truth: report every configured
    // route (supported by a usage adapter or not) so the management page can
    // list DSH providers first and keep preset adapters secondary.
    // User-declared custom adapters (management page).
    for (const [id, def] of Object.entries(customProviderDefs())) {
      const provider = effectiveCustomProvider(id)
      if (provider === undefined) continue
      const key = await providerKeyInfo({ ...provider, apiKeyRef: provider.apiKeyRef ?? '' })
      providers.push({
        providerId: id,
        label: provider.label,
        shortLabel: provider.shortLabel ?? provider.label,
        kind: provider.kind,
        enabled: provider.enabled !== false,
        hasKey: key.hasKey,
        keySource: key.keySource,
        apiKeyRef: provider.apiKeyRef ?? '',
        baseURL: provider.baseURL ?? '',
        consoleUrl: provider.consoleUrl ?? '',
        builtin: false,
        custom: true,
        dshManaged: dshIds.has(id),
        dshProviderId: dshIds.has(id) ? id : null,
        subscribed: providerHasSubscription(id),
        note: def.note ?? '',
        // The declaration (no secrets: only a credential *reference* name) so
        // the edit form can prefill all path fields after a page reload.
        definition: def,
      })
    }

    // Auto-mapped routes without a built-in provider entry become virtual
    // providers: a DSH route id whose usage is served by a built-in adapter
    // (by id or by model base-URL host), so no manual adapter is required.
    for (const route of dshRoutes) {
      if (providers.some((provider) => provider.dshProviderId === route.id)) continue
      const provider = dshRouteProviderConfig(route.id, dshProfiles)
      if (provider === undefined) continue
      const key = await providerKeyInfo(provider)
      providers.push({
        providerId: route.id,
        label: provider.label,
        shortLabel: provider.shortLabel ?? provider.label,
        kind: ADAPTERS[canonicalProviderId(route.id)]?.kind ?? dshRouteMapping(route.id, dshProfiles)?.adapterId
          ? ADAPTERS[dshRouteMapping(route.id, dshProfiles).adapterId]?.kind ?? 'unknown'
          : 'unknown',
        enabled: provider.enabled !== false,
        hasKey: key.hasKey,
        keySource: key.keySource,
        apiKeyRef: provider.apiKeyRef ?? '',
        baseURL: provider.baseURL ?? '',
        consoleUrl: provider.consoleUrl ?? '',
        builtin: false,
        autoMapped: true,
        dshManaged: true,
        dshProviderId: route.id,
        subscribed: providerHasSubscription(route.id),
      })
    }

    const dshProviders = dshRoutes.map((route) => {
      const usageProvider = providers.find((provider) => provider.dshProviderId === route.id)
      const mapping = dshRouteMapping(route.id, dshProfiles)
      return {
        providerId: route.id,
        label: route.name,
        supported: usageProvider !== undefined,
        usageProviderId: usageProvider?.providerId ?? null,
        autoMapped: mapping !== null && usageProvider?.builtin !== true,
        adapterId: mapping?.adapterId ?? null,
        reason: usageProvider === undefined ? 'no-usage-adapter' : null,
      }
    })

    return {
      ok: true,
      providers,
      dshProviders,
      settings: sanitizeSettings(providerStore.settings),
      storeFile: redactPaths(providerStoreFile),
      storeFileDisplay: redactPaths(providerStoreFile),
    }
  }

  /** Persist one management-page edit and invalidate that provider's caches. */
  function applyProviderUpdate(providerId, update) {
    const id = canonicalProviderId(providerId)
    if (PROVIDER_DEFAULTS[id] === undefined && effectiveCustomProvider(id) === undefined && dshRouteProviderConfig(String(providerId)) === undefined) {
      throw new UsageError('unsupported-provider', `provider ${JSON.stringify(providerId)} is not configured`, {
        retryable: false,
      })
    }
    const patch = {}
    if (typeof update?.enabled === 'boolean') patch.enabled = update.enabled
    if (typeof update?.apiKey === 'string') patch.apiKey = update.apiKey.trim()
    if (typeof update?.apiKeyRef === 'string') patch.apiKeyRef = update.apiKeyRef.trim()
    if (typeof update?.baseURL === 'string') {
      const rawBaseURL = update.baseURL.trim()
      patch.baseURL = rawBaseURL === '' ? '' : sanitizeUsageBaseURL(rawBaseURL)
    }
    if (typeof update?.consoleUrl === 'string') patch.consoleUrl = update.consoleUrl.trim()
    if (typeof update?.label === 'string') {
      const label = update.label.trim()
      if (label !== '' && label.length > 40) {
        throw new UsageError('parse', 'provider label must be 40 characters or fewer', { retryable: false })
      }
      patch.label = label
    }
    if (typeof update?.shortLabel === 'string') {
      const shortLabel = update.shortLabel.trim()
      if (shortLabel !== '' && shortLabel.length > 12) {
        throw new UsageError('parse', 'provider shortLabel must be 12 characters or fewer', { retryable: false })
      }
      patch.shortLabel = shortLabel
    }
    const existing = { ...(providerStore.providers[id] ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === '') delete existing[key]
      else existing[key] = value
    }
    const nextProviders = { ...providerStore.providers }
    if (Object.keys(existing).length === 0) delete nextProviders[id]
    else nextProviders[id] = existing
    // Only adopt the new in-memory store after the atomic write succeeded;
    // otherwise a failed save would leave an unsaved override active.
    providerStore = saveProviderStore(providerStoreFile, { ...providerStore, providers: nextProviders })
    state.caches.delete(id)
    state.flights.delete(id)
    state.lastErrors.delete(id)
    warn(`provider ${id} updated from the management page`)
    return id
  }


  /** Whether the plugin can report usage for a picker/provider id. */
  function providerUsable(providerId) {
    const custom = effectiveCustomProvider(providerId)
    if (custom !== undefined) return custom.enabled !== false
    const dshProvider = dshRouteProviderConfig(String(providerId))
    if (dshProvider !== undefined) return dshProvider.enabled !== false
    const id = canonicalProviderId(providerId)
    const provider = effectiveProviderConfig(id)
    return adapterFor(id) !== undefined && provider !== undefined && provider.enabled !== false
  }

  /** The Host default model selection, when the composition exposes it. */
  function defaultModelProvider() {
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service?.currentSelection?.()
      const picked = selection?.provider
      if (typeof picked === 'string' && providerUsable(picked)) return canonicalProviderId(picked)
    } catch {
      /* agent-default-model is optional */
    }
    return config.defaultProvider
  }

  /** The provider the operator is looking at: the browser's pick, the default model, then config. */
  function activeProviderId() {
    const picked = state.client?.providerId
    if (typeof picked === 'string' && providerUsable(picked)) return canonicalProviderId(picked)
    return defaultModelProvider()
  }

  function providerLabel(providerId) {
    const id = canonicalProviderId(providerId)
    return (
      dshRouteProviderConfig(String(providerId))?.label ??
      effectiveProviderConfig(id)?.label ??
      PROVIDER_DEFAULTS[id]?.label ??
      effectiveCustomProvider(providerId)?.label ??
      id
    )
  }

  function providerInfo(providerId) {
    const id = canonicalProviderId(providerId)
    const adapter = adapterForProvider(id)
    return {
      id,
      label: providerLabel(id),
      kind: adapter?.kind ?? 'unknown',
    }
  }

  /** Classify one HTTP exchange into a payload, or throw a typed UsageError. */
  async function requestJson(url, options = {}) {
    const method = typeof options.method === 'string' ? options.method : 'GET'
    const headers = { accept: 'application/json', 'user-agent': USER_AGENT, ...(options.headers ?? {}) }
    if (typeof options.bearer === 'string' && options.bearer !== '') headers.authorization = `Bearer ${options.bearer}`
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new UsageError('timeout', `the usage request timed out after ${config.timeoutMs} ms`, {
          retryable: true,
        })
      }
      throw new UsageError('network', `cannot reach the usage endpoint (${redactEndpoint(url)}): ${String(error?.message ?? error)}`, {
        retryable: true,
      })
    }
    if (!response.ok) {
      const { code, retryable } = classifyStatus(response.status)
      throw new UsageError(code, `the usage endpoint answered HTTP ${response.status}`, { retryable, status: response.status })
    }
    try {
      return await response.json()
    } catch {
      throw new UsageError('parse', 'the usage endpoint did not return JSON', { retryable: false })
    }
  }

  /** The built-in adapters' convenience wrapper: GET with a Bearer token. */
  async function fetchJson(url, keyValue) {
    return requestJson(url, { bearer: keyValue })
  }

  /** Read one provider's usage: resolve its key (when it has one), call its adapter. */
  async function readProvider(providerId, now) {
    const id = canonicalProviderId(providerId)
    const adapter = adapterForProvider(id)
    if (adapter === undefined) {
      throw new UsageError(
        'unsupported-provider',
        `provider ${JSON.stringify(providerId)} has no usage adapter`,
        { retryable: false },
      )
    }
    const custom = effectiveCustomProvider(id)
    const mapping = dshRouteMapping(String(providerId))
    let provider = custom ?? dshRouteProviderConfig(String(providerId)) ?? effectiveProviderConfig(id)
    if (provider === undefined || provider.enabled === false) {
      throw new UsageError('disabled', `provider ${JSON.stringify(providerId)} is disabled`, {
        retryable: false,
      })
    }
    if (typeof provider.baseURL === 'string' && provider.baseURL.trim() !== '') {
      try {
        provider = { ...provider, baseURL: sanitizeUsageBaseURL(provider.baseURL) }
      } catch {
        throw new UsageError('parse', `provider ${JSON.stringify(id)} has an unsafe baseURL (https required)`, {
          retryable: false,
        })
      }
    }
    const adapterId = mapping?.adapterId ?? id
    let keyInfo = { ref: '', source: 'service', detail: `${provider.service ?? 'service'} service` }
    let keyValue = ''
    if (adapterId === 'volcengine') {
      const accessRef = provider.apiKeyRef || 'VOLCENGINE_ACCESS_KEY_ID'
      const secretRef = provider.secretAccessKeyRef || 'VOLCENGINE_SECRET_ACCESS_KEY'
      const access = await resolveApiKey({
        config: { apiKeyRef: accessRef },
        credentials: ctx.get('credentials'),
        env: process.env,
      })
      const secret = await resolveApiKey({
        config: { apiKeyRef: secretRef },
        credentials: ctx.get('credentials'),
        env: process.env,
      })
      const accessValue = typeof access.value === 'string' ? access.value : ''
      const secretValue = typeof secret.value === 'string' ? secret.value : ''
      if (accessValue === '' || secretValue === '') {
        throw new UsageError('missing-key', `Volcengine quota needs ${accessRef} and ${secretRef}`, { retryable: false })
      }
      provider = { ...provider, accessKeyId: accessValue, secretAccessKey: secretValue }
      keyInfo = { ref: accessRef, source: access.source, detail: access.detail }
    } else if (adapterId === 'open-design') {
      const workspaceId =
        String(provider.workspaceId ?? '').trim() || String(process.env.OPENDESIGN_WORKSPACE_ID ?? '').trim()
      const refs = []
      for (const ref of [provider.controlKeyRef, 'OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY']) {
        if (typeof ref === 'string' && ref.trim() !== '' && !refs.includes(ref.trim())) refs.push(ref.trim())
      }
      // The management page's per-provider key field holds the Control Key here
      // (the inference API key cannot query billing).
      let controlKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
      let controlRef = refs[0] ?? 'OPENDESIGN_CONTROL_KEY'
      let controlSource = controlKey === '' ? 'none' : 'config'
      let controlDetail = controlKey === '' ? 'no OpenDesign control key found' : 'plugin config'
      if (controlKey === '') {
        for (const ref of refs) {
          const resolved = await resolveApiKey({
            config: { apiKeyRef: ref },
            credentials: ctx.get('credentials'),
            env: process.env,
          })
          const value = typeof resolved.value === 'string' ? resolved.value.trim() : ''
          if (value === '') continue
          controlKey = value
          controlRef = resolved.ref ?? ref
          controlSource = resolved.source
          controlDetail = resolved.detail
          break
        }
      }
      if (workspaceId === '') {
        throw new UsageError(
          'missing-key',
          'OpenDesign quota needs a workspace id (providers.open-design.workspaceId or OPENDESIGN_WORKSPACE_ID)',
          { retryable: false },
        )
      }
      if (controlKey === '') {
        throw new UsageError('missing-key', `OpenDesign quota needs a Control Key (${refs.join(' / ')})`, {
          retryable: false,
        })
      }
      provider = { ...provider, workspaceId, controlKey }
      keyInfo = { ref: controlRef, source: controlSource, detail: controlDetail }
    } else if (typeof provider.apiKeyRef === 'string' && provider.apiKeyRef.trim() !== '') {
      const key = await resolveApiKey({
        config: { apiKeyRef: provider.apiKeyRef, apiKey: provider.apiKey ?? '' },
        credentials: ctx.get('credentials'),
        env: process.env,
      })
      keyInfo = { ref: key.ref, source: key.source, detail: key.detail }
      keyValue = typeof key.value === 'string' ? key.value : ''
      if (keyValue === '') {
        throw new UsageError('missing-key', `no credential is configured for ${key.ref}`, {
          retryable: false,
        })
      }
    }
    state.keys.set(id, keyInfo)
    const started = Date.now()
    const result = await adapter.read({
      providerId: mapping?.adapterId ?? id,
      provider,
      fetchJson: (url) => fetchJson(url, keyValue),
      httpJson: (url, options) => requestJson(url, options),
      services: { account: ctx.get('deepseekAccount') },
      now,
    })
    return { result, keyInfo, latencyMs: Date.now() - started, fetchedAtMs: Date.now() }
  }

  /**
   * Provider-owned web pages the dialog links to. They follow the selected
   * provider, so the footer link never points at the wrong console:
   *
   *   - OpenCode → https://opencode.ai/console
   *   - Command Code → https://commandcode.ai/<userName>/settings/usage when the
   *     account name is known (that page is the plan-usage card), else home
   *   - DeepSeek / DeepSeek Account → https://platform.deepseek.com/usage
   *
   * A profile override wins: `providers.<id>.consoleUrl`.
   */
  function consoleLinks(providerId, result) {
    const id = canonicalProviderId(providerId)
    const custom = effectiveCustomProvider(id)
    const provider = custom ?? dshRouteProviderConfig(String(providerId)) ?? effectiveProviderConfig(id)
    if (provider === undefined) return null
    let consoleUrl =
      typeof provider.consoleUrl === 'string' && provider.consoleUrl !== '' ? provider.consoleUrl : null
    const userName = result?.account?.userName
    if (
      id === 'commandcode' &&
      typeof userName === 'string' &&
      userName !== '' &&
      provider.consoleUrl === PROVIDER_DEFAULTS.commandcode.consoleUrl
    ) {
      consoleUrl = `https://commandcode.ai/${encodeURIComponent(userName)}/settings/usage`
    }
    return consoleUrl === null ? null : { console: consoleUrl }
  }

  function snapshotFromResult(providerId, read, now) {
    return buildSnapshot({
      provider: providerInfo(providerId),
      plan: read.result.plan ?? null,
      windows: read.result.windows ?? null,
      balance: read.result.balance ?? null,
      credits: read.result.credits ?? null,
      account: read.result.account ?? null,
      links: consoleLinks(providerId, read.result),
      fetchedAtMs: read.fetchedAtMs,
      now,
      latencyMs: read.latencyMs,
      source: 'api',
      key: read.keyInfo,
    })
  }

  function announce() {
    for (const listener of [...state.subscribers]) {
      try {
        listener()
      } catch {
        /* a broken observer never breaks the plugin */
      }
    }
  }

  /** Force one provider read; failures keep that provider's previous snapshot as stale cache. */
  async function performRefresh(providerId) {
    if (providerId === null) {
      const error = errorToWire(new UsageError('disabled', 'no usable provider is enabled', { retryable: false }))
      return { ok: false, error, snapshot: null }
    }
    const canonicalId = canonicalProviderId(String(providerId))
    state.lastAttempts.set(canonicalId, new Date().toISOString())
    try {
      const read = await readProvider(canonicalId, Date.now())
      const snapshot = snapshotFromResult(canonicalId, read, Date.now())
      state.caches.set(canonicalId, { snapshot, fetchedAtMs: read.fetchedAtMs })
      state.lastErrors.delete(canonicalId)
      state.requestCounts.set(canonicalId, (state.requestCounts.get(canonicalId) ?? 0) + 1)
      announce()
      noteStatus('refresh', {
        provider: canonicalId,
        snapshot: {
          fetchedAt: snapshot.fetchedAt,
          provider: snapshot.provider,
          plan: snapshot.plan,
          windows: snapshot.windows,
          balance: snapshot.balance,
          credits: snapshot.credits,
        },
        lastError: null,
      })
      log('info', `usage refreshed for ${canonicalId}`)
      return { ok: true, snapshot }
    } catch (error) {
      const wire = errorToWire(error)
      state.lastErrors.set(canonicalId, wire)
      announce()
      const cached = state.caches.get(canonicalId) ?? null
      const snapshot = cached === null ? null : asStaleCache(cached.snapshot, Date.now())
      noteStatus('refresh-failed', { provider: canonicalId, lastError: wire })
      warn(`usage refresh failed for ${canonicalId}: ${wire.code}: ${wire.message}`)
      return { ok: false, error: wire, snapshot }
    }
  }

  /**
   * Read one provider's usage through the cache.
   *
   * @param providerId - provider id, or null for "no usable provider".
   * @param options.force - bypass the cache TTL and always ask upstream.
   * @returns `{ ok: true, snapshot }` or `{ ok: false, error, snapshot }`.
   */
  async function get(providerId, options = {}) {
    if (providerId === null) {
      const error = errorToWire(new UsageError('disabled', 'no usable provider is enabled', { retryable: false }))
      return { ok: false, error, snapshot: null }
    }
    const canonicalId = canonicalProviderId(String(providerId))
    const cached = state.caches.get(canonicalId)
    if (cached !== undefined && options.force !== true) {
      const now = Date.now()
      if (isFresh(cached.snapshot, now, config.minRefreshIntervalMs)) {
        return { ok: true, snapshot: asCacheHit(cached.snapshot, now) }
      }
    }
    const flight = state.flights.get(canonicalId)
    if (flight !== undefined) return await flight
    const started = performRefresh(canonicalId)
    state.flights.set(canonicalId, started)
    try {
      return await started
    } finally {
      if (state.flights.get(canonicalId) === started) state.flights.delete(canonicalId)
    }
  }

  // ---- background poll -----------------------------------------------------

  /** Start the background poll once a browser is connected (no browser, no timer). */
  function ensurePoll() {
    if (config.pollIntervalMs <= 0 || state.poll.timer !== null || state.disposed) return
    state.poll.timer = setInterval(() => {
      const providerId = activeProviderId()
      if (providerId !== null) void get(providerId, { force: true })
    }, config.pollIntervalMs)
    state.poll.timer.unref?.()
    noteStatus('poll-start', { pollIntervalMs: config.pollIntervalMs })
  }

  // ---- token statistics ----------------------------------------------------

  /**
   * Canonical provider id → installed model ids.
   *
   * Used to attribute a harness's own provider ids (ZCode uuids,
   * `opencode-go-chat`, …) onto a DSH provider: when a ZCode model id appears in
   * exactly one DSH provider's catalog, that row belongs to that provider.
   * `ctx.llm.listProviders()` is synchronous but `listModels()` returns a Promise,
   * so this helper is async. The `llm` service is optional; without it only the
   * configured aliases apply.
   */
  async function providerModelCatalog() {
    const catalog = {}
    try {
      const llm = ctx.get('llm')
      if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return catalog
      const providers = await Promise.resolve(llm.listProviders())
      if (!Array.isArray(providers)) return catalog
      for (const provider of providers) {
        const rawId = provider?.id
        const id = canonicalProviderId(rawId)
        if (typeof id !== 'string' || id === '') continue
        const models = typeof llm.listModels === 'function' ? await Promise.resolve(llm.listModels(rawId)) : []
        if (!Array.isArray(models)) continue
        catalog[id] = models
          .map((model) => (typeof model === 'string' ? model : model?.id))
          .filter((model) => typeof model === 'string' && model !== '')
      }
    } catch (error) {
      log('warn', `could not read the provider model catalog: ${String(error?.message ?? error)}`)
    }
    return catalog
  }

  const statsService = config.stats.enabled
    ? createUsageStats({
        dshHome: config.stats.dshHome !== '' ? config.stats.dshHome : dshHomeOf(process.env),
        config,
        providerCatalog: providerModelCatalog,
        log: { info: (message) => log('info', message), warn },
      })
    : null

  /** Token statistics for the dialog: today + all-time totals. */
  /** Whether the last snapshot of this provider represents a subscription/plan. */
  function providerHasSubscription(providerId) {
    const cached = state.caches.get(canonicalProviderId(String(providerId)))
    const snapshot = cached?.snapshot
    if (snapshot === null || snapshot === undefined || snapshot.ok !== true) return false
    // A paid plan id is the strongest signal.
    if (snapshot.plan !== null && snapshot.plan !== undefined) return true
    if (snapshot.windows === null || snapshot.windows === undefined) return false
    // Percentage windows only exist for plan quotas; a free/empty Command Code
    // snapshot has window objects with null percentages and must stay on 30 days.
    return Object.values(snapshot.windows).some(
      (window) => window !== null && window !== undefined && Number.isFinite(window.percent),
    )
  }


  /** Attach workspace ids/titles to the per-cwd local token totals. */
  function decorateWorkspaces(stats) {
    if (stats === null || typeof stats !== 'object' || !Array.isArray(stats.workspaces)) return stats
    let registry = null
    try {
      registry = ctx.get('workspaceRegistry') ?? null
    } catch {
      registry = null
    }
    let list = []
    try {
      const raw = registry !== null && typeof registry.list === 'function' ? registry.list() : []
      if (Array.isArray(raw)) list = raw
    } catch {
      list = []
    }
    const normalize = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    const basename = (value) => {
      const parts = String(value ?? '').split(/[\\/]/).filter((part) => part !== '')
      return parts.length === 0 ? String(value ?? '') : parts[parts.length - 1]
    }
    const merged = new Map()
    for (const row of stats.workspaces) {
      const cwd = typeof row?.cwd === 'string' ? row.cwd : ''
      if (cwd === '') continue
      const normalized = normalize(cwd)
      let match = null
      let bestLength = -1
      for (const workspace of list) {
        const rawPath = typeof workspace?.path === 'string' ? workspace.path : ''
        if (rawPath === '') continue
        const candidate = normalize(rawPath)
        if (normalized !== candidate && !normalized.startsWith(candidate + '/')) continue
        if (candidate.length > bestLength) {
          bestLength = candidate.length
          match = workspace
        }
      }
      const workspaceId = match !== null && match.id !== undefined ? String(match.id) : null
      const key = workspaceId ?? normalized
      const title =
        match !== null && typeof match.title === 'string' && match.title !== '' ? match.title : basename(cwd)
      const existing = merged.get(key)
      const messages = Number.isFinite(row.messages) ? row.messages : 0
      const windowOf = (value) => ({
        total: Number.isFinite(value?.total) ? value.total : 0,
        messages: Number.isFinite(value?.messages) ? value.messages : 0,
      })
      if (existing === undefined) {
        merged.set(key, {
          workspaceId,
          label: title,
          path: cwd,
          today: windowOf(row.today),
          last7Days: windowOf(row.last7Days),
          last30Days: windowOf(row.last30Days),
          total: Number.isFinite(row.total) ? row.total : 0,
          messages,
        })
      } else {
        for (const bucket of ['today', 'last7Days', 'last30Days']) {
          existing[bucket].total += Number.isFinite(row[bucket]?.total) ? row[bucket].total : 0
          existing[bucket].messages += Number.isFinite(row[bucket]?.messages) ? row[bucket].messages : 0
        }
        existing.total += Number.isFinite(row.total) ? row.total : 0
        existing.messages += messages
      }
    }
    return { ...stats, workspaces: [...merged.values()].sort((a, b) => b.total - a.total) }
  }

  /** Stats payload boundary: drop local absolute paths before they leave the Host. */
  function sanitizeStatsForWire(stats) {
    if (stats === null || typeof stats !== 'object') return stats
    const out = redactPaths(stats)
    const harnesses = ['zcode', 'opencode', 'workbuddy', 'qoder']
    for (const id of harnesses) {
      if (out[id] === null || typeof out[id] !== 'object') continue
      const { dbPath, root, home, ...rest } = out[id]
      out[id] = rest
    }
    if (out.scan !== null && typeof out.scan === 'object') {
      const { cacheFile, failures, ...rest } = out.scan
      out.scan = {
        ...rest,
        failures: Array.isArray(failures)
          ? failures.map(({ path, ...entry }) => entry)
          : [],
      }
    }
    if (Array.isArray(out.workspaces)) {
      out.workspaces = out.workspaces.map(({ cwd, path, ...row }) => row)
    }
    out.workspaces = out.workspaces.map((row) => ({
      ...row,
      path: String(row.path ?? row.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '',
    }))
    return scrubMessagePaths(out)
  }

  async function getStats(options = {}) {
    if (statsService === null) {
      return {
        ok: false,
        error: errorToWire(new UsageError('stats-unavailable', 'token statistics are disabled', { retryable: false })),
      }
    }
    try {
      const stats = await statsService.get({ fresh: options.fresh === true })
      // v0.22.1: only subscription-backed providers use the 最近X天 window;
      // pay-as-you-go/balance providers keep the fixed 最近30天 column.
      const decorated =
        stats !== null && typeof stats === 'object' && Array.isArray(stats.providers)
          ? {
              ...decorateWorkspaces(stats),
              providers: stats.providers.map((provider) => ({
                ...provider,
                subscribed: providerHasSubscription(provider.providerId),
              })),
            }
          : stats
      return { ok: true, stats: sanitizeStatsForWire(decorated) }
    } catch (error) {
      const wire = errorToWire(error)
      warn(`token statistics failed: ${wire.code}: ${wire.message}`)
      return { ok: false, error: wire }
    }
  }

  // ---- diagnostics ---------------------------------------------------------

  /** Secret-free description of the plugin's configuration and live state. */
  function diagnostics() {
    const now = Date.now()
    const providers = {}
    for (const [id, provider] of Object.entries(config.providers)) {
      const cache = state.caches.get(id)
      providers[id] = {
        id,
        label: providerLabel(id),
        kind: ADAPTERS[id]?.kind ?? 'unknown',
        enabled: provider.enabled,
        apiKeyRef: provider.apiKeyRef,
        key: state.keys.get(id) ?? null,
        requests: state.requestCounts.get(id) ?? 0,
        lastAttempt: state.lastAttempts.get(id) ?? null,
        lastError: state.lastErrors.get(id) ?? null,
        cache:
          cache === undefined
            ? null
            : {
                fetchedAt: cache.snapshot.fetchedAt,
                ageMs: Math.max(0, now - cache.fetchedAtMs),
                windows: cache.snapshot.windows,
                plan: cache.snapshot.plan,
                balance: cache.snapshot.balance,
                credits: cache.snapshot.credits,
              },
      }
    }
    const payload = {
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      pid: process.pid,
      runtime: `node ${process.versions.node}`,
      at: new Date(now).toISOString(),
      config: {
        enabled: config.enabled,
        defaultProvider: config.defaultProvider,
        minRefreshIntervalMs: config.minRefreshIntervalMs,
        timeoutMs: config.timeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        statusFile: config.statusFile,
        stats: {
          enabled: config.stats.enabled,
          ttlMs: config.stats.ttlMs,
          showUninstalled: config.stats.showUninstalled,
          harnesses: { ...config.stats.harnesses },
          zcode: { dbPath: config.stats.zcode.dbPath },
          opencode: { dbPath: config.stats.opencode.dbPath },
          workbuddy: { root: config.stats.workbuddy.root },
          qoder: { home: config.stats.qoder.home },
        },
      },
      activeProvider: activeProviderId(),
      client: state.client,
      bridge: { ...state.bridge },
      providers,
      stats: statsService?.diagnostics?.() ?? null,
      subscribers: state.subscribers.size,
      poll: { running: state.poll.timer !== null, intervalMs: config.pollIntervalMs },
    }
    return scrubMessagePaths(redactPaths(payload))
  }

  // ---- service -------------------------------------------------------------

  const service = {
    /** Usage for one provider (defaults to the active one). */
    get: (options = {}) =>
      get(
        typeof options.providerId === 'string' && options.providerId !== ''
          ? options.providerId
          : activeProviderId(),
        options,
      ),
    refresh: (options = {}) =>
      get(
        typeof options.providerId === 'string' && options.providerId !== ''
          ? options.providerId
          : activeProviderId(),
        { force: true },
      ),
    snapshot: async (options = {}) => {
      const result = await service.get(options)
      return result.snapshot
    },
    stats: getStats,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      state.subscribers.add(listener)
      return () => state.subscribers.delete(listener)
    },
    diagnostics,
    config: () => ({
      ...config,
      // Provider config may carry a literal apiKey from a profile override;
      // other composed plugins only need the non-secret shape.
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([id, provider]) => [
          id,
          { ...provider, apiKey: undefined },
        ]),
      ),
    }),
  }
  ctx.provide('planUsage', service)
  // v1 compatibility: the plugin used to expose only the OpenCode route.
  ctx.provide('tokenlens', service)

  ctx.effect(
    () => () => {
      state.disposed = true
      if (state.poll.timer !== null) clearInterval(state.poll.timer)
      if (state.status.timer !== null) clearTimeout(state.status.timer)
      state.poll.timer = null
      state.status.timer = null
      state.subscribers.clear()
    },
    'dsh-tokenlens: lifecycle',
  )

  // ---- browser bridge ------------------------------------------------------

  /** A JSON `Response` with caching disabled. */
  function json(value, status = 200) {
    return new Response(JSON.stringify(value ?? null), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  try {
    ctx.inject(['connection'], (scope) => {
      try {
        state.bridge.found = true
        scope.effect(() => {
          const dispose = scope.connection.fetch.register({
            path: BRIDGE,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: (request) => handleBridge(request),
          })
          state.bridge.registered = true
          log('info', `browser bridge registered at ${BRIDGE}`)
          noteStatus('bridge', {})
          return dispose
        })
      } catch (error) {
        state.bridge.error = String(error?.message ?? error)
        warn(`browser bridge unavailable: ${state.bridge.error}`)
        noteStatus('bridge', { error: state.bridge.error })
      }
    })
  } catch (error) {
    state.bridge.error = String(error?.message ?? error)
    warn(`connection service unavailable: ${state.bridge.error}`)
    noteStatus('bridge', { error: state.bridge.error })
  }

  /** The provider a bridge request names, falling back to the active one. */
  function requestProvider(body) {
    const named = body?.providerId
    if (typeof named === 'string' && named.trim() !== '') return named.trim()
    return activeProviderId()
  }

  /** Keep the active provider on the selection the browser last reported. */
  function rememberRequestedProvider(body) {
    const named = body?.providerId
    if (typeof named !== 'string' || named.trim() === '') return
    const providerId = named.trim()
    if (state.client?.providerId === providerId) return
    state.client = { ...(state.client ?? {}), providerId, at: state.client?.at ?? new Date().toISOString() }
    noteStatus('client-provider', { client: state.client })
    // The chip is polling for a provider now: the background refresh must follow it.
    ensurePoll()
  }

  /** One JSON request/response exchange with the browser half. */
  async function handleBridge(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return json(
        { ok: false, error: { code: 'internal', message: 'the request body is not JSON', retryable: false } },
        400,
      )
    }
    const action = typeof body?.action === 'string' ? body.action : 'snapshot'
    try {
      if (action === 'hello') {
        const providerId = typeof body?.providerId === 'string' && body.providerId.trim() !== ''
          ? body.providerId.trim()
          : null
        state.client = {
          origin: typeof body?.origin === 'string' ? body.origin : undefined,
          locale: typeof body?.locale === 'string' ? body.locale : undefined,
          primitives: Number.isSafeInteger(body?.primitives) ? body.primitives : undefined,
          providerId,
          at: new Date().toISOString(),
        }
        // The chip is on screen: keep the shared cache warm from now on.
        ensurePoll()
        // Token statistics are only requested when the dialog opens; warming the
        // cache now makes that first open immediate and puts the scan outcome in
        // the status file for outside inspection.
        if (statsService !== null) {
          void getStats().then((result) => {
            noteStatus('stats', {
              stats: result.ok
                ? {
                    generatedAt: result.stats.generatedAt,
                    day: result.stats.day,
                    todayTotal: result.stats.today.total,
                    last30DaysTotal: result.stats.last30Days.total,
                    allTimeTotal: result.stats.allTime.total,
                    sessions: result.stats.scan.sessions,
                    scanned: result.stats.scan.scanned,
                    reused: result.stats.scan.reused,
                    durationMs: result.stats.scan.durationMs,
                    // Provider-scoped totals across harnesses (30d) — the value
                    // the dialog shows for the selected provider.
                    providers: Object.fromEntries(
                      (result.stats.providers ?? []).map((provider) => [
                        provider.providerId,
                        {
                          last30Days: provider.last30Days.total,
                          allTime: provider.allTime.total,
                          harnesses: Object.keys(provider.harnesses ?? {}),
                        },
                      ]),
                    ),
                    harnesses: Object.fromEntries(
                      (result.stats.harnesses ?? []).map((harness) => [
                        harness.harnessId,
                        { today: harness.today.total, last30Days: harness.last30Days.total, allTime: harness.allTime.total, error: harness.error?.code ?? null },
                      ]),
                    ),
                    unmappedCount: (result.stats.zcode?.unmapped ?? []).length,
                    missingHarnesses: result.stats.missingHarnesses ?? [],
                  }
                : null,
              statsError: result.ok ? null : result.error,
            })
          })
        }
        noteStatus('client', { client: state.client })
        log('info', `browser half connected from ${String(state.client.origin ?? 'unknown origin')} (${providerId ?? 'default provider'})`)
        // Answer with a snapshot too, so the first paint needs one round trip.
        const first = await get(requestProvider(body))
        return json({ ok: true, plugin: PLUGIN_NAME, version: PLUGIN_VERSION, bridge: BRIDGE, pid: process.pid, ...first })
      }
      if (action === 'snapshot' || action === 'status') {
        rememberRequestedProvider(body)
        return json(await get(requestProvider(body)))
      }
      if (action === 'refresh') {
        rememberRequestedProvider(body)
        return json(await get(requestProvider(body), { force: true }))
      }
      if (action === 'stats') return json(await getStats({ fresh: body?.fresh === true }))
      if (action === 'providers') return json(await providersPayload())
      if (action === 'customProviderSave') {
        const def = validateCustomProvider(body?.provider ?? body)
        if (PROVIDER_DEFAULTS[def.providerId] !== undefined || ADAPTERS[def.providerId] !== undefined) {
          throw new UsageError('parse', 'custom provider id collides with a built-in provider', { retryable: false })
        }
        providerStore = saveProviderStore(providerStoreFile, {
          ...providerStore,
          customProviders: { ...(providerStore.customProviders ?? {}), [def.providerId]: def },
        })
        state.caches.delete(def.providerId)
        state.flights.delete(def.providerId)
        state.lastErrors.delete(def.providerId)
        warn(`custom usage adapter ${def.providerId} saved`)
        return json(await providersPayload())
      }
      if (action === 'customProviderDelete') {
        const rawId = typeof body?.providerId === 'string' ? body.providerId.trim().toLowerCase() : ''
        const customProviders = { ...(providerStore.customProviders ?? {}) }
        delete customProviders[rawId]
        providerStore = saveProviderStore(providerStoreFile, { ...providerStore, customProviders })
        state.caches.delete(rawId)
        state.flights.delete(rawId)
        state.lastErrors.delete(rawId)
        warn(`custom usage adapter ${rawId} deleted`)
        return json(await providersPayload())
      }
      if (action === 'settingsUpdate') {
        const incoming = body?.settings !== null && typeof body?.settings === 'object' ? body.settings : {}
        const current = sanitizeSettings(providerStore.settings)
        const next = { ...current }
        if (Object.prototype.hasOwnProperty.call(incoming, 'labelStyle')) {
          if (!LABEL_STYLES.includes(incoming.labelStyle)) {
            throw new UsageError('unsupported-provider', `settings.labelStyle must be one of ${LABEL_STYLES.join(', ')}`, {
              retryable: false,
            })
          }
          next.labelStyle = incoming.labelStyle
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'defaultView')) {
          if (!DISPLAY_VIEWS.includes(incoming.defaultView)) {
            throw new UsageError('unsupported-provider', `settings.defaultView must be one of ${DISPLAY_VIEWS.join(', ')}`, {
              retryable: false,
            })
          }
          next.defaultView = incoming.defaultView
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'defaultScope')) {
          if (!STATS_SCOPES.includes(incoming.defaultScope)) {
            throw new UsageError('unsupported-provider', `settings.defaultScope must be one of ${STATS_SCOPES.join(', ')}`, {
              retryable: false,
            })
          }
          next.defaultScope = incoming.defaultScope
        }
        if (Object.prototype.hasOwnProperty.call(incoming, 'detailsExpanded')) {
          if (!DETAILS_DEFAULTS.includes(incoming.detailsExpanded)) {
            throw new UsageError('unsupported-provider', `settings.detailsExpanded must be one of ${DETAILS_DEFAULTS.join(', ')}`, {
              retryable: false,
            })
          }
          next.detailsExpanded = incoming.detailsExpanded
        }
        providerStore = saveProviderStore(providerStoreFile, {
          ...providerStore,
          settings: next,
        })
        noteStatus('settings-update', { providerStoreFile })
        return json(await providersPayload())
      }
      if (action === 'providerUpdate') {
        const providerId = typeof body?.providerId === 'string' ? body.providerId : ''
        const update = body?.update !== null && typeof body?.update === 'object' ? body.update : {}
        applyProviderUpdate(providerId, update)
        noteStatus('provider-update', { providerStoreFile })
        return json(await providersPayload())
      }
      if (action === 'providerTest') {
        const providerId = requestProvider(body)
        const result = await get(providerId, { force: true })
        return json(result)
      }
      if (action === 'diagnostics') return json({ ok: true, diagnostics: diagnostics() })
      return json(
        {
          ok: false,
          error: {
            code: 'unknown-action',
            message: `unknown action ${JSON.stringify(action)}`,
            retryable: false,
          },
          actions: ACTIONS,
        },
        400,
      )
    } catch (error) {
      const wire = errorToWire(error)
      warn(`bridge action "${action}" failed: ${wire.code}: ${wire.message}`)
      return json({ ok: false, error: wire, snapshot: state.caches.get(activeProviderId())?.snapshot ?? null }, 500)
    }
  }

  // ---- agent tool ----------------------------------------------------------

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() =>
      tools.register({
        name: 'tokenlens_usage',
        description:
          'Read the current AI provider plan usage and the local token statistics. ' +
          'Usage is provider-aware: OpenCode/Go Plus reports 5-hour/weekly/monthly allowance percentages; ' +
          'Command Code reports 5-hour/weekly dollar windows plus monthly credits; DeepSeek reports the account balance. ' +
          'Token statistics are computed from this machine\'s DSH session logs (today + all time, per provider/model). ' +
          'Actions: "snapshot" reads the cached usage (refreshing when stale), "refresh" forces an upstream read, ' +
          '"stats" reads today/all-time token totals, "diagnostics" reports plugin/key/bridge state without secrets.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: TOOL_ACTIONS,
              description: 'snapshot (default) reads usage; refresh forces a fresh read; stats reads token totals; diagnostics reports plugin state.',
            },
            providerId: {
              type: 'string',
              description: 'Provider whose usage to read (opencode-go, commandcode, deepseek); defaults to the active provider.',
            },
          },
          required: [],
        },
        output: {
          schema: { type: 'object', description: 'A usage snapshot, token statistics, or a diagnostics report.' },
          render: (_args, value) => [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
          ],
        },
        async execute(args) {
          const action = typeof args?.action === 'string' ? args.action : 'snapshot'
          if (!TOOL_ACTIONS.includes(action)) {
            return jsonSafe({
              ok: false,
              error: { code: 'unknown-action', message: `unknown action ${JSON.stringify(action)}`, retryable: false },
              actions: TOOL_ACTIONS,
            })
          }
          const providerId =
            typeof args?.providerId === 'string' && args.providerId.trim() !== ''
              ? args.providerId.trim()
              : activeProviderId()
          if (action === 'diagnostics') return jsonSafe({ ok: true, diagnostics: diagnostics() })
          if (action === 'stats') return jsonSafe(await getStats())
          if (action === 'refresh') return jsonSafe(await get(providerId, { force: true }))
          return jsonSafe(await get(providerId))
        },
      }),
    )
  }

  noteStatus('activate', { pollIntervalMs: config.pollIntervalMs })
  log(
    'info',
    `ready (providers ${Object.keys(config.providers).filter((id) => config.providers[id].enabled).join(', ') || 'none'}, cache ${config.minRefreshIntervalMs} ms, poll ${config.pollIntervalMs} ms)`,
  )
}

/** Round-trip a tool value through JSON: tool results must be lossless JSON. */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value) ?? 'null')
}
