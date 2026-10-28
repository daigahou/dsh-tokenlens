/**
 * Provider adapters: how each supported provider reports its plan usage.
 *
 * The plugin is provider-aware: the browser half tells the Host which provider
 * the user currently selected, and the Host reads *that* provider's usage with
 * the matching adapter. Three providers are supported today:
 *
 *   - `opencode-go`  — OpenCode / Go Plus allowance windows (percentages);
 *   - `commandcode`  — Command Code billing: 5-hour + weekly dollars, monthly credits;
 *   - `deepseek`     — DeepSeek platform balance (CNY/USD), no allowance windows.
 *
 * Every adapter normalizes to one shape (see PROTOCOL.md):
 *
 *   { provider: {id,label,kind}, plan, windows|balance|credits }
 *
 * The windows object always has the canonical ids `rolling` (5-hour), `weekly`
 * and `monthly`; a window the provider cannot report is `null` rather than a
 * fake zero.
 */
import { createHash, createHmac } from 'node:crypto'
import { normalizePercent, parseTimestamp, UsageError } from './go-usage.mjs'

/** Canonical window ids, in display order. */
export const WINDOW_IDS = ['rolling', 'weekly', 'monthly']

/** Display labels; the client localizes, this is the fallback/friendly name. */
export const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode',
  commandcode: 'Command Code',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  moonshot: 'Moonshot / Kimi',
  siliconflow: 'SiliconFlow',
  stepfun: 'StepFun',
  novita: 'Novita',
  hyperbolic: 'Hyperbolic',
  deepinfra: 'DeepInfra',
  zai: 'Z.ai GLM Coding Plan',
  minimax: 'MiniMax Coding Plan',
  sensenova: 'SenseNova 商汤',
  volcengine: '火山引擎',
  qwen: '通义千问',
  qianfan: '百度千帆',
  'zhipu-cn': '智谱 AI（国内版）',
  'intern-ai': 'Intern AI（书生）',
  'agnes-ai': 'Agnes AI',
  'open-design': 'Open Design',
  hunyuan: '腾讯混元',
  spark: '讯飞星火',
  yi: '零一万物',
  baichuan: '百川智能',
}

/**
 * Default per-provider configuration. A profile overrides any of these by
 * repeating the provider id under `providers:`; the old flat `baseURL` /
 * `usagePath` / `apiKeyRef` fields still override `opencode-go`.
 */
