/**
 * Host-half tests.
 *
 * Three layers, matching the package:
 *   - lib/go-usage.mjs   — pure normalization of the upstream payload;
 *   - lib/key-source.mjs — credential discovery order;
 *   - index.js           — the Cordis plugin, driven through a stub context and
 *                          the same `POST /api/tokenlens` exchange the
 *                          browser half performs.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { apply, BRIDGE, normalize, TOOL_ACTIONS } from '../index.js'
import { redactPath } from '../lib/redact.mjs'
import {
  asCacheHit,
  asStaleCache,
  buildSnapshot,
  classifyStatus,
  errorToWire,
  isFresh,
  normalizePercent,
  parseUsagePayload,
  UsageError,
  usageUrl,
} from '../lib/go-usage.mjs'
import {
  dshHomeOf,
  opencodeAuthCandidates,
  parseCredentialRefs,
  parseOpencodeAuth,
  resolveApiKey,
} from '../lib/key-source.mjs'

const NOW = Date.parse('2026-10-25T09:03:00.000Z')

/** The payload the live endpoint returned on 2026-10-25 (documented shape). */
const LIVE_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 2, resetsAt: '2026-10-25T11:31:25.000Z' },
    weekly: { status: 'ok', percent: 21, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 30, resetsAt: '2026-11-09T14:08:58.000Z' },
  },
}

// ---- lib/go-usage.mjs ------------------------------------------------------

test('normalizePercent clamps and rejects non-numbers', () => {
  assert.equal(normalizePercent(2), 2)
  assert.equal(normalizePercent('21.5'), 21.5)
  assert.equal(normalizePercent(140), 100)
  assert.equal(normalizePercent(-3), 0)
  assert.equal(normalizePercent(Number.NaN), null)
  assert.equal(normalizePercent('abc'), null)
  assert.equal(normalizePercent(undefined), null)
})

test('parseUsagePayload normalizes the three windows in display order', () => {
  const windows = parseUsagePayload(LIVE_PAYLOAD, NOW)
  assert.deepEqual(Object.keys(windows), ['rolling', 'weekly', 'monthly'])
  assert.equal(windows.rolling.percent, 2)
  assert.equal(windows.rolling.status, 'ok')
  assert.equal(windows.rolling.resetsAt, '2026-10-25T11:31:25.000Z')
  assert.equal(windows.rolling.remainingMs, Date.parse('2026-10-25T11:31:25.000Z') - NOW)
  assert.equal(windows.monthly.percent, 30)
})

test('parseUsagePayload keeps a missing window as an explicit gap', () => {
  const windows = parseUsagePayload({ usage: { rolling: { percent: 5, resetsAt: null } } }, NOW)
  assert.equal(windows.rolling.percent, 5)
  assert.equal(windows.weekly.percent, null)
  assert.equal(windows.weekly.resetsAt, null)
  assert.equal(windows.weekly.remainingMs, null)
})

test('parseUsagePayload refuses bodies without usage windows', () => {
  assert.throws(() => parseUsagePayload({}, NOW), (error) => error instanceof UsageError && error.code === 'parse')
  assert.throws(() => parseUsagePayload({ usage: {} }, NOW), (error) => error.code === 'parse')
  assert.throws(() => parseUsagePayload(null, NOW), (error) => error.code === 'parse')
})

test('parseUsagePayload clamps an out-of-range percent and tolerates a bad timestamp', () => {
  const windows = parseUsagePayload({ usage: { rolling: { percent: 150, status: 7, resetsAt: 'not a date' } } }, NOW)
  assert.equal(windows.rolling.percent, 100)
  assert.equal(windows.rolling.status, 'unknown')
  assert.equal(windows.rolling.resetsAt, null)
})

test('buildSnapshot / asCacheHit / asStaleCache follow the wire contract', () => {
  const windows = parseUsagePayload(LIVE_PAYLOAD, NOW)
  const snapshot = buildSnapshot({
    provider: { id: 'opencode-go', label: 'OpenCode', kind: 'windows' },
    windows,
    fetchedAtMs: NOW,
    now: NOW + 500,
    latencyMs: 87,
    source: 'api',
    key: { ref: 'OPENCODE_GO_API_KEY', source: 'credentials' },
  })
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.version, 3)
  assert.equal(snapshot.fetchedAt, '2026-10-25T09:03:00.000Z')
  assert.equal(snapshot.ageMs, 500)
  assert.equal(snapshot.latencyMs, 87)
  assert.equal(snapshot.source, 'api')
  assert.deepEqual(snapshot.provider, { id: 'opencode-go', label: 'OpenCode', kind: 'windows' })
  assert.equal(snapshot.plan, null)
  assert.equal(snapshot.balance, null)
  assert.equal(snapshot.credits, null)
  assert.equal(snapshot.account, null)
  assert.deepEqual(snapshot.key, { ref: 'OPENCODE_GO_API_KEY', source: 'credentials' })

  const hit = asCacheHit(snapshot, NOW + 5000)
  assert.equal(hit.source, 'cache')
  assert.equal(hit.ageMs, 5000)
  assert.equal(hit.latencyMs, null)
  assert.equal(hit.stale, false)

  const stale = asStaleCache(snapshot, NOW + 6000)
  assert.equal(stale.source, 'stale-cache')
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)
})

test('isFresh honours the TTL and rejects failed snapshots', () => {
  const snapshot = buildSnapshot({
    windows: parseUsagePayload(LIVE_PAYLOAD, NOW),
    fetchedAtMs: NOW,
    latencyMs: 1,
    source: 'api',
  })
  assert.equal(isFresh(snapshot, NOW + 1000, 20_000), true)
  assert.equal(isFresh(snapshot, NOW + 30_000, 20_000), false)
  assert.equal(isFresh({ ...snapshot, ok: false }, NOW + 1000, 20_000), false)
  assert.equal(isFresh(null, NOW, 20_000), false)
})

test('classifyStatus and errorToWire map failures without secrets', () => {
  assert.deepEqual(classifyStatus(401), { code: 'unauthorized', retryable: false })
  assert.deepEqual(classifyStatus(403), { code: 'forbidden', retryable: false })
  assert.deepEqual(classifyStatus(429), { code: 'rate-limited', retryable: true })
  assert.deepEqual(classifyStatus(503), { code: 'http', retryable: true })
  assert.deepEqual(classifyStatus(418), { code: 'http', retryable: false })

  const wire = errorToWire(new UsageError('unauthorized', 'the usage endpoint answered HTTP 401', { status: 401 }))
  assert.deepEqual(wire, { code: 'unauthorized', message: 'the usage endpoint answered HTTP 401', status: 401, retryable: false })
  assert.equal(errorToWire({ name: 'TimeoutError' }).code, 'timeout')
  assert.equal(errorToWire(new TypeError('fetch failed')).code, 'internal')
})

