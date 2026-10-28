/**
 * Render smoke tests for the client half of dsh-tokenlens (v2).
 *
 * The browser bundle is a plain script that registers a factory on
 * `window.__ModuleLoader__`, so the test stands up the same surface: a stub
 * `window` (with fake timers), a stub React (hooks + `createElement`), a stub
 * primitives module, and a stub Cordis context that records what the plugin
 * registers and which dictionaries it registers.
 *
 * Two stub details matter here:
 *
 *   - `useEffect` runs its callback eagerly, so one render commits the same
 *     side effects a mounted component would (provider sync, lazy stats load).
 *     Assertions therefore inspect a second render taken after the store settled.
 *   - `useProjection` is supplied by the caller: the plugin learns the provider
 *     from that prop, exactly like the session-scoped composer slot does.
 *
 * Covered: provider-aware window/balance chip bodies, the monthly "—" of a
 * provider without a plan, provider switching (old answers dropped), silent
 * hiding for missing-key/unsupported-provider/disabled, the detail dialog
 * (plan header, allowance rows, credits, balance card, token statistics,
 * independent stats failure), refresh refreshing usage + stats, hidden-page
 * polling, and no-throw rendering of hostile wire data.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/** A minimal React: enough for hooks and element construction. */
function stubReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    memo: (component) => component,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // Effects run eagerly: this single render pass behaves like a committed
    // mount, which is what lets a test drive the shared store without a DOM.
    useEffect: (fn) => fn(),
    useRef: (initial) => ({ current: initial ?? null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useId: () => 'test-id',
  }
}

/** Every primitive resolves to a callable placeholder; the tree only needs identity. */
function stubPrimitives() {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (String(name) === '__esModule') return true
        return (...args) => ({ __primitive: String(name), args })
      },
    },
  )
}

/** Collect every string in an element tree (children, props.children, and label-like props). */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    collectText(node.children, out)
    collectText(node.props?.children, out)
    // Slot/primitive props that hold element trees rather than children: the
    // stub Modal never renders, so its `footer` must be walked explicitly.
    for (const key of ['footer', 'body', 'header', 'actions']) collectText(node.props?.[key], out)
    for (const key of ['title', 'label', 'description']) {
      const value = node.props?.[key]
      if (typeof value === 'string') out.push(value)
    }
  }
  return out
}

/** Find the first element matching a predicate. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (predicate(node)) return node
  return (
    findElement(node.children, predicate) ??
    findElement(node.props?.children, predicate) ??
    findElement(node.props?.footer, predicate) ??
    findElement(node.props?.body, predicate)
  )
}

/** Find every element matching a predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  findAll(node.props?.children, predicate, out)
  findAll(node.props?.footer, predicate, out)
  findAll(node.props?.body, predicate, out)
  return out
}

/** The text of one element, joined without separators. */
function textOf(node) {
  return collectText(node).join('')
}

/** The `{name}` placeholders the LocaleRuntime fills. */
function fillTemplate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    params !== undefined && params[key] !== undefined ? String(params[key]) : `{${key}}`,
  )
}

/** A translator over one captured dictionary, mirroring the locale seat's params. */
function translatorOf(dictionary) {
  return (key, params) => {
    const template = dictionary?.[key]
    if (typeof template !== 'string') return key
    return params === undefined ? template : fillTemplate(template, params)
  }
}

/** Wait for the controller's asynchronous calls to settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

/** A stats bucket with all six counters. */
function bucket(overrides = {}) {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, ...overrides }
}

/** One allowance window, resetting `hours` from now. */
function windowFixture(percent, hoursFromNow, overrides = {}) {
  const remainingMs = Math.round(hoursFromNow * 3600000)
  return {
    id: 'rolling',
    percent,
    status: 'ok',
    resetsAt: new Date(Date.now() + remainingMs).toISOString(),
    remainingMs,
    ...overrides,
  }
}

/** A v2 snapshot for one provider. */
function snapshotFixture(providerId = 'opencode-go') {
  const now = Date.now()
  const common = {
    ok: true,
    version: 2,
    fetchedAt: new Date(now - 60000).toISOString(),
    ageMs: 60000,
    stale: false,
    latencyMs: 87,
    source: 'api',
    key: { ref: 'OPENCODE_GO_API_KEY', source: 'credentials' },
  }
  if (providerId === 'deepseek') {
    return {
      ...common,
      provider: { id: 'deepseek', label: 'DeepSeek', kind: 'balance' },
      plan: null,
      windows: null,
      balance: { amount: 2.26, currency: 'CNY', granted: 0, toppedUp: 2.26 },
      credits: null,
      account: null,
      links: { console: 'https://platform.deepseek.com/usage' },
    }
  }
  if (providerId === 'deepseek-account') {
    return {
      ...common,
      provider: { id: 'deepseek-account', label: 'DeepSeek Account', kind: 'balance' },
      plan: null,
      windows: null,
      balance: {
        amount: 12.5,
        currency: 'CNY',
        wallets: [
          { currency: 'CNY', amount: 12.5 },
          { currency: 'USD', amount: 0.5 },
        ],
        bonus: [{ currency: 'CNY', amount: 2 }],
      },
      credits: null,
      account: { name: '', userName: '' },
      links: { console: 'https://platform.deepseek.com/usage' },
    }
  }
  if (providerId === 'commandcode') {
    return {
      ...common,
      provider: { id: 'commandcode', label: 'Command Code', kind: 'windows' },
      plan: { id: 'beginner', label: 'Beginner' },
      windows: {
        // Command Code windows carry the provider-native dollar capacity.
        rolling: windowFixture(20, 2.5, { used: 0.5, cap: 2.5, unit: 'USD' }),
        weekly: windowFixture(45, 30, { used: 4.5, cap: 10, unit: 'USD' }),
        // The monthly percentage is unknown without an API-reported grant, but
        // the dollar capacity can still be known.
        monthly: {
          id: 'monthly',
          percent: null,
          status: 'unknown',
          resetsAt: null,
          remainingMs: null,
          used: 5.5,
          cap: 10,
          unit: 'USD',
        },
      },
      balance: null,
      credits: { remaining: 4.5, granted: 10, purchased: 0 },
      account: { name: '', userName: 'dev@example.com' },
      links: { console: 'https://commandcode.ai/dev%40example.com/settings/usage' },
    }
  }
  return {
    ...common,
    provider: { id: 'opencode-go', label: 'OpenCode', kind: 'windows' },
    plan: { id: 'individual-go-v1', label: 'Go' },
    windows: {
      rolling: windowFixture(2, 2.5),
      weekly: windowFixture(24, 30),
      monthly: windowFixture(32, 9 * 24),
    },
    balance: null,
    credits: null,
    account: null,
    links: { console: 'https://opencode.ai/console' },
  }
}

/** A bucket triple (`today` / `last30Days` / `allTime`). */
function triple(todayTotal, monthTotal, allTotal, messages = {}) {
  return {
    today: bucket({ total: todayTotal, messages: messages.today ?? 0 }),
    last30Days: bucket({ total: monthTotal, messages: messages.month ?? 0 }),
    allTime: bucket({ total: allTotal, messages: messages.all ?? 0 }),
  }
}

/** A cross-harness provider row (stats v3). */
function providerRow(providerId, label, todayTotal, monthTotal, allTotal, harnesses, messages = {}) {
  return { providerId, label, ...triple(todayTotal, monthTotal, allTotal, messages), harnesses }
}

/**
 * A stats payload matching the Host's v3 wire shape (provider-scoped,
 * cross-harness). Numbers follow the live sanity report:
 * DSH 489.2M/2.24B/2.6B, ZCode 48.0M/5.74B/5.74B,
 * combined 537.2M/7.98B/8.34B; opencode-go 489.2M/2.26B/3.14B.
 */
function statsFixture(overrides = {}) {
  const opencodeGo = providerRow('opencode-go', 'OpenCode', 489200000, 2260000000, 3140000000, {
    dsh: triple(489200000, 920000000, 1800000000, { today: 908, month: 5000, all: 12000 }),
    zcode: triple(0, 1340000000, 1340000000, { today: 0, month: 2000, all: 8000 }),
  })
  const commandcode = providerRow('commandcode', 'Command Code', 0, 5656000000, 5136000000, {
    dsh: triple(0, 1320000000, 800000000, { today: 0, month: 600, all: 900 }),
    zcode: triple(0, 4336000000, 4336000000, { today: 0, month: 3000, all: 6000 }),
  })
  return {
    version: 3,
    generatedAt: new Date(Date.now() - 5000).toISOString(),
    timezone: 'Asia/Shanghai',
    day: '2026-10-25',
    last30DaysStart: '2026-09-26',
    // All-harness totals (include ZCode rows that map to no provider row).
    today: bucket({ total: 537214344, messages: 1028 }),
    last30Days: bucket({ total: 7983000000, messages: 11000 }),
    allTime: bucket({ total: 8343000000, messages: 21706 }),
    // Cross-harness provider rows: DSH + mapped ZCode contributions combined.
    providers: [opencodeGo, commandcode],
    harnesses: [
      {
        harnessId: 'dsh',
        label: 'DSH',
        today: bucket({ total: 489200000, messages: 908 }),
        last30Days: bucket({ total: 2240000000, messages: 5600 }),
        allTime: bucket({ total: 2600000000, messages: 12900 }),
      },
      {
        harnessId: 'zcode',
        label: 'ZCode',
        today: bucket({ total: 48014344, messages: 120 }),
        last30Days: bucket({ total: 5743000000, messages: 5000 }),
        allTime: bucket({ total: 5743000000, messages: 8806 }),
        error: null,
      },
    ],
    // DSH-only attribution (providers/models keep the v1 keys, DSH-scoped).
    models: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash',
        today: { total: 300000000, messages: 400 },
        last30Days: { total: 500000000, messages: 900 },
        allTime: { total: 662839698, messages: 1699 },
      },
      {
        key: 'commandcode/Kimi-K3',
        providerId: 'commandcode',
        modelId: 'Kimi-K3',
        today: { total: 0, messages: 0 },
        last30Days: { total: 250000000, messages: 300 },
        allTime: { total: 300000000, messages: 800 },
      },
    ],
    zcode: {
      dbPath: 'C:/Users/x/.zcode/cli/db/db.sqlite',
      available: true,
      error: null,
      rows: 9,
      cached: false,
      providerAliases: { 'opencode-go-chat': 'opencode-go' },
      mappedProviders: [
        providerRow('opencode-go', 'OpenCode', 0, 1340000000, 1340000000, {}),
        providerRow('commandcode', 'Command Code', 0, 4336000000, 4336000000, {}),
      ],
      unmapped: [
        providerRow('bigmodel-start-plan', 'BigModel Start Plan', 48014344, 67000000, 67000000, {}),
      ],
    },
    scan: {
      sessions: 5,
      scanned: 2,
      reused: 3,
      skipped: 0,
      failures: [],
      bytes: 1,
      frames: 2,
      durationMs: 5,
      zcode: { available: true, rows: 9, durationMs: 7, cached: false, error: null },
    },
    ...overrides,
  }
}

/**
 * Providers the Host maps onto an already-configured DSH model-settings route
 * (v0.13.0): `providerId → dshProviderId`. Every other provider is plugin-only.
 */
const DSH_MANAGED_ROUTES = {
  'opencode-go': 'opencode-go/opencode',
  commandcode: 'commandcode',
  deepseek: 'deepseek/deepseek-official',
}

/**
 * One provider entry of the v0.9.0/v0.10.0/v0.13.0 management payload.
 *
 * v0.14.0: the client no longer edits credentials at all, so the fixture carries
 * no apiKey/baseURL fields — only the status hints (`hasKey`/`keySource`) and the
 * DSH route hints (`dshManaged`/`dshProviderId`).
 */
function providerEntry(overrides = {}) {
  const providerId = overrides.providerId ?? 'opencode-go'
  // A DSH-managed entry carries the route id the key + endpoint are inherited
  // from; every other provider is plugin-only and omits the hint as `false`.
  const dshManaged =
    overrides.dshManaged !== undefined
      ? overrides.dshManaged === true
      : Object.prototype.hasOwnProperty.call(DSH_MANAGED_ROUTES, providerId)
  const entry = {
    providerId,
    label: 'OpenCode',
    shortLabel: 'OC',
    kind: 'windows',
    enabled: true,
    hasKey: true,
    keySource: 'env',
    consoleUrl: 'https://opencode.ai/console',
    builtin: true,
    ...overrides,
    dshManaged,
    dshProviderId: dshManaged ? (overrides.dshProviderId ?? DSH_MANAGED_ROUTES[providerId] ?? null) : null,
  }
  // A relabeled fixture keeps a coherent short label unless the test overrides it.
  if (overrides.shortLabel === undefined && overrides.label !== undefined) entry.shortLabel = overrides.label
  return entry
}

/**
 * The v0.15.0 `dshProviders` discovery list: every route registered in the DSH
 * model settings, in registration order. A supported route names the plugin
 * provider it is backed by (`usageProviderId`); a route without a usage adapter
 * has `supported:false` and no `usageProviderId`.
 */
function dshProvidersFixture() {
  return [
    { providerId: 'opencode-go/opencode', label: 'OpenCode Go', supported: true, usageProviderId: 'opencode-go' },
    { providerId: 'commandcode', label: 'Command Code', supported: true, usageProviderId: 'commandcode' },
    {
      providerId: 'deepseek/deepseek-official',
      label: 'DeepSeek Official',
      supported: true,
      usageProviderId: 'deepseek',
    },
    // DSH-configured routes with no usage adapter yet: read-only muted rows.
    { providerId: 'anthropic/claude', label: 'Anthropic', supported: false, usageProviderId: null },
    { providerId: 'zai', label: 'Z.ai', supported: false, usageProviderId: null },
  ]
}

/** The v0.10.0 `{action:'providers'}` payload: every shipped provider, mixed states. */
function providersFixture(overrides = {}) {
  return {
    ok: true,
    settings: {
      labelStyle: 'short',
      defaultView: 'chart',
      defaultScope: 'provider',
      detailsExpanded: 'auto',
    },
    storeFile: 'C:/Users/x/.dsh/dsh-tokenlens/providers.json',
    dshProviders: dshProvidersFixture(),
    providers: [
      providerEntry({ subscribed: true }),
      providerEntry({
        providerId: 'commandcode',
        label: 'Command Code',
        shortLabel: 'CC',
        enabled: false,
        hasKey: false,
        keySource: 'none',
        subscribed: false,
        consoleUrl: 'https://commandcode.ai/settings/usage',
      }),
      providerEntry({
        providerId: 'deepseek',
        label: 'DeepSeek',
        shortLabel: 'DS',
        kind: 'balance',
        hasKey: true,
        keySource: 'credentials',
        consoleUrl: 'https://platform.deepseek.com/usage',
      }),
      providerEntry({
        providerId: 'deepseek-account',
        label: 'DeepSeek Account',
        shortLabel: 'DSA',
        kind: 'balance',
        hasKey: true,
        keySource: 'service',
        consoleUrl: '',
      }),
      providerEntry({
        providerId: 'openrouter',
        label: 'OpenRouter',
        shortLabel: 'OR',
        kind: 'balance',
        enabled: true,
        hasKey: false,
        keySource: 'none',
        consoleUrl: 'https://openrouter.ai/settings/credits',
      }),
      providerEntry({
        providerId: 'moonshot',
        label: 'Moonshot Kimi',
        shortLabel: 'MS',
        kind: 'balance',
        enabled: false,
        hasKey: false,
        keySource: 'none',
        consoleUrl: '',
      }),
    ],
    ...overrides,
  }
}

/**
 * One v0.16.0 custom usage-adapter entry as the Host lists it. The wire carries
 * display/credential hints only (no declaration paths), so this fixture is
 * identity + `custom:true`; tests may add a declaration tail to exercise the
 * defensive prefill of a future Host.
 */