export const PROVIDER_DEFAULTS = {
  'opencode-go': {
    kind: 'windows',
    label: 'OpenCode',
    shortLabel: 'OC',
    baseURL: 'https://opencode.ai',
    usagePath: '/inference/go/v1/usage',
    apiKeyRef: 'OPENCODE_GO_API_KEY',
    // Where the provider's own web console / usage page lives.
    consoleUrl: 'https://opencode.ai/console',
  },
  commandcode: {
    kind: 'windows',
    label: 'Command Code',
    shortLabel: 'CC',
    baseURL: 'https://api.commandcode.ai',
    creditsPath: '/alpha/billing/credits',
    subscriptionsPath: '/alpha/billing/subscriptions',
    whoamiPath: '/alpha/whoami',
    apiKeyRef: 'COMMANDCODE_API_KEY',
    consoleUrl: 'https://commandcode.ai/',
  },
  deepseek: {
    kind: 'balance',
    label: 'DeepSeek',
    shortLabel: 'DS',
    baseURL: 'https://api.deepseek.com',
    balancePath: '/user/balance',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    consoleUrl: 'https://platform.deepseek.com/usage',
  },
  openrouter: {
    kind: 'balance',
    label: 'OpenRouter',
    shortLabel: 'OR',
    baseURL: 'https://openrouter.ai',
    balancePath: '/api/v1/credits',
    apiKeyRef: 'OPENROUTER_API_KEY',
    consoleUrl: 'https://openrouter.ai/settings/credits',
  },
  moonshot: {
    kind: 'balance',
    label: 'Moonshot / Kimi',
    shortLabel: 'MS',
    baseURL: 'https://api.moonshot.cn',
    balancePath: '/v1/users/me/balance',
    apiKeyRef: 'MOONSHOT_API_KEY',
    consoleUrl: 'https://platform.moonshot.cn/console/info',
  },
  siliconflow: {
    kind: 'balance',
    label: 'SiliconFlow',
    shortLabel: 'SF',
    baseURL: 'https://api.siliconflow.cn',
    balancePath: '/v1/user/info',
    apiKeyRef: 'SILICONFLOW_API_KEY',
    consoleUrl: 'https://cloud.siliconflow.cn/account/overview',
  },
  stepfun: {
    kind: 'balance',
    label: 'StepFun',
    shortLabel: 'ST',
    baseURL: 'https://api.stepfun.com',
    balancePath: '/v1/accounts',
    apiKeyRef: 'STEP_API_KEY',
    consoleUrl: 'https://platform.stepfun.com/account/charge',
  },
  novita: {
    kind: 'balance',
    label: 'Novita',
    shortLabel: 'NV',
    baseURL: 'https://api.novita.ai',
    balancePath: '/openapi/v1/billing/balance/detail',
    apiKeyRef: 'NOVITA_API_KEY',
    consoleUrl: 'https://novita.ai/settings/billing',
  },
  hyperbolic: {
    kind: 'balance',
    label: 'Hyperbolic',
    shortLabel: 'HB',
    baseURL: 'https://api.hyperbolic.ai',
    balancePath: '/v2/customer/balance',
    apiKeyRef: 'HYPERBOLIC_API_KEY',
    consoleUrl: 'https://app.hyperbolic.ai/settings/billing',
  },
  deepinfra: {
    kind: 'balance',
    label: 'DeepInfra',
    shortLabel: 'DI',
    baseURL: 'https://api.deepinfra.com',
    balancePath: '/payment/checklist?compute_owed=true',
    apiKeyRef: 'DEEPINFRA_API_KEY',
    consoleUrl: 'https://deepinfra.com/dash/billing',
  },
  zai: {
    kind: 'windows',
    label: 'Z.ai GLM Coding Plan',
    shortLabel: 'ZAI',
    baseURL: 'https://api.z.ai',
    quotaPath: '/api/monitor/usage/quota/limit',
    apiKeyRef: 'ZAI_API_KEY',
    consoleUrl: 'https://z.ai/manage-apikey',
  },
  minimax: {
    kind: 'windows',
    label: 'MiniMax Coding Plan',
    shortLabel: 'MM',
    baseURL: 'https://api.minimax.io',
    quotaPath: '/v1/api/openplatform/coding_plan/remains',
    apiKeyRef: 'MINIMAX_API_KEY',
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/subscribe',
  },
  // Additional built-in providers (metadata pool; usage adapters are added
  // separately when a provider exposes a known usage endpoint).
  sensenova: {
    kind: 'balance',
    label: 'SenseNova 商汤',
    shortLabel: 'SN',
    baseURL: 'https://api.sensenova.cn',
    apiKeyRef: 'SENSENOVA_API_KEY',
    consoleUrl: 'https://console.sensenova.cn',
  },
  volcengine: {
    kind: 'windows',
    label: '火山引擎',
    shortLabel: 'VE',
    baseURL: 'https://ark.cn-beijing.volces.com',
    // Coding Plan / AgentPlan quota is a signed control-plane API; the key
    // pair comes from the environment (or the DSH credential service).
    quotaAction: 'GetCodingPlanUsage',
    quotaVersion: '2024-01-01',
    openApiHost: 'open.volcengineapi.com',
    region: 'cn-beijing',
    service: 'ark',
    apiKeyRef: 'VOLCENGINE_ACCESS_KEY_ID',
    secretAccessKeyRef: 'VOLCENGINE_SECRET_ACCESS_KEY',
    consoleUrl: 'https://console.volcengine.com/ark',
  },
  qwen: {
    kind: 'balance',
    label: '通义千问',
    shortLabel: 'QW',
    baseURL: 'https://dashscope.aliyuncs.com',
    apiKeyRef: 'DASHSCOPE_API_KEY',
    consoleUrl: 'https://bailian.console.aliyun.com',
  },
  qianfan: {
    kind: 'balance',
    label: '百度千帆',
    shortLabel: 'QF',
    baseURL: 'https://qianfan.baidubce.com',
    apiKeyRef: 'QIANFAN_API_KEY',
    consoleUrl: 'https://console.bce.baidu.com/qianfan',
  },
  'zhipu-cn': {
    kind: 'windows',
    label: '智谱 AI（国内版）',
    shortLabel: 'ZP',
    baseURL: 'https://open.bigmodel.cn',
    quotaPath: '/api/monitor/usage/quota/limit',
    apiKeyRef: 'ZHIPU_API_KEY',
    consoleUrl: 'https://bigmodel.cn/console/overview',
  },
  'intern-ai': {
    kind: 'balance',
    label: 'Intern AI（书生）',
    shortLabel: 'IA',
    baseURL: 'https://chat.intern-ai.org.cn',
    apiKeyRef: 'INTERN_API_KEY',
    consoleUrl: 'https://chat.intern-ai.org.cn',
  },
  'agnes-ai': {
    kind: 'balance',
    label: 'Agnes AI',
    shortLabel: 'AG',
    baseURL: 'https://api.agnes.ai',
    apiKeyRef: 'AGNES_API_KEY',
    consoleUrl: 'https://agnes.ai',
  },
  'open-design': {
    kind: 'balance',
    label: 'Open Design',
    shortLabel: 'OD',
    baseURL: 'https://api.open-design.ai',
    apiKeyRef: 'OPEN_DESIGN_API_KEY',
    consoleUrl: 'https://open-design.ai',
  },
  hunyuan: {
    kind: 'balance',
    label: '腾讯混元',
    shortLabel: 'HY',
    baseURL: 'https://hunyuan.tencentcloudapi.com',
    apiKeyRef: 'HUNYUAN_API_KEY',
    consoleUrl: 'https://console.cloud.tencent.com/hunyuan',
  },
  spark: {
    kind: 'balance',
    label: '讯飞星火',
    shortLabel: 'SP',
    baseURL: 'https://spark-api-open.xf-yun.com',
    apiKeyRef: 'SPARK_API_KEY',
    consoleUrl: 'https://console.xfyun.cn',
  },
  yi: {
    kind: 'balance',
    label: '零一万物',
    shortLabel: 'YI',
    baseURL: 'https://api.lingyiwanwu.com',
    apiKeyRef: 'YI_API_KEY',
    consoleUrl: 'https://platform.lingyiwanwu.com',
  },
  baichuan: {
    kind: 'balance',
    label: '百川智能',
    shortLabel: 'BC',
    baseURL: 'https://api.baichuan-ai.com',
    apiKeyRef: 'BAICHUAN_API_KEY',
    consoleUrl: 'https://platform.baichuan-ai.com',
  },
  'deepseek-account': {
    kind: 'balance',
    label: 'DeepSeek Account',
    shortLabel: 'DSA',
    // No endpoint and no key: the balance comes from the composed account service.
    service: 'deepseekAccount',
    apiKeyRef: '',
    consoleUrl: 'https://platform.deepseek.com/usage',
  },
}