test('usageUrl joins base and path tolerantly', () => {
  assert.equal(usageUrl('https://opencode.ai', '/inference/go/v1/usage'), 'https://opencode.ai/inference/go/v1/usage')
  assert.equal(usageUrl('https://opencode.ai/', 'inference/go/v1/usage'), 'https://opencode.ai/inference/go/v1/usage')
  assert.throws(() => usageUrl('', '/x'), (error) => error.code === 'disabled')
  assert.throws(() => usageUrl('not a url', '/x'), (error) => error.code === 'parse')
})

// ---- lib/key-source.mjs ----------------------------------------------------

test('parseCredentialRefs reads only the refs mapping', () => {
  const text = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-123',
    '  OPENCODE_GO_API_KEY: "oc_sk_abc"',
    "  OTHER: 'quoted value'",
    '  COMMENTED: value # trailing comment',
    'settings:',
    '  NOT_A_REF: nope',
  ].join('\n')
  const refs = parseCredentialRefs(text)
  assert.equal(refs.DEEPSEEK_API_KEY, 'sk-123')
  assert.equal(refs.OPENCODE_GO_API_KEY, 'oc_sk_abc')
  assert.equal(refs.OTHER, 'quoted value')
  assert.equal(refs.COMMENTED, 'value')
  assert.equal(refs.NOT_A_REF, undefined)
  const commented = parseCredentialRefs('refs: # credentials\n  DEEPSEEK_API_KEY: sk-xyz')
  assert.equal(commented.DEEPSEEK_API_KEY, 'sk-xyz', 'a comment after refs: keeps the mapping active')
})

test('parseCredentialRefs survives malformed / empty documents', () => {
  assert.deepEqual(parseCredentialRefs(''), {})
  assert.deepEqual(parseCredentialRefs(undefined), {})
  assert.deepEqual(parseCredentialRefs('refs:\n  - broken'), {})
})

test('parseOpencodeAuth prefers the opencode provider entries', () => {
  const doc = JSON.stringify({
    anthropic: { type: 'api', key: 'sk-ant' },
    'opencode-go': { type: 'api', key: 'oc_sk_go' },
    opencode: { type: 'api', key: 'oc_sk_zen' },
  })
  assert.equal(parseOpencodeAuth(doc), 'oc_sk_go')
  assert.equal(parseOpencodeAuth('{"opencode":{"type":"api","key":"oc_sk_x"}}'), 'oc_sk_x')
  assert.equal(parseOpencodeAuth('{"other":{"type":"api","key":"oc_sk_fallback"}}'), 'oc_sk_fallback')
  assert.equal(
    parseOpencodeAuth('{"anthropic":{"type":"api","key":"sk-ant-secret"}}'),
    undefined,
    'a foreign provider key must not be sent to the OpenCode endpoint',
  )
  assert.equal(parseOpencodeAuth('{"openai":{"type":"api","key":"sk-openai-secret"}}'), undefined)
  assert.equal(parseOpencodeAuth('{"oauth":{"type":"oauth","access":"a"}}'), undefined)
  assert.equal(parseOpencodeAuth('not json'), undefined)
  assert.equal(parseOpencodeAuth('[]'), undefined)
})

test('opencodeAuthCandidates includes the Windows locations first', () => {
  const candidates = opencodeAuthCandidates({
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    home: 'C:\\Users\\u',
    platform: 'win32',
  })
  assert.equal(candidates[0], join('C:\\Users\\u\\AppData\\Local', 'opencode', 'auth.json'))
  assert.ok(candidates.some((path) => path.endsWith(join('opencode', 'auth.json'))))
  assert.equal(dshHomeOf({ DSH_HOME: 'D:\\dsh-home' }, 'C:\\Users\\u'), 'D:\\dsh-home')
  assert.equal(dshHomeOf({}, 'C:\\Users\\u'), join('C:\\Users\\u', '.dsh'))
})

test('resolveApiKey follows config 鈫?credentials 鈫?env 鈫?refs file 鈫?auth.json 鈫?none', async () => {
  const config = { apiKey: '', apiKeyRef: 'OPENCODE_GO_API_KEY' }
  const files = new Map()
  const readFile = async (path) => {
    if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files.get(path)
  }
  const base = { config, env: {}, home: 'C:\\Users\\u', platform: 'win32', readFile }

  // 1. explicit config key
  assert.equal((await resolveApiKey({ ...base, config: { ...config, apiKey: 'oc_sk_literal' } })).source, 'config')

  // 2. credential service
  const credentials = { resolve: async () => ({ value: 'oc_sk_store', source: 'file' }) }
  const fromStore = await resolveApiKey({ ...base, credentials })
  assert.equal(fromStore.value, 'oc_sk_store')
  assert.equal(fromStore.source, 'credentials')

  // 3. environment
  const fromEnv = await resolveApiKey({ ...base, env: { OPENCODE_GO_API_KEY: 'oc_sk_env' } })
  assert.equal(fromEnv.value, 'oc_sk_env')
  assert.equal(fromEnv.source, 'env')

  // 4. $DSH_HOME/.credentials.yaml
  const home = 'C:\\Users\\u'
  const dsh = join(home, '.dsh')
  files.set(join(dsh, '.credentials.yaml'), 'refs:\n  OPENCODE_GO_API_KEY: oc_sk_yaml\n')
  const fromYaml = await resolveApiKey({ ...base, home })
  assert.equal(fromYaml.value, 'oc_sk_yaml')
  assert.equal(fromYaml.source, 'credentials')

  // 5. OpenCode CLI auth.json
  files.clear()
  files.set(
    join('C:\\Users\\u\\AppData\\Local', 'opencode', 'auth.json'),
    JSON.stringify({ opencode: { type: 'api', key: 'oc_sk_cli' } }),
  )
  const fromCli = await resolveApiKey({
    ...base,
    home,
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
  })
  assert.equal(fromCli.value, 'oc_sk_cli')
  assert.equal(fromCli.source, 'file')

  // 6. nothing
  files.clear()
  const missing = await resolveApiKey(base)
  assert.equal(missing.value, undefined)
  assert.equal(missing.source, 'none')
})

// ---- plugin integration ----------------------------------------------------

/** A stub Cordis context reproducing only the contract this plugin consumes. */
function harness(t, options = {}) {
  const services = {
    logger: { info() {}, warn() {}, error() {} },
  }
  const handlers = new Map()
  const captured = { route: undefined, tools: [], provided: {}, effects: [] }
  const base = {
    get: (name) => services[name],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => {
      const disposer = fn()
      captured.effects.push(disposer)
      if (typeof disposer === 'function') t.after(() => disposer())
      return disposer
    },
    provide: (name, value) => {
      captured.provided[name] = value
      return () => {}
    },
    inject: (_deps, callback) => {
      callback(ctx)
      return { dispose() {} }
    },
  }
  const ctx = new Proxy(base, {
    get: (target, property) => (property in target ? target[property] : services[property]),
    has: (target, property) => property in target || property in services,
  })
  services.connection = {
    fetch: {
      register: (route) => {
        captured.route = route
        return () => {}
      },
    },
  }
  services.tools = {
    register: (definition) => {
      captured.tools.push(definition)
      return () => {}
    },
  }
  if (options.credentials !== undefined) services.credentials = options.credentials
  if (options.services !== undefined) Object.assign(services, options.services)
  // Token statistics walk the real session logs, so tests opt in explicitly.
  apply(ctx, { statusFile: '', stats: { enabled: false }, ...options.config })
  return { ctx, captured, services, base }
}