function customProviderEntry(overrides = {}) {
  const providerId = overrides.providerId ?? 'my-gw'
  return {
    providerId,
    label: 'My Gateway',
    shortLabel: 'MG',
    kind: 'balance',
    enabled: true,
    hasKey: true,
    keySource: 'env',
    apiKeyRef: `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
    baseURL: 'https://gw.example.com',
    consoleUrl: '',
    builtin: false,
    custom: true,
    dshManaged: false,
    dshProviderId: null,
    note: '',
    ...overrides,
  }
}

/** The providers payload with one custom adapter appended (v0.16.0). */
function providersFixtureWithCustomEntry(entry) {
  const payload = providersFixture()
  payload.providers = [...payload.providers, entry]
  return payload
}

/** The same payload, with the custom adapter's id added to the DSH discovery. */
function providersFixtureWithDshCustom(entry) {
  const payload = providersFixtureWithCustomEntry(entry)
  payload.dshProviders = [
    ...dshProvidersFixture(),
    { providerId: entry.providerId, label: entry.label, supported: true, usageProviderId: entry.providerId },
  ]
  payload.providers = payload.providers.map((provider) =>
    provider.providerId === entry.providerId
      ? { ...provider, dshManaged: true, dshProviderId: entry.providerId }
      : provider,
  )
  return payload
}

/** The default Host handler: provider-aware usage + a healthy stats payload. */
function defaultHandler() {
  return (payload) => {
    if (payload.action === 'hello') {
      return { ok: true, plugin: 'dsh-tokenlens', version: '0.5.0', bridge: '/api/tokenlens', snapshot: snapshotFixture(payload.providerId) }
    }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'settingsUpdate') {
      const base = providersFixture()
      const settings = { ...base.settings, ...payload.settings }
      return providersFixture({ settings })
    }
    if (payload.action === 'providerUpdate') return providersFixture()
    if (payload.action === 'providerTest') return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  }
}

/**
 * Stand up a stub page and load the bundle.
 *
 * @param handler - `(payload) => envelope`; may throw to simulate a transport failure.
 */
function loadPlugin(handler = defaultHandler()) {
  const calls = []
  const intervals = []
  const clearedIntervals = []
  const timeouts = []
  const windowListeners = []
  let registration

  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval: (id) => {
      clearedIntervals.push(id)
    },
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms })
      return timeouts.length
    },
    clearTimeout: () => {},
    addEventListener: (type, fn) => {
      windowListeners.push({ type, fn })
    },
    removeEventListener: (type, fn) => {
      const index = windowListeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (index >= 0) windowListeners.splice(index, 1)
    },
    open: () => ({}),
  }

  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), payload })
    const envelope = await handler(payload)
    // A handler may answer a non-2xx HTTP status, like the Host's error route:
    // `{__httpStatus: 500, __body: {ok:false, error, snapshot}}`.
    if (envelope !== null && typeof envelope === 'object' && Number.isSafeInteger(envelope.__httpStatus)) {
      return { ok: false, status: envelope.__httpStatus, text: async () => JSON.stringify(envelope.__body ?? null) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(envelope) }
  }

  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  const evaluate = new Function('window', source)
  evaluate(window)
  assert.equal(registration?.id, 'dsh-tokenlens', 'the bundle registers the package id')

  const react = stubReact()
  const require = (name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }
  const api = registration.factory(require)
  assert.deepEqual(api.inject, ['slots', 'locale'])

  const registered = []
  const dictionaries = {}
  const effects = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    locale: {
      register: (namespace, dictionary) => {
        dictionaries[namespace] = dictionary
        return () => {}
      },
      bind: () => (key) => key,
      getSnapshot: () => ({ locale: 'zh' }),
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  api.apply(ctx)

  return {
    calls,
    intervals,
    clearedIntervals,
    timeouts,
    dictionaries,
    effects,
    /** Fire one window event registered by the bundle (e.g. `focus`). */
    fireWindowEvent(type, event = undefined) {
      for (const listener of windowListeners.filter((entry) => entry.type === type)) {
        listener.fn(event)
      }
    },
    /** Whether the bundle currently has a listener of one window-event type. */
    hasWindowListener(type) {
      return windowListeners.some((entry) => entry.type === type)
    },
    /** The registered entry for one slot selector. */
    find(predicate) {
      return registered.find((entry) => predicate(entry.options))
    },
    /** The captured zh dictionary rendered through the locale seat's params. */
    t: translatorOf(dictionaries['dsh-tokenlens']?.zh),
    /** Run every effect disposer so timers/listeners do not leak between tests. */
    dispose() {
      for (const disposer of effects) {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          /* disposal must not mask a test failure */
        }
      }
    },
  }
}

/** The composer-dock entry component plus its registered options. */
function dockOf(plugin) {
  const entry = plugin.find((options) => options.name === 'conversation.composer.dock')
  assert.ok(entry, 'the plugin registers a composer-dock entry')
  return entry
}

/** The detail-dialog entry component plus its registered options. */
function dialogOf(plugin) {
  const entry = plugin.find((options) => options.name === 'conversation.input.overlay')
  assert.ok(entry, 'the plugin registers a composer-overlay entry')
  return entry
}

/** Props the dock slot supplies; `useProjection` names the selected provider. */
function chipProps(plugin, providerId) {
  return {
    t: plugin.t,
    sessionId: 'session-1',
    useProjection: () => ({ next: { provider: providerId, model: 'm' } }),
  }
}

/** Render the chip for one provider. */
function renderChip(plugin, providerId) {
  return dockOf(plugin).component(chipProps(plugin, providerId))
}

/** Render the chip, wait for its provider sync to settle and render again. */
async function settleChip(plugin, providerId) {
  renderChip(plugin, providerId)
  await settle()
  return renderChip(plugin, providerId)
}

/** Click the chip's button, opening the dialog. */
function clickChip(plugin, providerId) {
  const tree = renderChip(plugin, providerId)
  const button = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chip')
  assert.ok(button, 'the chip carries a clickable button')
  button.props.onClick()
}

/** Render the dialog, wait for its lazy loads to settle and render again. */
async function settleDialog(plugin, providerId) {
  await settleChip(plugin, providerId)
  clickChip(plugin, providerId)
  const render = () => dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
  render() // first paint: mounts the dialog and starts its lazy usage/stats loads
  await settle()
  return render()
}

/** All recorded bridge actions, in order. */
function actions(plugin) {
  return plugin.calls.map((call) => call.payload.action)
}

/** The footer console-link element of the dialog. */
function consoleLinkOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-console')
}

/** Re-render the dialog from the current store state. */
function renderDialog(plugin) {
  return dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
}

/** The 管理 button of the usage dialog. */
function manageButtonOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-manage')
}

/** The composer-chip brand span. */
function brandOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-brand')
}

/** One pill of the management page's chip-label-style selector (`short` / `full`). */
function labelStyleOptionOf(tree, style) {
  return findElement(tree, (element) => element.props?.['data-label-style'] === style)
}

/** One management section tab (`providers` / `settings`, v0.29.0). */
function manageTabOf(tree, tab) {
  return findElement(tree, (element) => element.props?.['data-manage-tab'] === tab)
}

/** Switch the management section tab; returns the dialog tree after the click. */
function switchManageTab(plugin, tree, tab) {
  const option = manageTabOf(tree, tab)
  assert.ok(option, `the ${tab} management tab is rendered`)
  if (option.props['data-active'] !== 'true') option.props.onClick()
  return renderDialog(plugin)
}

/** Render the management page, then open the 插件设置 tab. */
async function settleSettingsTab(plugin, providerId = 'opencode-go') {
  const tree = await settleManagement(plugin, providerId)
  return switchManageTab(plugin, tree, 'settings')
}

/** One 插件设置 row by its field name (v0.29.0). */
function settingsRowOf(tree, field) {
  return findElement(tree, (element) => element.props?.['data-settings-row'] === field)
}

/** One option of a 插件设置 row. */
function settingOptionOf(tree, field, value) {
  return findElement(
    tree,
    (element) => element.props?.['data-setting'] === field && element.props?.['data-value'] === value,
  )
}

/** The ← 返回 button of the management page. */
function backButtonOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-back')
}

/** Render the dialog, switch to the provider management page and settle the list load. */
async function settleManagement(plugin, providerId = 'opencode-go') {
  const tree = await settleDialog(plugin, providerId)
  const button = manageButtonOf(tree)
  assert.ok(button, 'the usage dialog offers a 管理 button')
  button.props.onClick()
  await settle()
  return renderDialog(plugin)
}

/** One provider card of the management page. */
function providerCardOf(tree, providerId) {
  return findElement(
    tree,
    (element) => element.props?.className === 'dsh-tokenlens-provider-card' && element.props['data-provider'] === providerId,
  )
}

/** Every provider card, in render order. */
function providerCardsOf(tree) {
  return findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-provider-card')
}

/** Expand the editor of one provider; returns the dialog tree after the click. */
function expandProvider(plugin, tree, providerId) {
  const card = providerCardOf(tree, providerId)
  assert.ok(card, `provider ${providerId} is listed`)
  const toggle = findElement(card, (element) => element.props?.className === 'dsh-tokenlens-provider-toggle')
  assert.ok(toggle, `provider ${providerId} has an expand toggle`)
  toggle.props.onClick()
  return renderDialog(plugin)
}

/** An editor input by its data attribute (`data-provider-shortlabel`, `data-provider-consoleurl`, …). */
function providerInputOf(tree, attr, providerId) {
  return findElement(tree, (element) => element.props?.[attr] === providerId)
}

/** The inherited-model-settings note of one DSH-managed provider. */
function inheritedNoteOf(tree, providerId) {
  return findElement(tree, (element) => element.props?.['data-provider-inherited'] === providerId)
}

/** The "no DSH route found" hint of one plugin-only provider (v0.14.0). */
function unmanagedHintOf(tree, providerId) {
  return findElement(tree, (element) => element.props?.['data-provider-unmanaged'] === providerId)
}

/** The primary 「DSH 模型设置中的供应商」 section (v0.15.0). */
function dshSectionOf(tree) {
  return findElement(
    tree,
    (element) => element.props?.className === 'dsh-tokenlens-dsh-section dsh-tokenlens-manage-section',
  )
}

/** The secondary 「插件适配器（DSH 未配置）」 section (v0.15.0). */
function presetSectionOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-preset-section')
}

/** The expand/collapse toggle of the secondary preset section (v0.15.0). */
function presetToggleOf(tree) {
  return findElement(tree, (element) => element.props?.['data-preset-toggle'] === 'true')
}

/** One read-only row of a DSH-only (unsupported) route (v0.15.0). */
function dshUnsupportedRowOf(tree, providerId) {
  return findElement(tree, (element) => element.props?.['data-dsh-route'] === providerId)
}

/** Expand the collapsed preset section; returns the dialog tree after the click. */
function expandPresetSection(plugin, tree) {
  const toggle = presetToggleOf(tree)
  assert.ok(toggle, 'the preset adapter section toggle is rendered')
  toggle.props.onClick()
  return renderDialog(plugin)
}

/** One provider-list filter tab (`configured` / `builtin` / `all`), v0.17.0. */
function providerFilterOf(tree, filter) {
  return findElement(tree, (element) => element.props?.['data-provider-filter'] === filter)
}

/** Switch the provider-list filter; returns the dialog tree after the click. */
function switchProviderFilter(plugin, tree, filter) {
  const tab = providerFilterOf(tree, filter)
  assert.ok(tab, `the ${filter} filter tab is rendered`)
  tab.props.onClick()
  return renderDialog(plugin)
}

/** Render the management page, then switch to the 全部 tab (the union list). */
async function settleManagementAll(plugin, providerId = 'opencode-go') {
  const tree = await settleManagement(plugin, providerId)
  return switchProviderFilter(plugin, tree, 'all')
}

/** Render the management page, then switch to the 内置 tab (built-in presets). */
async function settleManagementBuiltin(plugin, providerId = 'opencode-go') {
  const tree = await settleManagement(plugin, providerId)
  return switchProviderFilter(plugin, tree, 'builtin')
}

/** The 已配置 tab's empty state (v0.17.0), or undefined when configured rows exist. */
function configuredEmptyStateOf(tree) {
  return findElement(tree, (element) => element.props?.['data-filter-empty'] === 'configured')
}

/** The 添加自定义用量适配器 button (v0.16.0). */
function customAddButtonOf(tree) {
  return findElement(tree, (element) => element.props?.['data-custom-add'] === 'true')
}

/** The 「自定义适配器」 section (v0.16.0). */
function customSectionOf(tree) {
  return findElement(
    tree,
    (element) => element.props?.className === 'dsh-tokenlens-custom-section dsh-tokenlens-manage-section',
  )
}

/** The 删除 button of one custom provider's editor (v0.16.0). */
function customDeleteButtonOf(tree, providerId) {
  return findElement(tree, (element) => element.props?.['data-custom-delete'] === providerId)
}

/** Expand the editor of one custom provider card; returns the dialog tree after the click. */
function expandCustomProvider(plugin, tree, providerId) {
  const card = providerCardOf(tree, providerId)
  assert.ok(card, `custom provider ${providerId} is listed`)
  const toggle = findElement(card, (element) => element.props?.className === 'dsh-tokenlens-provider-toggle')
  assert.ok(toggle, `custom provider ${providerId} has an expand toggle`)
  toggle.props.onClick()
  return renderDialog(plugin)
}

/** A button inside the expanded editor of one provider. */
function editorButtonOf(tree, className) {
  return findElement(tree, (element) => element.props?.className === className)
}

/** One entry of `fields` from the last recorded bridge call carrying them. */
function lastCallWith(plugin, action) {
  for (let index = plugin.calls.length - 1; index >= 0; index -= 1) {
    if (plugin.calls[index].payload.action === action) return plugin.calls[index].payload
  }
  return undefined
}

test('the plugin registers the agreed seats and a complete zh/en dictionary', async () => {
  const plugin = loadPlugin()
  try {
    await settle()
    const dock = dockOf(plugin)
    assert.deepEqual(
      { name: dock.options.name, id: dock.options.id, order: dock.options.order, locale: dock.options.locale },
      { name: 'conversation.composer.dock', id: 'tokenlens', order: 5, locale: 'dsh-tokenlens' },
    )
    const dialog = dialogOf(plugin)
    assert.deepEqual(
      { name: dialog.options.name, id: dialog.options.id, order: dialog.options.order, locale: dialog.options.locale },
      {
        name: 'conversation.input.overlay',
        id: 'dsh-tokenlens-dialog',
        order: 3,
        locale: 'dsh-tokenlens',
      },
    )
    const dictionary = plugin.dictionaries['dsh-tokenlens']
    assert.ok(dictionary, 'the locale namespace is registered')
    assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort(), 'zh and en agree on every key')

    const hello = plugin.calls.find((call) => call.payload.action === 'hello')
    assert.ok(hello, 'the client announces itself on activation')
    assert.equal(hello.url, 'api/tokenlens', 'the bridge URL is document-relative')
    assert.equal(typeof hello.payload.origin, 'string')
    assert.equal(typeof hello.payload.primitives, 'number')
    assert.equal(hello.payload.locale, 'zh', 'hello reports the app locale')
    assert.equal(hello.payload.providerId, undefined, 'before a projection is known the Host default is used')
    assert.deepEqual(actions(plugin).includes('snapshot'), true)
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'providers').length,
      1,
      'the controller loads the providers payload once at startup for the persisted chip label style',
    )
  } finally {
    plugin.dispose()
  }
})

test('the chip shows the provider label and the three window percentages', async () => {
  // Regression: the chip used the plan tier "Go" as the provider brand.
  const plugin = loadPlugin()
  try {
    const tree = await settleChip(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.match(text, /OpenCode/, 'the chip brand is the provider name, not the plan tier')
    assert.doesNotMatch(text, /^Go /, 'the plan tier Go must not replace the provider label')
    assert.match(text, /5时 2%/)
    assert.match(text, /周 24%/)
    assert.match(text, /月 32%/)
    const dot = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-dot')
    assert.equal(dot.props['data-level'], 'normal', 'a healthy plan paints a normal dot')
    assert.equal(findElement(tree, (element) => element.props?.['data-composer-stat'] === 'tokenlens') !== undefined, true)

    const snapshots = plugin.calls.filter((call) => call.payload.action === 'snapshot')
    assert.equal(snapshots.length >= 1, true)
    assert.equal(
      snapshots.some((call) => call.payload.providerId === 'opencode-go'),
      true,
      'snapshot calls carry the selected providerId',
    )
    assert.equal(
      plugin.calls.some((call) => call.payload.action === 'hello' && call.payload.providerId === 'opencode-go'),
      true,
      'the hello announcement is refreshed with the selected providerId',
    )
  } finally {
    plugin.dispose()
  }
})

test('a balance provider renders the money instead of percentages', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleChip(plugin, 'deepseek')
    const text = textOf(tree)
    assert.match(text, /DeepSeek/)
    assert.match(text, /¥2\.26/)
    assert.doesNotMatch(text, /5时/)
    const dot = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-dot')
    assert.equal(dot.props['data-level'], 'normal')
  } finally {
    plugin.dispose()
  }
})

test('a provider without a monthly plan renders an em dash for it', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleChip(plugin, 'commandcode')
    const text = textOf(tree)
    assert.match(text, /CC/)
    assert.match(text, /5时 20%/)
    assert.match(text, /周 45%/)
    assert.match(text, /月 —/)
  } finally {
    plugin.dispose()
  }
})

test('switching providers refetches and drops the previous numbers', async () => {
  const plugin = loadPlugin()
  try {
    const first = await settleChip(plugin, 'opencode-go')
    assert.match(textOf(first), /5时 2%/)

    const second = await settleChip(plugin, 'commandcode')
    const text = textOf(second)
    assert.match(text, /CC/)
    assert.match(text, /5时 20%/)
    assert.doesNotMatch(text, /5时 2%/, 'the previous provider snapshot is dropped')
    assert.equal(
      plugin.calls.some((call) => call.payload.action === 'snapshot' && call.payload.providerId === 'commandcode'),
      true,
      'the new provider is requested',
    )
  } finally {
    plugin.dispose()
  }
})

test('unsupported-provider hides the chip silently', async () => {
  const plugin = loadPlugin((payload) =>
    payload.action === 'hello'
      ? { ok: true }
      : {
          ok: false,
          error: { code: 'unsupported-provider', message: 'provider "mystery" has no usage adapter', retryable: false },
          snapshot: null,
        },
  )
  try {
    const tree = await settleChip(plugin, 'mystery')
    assert.equal(tree, null, 'the chip is hidden for unsupported-provider')
    assert.equal(
      plugin.calls.some((call) => call.payload.providerId === 'mystery'),
      true,
      'the provider was still reported to the Host',
    )
  } finally {
    plugin.dispose()
  }
})

test('missing-key and disabled hide the chip as well', async () => {
  for (const code of ['missing-key', 'disabled']) {
    const plugin = loadPlugin((payload) =>
      payload.action === 'hello'
        ? { ok: true }
        : { ok: false, error: { code, message: code, retryable: false }, snapshot: null },
    )
    try {
      const tree = await settleChip(plugin, 'opencode-go')
      assert.equal(tree, null, `the chip is hidden for ${code}`)
    } finally {
      plugin.dispose()
    }
  }
})

test('the dialog lists windows, plan header and today/all-time token statistics', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.doesNotMatch(text, /is not defined/, 'no identifier leaks from a builder')
    assert.match(text, /OpenCode/, 'the dialog title is the provider label')
    assert.match(text, /套餐：Go/, 'the plan header comes from the snapshot')
    assert.match(text, /5 小时/)
    assert.match(text, /本周/)
    assert.match(text, /本月/)
    assert.match(text, /2%/)
    assert.match(text, /24%/)
    assert.match(text, /32%/)
    assert.match(text, /2 小时 30 分后重置/)
    assert.match(text, /1 天 6 小时后重置/)
    assert.match(text, /9 天后重置/)
    assert.match(text, /上次更新：/)
    // The dialog is two explicitly labelled sections: provider-side capacity and
    // machine-local DSH + ZCode session records.
    assert.match(text, /套餐容量/)
    assert.match(text, /数据来自供应商接口（服务端权威）/)
    assert.match(text, /本机 Token 用量/)
    assert.match(text, /本机各 Harness 记录/)
    assert.match(text, /DSH \+ ZCode/)
    assert.match(text, /全部 Harness/)
    assert.match(text, /当前供应商 · 全部 Harness/)
    // OpenCode reports percentages only: no provider-native money line.
    assert.doesNotMatch(text, /\$/, 'no dollar capacity for OpenCode')

    const rows = findAll(tree, (element) => element.props?.['data-window'] !== undefined)
    assert.deepEqual(
      rows.map((row) => row.props['data-window']),
      ['rolling', 'weekly', 'monthly'],
    )
    const fills = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-bar-fill')
    assert.deepEqual(
      fills.map((fill) => [fill.props['data-level'], fill.props.style.width]),
      [
        ['normal', '2%'],
        ['normal', '24%'],
        ['normal', '32%'],
      ],
    )

    // Token statistics: lazily loaded when the dialog opened. The default scope
    // is PROVIDER-SCOPED ACROSS HARNESSES: opencode-go tokens from DSH + ZCode.
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'stats').length,
      1,
      'the dialog loads stats on open (and not before)',
    )
    assert.ok(
      plugin.calls.findIndex((call) => call.payload.action === 'stats') >
        plugin.calls.findIndex((call) => call.payload.action === 'snapshot'),
      'stats load after usage',
    )
    assert.match(text, /本机 Token 用量/)
    assert.match(text, /今日/)
    assert.match(text, /最近30天/)
    assert.match(text, /总计/)
    const cardsOf = (node) =>
      findAll(node, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    const providerCards = cardsOf(tree)
    assert.equal(providerCards.length, 3, 'three time-window cards')
    assert.match(providerCards[0], /489\.200M/, 'provider-scope today across harnesses')
    assert.match(providerCards[1], /2\.260B/, 'provider-scope last 30 days across harnesses')
    assert.match(providerCards[2], /3\.140B/, 'provider-scope all-time across harnesses')
    assert.match(text, /当前供应商 · 全部 Harness：OpenCode/, 'the cards are captioned by provider scope')

    // Harness breakdown reflects the provider scope: DSH + ZCode contributions
    // to THIS provider row (three windows each).
    const harnessRows = findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
    assert.deepEqual(
      harnessRows.map((row) => row.props['data-harness']),
      ['dsh', 'zcode'],
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '489.200M'], ['最近30天', '920.000M'], ['总计', '1.800B']],
      'DSH contribution within the provider row',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'ZCode'),
      [['今日', '0'], ['最近30天', '1.340B'], ['总计', '1.340B']],
      'ZCode contribution within the provider row',
    )
    assert.match(text, /按 Harness/)
    assert.match(text, /DSH 按供应商/)
    assert.match(text, /DSH Top 模型/)
    // v0.22.1: this fixture has no subscription, so provider scope keeps the
    // fixed 30-day model column.
    assert.deepEqual(
      detailsRowCellsOf(tree, 'deepseek-v4.1-flash'),
      [['今日', '300.000M'], ['最近30天', '500.000M'], ['总计', '662.840M']],
      'top models keep the 30-day column without a subscription',
    )
    assert.doesNotMatch(text, /BigModel Start Plan/, 'unmapped ZCode providers do not enter provider scope')

    // Switch to 全部 Harness: all-harness cards, harness rows, unmapped ZCode note.
    const providerTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'provider',
    )
    assert.equal(providerTab.props['data-active'], 'true', 'provider scope is the default')
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    const allText = textOf(allTree)
    const allCards = cardsOf(allTree)
    assert.match(allCards[0], /537\.214M/, 'all-harness today total')
    assert.match(allCards[1], /7\.983B/, 'all-harness last-30-day total')
    assert.match(allCards[2], /8\.343B/, 'all-harness all-time total')
    assert.match(allText, /全部 Harness 合计/)
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'DSH'),
      [['今日', '489.200M'], ['最近30天', '2.240B'], ['总计', '2.600B']],
      'all-harness DSH row',
    )
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'ZCode'),
      [['今日', '48.014M'], ['最近30天', '5.743B'], ['总计', '5.743B']],
      'all-harness ZCode row',
    )
    assert.match(allText, /未归属到 DSH 供应商的本机用量/, 'the generalised unmapped note appears in all-harness scope')
    assert.match(allText, /BigModel Start Plan/)
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'BigModel Start Plan'),
      [['今日', '48.014M'], ['最近30天', '67.000M'], ['总计', '67.000M']],
    )
    assert.match(allText, /仅计入全部 Harness 合计/)

    // DSH provider breakdown rows also show the three windows.
    assert.deepEqual(
      detailsRowCellsOf(tree, 'OpenCode'),
      [['今日', '489.200M'], ['最近30天', '2.260B'], ['总计', '3.140B']],
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'Command Code'),
      [['今日', '0'], ['最近30天', '5.656B'], ['总计', '5.136B']],
    )
    assert.match(text, /输入/)
    assert.match(text, /输出/)
    assert.match(text, /缓存读/)
    const providerColumn = detailsBlockOf(tree, 'providers')
    const breakdown = findAll(
      providerColumn,
      (element) => (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-details-table-row'),
    )
    assert.deepEqual(
      breakdown.map((row) => textOf(row).includes('OpenCode')),
      [true, false],
    )
    assert.match(text, /deepseek-v4\.1-flash/, 'top models are listed')
    assert.match(text, /插件 v0\.5\.0/, 'the plugin version comes from the hello envelope')
    assert.ok(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-console'))
    assert.ok(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-refresh'))
  } finally {
    plugin.dispose()
  }
})

test('a command code dialog shows the dollar capacity, credits and the null monthly percent', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDialog(plugin, 'commandcode')
    const text = textOf(tree)
    assert.match(text, /Command Code/)
    assert.match(text, /套餐：Beginner/)
    assert.match(text, /账户：dev@example\.com/)
    assert.match(text, /剩余 \$4\.50/)
    assert.match(text, /本月额度 \$10\.00/)
    assert.match(text, /加购 \$0\.00/)
    // Command Code is the provider that sizes its windows in dollars.
    assert.match(text, /\$0\.50 \/ \$2\.50/)
    assert.match(text, /\$4\.50 \/ \$10\.00/)
    assert.match(text, /\$5\.50 \/ \$10\.00/)
    const money = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-capacity-money')
    assert.equal(money.length, 3, 'each sized window carries its dollar capacity')
    const percents = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-percent')
    assert.equal(percents.length, 3)
    assert.deepEqual(
      percents.map((element) => element.props['data-level']),
      ['normal', 'normal', 'unknown'],
    )
    assert.equal(text.includes('—'), true, 'the missing monthly percent renders as a dash')
  } finally {
    plugin.dispose()
  }
})

test('a balance provider dialog shows a balance card instead of window rows', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'deepseek')
    const text = textOf(tree)
    assert.match(text, /DeepSeek/)
    assert.match(text, /账户余额/)
    assert.match(text, /¥2\.26/)
    assert.match(text, /充值 ¥2\.26/)
    assert.equal(findAll(tree, (element) => element.props?.['data-window'] !== undefined).length, 0, 'no window rows')
    assert.ok(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-balance'))
    assert.match(text, /套餐容量/, 'the capacity section stays for balance providers')
    assert.match(text, /本机 Token 用量/, 'the local-usage section stays for balance providers')
    // This provider has no stats row, so the provider scope falls back to the
    // all-harness totals and says so.
    const cards = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.equal(cards.length, 3)
    assert.match(cards[0], /537\.214M/, 'the provider scope falls back to the all-harness totals')
    assert.match(text, /当前供应商（DeepSeek）没有本机记录/)
    const providerTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'provider',
    )
    assert.equal(providerTab.props['data-active'], 'true')
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    const allCards = findAll(allTree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.match(allCards[2], /8\.343B/)
    assert.match(textOf(allTree), /全部 Harness 合计/)
  } finally {
    plugin.dispose()
  }
})

test('a platform-account balance lists wallets and bonus', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    return { ok: true, snapshot: snapshotFixture('deepseek-account') }
  })
  try {
    const tree = await settleDialog(plugin, 'deepseek-account')
    const text = textOf(tree)
    assert.match(text, /DeepSeek Account/)
    assert.match(text, /账户余额/)
    assert.match(text, /¥12\.50/)
    assert.match(text, /钱包：¥12\.50 · \$0\.50/)
    assert.match(text, /奖励：¥2\.00/)
  } finally {
    plugin.dispose()
  }
})

test('the footer console link follows the selected provider', async () => {
  // OpenCode: the provider console.
  {
    const plugin = loadPlugin()
    try {
      const tree = await settleDialog(plugin, 'opencode-go')
      const link = consoleLinkOf(tree)
      assert.equal(link.props.href, 'https://opencode.ai/console')
      assert.equal(link.props.target, '_blank')
      assert.equal(link.props['aria-label'], '打开 OpenCode 控制台')
      assert.match(textOf(link), /打开 OpenCode 控制台/)
    } finally {
      plugin.dispose()
    }
  }
  // Command Code: the account's usage page from snapshot.links.console.
  {
    const plugin = loadPlugin()
    try {
      const tree = await settleDialog(plugin, 'commandcode')
      const link = consoleLinkOf(tree)
      assert.equal(link.props.href, 'https://commandcode.ai/dev%40example.com/settings/usage')
      assert.equal(link.props['aria-label'], '打开 Command Code 用量页')
      assert.match(textOf(link), /打开 Command Code 用量页/)
    } finally {
      plugin.dispose()
    }
  }
  // DeepSeek: the platform page.
  {
    const plugin = loadPlugin()
    try {
      const tree = await settleDialog(plugin, 'deepseek')
      const link = consoleLinkOf(tree)
      assert.equal(link.props.href, 'https://platform.deepseek.com/usage')
      assert.match(textOf(link), /打开 DeepSeek 平台/)
    } finally {
      plugin.dispose()
    }
  }
})

test('the console link falls back when links are missing or junk', async () => {
  // Old payload / v2 Host: no `links` at all → legacy opencode console URL,
  // while the label still follows the provider.
  {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      const snapshot = snapshotFixture(payload.providerId)
      const { links, ...withoutLinks } = snapshot
      return { ok: true, snapshot: withoutLinks }
    })
    try {
      const tree = await settleDialog(plugin, 'opencode-go')
      const link = consoleLinkOf(tree)
      assert.equal(link.props.href, 'https://opencode.ai/console')
      assert.match(textOf(link), /打开 OpenCode 控制台/)
    } finally {
      plugin.dispose()
    }
  }
  // Junk links (non-http URL shapes) must never become the anchor href.
  for (const junk of ['javascript:alert(1)', 'not-a-url', 42, null]) {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      return { ok: true, snapshot: { ...snapshotFixture(payload.providerId), links: { console: junk } } }
    })
    try {
      const tree = await settleDialog(plugin, 'deepseek')
      const link = consoleLinkOf(tree)
      assert.equal(link.props.href, 'https://opencode.ai/console', `junk ${JSON.stringify(junk)} falls back`)
      assert.match(textOf(link), /打开 DeepSeek 平台/)
    } finally {
      plugin.dispose()
    }
  }
})

test('switching providers updates the console link', async () => {
  const plugin = loadPlugin()
  try {
    const first = await settleDialog(plugin, 'opencode-go')
    assert.equal(consoleLinkOf(first).props.href, 'https://opencode.ai/console')

    // The provider switch replaces the snapshot; the open dialog re-renders with
    // the new href/label.
    await settleChip(plugin, 'commandcode')
    await settle()
    const switched = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    const link = consoleLinkOf(switched)
    assert.equal(link.props.href, 'https://commandcode.ai/dev%40example.com/settings/usage')
    assert.match(textOf(link), /打开 Command Code 用量页/)

    await settleChip(plugin, 'deepseek')
    await settle()
    const platform = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.equal(consoleLinkOf(platform).props.href, 'https://platform.deepseek.com/usage')
    assert.match(textOf(consoleLinkOf(platform)), /打开 DeepSeek 平台/)
  } finally {
    plugin.dispose()
  }
})

test('a picker alias reuses the canonical provider snapshot', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    // The Host answers the default (unreported) provider request with the
    // canonical `deepseek` snapshot, while the picker will report
    // `deepseek-official` (the verified alias).
    return { ok: true, snapshot: snapshotFixture('deepseek') }
  })
  try {
    await settle() // the apply-time default snapshot is on screen before the chip mounts
    const tree = await settleChip(plugin, 'deepseek-official')
    assert.match(textOf(tree), /¥2\.26/)
    assert.equal(
      plugin.calls.some(
        (call) => call.payload.action === 'snapshot' && call.payload.providerId === 'deepseek-official',
      ),
      false,
      'the canonical snapshot is reused instead of refetching the alias',
    )
  } finally {
    plugin.dispose()
  }
})

test('a stats failure shows its own banner without hiding the usage content', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') {
      return { ok: false, error: { code: 'stats-unavailable', message: 'token statistics are disabled', retryable: false } }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.match(text, /5 小时/, 'the usage rows are still rendered')
    assert.match(text, /2 小时 30 分后重置/)
    assert.match(text, /Token 统计不可用/, 'the stats failure has its own banner')
    assert.match(text, /token statistics are disabled/)
    assert.equal(findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').length, 0)
  } finally {
    plugin.dispose()
  }
})

test('a ZCode failure keeps the provider (DSH) rows and marks ZCode unavailable', async () => {
  const zcodeError = {
    code: 'stats-unavailable',
    message: 'ZCode database unavailable: no such file or directory',
    retryable: true,
  }
  const dshOnly = statsFixture()
  const failingStats = statsFixture({
    today: bucket({ total: 489200000, messages: 908 }),
    last30Days: bucket({ total: 2240000000, messages: 5600 }),
    allTime: bucket({ total: 2600000000, messages: 12900 }),
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        ...triple(489200000, 920000000, 1800000000),
        harnesses: { dsh: triple(489200000, 920000000, 1800000000) },
      },
    ],
    harnesses: [
      {
        harnessId: 'dsh',
        label: 'DSH',
        today: bucket({ total: 489200000, messages: 908 }),
        last30Days: bucket({ total: 2240000000, messages: 5600 }),
        allTime: bucket({ total: 2600000000, messages: 12900 }),
      },
      {
        harnessId: 'zcode',
        label: 'ZCode',
        today: bucket(),
        last30Days: bucket(),
        allTime: bucket(),
        error: zcodeError,
      },
    ],
    zcode: { dbPath: 'C:/Users/x/.zcode/cli/db/db.sqlite', available: false, error: zcodeError, mappedProviders: [], unmapped: [], rows: null, cached: false },
    models: dshOnly.models,
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true, version: '0.5.0' }
    if (payload.action === 'stats') return { ok: true, stats: failingStats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.doesNotMatch(text, /is not defined/)
    // Provider scope still shows the DSH side of the opencode-go row.
    const cards = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.match(cards[0], /489\.200M/, 'the provider cards still use the DSH contribution')
    assert.match(cards[1], /920\.000M/)
    assert.match(cards[2], /1\.800B/)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '489.200M'], ['最近30天', '920.000M'], ['总计', '1.800B']],
      'the DSH harness row still renders',
    )
    assert.doesNotMatch(text, /5\.74B/, 'no stale ZCode totals')
    const rows = findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
    assert.deepEqual(
      rows.map((row) => row.props['data-harness']),
      ['dsh'],
      'provider scope only lists harnesses with last-30-day usage',
    )
    // Switching to all-harness scope still surfaces the failing harness.
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    const allText = textOf(allTree)
    assert.match(allText, /不可用/, 'the failing harness is visible in all-harness scope')
    assert.match(allText, /检查本机 Harness 数据源后点刷新重试/, 'and carries the retry hint')
    // A failing harness is one full-width colspan row inside the harness table.
    const errorRow = findElement(allTree, (element) => element.props?.['data-harness'] === 'zcode')
    assert.ok(errorRow, 'the failing harness row renders')
    assert.equal(errorRow.props.className.includes('dsh-tokenlens-harness-error-row'), true)
    const errorCell = findElement(errorRow, (element) => element.type === 'td')
    assert.equal(errorCell.type, 'td')
    assert.ok(errorCell.props.colSpan >= 2, 'the error row spans the whole table')
  } finally {
    plugin.dispose()
  }
})

test('a ZCode-only provider row keeps DSH muted in the provider harness breakdown', async () => {
  const base = statsFixture()
  const zcodeOnly = {
    providerId: 'bigmodel-start-plan',
    label: 'BigModel Start Plan',
    ...triple(10000000, 20000000, 20000000),
    harnesses: { zcode: triple(10000000, 20000000, 20000000) },
  }
  const stats = statsFixture({ providers: [...base.providers, zcodeOnly] })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'bigmodel-start-plan')
    const text = textOf(tree)
    const cards = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.match(cards[0], /10\.000M/, 'provider-scope cards use the ZCode-only row')
    assert.match(cards[1], /20\.000M/)
    assert.match(cards[2], /20\.000M/)
    assert.match(text, /当前供应商 · 全部 Harness：BigModel Start Plan/)
    assert.equal(
      findElement(tree, (element) => element.props?.['data-harness'] === 'dsh'),
      undefined,
      'DSH has no usage in the last 30 days, so its row is hidden',
)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'ZCode'),
      [['今日', '10.000M'], ['最近30天', '20.000M'], ['总计', '20.000M']],
    )
    assert.doesNotMatch(text, /未归属到 DSH 供应商/, 'unmapped providers are not part of provider scope')
  } finally {
    plugin.dispose()
  }
})

test('an arbitrary harness list renders in Host order with labels and totals', async () => {
  const harnesses = [
    { harnessId: 'dsh', label: 'DSH', today: bucket({ total: 500000000 }), last30Days: bucket({ total: 2000000000 }), allTime: bucket({ total: 2500000000, messages: 12000 }) },
    { harnessId: 'zcode', label: 'ZCode', today: bucket({ total: 48000000 }), last30Days: bucket({ total: 5743000000 }), allTime: bucket({ total: 5743000000, messages: 8806 }) },
    { harnessId: 'opencode', label: 'OpenCode CLI', today: bucket({ total: 12000000 }), last30Days: bucket({ total: 300000000 }), allTime: bucket({ total: 400000000, messages: 1200 }) },
    { harnessId: 'codex', label: 'Codex', today: bucket({ total: 1000000 }), last30Days: bucket({ total: 50000000 }), allTime: bucket({ total: 60000000, messages: 120 }) },
  ]
  const opencodeGo = {
    providerId: 'opencode-go',
    label: 'OpenCode',
    ...triple(489200000, 2260000000, 3140000000),
    harnesses: {
      dsh: triple(489200000, 920000000, 1800000000),
      zcode: triple(0, 1340000000, 1340000000),
      opencode: triple(12000000, 300000000, 400000000),
    },
  }
  const stats = statsFixture({ harnesses, providers: [opencodeGo] })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.match(text, /DSH \+ ZCode \+ OpenCode CLI \+ Codex/, 'the subtitle lists the active harness labels')
    const rows = findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
    assert.deepEqual(
      rows.map((row) => row.props['data-harness']),
      ['dsh', 'zcode', 'opencode'],
      'provider scope keeps the Host order but drops harnesses without last-30-day usage',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'OpenCode CLI'),
      [['今日', '12.000M'], ['最近30天', '300.000M'], ['总计', '400.000M']],
      'a non-DSH/ZCode provider split renders',
    )

    // The all-harness scope shows every harness total (including those without a
    // provider split) in the same Host order.
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'Codex'),
      [['今日', '1.000M'], ['最近30天', '50.000M'], ['总计', '60.000M']],
      'the Codex row shows its totals in all-harness scope',
    )
    assert.deepEqual(
      findAll(allTree, (element) => element.props?.['data-harness'] !== undefined).map(
        (row) => row.props['data-harness'],
      ),
      ['dsh', 'zcode', 'opencode', 'codex'],
    )
  } finally {
    plugin.dispose()
  }
})

test('an unknown harness id falls back to the raw id as its label', async () => {
  const base = statsFixture()
  const harnesses = [
    { harnessId: 'weird-agent', today: bucket({ total: 5000000 }), last30Days: bucket({ total: 15000000 }), allTime: bucket({ total: 20000000, messages: 5 }) },
    { harnessId: 'dsh', label: 'DSH', today: bucket({ total: 1000000 }), last30Days: bucket({ total: 5000000 }), allTime: bucket({ total: 10000000 }) },
  ]
  const provider = {
    providerId: 'opencode-go',
    label: 'OpenCode',
    ...triple(489200000, 2260000000, 3140000000),
    harnesses: { dsh: triple(489200000, 920000000, 1800000000), 'weird-agent': triple(5000000, 15000000, 20000000) },
  }
  const stats = statsFixture({ harnesses, providers: [provider] })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.match(text, /weird-agent \+ DSH/, 'the raw id is used when the wire has no label')
    const weirdRow = findElement(tree, (element) => element.props?.['data-harness'] === 'weird-agent')
    assert.ok(weirdRow, 'the unknown harness renders a row')
    assert.match(textOf(weirdRow), /weird-agent/)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'weird-agent'),
      [['今日', '5.000M'], ['最近30天', '15.000M'], ['总计', '20.000M']],
      'its provider split renders too',
    )
  } finally {
    plugin.dispose()
  }
})

test('a provider with no last-30-day harness usage shows the empty hint', async () => {
  const provider = {
    providerId: 'commandcode',
    label: 'Command Code',
    ...triple(0, 0, 1000),
    harnesses: {},
  }
  const stats = statsFixture({ providers: [provider] })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'commandcode')
    assert.match(
      textOf(tree),
      /该供应商最近 30 天在本机各 Harness 没有用量/,
      'the empty provider breakdown explains why no harness rows render',
    )
  } finally {
    plugin.dispose()
  }
})

test('a per-harness error row stays muted while the other harnesses render', async () => {
  const harnesses = [
    { harnessId: 'dsh', label: 'DSH', today: bucket({ total: 500000000 }), last30Days: bucket({ total: 2000000000 }), allTime: bucket({ total: 2500000000, messages: 12000 }) },
    {
      harnessId: 'opencode',
      label: 'OpenCode CLI',
      today: bucket(),
      last30Days: bucket(),
      allTime: bucket(),
      error: { code: 'stats-unavailable', message: 'OpenCode CLI database unavailable', retryable: true },
    },
  ]
  const stats = statsFixture({
    harnesses,
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        ...triple(489200000, 2260000000, 3140000000),
        harnesses: { dsh: triple(489200000, 920000000, 1800000000) },
      },
    ],
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '489.200M'], ['最近30天', '920.000M'], ['总计', '1.800B']],
      'the healthy harness still renders',
    )
    assert.equal(
      findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
        .map((row) => row.props['data-harness'])
        .join(","),
      'dsh',
      'the failing harness has no 30-day usage and is hidden in provider scope',
    )
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.match(textOf(allTree), /不可用/, 'the failing harness is muted in all-harness scope')
    assert.match(textOf(allTree), /检查本机 Harness 数据源后点刷新重试/, 'and carries the generic retry hint')
  } finally {
    plugin.dispose()
  }
})

test('an older stats payload without last30Days falls back to two cards', async () => {
  const legacy = {
    version: 2,
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    day: '2026-10-25',
    today: bucket({ total: 268488264, messages: 810 }),
    allTime: bucket({ total: 2984370940, messages: 7841 }),
    // v2 DSH-only provider rows: no last30Days, no harness splits.
    providers: [{ providerId: 'opencode-go', label: 'OpenCode', today: bucket({ total: 200000000, messages: 600 }), allTime: bucket({ total: 2000000000, messages: 6000 }) }],
    harnesses: [
      { harnessId: 'dsh', label: 'DSH', today: bucket({ total: 268488264, messages: 810 }), allTime: bucket({ total: 2984370940, messages: 7841 }) },
    ],
    models: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash',
        today: { total: 120000000, messages: 400 },
        allTime: { total: 662839698, messages: 1699 },
      },
    ],
    scan: { sessions: 1, scanned: 1, reused: 0, skipped: 0, failures: [], bytes: 1, frames: 1, durationMs: 1 },
  }
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: legacy }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.doesNotMatch(text, /is not defined/)
    const cards = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.equal(cards.length, 2, 'only 今日 / 总计 are rendered without last30Days data')
    assert.match(cards[0], /200\.000M/, 'provider-scope today total')
    assert.match(cards[1], /2\.000B/, 'provider-scope total')
    assert.doesNotMatch(text, /最近30天/, 'no empty 30-day column is shown')
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '200.000M'], ['总计', '2.000B']],
      'provider-scope harness rows fall back to two windows',
    )
    const rows = findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
    assert.deepEqual(
      rows.map((row) => row.props['data-harness']),
      ['dsh'],
      'the harness list is whatever the Host sent: no invented ZCode row',
    )
    assert.equal(
      findElement(tree, (element) => element.props?.['data-harness'] === 'zcode'),
      undefined,
    )
    // The all-harness scope still renders the legacy combined totals.
    const allTab = findElement(
      tree,
      (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === 'all',
    )
    allTab.props.onClick()
    const allTree = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'DSH'),
      [['今日', '268.488M'], ['总计', '2.984B']],
    )
  } finally {
    plugin.dispose()
  }
})

test('local token numbers always show exactly three decimals once scaled', async () => {
  // 812 stays a plain integer; 448,902,000 → 448.902M; 2,882,000,000 → 2.882B;
  // trailing zeros are kept (3,000,000,000 → 3.000B). The old compact style
  // (2.88B / 448.9M / 3B) must never leak back into the token section.
  const stats = statsFixture({
    today: bucket({ total: 448902000, messages: 908 }),
    last30Days: bucket({ total: 2882000000, messages: 5600 }),
    allTime: bucket({ total: 812, messages: 12 }),
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 448902000, messages: 908 }),
        last30Days: bucket({ total: 2882000000, messages: 5600 }),
        allTime: bucket({ total: 812, messages: 12 }),
        harnesses: {
          dsh: {
            today: bucket({ total: 448902000 }),
            last30Days: bucket({ total: 2882000000 }),
            allTime: bucket({ total: 812 }),
          },
        },
      },
    ],
    models: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash',
        today: { total: 3000000000, messages: 1 },
        last30Days: { total: 3000000000, messages: 1 },
        allTime: { total: 3000000000, messages: 1 },
      },
    ],
    zcode: null,
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    const cards = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
    assert.equal(cards.length, 3)
    assert.match(cards[0], /今日448\.902M/, 'the today total carries three decimals')
    assert.match(cards[1], /最近30天2\.882B/, 'the 30-day total scales to B with three decimals')
    assert.match(cards[2], /总计812/, 'values below 1000 stay plain integers')
    // 按 Harness / 按供应商 / Top 模型 rows share the same precise formatter.
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '448.902M'], ['最近30天', '2.882B'], ['总计', '812']],
      'the harness row uses precise token numbers',
    )
    assert.match(text, /3\.000B/, 'trailing zeros are kept')
    assert.doesNotMatch(text, /2\.88B(?![0-9])/, 'no old two-decimal token string leaks')
    assert.doesNotMatch(text, /448\.9M(?![0-9])/, 'no old one-decimal token string leaks')
    assert.doesNotMatch(text, /3B(?![0-9])/, 'no old zero-decimal token string leaks')
  } finally {
    plugin.dispose()
  }
})

test('a failed usage read shows a warning chip and the retry recovers', async () => {
  let failing = true
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (failing) {
      return { ok: false, error: { code: 'network', message: 'upstream unreachable', retryable: true }, snapshot: null }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const chipTree = await settleChip(plugin, 'opencode-go')
    assert.ok(chipTree, 'a non-silent failure keeps a warning chip')
    const dot = findElement(chipTree, (element) => element.props?.className === 'dsh-tokenlens-dot')
    assert.equal(dot.props['data-level'], 'warning')
    assert.match(textOf(chipTree), /用量读取失败/)

    clickChip(plugin, 'opencode-go')
    const render = () => dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    render()
    await settle()
    const errorTree = render()
    const errorText = textOf(errorTree)
    assert.match(errorText, /无法连接用量服务/)
    assert.match(errorText, /upstream unreachable/, 'the Host message is shown as the detail line')
    assert.equal(
      findAll(errorTree, (element) => element.props?.className === 'dsh-tokenlens-banner').length,
      2,
      'usage and stats carry independent error banners',
    )

    const retry = findElement(errorTree, (element) => element.props?.className === 'dsh-tokenlens-retry')
    assert.ok(retry, 'the usage banner carries a retry action')
    failing = false
    retry.props.onClick()
    await settle()
    const recoveredTree = render()
    const recovered = textOf(recoveredTree)
    assert.match(recovered, /2 小时 30 分后重置/, 'the usage rows are back')
    assert.equal(
      findAll(recoveredTree, (element) => element.props?.className === 'dsh-tokenlens-banner').length,
      1,
      'the usage banner cleared while the independent stats banner remains',
    )
  } finally {
    plugin.dispose()
  }
})

test('the refresh button refreshes usage and forces a fresh stats scan', async () => {
  const plugin = loadPlugin()
  try {
    renderChip(plugin, 'opencode-go')
    await settle()
    const tree = await settleDialog(plugin, 'opencode-go')
    const refresh = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-refresh')
    assert.ok(refresh, 'the dialog carries a refresh button')
    refresh.props.onClick()
    await settle()
    assert.equal(plugin.calls.some((call) => call.payload.action === 'refresh'), true, 'usage is force-refreshed')
    assert.equal(
      plugin.calls.some((call) => call.payload.action === 'stats' && call.payload.fresh === true),
      true,
      'stats are force-refreshed',
    )
  } finally {
    plugin.dispose()
  }
})

test('a hidden page does not poll until visibilitychange says it is visible', async (t) => {
  const listeners = []
  globalThis.document = {
    visibilityState: 'hidden',
    addEventListener: (type, fn) => {
      if (type === 'visibilitychange') listeners.push(fn)
    },
    removeEventListener: () => {},
  }
  try {
    const plugin = loadPlugin()
    t.after(() => plugin.dispose())
    await settle()
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'snapshot').length,
      0,
      'no snapshot while the page is hidden',
    )

    globalThis.document.visibilityState = 'visible'
    for (const listener of listeners) listener()
    await settle()
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'snapshot').length,
      1,
      'becoming visible catches up immediately',
    )
    assert.equal(plugin.intervals.length, 1, 'a 60s poll interval is installed')
    assert.equal(plugin.intervals[0].ms, 60000)
  } finally {
    delete globalThis.document
  }
})

test('hostile snapshots and stats render without throwing', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') {
      return {
        ok: true,
        stats: {
          version: 3,
          today: 'nonsense',
          last30Days: 'x',
          allTime: null,
          last30DaysStart: 5,
          harnesses: [null, { harnessId: 7, today: 'x', last30Days: {}, providers: [null, 5] }],
          zcode: 'n/a',
          providers: [null, {}],
          models: [{ key: null }],
          generatedAt: 5,
        },
      }
    }
    return {
      ok: true,
      snapshot: { version: 2, provider: {}, plan: null, windows: { rolling: null }, balance: 7, credits: 'x' },
    }
  })
  try {
    const chipTree = await settleChip(plugin, 'opencode-go')
    assert.ok(chipTree, 'a hostile snapshot still renders a chip')
    assert.match(textOf(chipTree), /暂无用量/)

    clickChip(plugin, 'opencode-go')
    const render = () => dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    render()
    await settle()
    const tree = render()
    const text = textOf(tree)
    assert.doesNotMatch(text, /is not defined/)
    assert.doesNotMatch(text, /undefined/)
    assert.match(text, /本机 Token 用量/)
    assert.equal(text.includes('—'), true)
    assert.match(text, /套餐容量/)
  } finally {
    plugin.dispose()
  }
})

test('the plugin version line is omitted when the Host does not report one', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDialog(plugin, 'opencode-go')
    assert.doesNotMatch(textOf(tree), /插件 v/)
  } finally {
    plugin.dispose()
  }
})

test('the dialog entry renders nothing while closed and never throws', () => {
  const plugin = loadPlugin()
  try {
    const chip = dockOf(plugin).component
    const dialog = dialogOf(plugin).component
    assert.equal(chip({ t: plugin.t }), null, 'no data yet: the chip stays silent')
    assert.equal(dialog({ sessionId: 'session-1', t: plugin.t }), null, 'a closed dialog renders nothing')
    // The degraded path itself must be renderable: no props at all.
    assert.doesNotThrow(() => chip({}))
    assert.doesNotThrow(() => dialog({}))
    assert.equal(chip({}), null)
    assert.equal(dialog({}), null)
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Provider management page (v0.9.0).
// ---------------------------------------------------------------------------

test('the management page opens from the dialog header, loads providers and 返回 restores usage', async () => {
  const plugin = loadPlugin()
  try {
    const usageTree = await settleDialog(plugin, 'opencode-go')
    assert.equal(usageTree.props.title, 'dsh-TokenLens · 词元透镜 · OpenCode', 'the usage dialog keeps the plugin + provider title')
    const manage = manageButtonOf(usageTree)
    assert.ok(manage, 'the dialog carries a 管理 button')
    assert.match(textOf(manage), /管理/)
    manage.props.onClick()

    // The view switch is synchronous; the provider list read is still in flight.
    const loadingTree = renderDialog(plugin)
    assert.equal(loadingTree.props.title, 'dsh-TokenLens · 词元透镜 · 管理页', 'the management view retitles the modal to plugin + page')
    assert.match(textOf(loadingTree), /正在读取供应商配置…/)
    assert.match(textOf(loadingTree), /← 返回/)
    assert.ok(backButtonOf(loadingTree), 'the back arrow is present while loading')

    await settle()
    const tree = renderDialog(plugin)
    const text = textOf(tree)
    // v0.15.0: the DSH model settings drive the primary list.
    assert.match(text, /DSH 模型设置中的供应商/)
    assert.ok(text.includes('OpenCode'))
    assert.ok(text.includes('Command Code'))
    assert.ok(text.includes('Anthropic'), 'a DSH-only route without an adapter is listed read-only')
    assert.match(text, /DSH 已配置，但插件暂时无法自动识别其用量接口/)
    assert.ok(text.includes('配置文件：'), 'the settings path is shown as a hint')
    assert.ok(text.includes('C:/Users/x/.dsh/dsh-tokenlens/providers.json'))
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'providers').length,
      2,
      'one silent startup read plus the page read when 管理 opens',
    )

    // The plugin-only preset adapters are collapsed inside the 全部 tab.
    const allTab = switchProviderFilter(plugin, tree, 'all')
    const expanded = expandPresetSection(plugin, allTab)
    assert.ok(textOf(expanded).includes('DeepSeek Account'), 'the collapsed preset section holds the account provider')
    assert.match(textOf(expanded), /插件适配器（DSH 未配置）/)

    backButtonOf(expanded).props.onClick()
    const usageAgain = renderDialog(plugin)
    assert.equal(usageAgain.props.title, 'dsh-TokenLens · 词元透镜 · OpenCode', 'the provider title is restored')
    assert.match(textOf(usageAgain), /套餐容量/)
    assert.match(textOf(usageAgain), /本机 Token 用量/)
    assert.equal(actions(plugin).filter((action) => action === 'providers').length, 2, '返回 does not refetch')
  } finally {
    plugin.dispose()
  }
})

test('the management page lists every provider with label, kind badge and enabled toggle', async () => {
  const plugin = loadPlugin()
  try {
    // v0.17.0: 全部 is the union list; 已配置/内置 are exercised by their own tests.
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    const cards = providerCardsOf(tree)
    assert.deepEqual(
      cards.map((card) => card.props['data-provider']),
      ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot'],
      'the DSH section comes first, then the preset adapters in Host order',
    )
    const text = textOf(tree)
    for (const label of ['OpenCode', 'Command Code', 'DeepSeek', 'DeepSeek Account', 'OpenRouter', 'Moonshot Kimi']) {
      assert.ok(text.includes(label), `the list shows ${label}`)
    }
    assert.deepEqual(
      findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-kind').map((badge) => badge.props['data-kind']),
      ['windows', 'windows', 'balance', 'balance', 'balance', 'balance'],
      'each provider carries its kind badge',
    )
    assert.match(text, /额度窗口/)
    assert.match(text, /余额/)

    const toggles = findAll(tree, (element) => element.props?.['data-provider-enabled'] !== undefined)
    assert.deepEqual(
      toggles.map((toggle) => [toggle.props['data-provider-enabled'], toggle.props.checked]),
      [
        ['opencode-go', true],
        ['commandcode', false],
        ['deepseek', true],
        ['deepseek-account', true],
        ['openrouter', true],
        ['moonshot', false],
      ],
      'the toggle mirrors the Host state',
    )
    // Per-row status: configured with its key source, disabled, missing key.
    assert.match(textOf(providerCardOf(tree, 'opencode-go')), /已配置/)
    assert.match(textOf(providerCardOf(tree, 'opencode-go')), /来源：env/)
    assert.match(textOf(providerCardOf(tree, 'commandcode')), /已停用/)
    assert.match(textOf(providerCardOf(tree, 'openrouter')), /缺 Key/)
    assert.match(textOf(providerCardOf(tree, 'deepseek-account')), /来源：service/)
  } finally {
    plugin.dispose()
  }
})

test('toggling the enabled switch sends providerUpdate with only the enabled flag', async () => {
  let opencodeEnabled = true
  const updates = []
  const providerList = () => ({
    ok: true,
    storeFile: '',
    providers: [
      providerEntry({ providerId: 'opencode-go', enabled: opencodeEnabled }),
      providerEntry({ providerId: 'deepseek', label: 'DeepSeek', kind: 'balance' }),
    ],
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providerList()
    if (payload.action === 'providerUpdate') {
      updates.push(payload)
      if (typeof payload.update?.enabled === 'boolean') opencodeEnabled = payload.update.enabled
      return providerList()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    const toggle = providerInputOf(tree, 'data-provider-enabled', 'opencode-go')
    assert.equal(toggle.props.checked, true)
    toggle.props.onChange({ target: { checked: false } })
    await settle()
    tree = renderDialog(plugin)

    assert.equal(updates.length, 1, 'one update is sent')
    assert.equal(updates[0].providerId, 'opencode-go')
    assert.deepEqual(updates[0].update, { enabled: false }, 'only the enabled flag is sent')
    assert.equal(
      providerInputOf(tree, 'data-provider-enabled', 'opencode-go').props.checked,
      false,
      'the answer is adopted by the toggle',
    )
    assert.match(textOf(providerCardOf(tree, 'opencode-go')), /已停用/)
  } finally {
    plugin.dispose()
  }
})

test('saving a console URL sends only providerUpdate {consoleUrl} (no credential fields exist)', async () => {
  const nextConsoleUrl = 'https://openrouter.ai/settings/keys'
  const updates = []
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'providerUpdate') {
      updates.push(payload)
      return providersFixture()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'openrouter')
    // The console URL is a display link, not a credential: it stays editable.
    const input = providerInputOf(tree, 'data-provider-consoleurl', 'openrouter')
    assert.ok(input, 'the editor offers a console-URL input')
    assert.equal(input.props.value, 'https://openrouter.ai/settings/credits', 'the draft is seeded from the wire')
    assert.equal(
      providerInputOf(tree, 'data-provider-key', 'openrouter'),
      undefined,
      'the Host never sends a stored secret back, and the client asks for none',
    )

    input.props.onChange({ target: { value: nextConsoleUrl } })
    tree = renderDialog(plugin)
    assert.equal(
      providerInputOf(tree, 'data-provider-consoleurl', 'openrouter').props.value,
      nextConsoleUrl,
      'the typed draft stays in the input',
    )
    editorButtonOf(tree, 'dsh-tokenlens-save').props.onClick()
    await settle()

    assert.equal(updates.length, 1, 'one update is sent')
    assert.equal(updates[0].providerId, 'openrouter')
    assert.deepEqual(updates[0].update, { consoleUrl: nextConsoleUrl }, 'only the changed non-credential field is sent')
    assert.deepEqual(Object.keys(updates[0].update), ['consoleUrl'], 'no apiKey/baseURL key can appear in a UI payload')

    // The answered list re-seeds the draft (the fixture keeps its static URL).
    tree = renderDialog(plugin)
    assert.equal(
      providerInputOf(tree, 'data-provider-consoleurl', 'openrouter').props.value,
      'https://openrouter.ai/settings/credits',
    )
  } finally {
    plugin.dispose()
  }
})

test('no provider editor renders API-key, Base-URL, reveal or clear controls', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    for (const providerId of ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot']) {
      tree = expandProvider(plugin, tree, providerId)
      for (const attr of ['data-provider-key', 'data-provider-baseurl', 'data-provider-reveal', 'data-provider-clear']) {
        assert.equal(
          providerInputOf(tree, attr, providerId),
          undefined,
          `${providerId}: ${attr} must never render in v0.14.0`,
        )
      }
    }
    // The bundle itself must not carry the old credential controls either.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    for (const marker of ['data-provider-key', 'data-provider-baseurl', 'data-provider-override', 'providerApiKey', 'providerBaseURL']) {
      assert.equal(source.includes(marker), false, `client.js no longer defines ${marker}`)
    }
  } finally {
    plugin.dispose()
  }
})

test('测试连接 calls providerTest and shows the snapshot summary on success', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'providerTest') return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'opencode-go')
    const testButton = editorButtonOf(tree, 'dsh-tokenlens-test')
    assert.ok(testButton, 'the editor offers 测试连接')
    assert.match(textOf(testButton), /测试连接/)
    testButton.props.onClick()
    await settle()
    tree = renderDialog(plugin)

    const payload = lastCallWith(plugin, 'providerTest')
    assert.deepEqual(payload, { action: 'providerTest', providerId: 'opencode-go' })
    const card = textOf(providerCardOf(tree, 'opencode-go'))
    assert.match(card, /可用/, 'the row reports the successful test')
    assert.match(card, /5 小时 2%/, 'the row summarises the forced upstream read')
    assert.match(card, /本周 24%/)
  } finally {
    plugin.dispose()
  }
})

test('a failing 测试连接 shows the localized error and the payload message', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'providerTest') {
      return {
        ok: false,
        error: { code: 'unauthorized', message: 'upstream rejected the key', retryable: false },
        snapshot: null,
      }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'opencode-go')
    editorButtonOf(tree, 'dsh-tokenlens-test').props.onClick()
    await settle()
    tree = renderDialog(plugin)
    const card = textOf(providerCardOf(tree, 'opencode-go'))
    assert.match(card, /错误/)
    assert.match(card, /API Key 无效或已过期/)
    assert.match(card, /upstream rejected the key/)
    assert.match(textOf(tree), /测试连接/, 'the editor stays usable for a retry')
  } finally {
    plugin.dispose()
  }
})

test('a failed save keeps the editor and draft, and shows the error on the row', async () => {
  const draftUrl = 'https://example.com/usage'
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'providerUpdate') {
      return {
        ok: false,
        error: { code: 'unsupported-provider', message: 'provider "openrouter" is not built in', retryable: false },
      }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'openrouter')
    // A non-credential draft is enough to exercise the failed-save path.
    providerInputOf(tree, 'data-provider-consoleurl', 'openrouter').props.onChange({ target: { value: draftUrl } })
    tree = renderDialog(plugin)
    editorButtonOf(tree, 'dsh-tokenlens-save').props.onClick()
    await settle()
    tree = renderDialog(plugin)
    const card = textOf(providerCardOf(tree, 'openrouter'))
    assert.match(card, /错误/)
    assert.match(card, /not built in/)
    assert.equal(
      providerInputOf(tree, 'data-provider-consoleurl', 'openrouter').props.value,
      draftUrl,
      'the draft survives a failed save',
    )
    assert.ok(providerInputOf(tree, 'data-provider-consoleurl', 'openrouter'), 'the editor stays expanded')
  } finally {
    plugin.dispose()
  }
})

test('deepseek-account keeps its account-service hint with no key field while enable/disable still works', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'deepseek-account')
    assert.equal(
      providerInputOf(tree, 'data-provider-key', 'deepseek-account'),
      undefined,
      'the DSH account service owns the credential: no key field exists',
    )
    assert.equal(
      providerInputOf(tree, 'data-provider-baseurl', 'deepseek-account'),
      undefined,
      'the account service has no editable endpoint either',
    )
    assert.match(textOf(providerCardOf(tree, 'deepseek-account')), /使用 DSH 账户服务/)
    // The account service is not a missing model route: it gets its own hint and
    // not the "add a DSH route" hint either.
    assert.equal(unmanagedHintOf(tree, 'deepseek-account'), undefined)
    assert.equal(inheritedNoteOf(tree, 'deepseek-account'), undefined)

    const toggle = providerInputOf(tree, 'data-provider-enabled', 'deepseek-account')
    assert.equal(toggle.props.disabled, false, 'enable/disable is still available')
    toggle.props.onChange({ target: { checked: false } })
    await settle()
    const update = lastCallWith(plugin, 'providerUpdate')
    assert.equal(update.providerId, 'deepseek-account')
    assert.deepEqual(update.update, { enabled: false })

    // Every other provider is credential-free too, while names/console stay editable.
    tree = expandProvider(plugin, renderDialog(plugin), 'openrouter')
    assert.ok(providerInputOf(tree, 'data-provider-shortlabel', 'openrouter'), 'name editing stays')
    assert.ok(providerInputOf(tree, 'data-provider-consoleurl', 'openrouter'), 'console editing stays')
    assert.equal(providerInputOf(tree, 'data-provider-key', 'openrouter'), undefined)
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Uniform provider cards + editable short/full names (v0.12.0).
// ---------------------------------------------------------------------------

test('the provider editor prefills 短标签 and 全名 with their limits and hints', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'commandcode')
    const shortInput = providerInputOf(tree, 'data-provider-shortlabel', 'commandcode')
    assert.ok(shortInput, 'the editor offers a 短标签 input')
    assert.equal(shortInput.props.type, 'text')
    assert.equal(shortInput.props.value, 'CC', 'the short-label draft is seeded from the wire shortLabel')
    assert.equal(shortInput.props.maxLength, 12, 'the Host limit caps the short label')
    const fullInput = providerInputOf(tree, 'data-provider-label', 'commandcode')
    assert.ok(fullInput, 'the editor offers a 全名 input')
    assert.equal(fullInput.props.type, 'text')
    assert.equal(fullInput.props.value, 'Command Code', 'the full-name draft is seeded from the wire label')
    assert.equal(fullInput.props.maxLength, 40, 'the Host limit caps the full name')

    const card = textOf(providerCardOf(tree, 'commandcode'))
    assert.match(card, /1–12 字符/, 'the short-label limit is hinted')
    assert.match(card, /1–40 字符/, 'the full-name limit is hinted')
    assert.match(card, /恢复默认名称/, 'the restore-defaults button is part of the editor')

    // Every card header has the same five deterministic columns, so no card's
    // status pill can wrap onto a second row and change that card's height.
    const headOf = (providerCard) =>
      findElement(providerCard, (element) => element.props?.className === 'dsh-tokenlens-provider-head')
    assert.deepEqual(
      providerCardsOf(tree).map((providerCard) => headOf(providerCard).children.map((child) => child.props?.className)),
      Array.from({ length: 6 }, () => [
        'dsh-tokenlens-avatar',
        'dsh-tokenlens-provider-toggle',
        'dsh-tokenlens-kind',
        'dsh-tokenlens-provider-status',
        'dsh-tokenlens-enabled-wrap',
      ]),
      'all cards share avatar | name | kind | status | enable in that order',
    )
  } finally {
    plugin.dispose()
  }
})

test('saving changed labels sends exactly the changed name fields and adopts the answered payload', async () => {
  const labels = { label: 'OpenCode', shortLabel: 'OC' }
  const updates = []
  const providerList = () => ({
    ok: true,
    storeFile: '',
    providers: [
      providerEntry({ providerId: 'opencode-go', label: labels.label, shortLabel: labels.shortLabel }),
      providerEntry({ providerId: 'commandcode', label: 'Command Code', shortLabel: 'CC' }),
    ],
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providerList()
    if (payload.action === 'providerUpdate') {
      updates.push(payload)
      const update = payload.update ?? {}
      if (typeof update.shortLabel === 'string') labels.shortLabel = update.shortLabel === '' ? 'OC' : update.shortLabel
      if (typeof update.label === 'string') labels.label = update.label === '' ? 'OpenCode' : update.label
      return providerList()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'opencode-go')
    providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go').props.onChange({ target: { value: 'XY' } })
    providerInputOf(tree, 'data-provider-label', 'opencode-go').props.onChange({ target: { value: 'OpenCode Prime' } })
    tree = renderDialog(plugin)
    editorButtonOf(tree, 'dsh-tokenlens-save').props.onClick()
    await settle()

    assert.equal(updates.length, 1, 'one providerUpdate is sent')
    assert.equal(updates[0].providerId, 'opencode-go')
    assert.deepEqual(updates[0].update, { shortLabel: 'XY', label: 'OpenCode Prime' })
    assert.deepEqual(
      Object.keys(updates[0].update).sort(),
      ['label', 'shortLabel'],
      'only the two changed name fields are submitted (no apiKey/baseURL/consoleUrl noise)',
    )

    tree = renderDialog(plugin)
    const card = providerCardOf(tree, 'opencode-go')
    assert.match(textOf(card), /OpenCode Prime/, 'the card name/header adopts the answered full name')
    assert.match(textOf(card), /短标签：XY/)
    assert.match(textOf(card), /全名：OpenCode Prime/)
    const avatar = findAll(card, (element) => element.props?.className === 'dsh-tokenlens-avatar')[0]
    assert.equal(textOf(avatar), 'XY', 'the avatar shows the answered short label')
    assert.equal(
      providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go').props.value,
      'XY',
      'the editor re-seeds the draft from the answered payload',
    )
    assert.equal(providerInputOf(tree, 'data-provider-label', 'opencode-go').props.value, 'OpenCode Prime')

    // The chip label catalog is adopted too: 返回 shows the new short label.
    backButtonOf(tree).props.onClick()
    const chip = await settleChip(plugin, 'opencode-go')
    assert.equal(textOf(brandOf(chip)), 'XY', 'the chip brand follows the updated short label')
  } finally {
    plugin.dispose()
  }
})

test('clearing both name inputs sends empty strings and restores the built-in names', async () => {
  const builtin = { label: 'Command Code', shortLabel: 'CC' }
  let custom = { label: 'Command Code Pro', shortLabel: 'CCX' }
  const updates = []
  const providerList = () => ({
    ok: true,
    storeFile: '',
    providers: [providerEntry({ providerId: 'commandcode', label: custom.label, shortLabel: custom.shortLabel })],
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providerList()
    if (payload.action === 'providerUpdate') {
      updates.push(payload)
      const update = payload.update ?? {}
      custom = {
        label: typeof update.label === 'string' ? update.label || builtin.label : custom.label,
        shortLabel: typeof update.shortLabel === 'string' ? update.shortLabel || builtin.shortLabel : custom.shortLabel,
      }
      return providerList()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'commandcode')
    assert.equal(providerInputOf(tree, 'data-provider-shortlabel', 'commandcode').props.value, 'CCX')
    assert.equal(providerInputOf(tree, 'data-provider-label', 'commandcode').props.value, 'Command Code Pro')

    providerInputOf(tree, 'data-provider-shortlabel', 'commandcode').props.onChange({ target: { value: '' } })
    providerInputOf(tree, 'data-provider-label', 'commandcode').props.onChange({ target: { value: '' } })
    tree = renderDialog(plugin)
    editorButtonOf(tree, 'dsh-tokenlens-save').props.onClick()
    await settle()

    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].update, { shortLabel: '', label: '' }, 'empty strings clear both overrides')

    tree = renderDialog(plugin)
    const card = providerCardOf(tree, 'commandcode')
    assert.match(textOf(card), /短标签：CC/, 'the built-in short label is restored')
    assert.match(textOf(card), /全名：Command Code/, 'the built-in full name is restored')
    assert.doesNotMatch(textOf(card), /Command Code Pro/, 'the override is gone from the card')
    assert.equal(providerInputOf(tree, 'data-provider-shortlabel', 'commandcode').props.value, 'CC')
    assert.equal(providerInputOf(tree, 'data-provider-label', 'commandcode').props.value, 'Command Code')
  } finally {
    plugin.dispose()
  }
})

test('the 恢复默认名称 button sends both name overrides as empty strings', async () => {
  const updates = []
  let overridden = true
  const providerList = () => ({
    ok: true,
    storeFile: '',
    providers: [
      providerEntry({
        providerId: 'commandcode',
        label: overridden ? 'CC Custom' : 'Command Code',
        shortLabel: overridden ? 'CUS' : 'CC',
      }),
    ],
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providerList()
    if (payload.action === 'providerUpdate') {
      updates.push(payload)
      const update = payload.update ?? {}
      if (update.shortLabel === '' && update.label === '') overridden = false
      return providerList()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'commandcode')
    // A dirty draft must not leak into the restore call: it clears both overrides.
    providerInputOf(tree, 'data-provider-shortlabel', 'commandcode').props.onChange({ target: { value: 'ZZZ' } })
    tree = renderDialog(plugin)
    editorButtonOf(tree, 'dsh-tokenlens-restore-labels').props.onClick()
    await settle()

    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].providerId, 'commandcode')
    assert.deepEqual(updates[0].update, { shortLabel: '', label: '' })

    tree = renderDialog(plugin)
    const card = providerCardOf(tree, 'commandcode')
    assert.match(textOf(card), /全名：Command Code/, 'the built-in full name is adopted')
    assert.match(textOf(card), /短标签：CC/, 'the built-in short label is adopted')
    assert.equal(providerInputOf(tree, 'data-provider-shortlabel', 'commandcode').props.value, 'CC')
    assert.equal(providerInputOf(tree, 'data-provider-label', 'commandcode').props.value, 'Command Code')
  } finally {
    plugin.dispose()
  }
})

test('over-long names show the inline limit error and the Host rejection is rendered on the row', async () => {
  const tooLongLabel = 'X'.repeat(41)
  const tooLongShort = 'X'.repeat(13)
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'providerUpdate') {
      // The Host validates the name limits and rejects with HTTP 500: the body is
      // still the JSON error envelope, but it also carries a cached snapshot, so
      // it is longer than the client's short message preview.
      return {
        __httpStatus: 500,
        __body: {
          ok: false,
          error: { code: 'parse', message: 'provider label must be 40 characters or fewer', retryable: false },
          snapshot: snapshotFixture(payload.providerId),
        },
      }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'opencode-go')
    // The stub input does not enforce maxlength, so this simulates a pasted draft
    // that is longer than the Host's validation limit.
    providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go').props.onChange({
      target: { value: tooLongShort },
    })
    providerInputOf(tree, 'data-provider-label', 'opencode-go').props.onChange({ target: { value: tooLongLabel } })
    tree = renderDialog(plugin)
    const before = textOf(providerCardOf(tree, 'opencode-go'))
    assert.match(before, /最多 40 个字符/, 'the client shows the full-name length error')
    assert.match(before, /最多 12 个字符/, 'the client shows the short-label length error')
    assert.equal(
      providerInputOf(tree, 'data-provider-label', 'opencode-go').props['aria-invalid'],
      'true',
      'the invalid field is marked for assistive tech',
    )

    editorButtonOf(tree, 'dsh-tokenlens-save').props.onClick()
    await settle()
    const update = lastCallWith(plugin, 'providerUpdate')
    assert.deepEqual(update.update, { shortLabel: tooLongShort, label: tooLongLabel }, 'the Host remains authoritative')

    tree = renderDialog(plugin)
    const card = textOf(providerCardOf(tree, 'opencode-go'))
    assert.match(card, /无法解析用量服务的返回内容/, 'the localized Host error code is rendered')
    assert.match(card, /provider label must be 40 characters or fewer/, 'the full HTTP-500 envelope message is rendered')
    assert.ok(providerInputOf(tree, 'data-provider-label', 'opencode-go'), 'the editor stays usable for a retry')
  } finally {
    plugin.dispose()
  }
})

test('the provider grid top-aligns cards and gives collapsed cards a uniform height (static CSS)', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /\.dsh-tokenlens-providers\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(300px,1fr\)\);gap:8px;align-items:start\}/,
    'the provider grid top-aligns its cards instead of stretching every row',
  )
  assert.doesNotMatch(source, /grid-auto-rows:1fr/, 'no uniform row track lets one expanded card stretch its whole row')
  assert.doesNotMatch(
    source,
    /\.dsh-tokenlens-provider-card\{[^}]*height:100%/,
    'cards no longer stretch to the tallest card of their row',
  )
  assert.match(
    source,
    /\.dsh-tokenlens-provider-card\{[^}]*min-height:84px/,
    'collapsed cards share one uniform minimum height',
  )
  assert.match(
    source,
    /\.dsh-tokenlens-provider-head\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto auto auto;/,
    'the card header is a deterministic five-column grid row',
  )
  assert.doesNotMatch(source, /\.dsh-tokenlens-provider-head\{[^}]*flex-wrap:wrap/, 'the header no longer wraps unevenly')
  assert.match(source, /\.dsh-tokenlens-provider-status\{flex:none;[^}]*white-space:nowrap/, 'status pills never wrap')
  assert.match(source, /\.dsh-tokenlens-kind\{flex:none;[^}]*white-space:nowrap/, 'kind badges never wrap')
})

test('junk providers payloads degrade to empty/defensive states without throwing', async () => {
  const cases = [
    { providers: 'nonsense', expected: 'empty' },
    { expected: 'empty' },
    {
      providers: [null, 5, 'x', {}, { providerId: '' }, { providerId: 'mystery', label: 7, kind: 'weird', enabled: 'yes', hasKey: 'maybe', baseURL: 5 }],
      expected: 'normalized',
    },
  ]
  for (const scenario of cases) {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      if (payload.action === 'providers') return { ok: true, ...scenario }
      return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    })
    try {
      const tree = await settleManagement(plugin)
      const text = textOf(tree)
      assert.doesNotMatch(text, /is not defined/)
      assert.doesNotMatch(text, /undefined/)
      assert.match(text, /dsh-TokenLens · 词元透镜 · 管理页/)
      if (scenario.expected === 'empty') {
        assert.match(text, /Host 没有返回任何供应商/)
        assert.equal(providerCardsOf(tree).length, 0)
      } else {
        const cards = providerCardsOf(tree)
        assert.equal(cards.length, 1, 'only the entry with a usable id survives')
        assert.match(text, /mystery/, 'the raw id is the label fallback')
        assert.match(text, /未知类型/, 'an unknown kind gets its own badge')
        assert.match(text, /缺 Key/, 'a non-true hasKey reads as missing')
        const toggle = providerInputOf(tree, 'data-provider-enabled', 'mystery')
        assert.equal(toggle.props.checked, true, 'only enabled:false disables a provider')
      }
      backButtonOf(tree).props.onClick()
      assert.match(textOf(renderDialog(plugin)), /套餐容量/, '返回 still works from a degraded list')
    } finally {
      plugin.dispose()
    }
  }
})

test('a Host without the providers action shows an error state and 返回 still works', async () => {
  for (const failure of ['throw', 'envelope']) {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      if (payload.action === 'providers') {
        if (failure === 'throw') throw new Error('HTTP 400 unknown-action')
        return {
          ok: false,
          error: { code: 'unknown-action', message: 'unknown action "providers"', retryable: false },
        }
      }
      return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    })
    try {
      const tree = await settleManagement(plugin)
      const text = textOf(tree)
      assert.match(text, /dsh-TokenLens · 词元透镜 · 管理页/)
      assert.doesNotMatch(text, /用量详情渲染失败/, 'the dialog is not replaced by the degraded fallback')
      if (failure === 'throw') {
        assert.match(text, /Host 桥接/, 'a transport failure is explained')
        assert.match(text, /重试/, 'a retryable failure offers the retry button')
      } else {
        assert.match(text, /unknown action "providers"/, 'the Host message is shown')
      }
      backButtonOf(tree).props.onClick()
      const usage = renderDialog(plugin)
      assert.equal(usage.props.title, 'dsh-TokenLens · 词元透镜 · OpenCode')
      assert.match(textOf(usage), /套餐容量/)
      assert.match(textOf(usage), /本机 Token 用量/)
    } finally {
      plugin.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
// Chip label style selector (v0.10.0): short label vs full provider name.
// ---------------------------------------------------------------------------

test('the chip shows the short label by default and the full label after 全名', async () => {
  let settings = { labelStyle: 'short', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto' }
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture({ settings })
    if (payload.action === 'settingsUpdate') {
      settings = { ...settings, ...payload.settings }
      return providersFixture({ settings })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const shortChip = await settleChip(plugin, 'commandcode')
    assert.equal(textOf(brandOf(shortChip)), 'CC', 'the default chip brand is the short label')

    const management = await settleManagement(plugin, 'commandcode')
    const settingsTree = await switchManageTab(plugin, management, 'settings')
    const shortOption = labelStyleOptionOf(settingsTree, 'short')
    const fullOption = labelStyleOptionOf(settingsTree, 'full')
    assert.ok(shortOption, 'the 插件设置 tab offers the short label')
    assert.ok(fullOption, 'the 插件设置 tab offers the full name')
    assert.equal(shortOption.props['data-active'], 'true')
    assert.equal(fullOption.props['data-active'], 'false')

    fullOption.props.onClick()
    await settle()
    const update = lastCallWith(plugin, 'settingsUpdate')
    assert.deepEqual(
      update,
      {
        action: 'settingsUpdate',
        settings: { labelStyle: 'full', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto' },
      },
      'choosing 全名 sends the FULL settings object',
    )

    const updated = renderDialog(plugin)
    assert.equal(labelStyleOptionOf(updated, 'full').props['data-active'], 'true', 'the answered style is adopted')
    assert.equal(labelStyleOptionOf(updated, 'short').props['data-active'], 'false')

    backButtonOf(updated).props.onClick()
    const usage = renderDialog(plugin)
    assert.equal(usage.props.title, 'dsh-TokenLens · 词元透镜 · Command Code', 'the usage dialog title is unchanged')
    const fullChip = await settleChip(plugin, 'commandcode')
    assert.equal(textOf(brandOf(fullChip)), 'Command Code', '返回 shows the chip with the full provider name')
  } finally {
    plugin.dispose()
  }
})

test('the management page renders the label-style selector and both labels per provider', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    // The selector moved to the 插件设置 tab (v0.29.0); the provider cards stay
    // on the 供应商配置 tab.
    assert.equal(providerCardsOf(tree).length > 0, true, 'the provider cards render on the first tab')
    const commandCode = textOf(providerCardOf(tree, 'commandcode'))
    assert.match(commandCode, /短标签：CC/)
    assert.match(commandCode, /全名：Command Code/)
    const openCode = textOf(providerCardOf(tree, 'opencode-go'))
    assert.match(openCode, /短标签：OC/)
    assert.match(openCode, /全名：OpenCode/)
    // The preset adapters live in the collapsed secondary section of 全部 (v0.15.0).
    const allTab = switchProviderFilter(plugin, tree, 'all')
    const expanded = expandPresetSection(plugin, allTab)
    const moonShot = textOf(providerCardOf(expanded, 'moonshot'))
    assert.match(moonShot, /短标签：MS/, 'the wire shortLabel is displayed')
    assert.match(moonShot, /全名：Moonshot Kimi/, 'the wire full label is displayed')

    // The chip-label-style selector lives in the 插件设置 tab.
    const settingsTree = await switchManageTab(plugin, expanded, 'settings')
    const text = textOf(settingsTree)
    assert.match(text, /标签样式/, 'the selector row is labelled in 插件设置')
    assert.match(text, /短标签/)
    assert.match(text, /全名/)
    assert.deepEqual(
      findAll(settingsTree, (element) => element.props?.['data-label-style'] !== undefined).map(
        (option) => option.props['data-label-style'],
      ),
      ['short', 'full'],
      'the selector has exactly two options',
    )
    assert.equal(labelStyleOptionOf(settingsTree, 'short').props['data-active'], 'true', 'short is the default style')
  } finally {
    plugin.dispose()
  }
})

test('a persisted full label style is applied at startup and uses the wire labels', async () => {
  const list = providersFixture({ settings: { labelStyle: 'full' } })
  list.providers = list.providers.map((provider) =>
    provider.providerId === 'commandcode'
      ? { ...provider, label: 'Command Code Pro', shortLabel: 'CCX' }
      : provider,
  )
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return list
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const chip = await settleChip(plugin, 'commandcode')
    assert.equal(
      textOf(brandOf(chip)),
      'Command Code Pro',
      'the persisted full style applies before 管理 is ever opened (wire full label wins)',
    )
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'providers').length,
      1,
      'the startup load reads the providers payload once',
    )

    const tree = await settleManagement(plugin, 'commandcode')
    const settingsTree = await switchManageTab(plugin, tree, 'settings')
    assert.equal(labelStyleOptionOf(settingsTree, 'full').props['data-active'], 'true', 'the page starts on the persisted style')
    const row = textOf(providerCardOf(tree, 'commandcode'))
    assert.match(row, /短标签：CCX/)
    assert.match(row, /全名：Command Code Pro/)
  } finally {
    plugin.dispose()
  }
})

test('cached wire short labels win over the local catalog', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') {
      return providersFixture({
        providers: [
          providerEntry({
            providerId: 'commandcode',
            label: 'Command Code Pro',
            shortLabel: 'CCX',
            enabled: true,
            hasKey: true,
            keySource: 'env',
          }),
        ],
      })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const chip = await settleChip(plugin, 'commandcode')
    assert.equal(textOf(brandOf(chip)), 'CCX', 'the short wire label overrides the local "CC" entry')
  } finally {
    plugin.dispose()
  }
})

test('junk settings and old providers payloads fall back to the short label', async () => {
  const oldCommandCode = {
    providerId: 'commandcode',
    label: 'Command Code',
    kind: 'windows',
    enabled: true,
    hasKey: true,
    keySource: 'none',
    builtin: true,
  }
  const cases = [
    { name: 'old payload without settings', settings: undefined, providers: [oldCommandCode] },
    { name: 'invalid labelStyle', settings: { labelStyle: 'weird' }, providers: [oldCommandCode] },
    { name: 'junk settings', settings: 'junk', providers: [oldCommandCode] },
    { name: 'junk providers and null settings', settings: null, providers: 'nonsense' },
  ]
  for (const scenario of cases) {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      if (payload.action === 'providers') {
        return { ok: true, settings: scenario.settings, providers: scenario.providers, storeFile: '' }
      }
      return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    })
    try {
      const chip = await settleChip(plugin, 'commandcode')
      assert.equal(textOf(brandOf(chip)), 'CC', `${scenario.name}: the chip stays on the short label`)
      const tree = await settleManagement(plugin, 'commandcode')
      if (Array.isArray(scenario.providers) && scenario.providers.length > 0) {
        assert.match(
          textOf(providerCardOf(tree, 'commandcode')),
          /短标签：CC/,
          `${scenario.name}: the local short-label fallback fills the row`,
        )
      }
      const settingsTree = await switchManageTab(plugin, tree, 'settings')
      assert.equal(
        labelStyleOptionOf(settingsTree, 'short').props['data-active'],
        'true',
        `${scenario.name}: the selector falls back to short`,
      )
      assert.equal(labelStyleOptionOf(settingsTree, 'full').props['data-active'], 'false')
      assert.doesNotMatch(textOf(settingsTree), /undefined/, `${scenario.name}: no raw undefined leaks into the page`)
    } finally {
      plugin.dispose()
    }
  }
})

test('a failed settingsUpdate shows the error and keeps the previous short label', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture()
    if (payload.action === 'settingsUpdate') {
      return {
        ok: false,
        error: {
          code: 'unsupported-provider',
          message: 'settings.labelStyle must be one of short, full',
          retryable: false,
        },
      }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleManagement(plugin, 'commandcode')
    const settingsTree = await switchManageTab(plugin, tree, 'settings')
    labelStyleOptionOf(settingsTree, 'full').props.onClick()
    const busyTree = renderDialog(plugin)
    assert.match(textOf(busyTree), /保存中…/, 'the saving state is shown while the request is in flight')
    assert.equal(labelStyleOptionOf(busyTree, 'full').props.disabled, true, 'both options are disabled while saving')
    await settle()

    const failed = renderDialog(plugin)
    const text = textOf(failed)
    assert.match(text, /当前模型供应商不受用量插件支持/, 'the localized wire error is shown')
    assert.match(text, /settings.labelStyle must be one of/, 'the Host message is shown too')
    assert.equal(labelStyleOptionOf(failed, 'short').props['data-active'], 'true', 'a failed switch keeps short')
    assert.equal(labelStyleOptionOf(failed, 'full').props['data-active'], 'false')
    assert.equal(labelStyleOptionOf(failed, 'full').props.disabled, false, 'the selector is usable for a retry')

    backButtonOf(failed).props.onClick()
    const chip = await settleChip(plugin, 'commandcode')
    assert.equal(textOf(brandOf(chip)), 'CC', 'the chip keeps the short label after a failed switch')
  } finally {
    plugin.dispose()
  }
})

test('the management page ships matching zh/en dictionary keys', () => {
  const plugin = loadPlugin()
  try {
    const dictionary = plugin.dictionaries['dsh-tokenlens']
    assert.ok(dictionary, 'the locale namespace is registered')
    const required = [
      'manageOpen',
      'manageOpenHint',
      'manageTitle',
      'manageBack',
      'manageBackHint',
      'manageSubtitle',
      'providersLoading',
      'providersEmpty',
      'providersStoreFile',
      'providerKindWindows',
      'providerKindBalance',
      'providerKindUnknown',
      'providerEnabled',
      'providerStatusConfigured',
      'providerStatusMissingKey',
      'providerStatusDisabled',
      'providerStatusTesting',
      'providerStatusOk',
      'providerStatusError',
      'providerKeySource',
      'providerKeyService',
      'providerDshInherited',
      'providerDshUnmanaged',
      'dshSectionTitle',
      'dshSectionHint',
      'dshSectionCount',
      'dshUnsupportedHint',
      'presetSectionTitle',
      'presetSectionHint',
      'presetSectionCount',
      'presetExpand',
      'presetCollapse',
      'providerFilterLabel',
      'filterConfigured',
      'filterBuiltin',
      'filterAll',
      'filterEmptyConfigured',
      'filterEmptyConfiguredHint',
      'builtinSectionTitle',
      'builtinSectionHint',
      'providerConsoleURL',
      'providerConsoleURLPlaceholder',
      'providerSave',
      'providerSaving',
      'providerTest',
      'providerTesting',
      'providerUpdateFailed',
      'providerTestFailed',
      'labelStyleTitle',
      'labelStyleShort',
      'labelStyleFull',
      'labelStyleSaving',
      'labelStyleHint',
      'providerBothLabels',
      'providerShortLabel',
      'providerShortLabelHint',
      'providerShortLabelTooLong',
      'providerFullName',
      'providerFullNameHint',
      'providerFullNameTooLong',
      'providerRestoreNames',
      'providerRestoreNamesHint',
      'customSectionTitle',
      'customSectionCount',
      'customSectionHint',
      'customDelete',
      'customDeleting',
      'customDeleteHint',
      'customProviderBadge',
      'customProviderHint',
      'statsSinceEffective',
      'providerSubscribed',
      'providerNotSubscribed',
      'providerSubscribedHint',
      'providerNotSubscribedHint',
      'statsViewLabel',
      'statsViewData',
      'statsViewChart',
      'statsChartEmpty',
      'statsChartEmptyHint',
      'statsChartTotal',
      'statsChartPeak',
      'statsChartBarTitle',
      'statsChartReadout',
      'statsLast7Days',
      'manageTabProviders',
      'manageTabSettings',
      'manageTabsLabel',
      'settingsHint',
      'settingsLabelStyle',
      'settingsDefaultView',
      'settingsDefaultScope',
      'settingsScopeProvider',
      'settingsScopeAll',
      'settingsDetailsExpanded',
      'settingsDetailsAuto',
      'settingsDetailsExpandedOption',
      'settingsDetailsCollapsed',
      'settingsResetDefaults',
      'settingsResetDefaultsHint',
      'capacityTokenUsed',
      'capacityTokenEstimate',
      'capacityTokenNoEstimate',
      'capacityTokenEstimateHint',
    ]
    for (const key of required) {
      assert.equal(typeof dictionary.zh[key], 'string', `zh.${key} exists`)
      assert.equal(typeof dictionary.en[key], 'string', `en.${key} exists`)
      assert.notEqual(dictionary.zh[key], '', `zh.${key} is not empty`)
      assert.notEqual(dictionary.en[key], '', `en.${key} is not empty`)
    }
    assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort())
    assert.equal(dictionary.en.manageTitle, 'Provider management')
    // v0.22.0: the provider-scoped effective-window label.
    assert.equal(dictionary.zh.statsSinceEffective, '最近{n}天')
    assert.equal(dictionary.en.statsSinceEffective, 'Last {n}d')
    assert.equal(dictionary.zh.statsLast30Days, '最近30天', 'the all-harness label is unchanged')
    assert.equal(dictionary.en.statsLast30Days, 'Last 30 days')
    // v0.30.0: the rolling 7-day window label.
    assert.equal(dictionary.zh.statsLast7Days, '最近7天')
    assert.equal(dictionary.en.statsLast7Days, 'Last 7 days')
    // v0.23.0: the subscription pill labels + tooltips.
    assert.equal(dictionary.zh.providerSubscribed, '已订阅')
    assert.equal(dictionary.zh.providerNotSubscribed, '未订阅')
    assert.match(dictionary.zh.providerSubscribedHint, /已检测到套餐额度/)
    assert.match(dictionary.zh.providerNotSubscribedHint, /未检测到订阅/)
    assert.equal(dictionary.en.providerSubscribed, 'Subscribed')
    assert.equal(dictionary.en.providerNotSubscribed, 'Not subscribed')
    assert.match(dictionary.en.providerSubscribedHint, /Plan quota detected/)
    assert.match(dictionary.en.providerNotSubscribedHint, /No subscription detected/)
    // v0.24.0: 数据/图表 mode labels + chart summary/tooltip templates.
    assert.equal(dictionary.zh.statsViewData, '数据')
    assert.equal(dictionary.zh.statsViewChart, '图表')
    assert.equal(dictionary.en.statsViewData, 'Data')
    assert.equal(dictionary.en.statsViewChart, 'Chart')
    assert.equal(dictionary.zh.statsChartBarTitle, '{date}: {tokens}')
    assert.equal(dictionary.en.statsChartBarTitle, '{date}: {tokens}')
    // v0.25.0: the live chart readout template.
    assert.equal(dictionary.zh.statsChartReadout, '{date} · {value}（{share}%）')
    assert.equal(dictionary.en.statsChartReadout, '{date} · {value} ({share}%)')
    // v0.29.0: management tabs + 插件设置 labels.
    assert.equal(dictionary.zh.manageTabProviders, '供应商配置')
    assert.equal(dictionary.zh.manageTabSettings, '插件设置')
    assert.equal(dictionary.en.manageTabProviders, 'Provider config')
    assert.equal(dictionary.en.manageTabSettings, 'Plugin settings')
    assert.equal(dictionary.zh.settingsDefaultView, '默认展示模式')
    assert.equal(dictionary.en.settingsDefaultView, 'Default view')
    assert.equal(dictionary.zh.settingsResetDefaults, '恢复默认设置')
    assert.equal(dictionary.en.settingsResetDefaults, 'Restore defaults')
    assert.equal(dictionary.zh.statsChartTotal, '合计 {value}')
    assert.equal(dictionary.en.statsChartTotal, 'Total {value}')
    assert.match(dictionary.zh.statsChartPeak, /峰值 \{value\}（\{day\}）/)
    assert.match(dictionary.en.statsChartPeak, /Peak \{value\} \(\{day\}\)/)
    assert.notEqual(dictionary.zh.statsChartEmpty, '')
    assert.notEqual(dictionary.en.statsChartEmpty, '')
    // v0.30.13: capacity-card local-token consumption hints.
    assert.equal(dictionary.zh.capacityTokenUsed, '已消耗 {used}')
    assert.equal(dictionary.zh.capacityTokenEstimate, '预计可消耗 {quota}')
    assert.equal(dictionary.zh.capacityTokenNoEstimate, '预计可消耗 —')
    assert.match(dictionary.zh.capacityTokenEstimateHint, /仅供参考/)
    assert.equal(dictionary.en.capacityTokenUsed, 'Consumed {used}')
    assert.equal(dictionary.en.capacityTokenEstimate, 'Est. quota {quota}')
    assert.equal(dictionary.en.capacityTokenNoEstimate, 'Est. quota —')
    assert.match(dictionary.en.capacityTokenEstimateHint, /estimate only/)
    // v0.14.0: the unmanaged-provider hint replaces all credential editing.
    assert.match(dictionary.zh.providerDshUnmanaged, /设置 → 模型服务/)
    assert.match(dictionary.zh.providerDshUnmanaged, /建议路由 id：\{provider\}/)
    assert.match(dictionary.en.providerDshUnmanaged, /Settings → Model services/)
    assert.match(dictionary.en.providerDshUnmanaged, /suggested route id: \{provider\}/)
    // v0.15.0: DSH-discovery sections and the unsupported-route hint.
    assert.match(dictionary.zh.dshSectionTitle, /DSH 模型设置中的供应商/)
    assert.match(dictionary.en.dshSectionTitle, /DSH model settings/)
    assert.match(dictionary.zh.dshUnsupportedHint, /无法自动识别其用量接口/)
    assert.match(dictionary.en.dshUnsupportedHint, /cannot automatically detect its usage API yet/)
    assert.doesNotMatch(dictionary.zh.dshUnsupportedHint, /添加自定义用量适配器/, 'the removed add-custom CTA is gone')
    assert.doesNotMatch(dictionary.en.dshUnsupportedHint, /Add custom usage adapter/, 'the removed add-custom CTA is gone in en')
    assert.match(dictionary.zh.presetSectionTitle, /插件适配器（DSH 未配置）/)
    assert.match(dictionary.en.presetSectionTitle, /Plugin adapters \(not in DSH\)/)
    assert.match(dictionary.zh.presetSectionHint, /设置 → 模型服务/)
    assert.match(dictionary.en.presetSectionHint, /Settings → Model services/)
    // The removed credential/override UI keys are gone from both dictionaries.
    for (const removed of [
      'providerApiKey',
      'providerApiKeyPlaceholder',
      'providerApiKeyConfigured',
      'providerApiKeyMasked',
      'providerApiKeyClear',
      'providerKeyShow',
      'providerKeyHide',
      'providerBaseURL',
      'providerBaseURLPlaceholder',
      'providerOverrideToggle',
      'providerOverrideWarning',
    ]) {
      assert.equal(dictionary.zh[removed], undefined, `zh.${removed} is removed`)
      assert.equal(dictionary.en[removed], undefined, `en.${removed} is removed`)
    }
  } finally {
    plugin.dispose()
  }
})

test('short labels are real abbreviations and the full style restores full names', async () => {
  // Wire labels win when the Host reports them.
  const shortPlugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture({ settings: { labelStyle: 'short' } })
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const shortTree = await settleChip(shortPlugin, 'opencode-go')
    assert.match(textOf(shortTree), /OC5时/, 'short mode uses the OC abbreviation')
    assert.doesNotMatch(textOf(shortTree), /OpenCode5时/, 'short mode does not print the full name as a prefix')
  } finally {
    shortPlugin.dispose()
  }

  const fullPlugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture({ settings: { labelStyle: 'full' } })
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const fullTree = await settleChip(fullPlugin, 'opencode-go')
    assert.match(textOf(fullTree), /OpenCode5时/, 'full mode prints the provider full name')
  } finally {
    fullPlugin.dispose()
  }
})

test('short label falls back to the local abbreviation map when the wire omits it', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') {
      const payloadBase = providersFixture({ settings: { labelStyle: 'short' } })
      const first = payloadBase.providers[0]
      delete first.shortLabel
      return payloadBase
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleChip(plugin, 'opencode-go')
    assert.match(textOf(tree), /OC5时/, 'the local map still gives the OC abbreviation')
  } finally {
    plugin.dispose()
  }
})

test('the dialog uses a balanced no-scrollbar two-row layout', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.dsh-tokenlens-chart-layout\{[^}]*display:flex[^}]*flex-direction:column/, 'the layout stacks its two rows')
  assert.match(source, /\.dsh-tokenlens-chart-layout-row\{[^}]*display:flex[^}]*flex-wrap:wrap/, 'each row wraps instead of scrolling')
  assert.match(source, /\.dsh-tokenlens-chart-layout-row>\.dsh-tokenlens-capacity\{[^}]*flex:/, 'the capacity card is sized explicitly')
  assert.match(source, /\.dsh-tokenlens-chart-layout-row>\.dsh-tokenlens-stats\{[^}]*flex:1\.25 1 330px/, 'the token summary is sized explicitly')
  assert.match(source, /\.dsh-tokenlens-chart-layout-row>\.dsh-tokenlens-details\{[^}]*flex:1 1 100%/, 'the details card owns the full second row')
  assert.doesNotMatch(source, /\.dsh-tokenlens-dialog-grid/, 'the old three-column flex-wrap grid is gone')
  assert.match(source, /\.dsh-tokenlens-details\{/, 'the details card has its own style block')
  assert.match(source, /@media \(max-height:800px\)/, 'short screens get a compact density')
  assert.match(source, /@media \(max-height:720px\)/, 'the modal body padding shrinks further on very short screens')
  assert.match(source, /@media \(max-width:680px\)/, 'narrow screens fall back to one column')
  assert.doesNotMatch(source, /\.dsh-tokenlens-dialog\{[^}]*overflow-y:auto/, 'the dialog body must not need an internal scrollbar')
  assert.match(source, /\.dsh-tokenlens-details-toggle\{/, 'the DSH detail blocks have a collapse toggle')
  assert.match(source, /@media \(max-width:560px\)/, 'very narrow windows wrap rows instead of overflowing')
  assert.match(source, /\.dsh-tokenlens-modal\{[^}]*width:min\(1120px/, 'the shell owns an explicit, wider dialog panel')
  assert.match(source, /\.dsh-tokenlens-dialog\{[^}]*width:100%/, 'the dialog content fills the shell panel')
  assert.match(source, /\.dsh-tokenlens-overlay\{[^}]*position:fixed/, 'the shell is a fixed overlay (not a fit-content Modal)')
  // The provider list is a responsive grid: 3 columns in the wide panel, and the
  // old later `display:flex;flex-direction:column` override must be gone.
  assert.match(
    source,
    /\.dsh-tokenlens-providers\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(300px,1fr\)\)/,
    'provider cards use a responsive grid',
  )
  assert.equal(
    (source.match(/\.dsh-tokenlens-providers\{display:/g) ?? []).length,
    1,
    'exactly one .dsh-tokenlens-providers display rule remains (no override wins over the grid)',
  )
  assert.doesNotMatch(source, /\.dsh-tokenlens-providers\{display:flex/, 'the single-column flex override is gone')
  assert.match(source, /@media \(max-width:680px\)\{\.dsh-tokenlens-providers\{grid-template-columns:minmax\(0,1fr\)\}/, 'the provider grid collapses to one column when narrow')
})

test('the 数据 view uses the two-row layout: capacity+summary then full-width details', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    // v0.30.0: 数据 mode mirrors 图表 mode's explicit two-row layout.
    const layout = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout')
    assert.ok(layout, 'the 数据 view renders the explicit two-row layout')
    assert.equal(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-dialog-grid'),
      undefined,
      'the old three-column flex-wrap grid is gone',
    )
    const rows = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout-row')
    assert.equal(rows.length, 2, 'one row for capacity+summary and one for the details card')
    const hasClass = (element, name) =>
      typeof element?.props?.className === 'string' && element.props.className.split(/\s+/).includes(name)
    const capacity = findElement(rows[0], (element) => hasClass(element, 'dsh-tokenlens-capacity'))
    const summary = findElement(rows[0], (element) => hasClass(element, 'dsh-tokenlens-stats'))
    const details = findElement(rows[1], (element) => hasClass(element, 'dsh-tokenlens-details'))
    assert.ok(capacity && summary, 'the first row holds capacity + token summary')
    assert.ok(details, 'the second row holds the details card')

    // Left: provider-side capacity, including the last-updated line.
    const capacityText = textOf(capacity)
    assert.match(capacityText, /套餐容量/)
    assert.match(capacityText, /数据来自供应商接口（服务端权威）/)
    assert.match(capacityText, /上次更新：/)
    assert.equal(
      findAll(capacity, (element) => element.props?.['data-window'] !== undefined).length,
      3,
      'the three allowance windows stay in the first row',
    )

    // Middle: the local-token summary (head, subtitle, scope tabs, cards, toggle).
    const summaryText = textOf(summary)
    assert.match(summaryText, /本机 Token 用量/)
    assert.match(summaryText, /本机各 Harness 记录/)
    assert.match(summaryText, /当前供应商 · 全部 Harness/)
    assert.equal(findAll(summary, (element) => element.props?.className === 'dsh-tokenlens-card').length, 3)
    assert.ok(findElement(summary, (element) => element.props?.className === 'dsh-tokenlens-details-toggle'), 'the 更多明细 toggle sits in the summary')
    assert.equal(
      findAll(summary, (element) => element.props?.className === 'dsh-tokenlens-harness-breakdown').length,
      0,
      'the summary row holds the cards, not the breakdown rows',
    )

    // Full-width row 2: the details (按 Harness / 未映射 note / DSH by provider / top models).
    const detailsText = textOf(details)
    assert.match(detailsText, /明细/)
    assert.match(detailsText, /按 Harness/)
    assert.match(detailsText, /DSH 按供应商/)
    assert.match(detailsText, /DSH Top 模型/)
    assert.ok(detailsBlockOf(details, 'harness'), 'the harness column renders in the details row')
    assert.ok(detailsBlockOf(details, 'providers'), 'the DSH provider column renders in the details row')
    assert.ok(detailsBlockOf(details, 'models'), 'the top-model column renders in the details row')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-chart-layout-row>\.dsh-tokenlens-details\{[^}]*flex:1 1 100%/,
      'the details row is full width in both modes',
    )
  } finally {
    plugin.dispose()
  }
})

test('the dialog and management page render inline SVG icons and provider avatars', async () => {
  const plugin = loadPlugin()
  try {
    const usage = await settleDataDialog(plugin, 'opencode-go')
    const svgs = findAll(usage, (element) => element.type === 'svg')
    assert.ok(svgs.length >= 8, `the dialog carries a set of inline icons (found ${svgs.length})`)
    for (const svg of svgs) {
      assert.equal(svg.props['aria-hidden'], 'true', 'icons are decorative for assistive tech')
      assert.equal(svg.props.stroke, 'currentColor', 'icons inherit the surrounding color')
      assert.equal(svg.props.fill, 'none')
      assert.ok(Number.isFinite(svg.props.width) && svg.props.width >= 12 && svg.props.width <= 16, 'icons are 12–16px')
      assert.equal(svg.props.width, svg.props.height, 'icons are square')
      assert.ok(Array.isArray(svg.children) && svg.children.length >= 1, 'every icon has at least one path')
      assert.ok(
        svg.children.every((path) => path.type === 'path' && typeof path.props?.d === 'string' && path.props.d !== ''),
        'icons are drawn from path data only',
      )
      assert.equal(textOf(svg), '', 'icons never inject text into textOf assertions')
    }
    // The five named section-title icons and the two chrome icons are wired up.
    const titles = findAll(usage, (element) => element.props?.className === 'dsh-tokenlens-section-title')
    assert.equal(titles.length, 3, 'capacity / token summary / details each carry a title')
    for (const title of titles) {
      assert.equal(findAll(title, (element) => element.type === 'svg').length, 1, 'each title is prefixed with one icon')
    }
    assert.ok(findElement(manageButtonOf(usage), (element) => element.type === 'svg'), 'the 管理 button gets a gear icon')
    assert.ok(findElement(consoleLinkOf(usage), (element) => element.type === 'svg'), 'the console link gets an external-link icon')
    assert.ok(findElement(usage, (element) => element.props?.className === 'dsh-tokenlens-refresh'), 'the primitives refresh icon remains')

    const management = expandPresetSection(plugin, await settleManagementAll(plugin))
    const cards = providerCardsOf(management)
    const avatars = findAll(management, (element) => element.props?.className === 'dsh-tokenlens-avatar')
    assert.equal(avatars.length, cards.length, 'every provider card shows an avatar badge')
    assert.deepEqual(
      avatars.map((avatar) => textOf(avatar)),
      ['OC', 'CC', 'DS', 'DS', 'OR', 'MS'],
      'the avatar shows the 1–2 character short label',
    )
    for (const avatar of avatars) {
      assert.match(
        String(avatar.props.style?.backgroundColor ?? ''),
        /^hsl\(\d{1,3}, 46%, 34%\)$/,
        'the avatar color is a deterministic provider-id hash',
      )
    }
    assert.ok(
      new Set(avatars.map((avatar) => avatar.props.style.backgroundColor)).size >= 5,
      'different providers get different avatar colors',
    )
    // Re-rendering keeps the same provider → same color mapping.
    const again = renderDialog(plugin)
    assert.deepEqual(
      findAll(again, (element) => element.props?.className === 'dsh-tokenlens-avatar').map((avatar) => [
        avatar.props['data-provider-avatar'],
        avatar.props.style.backgroundColor,
      ]),
      avatars.map((avatar) => [avatar.props['data-provider-avatar'], avatar.props.style.backgroundColor]),
      'the avatar color is stable across renders',
    )
    // Kind badges, status pills and the label-style pills are icon-bearing.
    const kinds = findAll(management, (element) => element.props?.className === 'dsh-tokenlens-kind')
    assert.equal(kinds.length, cards.length)
    for (const kind of kinds) assert.equal(findAll(kind, (element) => element.type === 'svg').length, 1)
    const statuses = findAll(management, (element) => element.props?.className === 'dsh-tokenlens-provider-status')
    assert.equal(statuses.length, cards.length, 'one status pill per provider')
    for (const status of statuses) assert.equal(findAll(status, (element) => element.type === 'svg').length, 1)
    // The label-style pills moved to the 插件设置 tab (v0.29.0) and stay icon-bearing.
    const settingsTree = await switchManageTab(plugin, management, 'settings')
    assert.ok(manageTabOf(settingsTree, 'settings').props['data-active'] === 'true', 'the settings tab is active')
    for (const style of ['short', 'full']) {
      const option = labelStyleOptionOf(settingsTree, style)
      assert.ok(findElement(option, (element) => element.type === 'svg'), `the ${style} label-style pill carries an icon`)
    }
    const backToProviders = await switchManageTab(plugin, settingsTree, 'providers')
    // The editor hint rows and the action buttons (保存 / 测试连接 / 恢复默认名称)
    // carry icons too; no credential control exists any more (v0.14.0).
    const expanded = expandProvider(plugin, backToProviders, 'opencode-go')
    assert.ok(findElement(inheritedNoteOf(expanded, 'opencode-go'), (element) => element.type === 'svg'), 'the inherited note carries an icon')
    const unmanaged = expandProvider(plugin, expanded, 'openrouter')
    assert.ok(findElement(unmanagedHintOf(unmanaged, 'openrouter'), (element) => element.type === 'svg'), 'the unmanaged hint carries an icon')
    const actionButtons = [
      ['dsh-tokenlens-restore-labels', editorButtonOf(unmanaged, 'dsh-tokenlens-restore-labels')],
      ['dsh-tokenlens-save', editorButtonOf(unmanaged, 'dsh-tokenlens-save')],
      ['dsh-tokenlens-test', editorButtonOf(unmanaged, 'dsh-tokenlens-test')],
    ]
    for (const [name, button] of actionButtons) {
      assert.ok(button, `${name} is rendered`)
      assert.ok(findAll(button, (element) => element.type === 'svg').length >= 1, `${name} carries an icon`)
    }
  } finally {
    plugin.dispose()
  }
})

test('the DSH detail blocks collapse behind the details toggle', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const toggle = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle')
    assert.ok(toggle, 'the details toggle renders when provider/model details exist')
    assert.ok(detailsBlockOf(tree, 'models'), 'details start expanded on a tall viewport')
    toggle.props.onClick()
    const collapsed = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.equal(detailsBlockOf(collapsed, 'models'), undefined, 'models hide when collapsed')
    assert.equal(detailsBlockOf(collapsed, 'providers'), undefined, 'the DSH provider split hides when collapsed')
    const again = findElement(collapsed, (element) => element.props?.className === 'dsh-tokenlens-details-toggle')
    assert.ok(again, 'the toggle stays available to expand again')
    again.props.onClick()
    const expanded = dialogOf(plugin).component({ sessionId: 'session-1', t: plugin.t })
    assert.ok(detailsBlockOf(expanded, 'models'), 'expanding restores the details')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Every provider inherits Key / endpoint from DSH model settings (v0.14.0):
// no manual override, no credential inputs anywhere.
// ---------------------------------------------------------------------------

test('a DSH-managed provider shows the inherited note and no credential fields', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagement(plugin)
    tree = expandProvider(plugin, tree, 'opencode-go')

    assert.equal(providerInputOf(tree, 'data-provider-key', 'opencode-go'), undefined, 'no API-key input exists')
    assert.equal(providerInputOf(tree, 'data-provider-baseurl', 'opencode-go'), undefined, 'no Base-URL input exists')
    const note = inheritedNoteOf(tree, 'opencode-go')
    assert.ok(note, 'the compact inherited-info row replaces the removed inputs')
    assert.match(textOf(note), /Key 与接口地址继承自 DSH 模型设置（opencode-go\/opencode），无需在此重复填写/)
    assert.equal(findAll(note, (element) => element.type === 'svg').length, 1, 'the note carries one info icon')
    assert.equal(
      findElement(note, (element) => element.props?.['data-provider-override'] !== undefined),
      undefined,
      'the 「手动覆盖」 toggle is gone',
    )
    assert.equal(editorButtonOf(tree, 'dsh-tokenlens-save').props.disabled, true, 'nothing is dirty on first open')

    // Everything else in the editor keeps working for a managed provider.
    const card = providerCardOf(tree, 'opencode-go')
    assert.ok(providerInputOf(card, 'data-provider-enabled', 'opencode-go'), 'the enable toggle stays')
    assert.match(textOf(card), /已配置/, 'the status pill stays')
    assert.ok(providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go'), 'short-label editing stays')
    assert.ok(providerInputOf(tree, 'data-provider-label', 'opencode-go'), 'full-name editing stays')
    assert.ok(providerInputOf(tree, 'data-provider-consoleurl', 'opencode-go'), 'console-URL editing stays')
    assert.ok(editorButtonOf(tree, 'dsh-tokenlens-save'), '保存 stays')
    assert.ok(editorButtonOf(tree, 'dsh-tokenlens-test'), '测试连接 stays')
    assert.ok(editorButtonOf(tree, 'dsh-tokenlens-restore-labels'), '恢复默认名称 stays')

    // commandcode and deepseek are managed too: each note names its own route.
    tree = expandProvider(plugin, tree, 'commandcode')
    assert.match(textOf(inheritedNoteOf(tree, 'commandcode')), /（commandcode）/)
    tree = expandProvider(plugin, tree, 'deepseek')
    assert.match(textOf(inheritedNoteOf(tree, 'deepseek')), /（deepseek\/deepseek-official）/)
  } finally {
    plugin.dispose()
  }
})

test('an unmanaged provider hints at the DSH model-settings route id (zh + en)', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    for (const [providerId, label] of [
      ['openrouter', 'OpenRouter'],
      ['moonshot', 'Moonshot Kimi'],
    ]) {
      tree = expandProvider(plugin, tree, providerId)
      const hint = unmanagedHintOf(tree, providerId)
      assert.ok(hint, `${providerId}: the routing hint replaces the removed inputs`)
      assert.match(textOf(hint), /未在 DSH 模型设置中找到该供应商路由/)
      assert.match(textOf(hint), new RegExp(`建议路由 id：${providerId}`))
      assert.match(textOf(hint), /设置 → 模型服务/)
      assert.match(textOf(hint), /会自动复用其 Key 与地址/)
      assert.equal(findAll(hint, (element) => element.type === 'svg').length, 1, 'the hint carries one info icon')
      assert.equal(providerInputOf(tree, 'data-provider-key', providerId), undefined)
      assert.equal(providerInputOf(tree, 'data-provider-baseurl', providerId), undefined)
      assert.equal(inheritedNoteOf(tree, providerId), undefined, 'no inherited note without a DSH route')
      assert.match(textOf(providerCardOf(tree, providerId)), new RegExp(label), 'the card keeps its label')
    }

    // The en locale renders the same instruction through the component's `t` seat.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enBase = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    findElement(
      providerCardOf(enBase, 'openrouter'),
      (element) => element.props?.className === 'dsh-tokenlens-provider-toggle',
    ).props.onClick()
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    const enHint = unmanagedHintOf(enTree, 'openrouter')
    assert.ok(enHint, 'the en locale renders the same hint')
    assert.match(textOf(enHint), /No route for this provider was found in the DSH model settings/)
    assert.match(textOf(enHint), /suggested route id: openrouter/)
    assert.match(textOf(enHint), /Settings → Model services/)
  } finally {
    plugin.dispose()
  }
})

test('plugin-only providers show the routing hint with non-credential editing only', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'openrouter')
    assert.ok(unmanagedHintOf(tree, 'openrouter'), 'the plugin-only provider explains the missing DSH route')
    assert.equal(inheritedNoteOf(tree, 'openrouter'), undefined, 'no inherited note: there is no DSH route')
    assert.equal(providerInputOf(tree, 'data-provider-key', 'openrouter'), undefined)
    assert.equal(providerInputOf(tree, 'data-provider-baseurl', 'openrouter'), undefined)
    // Names and the display-only console URL stay editable.
    assert.ok(providerInputOf(tree, 'data-provider-shortlabel', 'openrouter'))
    assert.ok(providerInputOf(tree, 'data-provider-label', 'openrouter'))
    assert.ok(providerInputOf(tree, 'data-provider-consoleurl', 'openrouter'))

    // deepseek-account is neither DSH-model-managed nor a plugin-only key
    // provider: it keeps the account-service hint only.
    tree = expandProvider(plugin, tree, 'deepseek-account')
    assert.equal(providerInputOf(tree, 'data-provider-key', 'deepseek-account'), undefined)
    assert.equal(providerInputOf(tree, 'data-provider-baseurl', 'deepseek-account'), undefined)
    assert.equal(inheritedNoteOf(tree, 'deepseek-account'), undefined)
    assert.equal(unmanagedHintOf(tree, 'deepseek-account'), undefined)
    assert.match(textOf(providerCardOf(tree, 'deepseek-account')), /使用 DSH 账户服务，无需 API Key/)
  } finally {
    plugin.dispose()
  }
})

test('missing or junk dshManaged hints read as unmanaged and show the routing hint', async () => {
  const scenarios = [
    { name: 'no hints at all', patch: {} },
    { name: 'managed flag without a route id', patch: { dshManaged: true } },
    { name: 'route id without the managed flag', patch: { dshProviderId: 'opencode-go/opencode' } },
    { name: 'junk hints', patch: { dshManaged: 'yes', dshProviderId: 5 } },
  ]
  for (const scenario of scenarios) {
    const entry = providerEntry()
    delete entry.dshManaged
    delete entry.dshProviderId
    Object.assign(entry, scenario.patch)
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      if (payload.action === 'providers') return { ok: true, storeFile: '', providers: [entry] }
      return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    })
    try {
      let tree = await settleManagement(plugin)
      tree = expandProvider(plugin, tree, 'opencode-go')
      assert.equal(inheritedNoteOf(tree, 'opencode-go'), undefined, `${scenario.name}: no inherited note`)
      const hint = unmanagedHintOf(tree, 'opencode-go')
      assert.ok(hint, `${scenario.name}: the routing hint is shown`)
      assert.match(textOf(hint), /建议路由 id：opencode-go/, `${scenario.name}: the provider id is the suggested route`)
      assert.equal(providerInputOf(tree, 'data-provider-key', 'opencode-go'), undefined)
      assert.equal(providerInputOf(tree, 'data-provider-baseurl', 'opencode-go'), undefined)
    } finally {
      plugin.dispose()
    }
  }
})

test('switching cards keeps every editor credential-free and its hint correct', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementAll(plugin)
    tree = expandPresetSection(plugin, tree)
    tree = expandProvider(plugin, tree, 'opencode-go')
    assert.ok(inheritedNoteOf(tree, 'opencode-go'), 'the managed card shows the inherited note')
    // An unsaved name draft survives switching cards (there is no credential
    // state that could leak between editors any more).
    providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go').props.onChange({ target: { value: 'XY' } })
    tree = expandProvider(plugin, renderDialog(plugin), 'commandcode')
    assert.equal(providerInputOf(tree, 'data-provider-key', 'commandcode'), undefined)
    assert.ok(inheritedNoteOf(tree, 'commandcode'), 'the switched-to managed card shows its own note')
    tree = expandProvider(plugin, tree, 'opencode-go')
    assert.equal(
      providerInputOf(tree, 'data-provider-shortlabel', 'opencode-go').props.value,
      'XY',
      'the unsaved draft survives switching cards',
    )
    // The unmanaged provider renders its own hint; closing its card removes the
    // editor entirely instead of revealing any hidden credential row.
    tree = expandProvider(plugin, tree, 'moonshot')
    assert.ok(unmanagedHintOf(tree, 'moonshot'))
    findElement(
      providerCardOf(tree, 'moonshot'),
      (element) => element.props?.className === 'dsh-tokenlens-provider-toggle',
    ).props.onClick()
    tree = renderDialog(plugin)
    assert.equal(providerInputOf(tree, 'data-provider-shortlabel', 'moonshot'), undefined, 'the card is collapsed')
    assert.equal(
      findAll(tree, (element) => element.props?.['data-provider-editor'] !== undefined).length,
      0,
      'no editor (and no credential row) stays mounted',
    )
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// DSH model-settings discovery drives the management page (v0.15.0).
// ---------------------------------------------------------------------------

test('the management page leads with DSH model-settings providers', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    const dshSection = dshSectionOf(tree)
    assert.ok(dshSection, 'the DSH discovery section renders')
    const dshText = textOf(dshSection)
    assert.match(dshText, /DSH 模型设置中的供应商/)
    assert.match(dshText, /共 5 个/, 'the section counts every DSH route')
    assert.match(dshText, /来自 DSH「设置 → 模型服务」/, 'the section explains the inheritance')
    assert.deepEqual(
      findAll(dshSection, (element) => element.props?.className === 'dsh-tokenlens-provider-card').map(
        (card) => card.props['data-provider'],
      ),
      ['opencode-go', 'commandcode', 'deepseek'],
      'supported routes reuse the editable provider cards in DSH order',
    )
    // A supported DSH route keeps the full editable controls.
    const opencode = providerCardOf(dshSection, 'opencode-go')
    assert.ok(providerInputOf(opencode, 'data-provider-enabled', 'opencode-go'), 'the enable toggle stays')
    assert.ok(findElement(opencode, (element) => element.props?.className === 'dsh-tokenlens-provider-toggle'))
    // Read-only muted rows for DSH routes without a usage adapter, in DSH order.
    const unsupported = findAll(dshSection, (element) => element.props?.['data-dsh-route'] !== undefined)
    assert.deepEqual(
      unsupported.map((row) => row.props['data-dsh-route']),
      ['anthropic/claude', 'zai'],
      'unsupported DSH routes are listed after the supported cards',
    )
    assert.match(textOf(unsupported[0]), /Anthropic/)
    assert.match(textOf(unsupported[0]), /DSH 已配置，但插件暂时无法自动识别其用量接口/)
    for (const row of unsupported) {
      assert.equal(row.props['data-supported'], 'false')
      assert.equal(
        findAll(row, (element) => element.type === 'input' || element.type === 'button' || element.type === 'select')
          .length,
        0,
        'a DSH-only route has no controls',
      )
      assert.equal(findElement(row, (element) => element.props?.['data-provider-editor'] !== undefined), undefined)
    }
    // The preset adapters never mingle into the primary DSH section.
    assert.equal(providerCardOf(dshSection, 'openrouter'), undefined)
    // Section order inside 全部: DSH discovery first, plugin adapters second.
    const allTree = switchProviderFilter(plugin, tree, 'all')
    const view = findElement(allTree, (element) => element.props?.className === 'dsh-tokenlens-manage-view')
    const classOf = (child) => (typeof child?.props?.className === 'string' ? child.props.className : '')
    const indexes = view.children.map(classOf)
    const dshIndex = indexes.findIndex((className) => className.includes('dsh-tokenlens-dsh-section'))
    const presetIndex = indexes.findIndex((className) => className.includes('dsh-tokenlens-preset-section'))
    assert.ok(dshIndex >= 0 && presetIndex > dshIndex, 'the DSH section precedes the preset section')
  } finally {
    plugin.dispose()
  }
})

test('the preset adapter section is collapsed by default and expands on demand', async () => {
  const plugin = loadPlugin()
  try {
    // The preset section lives in the 全部 tab (v0.17.0).
    const tree = await settleManagementAll(plugin)
    const toggle = presetToggleOf(tree)
    assert.ok(toggle, 'the preset section toggle renders')
    assert.equal(toggle.props['aria-expanded'], 'false', 'collapsed by default')
    assert.match(textOf(toggle), /插件适配器（DSH 未配置）/)
    assert.match(textOf(toggle), /共 3 个/)
    assert.match(textOf(toggle), /展开/)
    assert.match(textOf(tree), /配置后，它们会自动移到上方的 DSH 列表/, 'the hint explains how to promote them')
    // Collapsed means the preset cards are not mounted at all.
    assert.equal(providerCardOf(tree, 'openrouter'), undefined)
    assert.equal(providerCardOf(tree, 'moonshot'), undefined)
    assert.equal(providerCardOf(tree, 'deepseek-account'), undefined)

    const expanded = expandPresetSection(plugin, tree)
    assert.equal(presetToggleOf(expanded).props['aria-expanded'], 'true')
    assert.match(textOf(presetToggleOf(expanded)), /收起/)
    assert.deepEqual(
      findAll(presetSectionOf(expanded), (element) => element.props?.className === 'dsh-tokenlens-provider-card').map(
        (card) => card.props['data-provider'],
      ),
      ['deepseek-account', 'openrouter', 'moonshot'],
      'the preset adapters render in Host order inside their own section',
    )
    // The two sections stay separate.
    assert.deepEqual(
      findAll(dshSectionOf(expanded), (element) => element.props?.className === 'dsh-tokenlens-provider-card').map(
        (card) => card.props['data-provider'],
      ),
      ['opencode-go', 'commandcode', 'deepseek'],
    )
    // Collapsing hides them again.
    presetToggleOf(expanded).props.onClick()
    const collapsed = renderDialog(plugin)
    assert.equal(presetToggleOf(collapsed).props['aria-expanded'], 'false')
    assert.equal(providerCardOf(collapsed, 'openrouter'), undefined)
  } finally {
    plugin.dispose()
  }
})

test('a DSH-only route never becomes an editable provider card', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    const row = dshUnsupportedRowOf(tree, 'anthropic/claude')
    assert.ok(row, 'the DSH-only route is listed')
    assert.equal(row.props['data-supported'], 'false')
    assert.match(textOf(row), /Anthropic/)
    assert.match(textOf(row), /DSH 已配置，但插件暂时无法自动识别其用量接口/)
    // No card, no enable toggle, no status pill: nothing actionable.
    assert.equal(providerCardOf(tree, 'anthropic/claude'), undefined, 'no editable card is created')
    assert.equal(providerInputOf(tree, 'data-provider-enabled', 'anthropic/claude'), undefined)
    assert.equal(providerInputOf(tree, 'data-provider-editor', 'anthropic/claude'), undefined)
    assert.equal(findElement(row, (element) => element.props?.className === 'dsh-tokenlens-provider-status'), undefined)
    assert.equal(findAll(row, (element) => element.type === 'button').length, 0, 'no buttons on a read-only route')
    // Cards exist only for the supported DSH routes.
    assert.equal(providerCardsOf(tree).length, 3)
  } finally {
    plugin.dispose()
  }
})

test('an old Host without dshProviders falls back to the flat preset list', async () => {
  const variants = [
    { name: 'absent', dshProviders: undefined },
    { name: 'junk', dshProviders: 'nonsense' },
  ]
  for (const variant of variants) {
    const plugin = loadPlugin((payload) => {
      if (payload.action === 'hello') return { ok: true }
      if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
      if (payload.action === 'providers') return providersFixture({ dshProviders: variant.dshProviders })
      return { ok: true, snapshot: snapshotFixture(payload.providerId) }
    })
    try {
      const tree = await settleManagement(plugin)
      assert.equal(dshSectionOf(tree), undefined, `${variant.name}: no DSH section without discovery data`)
      assert.equal(presetSectionOf(tree), undefined, `${variant.name}: no preset section either`)
      assert.deepEqual(
        providerCardsOf(tree).map((card) => card.props['data-provider']),
        ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot'],
        `${variant.name}: every preset adapter renders in the legacy flat list`,
      )
      assert.ok(providerCardOf(tree, 'openrouter'), `${variant.name}: the legacy list keeps the editable card`)
      assert.match(textOf(tree), /配置文件：/)
    } finally {
      plugin.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
// Custom usage-adapter form (v0.16.0).
// ---------------------------------------------------------------------------

test('deleting a custom adapter sends customProviderDelete and removes its card', async () => {
  const deletes = []
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixtureWithCustomEntry(customProviderEntry())
    if (payload.action === 'customProviderDelete') {
      deletes.push(payload)
      return providersFixture()
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagementAll(plugin)
    assert.equal(customAddButtonOf(tree), undefined, 'no 添加自定义用量适配器 entry point')
    assert.ok(customSectionOf(tree), 'the legacy custom adapter is listed in its own section')
    tree = expandCustomProvider(plugin, tree, 'my-gw')
    customDeleteButtonOf(tree, 'my-gw').props.onClick()
    await settle()

    assert.deepEqual(deletes[0], { action: 'customProviderDelete', providerId: 'my-gw' })
    tree = renderDialog(plugin)
    assert.equal(providerCardOf(tree, 'my-gw'), undefined, 'the deleted adapter disappears from the list')
    assert.equal(customSectionOf(tree), undefined, 'the empty custom section is removed')
  } finally {
    plugin.dispose()
  }
})

test('a custom adapter matching a DSH route is listed in the DSH section', async () => {
  const entry = customProviderEntry({ dshManaged: true, dshProviderId: 'my-gw' })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixtureWithDshCustom(entry)
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    const section = dshSectionOf(tree)
    assert.ok(providerCardOf(section, 'my-gw'), 'the custom adapter card lives in the DSH section')
    assert.equal(customSectionOf(tree), undefined, 'no separate custom section for a DSH-matched adapter')
    assert.ok(
      findElement(providerCardOf(section, 'my-gw'), (element) => element.props?.['data-custom-badge'] === 'my-gw'),
      'the card still carries the 自定义 badge',
    )
    tree = expandCustomProvider(plugin, tree, 'my-gw')
    assert.ok(
      findElement(tree, (element) => element.props?.['data-custom-hint'] === 'my-gw'),
      'the editor explains the custom provenance instead of the DSH inheritance note',
    )
    assert.equal(inheritedNoteOf(tree, 'my-gw'), undefined, 'a custom adapter does not show the inherited-Key note')
    assert.equal(findElement(tree, (element) => element.props?.['data-custom-edit'] !== undefined), undefined, 'the obsolete edit form is gone')
    assert.ok(customDeleteButtonOf(tree, 'my-gw'), 'delete stays available in the DSH section')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Provider-list filter tabs + management auto-sync (v0.17.0).
// ---------------------------------------------------------------------------

test('the management page defaults to the 已配置 filter tab', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    assert.deepEqual(
      findAll(tree, (element) => element.props?.['data-provider-filter'] !== undefined).map(
        (option) => option.props['data-provider-filter'],
      ),
      ['configured', 'builtin', 'all'],
      'the three filter tabs render in order',
    )
    assert.equal(providerFilterOf(tree, 'configured').props['data-active'], 'true', '已配置 is the default tab')
    assert.equal(providerFilterOf(tree, 'builtin').props['data-active'], 'false')
    assert.equal(providerFilterOf(tree, 'all').props['data-active'], 'false')
    // Only configured rows render: supported cards + unsupported gray rows.
    assert.deepEqual(
      providerCardsOf(tree).map((card) => card.props['data-provider']),
      ['opencode-go', 'commandcode', 'deepseek'],
    )
    assert.ok(dshSectionOf(tree), 'the DSH section renders inside 已配置')
    assert.ok(dshUnsupportedRowOf(tree, 'anthropic/claude'), 'DSH-only routes stay gray rows')
    assert.equal(providerCardOf(tree, 'openrouter'), undefined, 'presets are not part of 已配置')
    assert.equal(providerCardOf(tree, 'moonshot'), undefined)
    assert.equal(presetSectionOf(tree), undefined, 'the preset section is 全部-only')
    assert.equal(customSectionOf(tree), undefined)
    // The chrome around the list stays reachable.
    assert.ok(manageTabOf(tree, 'providers'), 'the 供应商配置 tab is rendered')
    assert.equal(manageTabOf(tree, 'providers').props['data-active'], 'true', '供应商配置 is the default tab')
    assert.ok(manageTabOf(tree, 'settings'), 'the 插件设置 tab is reachable')
    assert.equal(customAddButtonOf(tree), undefined, 'the 添加自定义用量适配器 button is gone')
    assert.match(textOf(tree), /配置文件：/, 'the store-file hint stays')
    // Switching tabs re-renders the list synchronously.
    const builtin = switchProviderFilter(plugin, tree, 'builtin')
    assert.equal(providerFilterOf(builtin, 'builtin').props['data-active'], 'true')
    assert.equal(providerFilterOf(builtin, 'configured').props['data-active'], 'false')
  } finally {
    plugin.dispose()
  }
})

test('the 内置 filter tab lists every built-in preset adapter', async () => {
  const plugin = loadPlugin()
  try {
    let tree = await settleManagementBuiltin(plugin)
    assert.equal(providerFilterOf(tree, 'builtin').props['data-active'], 'true')
    assert.match(textOf(tree), /内置供应商适配器/)
    assert.equal(dshSectionOf(tree), undefined, 'the DSH section belongs to 已配置/全部')
    assert.equal(customSectionOf(tree), undefined)
    assert.deepEqual(
      providerCardsOf(tree).map((card) => card.props['data-provider']),
      ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot'],
      'all built-in presets render in Host order',
    )
    // A DSH-configured builtin may appear in both tabs; its editor is unchanged.
    tree = expandProvider(plugin, tree, 'opencode-go')
    assert.ok(inheritedNoteOf(tree, 'opencode-go'), 'the inherited-Key note still works in 内置')
    tree = expandProvider(plugin, tree, 'openrouter')
    assert.ok(unmanagedHintOf(tree, 'openrouter'), 'an unconfigured preset keeps the DSH-routing hint')
  } finally {
    plugin.dispose()
  }
})

test('the 全部 filter tab is the deduped union with custom adapters last', async () => {
  const custom = customProviderEntry()
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixtureWithCustomEntry(custom)
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagementAll(plugin)
    assert.equal(providerFilterOf(tree, 'all').props['data-active'], 'true')
    tree = expandPresetSection(plugin, tree)
    const cards = providerCardsOf(tree)
    // DSH-configured rows first (DSH order), then unconfigured builtins (Host
    // order), custom-only adapters last.
    assert.deepEqual(
      cards.map((card) => card.props['data-provider']),
      ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot', 'my-gw'],
    )
    const ids = cards.map((card) => card.props['data-provider'])
    assert.equal(new Set(ids).size, ids.length, 'the union is deduped by providerId')
    assert.equal(
      cards.filter((card) => card.props['data-provider'] === 'opencode-go').length,
      1,
      'a DSH-configured builtin is listed exactly once in 全部',
    )
    const section = customSectionOf(tree)
    assert.ok(section, 'the custom-adapters section renders below the presets')
    assert.deepEqual(
      findAll(section, (element) => element.props?.className === 'dsh-tokenlens-provider-card').map(
        (card) => card.props['data-provider'],
      ),
      ['my-gw'],
      'custom-only adapters live in their own section',
    )
  } finally {
    plugin.dispose()
  }
})

test('an empty DSH configuration shows the 已配置 empty state and keeps 内置 available', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    // A new Host with no DSH model-settings route configured: an empty array,
    // which is different from an old Host that omits the field entirely.
    if (payload.action === 'providers') return providersFixture({ dshProviders: [] })
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleManagement(plugin)
    assert.equal(providerFilterOf(tree, 'configured').props['data-active'], 'true')
    const empty = configuredEmptyStateOf(tree)
    assert.ok(empty, 'the 已配置 tab renders its empty state')
    assert.match(textOf(empty), /暂无已配置的供应商/)
    assert.match(textOf(empty), /设置 → 模型服务/, 'the empty state explains how to add one')
    assert.equal(providerCardsOf(tree).length, 0, 'no configured cards')
    assert.equal(dshSectionOf(tree), undefined, 'no DSH section without configured routes')
    assert.equal(presetSectionOf(tree), undefined, 'presets do not mingle into 已配置')
    // 内置 still lists the presets.
    const builtin = switchProviderFilter(plugin, tree, 'builtin')
    assert.deepEqual(
      providerCardsOf(builtin).map((card) => card.props['data-provider']),
      ['opencode-go', 'commandcode', 'deepseek', 'deepseek-account', 'openrouter', 'moonshot'],
    )
  } finally {
    plugin.dispose()
  }
})

test('a new DSH provider arriving on a poll/focus refresh appears under 已配置', async () => {
  const extraRoutes = []
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') {
      const base = providersFixture()
      base.dshProviders = [...base.dshProviders, ...extraRoutes]
      return base
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleManagement(plugin)
    assert.equal(dshUnsupportedRowOf(tree, 'poll-route'), undefined)

    // The 15s poll repaints the 已配置 list from the fresh payload.
    const poll = plugin.intervals.find((entry) => entry.ms === 15000)
    assert.ok(poll, 'the management sync poll is installed')
    extraRoutes.push({ providerId: 'poll-route', label: 'Poll Route', supported: false, usageProviderId: null })
    poll.fn()
    await settle()
    const polled = renderDialog(plugin)
    assert.ok(dshUnsupportedRowOf(polled, 'poll-route'), 'the polled payload appears under 已配置')
    assert.match(textOf(dshUnsupportedRowOf(polled, 'poll-route')), /Poll Route/)

    // Returning to the page (window focus) refreshes immediately as well.
    assert.equal(plugin.hasWindowListener('focus'), true, 'the management page listens for window focus')
    extraRoutes.push({ providerId: 'focus-route', label: 'Focus Route', supported: true, usageProviderId: 'focus-route' })
    const before = plugin.calls.filter((call) => call.payload.action === 'providers').length
    plugin.fireWindowEvent('focus')
    await settle()
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'providers').length,
      before + 1,
      'window focus triggers one providers refresh',
    )
    const focused = renderDialog(plugin)
    assert.ok(dshUnsupportedRowOf(focused, 'focus-route'), 'the focused refresh repaints the list')
  } finally {
    plugin.dispose()
  }
})

test('the management sync refreshes when the page becomes visible again', async () => {
  const listeners = []
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (index >= 0) listeners.splice(index, 1)
    },
  }
  try {
    const plugin = loadPlugin()
    try {
      await settleManagement(plugin)
      const providerCalls = () => plugin.calls.filter((call) => call.payload.action === 'providers').length
      const before = providerCalls()
      globalThis.document.visibilityState = 'hidden'
      for (const listener of listeners.filter((entry) => entry.type === 'visibilitychange')) listener.fn()
      await settle()
      assert.equal(providerCalls(), before, 'a hidden page does not refresh the list')
      globalThis.document.visibilityState = 'visible'
      for (const listener of listeners.filter((entry) => entry.type === 'visibilitychange')) listener.fn()
      await settle()
      assert.equal(providerCalls(), before + 1, 'becoming visible refreshes the provider list')
    } finally {
      plugin.dispose()
    }
  } finally {
    delete globalThis.document
  }
})

test('the management sync timer is set up on open and cleared on close/dispose', async () => {
  const plugin = loadPlugin()
  try {
    await settleManagement(plugin)
    const syncTimer = plugin.intervals.find((entry) => entry.ms === 15000)
    assert.ok(syncTimer, 'a 15s providers poll runs while 管理 is open')
    const syncTimerId = plugin.intervals.indexOf(syncTimer) + 1
    assert.equal(plugin.hasWindowListener('focus'), true)

    // 返回 stops the sync (view closed, dialog still open).
    let tree = renderDialog(plugin)
    backButtonOf(tree).props.onClick()
    assert.ok(plugin.clearedIntervals.includes(syncTimerId), '返回 clears the management sync timer')
    assert.equal(plugin.hasWindowListener('focus'), false, '返回 detaches the focus listener')

    // Reopening starts a fresh timer; closing the dialog cleans it up too.
    tree = renderDialog(plugin)
    manageButtonOf(tree).props.onClick()
    await settle()
    const reopenedTimers = plugin.intervals.filter((entry) => entry.ms === 15000)
    assert.equal(reopenedTimers.length, 2, 'reopening installs a new sync timer')
    const reopenedId = plugin.intervals.indexOf(reopenedTimers[1]) + 1
    tree = renderDialog(plugin)
    findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-close').props.onClick()
    assert.ok(plugin.clearedIntervals.includes(reopenedId), 'closing the dialog clears the sync timer')
    assert.equal(plugin.hasWindowListener('focus'), false)

    // Disposal is the last-resort cleanup.
    clickChip(plugin, 'opencode-go')
    await settle()
    tree = renderDialog(plugin)
    manageButtonOf(tree).props.onClick()
    await settle()
    assert.equal(plugin.intervals.filter((entry) => entry.ms === 15000).length, 3)
    plugin.dispose()
    assert.equal(plugin.intervals.filter((entry) => entry.ms === 15000).length, 3, 'poll entries stay recorded')
    assert.equal(plugin.clearedIntervals.length >= 3, true, 'plugin disposal clears the sync timer')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Provider-scoped 最近X天 effective window (v0.22.0).
// ---------------------------------------------------------------------------

/** Stats payload with the v0.22.0 effective-window fields for opencode-go. */
function effectiveWindowStats() {
  return statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        subscribed: true,
        effectiveDay: '2026-10-15',
        effectiveDays: 12,
        today: bucket({ total: 11000000 }),
        last30Days: bucket({ total: 999000000 }),
        allTime: bucket({ total: 1200000000 }),
        sinceEffective: bucket({ total: 120000000 }),
        harnesses: {
          dsh: {
            today: bucket({ total: 10000000 }),
            last30Days: bucket({ total: 200000000 }),
            allTime: bucket({ total: 800000000 }),
            sinceEffective: bucket({ total: 100000000 }),
          },
          // Its effective window is empty, so this harness row must be filtered out.
          zcode: {
            today: bucket({ total: 1000000 }),
            last30Days: bucket({ total: 50000000 }),
            allTime: bucket({ total: 400000000 }),
            sinceEffective: bucket({ total: 0 }),
          },
        },
      },
      {
        providerId: 'commandcode',
        label: 'Command Code',
        subscribed: true,
        effectiveDay: '2026-10-20',
        effectiveDays: 7,
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 500000000 }),
        allTime: bucket({ total: 500000000 }),
        sinceEffective: bucket({ total: 20000000 }),
        harnesses: {},
      },
    ],
    models: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash',
        today: { total: 3000000 },
        last30Days: { total: 900000000 },
        allTime: { total: 1200000000 },
        sinceEffective: { total: 120000000 },
      },
    ],
    zcode: null,
    daily: [
      { day: '2026-10-20', total: { total: 5000000, messages: 0 }, providers: { 'opencode-go': { total: 5000000, messages: 0 } } },
      { day: '2026-10-21', total: { total: 12000000, messages: 0 }, providers: { 'opencode-go': { total: 12000000, messages: 0 } } },
      { day: '2026-10-22', total: { total: 11000000, messages: 0 }, providers: { 'opencode-go': { total: 11000000, messages: 0 } } },
    ],
  })
}

/** The token cards of a rendered dialog as text. */
function tokenCardsOf(tree) {
  return findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
}

/** One scope tab (`provider` / `all`) of the token section. */
function scopeTabOf(tree, scope) {
  return findElement(
    tree,
    (element) => element.props?.className === 'dsh-tokenlens-scope-option' && element.props['data-scope'] === scope,
  )
}

test('provider scope shows 最近X天 and reads the sinceEffective buckets', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: effectiveWindowStats() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    const cards = tokenCardsOf(tree)
    assert.equal(cards.length, 3)
    assert.match(cards[1], /最近12天/, 'the second card is labelled with the effective day count')
    assert.match(cards[1], /120\.000M/, 'the second card reads sinceEffective')
    assert.doesNotMatch(cards[1], /999\.000M/, 'last30Days does not leak into provider scope')
    assert.doesNotMatch(text, /最近30天/, 'the fixed 30-day label is replaced in provider scope')
    // The harness filter and cells follow the effective window.
    const harnessRows = findAll(tree, (element) => element.props?.['data-harness'] !== undefined)
    assert.deepEqual(
      harnessRows.map((row) => row.props['data-harness']),
      ['dsh'],
      'a harness whose effective window is empty is hidden',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '10.000M'], ['最近12天', '100.000M'], ['总计', '800.000M']],
      'harness cells use the split sinceEffective bucket',
    )
    // DSH provider rows and top models use their sinceEffective buckets too.
    assert.deepEqual(
      detailsRowCellsOf(tree, 'OpenCode'),
      [['今日', '11.000M'], ['最近12天', '120.000M'], ['总计', '1.200B']],
      'provider rows use their own sinceEffective bucket',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'Command Code'),
      [['今日', '0'], ['最近12天', '20.000M'], ['总计', '500.000M']],
      'another provider row keeps its own effective window',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'deepseek-v4.1-flash'),
      [['今日', '3.000M'], ['最近12天', '120.000M'], ['总计', '1.200B']],
      'model rows show today / sinceEffective / total',
    )
    // The en locale renders the same dynamic label.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.match(textOf(enTree), /Last 12d/, 'the en label is Last {n}d')
  } finally {
    plugin.dispose()
  }
})

test('all-harness scope keeps the fixed 最近30天 column', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: effectiveWindowStats() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    assert.match(textOf(tree), /最近12天/, 'provider scope starts on the effective window')
    scopeTabOf(tree, 'all').props.onClick()
    const allTree = renderDialog(plugin)
    const allText = textOf(allTree)
    const cards = tokenCardsOf(allTree)
    assert.equal(cards.length, 3)
    assert.match(cards[1], /最近30天/, 'all-harness scope keeps the fixed 30-day label')
    assert.match(cards[1], /7\.983B/, 'all-harness scope keeps the stats-level last30Days bucket')
    assert.doesNotMatch(allText, /最近12天/, 'the effective-window label does not leak into all-harness scope')
    assert.deepEqual(
      detailsRowCellsOf(allTree, 'deepseek-v4.1-flash'),
      [['最近30天', '900.000M'], ['总计', '1.200B']],
      'models keep the two-column 30-day / total form in all scope',
    )
  } finally {
    plugin.dispose()
  }
})

test('old Host stats fall back to last30Days and the 最近30天 label', async () => {
  // statsFixture() carries no effectiveDay/effectiveDays/sinceEffective fields.
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    const cards = tokenCardsOf(tree)
    assert.match(cards[1], /最近30天/, 'without an effective window the fixed label stays')
    assert.match(cards[1], /2\.260B/, 'and the last30Days value is used')
    assert.match(text, /今日 \/ 最近30天 \/ 总计|最近30天/, 'the effective-window headers stay')
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '489.200M'], ['最近30天', '920.000M'], ['总计', '1.800B']],
      'harness cells fall back to last30Days',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'OpenCode'),
      [['今日', '489.200M'], ['最近30天', '2.260B'], ['总计', '3.140B']],
      'provider rows fall back to last30Days',
    )
    // Without a subscription the second column is the model 30-day series.
    assert.deepEqual(
      detailsRowCellsOf(tree, 'deepseek-v4.1-flash'),
      [['今日', '300.000M'], ['最近30天', '500.000M'], ['总计', '662.840M']],
    )
  } finally {
    plugin.dispose()
  }
})

test('pay-as-you-go providers keep the 30-day column', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') {
      const stats = effectiveWindowStats()
      stats.providers[1].subscribed = false
      return { ok: true, stats }
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'commandcode')
    const cards = tokenCardsOf(tree)
    assert.match(cards[1], /最近30天/, 'no subscription -> fixed 30-day window')
    assert.match(cards[1], /500\.000M/, 'the last30Days bucket is used')
    assert.doesNotMatch(cards[1], /最近7天/, 'the effective window is not used')
  } finally {
    plugin.dispose()
  }
})

test('junk effective-window hints fall back to the 30-day column', async () => {
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        effectiveDay: 5,
        effectiveDays: '12',
        today: bucket({ total: 11000000 }),
        last30Days: bucket({ total: 220000000 }),
        allTime: bucket({ total: 1200000000 }),
        sinceEffective: 'nonsense',
        harnesses: {
          dsh: {
            today: bucket({ total: 11000000 }),
            last30Days: bucket({ total: 220000000 }),
            allTime: bucket({ total: 1200000000 }),
            sinceEffective: 'nonsense',
          },
        },
      },
    ],
    models: [],
    zcode: null,
  })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const text = textOf(tree)
    assert.match(tokenCardsOf(tree)[1], /最近30天/, 'a junk effectiveDays count keeps the 30-day label')
    assert.match(tokenCardsOf(tree)[1], /220\.000M/, 'junk sinceEffective falls back to last30Days')
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '11.000M'], ['最近30天', '220.000M'], ['总计', '1.200B']],
      'harness cells fall back to last30Days',
    )
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Subscription badge on management provider cards (v0.23.0).
// ---------------------------------------------------------------------------

/** The 已订阅 / 未订阅 badge of one provider card. */
function subscriptionBadgeOf(tree, providerId) {
  return findElement(tree, (element) => element.props?.['data-provider-subscription'] === providerId)
}

test('every management provider card carries a 已订阅 / 未订阅 badge', async () => {
  const custom = customProviderEntry({ subscribed: true })
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixtureWithCustomEntry(custom)
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleManagement(plugin)
    // Built-in / auto-mapped cards in the 已配置 tab.
    const subscribed = subscriptionBadgeOf(tree, 'opencode-go')
    assert.ok(subscribed, 'the auto-mapped DSH card carries the badge')
    assert.equal(subscribed.children.join(''), '已订阅')
    assert.equal(subscribed.props['data-subscribed'], 'true')
    assert.equal(subscribed.props['data-kind'], 'subscribed')
    assert.equal(subscribed.props.title, '已检测到套餐额度')
    assert.match(textOf(providerCardOf(tree, 'opencode-go')), /已订阅/, 'the badge sits on the card metadata line')

    const unsubscribed = subscriptionBadgeOf(tree, 'commandcode')
    assert.equal(unsubscribed.children.join(''), '未订阅')
    assert.equal(unsubscribed.props['data-subscribed'], 'false')
    assert.equal(unsubscribed.props['data-kind'], 'unsubscribed')
    assert.equal(unsubscribed.props.title, '未检测到订阅（余额/按量付费或尚未配置）')

    // Missing `subscribed` on the wire reads as 未订阅.
    const undefinedBadge = subscriptionBadgeOf(tree, 'deepseek')
    assert.equal(undefinedBadge.children.join(''), '未订阅', 'undefined subscribed reads as 未订阅')

    // Preset cards and custom cards carry it too (全部 tab).
    tree = expandPresetSection(plugin, switchProviderFilter(plugin, tree, 'all'))
    assert.equal(subscriptionBadgeOf(tree, 'openrouter').children.join(''), '未订阅')
    const customBadge = subscriptionBadgeOf(tree, 'my-gw')
    assert.ok(customBadge, 'the custom adapter card carries the badge')
    assert.equal(customBadge.children.join(''), '已订阅')
    assert.equal(customBadge.props['data-subscribed'], 'true')
    assert.ok(
      findElement(
        providerCardOf(tree, 'my-gw'),
        (element) => element.props?.['data-custom-badge'] === 'my-gw',
      ),
      'the subscription pill lives next to the 自定义 badge',
    )

    // Every rendered card has exactly one badge, always a short nowrap pill.
    const cards = providerCardsOf(tree)
    const badges = findAll(
      tree,
      (element) =>
        typeof element.props?.className === 'string' &&
        element.props.className.split(/\s+/).includes('dsh-tokenlens-subscription-badge'),
    )
    assert.equal(badges.length, cards.length, 'one badge per provider card')
    for (const badge of badges) {
      assert.match(badge.children.join(''), /^(已订阅|未订阅)$/, 'the pill text stays short')
      assert.ok(
        typeof badge.props.title === 'string' && badge.props.title !== '',
        'every badge has an explanatory tooltip',
      )
    }
    // The pill styling is a nowrap bordered pill, subscribed = positive color.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-subscription-badge\{[^}]*white-space:nowrap[^}]*border-radius:999px/,
      'the badge is a nowrap pill',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-subscription-badge\[data-kind=subscribed\]\{[^}]*color:#2e9e5b/,
      'the subscribed state uses the positive color',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-subscription-badge\{[^}]*flex:none/,
      'the pill never shrinks or wraps the metadata line',
    )
  } finally {
    plugin.dispose()
  }
})

test('the subscription badge is localized in en', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    const subscribed = subscriptionBadgeOf(enTree, 'opencode-go')
    assert.equal(subscribed.children.join(''), 'Subscribed')
    assert.equal(subscribed.props.title, 'Plan quota detected')
    const unsubscribed = subscriptionBadgeOf(enTree, 'commandcode')
    assert.equal(unsubscribed.children.join(''), 'Not subscribed')
    assert.equal(
      unsubscribed.props.title,
      'No subscription detected (balance / pay-as-you-go or not configured yet)',
    )
    assert.match(textOf(enTree), /Subscribed/, 'the en pill renders on the card')
    assert.equal(subscriptionBadgeOf(tree, 'opencode-go').props['data-subscribed'], 'true')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// 数据 / 图表 mode toggle with the daily token bar chart (v0.24.0).
// ---------------------------------------------------------------------------

/** `n` ascending YYYY-MM-DD days ending on `endDay` (UTC). */
function dayList(n, endDay = '2026-10-25') {
  const end = Date.parse(`${endDay}T00:00:00Z`)
  return Array.from({ length: n }, (_, index) =>
    new Date(end - (n - 1 - index) * 86400000).toISOString().slice(0, 10),
  )
}

/**
 * One daily-series entry: `total` tokens for the all-harness series and one
 * provider bucket (default `opencode-go`).
 */
function dailyEntry(day, index, options = {}) {
  const scale = options.scale ?? 1000000
  const providerId = options.providerId ?? 'opencode-go'
  const providerScale = options.providerScale ?? 500000
  const entry = {
    day,
    total: bucket({ total: scale * (index + 1), messages: index + 1 }),
    providers: {},
  }
  entry.providers[providerId] = bucket({ total: providerScale * (index + 1), messages: index + 1 })
  return entry
}

/** A plugin whose stats handler answers `stats`, with the standard providers/snapshots. */
function loadChartPlugin(stats) {
  return loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats }
    if (payload.action === 'providers') return providersFixture()
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
}

/** The right-aligned window values of one details row (v0.30.2). */
function windowValuesOf(row) {
  return findAll(row, (element) => element.props?.['data-window-value'] !== undefined).map((cell) => textOf(cell))
}

/** One 明细 row by its displayed name (harness / provider / model), or undefined. */
function detailsRowOf(tree, name) {
  return findElement(tree, (element) => element.props?.['data-details-row'] === name)
}

/** One 明细 column container (`harness` / `providers` / `models`). */
function detailsBlockOf(tree, block) {
  return findElement(tree, (element) => element.props?.['data-details-block'] === block)
}

/** The single window-label header row of a 明细 column (its `data-window-label` keys). */
function detailsWindowLabelsOf(tree, column) {
  const container = detailsBlockOf(tree, column)
  assert.ok(container, `the ${column} details column renders`)
  const head = findElement(container, (element) => element.props?.className === 'dsh-tokenlens-details-table-head')
  assert.ok(head, `the ${column} column has one label header row`)
  return findAll(head, (element) => element.props?.['data-window-label'] !== undefined).map(
    (label) => label.props['data-window-label'],
  )
}

/** The rendered header label texts of a 明细 column. */
function detailsWindowLabelTextsOf(tree, column) {
  const container = detailsBlockOf(tree, column)
  assert.ok(container, `the ${column} details column renders`)
  const head = findElement(container, (element) => element.props?.className === 'dsh-tokenlens-details-table-head')
  assert.ok(head, `the ${column} column has one label header row`)
  return findAll(head, (element) => element.props?.['data-window-label'] !== undefined).map((label) => textOf(label))
}

/**
 * The cells of one details row as `[header label, value]` pairs. The labels come
 * from the column's SINGLE header row (v0.30.2), so a row never repeats them.
 */
function detailsRowCellsOf(tree, name) {
  const row = detailsRowOf(tree, name)
  assert.ok(row, `the ${name} details row renders`)
  const values = windowValuesOf(row)
  let labels = []
  for (const column of ['harness', 'providers', 'models']) {
    const container = detailsBlockOf(tree, column)
    if (container === undefined) continue
    if (findElement(container, (element) => element.props?.['data-details-row'] === name) === row) {
      labels = detailsWindowLabelTextsOf(tree, column)
      break
    }
  }
  return values.map((value, index) => [labels[index] ?? `#${index}`, value])
}

/** Expand/collapse the DSH-only detail blocks (no-scroll responsive layout). */
function toggleStatsDetailsOf(tree) {
  return findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle')
}

/** The window-column header of the legacy wide tables (kept for old assertions). */
function statsViewOptionOf(tree, view) {
  return findElement(tree, (element) => element.props?.['data-stats-view'] === view)
}

/** Switch the token section to 数据 mode; returns the dialog tree after the click. */
function switchToDataView(plugin, tree) {
  const option = statsViewOptionOf(tree, 'data')
  assert.ok(option, 'the 数据 view toggle is rendered')
  if (option.props['data-active'] !== 'true') option.props.onClick()
  return renderDialog(plugin)
}

/** Render the usage dialog and switch the token section to 数据 mode. */
async function settleDataDialog(plugin, providerId = 'opencode-go') {
  const tree = await settleDialog(plugin, providerId)
  return switchToDataView(plugin, tree)
}

/** Every chart bar of the daily chart (v0.24.0). */
function chartBarsOf(tree) {
  return findAll(tree, (element) => element.props?.['data-chart-day'] !== undefined)
}

/** The chart summary cell (`total` / `peak`), or undefined. */
function chartSummaryOf(tree, cell) {
  return findElement(tree, (element) => element.props?.['data-chart-summary'] === cell)
}

/** The token cards of a rendered dialog. */
function tokenCardsOfTree(tree) {
  return findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
}

test('the token section defaults to 图表 mode and 数据 still renders the cards', async () => {
  const days = dayList(45)
  const daily = days.map((day, index) => dailyEntry(day, index))
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 24500000 }),
        last30Days: bucket({ total: 915000000 }),
        allTime: bucket({ total: 1035000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    // v0.28.0: the dialog opens in 图表 mode (daily chart + 明细 donuts).
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', '图表 is the default mode')
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'false')
    assert.equal(tokenCardsOfTree(tree).length, 0, 'the cards are hidden in the default chart mode')
    assert.equal(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle'),
      undefined,
      'the details toggle is hidden in chart mode',
    )
    assert.ok(findElement(tree, (element) => element.props?.['data-chart'] === 'true'), 'the chart renders on open')
    assert.ok(
      findElement(tree, (element) => element.props?.['data-donut-group'] !== undefined),
      'the 明细 donuts render on open',
    )
    const bars = chartBarsOf(tree)
    assert.equal(bars.length, 30, 'a non-subscribed provider charts the last 30 days')
    // The provider series (500K * index) is used, not the all-harness totals.
    assert.equal(bars[0].props['data-chart-total'], String(500000 * 16))
    assert.equal(bars[bars.length - 1].props['data-chart-total'], String(500000 * 45))
    assert.equal(bars[bars.length - 1].props['data-chart-day'], '2026-10-25')
    assert.equal(bars[bars.length - 1].props.title, '2026-10-25: 22.500M', 'bar title = date: precise tokens')
    assert.equal(bars[0].props.title, '2026-09-26: 8.000M')
    // Bars scale to the max; the largest bar tops out at 100%.
    assert.equal(
      findElement(bars[bars.length - 1], (element) => element.props?.className === 'dsh-tokenlens-chart-bar').props.style
        .height,
      '100%',
    )
    // Summary line: 合计 + 峰值 with 3-decimal formatting.
    const total = chartSummaryOf(tree, 'total')
    const peak = chartSummaryOf(tree, 'peak')
    assert.match(textOf(total), /合计 457\.500M/, 'the chart sums the shown window (30 * 8M..22.5M)')
    assert.match(textOf(peak), /峰值 22\.500M（2026-10-25）/, 'the peak names the best day')

    // Switching to 数据 renders the unchanged cards/details tables.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true')
    assert.equal(tokenCardsOfTree(tree).length, 3, '数据 mode renders the three token cards')
    assert.ok(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle'),
      '数据 mode renders the details toggle',
    )
    assert.equal(chartBarsOf(tree).length, 0, 'the chart is hidden in 数据 mode')
    assert.equal(
      findElement(tree, (element) => element.props?.['data-donut-group'] !== undefined),
      undefined,
      'no donut groups in 数据 mode',
    )
    // And 图表 restores the chart.
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(chartBarsOf(tree).length, 30, '图表 mode restores the chart')
  } finally {
    plugin.dispose()
  }
})