/**
 * Provider ids the model picker uses that do not match an adapter id.
 * Verified on this machine: the API-key DeepSeek adapter announces itself as
 * `deepseek-official`; the picker never emits the bare `deepseek`.
 */
export const PROVIDER_ALIASES = {
  'deepseek-official': 'deepseek',
  // The model picker names the OpenCode route `opencode`; Go is its plan tier.
  'opencode': 'opencode-go',
}

/** The adapter id behind a picker/selection provider id. */
export function canonicalProviderId(providerId) {
  if (typeof providerId !== 'string') return providerId
  return PROVIDER_ALIASES[providerId] ?? providerId
}

/**
 * Command Code plan labels we have documented evidence for (the public pricing
 * page and the CodexBar provider notes). An unknown plan keeps its raw id: this
 * plugin never invents a plan name or a monthly grant it was not told.
 */
const COMMANDCODE_PLAN_LABELS = {
  'individual-go-v1': 'Go',
  'individual-go': 'Go',
}

/** A friendly plan label for a Command Code plan id (raw id when unknown). */
export function commandcodePlanLabel(planId) {
  if (typeof planId !== 'string' || planId === '') return null
  return COMMANDCODE_PLAN_LABELS[planId] ?? planId
}

/**
 * Build one normalized window. `percent` may be `null` when a provider cannot
 * size the window; `resetsAt` accepts an ISO string, epoch seconds or epoch
 * milliseconds and always leaves as ISO (or `null`). A provider that reports its
 * allowance in a native unit (Command Code: dollars) also contributes
 * `used` / `cap` / `unit`, which the dialog shows next to the percentage.
 */
export function makeWindow(id, input, now) {
  const percent = normalizePercent(input?.percent)
  const resetsMs = parseTimestamp(input?.resetsAt)
  const used = toNumber(input?.used)
  const cap = toNumber(input?.cap)
  const unit = typeof input?.unit === 'string' && input.unit !== '' ? input.unit : undefined
  return {
    id,
    percent,
    status: typeof input?.status === 'string' && input.status !== '' ? input.status : 'unknown',
    resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
    remainingMs: resetsMs === null ? null : Math.max(0, resetsMs - now),
    ...(used === null ? {} : { used }),
    ...(cap === null ? {} : { cap }),
    ...(used === null || cap === null || unit === undefined ? {} : { unit }),
  }
}