/** POST one bridge request the way the browser half does. */
async function bridge(captured, body) {
  assert.ok(captured.route, 'the bridge route was registered')
  const response = await captured.route.fetch({ json: async () => body })
  assert.equal(typeof response.status, 'number')
  return { status: response.status, body: await response.json() }
}

/** Replace global fetch for the duration of one test. */
function stubFetch(t, implementation) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return implementation(calls.length, url, init)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const okCredentials = { resolve: async () => ({ value: 'oc_sk_test', source: 'env' }) }

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('plugin registers a bridge, a tool and the service; hello records the client', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const statusFile = join(dir, 'status.json')
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { statusFile, minRefreshIntervalMs: 20_000, pollIntervalMs: 0 },
  })
  stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))

  assert.equal(captured.tools.length, 1)
  assert.equal(captured.tools[0].name, 'tokenlens_usage')
  assert.deepEqual(captured.tools[0].parameters.properties.action.enum, TOOL_ACTIONS)
  assert.ok(captured.provided.tokenlens, 'the tokenlens service is provided')
  assert.ok(captured.provided.planUsage, 'the provider-neutral planUsage service is provided')
  assert.equal(captured.route.path, BRIDGE)
  assert.deepEqual(captured.route.methods, ['POST'])

  const hello = await bridge(captured, { action: 'hello', origin: 'dsh-app://app', primitives: 282 })
  assert.equal(hello.status, 200)
  assert.equal(hello.body.ok, true)
  assert.equal(hello.body.plugin, 'dsh-tokenlens')
  assert.equal(hello.body.snapshot.ok, true)
  assert.equal(hello.body.snapshot.windows.rolling.percent, 2)
  assert.deepEqual(hello.body.snapshot.provider, { id: 'opencode-go', label: 'OpenCode', kind: 'windows' })

  const diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.equal(diagnostics.body.diagnostics.client.origin, 'dsh-app://app')
  assert.equal(diagnostics.body.diagnostics.client.primitives, 282)
  assert.equal(diagnostics.body.diagnostics.providers['opencode-go'].key.ref, 'OPENCODE_GO_API_KEY')

  // The status file write is coalesced (120 ms) so one burst of events is one write.
  await new Promise((resolve) => setTimeout(resolve, 250))
  const status = JSON.parse(await readFile(statusFile, 'utf8'))
  assert.equal(status.plugin, 'dsh-tokenlens')
  assert.equal(status.bridge.registered, true)

  const windows = diagnostics.body.diagnostics.providers['opencode-go'].cache.windows
  assert.equal(windows.weekly.percent, 21)
})

test('snapshot is cached for minRefreshIntervalMs and refresh forces upstream', async (t) => {
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { minRefreshIntervalMs: 60_000, pollIntervalMs: 0 },
  })
  const calls = stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))

  const first = await bridge(captured, { action: 'snapshot' })
  assert.equal(first.body.ok, true)
  assert.equal(first.body.snapshot.source, 'api')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/v1/usage')
  assert.equal(calls[0].init.headers.authorization, 'Bearer oc_sk_test')
  assert.equal(calls[0].init.method, 'GET')

  const second = await bridge(captured, { action: 'snapshot' })
  assert.equal(second.body.snapshot.source, 'cache')
  assert.equal(calls.length, 1, 'a cache hit does not hit the network')

  const refreshed = await bridge(captured, { action: 'refresh' })
  assert.equal(refreshed.body.snapshot.source, 'api')
  assert.equal(calls.length, 2)
})

test('a missing key is a silent missing-key error, not a crash', async (t) => {
  const { captured } = harness(t, {
    credentials: { resolve: async () => undefined },
    // A reference that exists nowhere: the default reference would find this
    // machine's real credential file, which is exactly what the plugin should do.
    config: {
      providers: { 'opencode-go': { apiKeyRef: 'OPENCODE_GO_USAGE_ABSENT_REFERENCE' } },
      minRefreshIntervalMs: 0,
      pollIntervalMs: 0,
    },
  })
  const calls = stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))

  const result = await bridge(captured, { action: 'snapshot' })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'missing-key')
  assert.equal(result.body.error.retryable, false)
  assert.equal(result.body.snapshot, null)
  assert.equal(calls.length, 0, 'no request is made without a credential')
})

test('upstream failures are classified and keep the previous snapshot as stale', async (t) => {
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 },
  })
  let mode = 'ok'
  const calls = stubFetch(t, () => {
    if (mode === 'unauthorized') return jsonResponse({ error: 'Unauthorized' }, 401)
    if (mode === 'garbage') return new Response('<html>nope</html>', { status: 200 })
    return jsonResponse(LIVE_PAYLOAD)
  })

  const good = await bridge(captured, { action: 'snapshot' })
  assert.equal(good.body.ok, true)

  mode = 'unauthorized'
  const unauthorized = await bridge(captured, { action: 'refresh' })
  assert.equal(unauthorized.body.ok, false)
  assert.equal(unauthorized.body.error.code, 'unauthorized')
  assert.equal(unauthorized.body.error.status, 401)
  assert.equal(unauthorized.body.snapshot.source, 'stale-cache')
  assert.equal(unauthorized.body.snapshot.stale, true)
  assert.equal(unauthorized.body.snapshot.windows.rolling.percent, 2)

  mode = 'garbage'
  const parse = await bridge(captured, { action: 'refresh' })
  assert.equal(parse.body.error.code, 'parse')
  assert.equal(calls.length, 3)
})

test('an unsafe profile baseURL is rejected before any credential is sent', async (t) => {
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: {
      minRefreshIntervalMs: 0,
      pollIntervalMs: 0,
      providers: {
        'opencode-go': { baseURL: 'https://user:pass@example.com/usage?api_key=sk-secret' },
      },
    },
  })
  const calls = stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))

  const result = await bridge(captured, { action: 'refresh' })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'parse')
  assert.equal(calls.length, 0, 'no request is made to an unsafe baseURL')
  assert.equal(result.body.error.message.includes('sk-secret'), false)
  assert.equal(result.body.error.message.includes('user:pass'), false)
})

