/**
 * Built-in provider pool expansion (v0.19.0).
 *
 * Every added provider uses the same metadata shape as the existing pool; no
 * new fields and no usage-adapter protocol were introduced. These entries are
 * therefore recognised/selectable in the management page, while providers
 * without a usage endpoint simply report no snapshot until an adapter exists.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ADAPTERS, PROVIDER_DEFAULTS, PROVIDER_LABELS, parseVolcenginePlan } from '../lib/providers.mjs'

const ADDED = {
  sensenova: { label: 'SenseNova 商汤', shortLabel: 'SN', baseURL: 'https://api.sensenova.cn' },
  volcengine: { label: '火山引擎', shortLabel: 'VE', baseURL: 'https://ark.cn-beijing.volces.com', kind: 'windows' },
  qwen: { label: '通义千问', shortLabel: 'QW', baseURL: 'https://dashscope.aliyuncs.com' },
  qianfan: { label: '百度千帆', shortLabel: 'QF', baseURL: 'https://qianfan.baidubce.com' },
  'zhipu-cn': { label: '智谱 AI（国内版）', shortLabel: 'ZP', baseURL: 'https://open.bigmodel.cn', kind: 'windows' },
  'intern-ai': { label: 'Intern AI（书生）', shortLabel: 'IA', baseURL: 'https://chat.intern-ai.org.cn' },
  'agnes-ai': { label: 'Agnes AI', shortLabel: 'AG', baseURL: 'https://api.agnes.ai' },
  'open-design': { label: 'Open Design', shortLabel: 'OD', baseURL: 'https://api.open-design.ai' },
  hunyuan: { label: '腾讯混元', shortLabel: 'HY', baseURL: 'https://hunyuan.tencentcloudapi.com' },
  spark: { label: '讯飞星火', shortLabel: 'SP', baseURL: 'https://spark-api-open.xf-yun.com' },
  yi: { label: '零一万物', shortLabel: 'YI', baseURL: 'https://api.lingyiwanwu.com' },
  baichuan: { label: '百川智能', shortLabel: 'BC', baseURL: 'https://api.baichuan-ai.com' },
}

test('the added providers use the existing metadata shape', () => {
  for (const [id, expected] of Object.entries(ADDED)) {
    const provider = PROVIDER_DEFAULTS[id]
    assert.ok(provider, `${id} is registered`)
    assert.equal(provider.label, expected.label)
    assert.equal(provider.shortLabel, expected.shortLabel)
    assert.equal(provider.baseURL, expected.baseURL)
    assert.equal(provider.kind, expected.kind ?? 'balance', 'the existing kind vocabulary is reused')
    assert.ok(typeof provider.apiKeyRef === 'string' && provider.apiKeyRef !== '', `${id} names a credential ref`)
    assert.ok(typeof provider.consoleUrl === 'string' && provider.consoleUrl.startsWith('https://'), `${id} names a console URL`)
    assert.equal(PROVIDER_LABELS[id], expected.label, 'the label map stays in sync')
  }
})

test('the existing built-in entries are unchanged and labels are unique', () => {
  assert.deepEqual(
    { ...PROVIDER_DEFAULTS['opencode-go'] },
    {
      kind: 'windows',
      label: 'OpenCode',
      shortLabel: 'OC',
      baseURL: 'https://opencode.ai',
      usagePath: '/inference/go/v1/usage',
      apiKeyRef: 'OPENCODE_GO_API_KEY',
      consoleUrl: 'https://opencode.ai/console',
    },
  )
  assert.equal(PROVIDER_DEFAULTS.deepseek.label, 'DeepSeek')
  assert.equal(PROVIDER_DEFAULTS['deepseek-account'].service, 'deepseekAccount')
  const shortLabels = Object.values(PROVIDER_DEFAULTS).map((provider) => provider.shortLabel)
  assert.equal(new Set(shortLabels).size, shortLabels.length, 'short labels stay unique across the pool')
  const ids = Object.keys(PROVIDER_DEFAULTS)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.length >= 25)
})

test('zhipu-cn exposes GLM Coding Plan windows through the existing parser', async () => {
  assert.equal(ADAPTERS['zhipu-cn'].kind, 'windows')
  const now = Date.parse('2026-10-25T09:55:00.000Z')
  const result = await ADAPTERS['zhipu-cn'].read({
    providerId: 'zhipu-cn',
    provider: {},
    now,
    fetchJson: async (url) => {
      assert.equal(url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
      return {
        success: true,
        data: {
          level: 'lite',
          limits: [
            { unit: 3, number: 5, type: 'TOKENS_LIMIT', percentage: 12, nextResetTime: now + 3600_000 },
            { unit: 6, number: 1, type: 'TOKENS_LIMIT', percentage: 34 },
            { type: 'TIME_LIMIT', percentage: 56 },
          ],
        },
      }
    },
  })
  assert.equal(result.kind, 'windows')
  assert.equal(result.windows.rolling.percent, 12)
  assert.equal(result.windows.weekly.percent, 34)
  assert.equal(result.windows.monthly.percent, 56)
  assert.equal(result.plan.id, 'lite')
})

test('volcengine signs the quota request and parses Coding Plan windows', async () => {
  const now = Date.parse('2026-10-25T09:55:00.000Z')
  let seen = null
  const result = await ADAPTERS.volcengine.read({
    provider: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRETEXAMPLE' },
    now,
    httpJson: async (url, options) => {
      seen = { url, options }
      return {
        Result: {
          Tier: 'pro',
          QuotaUsage: [
            { Level: 'FIVE_HOUR', Percent: 12, ResetTimestamp: Math.floor((now + 3600_000) / 1000) },
            { Level: 'WEEKLY', Percent: 34 },
            { Level: 'MONTHLY', Percent: 56 },
          ],
        },
      }
    },
  })
  assert.equal(result.kind, 'windows')
  assert.equal(result.windows.rolling.percent, 12)
  assert.equal(result.windows.weekly.percent, 34)
  assert.equal(result.windows.monthly.percent, 56)
  assert.equal(result.plan.id, 'pro')
  assert.equal(seen.options.method, 'POST')
  assert.match(seen.url, /^https:\/\/open\.volcengineapi\.com\/\?Action=GetCodingPlanUsage&Version=2024-01-01$/)
  assert.match(seen.options.headers.authorization, /^HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/)
  assert.equal(seen.options.headers['x-content-sha256'], '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
})

test('parseVolcenginePlan accepts the AFP (absolute quota) shape', () => {
  const parsed = parseVolcenginePlan({ Result: { AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: Date.now() + 1000 } } })
  assert.equal(parsed.windows.rolling.percent, 25)
  assert.equal(parsed.windows.weekly, null)
})