/** A window object with all three canonical ids, each possibly `null`. */
function windowSet(inputs, now) {
  const windows = {}
  for (const id of WINDOW_IDS) {
    const raw = inputs !== null && typeof inputs === 'object' ? inputs[id] : undefined
    windows[id] = raw === undefined || raw === null ? null : makeWindow(id, raw, now)
  }
  return windows
}

/** A number from a JSON number or numeric string; `null` when unusable. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** Used/limit as a 0..100 percentage; `null` when the limit is not positive. */
export function usedPercent(used, limit) {
  const u = toNumber(used)
  const l = toNumber(limit)
  if (u === null || l === null || l <= 0) return null
  return normalizePercent((u / l) * 100)
}

/**
 * Parse the OpenCode payload (percentages).
 *
 * @returns `{ windows }` with `rolling` / `weekly` / `monthly`.
 */
export function parseOpencodeGo(payload, now = Date.now()) {
  const usage = payload?.usage
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new UsageError('parse', 'the OpenCode response has no usage object')
  }
  const inputs = {}
  for (const id of WINDOW_IDS) {
    const raw = usage[id]
    if (raw === null || typeof raw !== 'object') continue
    inputs[id] = { percent: raw.percent, status: raw.status, resetsAt: raw.resetsAt }
  }
  const windows = windowSet(inputs, now)
  if (WINDOW_IDS.every((id) => windows[id] === null)) {
    throw new UsageError('parse', 'the OpenCode response has no usage windows')
  }
  return { windows }
}

/**
 * Parse Command Code billing documents.
 *
 * `credits`:  `{ credits: { monthlyCredits, purchasedCredits, monthlyCreditsGranted? },
 *               windowLimits: { limited, fiveHour: {cap,used,resetAt}|null, weekly: … } }`
 * `subscription`: `{ success, data: { planId, status, currentPeriodEnd }|null }`
 * `whoami`:   `{ success, user: { name, userName } }`
 *
 * Semantics verified against the live API and the CodexBar reference client:
 * `monthlyCredits` is the REMAINING monthly credit (USD), `granted` is the
 * plan's monthly grant; the windows' `used`/`cap` are USD, `resetAt` is epoch
 * seconds or milliseconds.
 */
export function parseCommandCode({ credits, subscription, whoami } = {}, now = Date.now()) {
  const document = credits !== null && typeof credits === 'object' ? credits : {}
  const credit = document.credits !== null && typeof document.credits === 'object' ? document.credits : {}
  const limits = document.windowLimits !== null && typeof document.windowLimits === 'object'
    ? document.windowLimits
    : {}
  const limited = limits.limited === true || limits.exceeded === true
  const windowStatus = limited ? 'limited' : 'ok'
  const windowFrom = (raw) => {
    if (raw === null || typeof raw !== 'object') return null
    return {
      percent: usedPercent(raw.used, raw.cap),
      status: windowStatus,
      resetsAt: raw.resetAt,
      used: toNumber(raw.used),
      cap: toNumber(raw.cap),
      unit: 'USD',
    }
  }
  const windows = windowSet(
    { rolling: windowFrom(limits.fiveHour), weekly: windowFrom(limits.weekly) },
    now,
  )

  const data = subscription?.success === true && subscription?.data !== null && typeof subscription?.data === 'object'
    ? subscription.data
    : null
  const planId = typeof data?.planId === 'string' && data.planId !== '' ? data.planId : null
  const plan = planId === null ? null : { id: planId, label: commandcodePlanLabel(planId) }

  const remaining = toNumber(credit.monthlyCredits)
  // Only the API-reported grant sizes the monthly percentage: this plugin never
  // guesses a grant from a plan catalog (the live free-tier response omits it).
  const granted = toNumber(credit.monthlyCreditsGranted)
  const purchased = toNumber(credit.purchasedCredits)
  const monthlyPercent =
    remaining !== null && granted !== null && granted > 0
      ? normalizePercent(((granted - remaining) / granted) * 100)
      : null
  windows.monthly = makeWindow(
    'monthly',
    {
      percent: monthlyPercent,
      status: monthlyPercent === null ? 'unknown' : windowStatus,
      resetsAt: data?.currentPeriodEnd ?? null,
      used: remaining !== null && granted !== null && granted > 0 ? Math.max(0, granted - remaining) : null,
      cap: granted,
      unit: 'USD',
    },
    now,
  )

  const profile = whoami?.success === true && whoami?.user !== null && typeof whoami?.user === 'object'
    ? whoami.user
    : null

  return {
    windows,
    plan,
    credits:
      remaining === null && granted === null && purchased === null
        ? null
        : { remaining, granted, purchased },
    account:
      profile === null
        ? null
        : {
            name: typeof profile.name === 'string' ? profile.name : null,
            userName: typeof profile.userName === 'string' ? profile.userName : null,
          },
  }
}