test('custom usage adapters save, resolve and delete through the management bridge', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-custom-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storeFile = join(dir, 'providers.json')
  const { captured } = harness(t, {
    credentials: okCredentials,
    services: {
      llm: { listProviders: () => [{ id: 'my-gw', name: 'My Gateway' }] },
    },
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: storeFile },
  })
  stubFetch(t, () => jsonResponse({ data: { balance: 12.5, granted: 2 } }))

  const def = {
    providerId: 'my-gw',
    label: 'My Gateway',
    kind: 'balance',
    baseURL: 'https://gw.example.com',
    usagePath: '/v1/credits',
    apiKeyRef: 'MY_GATEWAY_API_KEY',
    amountPath: 'data.balance',
    grantedPath: 'data.granted',
  }
  const saved = await bridge(captured, { action: 'customProviderSave', provider: def })
  assert.equal(saved.body.ok, true)
  const custom = saved.body.providers.find((provider) => provider.providerId === 'my-gw')
  assert.ok(custom, 'the custom provider is listed')
  assert.equal(custom.custom, true)
  assert.equal(custom.builtin, false)
  assert.equal(custom.label, 'My Gateway')
  assert.equal(custom.kind, 'balance')
  assert.equal(custom.definition.amountPath, 'data.balance', 'the definition is echoed for edit prefills')
  assert.equal(custom.definition.usagePath, '/v1/credits')
  const route = saved.body.dshProviders.find((entry) => entry.providerId === 'my-gw')
  assert.equal(route.supported, true, 'the DSH route becomes supported once an adapter exists')
  assert.equal(route.usageProviderId, 'my-gw')

  const tested = await bridge(captured, { action: 'providerTest', providerId: 'my-gw' })
  assert.equal(tested.body.ok, true)
  assert.equal(tested.body.snapshot.provider.id, 'my-gw')
  assert.equal(tested.body.snapshot.balance.amount, 12.5)

  const invalid = await bridge(captured, { action: 'customProviderSave', provider: { ...def, amountPath: '' } })
  assert.equal(invalid.status, 500)
  assert.equal(invalid.body.error.code, 'parse')

  const removed = await bridge(captured, { action: 'customProviderDelete', providerId: 'my-gw' })
  assert.equal(removed.body.ok, true)
  assert.equal(removed.body.providers.some((provider) => provider.providerId === 'my-gw'), false)

  const stored = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.deepEqual(stored.customProviders, {}, 'the definition is removed from providers.json')
})

test('only providers saved in DSH model settings count as configured', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-configured-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { captured } = harness(t, {
    credentials: okCredentials,
    services: {
      llm: {
        listProviders: () => [
          { id: 'opencode-go', name: 'OpenCode' },
          { id: 'commandcode', name: 'Command Code' },
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'deepseek-account', name: 'DeepSeek Account' },
          { id: 'codearts', name: 'CodeArts Agent' },
          { id: 'codebuddy', name: 'CodeBuddy' },
        ],
      },
      // Only these llm-pi-ai profiles are actually configured in the settings.
      configEditor: {
        configuration: () => [
          {
            entry: {
              options: {
                id: 'llm-pi-ai',
                name: '@deepseek-ai/dsh-llm-pi-ai',
                config: { providers: { 'opencode-go': {}, commandcode: {}, deepseek: {} } },
              },
            },
          },
        ],
      },
      deepseekAccount: { getBalance: async () => ({ status: 'ready', value: [], bonusWallets: [] }) },
    },
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: join(dir, 'providers.json') },
  })
  const list = await bridge(captured, { action: 'providers' })
  assert.equal(list.body.ok, true)
  const ids = list.body.dshProviders.map((entry) => entry.providerId)
  assert.deepEqual(ids, ['opencode-go', 'commandcode', 'deepseek-official', 'deepseek-account'], 'dynamically registered plugin channels are not configured providers')
  assert.equal(ids.includes('codearts'), false)
  assert.equal(ids.includes('codebuddy'), false)
  const opencode = list.body.dshProviders.find((entry) => entry.providerId === 'opencode-go')
  assert.equal(opencode.supported, true)
})

test('a newly configured DSH provider is auto-mapped and measured without manual setup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-automap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const profiles = {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    'my-openrouter': {
      displayName: 'My OpenRouter',
      apiKeyEnv: 'MY_OR_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
    },
  }
  const { captured } = harness(t, {
    credentials: okCredentials,
    services: {
      llm: {
        listProviders: () => [
          { id: 'opencode-go', name: 'OpenCode' },
          { id: 'my-openrouter', name: 'My OpenRouter' },
          { id: 'codearts', name: 'CodeArts Agent' },
        ],
      },
      configEditor: {
        configuration: () => [
          {
            entry: {
              options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: profiles } },
            },
          },
        ],
      },
    },
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: join(dir, 'providers.json') },
  })
  stubFetch(t, () => jsonResponse({ data: { total_credits: 100, total_usage: 25 } }))

  const list = await bridge(captured, { action: 'providers' })
  assert.equal(list.body.ok, true)
  const route = list.body.dshProviders.find((entry) => entry.providerId === 'my-openrouter')
  assert.ok(route, 'the configured route is discovered automatically')
  assert.equal(route.supported, true, 'its usage API is auto-recognised from the model base URL')
  assert.equal(route.autoMapped, true)
  assert.equal(route.adapterId, 'openrouter')
  const virtual = list.body.providers.find((provider) => provider.providerId === 'my-openrouter')
  assert.ok(virtual, 'a virtual provider entry is exposed to the management page')
  assert.equal(virtual.label, 'My OpenRouter')
  assert.equal(virtual.autoMapped, true)
  assert.equal(virtual.dshManaged, true)
  assert.equal(virtual.apiKeyRef, 'MY_OR_KEY', 'the DSH profile credential reference is inherited')

  const tested = await bridge(captured, { action: 'providerTest', providerId: 'my-openrouter' })
  assert.equal(tested.body.ok, true)
  assert.equal(tested.body.snapshot.provider.id, 'my-openrouter')
  assert.ok(tested.body.snapshot.credits !== undefined || tested.body.snapshot.balance !== undefined)

  // Deleting the profile in DSH settings removes it (and its stats) again.
  delete profiles['my-openrouter']
  const afterDelete = await bridge(captured, { action: 'providers' })
  assert.equal(afterDelete.body.ok, true)
  assert.equal(afterDelete.body.dshProviders.some((entry) => entry.providerId === 'my-openrouter'), false)
  assert.equal(afterDelete.body.providers.some((provider) => provider.providerId === 'my-openrouter'), false)
})

test('volcengine Coding Plan quota is read through the signed API', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-volc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: join(dir, 'providers.json') },
  })
  stubFetch(t, () =>
    jsonResponse({
      Result: {
        QuotaUsage: [
          { Level: 'FIVE_HOUR', Percent: 8, ResetTimestamp: Math.floor(Date.now() / 1000) + 3600 },
          { Level: 'WEEKLY', Percent: 21 },
          { Level: 'MONTHLY', Percent: 33 },
        ],
      },
    }),
  )
  const tested = await bridge(captured, { action: 'providerTest', providerId: 'volcengine' })
  assert.equal(tested.body.ok, true)
  assert.equal(tested.body.snapshot.provider.id, 'volcengine')
  assert.equal(tested.body.snapshot.windows.rolling.percent, 8)
  assert.equal(tested.body.snapshot.windows.weekly.percent, 21)
  assert.equal(tested.body.snapshot.windows.monthly.percent, 33)
  assert.equal(tested.body.snapshot.key.ref, 'VOLCENGINE_ACCESS_KEY_ID')
})

