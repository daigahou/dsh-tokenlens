/**
 * Provider adapter tests.
 *
 * Fixtures come from the live APIs (2026-10-25) where possible:
 *   - OpenCode: real usage payload;
 *   - Command Code: the real free-tier payload of this machine's key, plus a
 *     synthetic paid-plan payload built from the documented response shape;
 *   - DeepSeek: the real `/user/balance` payload.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { UsageError } from '../lib/go-usage.mjs'
import {
  ADAPTERS,
  adapterFor,
  balanceFromWallets,
  canonicalProviderId,
  commandcodePlanLabel,
  joinUrl,
  makeWindow,
  parseCommandCode,
  parseDeepseekBalance,
  parseMoonshotBalance,
  parseOpenRouterCredits,
  parseSiliconflowBalance,
  parseStepfunBalance,
  parseNovitaBalance,
  parseHyperbolicBalance,
  parseDeepinfraBalance,
  parseZaiQuota,
  parseMinimaxRemains,
  parseOpencodeGo,
  toNumber,
  usedPercent,
} from '../lib/providers.mjs'

const NOW = Date.parse('2026-10-25T09:55:00.000Z')

const OPENCODE_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 8, resetsAt: '2026-10-25T11:31:25.000Z' },
    weekly: { status: 'ok', percent: 24, resetsAt: '2026-10-26T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 32, resetsAt: '2026-11-09T14:08:58.000Z' },
  },
}

/** The live free-tier response of this machine's Command Code key. */
const COMMANDCODE_FREE = {
  credits: {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: { limited: false, exceeded: null, fiveHour: null, weekly: null },
    sandboxAccess: false,
    sandboxMinutes: null,
  },
  subscription: { success: true, data: null },
  whoami: { success: true, user: { id: 'u1', name: 'Acme Studio', email: 'x@example.com', userName: 'test-user' }, org: null },
}

/** A synthetic paid plan shaped exactly like the documented response. */
const COMMANDCODE_PAID = {
  credits: {
    credits: { monthlyCredits: 4.5, purchasedCredits: 0, monthlyCreditsGranted: 10, premiumMonthlyCredits: 0, opensourceMonthlyCredits: 0 },
    windowLimits: {
      limited: false,
      exceeded: null,
      fiveHour: { cap: 2.5, used: 0.5, resetAt: 1793000000 },
      weekly: { cap: 7.5, used: 3, resetAt: '2026-11-01T00:00:00.000Z' },
    },
  },
  subscription: { success: true, data: { planId: 'individual-go-v1', status: 'active', currentPeriodEnd: '2026-11-09T00:00:00.000Z' } },
  whoami: { success: true, user: { name: 'Acme Studio', userName: 'test-user' } },
}

test('toNumber / usedPercent handle strings, nulls and zero caps', () => {
  assert.equal(toNumber('2.26'), 2.26)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber(Number.NaN), null)
  assert.equal(usedPercent(0.5, 2.5), 20)
  assert.equal(usedPercent(3, '7.5'), 40)
  assert.equal(usedPercent(1, 0), null)
  assert.equal(usedPercent(null, 2), null)
  assert.equal(usedPercent(5, 2), 100, 'over-limit clamps to 100')
})

test('makeWindow normalizes ISO/epoch timestamps and the percentage', () => {
  const fromIso = makeWindow('rolling', { percent: '8', status: 'ok', resetsAt: '2026-10-25T11:31:25.000Z' }, NOW)
  assert.equal(fromIso.percent, 8)
  assert.equal(fromIso.resetsAt, '2026-10-25T11:31:25.000Z')
  assert.equal(fromIso.remainingMs, Date.parse('2026-10-25T11:31:25.000Z') - NOW)
  assert.equal(fromIso.used, undefined, 'no native capacity unless the provider reports it')
  assert.equal(fromIso.cap, undefined)
  assert.equal(fromIso.unit, undefined)
  const withMoney = makeWindow('rolling', { percent: 20, used: '0.5', cap: 2.5, unit: 'USD' }, NOW)
  assert.equal(withMoney.used, 0.5)
  assert.equal(withMoney.cap, 2.5)
  assert.equal(withMoney.unit, 'USD')
  const partialMoney = makeWindow('rolling', { percent: 20, used: 1 }, NOW)
  assert.equal(partialMoney.used, 1)
  assert.equal(partialMoney.cap, undefined)
  assert.equal(partialMoney.unit, undefined, 'no unit without both numbers')
  const fromEpochSeconds = makeWindow('monthly', { percent: 50, resetsAt: 1793000000 }, NOW)
  assert.equal(fromEpochSeconds.resetsAt, new Date(1793000000 * 1000).toISOString())
  const missing = makeWindow('weekly', { percent: 12 }, NOW)
  assert.equal(missing.resetsAt, null)
  assert.equal(missing.remainingMs, null)
  assert.equal(missing.status, 'unknown')
  assert.equal(makeWindow('weekly', { percent: null }, NOW).percent, null)
})