test('provider scope chart follows the subscribed effective window', async () => {
  const days = dayList(40)
  const daily = days.map((day, index) => dailyEntry(day, index, { scale: 2000000, providerScale: 1000000 }))
  const effectiveDay = days[35]
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        subscribed: true,
        effectiveDay,
        effectiveDays: 5,
        today: bucket({ total: 40000000 }),
        last30Days: bucket({ total: 765000000 }),
        allTime: bucket({ total: 820000000 }),
        sinceEffective: bucket({ total: 190000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const bars = chartBarsOf(tree)
    assert.equal(bars.length, 5, 'a subscribed provider charts only its effective window')
    assert.deepEqual(
      bars.map((bar) => bar.props['data-chart-day']),
      days.slice(35),
      'the window starts at the effective day',
    )
    assert.deepEqual(
      bars.map((bar) => bar.props['data-chart-total']),
      ['36000000', '37000000', '38000000', '39000000', '40000000'],
      'provider daily totals are used',
    )
    assert.match(textOf(chartSummaryOf(tree, 'total')), /合计 190\.000M/)
    assert.match(textOf(chartSummaryOf(tree, 'peak')), /峰值 40\.000M（2026-10-25）/)
    assert.equal(bars.length, 5, 'the effective window (not 30 days) is charted')
  } finally {
    plugin.dispose()
  }
})

test('provider scope chart keeps the last 30 days for a non-subscribed provider', async () => {
  const days = dayList(40)
  const daily = days.map((day, index) =>
    dailyEntry(day, index, { scale: 2000000, providerId: 'commandcode', providerScale: 3000000 }),
  )
  const stats = statsFixture({
    providers: [
      {
        providerId: 'commandcode',
        label: 'Command Code',
        subscribed: false,
        effectiveDay: days[2],
        effectiveDays: 38,
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 2850000000 }),
        allTime: bucket({ total: 2925000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'commandcode')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const bars = chartBarsOf(tree)
    assert.equal(bars.length, 30, 'a pay-as-you-go provider charts the fixed last 30 days')
    assert.equal(bars[0].props['data-chart-day'], days[10])
    assert.equal(bars[0].props['data-chart-total'], String(3000000 * 11), 'provider daily totals are used')
    assert.equal(bars[29].props['data-chart-total'], String(3000000 * 40))
    assert.match(textOf(chartSummaryOf(tree, 'total')), /合计 2\.295B/)
  } finally {
    plugin.dispose()
  }
})

test('all-harness scope charts the last 30 day totals', async () => {
  const days = dayList(40)
  // Provider buckets deliberately differ from the day totals.
  const daily = days.map((day, index) => dailyEntry(day, index, { scale: 2000000, providerScale: 1000000 }))
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 40000000 }),
        last30Days: bucket({ total: 765000000 }),
        allTime: bucket({ total: 820000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    scopeTabOf(tree, 'all').props.onClick()
    tree = renderDialog(plugin)
    const bars = chartBarsOf(tree)
    assert.equal(bars.length, 30, 'all-harness scope charts the last 30 days')
    assert.deepEqual(
      bars.map((bar) => bar.props['data-chart-total']),
      days.slice(10).map((day, index) => String(2000000 * (index + 11))),
      'the chart reads daily[].total.total, not a provider bucket',
    )
    assert.match(textOf(chartSummaryOf(tree, 'total')), /合计 1\.530B/)
    assert.match(textOf(chartSummaryOf(tree, 'peak')), /峰值 80\.000M（2026-10-25）/)
  } finally {
    plugin.dispose()
  }
})

test('chart mode shows a readable empty state when there is no daily data', async () => {
  const stats = statsFixture({ daily: [], models: [], zcode: null })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const empty = findElement(tree, (element) => element.props?.['data-chart-empty'] === 'true')
    assert.ok(empty, 'the chart renders its empty state')
    assert.match(textOf(empty), /暂无每日用量数据/, 'the empty state is readable')
    assert.equal(chartBarsOf(tree).length, 0, 'no bars are invented')
    assert.equal(chartSummaryOf(tree, 'total'), undefined, 'no fake summary line')
    assert.doesNotMatch(textOf(tree), /render failed|渲染失败/, 'the dialog is not degraded')
  } finally {
    plugin.dispose()
  }
})

test('图表 is the default and the toggle resets to it on every open/switch/management return', async () => {
  const days = dayList(35)
  const daily = days.map((day, index) => dailyEntry(day, index))
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 15000000 }),
        last30Days: bucket({ total: 465000000 }),
        allTime: bucket({ total: 630000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    // v0.28.0: the dialog opens in 图表 mode.
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', 'dialogs open in 图表 mode')
    assert.equal(chartBarsOf(tree).length, 30, 'the daily chart renders on open')
    // en labels for the toggle + chart summary.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.equal(textOf(statsViewOptionOf(enTree, 'data')), 'Data')
    assert.equal(textOf(statsViewOptionOf(enTree, 'chart')), 'Chart')
    assert.match(textOf(chartSummaryOf(enTree, 'total')), /Total /)
    assert.match(textOf(chartSummaryOf(enTree, 'peak')), /Peak /)

    // Regression: switch to 数据, close and reopen the dialog → 图表 again.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true', '数据 mode is reachable')
    assert.equal(tokenCardsOfTree(tree).length, 3, '数据 mode renders the cards')
    findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-close').props.onClick()
    clickChip(plugin, 'opencode-go')
    await settle()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', 'reopening starts in 图表 mode')
    assert.equal(chartBarsOf(tree).length, 30, 'the chart is back after reopening')
    assert.equal(tokenCardsOfTree(tree).length, 0, 'the cards are hidden again after reopening')

    // A provider switch also resets 数据 back to 图表.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true')
    renderChip(plugin, 'commandcode')
    await settle()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', 'provider switch resets to 图表')

    // Returning from 管理 resets 数据 back to 图表 as well.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true')
    manageButtonOf(tree).props.onClick()
    await settle()
    tree = renderDialog(plugin)
    assert.match(String(tree.props.title), /dsh-TokenLens · 词元透镜 · 管理页/, 'the management page is open')
    backButtonOf(tree).props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', 'management return resets to 图表')
  } finally {
    plugin.dispose()
  }
})