test('OpenDesign quota and wallet are read with the workspace Control Key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-od-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { captured } = harness(t, {
    credentials: { resolve: async () => ({ value: 'od_control_test', source: 'env' }) },
    config: {
      minRefreshIntervalMs: 0,
      pollIntervalMs: 0,
      providerStoreFile: join(dir, 'providers.json'),
      providers: { 'open-design': { enabled: true, workspaceId: 'ws_test', controlKeyRef: 'OPENDESIGN_CONTROL_KEY' } },
    },
  })
  const calls = stubFetch(t, (call, url) =>
    String(url).includes('/wallet/balance')
      ? jsonResponse({ billingScopeVersion: 2, workspaceId: 'ws_test', workspaceMemberId: 'member_1', balanceUsd: '12.34' })
      : jsonResponse({
          workspaceId: 'ws_test',
          workspaceMemberId: 'member_1',
          eligible: true,
          windows: [
            {
              policyId: 'plan-5h',
              durationSeconds: 18000,
              usedCredits: '250',
              remainingCredits: '750',
              limitCredits: '1000',
              resetsAt: '2026-10-25T11:00:00.000Z',
            },
            {
              policyId: 'plan-7d',
              durationSeconds: 604800,
              usedCredits: '300',
              remainingCredits: '700',
              limitCredits: '1000',
              resetsAt: '2026-11-01T00:00:00.000Z',
            },
          ],
        }),
  )
  const tested = await bridge(captured, { action: 'providerTest', providerId: 'open-design' })
  assert.equal(tested.body.ok, true)
  assert.equal(tested.body.snapshot.provider.id, 'open-design')
  assert.equal(tested.body.snapshot.windows.rolling.percent, 25)
  assert.equal(tested.body.snapshot.windows.weekly.percent, 30)
  assert.equal(tested.body.snapshot.balance.amount, 12.34)
  assert.equal(tested.body.snapshot.balance.currency, 'USD')
  assert.equal(tested.body.snapshot.key.ref, 'OPENDESIGN_CONTROL_KEY')
  assert.equal(calls.length, 2, 'one quota read plus one wallet read')
  const headers = calls[0].init.headers
  assert.equal(headers.authorization, 'Bearer od_control_test')
  assert.equal(headers['x-vela-workspace-id'], 'ws_test')
  assert.match(String(calls[0].url), /\/api\/v1\/workspaces\/ws_test\/billing\/coding-plan-usage$/)
})

test('OpenDesign without a workspace id fails with missing-key, never a fabricated window', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-od-noid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const previous = process.env.OPENDESIGN_WORKSPACE_ID
  delete process.env.OPENDESIGN_WORKSPACE_ID
  t.after(() => {
    if (previous === undefined) delete process.env.OPENDESIGN_WORKSPACE_ID
    else process.env.OPENDESIGN_WORKSPACE_ID = previous
  })
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: {
      minRefreshIntervalMs: 0,
      pollIntervalMs: 0,
      providerStoreFile: join(dir, 'providers.json'),
      providers: { 'open-design': { enabled: true, workspaceId: '', controlKeyRef: 'OPENDESIGN_CONTROL_KEY' } },
    },
  })
  stubFetch(t, () => jsonResponse({ workspaceId: 'ws_test', eligible: true, windows: [] }))
  const tested = await bridge(captured, { action: 'providerTest', providerId: 'open-design' })
  assert.equal(tested.body.ok, false)
  assert.equal(tested.body.error.code, 'missing-key')
  assert.equal(tested.body.snapshot, null)
})

test('unknown actions are refused with the legal list', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { pollIntervalMs: 0 } })
  stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))
  const result = await bridge(captured, { action: 'delete-everything' })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'unknown-action')
  assert.deepEqual(result.body.actions, [
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
  ])
})

test('the agent tool exposes snapshot / refresh / diagnostics', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { pollIntervalMs: 0, minRefreshIntervalMs: 0 } })
  stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))
  const tool = captured.tools[0]

  const snapshot = await tool.execute({})
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.snapshot.windows.monthly.percent, 30)

  const refreshed = await tool.execute({ action: 'refresh' })
  assert.equal(refreshed.snapshot.source, 'api')

  const diagnostics = await tool.execute({ action: 'diagnostics' })
  assert.equal(diagnostics.ok, true)
  assert.equal(diagnostics.diagnostics.plugin, 'dsh-tokenlens')

  const bogus = await tool.execute({ action: 'nope' })
  assert.equal(bogus.error.code, 'unknown-action')
  assert.deepEqual(bogus.actions, TOOL_ACTIONS)
})

test('the picker route ids "opencode" and "opencode-go" share the OpenCode adapter', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  providerFetch(t, { '/inference/go/v1/usage': () => jsonResponse(LIVE_PAYLOAD) })
  for (const providerId of ['opencode', 'opencode-go']) {
    const result = await bridge(captured, { action: 'snapshot', providerId })
    assert.equal(result.body.ok, true)
    assert.equal(result.body.snapshot.provider.id, 'opencode-go', 'canonical adapter id')
    assert.equal(result.body.snapshot.provider.label, 'OpenCode')
  }
  // Both alias and canonical id must share one cache slot; an alias refresh must
  // not leave a second, subscription-detection-invisible entry behind.
  const diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.ok(diagnostics.body.diagnostics.providers['opencode-go'].cache, 'canonical id owns the cache')
  assert.equal(diagnostics.body.diagnostics.providers.opencode, undefined, 'no alias-keyed provider row/cache')
})

