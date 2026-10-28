/**
 * Custom usage adapter tests: declarative balance / windows adapters built from
 * management-page definitions. No network: `fetchJson` is a stub supplied by the
 * test, exactly like the Host wires its own key-bound fetch.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getJsonPath,
  makeCustomAdapter,
  sanitizeCustomProvider,
  validateCustomProvider,
} from '../lib/custom-provider.mjs'

const balanceDef = {
  providerId: 'my-gateway',
  label: 'My Gateway',
  kind: 'balance',
  baseURL: 'https://api.example.com',
  usagePath: '/v1/credits',
  apiKeyRef: 'MY_GATEWAY_API_KEY',
  amountPath: 'data.balance',
  currency: 'usd',
  grantedPath: 'data.granted',
  toppedUpPath: 'data.paid',
}

test('validateCustomProvider normalizes ids/labels/currency and rejects bad definitions', () => {
  const def = validateCustomProvider({ ...balanceDef, providerId: 'My-Gateway', currency: 'usd', usagePath: 'v1/credits' })
  assert.equal(def.providerId, 'my-gateway')
  assert.equal(def.usagePath, '/v1/credits')
  assert.equal(def.currency, 'USD')
  assert.throws(() => validateCustomProvider({ ...balanceDef, providerId: 'Bad Id' }), (error) => error.code === 'parse')
  assert.throws(() => validateCustomProvider({ ...balanceDef, baseURL: 'ftp://x' }), (error) => error.code === 'parse')
  assert.throws(() => validateCustomProvider({ ...balanceDef, amountPath: '' }), (error) => error.code === 'parse')
  assert.equal(sanitizeCustomProvider({ ...balanceDef, kind: 'nope' }), null)
})

test('getJsonPath walks objects and array indexes', () => {
  const value = { data: { limits: [{ percent: 42 }] } }
  assert.equal(getJsonPath(value, 'data.limits.0.percent'), 42)
  assert.equal(getJsonPath(value, 'data.missing.deep'), undefined)
  assert.equal(getJsonPath(value, ''), undefined)
})

test('a balance adapter normalizes amount/currency/granted/toppedUp', async () => {
  const adapter = makeCustomAdapter(validateCustomProvider(balanceDef))
  assert.equal(adapter.kind, 'balance')
  const result = await adapter.read({
    now: 1_700_000_000_000,
    fetchJson: async (url) => {
      assert.equal(url, 'https://api.example.com/v1/credits')
      return { data: { balance: '12.5', granted: 2, paid: '10.5' } }
    },
  })
  assert.equal(result.kind, 'balance')
  assert.deepEqual(result.balance, { amount: 12.5, currency: 'USD', granted: 2, toppedUp: 10.5 })
  assert.equal(result.windows.rolling, null)
})

test('a windows adapter maps percent/reset paths, including fraction scale', async () => {
  const def = validateCustomProvider({
    providerId: 'window-gw',
    label: 'Window GW',
    kind: 'windows',
    kindLabel: 'x',
    baseURL: 'https://gw.example.com',
    usagePath: '/usage',
    windows: {
      rolling: { percentPath: 'limits.hour.used', resetPath: 'limits.hour.reset' },
      weekly: { percentPath: 'limits.week.used', resetPath: 'limits.week.reset' },
    },
    percentScale: 'fraction',
  })
  const adapter = makeCustomAdapter(def)
  const now = 1_700_000_000_000
  const result = await adapter.read({
    now,
    fetchJson: async () => ({ limits: { hour: { used: 0.25, reset: now + 3600_000 }, week: { used: 0.5 } } }),
  })
  assert.equal(result.kind, 'windows')
  assert.equal(result.windows.rolling.percent, 25)
  assert.equal(result.windows.weekly.percent, 50)
  assert.equal(result.windows.monthly, null)
  assert.equal(result.windows.rolling.resetsAt, new Date(now + 3600_000).toISOString())
})

test('a windows adapter throws when no configured path resolves', async () => {
  const adapter = makeCustomAdapter(
    validateCustomProvider({
      providerId: 'window-gw',
      label: 'Window GW',
      kind: 'windows',
      baseURL: 'https://gw.example.com',
      usagePath: '/usage',
      windows: { rolling: { percentPath: 'x.used' } },
    }),
  )
  await assert.rejects(() => adapter.read({ fetchJson: async () => ({}) }), (error) => error.code === 'parse')
})