test('the view toggle sits in the 管理 toolbar', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDialog(plugin, 'opencode-go')
    const toolbar = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-toolbar')
    assert.ok(toolbar, 'the dialog has a top toolbar')
    const toggle = findElement(toolbar, (element) => element.props?.className === 'dsh-tokenlens-stats-view')
    assert.ok(toggle, 'the 数据/图表 toggle lives in the top toolbar')
    const manage = findElement(toolbar, (element) => element.props?.className === 'dsh-tokenlens-manage')
    assert.ok(manage, 'the 管理 button shares the toolbar')
    const scopeRow = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-scope-row')
    const scopeToggle = scopeRow === undefined ? undefined : findElement(scopeRow, (element) => element.props?.className === 'dsh-tokenlens-stats-view')
    assert.equal(scopeToggle, undefined, 'the toggle no longer sits in the scope row')
  } finally {
    plugin.dispose()
  }
})

test('window rows show the absolute reset date and icons are not clipped', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDialog(plugin, 'opencode-go')
    const dates = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-reset-date')
    assert.ok(dates.length >= 1, 'every window row carries an absolute reset date')
    assert.ok(dates.every((node) => typeof textOf(node) === 'string' && textOf(node).length > 0))
    assert.match(textOf(dates[0]), /\d{4}.+\d{1,2}.+\d{1,2}.+\d{1,2}:\d{2}/, 'the date includes a wall-clock time')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /\.dsh-tokenlens-icon\{[^}]*overflow:visible/, 'icon strokes are not clipped')
    assert.match(source, /\.dsh-tokenlens-icon\{[^}]*display:block/, 'the icon uses its own block box')
    assert.match(source, /\.dsh-tokenlens-reset-date\{[^}]*white-space:nowrap/, 'the date stays on one line')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Chart axes + realtime pointer readout (v0.25.0).