test('normalize applies documented defaults and coerces raw values', () => {
  const defaults = normalize(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.defaultProvider, 'opencode-go')
  assert.equal(defaults.minRefreshIntervalMs, 20_000)
  assert.equal(defaults.timeoutMs, 15_000)
  assert.equal(defaults.pollIntervalMs, 120_000)
  assert.equal(defaults.statusFile, '')
  assert.deepEqual(defaults.stats, {
    enabled: true,
    ttlMs: 30_000,
    cacheFile: '',
    dshHome: '',
    showUninstalled: false,
    harnesses: { dsh: true, zcode: true, opencode: true, workbuddy: true, qoder: true },
    zcode: { dbPath: '', providerAliases: { 'opencode-go-chat': 'opencode-go' } },
    opencode: { dbPath: '', providerAliases: {} },
    workbuddy: { root: '', providerAliases: {} },
    qoder: { home: '', providerAliases: {} },
  })
  assert.deepEqual(defaults.providers['opencode-go'], {
    id: 'opencode-go',
    kind: 'windows',
    label: 'OpenCode',
    baseURL: 'https://opencode.ai',
    usagePath: '/inference/go/v1/usage',
    apiKeyRef: 'OPENCODE_GO_API_KEY',
    consoleUrl: 'https://opencode.ai/console',
    shortLabel: 'OC',
    enabled: true,
  })
  assert.equal(defaults.providers.commandcode.baseURL, 'https://api.commandcode.ai')
  assert.equal(defaults.providers.commandcode.consoleUrl, 'https://commandcode.ai/')
  assert.equal(defaults.providers.deepseek.balancePath, '/user/balance')
  assert.equal(defaults.providers.deepseek.consoleUrl, 'https://platform.deepseek.com/usage')

  const legacy = normalize({
    enabled: false,
    baseURL: ' https://proxy.example ',
    usagePath: 'custom/usage',
    apiKeyRef: 'MY_KEY',
    minRefreshIntervalMs: 0,
    pollIntervalMs: -1,
    timeoutMs: 0,
    statusFile: 'C:/tmp/status.json',
  })
  assert.equal(legacy.enabled, false)
  assert.equal(legacy.providers['opencode-go'].baseURL, 'https://proxy.example', 'v1 flat baseURL still configures OpenCode')
  assert.equal(legacy.providers['opencode-go'].usagePath, 'custom/usage')
  assert.equal(legacy.providers['opencode-go'].apiKeyRef, 'MY_KEY')
  assert.equal(legacy.minRefreshIntervalMs, 0)
  assert.equal(legacy.pollIntervalMs, 120_000, 'a negative poll interval falls back')
  assert.equal(legacy.timeoutMs, 15_000, 'a zero timeout falls back')
  assert.equal(legacy.statusFile, 'C:/tmp/status.json')

  const custom = normalize({
    defaultProvider: 'commandcode',
    providers: {
      'opencode-go': { enabled: false },
      commandcode: { apiKeyRef: 'CC_KEY', label: 'CC' },
    },
    stats: { ttlMs: 5_000 },
  })
  assert.equal(custom.defaultProvider, 'commandcode')
  assert.equal(custom.providers['opencode-go'].enabled, false)
  assert.equal(custom.providers.commandcode.apiKeyRef, 'CC_KEY')
  assert.equal(custom.providers.commandcode.label, 'CC')
  assert.equal(custom.providers.commandcode.creditsPath, '/alpha/billing/credits', 'defaults survive a partial override')
  assert.equal(custom.stats.ttlMs, 5_000)
  assert.equal(custom.stats.enabled, true)

  // A default provider that is disabled or unknown falls back to the first enabled one.
  assert.equal(normalize({ defaultProvider: 'nope' }).defaultProvider, 'opencode-go')
  assert.equal(normalize({ defaultProvider: 'commandcode', providers: { commandcode: { enabled: false } } }).defaultProvider, 'opencode-go')
})

// ---- provider-aware routing ------------------------------------------------

/** A response stub that routes by URL, like the three provider endpoints. */
function providerFetch(t, routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    for (const [fragment, handler] of Object.entries(routes)) {
      if (String(url).includes(fragment)) return handler(String(url))
    }
    return jsonResponse({ error: 'unexpected url' }, 404)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const COMMANDCODE_ROUTES = {
  '/alpha/billing/credits': () =>
    jsonResponse({
      credits: { monthlyCredits: 4.5, monthlyCreditsGranted: 10, purchasedCredits: 0 },
      windowLimits: {
        limited: false,
        fiveHour: { cap: 2.5, used: 0.5, resetAt: '2026-10-25T11:31:25.000Z' },
        weekly: { cap: 7.5, used: 3, resetAt: '2026-10-26T00:00:00.000Z' },
      },
    }),
  '/alpha/billing/subscriptions': () =>
    jsonResponse({ success: true, data: { planId: 'individual-go-v1', status: 'active', currentPeriodEnd: '2026-11-09T00:00:00.000Z' } }),
  '/alpha/whoami': () => jsonResponse({ success: true, user: { name: 'Account', userName: 'acct' } }),
}

test('provider-aware: Command Code windows are served for providerId "commandcode"', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  const calls = providerFetch(t, COMMANDCODE_ROUTES)

  const result = await bridge(captured, { action: 'snapshot', providerId: 'commandcode' })
  assert.equal(result.body.ok, true)
  const snapshot = result.body.snapshot
  assert.deepEqual(snapshot.provider, { id: 'commandcode', label: 'Command Code', kind: 'windows' })
  assert.deepEqual(snapshot.plan, { id: 'individual-go-v1', label: 'Go' })
  assert.deepEqual(snapshot.links, { console: 'https://commandcode.ai/acct/settings/usage' }, 'console link follows the account name')
  assert.equal(snapshot.windows.rolling.percent, 20)
  assert.equal(snapshot.windows.weekly.percent, 40)
  assert.equal(snapshot.windows.monthly.percent, 55)
  assert.equal(snapshot.windows.rolling.used, 0.5, 'dollar capacity rides on the window')
  assert.equal(snapshot.windows.rolling.cap, 2.5)
  assert.equal(snapshot.windows.rolling.unit, 'USD')
  assert.equal(snapshot.windows.monthly.used, 5.5)
  assert.equal(snapshot.windows.monthly.cap, 10)
  assert.deepEqual(snapshot.credits, { remaining: 4.5, granted: 10, purchased: 0 })
  assert.equal(snapshot.account.userName, 'acct')
  assert.equal(calls.length, 3, 'credits + subscriptions + whoami')
  assert.ok(calls.every((url) => url.startsWith('https://api.commandcode.ai/')))

  const diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.equal(diagnostics.body.diagnostics.providers.commandcode.key.ref, 'COMMANDCODE_API_KEY')
  assert.equal(diagnostics.body.diagnostics.providers.commandcode.cache.windows.rolling.percent, 20)
})

test('provider-aware: DeepSeek serves a balance snapshot, not windows', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  providerFetch(t, {
    '/user/balance': () =>
      jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '2.26', granted_balance: '0.00', topped_up_balance: '2.26' }] }),
  })
  const result = await bridge(captured, { action: 'snapshot', providerId: 'deepseek' })
  assert.equal(result.body.ok, true)
  assert.deepEqual(result.body.snapshot.provider, { id: 'deepseek', label: 'DeepSeek', kind: 'balance' })
  assert.deepEqual(result.body.snapshot.balance, { amount: 2.26, currency: 'CNY', granted: 0, toppedUp: 2.26 })
  assert.equal(result.body.snapshot.windows.rolling, null)
})

test('an unsupported provider is refused with a typed error', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { pollIntervalMs: 0 } })
  const calls = stubFetch(t, () => jsonResponse({}))
  const result = await bridge(captured, { action: 'snapshot', providerId: 'some-future-provider' })
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error.code, 'unsupported-provider')
  assert.equal(result.body.error.retryable, false)
  assert.equal(calls.length, 0)
})

test('hello records the selected provider and answers with its snapshot', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  providerFetch(t, COMMANDCODE_ROUTES)
  const hello = await bridge(captured, { action: 'hello', origin: 'dsh-app://app', providerId: 'commandcode' })
  assert.equal(hello.body.snapshot.provider.id, 'commandcode')
  const diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.equal(diagnostics.body.diagnostics.client.providerId, 'commandcode')
  assert.equal(diagnostics.body.diagnostics.activeProvider, 'commandcode')
})