/**
 * Parse the DeepSeek balance payload.
 *
 * `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }`
 * Balances arrive as strings; the first entry is the account currency.
 */
export function parseDeepseekBalance(payload, now = Date.now()) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const first = infos.find((info) => info !== null && typeof info === 'object')
  if (first === undefined) throw new UsageError('parse', 'the DeepSeek response has no balance info')
  const amount = toNumber(first.total_balance)
  if (amount === null) throw new UsageError('parse', 'the DeepSeek response has no usable balance')
  return {
    windows: windowSet({}, now),
    balance: {
      amount,
      currency: typeof first.currency === 'string' && first.currency !== '' ? first.currency : 'CNY',
      granted: toNumber(first.granted_balance),
      toppedUp: toNumber(first.topped_up_balance),
    },
    available: payload?.is_available !== false,
  }
}


/** OpenRouter `/api/v1/credits`: `{data:{total_credits,total_usage}}` (USD). */
export function parseOpenRouterCredits(payload, now = Date.now()) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : null
  const total = toNumber(data?.total_credits)
  const used = toNumber(data?.total_usage)
  if (total === null && used === null) throw new UsageError('parse', 'the OpenRouter response has no credits')
  const amount = Math.max(0, (total ?? 0) - (used ?? 0))
  return {
    windows: windowSet({}, now),
    balance: { amount, currency: 'USD', granted: total ?? undefined, toppedUp: undefined },
    available: true,
  }
}

/** Moonshot `/v1/users/me/balance`: `{data:{available_balance,…}}` (CNY). */
export function parseMoonshotBalance(payload, now = Date.now()) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : null
  const amount = toNumber(data?.available_balance)
  if (amount === null) throw new UsageError('parse', 'the Moonshot response has no usable balance')
  return { windows: windowSet({}, now), balance: { amount, currency: 'CNY' }, available: true }
}

/** SiliconFlow `/v1/user/info`: `{data:{totalBalance,balance,…}}` (CNY). */
export function parseSiliconflowBalance(payload, now = Date.now()) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : null
  const amount = toNumber(data?.totalBalance) ?? toNumber(data?.balance)
  if (amount === null) throw new UsageError('parse', 'the SiliconFlow response has no usable balance')
  return { windows: windowSet({}, now), balance: { amount, currency: 'CNY' }, available: true }
}


/** StepFun `/v1/accounts`: `{object:"account", type, balance, total_cash_balance, total_voucher_balance}`. */
export function parseStepfunBalance(payload, baseURL = '', now = Date.now()) {
  const amount = toNumber(payload?.balance)
  if (amount === null) throw new UsageError('parse', 'the StepFun response has no usable balance')
  const currency = String(baseURL).includes('stepfun.ai') ? 'USD' : 'CNY'
  return {
    windows: windowSet({}, now),
    balance: {
      amount,
      currency,
      granted: toNumber(payload?.total_voucher_balance),
      toppedUp: toNumber(payload?.total_cash_balance),
      postpaid: payload?.type === 'postpaid',
    },
    available: true,
  }
}

/** Novita `/openapi/v1/billing/balance/detail`: strings in 1/10000 USD. */
export function parseNovitaBalance(payload, now = Date.now()) {
  const available = toNumber(payload?.availableBalance)
  if (available === null) throw new UsageError('parse', 'the Novita response has no usable balance')
  return {
    windows: windowSet({}, now),
    balance: { amount: available / 10000, currency: 'USD', toppedUp: (toNumber(payload?.cashBalance) ?? 0) / 10000 },
    available: true,
  }
}

/** Hyperbolic `/v2/customer/balance`: `{balanceCents, maxOverdraftCents}` (USD cents). */
export function parseHyperbolicBalance(payload, now = Date.now()) {
  const cents = toNumber(payload?.balanceCents)
  if (cents === null) throw new UsageError('parse', 'the Hyperbolic response has no usable balance')
  return { windows: windowSet({}, now), balance: { amount: cents / 100, currency: 'USD' }, available: true }
}

/** DeepInfra internal `/payment/checklist`: `{data:{stripe_balance,…}}`, negative = prepaid funds. */
export function parseDeepinfraBalance(payload, now = Date.now()) {
  const data = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : null
  const stripe = toNumber(data?.stripe_balance)
  if (stripe === null) throw new UsageError('parse', 'the DeepInfra response has no usable balance')
  return {
    windows: windowSet({}, now),
    balance: {
      amount: stripe < 0 ? -stripe : 0,
      currency: 'USD',
      owed: stripe > 0 ? stripe : 0,
      spendingLimit: toNumber(data?.spending_limit) ?? undefined,
    },
    available: true,
  }
}