test('parseOpencodeGo maps the three percentage windows', () => {
  const result = parseOpencodeGo(OPENCODE_PAYLOAD, NOW)
  assert.deepEqual(Object.keys(result.windows), ['rolling', 'weekly', 'monthly'])
  assert.equal(result.windows.rolling.percent, 8)
  assert.equal(result.windows.weekly.percent, 24)
  assert.equal(result.windows.monthly.resetsAt, '2026-11-09T14:08:58.000Z')
})

test('parseOpencodeGo is tolerant of a missing window but not of a missing usage object', () => {
  const partial = parseOpencodeGo({ usage: { rolling: { percent: 5 } } }, NOW)
  assert.equal(partial.windows.rolling.percent, 5)
  assert.equal(partial.windows.weekly, null)
  assert.equal(partial.windows.monthly, null)
  assert.throws(() => parseOpencodeGo({}, NOW), (error) => error instanceof UsageError && error.code === 'parse')
  assert.throws(() => parseOpencodeGo({ usage: {} }, NOW), (error) => error.code === 'parse')
})

test('parseCommandCode handles the live free-tier payload (no plan, no windows)', () => {
  const result = parseCommandCode(COMMANDCODE_FREE, NOW)
  assert.equal(result.plan, null)
  assert.equal(result.windows.rolling, null)
  assert.equal(result.windows.weekly, null)
  assert.equal(result.windows.monthly.percent, null, 'an unsized monthly credit is not fake 0%')
  assert.equal(result.windows.monthly.status, 'unknown')
  assert.equal(result.windows.monthly.used, undefined, 'no money when the API did not report it')
  assert.equal(result.windows.monthly.cap, undefined)
  assert.equal(result.windows.monthly.unit, undefined)
  assert.deepEqual(result.credits, { remaining: 0, granted: null, purchased: 0 })
  assert.equal(result.account.userName, 'test-user')
})

test('parseCommandCode maps a paid plan: 5-hour, weekly and monthly credit usage', () => {
  const result = parseCommandCode(COMMANDCODE_PAID, NOW)
  assert.deepEqual(result.plan, { id: 'individual-go-v1', label: 'Go' })
  assert.equal(result.windows.rolling.percent, 20)
  assert.equal(result.windows.weekly.percent, 40)
  assert.equal(result.windows.monthly.percent, 55, '(10 - 4.5) / 10')
  assert.equal(result.windows.monthly.resetsAt, '2026-11-09T00:00:00.000Z')
  assert.deepEqual(result.credits, { remaining: 4.5, granted: 10, purchased: 0 })
  assert.equal(result.windows.rolling.resetsAt, new Date(1793000000 * 1000).toISOString())
  // Provider-native capacity in dollars travels with the window.
  assert.equal(result.windows.rolling.used, 0.5)
  assert.equal(result.windows.rolling.cap, 2.5)
  assert.equal(result.windows.rolling.unit, 'USD')
  assert.equal(result.windows.weekly.used, 3)
  assert.equal(result.windows.weekly.cap, 7.5)
  assert.equal(result.windows.monthly.used, 5.5)
  assert.equal(result.windows.monthly.cap, 10)
  assert.equal(result.windows.monthly.unit, 'USD')
})

test('parseCommandCode marks limited windows and tolerates a missing subscription', () => {
  const limited = structuredClone(COMMANDCODE_PAID)
  limited.credits.windowLimits.limited = true
  const result = parseCommandCode(limited, NOW)
  assert.equal(result.windows.rolling.status, 'limited')
  assert.equal(result.windows.weekly.status, 'limited')

  const noSubscription = parseCommandCode({ ...COMMANDCODE_PAID, subscription: undefined }, NOW)
  assert.equal(noSubscription.plan, null)
  assert.equal(noSubscription.windows.monthly.percent, 55, 'the API-reported grant still sizes the month')
  assert.equal(noSubscription.windows.monthly.resetsAt, null, 'no billing period is known')
})