// ---------------------------------------------------------------------------

/** A 30-day stats payload for the chart axes/readout tests. */
function chartStats30() {
  const days = dayList(30)
  const daily = days.map((day, index) => {
    const entry = dailyEntry(day, index, { scale: 2000000, providerScale: 1000000 })
    entry.providers.commandcode = bucket({ total: 4000000 * (index + 1), messages: index + 1 })
    return entry
  })
  return statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 15000000 }),
        last30Days: bucket({ total: 465000000 }),
        allTime: bucket({ total: 465000000 }),
        harnesses: {},
      },
      {
        providerId: 'commandcode',
        label: 'Command Code',
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 1860000000 }),
        allTime: bucket({ total: 1860000000 }),
        harnesses: {},
      },
    ],
    daily,
    models: [],
    zcode: null,
  })
}

/** The chart plot container (the pointer-move surface), or undefined. */
function chartPlotOf(tree) {
  return findElement(tree, (element) => element.props?.['data-chart-plot'] === 'true')
}

/** The live chart readout, or undefined. */
function chartReadoutOf(tree) {
  return findElement(tree, (element) => element.props?.['data-chart-readout'] === 'true')
}

/** Simulate the pointer entering the centre of bar `index` on a plot element. */
function movePointerTo(plot, index, count, plotWidth = 300) {
  const rect = { left: 40, width: plotWidth, height: 160 }
  plot.props.onMouseMove({
    currentTarget: { getBoundingClientRect: () => rect },
    clientX: 40 + (index + 0.5) * (plotWidth / count),
  })
}