/** Z.ai / BigModel GLM Coding Plan `/api/monitor/usage/quota/limit` (undocumented). */
export function parseZaiQuota(payload, now = Date.now()) {
  if (payload?.success === false) throw new UsageError('parse', 'the Z.ai quota endpoint rejected the key')
  const rows = Array.isArray(payload?.data?.limits) ? payload.data.limits : []
  const pick = (unit, number, types) =>
    rows.find(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        (unit === undefined || row.unit === unit) &&
        (number === undefined || row.number === number) &&
        (types === undefined || types.includes(row.type)),
    )
  const percentOf = (row) => {
    if (row === undefined) return null
    const direct = toNumber(row.percentage)
    if (direct !== null) return direct
    return usedPercent(row.currentValue, row.usage)
  }
  const windowOf = (row) => {
    if (row === undefined) return null
    return { percent: percentOf(row), resetsAt: row.nextResetTime }
  }
  const rolling = windowOf(pick(3, 5))
  const weekly = windowOf(pick(6, 1))
  const monthlyRow = pick(undefined, undefined, ['TIME_LIMIT'])
  const monthly = windowOf(monthlyRow)
  if (rolling === null && weekly === null && monthly === null) throw new UsageError('parse', 'the Z.ai quota response has no usable limit rows')
  return { windows: windowSet({ rolling, weekly, monthly }, now), plan: typeof payload?.data?.level === 'string' ? { id: payload.data.level, label: payload.data.level } : null }
}

/** MiniMax Coding Plan `/v1/api/openplatform/coding_plan/remains` (undocumented). */
export function parseMinimaxRemains(payload, now = Date.now()) {
  if (payload?.base_resp?.status_code !== undefined && payload.base_resp.status_code !== 0) {
    throw new UsageError('parse', 'the MiniMax plan endpoint rejected the request')
  }
  const rows = Array.isArray(payload?.model_remains) ? payload.model_remains : []
  const row = rows.find((entry) => entry !== null && typeof entry === 'object' && (entry.model_name === 'general' || rows.length === 1))
  if (row === undefined) throw new UsageError('parse', 'the MiniMax response has no model_remains row')
  const invert = (remaining) => {
    const value = toNumber(remaining)
    return value === null ? null : normalizePercent(100 - value)
  }
  return {
    windows: windowSet(
      {
        rolling: { percent: invert(row.current_interval_remaining_percent), resetsAt: row.end_time },
        weekly:
          row.current_weekly_status === undefined || row.current_weekly_status === 1
            ? { percent: invert(row.current_weekly_remaining_percent), resetsAt: row.weekly_end_time }
            : null,
      },
      now,
    ),
  }
}

/** Which adapter handles a provider id; `undefined` for unsupported ids. */
export function adapterFor(providerId) {
  return PROVIDER_DEFAULTS[providerId] === undefined ? undefined : ADAPTERS[providerId]
}

/** Merge one provider's configured fields over the documented defaults. */
export function providerConfig(providerId, configured) {
  const defaults = PROVIDER_DEFAULTS[providerId]
  if (defaults === undefined) return undefined
  const value = configured !== null && typeof configured === 'object' ? configured : {}
  const merged = { ...defaults, id: providerId }
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null && entry !== '') merged[key] = entry
  }
  return merged
}

/** Volcengine Signature V4 for the control-plane OpenAPI. */
function volcengineSignedRequest(ak, sk, action, version, host, region, service) {
  const now = new Date()
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const xDateShort = xDate.slice(0, 8)
  const body = '{}'
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const query = `Action=${action}&Version=${version}`
  const signedHeaderValues = {
    host,
    'x-date': xDate,
    'x-content-sha256': bodyHash,
    'content-type': 'application/json',
  }
  const signedHeaderNames = Object.keys(signedHeaderValues).sort()
  const signedHeaders = signedHeaderNames.join(';')
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${signedHeaderValues[name]}\n`).join('')
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const credentialScope = `${xDateShort}/${region}/${service}/request`
  const hashedCanonical = createHash('sha256').update(canonicalRequest).digest('hex')
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, hashedCanonical].join('\n')
  const kDate = createHmac('sha256', sk).update(xDateShort).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update(service).digest()
  const kSigning = createHmac('sha256', kService).update('request').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    url: `https://${host}/?${query}`,
    headers: {
      'content-type': 'application/json',
      host,
      'x-date': xDate,
      'x-content-sha256': bodyHash,
      authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  }
}