test('the picker id "deepseek-official" is aliased onto the DeepSeek balance adapter', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  const calls = providerFetch(t, {
    '/user/balance': () =>
      jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '2.26' }] }),
  })
  const result = await bridge(captured, { action: 'snapshot', providerId: 'deepseek-official' })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.snapshot.provider.id, 'deepseek', 'canonical adapter id')
  assert.equal(result.body.snapshot.provider.label, 'DeepSeek')
  assert.equal(result.body.snapshot.balance.amount, 2.26)
  assert.deepEqual(result.body.snapshot.links, { console: 'https://platform.deepseek.com/usage' })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('api.deepseek.com/user/balance'))
})

test('the active provider falls back to the composition default model', async (t) => {
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { pollIntervalMs: 0, minRefreshIntervalMs: 0 },
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) } },
  })
  providerFetch(t, {
    '/user/balance': () => jsonResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }),
  })
  const tool = captured.tools[0]
  const snapshot = await tool.execute({})
  assert.equal(snapshot.snapshot.provider.id, 'deepseek')
})

test('the provider management actions list, edit and test providers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storeFile = join(dir, 'providers.json')
  const { captured } = harness(t, {
    credentials: okCredentials,
    services: {
      llm: {
        listProviders: () => [
          { id: 'opencode-go', name: 'OpenCode' },
          { id: 'commandcode', name: 'Command Code' },
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'custom-route', name: 'Custom Route' },
        ],
      },
    },
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: storeFile },
  })
  stubFetch(t, () => jsonResponse({ data: { total_credits: 100, total_usage: 25 } }))

  const list = await bridge(captured, { action: 'providers' })
  assert.equal(list.body.ok, true)
  assert.equal(list.body.storeFile, redactPath(storeFile), 'the raw absolute path is never returned')
  assert.equal(list.body.storeFileDisplay, redactPath(storeFile), 'display path redacts the home directory')
  assert.equal(list.body.storeFileDisplay, redactPath(storeFile), 'display path redacts the home directory')
  const managed = list.body.providers.find((provider) => provider.providerId === 'opencode-go')
  assert.equal(managed.label, 'OpenCode', 'the built-in display label is preserved')
  assert.equal(managed.dshManaged, true, 'opencode-go is configured in DSH model settings')
  assert.equal(managed.dshProviderId, 'opencode-go')
  assert.equal(typeof managed.subscribed, 'boolean', 'the management payload carries subscription status')
  const qwen = list.body.providers.find((provider) => provider.providerId === 'qwen')
  assert.ok(qwen, 'the expanded built-in pool is exposed to the management page')
  assert.equal(qwen.label, '通义千问')
  assert.equal(qwen.builtin, true)
  assert.equal(qwen.kind, 'balance', 'metadata kind is used when a provider has no adapter yet')
  assert.equal(list.body.providers.some((provider) => provider.providerId === 'open-design'), true)

  const dshList = list.body.dshProviders
  assert.equal(dshList.length, 4, 'every DSH-configured route is reported')
  assert.equal(dshList.find((route) => route.providerId === 'opencode-go').supported, true)
  assert.equal(dshList.find((route) => route.providerId === 'opencode-go').usageProviderId, 'opencode-go')
  assert.equal(dshList.find((route) => route.providerId === 'deepseek-official').usageProviderId, 'deepseek')
  assert.equal(dshList.find((route) => route.providerId === 'custom-route').supported, false, 'DSH-only routes surface as unsupported')
  assert.equal(dshList.find((route) => route.providerId === 'custom-route').usageProviderId, null)
  const pluginOnly = list.body.providers.find((provider) => provider.providerId === 'openrouter')
  assert.equal(pluginOnly.dshManaged, false, 'providers without a DSH route keep their own credentials')
  const ids = list.body.providers.map((provider) => provider.providerId)
  for (const id of ['opencode-go', 'commandcode', 'deepseek', 'openrouter', 'moonshot', 'siliconflow', 'deepseek-account']) {
    assert.ok(ids.includes(id), `the management page lists ${id}`)
  }
  const openrouter = list.body.providers.find((provider) => provider.providerId === 'openrouter')
  assert.equal(openrouter.label, 'OpenRouter')
  assert.equal(openrouter.shortLabel, 'OR')
  assert.equal(list.body.settings.labelStyle, 'full')
  assert.equal(list.body.settings.defaultView, 'chart')
  assert.equal(list.body.settings.defaultScope, 'provider')
  assert.equal(list.body.settings.detailsExpanded, 'auto')
  assert.equal(list.body.settings.detailsWindow, 'total', 'the v1.2.1 明细 window defaults to 总计')
  assert.equal(openrouter.kind, 'balance')
  assert.equal(typeof openrouter.hasKey, 'boolean')

  const updated = await bridge(captured, { action: 'providerUpdate', providerId: 'openrouter', update: { apiKey: 'sk-or-test' } })
  assert.equal(updated.body.ok, true)
  assert.equal(updated.body.providers.find((provider) => provider.providerId === 'openrouter').hasKey, true)
  const store = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(store.providers.openrouter.apiKey, 'sk-or-test')

  const insecure = await bridge(captured, {
    action: 'providerUpdate',
    providerId: 'openrouter',
    update: { baseURL: 'http://api.example.com' },
  })
  assert.equal(insecure.body.ok, false)
  assert.equal(insecure.body.error.code, 'parse', 'plain http baseURL is rejected (key would be sent in clear)')
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).providers.openrouter.baseURL, undefined)

  const secure = await bridge(captured, {
    action: 'providerUpdate',
    providerId: 'openrouter',
    update: { baseURL: 'https://api.example.com/' },
  })
  assert.equal(secure.body.ok, true)
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).providers.openrouter.baseURL, 'https://api.example.com')

  const tested = await bridge(captured, { action: 'providerTest', providerId: 'openrouter' })
  assert.equal(tested.body.ok, true)
  assert.equal(tested.body.snapshot.balance.amount, 75)

  const relabeled = await bridge(captured, {
    action: 'providerUpdate',
    providerId: 'openrouter',
    update: { label: 'OpenRouter Custom', shortLabel: 'ORC' },
  })
  assert.equal(relabeled.body.ok, true)
  const relabeledRow = relabeled.body.providers.find((provider) => provider.providerId === 'openrouter')
  assert.equal(relabeledRow.label, 'OpenRouter Custom')
  assert.equal(relabeledRow.shortLabel, 'ORC')
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).providers.openrouter.label, 'OpenRouter Custom')
  const restored = await bridge(captured, {
    action: 'providerUpdate',
    providerId: 'openrouter',
    update: { label: '', shortLabel: '' },
  })
  const restoredRow = restored.body.providers.find((provider) => provider.providerId === 'openrouter')
  assert.equal(restoredRow.label, 'OpenRouter', 'empty clears the override back to the default')
  assert.equal(restoredRow.shortLabel, 'OR')

  const styled = await bridge(captured, { action: 'settingsUpdate', settings: { labelStyle: 'short', defaultView: 'data', defaultScope: 'all', detailsExpanded: 'expanded', detailsWindow: 'last7Days' } })
  assert.equal(styled.body.ok, true)
  assert.equal(styled.body.settings.labelStyle, 'short')
  assert.equal(styled.body.settings.defaultView, 'data')
  assert.equal(styled.body.settings.defaultScope, 'all')
  assert.equal(styled.body.settings.detailsExpanded, 'expanded')
  assert.equal(styled.body.settings.detailsWindow, 'last7Days', 'the 明细 window is persisted and echoed')
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).settings.labelStyle, 'short')
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).settings.detailsWindow, 'last7Days')
  const invalid = await bridge(captured, { action: 'settingsUpdate', settings: { labelStyle: 'huge' } })
  assert.equal(invalid.status, 500)
  assert.equal(invalid.body.error.code, 'unsupported-provider')
  const invalidWindow = await bridge(captured, { action: 'settingsUpdate', settings: { detailsWindow: 'junk' } })
  assert.equal(invalidWindow.status, 500)
  assert.equal(invalidWindow.body.error.code, 'unsupported-provider', 'an unknown 明细 window is refused')
  assert.match(invalidWindow.body.error.message, /settings\.detailsWindow must be one of today, last7Days, second, total/)
  assert.equal(
    JSON.parse(await readFile(storeFile, 'utf8')).settings.detailsWindow,
    'last7Days',
    'the refused value never reaches the store',
  )

  const disabled = await bridge(captured, { action: 'providerUpdate', providerId: 'openrouter', update: { enabled: false } })
  assert.equal(disabled.body.providers.find((provider) => provider.providerId === 'openrouter').enabled, false)
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).providers.openrouter.enabled, false)
})