test('the chart renders Y-axis ticks, gridlines and MM-DD X labels', async () => {
  const plugin = loadChartPlugin(chartStats30())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const yTicks = findAll(tree, (element) => element.props?.['data-chart-tick'] !== undefined)
    assert.equal(yTicks.length, 5, 'five Y-axis ticks including 0 and the max')
    assert.deepEqual(
      yTicks.map((node) => textOf(node)),
      ['30.000M', '22.500M', '15.000M', '7.500M', '0'],
      'tick labels use the precise 3-decimal formatter (max → 0)',
    )
    const gridlines = findAll(tree, (element) => element.props?.['data-chart-gridline'] !== undefined)
    assert.equal(gridlines.length, 5, 'one horizontal gridline per Y tick')
    const xLabels = findAll(tree, (element) => element.props?.['data-chart-axis-day'] !== undefined)
    assert.deepEqual(
      xLabels.map((label) => textOf(label)),
      ['09-26', '10-02', '10-08', '10-14', '10-20', '10-25'],
      'long series gets sensible MM-DD labels including first and last',
    )
    assert.equal(xLabels[0].props['data-chart-axis-day'], '2026-09-26')
    assert.equal(xLabels[xLabels.length - 1].props['data-chart-axis-day'], '2026-10-25')

    // A week-long series labels every single day.
    const thinDays = dayList(7)
    const thinStats = statsFixture({
      providers: [
        {
          providerId: 'opencode-go',
          label: 'OpenCode',
          today: bucket({ total: 7000000 }),
          last30Days: bucket({ total: 28000000 }),
          allTime: bucket({ total: 28000000 }),
          harnesses: {},
        },
      ],
      daily: thinDays.map((day, index) => dailyEntry(day, index, { providerScale: 1000000 })),
      models: [],
      zcode: null,
    })
    const thinPlugin = loadChartPlugin(thinStats)
    try {
      let thinTree = await settleDialog(thinPlugin, 'opencode-go')
      statsViewOptionOf(thinTree, 'chart').props.onClick()
      thinTree = renderDialog(thinPlugin)
      assert.equal(
        findAll(thinTree, (element) => element.props?.['data-chart-axis-day'] !== undefined).length,
        7,
        'a week-long series labels every day',
      )
      assert.deepEqual(
        findAll(thinTree, (element) => element.props?.['data-chart-tick'] !== undefined).map((node) => textOf(node)),
        ['7.000M', '5.250M', '3.500M', '1.750M', '0'],
        'Y ticks scale to the smaller max',
      )
    } finally {
      thinPlugin.dispose()
    }

    // Static: the left gutter / gridlines / no-scrollbar layout rules exist.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /\.dsh-tokenlens-chart-yaxis\{[^}]*width:58px/, 'the Y-axis owns a fixed left gutter')
    assert.match(source, /\.dsh-tokenlens-chart-gridline\{[^}]*border-top:1px dashed/, 'horizontal gridlines are drawn')
    assert.match(source, /\.dsh-tokenlens-chart-bars\{[^}]*overflow:hidden/, 'the chart never becomes scrollable')
    assert.match(source, /\.dsh-tokenlens-chart-readout\{[^}]*position:absolute/, 'the live readout floats above the bars')
  } finally {
    plugin.dispose()
  }
})

test('pointer movement shows the nearest bar data continuously and mouseleave clears it', async () => {
  const points = dayList(30)
  const plugin = loadChartPlugin(chartStats30())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(chartReadoutOf(tree), undefined, 'no readout before the pointer moves')
    let plot = chartPlotOf(tree)
    assert.ok(plot, 'the plot container accepts pointer movement')

    // Move to the middle of bar #5: the nearest bar is highlighted and the
    // readout shows its date + precise value + share (1M..30M series).
    movePointerTo(plot, 5, 30)
    tree = renderDialog(plugin)
    let readout = chartReadoutOf(tree)
    assert.ok(readout, 'the live readout appears on pointer move')
    assert.equal(textOf(readout), `${points[5]} · 6.000M（1.3%）`, 'nearest bar #5 readout')
    let bars = chartBarsOf(tree)
    assert.equal(bars[5].props['data-chart-hover'], 'true', 'the nearest bar is highlighted')
    assert.equal(bars[4].props['data-chart-hover'], 'false')
    const crosshair = findElement(tree, (element) => element.props?.['data-chart-crosshair'] !== undefined)
    assert.equal(crosshair.props['data-chart-crosshair'], '5', 'a crosshair marks the hovered bar')

    // Moving within another bar updates the readout continuously.
    plot = chartPlotOf(tree)
    movePointerTo(plot, 20, 30)
    tree = renderDialog(plugin)
    readout = chartReadoutOf(tree)
    assert.equal(textOf(readout), `${points[20]} · 21.000M（4.5%）`, 'moving updates the readout')
    bars = chartBarsOf(tree)
    assert.equal(bars[20].props['data-chart-hover'], 'true')
    assert.equal(bars[5].props['data-chart-hover'], 'false', 'only the nearest bar stays highlighted')

    // The rightmost pixel still resolves to the last bar.
    plot = chartPlotOf(tree)
    plot.props.onMouseMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 40, width: 300, height: 160 }) },
      clientX: 339,
    })
    tree = renderDialog(plugin)
    assert.equal(
      findElement(tree, (element) => element.props?.['data-chart-crosshair'] !== undefined).props[
        'data-chart-crosshair'
      ],
      '29',
      'the edge of the plot hits the last bar',
    )

    // Mouse leave clears both the readout and the highlight.
    plot = chartPlotOf(tree)
    plot.props.onMouseLeave()
    tree = renderDialog(plugin)
    assert.equal(chartReadoutOf(tree), undefined, 'the readout disappears on mouse leave')
    assert.equal(
      findAll(tree, (element) => element.props?.['data-chart-hover'] === 'true').length,
      0,
      'no bar stays highlighted after leaving',
    )
    assert.equal(findElement(tree, (element) => element.props?.['data-chart-crosshair'] !== undefined), undefined)
  } finally {
    plugin.dispose()
  }
})

test('chart hover works in both scopes and resets on scope/view/provider changes', async () => {
  const plugin = loadChartPlugin(chartStats30())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    movePointerTo(chartPlotOf(tree), 3, 30)
    tree = renderDialog(plugin)
    assert.match(textOf(chartReadoutOf(tree)), /4\.000M/, 'provider scope reads the provider daily bucket')

    // All-harness scope: hover state resets and the day totals are read instead.
    scopeTabOf(tree, 'all').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(chartReadoutOf(tree), undefined, 'switching scope clears the hover readout')
    movePointerTo(chartPlotOf(tree), 3, 30)
    tree = renderDialog(plugin)
    assert.match(textOf(chartReadoutOf(tree)), /8\.000M/, 'all-harness scope reads the day total')
    assert.doesNotMatch(textOf(chartReadoutOf(tree)), /4\.000M/, 'the provider bucket is not used in all scope')

    // Switching to 数据 and back to 图表 clears the hover again.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(chartPlotOf(tree), undefined, '数据 mode has no chart')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(chartReadoutOf(tree), undefined, 'the hover is reset when the view changes')

    // A provider switch resets the hover too.
    movePointerTo(chartPlotOf(tree), 4, 30)
    tree = renderDialog(plugin)
    assert.ok(chartReadoutOf(tree), 'hover is active before the provider change')
    renderChip(plugin, 'commandcode')
    await settle()
    tree = renderDialog(plugin)
    assert.equal(chartReadoutOf(tree), undefined, 'switching providers clears the hover readout')
  } finally {
    plugin.dispose()
  }
})