/** Normalize a Coding Plan / Agent Plan quota payload into window ids. */
export function parseVolcenginePlan(payload, now = Date.now()) {
  const result =
    payload !== null && typeof payload === 'object' && payload.Result !== null && typeof payload.Result === 'object'
      ? payload.Result
      : payload
  const windows = { rolling: null, weekly: null, monthly: null }
  const windowIdOf = (level) => {
    const value = String(level ?? '').toLowerCase()
    if (value === '5h' || value === 'five_hour' || value === 'fivehour' || value === 'session' || value === 'rolling') return 'rolling'
    if (value === 'weekly' || value === 'week' || value === '7d') return 'weekly'
    if (value === 'monthly' || value === 'month' || value === '30d') return 'monthly'
    return null
  }
  const usage = Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : []
  for (const row of usage) {
    if (row === null || typeof row !== 'object') continue
    const id = windowIdOf(row.Level)
    if (id === null) continue
    windows[id] = makeWindow(
      id,
      {
        percent: row.Percent,
        resetsAt: toNumber(row.ResetTimestamp) === null ? undefined : toNumber(row.ResetTimestamp) * 1000,
      },
      now,
    )
  }
  const afp = { rolling: result?.AFPFiveHour, weekly: result?.AFPWeekly, monthly: result?.AFPMonthly }
  for (const [id, row] of Object.entries(afp)) {
    if (row === null || typeof row !== 'object') continue
    if (windows[id] !== null) continue
    const quota = toNumber(row.Quota)
    const used = toNumber(row.Used)
    windows[id] = makeWindow(
      id,
      {
        percent: quota === null || quota <= 0 || used === null ? null : (used / quota) * 100,
        resetsAt: toNumber(row.ResetTime),
      },
      now,
    )
  }
  if (windows.rolling === null && windows.weekly === null && windows.monthly === null) {
    throw new UsageError('parse', 'the Volcengine quota response has no usable plan windows')
  }
  const tier = typeof result?.Tier === 'string' && result.Tier !== '' ? result.Tier : null
  return { windows, plan: tier === null ? null : { id: tier, label: tier } }
}

/**
 * The provider adapter table. `read()` performs the required network reads and
 * returns the normalized result; optional reads (subscription/whoami) are
 * tolerated when they fail, because the usage itself is still valid.
 */