test('an old store file without detailsWindow sanitizes to the 总计 default', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const storeFile = join(dir, 'providers.json')
  // A v1.2.0 store: the settings object predates the persisted 明细 window.
  await writeFile(
    storeFile,
    JSON.stringify({ version: 1, settings: { labelStyle: 'short', defaultView: 'data' }, providers: {} }),
    'utf8',
  )
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { minRefreshIntervalMs: 0, pollIntervalMs: 0, providerStoreFile: storeFile },
  })
  stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))
  const list = await bridge(captured, { action: 'providers' })
  assert.equal(list.body.ok, true)
  assert.equal(list.body.settings.labelStyle, 'short', 'the old saved settings are kept')
  assert.equal(list.body.settings.defaultView, 'data')
  assert.equal(list.body.settings.detailsWindow, 'total', 'the missing window falls back to 总计')

  // Saving one then round-trips through the store file.
  const saved = await bridge(captured, { action: 'settingsUpdate', settings: { detailsWindow: 'last7Days' } })
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.settings.labelStyle, 'short', 'an unrelated setting keeps its old value')
  assert.equal(saved.body.settings.detailsWindow, 'last7Days')
  assert.equal(JSON.parse(await readFile(storeFile, 'utf8')).settings.detailsWindow, 'last7Days')
})
test('a snapshot request that names a provider switches the active provider', async (t) => {
  const { captured } = harness(t, { credentials: okCredentials, config: { minRefreshIntervalMs: 0, pollIntervalMs: 0 } })
  providerFetch(t, COMMANDCODE_ROUTES)
  await bridge(captured, { action: 'hello', origin: 'dsh-app://app', providerId: 'opencode-go' })
  let diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.equal(diagnostics.body.diagnostics.activeProvider, 'opencode-go')
  await bridge(captured, { action: 'snapshot', providerId: 'commandcode' })
  diagnostics = await bridge(captured, { action: 'diagnostics' })
  assert.equal(diagnostics.body.diagnostics.activeProvider, 'commandcode', 'the poll now follows the reported provider')
})

// ---- token statistics through the bridge -----------------------------------

/** Write one synthetic session log (one zstd frame per event, like appends). */
async function writeUsageSession(dshHome, id, events) {
  const dir = join(dshHome, 'sessions', '--test--', id)
  await mkdir(dir, { recursive: true })
  const frames = events.map((entry) => zstdCompressSync(Buffer.from(JSON.stringify(entry) + '\n', 'utf8')))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

test('the stats action serves today/all-time token totals from session logs', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-bridge-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const now = Date.now()
  await writeUsageSession(dshHome, 'session-a', [
    { type: 'session', id: 'session-a', createdAt: now, isSeeded: false, delegationDepth: 0 },
    { type: 'request/header', seq: 1, time: now, data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', seq: 2, time: now, data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, totalTokens: 2000 } } },
  ])
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { pollIntervalMs: 0, stats: { enabled: true, ttlMs: 0, dshHome, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } },
  })
  stubFetch(t, () => jsonResponse(LIVE_PAYLOAD))

  const result = await bridge(captured, { action: 'stats' })
  assert.equal(result.body.ok, true)
  const stats = result.body.stats
  assert.equal(stats.today.total, 2000)
  assert.equal(stats.allTime.messages, 1)
  assert.equal(stats.providers[0].providerId, 'opencode-go')
  assert.equal(stats.providers[0].label, 'OpenCode')
  // Local absolute paths are Host-only; browser/agent payloads must not carry them.
  assert.equal('cacheFile' in stats.scan, false, 'scan cache path is stripped')
  assert.equal(stats.workspaces.every((row) => !('cwd' in row) && !('path' in row)), true, 'workspace cwd paths are stripped')
  assert.equal(JSON.stringify(stats).includes(dshHome), false, 'the session-home path never reaches the wire')

  // Disabled statistics answer with a typed error instead of data.
  const disabled = harness(t, { credentials: okCredentials, config: { pollIntervalMs: 0 } })
  const denied = await bridge(disabled.captured, { action: 'stats' })
  assert.equal(denied.body.ok, false)
  assert.equal(denied.body.error.code, 'stats-unavailable')
})

test('the agent tool also exposes providerId and stats', async (t) => {
  const { captured } = harness(t, {
    credentials: okCredentials,
    config: { pollIntervalMs: 0, minRefreshIntervalMs: 0, defaultProvider: 'deepseek' },
  })
  providerFetch(t, {
    '/user/balance': () =>
      jsonResponse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '10.00' }] }),
    '/inference/go/v1/usage': () => jsonResponse(LIVE_PAYLOAD),
  })
  const tool = captured.tools[0]
  const snapshot = await tool.execute({ action: 'snapshot' })
  assert.equal(snapshot.snapshot.provider.id, 'deepseek')
  assert.equal(snapshot.snapshot.balance.amount, 10)
  const byProvider = await tool.execute({ action: 'snapshot', providerId: 'opencode-go' })
  assert.equal(byProvider.snapshot.provider.id, 'opencode-go')
  assert.deepEqual(byProvider.snapshot.provider, { id: 'opencode-go', label: 'OpenCode', kind: 'windows' })
})