test('plan labels are documented ids only; grants are never guessed', () => {
  assert.equal(commandcodePlanLabel('individual-go-v1'), 'Go')
  assert.equal(commandcodePlanLabel('individual-go'), 'Go')
  assert.equal(commandcodePlanLabel('individual-goat'), 'individual-goat', 'an unknown plan keeps its raw id')
  assert.equal(commandcodePlanLabel('unknown-plan'), 'unknown-plan')
  assert.equal(commandcodePlanLabel(null), null)

  // A grant the API did not report must not size the monthly percentage.
  const noGrant = structuredClone(COMMANDCODE_PAID)
  delete noGrant.credits.credits.monthlyCreditsGranted
  const noGrantParsed = parseCommandCode(noGrant, NOW)
  assert.equal(noGrantParsed.windows.monthly.percent, null)
  assert.deepEqual(noGrantParsed.credits, { remaining: 4.5, granted: null, purchased: 0 })
})

test('canonicalProviderId maps picker ids onto adapters', () => {
  assert.equal(canonicalProviderId('deepseek-official'), 'deepseek')
  assert.equal(canonicalProviderId('opencode-go'), 'opencode-go')
  assert.equal(canonicalProviderId('commandcode'), 'commandcode')
  assert.equal(canonicalProviderId('deepseek-account'), 'deepseek-account')
  assert.equal(canonicalProviderId(undefined), undefined)
})

test('balanceFromWallets projects Platform wallets', () => {
  const result = balanceFromWallets(
    [{ currency: 'CNY', balance: '2.2679' }, { currency: 'USD', balance: '0.00' }],
    [{ currency: 'CNY', balance: '1.50' }],
  )
  assert.deepEqual(result.balance, {
    amount: 2.2679,
    currency: 'CNY',
    wallets: [{ currency: 'CNY', amount: 2.2679 }, { currency: 'USD', amount: 0 }],
    bonus: [{ currency: 'CNY', amount: 1.5 }],
  })
  assert.throws(() => balanceFromWallets([]), (error) => error.code === 'parse')
})

test('the DeepSeek Account adapter reads the account service, not the network', async () => {
  let requestedClient = null
  const result = await ADAPTERS['deepseek-account'].read({
    provider: { service: 'deepseekAccount', apiKeyRef: '' },
    fetchJson: async () => {
      throw new Error('the account adapter must not touch the network')
    },
    services: {
      account: {
        async getBalance(client) {
          requestedClient = client
          return { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] }
        },
      },
    },
    now: NOW,
  })
  assert.equal(result.balance.amount, 12.34)
  assert.equal(result.balance.currency, 'CNY')
  assert.equal(requestedClient.locale, 'zh-CN')
  assert.equal(typeof requestedClient.version, 'string')
  assert.equal(Number.isInteger(requestedClient.timezoneOffsetSeconds), true)

  // Signed out and failed queries become typed errors the client renders as
  // "hide the chip" and "warning + retry" respectively.
  await assert.rejects(
    ADAPTERS['deepseek-account'].read({ provider: {}, services: { account: { getBalance: async () => null } }, now: NOW }),
    (error) => error instanceof UsageError && error.code === 'missing-key',
  )
  await assert.rejects(
    ADAPTERS['deepseek-account'].read({
      provider: {},
      services: { account: { getBalance: async () => ({ status: 'failed' }) } },
      now: NOW,
    }),
    (error) => error.code === 'network' && error.retryable === true,
  )
  await assert.rejects(
    ADAPTERS['deepseek-account'].read({ provider: {}, services: {}, now: NOW }),
    (error) => error.code === 'missing-key',
  )
})

test('parseDeepseekBalance reads the live balance payload', () => {
  const result = parseDeepseekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '2.26', granted_balance: '0.00', topped_up_balance: '2.26' }],
  })
  assert.deepEqual(result.balance, { amount: 2.26, currency: 'CNY', granted: 0, toppedUp: 2.26 })
  assert.equal(result.available, true)
  assert.equal(result.windows.rolling, null)
  assert.throws(() => parseDeepseekBalance({}), (error) => error.code === 'parse')
})

test('joinUrl and adapterFor', () => {
  assert.equal(joinUrl('https://opencode.ai/', '/inference/go/v1/usage'), 'https://opencode.ai/inference/go/v1/usage')
  assert.equal(joinUrl('https://api.deepseek.com', 'user/balance'), 'https://api.deepseek.com/user/balance')
  assert.throws(() => joinUrl('', '/x'), (error) => error.code === 'disabled')
  assert.equal(adapterFor('opencode-go'), ADAPTERS['opencode-go'])
  assert.equal(adapterFor('commandcode'), ADAPTERS.commandcode)
  assert.equal(adapterFor('some-future-provider'), undefined)
})