export const ADAPTERS = {
  volcengine: {
    kind: 'windows',
    async read({ provider, fetchJson, httpJson, now }) {
      void fetchJson
      const config = providerConfig('volcengine', provider)
      const accessKeyId = provider?.accessKeyId
      const secretAccessKey = provider?.secretAccessKey
      if (typeof accessKeyId !== 'string' || accessKeyId === '' || typeof secretAccessKey !== 'string' || secretAccessKey === '') {
        throw new UsageError('missing-key', 'Volcengine quota needs VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY')
      }
      const request = volcengineSignedRequest(
        accessKeyId,
        secretAccessKey,
        config.quotaAction ?? 'GetCodingPlanUsage',
        config.quotaVersion ?? '2024-01-01',
        config.openApiHost ?? 'open.volcengineapi.com',
        config.region ?? 'cn-beijing',
        config.service ?? 'ark',
      )
      const payload =
        typeof httpJson === 'function'
          ? await httpJson(request.url, { method: 'POST', headers: request.headers, body: request.body })
          : await (async () => {
              const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body })
              if (!response.ok) {
                throw new UsageError('network', `the Volcengine quota endpoint answered HTTP ${response.status}`)
              }
              return response.json()
            })()
      return { kind: 'windows', ...parseVolcenginePlan(payload, now) }
    },
  },
  'zhipu-cn': {
    kind: 'windows',
    async read({ providerId = 'zhipu-cn', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.quotaPath))
      return { kind: 'windows', ...parseZaiQuota(payload, now) }
    },
  },
  'opencode-go': {
    kind: 'windows',
    async read({ providerId = 'opencode-go', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.usagePath))
      return { kind: 'windows', ...parseOpencodeGo(payload, now) }
    },
  },
  commandcode: {
    kind: 'windows',
    async read({ providerId = 'commandcode', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const credits = await fetchJson(joinUrl(config.baseURL, config.creditsPath))
      const [subscription, whoami] = await Promise.all([
        fetchJson(joinUrl(config.baseURL, config.subscriptionsPath)).catch(() => undefined),
        fetchJson(joinUrl(config.baseURL, config.whoamiPath)).catch(() => undefined),
      ])
      return { kind: 'windows', ...parseCommandCode({ credits, subscription, whoami }, now) }
    },
  },
  deepseek: {
    kind: 'balance',
    async read({ providerId = 'deepseek', provider, fetchJson }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseDeepseekBalance(payload) }
    },
  },
  openrouter: {
    kind: 'balance',
    async read({ providerId = 'openrouter', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseOpenRouterCredits(payload, now) }
    },
  },
  moonshot: {
    kind: 'balance',
    async read({ providerId = 'moonshot', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseMoonshotBalance(payload, now) }
    },
  },
  siliconflow: {
    kind: 'balance',
    async read({ providerId = 'siliconflow', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseSiliconflowBalance(payload, now) }
    },
  },
  stepfun: {
    kind: 'balance',
    async read({ providerId = 'stepfun', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseStepfunBalance(payload, config.baseURL, now) }
    },
  },
  novita: {
    kind: 'balance',
    async read({ providerId = 'novita', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseNovitaBalance(payload, now) }
    },
  },
  hyperbolic: {
    kind: 'balance',
    async read({ providerId = 'hyperbolic', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseHyperbolicBalance(payload, now) }
    },
  },
  deepinfra: {
    kind: 'balance',
    async read({ providerId = 'deepinfra', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.balancePath))
      return { kind: 'balance', ...parseDeepinfraBalance(payload, now) }
    },
  },
  zai: {
    kind: 'windows',
    async read({ providerId = 'zai', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.quotaPath))
      return { kind: 'windows', ...parseZaiQuota(payload, now) }
    },
  },
  minimax: {
    kind: 'windows',
    async read({ providerId = 'minimax', provider, fetchJson, now }) {
      const config = providerConfig(providerId, provider)
      const payload = await fetchJson(joinUrl(config.baseURL, config.quotaPath))
      return { kind: 'windows', ...parseMinimaxRemains(payload, now) }
    },
  },
  'deepseek-account': {
    kind: 'balance',
    async read({ provider, services, now }) {
      const account = services?.account
      if (account === undefined || account === null || typeof account.getBalance !== 'function') {
        throw new UsageError('missing-key', 'the DeepSeek Account service is not composed', { retryable: false })
      }
      const client = accountClientMetadata(now)
      let result
      try {
        result = await account.getBalance(client)
      } catch (error) {
        throw new UsageError('network', `the DeepSeek Account balance query failed: ${String(error?.message ?? error)}`, {
          retryable: true,
        })
      }
      if (result === null || result === undefined) {
        throw new UsageError('missing-key', 'DeepSeek Account is not signed in', { retryable: false })
      }
      if (result.status !== 'ready' || !Array.isArray(result.value)) {
        throw new UsageError('network', 'the DeepSeek Account balance query failed', { retryable: true })
      }
      return { kind: 'balance', ...balanceFromWallets(result.value, result.bonusWallets ?? []) }
    },
  },
}

/** Client identity metadata the account service signs its balance query with. */
function accountClientMetadata(now = Date.now()) {
  const date = new Date(now)
  return {
    version: '0.2.0',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -date.getTimezoneOffset() * 60,
  }
}

/** Turn Platform wallet arrays into the wire balance shape (primary wallet first). */
export function balanceFromWallets(wallets, bonusWallets = []) {
  const list = Array.isArray(wallets) ? wallets.filter((wallet) => wallet !== null && typeof wallet === 'object') : []
  const primary = list[0]
  if (primary === undefined) {
    throw new UsageError('parse', 'the DeepSeek Account response has no wallet')
  }
  const amount = toNumber(primary.balance)
  if (amount === null) throw new UsageError('parse', 'the DeepSeek Account response has no usable balance')
  const normalize = (wallet) => {
    const value = toNumber(wallet.balance)
    return value === null ? null : { currency: typeof wallet.currency === 'string' ? wallet.currency : 'CNY', amount: value }
  }
  return {
    balance: {
      amount,
      currency: typeof primary.currency === 'string' ? primary.currency : 'CNY',
      wallets: list.map(normalize).filter((wallet) => wallet !== null),
      bonus: (Array.isArray(bonusWallets) ? bonusWallets : []).map(normalize).filter((wallet) => wallet !== null),
    },
    windows: windowSet({}, Date.now()),
  }
}

/** Join an origin and a path tolerantly (trailing/leading slashes). */
export function joinUrl(baseURL, path) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '')
  const suffix = '/' + String(path ?? '').trim().replace(/^\/+/, '')
  if (base === '') throw new UsageError('disabled', 'no provider base URL is configured')
  try {
    return new URL(base + suffix).toString()
  } catch {
    throw new UsageError('parse', `invalid provider URL: ${base}${suffix}`)
  }
}