test('the chart readout is localized in en and empty series stay axis-free', async () => {
  const days = dayList(30)
  const plugin = loadChartPlugin(chartStats30())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    movePointerTo(chartPlotOf(tree), 2, 30)
    tree = renderDialog(plugin)
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    const enReadout = chartReadoutOf(enTree)
    assert.ok(enReadout, 'the en locale renders the live readout')
    assert.equal(textOf(enReadout), `${days[2]} · 3.000M (0.6%)`, 'the en readout uses the en template')
    assert.doesNotMatch(textOf(enReadout), /（/, 'the en readout uses plain parentheses')
    assert.equal(
      findAll(enTree, (element) => element.props?.['data-chart-tick'] !== undefined).length,
      5,
      'axes render in both locales',
    )
    assert.equal(
      findAll(enTree, (element) => element.props?.['data-chart-axis-day'] !== undefined).length,
      6,
      'X-axis labels are language-neutral MM-DD',
    )
  } finally {
    plugin.dispose()
  }

  // Empty series: no axes, no plot, no readout — just the readable empty state.
  const emptyPlugin = loadChartPlugin(statsFixture({ daily: [], models: [], zcode: null }))
  try {
    let tree = await settleDialog(emptyPlugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(emptyPlugin)
    assert.ok(findElement(tree, (element) => element.props?.['data-chart-empty'] === 'true'))
    assert.equal(chartPlotOf(tree), undefined, 'no plot surface without data')
    assert.equal(findAll(tree, (element) => element.props?.['data-chart-tick'] !== undefined).length, 0)
    assert.equal(findAll(tree, (element) => element.props?.['data-chart-axis-day'] !== undefined).length, 0)
    assert.equal(chartReadoutOf(tree), undefined)
    assert.doesNotMatch(textOf(tree), /render failed|渲染失败/)
  } finally {
    emptyPlugin.dispose()
  }
})

test('chart mode renders the 明细 column with donut share groups', async () => {
  const plugin = loadChartPlugin(effectiveWindowStats())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    assert.ok(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-section dsh-tokenlens-details'), 'data mode keeps the table details')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    assert.ok(findElement(tree, (element) => element.props?.['data-chart'] === 'true'), 'chart mode keeps the daily trend chart')
    const details = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-section dsh-tokenlens-details')
    assert.ok(details, 'chart mode keeps the details column')
    assert.ok(findAll(tree, (element) => element.props?.['data-breakdown-chart'] !== undefined).length >= 1, 'the breakdown chart groups render')
    assert.ok(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout-row'), 'the breakdown rows are horizontal bars')
  } finally {
    plugin.dispose()
  }
})

test('chart mode lays the details column out as its own row', async () => {
  const plugin = loadChartPlugin(effectiveWindowStats())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    // v0.28.0: dialogs open directly in 图表 mode; v0.30.0 keeps the two-row
    // layout for BOTH views.
    assert.ok(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout'),
      'the default 图表 mode uses the explicit two-row layout',
    )
    const rows = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout-row')
    assert.equal(rows.length, 2, 'one row for capacity+chart and one for details')
    assert.ok(findElement(rows[0], (element) => (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-capacity')), 'the top row starts with capacity')
    assert.ok(findElement(rows[0], (element) => (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-stats')), 'the top row carries the daily chart')
    assert.ok(findElement(rows[1], (element) => element.props?.className === 'dsh-tokenlens-section dsh-tokenlens-details'), 'the second row is the details card')
    assert.ok(
      findAll(tree, (element) => element.props?.['data-donut-group'] !== undefined).length >= 1,
      'the details charts render donut share groups',
    )
    assert.ok(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-donut-svg'),
      'the donut SVG renders',
    )
    assert.equal(
      findAll(tree, (element) => element.props?.['data-breakdown-chart'] !== undefined).length,
      findAll(tree, (element) => element.props?.['data-donut-group'] !== undefined).length,
      'one donut group per breakdown chart group',
    )
    // 数据 mode now uses the same two-row layout (v0.30.0), just with tables.
    tree = switchToDataView(plugin, tree)
    const dataLayout = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout')
    assert.ok(dataLayout, '数据 mode keeps the explicit two-row layout')
    assert.equal(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-dialog-grid'),
      undefined,
      'the old three-column grid is gone',
    )
    const dataRows = findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-layout-row')
    assert.equal(dataRows.length, 2)
    assert.ok(findElement(dataRows[1], (element) => (element.props?.className ?? '').includes('dsh-tokenlens-details')), 'the data details card is the full-width second row')
    assert.equal(findElement(tree, (element) => element.props?.['data-donut-group'] !== undefined), undefined, 'no donut groups in 数据 mode')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /\.dsh-tokenlens-chart-layout-row>\.dsh-tokenlens-details\{[^}]*flex:1 1 100%/, 'the details row is full width')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// 明细 donut charts + ranked legends (v0.27.0).
// ---------------------------------------------------------------------------

/** Stats whose three 明细 groups have known, easily asserted proportions. */
function donutStatsFixture() {
  return statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 80000000 }),
        allTime: bucket({ total: 80000000 }),
        harnesses: {
          dsh: { today: null, last30Days: bucket({ total: 60000000 }), allTime: bucket({ total: 60000000 }) },
          zcode: { today: null, last30Days: bucket({ total: 20000000 }), allTime: bucket({ total: 20000000 }) },
        },
      },
      {
        providerId: 'commandcode',
        label: 'Command Code',
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 20000000 }),
        allTime: bucket({ total: 20000000 }),
        harnesses: {},
      },
    ],
    models: [
      {
        key: 'opencode-go/model-a',
        providerId: 'opencode-go',
        modelId: 'model-a',
        today: null,
        last30Days: bucket({ total: 75000000 }),
        allTime: bucket({ total: 75000000 }),
      },
      {
        key: 'opencode-go/model-b',
        providerId: 'opencode-go',
        modelId: 'model-b',
        today: null,
        last30Days: bucket({ total: 25000000 }),
        allTime: bucket({ total: 25000000 }),
      },
    ],
    zcode: null,
  })
}

/** Every donut group of the rendered chart-mode details. */
function donutGroupsOf(tree) {
  return findAll(tree, (element) => element.props?.['data-donut-group'] !== undefined)
}

/** One donut group by its key (`harness-chart` / `provider-chart` / `model-chart`). */
function donutGroupOf(tree, key) {
  return findElement(tree, (element) => element.props?.['data-donut-group'] === key)
}

/** The text of every legend cell of one donut group (title tooltips excluded). */
function legendCellsOf(group, className) {
  return findAll(group, (element) => element.props?.className === className).map((element) =>
    (element.children ?? []).map((child) => String(child)).join(''),
  )
}

test('the 明细 donuts render proportional segments, centre totals and ranked legends', async () => {
  const circumference = 2 * Math.PI * 38
  const plugin = loadChartPlugin(donutStatsFixture())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)

    const groups = donutGroupsOf(tree)
    assert.deepEqual(
      groups.map((group) => group.props['data-donut-group']),
      ['harness-chart', 'provider-chart', 'model-chart'],
      'all three groups render donuts',
    )
    // Each group has exactly one donut SVG and one segment per ranked row.
    for (const group of groups) {
      assert.equal(
        findAll(group, (element) => element.props?.className === 'dsh-tokenlens-donut-svg').length,
        1,
        'one donut SVG per group',
      )
      assert.equal(
        findAll(group, (element) => element.props?.['data-donut-segment'] !== undefined).length,
        2,
        'one ring segment per row',
      )
    }

    // Centre totals use the precise 3-decimal formatter.
    assert.equal(textOf(donutGroupOf(tree, 'harness-chart')), textOf(donutGroupOf(tree, 'harness-chart')))
    assert.equal(
      textOf(findElement(donutGroupOf(tree, 'harness-chart'), (element) => element.props?.['data-donut-total'] !== undefined)),
      '80.000M',
      'harness centre total',
    )
    assert.equal(
      textOf(findElement(donutGroupOf(tree, 'provider-chart'), (element) => element.props?.['data-donut-total'] !== undefined)),
      '100.000M',
      'provider centre total',
    )
    assert.equal(
      textOf(findElement(donutGroupOf(tree, 'model-chart'), (element) => element.props?.['data-donut-total'] !== undefined)),
      '100.000M',
      'model centre total',
    )

    // Segments are proportional (dash length = circumference * share) and use
    // the fixed palette.
    const harnessSegments = findAll(
      donutGroupOf(tree, 'harness-chart'),
      (element) => element.props?.['data-donut-segment'] !== undefined,
    )
    const dashLength = (segment) => Number.parseFloat(String(segment.props['stroke-dasharray']).split(' ')[0])
    assert.ok(Math.abs(dashLength(harnessSegments[0]) - circumference * 0.75) < 0.01, 'first segment is 75% of the ring')
    assert.ok(Math.abs(dashLength(harnessSegments[1]) - circumference * 0.25) < 0.01, 'second segment is 25% of the ring')
    assert.equal(harnessSegments[0].props['data-donut-ratio'], '0.7500')
    assert.equal(harnessSegments[0].props.stroke, '#22c55e', 'fixed palette colour #1')
    assert.equal(harnessSegments[1].props.stroke, '#3b82f6', 'fixed palette colour #2')
    assert.equal(harnessSegments[0].props['stroke-width'], 10, 'segments form a ring stroke')

    // Ranked legend beside the donut: label (with title tooltip), 1-decimal
    // percentage and precise value, colours matching the segments.
    const harnessGroup = donutGroupOf(tree, 'harness-chart')
    assert.deepEqual(legendCellsOf(harnessGroup, 'dsh-tokenlens-donut-legend-label'), ['DSH', 'ZCode'], 'ranked by value')
    assert.deepEqual(legendCellsOf(harnessGroup, 'dsh-tokenlens-donut-legend-percent'), ['75.0%', '25.0%'])
    assert.deepEqual(legendCellsOf(harnessGroup, 'dsh-tokenlens-donut-legend-value'), ['60.000M', '20.000M'])
    assert.equal(
      findAll(harnessGroup, (element) => element.props?.className === 'dsh-tokenlens-donut-legend-label')[0].props.title,
      'DSH',
      'the truncated label keeps a full title tooltip',
    )
    assert.deepEqual(
      findAll(harnessGroup, (element) => element.props?.className === 'dsh-tokenlens-donut-dot').map(
        (dot) => dot.props.style.backgroundColor,
      ),
      ['#22c55e', '#3b82f6'],
      'legend dots share the segment palette',
    )

    const providerGroup = donutGroupOf(tree, 'provider-chart')
    assert.deepEqual(legendCellsOf(providerGroup, 'dsh-tokenlens-donut-legend-label'), ['OpenCode', 'Command Code'])
    assert.deepEqual(legendCellsOf(providerGroup, 'dsh-tokenlens-donut-legend-percent'), ['80.0%', '20.0%'])
    assert.deepEqual(legendCellsOf(providerGroup, 'dsh-tokenlens-donut-legend-value'), ['80.000M', '20.000M'])
    const modelGroup = donutGroupOf(tree, 'model-chart')
    assert.deepEqual(legendCellsOf(modelGroup, 'dsh-tokenlens-donut-legend-label'), ['model-a', 'model-b'])
    assert.deepEqual(legendCellsOf(modelGroup, 'dsh-tokenlens-donut-legend-percent'), ['75.0%', '25.0%'])
    assert.deepEqual(legendCellsOf(modelGroup, 'dsh-tokenlens-donut-legend-value'), ['75.000M', '25.000M'])

    // No leftover vertical mini bars, and the three groups sit in one row.
    assert.equal(findAll(tree, (element) => element.props?.['data-mini-bar'] !== undefined).length, 0)
    const grid = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-charts-grid')
    assert.ok(grid, 'the donut groups share the full-width details grid')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\.dsh-tokenlens-mini-bar/, 'the old mini-bar styles are gone')
    assert.match(
      source,
      /\.dsh-tokenlens-details-charts-grid>\.dsh-tokenlens-chart-group,\.dsh-tokenlens-details-charts>\.dsh-tokenlens-chart-group\{flex:1 1 260px/,
      'groups share the row at flex 1 1 260px',
    )
    assert.match(source, /\.dsh-tokenlens-donut-legend-label\{[^}]*text-overflow:ellipsis/, 'long legend labels truncate')
    assert.match(source, /\.dsh-tokenlens-donut-wrap\{[^}]*flex-wrap:wrap/, 'the donut+legend pair wraps on narrow screens')
    assert.match(source, /@media \(max-width:680px\)\{\.dsh-tokenlens-donut-wrap/, 'the narrow layout collapses to one column')
  } finally {
    plugin.dispose()
  }
})

test('single-row donuts draw a full ring and empty groups are omitted', async () => {
  const circumference = 2 * Math.PI * 38
  const stats = statsFixture({
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 0 }),
        last30Days: bucket({ total: 50000000 }),
        allTime: bucket({ total: 50000000 }),
        harnesses: {
          dsh: { today: null, last30Days: bucket({ total: 50000000 }), allTime: bucket({ total: 50000000 }) },
        },
      },
    ],
    models: [],
    zcode: null,
  })
  const plugin = loadChartPlugin(stats)
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    assert.deepEqual(
      donutGroupsOf(tree).map((group) => group.props['data-donut-group']),
      ['harness-chart', 'provider-chart'],
      'the empty model group is omitted',
    )
    for (const group of donutGroupsOf(tree)) {
      const segments = findAll(group, (element) => element.props?.['data-donut-segment'] !== undefined)
      assert.equal(segments.length, 1, 'a single row renders one segment')
      assert.ok(
        Math.abs(Number.parseFloat(String(segments[0].props['stroke-dasharray']).split(' ')[0]) - circumference) < 0.01,
        'a 100% row draws the full ring',
      )
      assert.equal(segments[0].props['data-donut-ratio'], '1.0000')
      assert.deepEqual(legendCellsOf(group, 'dsh-tokenlens-donut-legend-percent'), ['100.0%'])
    }
    // An empty stats payload renders the readable hint instead of empty donuts.
    const emptyPlugin = loadChartPlugin(
      statsFixture({
        today: bucket(),
        last30Days: bucket(),
        allTime: bucket(),
        providers: [],
        harnesses: [],
        models: [],
        daily: [],
        zcode: null,
      }),
    )
    try {
      let emptyTree = await settleDialog(emptyPlugin, 'opencode-go')
      statsViewOptionOf(emptyTree, 'chart').props.onClick()
      emptyTree = renderDialog(emptyPlugin)
      assert.equal(donutGroupsOf(emptyTree).length, 0, 'no donut group without data')
      assert.match(textOf(emptyTree), /没有 Token 使用记录|暂无/, 'the empty hint stays readable')
    } finally {
      emptyPlugin.dispose()
    }
  } finally {
    plugin.dispose()
  }
})

test('chart-mode top models keep every model a data-mode table would show', async () => {
  const plugin = loadChartPlugin(statsFixture())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const text = textOf(tree)
    assert.match(text, /deepseek-v4\.1-flash/, 'the first top model stays visible')
    assert.match(text, /Kimi-K3/, 'a model from another provider stays visible too')
  } finally {
    plugin.dispose()
  }
})

test('the chart summary adds today and the active window stats', async () => {
  const plugin = loadChartPlugin(effectiveWindowStats())
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    statsViewOptionOf(tree, 'chart').props.onClick()
    tree = renderDialog(plugin)
    const summary = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-summary')
    assert.ok(summary, 'the chart summary renders')
    const summaryText = textOf(summary)
    assert.match(summaryText, /今日 11\.000M/, 'provider scope shows today tokens')
    assert.match(summaryText, /最近12天 120\.000M/, 'provider scope shows the subscribed effective window')
    assert.match(summaryText, /合计/, 'the series total stays')
    assert.match(summaryText, /峰值/, 'the peak stays')
    // All-harness scope uses the fixed 30-day window.
    scopeTabOf(tree, 'all').props.onClick()
    tree = renderDialog(plugin)
    const allSummary = textOf(findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-summary'))
    assert.match(allSummary, /最近30天 7\.983B/, 'all-harness scope keeps the 30-day window')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Management tabs + 插件设置 defaults (v0.29.0).
// ---------------------------------------------------------------------------

test('the management page splits into 供应商配置 and 插件设置 tabs', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleManagement(plugin)
    assert.deepEqual(
      findAll(tree, (element) => element.props?.['data-manage-tab'] !== undefined).map(
        (option) => option.props['data-manage-tab'],
      ),
      ['providers', 'settings'],
      'the two management tabs render in order',
    )
    assert.equal(manageTabOf(tree, 'providers').props['data-active'], 'true', '供应商配置 is the default tab')
    assert.equal(manageTabOf(tree, 'settings').props['data-active'], 'false')
    assert.ok(providerCardsOf(tree).length > 0, 'the provider list lives on the first tab')
    assert.equal(
      findElement(tree, (element) => element.props?.['data-settings-panel'] === 'true'),
      undefined,
      'the settings panel is not on the provider tab',
    )

    // Switching tabs re-renders the same modal body synchronously.
    const settingsTree = await switchManageTab(plugin, tree, 'settings')
    assert.equal(manageTabOf(settingsTree, 'settings').props['data-active'], 'true')
    assert.equal(manageTabOf(settingsTree, 'providers').props['data-active'], 'false')
    assert.ok(
      findElement(settingsTree, (element) => element.props?.['data-settings-panel'] === 'true'),
      'the 插件设置 panel renders',
    )
    assert.equal(providerCardsOf(settingsTree).length, 0, 'provider cards stay on 供应商配置')
    for (const field of ['labelStyle', 'defaultView', 'defaultScope', 'detailsExpanded']) {
      assert.ok(settingsRowOf(settingsTree, field), `the ${field} settings row renders`)
    }
    assert.ok(manageTabOf(settingsTree, 'providers'), 'the first tab stays reachable')
    const providersAgain = await switchManageTab(plugin, settingsTree, 'providers')
    assert.ok(providerCardsOf(providersAgain).length > 0, 'switching back restores the provider list')

    // Leaving and reopening the management page resets to 供应商配置.
    backButtonOf(providersAgain).props.onClick()
    const usage = renderDialog(plugin)
    manageButtonOf(usage).props.onClick()
    await settle()
    const reopened = renderDialog(plugin)
    assert.equal(manageTabOf(reopened, 'providers').props['data-active'], 'true', '管理 reopens on 供应商配置')
  } finally {
    plugin.dispose()
  }
})

test('插件设置 shows the current values and saves the FULL settings on every change', async () => {
  let settings = { labelStyle: 'short', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto' }
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture({ settings })
    if (payload.action === 'settingsUpdate') {
      settings = { ...settings, ...payload.settings }
      return providersFixture({ settings })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleSettingsTab(plugin)
    for (const [field, value] of [
      ['labelStyle', 'short'],
      ['defaultView', 'chart'],
      ['defaultScope', 'provider'],
      ['detailsExpanded', 'auto'],
    ]) {
      assert.ok(settingsRowOf(tree, field), `${field} row exists`)
      assert.equal(
        settingOptionOf(tree, field, value).props['data-active'],
        'true',
        `${field} shows its persisted value`,
      )
    }

    // Every change sends the FULL four-field settings object.
    settingOptionOf(tree, 'defaultView', 'data').props.onClick()
    await settle()
    assert.deepEqual(lastCallWith(plugin, 'settingsUpdate'), {
      action: 'settingsUpdate',
      settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'provider', detailsExpanded: 'auto' },
    })
    tree = renderDialog(plugin)
    assert.equal(settingOptionOf(tree, 'defaultView', 'data').props['data-active'], 'true', 'the answered value is adopted')

    settingOptionOf(tree, 'defaultScope', 'all').props.onClick()
    await settle()
    assert.deepEqual(lastCallWith(plugin, 'settingsUpdate'), {
      action: 'settingsUpdate',
      settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'all', detailsExpanded: 'auto' },
    })

    settingOptionOf(tree, 'detailsExpanded', 'collapsed').props.onClick()
    await settle()
    assert.deepEqual(lastCallWith(plugin, 'settingsUpdate'), {
      action: 'settingsUpdate',
      settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'all', detailsExpanded: 'collapsed' },
    })

    settingOptionOf(tree, 'labelStyle', 'full').props.onClick()
    await settle()
    assert.deepEqual(lastCallWith(plugin, 'settingsUpdate'), {
      action: 'settingsUpdate',
      settings: { labelStyle: 'full', defaultView: 'data', defaultScope: 'all', detailsExpanded: 'collapsed' },
    })
    assert.equal(
      plugin.calls.filter((call) => call.payload.action === 'settingsUpdate').length,
      4,
      'each selector change saves once',
    )

    // Back in the usage dialog the new defaults apply: 数据 view, all scope and
    // collapsed details.
    tree = renderDialog(plugin)
    backButtonOf(tree).props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true', 'defaultView=data applies on return')
    assert.equal(tokenCardsOfTree(tree).length, 3, 'the 数据 cards render')
    assert.equal(scopeTabOf(tree, 'all').props['data-active'], 'true', 'defaultScope=all applies')
    assert.equal(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-models'),
      undefined,
      'detailsExpanded=collapsed hides the detail blocks',
    )
    // Reopening keeps the persisted defaults.
    findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-close').props.onClick()
    clickChip(plugin, 'opencode-go')
    await settle()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true', 'the 数据 default survives reopening')
  } finally {
    plugin.dispose()
  }
})

test('插件设置 renders settingsUpdate errors and 恢复默认设置 sends the defaults', async () => {
  let fail = true
  let settings = { labelStyle: 'short', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto' }
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') return providersFixture({ settings })
    if (payload.action === 'settingsUpdate') {
      if (fail) {
        return {
          __httpStatus: 500,
          __body: {
            ok: false,
            error: {
              code: 'unsupported-provider',
              message: 'settings.defaultView must be one of chart, data',
              retryable: false,
            },
          },
        }
      }
      settings = { ...settings, ...payload.settings }
      return providersFixture({ settings })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleSettingsTab(plugin)
    settingOptionOf(tree, 'defaultView', 'data').props.onClick()
    await settle()
    tree = renderDialog(plugin)
    const error = findElement(tree, (element) => element.props?.['data-settings-error'] === 'true')
    assert.ok(error, 'the inline error banner renders')
    assert.match(textOf(error), /当前模型供应商不受用量插件支持/, 'the localized error is shown')
    assert.match(textOf(error), /settings.defaultView must be one of/, 'the Host message is shown')
    assert.equal(settingOptionOf(tree, 'defaultView', 'chart').props['data-active'], 'true', 'the failed change is not adopted')
    assert.equal(settingOptionOf(tree, 'defaultView', 'data').props.disabled, false, 'the selector is usable for a retry')

    // 「恢复默认设置」 sends the full Host defaults in one payload.
    fail = false
    findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-settings-reset').props.onClick()
    await settle()
    assert.deepEqual(lastCallWith(plugin, 'settingsUpdate'), {
      action: 'settingsUpdate',
      settings: { labelStyle: 'full', defaultView: 'chart', defaultScope: 'provider', detailsExpanded: 'auto' },
    })
    tree = renderDialog(plugin)
    assert.equal(settingOptionOf(tree, 'labelStyle', 'full').props['data-active'], 'true', 'the defaults are adopted')
    assert.equal(settingOptionOf(tree, 'defaultView', 'chart').props['data-active'], 'true')
    assert.equal(
      findElement(tree, (element) => element.props?.['data-settings-error'] === 'true'),
      undefined,
      'a successful save clears the error banner',
    )
    assert.match(textOf(tree), /配置文件：/, 'the store path is shown in 插件设置')
  } finally {
    plugin.dispose()
  }
})

test('the dialog applies the configured default scope and details expansion', async () => {
  // collapsed details + all-harness scope, opening in 数据 so the tables render.
  const collapsedPlugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') {
      return providersFixture({
        settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'all', detailsExpanded: 'collapsed' },
      })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleDialog(collapsedPlugin, 'opencode-go')
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true', 'defaultView=data applies')
    assert.equal(scopeTabOf(tree, 'all').props['data-active'], 'true', 'defaultScope=all applies')
    const toggle = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle')
    assert.ok(toggle, 'the details toggle still renders')
    assert.equal(toggle.props['aria-expanded'], false, 'detailsExpanded=collapsed starts collapsed')
    assert.equal(
      detailsBlockOf(tree, 'models'),
      undefined,
      'the model details are hidden',
    )
    // The manual toggle still overrides the default for this dialog.
    toggle.props.onClick()
    tree = renderDialog(collapsedPlugin)
    assert.ok(
      detailsBlockOf(tree, 'models'),
      'the user can still expand the details manually',
    )
  } finally {
    collapsedPlugin.dispose()
  }

  // expanded details: the detail blocks start visible even on short viewports.
  const expandedPlugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: statsFixture() }
    if (payload.action === 'providers') {
      return providersFixture({
        settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'provider', detailsExpanded: 'expanded' },
      })
    }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDialog(expandedPlugin, 'opencode-go')
    assert.equal(
      findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-details-toggle').props['aria-expanded'],
      true,
      'detailsExpanded=expanded starts expanded',
    )
    assert.ok(
      detailsBlockOf(tree, 'models'),
      'the model details render by default',
    )
  } finally {
    expandedPlugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// 最近7天 window (v0.30.0).
// ---------------------------------------------------------------------------

/** Stats with the optional rolling 7-day buckets on every row the UI reads. */
function weeklyStatsFixture(overrides = {}) {
  const dshToday = bucket({ total: 6000000, messages: 60 })
  const dshWeek = bucket({ total: 40000000, messages: 400 })
  const dshMonth = bucket({ total: 150000000, messages: 1500 })
  const dshAll = bucket({ total: 400000000, messages: 4000 })
  const zcodeToday = bucket({ total: 4000000, messages: 40 })
  const zcodeWeek = bucket({ total: 30000000, messages: 300 })
  const zcodeMonth = bucket({ total: 50000000, messages: 500 })
  const zcodeAll = bucket({ total: 100000000, messages: 1000 })
  return statsFixture({
    today: bucket({ total: 15000000, messages: 150 }),
    last7Days: bucket({ total: 70000000, messages: 700 }),
    last30Days: bucket({ total: 200000000, messages: 2000 }),
    allTime: bucket({ total: 500000000, messages: 5000 }),
    providers: [
      {
        providerId: 'opencode-go',
        label: 'OpenCode',
        today: bucket({ total: 10000000, messages: 100 }),
        last7Days: bucket({ total: 70000000, messages: 700 }),
        last30Days: bucket({ total: 200000000, messages: 2000 }),
        allTime: bucket({ total: 500000000, messages: 5000 }),
        harnesses: {
          dsh: { today: dshToday, last7Days: dshWeek, last30Days: dshMonth, allTime: dshAll },
          zcode: { today: zcodeToday, last7Days: zcodeWeek, last30Days: zcodeMonth, allTime: zcodeAll },
        },
      },
      {
        providerId: 'commandcode',
        label: 'Command Code',
        today: bucket({ total: 5000000, messages: 50 }),
        last7Days: bucket({ total: 35000000, messages: 350 }),
        last30Days: bucket({ total: 120000000, messages: 1200 }),
        allTime: bucket({ total: 300000000, messages: 3000 }),
        harnesses: {},
      },
    ],
    harnesses: [
      { harnessId: 'dsh', label: 'DSH', today: dshToday, last7Days: dshWeek, last30Days: dshMonth, allTime: dshAll },
      { harnessId: 'zcode', label: 'ZCode', today: zcodeToday, last7Days: zcodeWeek, last30Days: zcodeMonth, allTime: zcodeAll },
    ],
    models: [
      {
        key: 'opencode-go/model-x',
        providerId: 'opencode-go',
        modelId: 'model-x',
        today: bucket({ total: 3000000 }),
        last7Days: bucket({ total: 20000000 }),
        last30Days: bucket({ total: 90000000 }),
        allTime: bucket({ total: 250000000 }),
      },
    ],
    daily: [],
    zcode: null,
    ...overrides,
  })
}

/** The rendered text of every token card, in order. */
function cardTextsOf(tree) {
  return findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-card').map((card) => textOf(card))
}

/** The header labels of one breakdown block (`harness` / `providers` / `models`). */
function breakdownHeaderOf(tree, className) {
  const block = findElement(tree, (element) =>
    (element.props?.className ?? '').split(' ').includes(className),
  )
  const head = findElement(block, (element) => (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-breakdown-head'))
  return head === undefined ? '' : textOf(head)
}

test('数据 mode shows 今日 / 最近7天 / 最近X天 / 总计 cards and table columns', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: weeklyStatsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleDataDialog(plugin, 'opencode-go')
    const cards = cardTextsOf(tree)
    assert.equal(cards.length, 4, 'the 7-day card joins today / second window / total')
    assert.match(cards[0], /今日10\.000M/, 'today card keeps 3-decimal formatting')
    assert.match(cards[1], /最近7天70\.000M/, 'the 7-day card reads the provider 7-day bucket')
    assert.match(cards[1], /700/, 'the 7-day card shows its request count')
    assert.match(cards[2], /最近30天200\.000M/, 'the second card keeps the 30-day window')
    assert.match(cards[3], /总计500\.000M/)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'DSH'),
      [['今日', '6.000M'], ['最近7天', '40.000M'], ['最近30天', '150.000M'], ['总计', '400.000M']],
      'harness cells include 7 days',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'ZCode'),
      [['今日', '4.000M'], ['最近7天', '30.000M'], ['最近30天', '50.000M'], ['总计', '100.000M']],
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'OpenCode'),
      [['今日', '10.000M'], ['最近7天', '70.000M'], ['最近30天', '200.000M'], ['总计', '500.000M']],
      'provider rows include 7 days',
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'Command Code'),
      [['今日', '5.000M'], ['最近7天', '35.000M'], ['最近30天', '120.000M'], ['总计', '300.000M']],
    )
    assert.deepEqual(
      detailsRowCellsOf(tree, 'model-x'),
      [['今日', '3.000M'], ['最近7天', '20.000M'], ['最近30天', '90.000M'], ['总计', '250.000M']],
      'model cells include 7 days',
    )

    // All-harness scope: the cards use the stats-level buckets and the model
    // table becomes 最近7天 / 最近30天 / 总计.
    scopeTabOf(tree, 'all').props.onClick()
    tree = renderDialog(plugin)
    const allCards = cardTextsOf(tree)
    assert.equal(allCards.length, 4)
    assert.match(allCards[0], /今日15\.000M/)
    assert.match(allCards[1], /最近7天70\.000M/)
    assert.match(allCards[2], /最近30天200\.000M/)
    assert.match(allCards[3], /总计500\.000M/)
    assert.deepEqual(
      detailsRowCellsOf(tree, 'model-x'),
      [['最近7天', '20.000M'], ['最近30天', '90.000M'], ['总计', '250.000M']],
      'all-scope model cells include 7 days',
    )
    // en label parity.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.match(textOf(enTree), /Last 7 days/, 'the en label is Last 7 days')
    assert.match(textOf(enTree), /Last 30 days/)
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Data-mode 明细: one row of three compact columns (v0.30.1).
// ---------------------------------------------------------------------------