test('the Command Code adapter survives a failing optional subscription/whoami read', async () => {
  const reads = []
  const fetchJson = async (url) => {
    reads.push(url)
    if (url.endsWith('/alpha/billing/credits')) return COMMANDCODE_PAID.credits
    if (url.endsWith('/alpha/billing/subscriptions')) return COMMANDCODE_PAID.subscription
    if (url.endsWith('/alpha/whoami')) throw new UsageError('network', 'offline')
    throw new Error(`unexpected url ${url}`)
  }
  const result = await ADAPTERS.commandcode.read({
    provider: { baseURL: 'https://api.commandcode.ai' },
    fetchJson,
    now: NOW,
  })
  assert.equal(readChecks(reads), true)
  assert.equal(result.windows.rolling.percent, 20)
  assert.equal(result.account, null, 'whoami failure only costs the account label')
})

test('the OpenCode adapter reads the usage endpoint', async () => {
  const urls = []
  const result = await ADAPTERS['opencode-go'].read({
    provider: { baseURL: 'https://opencode.ai', usagePath: '/inference/go/v1/usage' },
    fetchJson: async (url) => {
      urls.push(url)
      return OPENCODE_PAYLOAD
    },
    now: NOW,
  })
  assert.deepEqual(urls, ['https://opencode.ai/inference/go/v1/usage'])
  assert.equal(result.windows.weekly.percent, 24)
})

function readChecks(urls) {
  return (
    urls.length === 3 &&
    urls.some((url) => url.endsWith('/alpha/billing/credits')) &&
    urls.some((url) => url.endsWith('/alpha/billing/subscriptions')) &&
    urls.some((url) => url.endsWith('/alpha/whoami'))
  )
}

test('StepFun flat account payload becomes a balance', () => {
  const result = parseStepfunBalance({ object: 'account', type: 'prepaid', balance: 12.5, total_cash_balance: 2.5, total_voucher_balance: 10 })
  assert.equal(result.balance.amount, 12.5)
  assert.equal(result.balance.currency, 'CNY')
  assert.equal(result.balance.granted, 10)
  assert.equal(result.balance.toppedUp, 2.5)
  assert.equal(result.balance.postpaid, false)
  assert.equal(parseStepfunBalance({ balance: 1, type: 'postpaid' }, 'https://api.stepfun.ai').balance.currency, 'USD')
  assert.throws(() => parseStepfunBalance({ object: 'account' }), (error) => error.code === 'parse')
})

test('Novita balances are converted from 1/10000 USD', () => {
  const result = parseNovitaBalance({ availableBalance: '125000', cashBalance: '100000', creditLimit: '25000' })
  assert.equal(result.balance.amount, 12.5)
  assert.equal(result.balance.currency, 'USD')
  assert.equal(result.balance.toppedUp, 10)
})

test('Hyperbolic cents and DeepInfra prepaid signs normalize to USD', () => {
  assert.equal(parseHyperbolicBalance({ balanceCents: 12345 }).balance.amount, 123.45)
  const prepaid = parseDeepinfraBalance({ data: { stripe_balance: -12.34, spending_limit: 50 } })
  assert.equal(prepaid.balance.amount, 12.34)
  assert.equal(prepaid.balance.owed, 0)
  const owed = parseDeepinfraBalance({ data: { stripe_balance: 8 } })
  assert.equal(owed.balance.amount, 0)
  assert.equal(owed.balance.owed, 8)
})

test('Z.ai quota rows map to the canonical 5h/weekly/monthly windows', () => {
  const now = Date.now()
  const payload = { success: true, data: { level: 'pro', limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: now + 3600_000 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 52, nextResetTime: now + 86_400_000 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 12.3, nextResetTime: now + 86_400_000 },
  ] } }
  const result = parseZaiQuota(payload, now)
  assert.equal(result.windows.rolling.percent, 42)
  assert.equal(result.windows.weekly.percent, 52)
  assert.equal(result.windows.monthly.percent, 12.3)
  assert.equal(result.windows.rolling.resetsAt, new Date(now + 3600_000).toISOString())
  assert.equal(result.plan.label, 'pro')
  assert.throws(() => parseZaiQuota({ success: false }), (error) => error.code === 'parse')
  assert.throws(() => parseZaiQuota({ success: true, data: { limits: [] } }), (error) => error.code === 'parse')
})

test('MiniMax remaining percentages are inverted into used windows', () => {
  const now = Date.now()
  const payload = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 72.5, current_weekly_remaining_percent: 85, current_weekly_status: 1, end_time: now + 3600_000, weekly_end_time: now + 86_400_000 },
    ],
  }
  const result = parseMinimaxRemains(payload, now)
  assert.equal(result.windows.rolling.percent, 27.5)
  assert.equal(result.windows.weekly.percent, 15)
  assert.throws(() => parseMinimaxRemains({ base_resp: { status_code: 1004 } }), (error) => error.code === 'parse')
})