test('数据 mode 明细 stacks three full-width breakdown blocks vertically', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: weeklyStatsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    // v0.30.0 layout: ONE columns wrapper with three full-width blocks.
    const wrapper = findElement(tree, (element) => element.props?.['data-details-columns'] === 'true')
    assert.ok(wrapper, 'the 明细 card has one columns wrapper')
    assert.equal(wrapper.children.length, 3, 'the columns wrapper holds exactly three blocks')
    const blocks = findAll(tree, (element) => element.props?.['data-details-block'] !== undefined)
    assert.deepEqual(
      blocks.map((block) => block.props['data-details-block']),
      ['harness', 'providers', 'models'],
      'the three groups stack vertically in order',
    )
    assert.equal(
      findAll(tree, (element) => (element.props?.className ?? '') === 'dsh-tokenlens-details-columns').length,
      1,
      'the one-row three-column wrapper is present',
    )
    assert.deepEqual(wrapper.props.style?.gridTemplateColumns, 'minmax(320px,1fr) minmax(0,1.15fr) minmax(0,1.35fr)', 'the wrapper uses the deterministic three-column grid')
    assert.equal(
      findAll(tree, (element) => element.props?.['data-details-column'] !== undefined).length,
      0,
      'no column containers remain',
    )
    // Each block owns its icon/title head and exactly one full-width table.
    const titles = blocks.map((block) => {
      const head = findElement(block, (element) => (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-breakdown-head'))
      assert.ok(head, 'each block carries a group head')
      const tables = findAll(block, (element) => element.props?.['data-details-table'] === 'true')
      assert.equal(tables.length, 1, 'each block owns exactly one real table')
      assert.equal(tables[0].type, 'table')
      return textOf(head)
    })
    assert.deepEqual(titles, ['按 Harness', 'DSH 按供应商', 'DSH Top 模型'])
    assert.equal(findAll(tree, (element) => element.props?.['data-details-table'] === 'true').length, 3)
    // Each table has exactly ONE window-label header row with full labels.
    assert.deepEqual(detailsWindowLabelTextsOf(tree, 'harness'), ['今日', '最近7天', '最近30天', '总计'])
    assert.deepEqual(detailsWindowLabelTextsOf(tree, 'providers'), ['今日', '最近7天', '最近30天', '总计'])
    assert.deepEqual(detailsWindowLabelTextsOf(tree, 'models'), ['今日', '最近7天', '最近30天', '总计'])
    for (const block of blocks) {
      const heads = findAll(block, (element) => element.props?.className === 'dsh-tokenlens-details-table-head')
      assert.equal(heads.length, 1, 'one label header row per block')
      const rows = findAll(block, (element) =>
        (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-details-table-row'),
      )
      assert.ok(rows.length > 0, 'each block has data rows')
      for (const row of rows) {
        assert.equal(findAll(row, (element) => element.props?.['data-window-label'] !== undefined).length, 0, 'rows never repeat the window labels')
      }
    }
    // Rows carry only the four aligned values.
    const harnessRows = findAll(blocks[0], (element) => element.props?.['data-harness'] !== undefined)
    assert.equal(harnessRows.length, 2, 'the harness block lists DSH + ZCode')
    assert.deepEqual(windowValuesOf(harnessRows[0]), ['6.000M', '40.000M', '150.000M', '400.000M'])
    const providerRows = findAll(blocks[1], (element) =>
      (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-details-table-row'),
    )
    assert.equal(providerRows.length, 2, 'the provider block lists both providers')
    assert.deepEqual(windowValuesOf(providerRows[0]), ['10.000M', '70.000M', '200.000M', '500.000M'])
    const modelRows = findAll(blocks[2], (element) =>
      (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-model-row'),
    )
    assert.equal(modelRows.length, 1, 'the model block lists the top model')
    assert.deepEqual(windowValuesOf(modelRows[0]), ['3.000M', '20.000M', '90.000M', '250.000M'])
    // Request counts moved into the row tooltip instead of cluttering the row.
    const harnessNameCell = findElement(
      harnessRows[0],
      (element) => element.props?.className === 'dsh-tokenlens-details-table-name',
    )
    assert.match(String(harnessNameCell.props.title), /共 4,000 次请求/, 'the harness request count lives in the tooltip')
    assert.equal(harnessRows[0].type, 'tr', 'each item is ONE table row')
    assert.equal(harnessRows[0].props.className.includes('dsh-tokenlens-details-table-row'), true)
    assert.equal(harnessRows[0].children.length, 5, 'one row = name td + four value tds')
    const nameTd = harnessRows[0].children[0]
    assert.equal(nameTd.type, 'td')
    assert.equal(nameTd.props.colSpan, undefined, 'item rows never use a colspan name row')
    assert.deepEqual(
      harnessRows[0].children.slice(1).map((cell) => cell.props.className),
      ['dsh-tokenlens-details-table-cell', 'dsh-tokenlens-details-table-cell', 'dsh-tokenlens-details-table-cell', 'dsh-tokenlens-details-table-cell'],
    )
    assert.doesNotMatch(windowValuesOf(harnessRows[0]).join(''), /次请求/, 'the request count is not repeated inline')
    const nameSpan = findElement(harnessRows[0], (element) => element.props?.className === 'dsh-tokenlens-details-table-name')
    assert.match(nameSpan.props.title, /DSH/, 'the truncated name keeps a full-name tooltip')
    // en header labels use the short forms (Today / 7d / 30d / Total).
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.deepEqual(detailsWindowLabelTextsOf(enTree, 'harness'), ['Today', 'Last 7 days', 'Last 30 days', 'All time'])
    // The old wide value cells and per-row labelled grids are gone.
    assert.equal(findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-breakdown-value').length, 0)
    assert.equal(findAll(tree, (element) => element.props?.className === 'dsh-tokenlens-model-value').length, 0)
    assert.equal(findAll(tree, (element) => element.props?.['data-window-cell'] !== undefined).length, 0)
    // Static layout rules: a simple vertical stack of full-width blocks; the
    // old three-column grid/wrapper is gone.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-details-stack\{display:flex;flex-direction:column;gap:10px;min-width:0\}/,
      'the columns wrapper is a vertical flex column',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-details-block\{display:flex;flex-direction:column;gap:3px;min-width:0\}/,
      'each block stacks its head and table',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-details-table\{width:100%;min-width:100%;table-layout:fixed;border-collapse:collapse/,
      'the tables use fixed HTML table layout so columns always align',
    )
    assert.match(source, /\.dsh-tokenlens-details-columns\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\)/, 'the columns wrapper is a grid')
    assert.match(source, /minmax\(320px,1fr\) minmax\(0,1\.15fr\) minmax\(0,1\.35fr\)/, 'the grid ratios are present')
    assert.match(source, /\.dsh-tokenlens-details-table \.dsh-tokenlens-details-table-col-window\{width:64px\}/, 'window columns are 64px')
    assert.match(
      source,
      /\.dsh-tokenlens-details-table-name-text\{[^}]*display:-webkit-box[^}]*line-clamp:2/,
      'long names clamp to two lines',
    )
    assert.match(source, /\.dsh-tokenlens-details-table td\.dsh-tokenlens-details-table-cell\{[^}]*text-align:right/, 'values are right-aligned')
    assert.match(source, /\.dsh-tokenlens-details-table-label\{[^}]*text-align:right/, 'the single header labels right-align over their values')
    assert.doesNotMatch(source, /dsh-tokenlens-details-table-name-row/, 'the dead name-row CSS is gone')
    assert.doesNotMatch(source, /dsh-tokenlens-details-table-value-row/, 'the dead value-row CSS is gone')
  } finally {
    plugin.dispose()
  }
})

test('collapsing 更多明细 keeps the harness block and hides the other two', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: weeklyStatsFixture() }
    return { ok: true, snapshot: snapshotFixture(payload.providerId) }
  })
  try {
    let tree = await settleDataDialog(plugin, 'opencode-go')
    assert.equal(
      findAll(tree, (element) => element.props?.['data-details-block'] !== undefined).length,
      3,
      'expanded details show all three stacked blocks',
    )
    toggleStatsDetailsOf(tree).props.onClick()
    tree = renderDialog(plugin)
    assert.equal(toggleStatsDetailsOf(tree).props['aria-expanded'], false, 'the toggle reads collapsed')
    assert.deepEqual(
      findAll(tree, (element) => element.props?.['data-details-block'] !== undefined).map(
        (block) => block.props['data-details-block'],
      ),
      ['harness'],
      'only the 按 Harness block stays visible',
    )
    assert.ok(
      findElement(tree, (element) => element.props?.['data-harness'] === 'dsh'),
      'the harness rows remain readable when collapsed',
    )
    // Expanding restores all three blocks.
    toggleStatsDetailsOf(tree).props.onClick()
    tree = renderDialog(plugin)
    assert.equal(
      findAll(tree, (element) => element.props?.['data-details-block'] !== undefined).length,
      3,
      'expanding restores the three blocks',
    )
  } finally {
    plugin.dispose()
  }
})

test('chart-mode summary includes the 最近7天 item', async () => {
  const days = dayList(30)
  const plugin = loadChartPlugin(
    weeklyStatsFixture({ daily: days.map((day, index) => dailyEntry(day, index)) }),
  )
  try {
    const tree = await settleDialog(plugin, 'opencode-go')
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true', 'chart mode is the default')
    const summary = findElement(tree, (element) => element.props?.className === 'dsh-tokenlens-chart-summary')
    assert.ok(summary, 'the chart summary renders')
    const cells = findAll(summary, (element) => element.props?.['data-chart-summary'] !== undefined)
    assert.deepEqual(
      cells.map((cell) => cell.props['data-chart-summary']),
      ['today', 'week', 'window', 'total', 'peak'],
      'the summary reads 今日 / 最近7天 / 当前窗口 / 合计 / 峰值',
    )
    assert.match(textOf(cells[0]), /今日 10\.000M/)
    assert.match(textOf(cells[1]), /最近7天 70\.000M/, 'the 7-day summary item uses the provider 7-day bucket')
    assert.match(textOf(cells[2]), /最近30天 200\.000M/)
    assert.match(textOf(cells[3]), /合计/)
    assert.match(textOf(cells[4]), /峰值/)
    // en parity for the new summary item.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.match(textOf(enTree), /Last 7 days 70\.000M/, 'the en summary uses Last 7 days')
  } finally {
    plugin.dispose()
  }
})

test('old Host stats without last7Days keep three aligned value columns', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    assert.match(textOf(tree), /今日/)
    assert.doesNotMatch(textOf(tree), /最近7天/, 'no 7-day card/column without a last7Days bucket')
    assert.equal(cardTextsOf(tree).length, 3, 'the old three-card layout stays')
    // Old Host tables keep their three labelled windows in the single header row.
    const dshRow = detailsRowOf(tree, 'DSH')
    assert.ok(dshRow, 'the harness row renders')
    assert.equal(dshRow.type, 'tr', 'each item is ONE real table row')
    assert.equal(dshRow.children.length, 1 + 3, 'name td + three value tds')
    assert.equal(windowValuesOf(dshRow).length, 3, 'the old host rows keep three aligned values')
    const harnessColumn = detailsBlockOf(tree, 'harness')
    const ths = findAll(harnessColumn, (element) => element.type === 'th')
    assert.equal(ths.length, 1 + 3, 'spacer th + three window th labels')
    assert.equal(
      findAll(dshRow, (element) => element.type === 'td' && element.props?.['data-window-value'] !== undefined).length,
      3,
      'three aligned value tds on an old Host',
    )
    assert.deepEqual(detailsWindowLabelTextsOf(tree, 'harness'), ['今日', '最近30天', '总计'])
    assert.deepEqual(detailsWindowLabelsOf(tree, 'harness'), ['today', 'second', 'total'])
    assert.deepEqual(detailsRowCellsOf(tree, 'DSH'), [
      ['今日', '489.200M'],
      ['最近30天', '920.000M'],
      ['总计', '1.800B'],
    ])
    assert.deepEqual(detailsWindowLabelTextsOf(tree, 'models'), ['今日', '最近30天', '总计'])
    // Chart summary: no week cell on an old Host.
    const statsView = statsViewOptionOf(tree, 'chart')
    statsView.props.onClick()
    const chartTree = renderDialog(plugin)
    assert.equal(
      findElement(chartTree, (element) => element.props?.['data-chart-summary'] === 'week'),
      undefined,
      'the chart summary omits the week item',
    )
    assert.doesNotMatch(textOf(chartTree), /最近7天/)
  } finally {
    plugin.dispose()
  }
})

test('detail rows are real one-row HTML table rows with aligned th/td columns', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    // Three REAL <table> elements, one per 明细 column (v0.30.7/v0.30.8).
    const tables = findAll(tree, (element) => element.props?.['data-details-table'] === 'true')
    assert.equal(tables.length, 3, 'three real <table> elements render')
    for (const table of tables) {
      assert.equal(table.type, 'table', 'the container is a real table element')
      assert.ok(findElement(table, (element) => element.type === 'colgroup'), 'each table has a colgroup')
      const cols = findAll(table, (element) => element.type === 'col')
      const ths = findAll(table, (element) => element.type === 'th')
      const headLabels = ths.filter((th) => th.props['data-window-label'] !== undefined)
      assert.equal(cols.length, 1 + headLabels.length, 'one name col + one window col per window')
      assert.equal(cols[0].props.className, 'dsh-tokenlens-details-table-col-name', 'the first col is the auto name column')
      assert.equal(cols[1].props.className, 'dsh-tokenlens-details-table-col-window')
      assert.equal(cols[1].props.style.width, '64px', 'window columns are 64px wide')
      // thead: a spacer th + one label th per window
      const thead = findElement(table, (element) => element.type === 'thead')
      assert.ok(thead, 'each table has a thead')
      assert.equal(ths[0].props.className, 'dsh-tokenlens-details-table-spacer', 'the header starts with the spacer th')
      assert.equal(ths.length, 1 + headLabels.length, 'one th per column including the spacer')
      // Each item is ONE <tr>: name td + one value td per window.
      const tbodies = findAll(table, (element) => element.type === 'tbody')
      assert.equal(tbodies.length, 1, 'one tbody holds all rows')
      const itemRows = findAll(tbodies[0], (element) => element.type === 'tr' && element.props?.['data-details-row'] !== undefined)
      assert.ok(itemRows.length > 0, 'each table has data rows')
      for (const item of itemRows) {
        assert.ok((item.props?.className ?? '').split(' ').includes('dsh-tokenlens-details-table-row'), 'items are table rows')
        const tds = findAll(item, (element) => element.type === 'td')
        assert.equal(tds.length, 1 + headLabels.length, 'name td + one value td per window')
        assert.equal(tds[0].props.className, 'dsh-tokenlens-details-table-name', 'the first td is the name')
        assert.equal(tds[0].props.colSpan, undefined, 'item rows never use a colspan name row')
        assert.ok(typeof tds[0].props.title === 'string' && tds[0].props.title.length > 0, 'the name td keeps a tooltip')
        assert.deepEqual(
          tds.slice(1).map((td) => td.props.className),
          headLabels.map(() => 'dsh-tokenlens-details-table-cell'),
        )
        assert.deepEqual(
          tds.slice(1).map((td) => td.props['data-window-value']),
          headLabels.map((_, index) => String(index)),
        )
      }
    }
    // Notes/subheads (all-harness ZCode ownership rows) are single colspan rows.
    scopeTabOf(tree, 'all').props.onClick()
    const allTree = renderDialog(plugin)
    const noteRows = findAll(
      allTree,
      (element) => element.type === 'tr' && findElement(element, (cell) => cell.type === 'td'),
    )
    const noteCells = findAll(
      allTree,
      (element) =>
        element.type === 'td' && (element.props?.className ?? '').split(' ').includes('dsh-tokenlens-details-table-note'),
    )
    assert.ok(noteCells.length > 0, 'the ZCode notes render as table cells')
    for (const cell of noteCells) {
      assert.ok(cell.props.colSpan >= 2, 'a note row spans the whole table')
    }
    const subheads = noteCells.filter((cell) => (cell.props.className ?? '').includes('dsh-tokenlens-details-subhead'))
    assert.ok(subheads.length > 0, 'the unmapped subhead is a colspan row')
    assert.ok(noteRows.length >= noteCells.length, 'notes live in real table rows')
    // Static: fixed table layout + vertical stack blocks + 2-line name clamp.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /\.dsh-tokenlens-details-table\{width:100%;min-width:100%;table-layout:fixed;border-collapse:collapse/, 'fixed table layout + collapsed borders')
    assert.match(source, /\.dsh-tokenlens-details-table \.dsh-tokenlens-details-table-col-window\{width:64px\}/, 'window cols are fixed at 64px')
    assert.match(source, /\.dsh-tokenlens-details-stack\{display:flex;flex-direction:column;gap:10px;min-width:0\}/, 'the blocks stack vertically')
    assert.match(source, /\.dsh-tokenlens-details-block\{display:flex;flex-direction:column;gap:3px;min-width:0\}/, 'each block is a head + table column')
    assert.match(source, /\.dsh-tokenlens-details-columns\{[^}]*display:grid/, 'the columns wrapper CSS is present')
    assert.match(source, /minmax\(320px,1fr\) minmax\(0,1\.15fr\) minmax\(0,1\.35fr\)/, 'the grid ratios are present')
    assert.match(source, /line-clamp:2/, 'names clamp to two lines')
    assert.doesNotMatch(source, /dsh-tokenlens-details-table-name-row/, 'no dead name-row CSS')
    assert.doesNotMatch(source, /dsh-tokenlens-details-table-value-row/, 'no dead value-row CSS')
    assert.doesNotMatch(source, /\.dsh-tokenlens-details-table\{display:grid/, 'the grid emulation is gone')
    assert.doesNotMatch(source, /dsh-tokenlens-details-table-row\{display:contents/, 'the display:contents row override is gone')
  } finally {
    plugin.dispose()
  }
})

test('the name column has a header and the three columns have dividers', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDataDialog(plugin, 'opencode-go')
    const firstTable = findElement(tree, (element) => element.type === 'table')
    const nameTh = findElement(firstTable, (element) => (element.props?.className ?? '') === 'dsh-tokenlens-details-table-spacer')
    assert.ok(nameTh, 'the name column has a header cell')
    assert.equal(textOf(nameTh), 'Harness', 'the harness name column carries its header label')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /\.dsh-tokenlens-details-columns>\.dsh-tokenlens-details-block\+\.dsh-tokenlens-details-block\{[^}]*border-left:1px solid/, 'a divider separates the columns')
    assert.match(source, /\.dsh-tokenlens-details-columns>\.dsh-tokenlens-details-block\+\.dsh-tokenlens-details-block\{[^}]*padding-left:14px/, 'the divider keeps a gutter')
    assert.match(source, /statsNameColHarness: 'Harness'/, 'zh harness header exists')
    assert.match(source, /statsNameColProvider: '供应商'/, 'zh provider header exists')
    assert.match(source, /statsNameColModel: '模型'/, 'zh model header exists')
    assert.match(source, /statsNameColProvider: 'Provider'/, 'en provider header exists')
    assert.match(source, /statsNameColModel: 'Model'/, 'en model header exists')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Capacity card: local-token consumption + estimated quota per window (v0.30.13).
// ---------------------------------------------------------------------------

/** The visible text of one capacity-token line (title tooltips excluded). */
function capacityTokensTextOf(line) {
  return (line.children ?? []).map((child) => String(child)).join('')
}

/** One capacity-card local-token segment by window id (`rolling`/`weekly`/`monthly`). */
function capacityTokensOf(tree, windowId) {
  return findElement(tree, (element) => element.props?.['data-capacity-tokens'] === windowId)
}

/** One capacity window row by id. */
function capacityRowOf(tree, windowId) {
  return findElement(tree, (element) => element.props?.['data-window'] === windowId)
}

/** The reset/renewal line (`.dsh-tokenlens-row-foot`) of one capacity window row. */
function capacityRowFootOf(tree, windowId) {
  const row = capacityRowOf(tree, windowId)
  return row === undefined ? undefined : findElement(row, (element) => element.props?.className === 'dsh-tokenlens-row-foot')
}

/** Concatenated visible text of an element's children (title tooltips excluded). */
function visibleChildrenTextOf(node) {
  if (node === null || node === undefined) return ''
  return (node.children ?? [])
    .filter((child) => child !== null && child !== undefined)
    .map((child) => (typeof child === 'string' ? child : visibleChildrenTextOf(child)))
    .join('')
}

/** Snapshot for opencode-go whose window percentages are the given values. */
function capacitySnapshotFixture(percents = [10, 25, 50]) {
  const snapshot = snapshotFixture('opencode-go')
  snapshot.windows = {
    rolling: windowFixture(percents[0], 2.5),
    weekly: windowFixture(percents[1], 30),
    monthly: windowFixture(percents[2], 9 * 24),
  }
  return snapshot
}

/** Stats whose opencode-go provider row carries known local-window totals. */
function capacityStatsFixture() {
  const base = statsFixture()
  return {
    ...base,
    providers: [
      {
        ...base.providers[0],
        fiveHours: bucket({ total: 1000, messages: 10 }),
        last7Days: bucket({ total: 7000, messages: 70 }),
        last30Days: bucket({ total: 30000, messages: 300 }),
      },
      ...base.providers.slice(1),
    ],
  }
}

test('capacity card shows local consumption and estimated quota per window (data + chart)', async () => {
  const plugin = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: capacityStatsFixture() }
    if (payload.action === 'providers') return providersFixture()
    return {
      ok: true,
      snapshot:
        payload.providerId === 'opencode-go' ? capacitySnapshotFixture() : snapshotFixture(payload.providerId),
    }
  })
  try {
    let tree = await settleDialog(plugin, 'opencode-go')
    // 图表 is the default view; the shared capacity card renders the lines.
    assert.equal(statsViewOptionOf(tree, 'chart').props['data-active'], 'true')
    const cases = [
      ['rolling', '已消耗 1.000K · 预计可消耗 10.000K'],
      ['weekly', '已消耗 7.000K · 预计可消耗 28.000K'],
      ['monthly', '已消耗 30.000K · 预计可消耗 60.000K'],
    ]
    for (const [id, expected] of cases) {
      const segment = capacityTokensOf(tree, id)
      assert.ok(segment, `the ${id} row carries the inline local-token segment`)
      assert.equal(segment.type, 'span', 'the segment is an inline span, not a block row')
      assert.equal(segment.props.className, 'dsh-tokenlens-capacity-tokens')
      assert.equal(capacityTokensTextOf(segment), ` · ${expected}`)
      assert.equal(segment.props.title, '本机 Token 记录 ÷ 当前套餐百分比估算，仅供参考')
      const row = capacityRowOf(tree, id)
      const foot = capacityRowFootOf(tree, id)
      assert.ok(foot, `the ${id} row keeps its reset line`)
      assert.ok(foot.children.includes(segment), 'the segment sits on the reset/renewal line')
      assert.equal(row.children.includes(segment), false, 'no separate token block row remains')
      const footText = visibleChildrenTextOf(foot)
      assert.ok(footText.includes('后重置'), 'the line keeps the reset text')
      assert.ok(footText.includes(expected), 'the estimate stays on the reset line')
      assert.ok(footText.indexOf(expected) > footText.indexOf('后重置'), 'the estimate sits to the right of the reset text')
      const dateSpan = foot.children.find((child) => child?.props?.className === 'dsh-tokenlens-reset-date')
      if (dateSpan !== undefined) {
        assert.ok(footText.indexOf(expected) > footText.indexOf(textOf(dateSpan)), 'the estimate sits to the right of the reset date')
      }
    }
    // The 数据 view keeps the same shared capacity card/lines.
    statsViewOptionOf(tree, 'data').props.onClick()
    tree = renderDialog(plugin)
    assert.equal(statsViewOptionOf(tree, 'data').props['data-active'], 'true')
    for (const [id, expected] of cases) {
      const segment = capacityTokensOf(tree, id)
      assert.equal(capacityTokensTextOf(segment), ` · ${expected}`)
      assert.ok(
        capacityRowFootOf(tree, id).children.includes(segment),
        '数据 mode also keeps the inline segment on the reset line',
      )
    }
    // en locale + tooltip.
    const enT = translatorOf(plugin.dictionaries['dsh-tokenlens'].en)
    const enTree = dialogOf(plugin).component({ sessionId: 'session-1', t: enT })
    assert.equal(
      capacityTokensTextOf(capacityTokensOf(enTree, 'rolling')),
      ' · Consumed 1.000K · Est. quota 10.000K',
    )
    assert.equal(
      capacityTokensOf(enTree, 'rolling').props.title,
      'Local token records ÷ current plan percentage; estimate only',
    )
    // Compact CSS so the card does not grow.
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-capacity-tokens\{font-size:10px;line-height:1\.4;color:var\(--dsw-alias-label-tertiary\);overflow-wrap:anywhere;font-variant-numeric:tabular-nums\}/,
      'the line stays compact',
    )
  } finally {
    plugin.dispose()
  }
})

test('capacity card falls back to a dash on zero/unknown percent and tolerates missing stats', async () => {
  const zeroPercent = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: capacityStatsFixture() }
    if (payload.action === 'providers') return providersFixture()
    return {
      ok: true,
      snapshot:
        payload.providerId === 'opencode-go'
          ? capacitySnapshotFixture([0, 25, 50])
          : snapshotFixture(payload.providerId),
    }
  })
  try {
    const tree = await settleDialog(zeroPercent, 'opencode-go')
    assert.equal(capacityTokensTextOf(capacityTokensOf(tree, 'rolling')), ' · 已消耗 1.000K · 预计可消耗 —')
    assert.equal(capacityTokensTextOf(capacityTokensOf(tree, 'weekly')), ' · 已消耗 7.000K · 预计可消耗 28.000K')
    assert.equal(capacityTokensTextOf(capacityTokensOf(tree, 'monthly')), ' · 已消耗 30.000K · 预计可消耗 60.000K')
    assert.ok(
      capacityRowFootOf(tree, 'rolling').children.includes(capacityTokensOf(tree, 'rolling')),
      'a zero percent keeps the segment inline on the reset line',
    )
  } finally {
    zeroPercent.dispose()
  }

  const noStats = loadPlugin((payload) => {
    if (payload.action === 'hello') return { ok: true }
    if (payload.action === 'stats') return { ok: true, stats: null }
    if (payload.action === 'providers') return providersFixture()
    return {
      ok: true,
      snapshot:
        payload.providerId === 'opencode-go' ? capacitySnapshotFixture() : snapshotFixture(payload.providerId),
    }
  })
  try {
    const tree = await settleDialog(noStats, 'opencode-go')
    for (const id of ['rolling', 'weekly', 'monthly']) {
      assert.equal(
        capacityTokensTextOf(capacityTokensOf(tree, id)),
        ' · 已消耗 0 · 预计可消耗 —',
        `${id}: missing stats renders zero`,
      )
      assert.ok(
        capacityRowFootOf(tree, id).children.includes(capacityTokensOf(tree, id)),
        `${id}: missing stats keeps the segment inline`,
      )
    }
    assert.doesNotMatch(textOf(tree), /render failed|渲染失败/)
  } finally {
    noStats.dispose()
  }
})

test('chart-mode details groups get the same dividers and wrapping labels', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDialog(plugin)
    const groups = findAll(tree, (element) => (element.props?.className ?? '').includes('dsh-tokenlens-chart-group'))
    assert.ok(groups.length >= 3, 'chart mode renders three breakdown groups')
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-details-charts-grid>\.dsh-tokenlens-chart-group\+\.dsh-tokenlens-chart-group[^{]*\{[^}]*border-left:1px solid/,
      'a divider separates the chart groups',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-details-charts-grid>\.dsh-tokenlens-chart-group\+\.dsh-tokenlens-chart-group[^{]*\{[^}]*padding-left:14px/,
      'the chart divider keeps a gutter',
    )
    assert.match(
      source,
      /\.dsh-tokenlens-donut-legend-label\{[^}]*white-space:normal[^}]*line-clamp:2/,
      'chart legend labels may wrap to two lines',
    )
  } finally {
    plugin.dispose()
  }
})

test('chart legend percent/value columns share one grid and right-align', async () => {
  const plugin = loadPlugin()
  try {
    const tree = await settleDialog(plugin)
    assert.ok(findAll(tree, (element) => (element.props?.className ?? '') === 'dsh-tokenlens-donut-legend').length >= 3)
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(
      source,
      /\.dsh-tokenlens-donut-legend\{[^}]*display:grid[^}]*grid-template-columns:auto minmax\(0,1fr\) auto auto/,
      'the legend shares one grid for all rows',
    )
    assert.match(source, /\.dsh-tokenlens-donut-legend-row\{[^}]*display:contents/, 'legend rows expose their cells to the shared grid')
    assert.match(source, /\.dsh-tokenlens-donut-legend-percent\{[^}]*text-align:right/, 'percent values right-align')
    assert.match(source, /\.dsh-tokenlens-donut-legend-value\{[^}]*text-align:right/, 'token values right-align')
  } finally {
    plugin.dispose()
  }
})

// ---------------------------------------------------------------------------
// Experimental: per-workspace token badge in the sidebar (guarded decorator).
// ---------------------------------------------------------------------------

test('the sidebar workspace-token decorator is guarded and source-marked', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // Selector + DOM decorator contract (no real DOM is touched in node tests).
  assert.match(source, /\[data-row-key\^="workspace:"\]/, 'it targets the sidebar workspace rows')
  assert.match(source, /new MutationObserver\(/, 'a MutationObserver watches the sidebar')
  assert.match(source, /observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/, 'it observes the whole body')
  assert.match(source, /WORKSPACE_OBSERVER_DEBOUNCE_MS = 150/, 'mutations are debounced')
  assert.match(source, /clearTimeout\(debounceTimer\)/, 'the debounce timer is cleared on dispose')
  assert.match(source, /data-tokenlens-workspace-tokens/, 'the badge/row carries the marker attribute')
  assert.match(source, /setWorkspaceBadgeValue\(badge, formatTokensPrecise\(entry\.total\)\)/, 'the badge value goes through the icon helper')
  assert.match(source, /dsh-tokenlens-workspace-tokens-value/, 'the badge keeps a value span next to the icon')
  assert.match(source, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/, 'the badge icon is an inline svg')
  assert.match(source, /WORKSPACE_BADGE_CLASS = 'dsh-tokenlens-workspace-tokens'/, 'the badge class is stable (no hashed classes)')
  assert.match(source, /row\.insertBefore\(badge, last\)/, 'the badge is inserted before the row actions')
  assert.match(source, /setWorkspaceBadgeValue\(badge, formatTokensPrecise\(entry\.total\)\)/, 'the badge text uses the 3-decimal formatter')
  assert.match(source, /statsRequests/, 'the tooltip includes the request count')
  assert.match(source, /entry\.messages/, 'the tooltip reads the workspace messages')
  assert.match(source, /workspaceId === 'ungrouped'/, 'ungrouped rows are skipped')
  // Fetch/poll wiring + cleanup through ctx.effect.
  assert.match(source, /setInterval\(poll, WORKSPACE_STATS_INTERVAL_MS\)/, 'stats are polled on an interval')
  assert.match(source, /clearInterval\(timer\)/, 'the poll is cleared on dispose')
  assert.match(source, /'dsh-tokenlens: workspace tokens stats poll'/, 'the poll is registered through ctx.effect')
  assert.match(source, /'dsh-tokenlens: workspace token badges'/, 'the decorator is registered through ctx.effect')
  assert.match(source, /observer\.disconnect\(\)/, 'the observer disconnects on dispose')
  // Guarded degradation: no document/MutationObserver means a no-op.
  assert.match(source, /typeof document === 'undefined'/, 'it degrades when there is no document')
  assert.match(source, /typeof MutationObserver !== 'function'/, 'it degrades when MutationObserver is missing')
  assert.match(source, /never let the sidebar break the dialog/, 'failures are swallowed (decorative only)')
  // Normalized stats contract + compact CSS.
  assert.match(source, /Array\.isArray\(raw\.workspaces\)/, 'stats.workspaces is normalized')
  assert.match(source, /per-workspace all-time totals for the sidebar badge/, 'the normalized stats expose workspaces')
  assert.match(
    source,
    /\.dsh-tokenlens-workspace-tokens\{display:inline-flex;align-items:center;gap:3px;margin-left:auto;[^}]*max-width:104px\}/,
    'the badge CSS is compact and right-aligned next to the actions',
  )
  // Workspace hover-card tokens (today / 7d / 30d / total).
  assert.match(source, /\[class\*="hoverContent"\]/, 'it scans the hover-card containers by stable class fragment')
  assert.match(source, /\[class\*="hoverPath"\]/, 'a path element marks a workspace hover card')
  assert.match(source, /\[class\*="hoverTitle"\]/, 'the workspace title is read from the hover card')
  assert.match(source, /dsh-tokenlens-workspace-hover-tokens/, 'the hover stats container has a stable class')
  assert.match(source, /data-tokenlens-workspace-hover/, 'the hover card/container carries the marker attribute')
  assert.match(source, /refreshWorkspaceHoverCards\(\)/, 'the hover pass joins the debounced refresh')
  assert.match(source, /workspaceHoverEntryOf\(stats, title, pathText\)/, 'it matches by trimmed title then unique path suffix')
  assert.match(source, /workspacePathSuffixOf\(/, 'path-suffix matching helper exists')
  for (const key of ['statsToday', 'statsLast7Days', 'statsLast30Days']) {
    assert.match(source, new RegExp(`\\['${key}', workspaceBucketTotal\\(entry\\.`), `hover stats use the ${key} label`)
  }
  assert.match(source, /\['statsAllTime', Number\.isFinite\(entry\.total\)/, 'hover stats use the all-time total label')
  assert.match(source, /formatTokensPrecise\(value\)/, 'hover values use the 3-decimal formatter')
  assert.match(source, /today: normalizeWorkspaceBucket\(entry\.today\)/, 'workspace today bucket is normalized with numeric defaults')
  assert.match(source, /last7Days: normalizeWorkspaceBucket\(entry\.last7Days\)/, 'workspace 7-day bucket is normalized')
  assert.match(source, /last30Days: normalizeWorkspaceBucket\(entry\.last30Days\)/, 'workspace 30-day bucket is normalized')
  assert.match(source, /function normalizeWorkspaceBucket\(raw\) \{/, 'the workspace bucket normalizer exists')
  assert.match(
    source,
    /\.dsh-tokenlens-workspace-hover-tokens\{display:flex;flex-direction:column;gap:2px;color:#cfd3d6;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums/,
    'the hover stats row wraps with the requested muted styling',
  )
  assert.match(source, /\.dsh-tokenlens-workspace-hover-token\{display:flex;align-items:baseline;justify-content:space-between;/, 'each hover stat stays on one line')
  assert.match(source, /\.dsh-tokenlens-workspace-hover-label\{opacity:\.7;margin-right:3px\}/, 'the hover labels are muted')
  assert.match(source, /one odd hover card must not stop the others/, 'hover decorator failures are isolated')
})
