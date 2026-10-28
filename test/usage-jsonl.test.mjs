/**
 * WorkBuddy / CodeBuddy CLI and Qoder CN CLI JSONL adapter tests, plus their
 * composition into the stats service.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUsageStats } from '../lib/usage-stats.mjs'
import { readQoderUsage, readWorkbuddyUsage, providerForBaseUrl } from '../lib/usage-jsonl.mjs'

/** The local day key of the real "today" (keeps the composition test date-independent). */
function realToday() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local epoch-ms for a day key at a fixed local hour. */
function at(day, hour = 12) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime()
}

/** Write one JSONL transcript under `<root>/projects/<session>` (creating dirs). */
async function writeTranscript(root, sessionId, records) {
  const dir = join(root, 'projects', 'cwd')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

function workbuddyRecord({ time, model, prompt, completion, cacheRead = 0, requestId, messageId = 'm', step = 1 }) {
  return {
    timestamp: time,
    providerData: {
      conversationRequestId: requestId,
      messageId,
      stepSeq: step,
      model,
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_cache_hit_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  }
}

function qoderRecord({ time, model, input, output, cacheRead, messageId }) {
  return {
    type: 'assistant',
    timestamp: new Date(time).toISOString(),
    message: { id: messageId, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
  }
}

test('readWorkbuddyUsage normalizes rawUsage, dedupes and skips zero rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-workbuddy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTranscript(dir, 's1', [
    workbuddyRecord({ time: at('2026-10-25', 10), model: 'deepseek-v4.1-flash', prompt: 1000, completion: 200, cacheRead: 400, requestId: 'r1' }),
    // Same (request, message, step) → only counted once.
    workbuddyRecord({ time: at('2026-10-25', 10), model: 'deepseek-v4.1-flash', prompt: 1000, completion: 200, cacheRead: 400, requestId: 'r1' }),
    workbuddyRecord({ time: at('2026-10-24', 9), model: 'glm-5.3', prompt: 100, completion: 50, requestId: 'r2' }),
    // A record without providerData/rawUsage is ignored.
    { timestamp: at('2026-10-25', 11), type: 'message' },
  ])
  const result = readWorkbuddyUsage({ root: dir })
  assert.equal(result.harness, 'workbuddy')
  assert.equal(result.rows, 2)
  assert.equal(result.requests, 2)
  const today = result.groups.find((group) => group.day === '2026-10-25')
  assert.deepEqual(today.bucket, {
    input: 600,
    output: 200,
    cacheRead: 400,
    cacheWrite: 0,
    total: 1200,
    messages: 1,
  })
  assert.equal(today.providerId, 'workbuddy')
  assert.equal(today.modelId, 'deepseek-v4.1-flash')
})

test('WorkBuddy records without any request/message id are not collapsed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-workbuddy-no-id-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTranscript(dir, 's-no-id', [
    {
      timestamp: at('2026-10-25', 10),
      providerData: {
        model: 'deepseek-v4.1-flash',
        rawUsage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_cache_hit_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    {
      timestamp: at('2026-10-25', 11),
      providerData: {
        model: 'deepseek-v4.1-flash',
        rawUsage: { prompt_tokens: 300, completion_tokens: 1, total_tokens: 301, prompt_cache_hit_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ])
  const result = readWorkbuddyUsage({ root: dir })
  assert.equal(result.requests, 2, 'both valid records are counted')
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].bucket.total, 402, '101 + 301 tokens')
})

test('readQoderUsage reads assistant usage, dedupes by message id and maps provider base URLs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-qoder-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(
    join(dir, 'settings.json'),
    JSON.stringify({
      providers: {
        'qoder-custom-11111111-1111-1111-1111-111111111111': { baseUrl: 'https://api.commandcode.ai/provider/v1' },
        'qoder-custom-22222222-2222-2222-2222-222222222222': { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
      },
    }),
    'utf8',
  )
  await writeTranscript(dir, 's1', [
    // Custom commandcode provider: input includes the cached prompt.
    qoderRecord({
      time: at('2026-10-25', 10),
      model: 'qoder-custom-11111111-1111-1111-1111-111111111111/deepseek/deepseek-v4.1-flash',
      input: 1000,
      output: 200,
      cacheRead: 300,
      messageId: 'msg-1',
    }),
    // Thinking/text split of the same response → deduped.
    qoderRecord({
      time: at('2026-10-25', 10),
      model: 'qoder-custom-11111111-1111-1111-1111-111111111111/deepseek/deepseek-v4.1-flash',
      input: 1000,
      output: 200,
      cacheRead: 300,
      messageId: 'msg-1',
    }),
    // Built-in Qoder model: zero tokens, only credits → skipped.
    qoderRecord({ time: at('2026-10-24', 9), model: 'qmodel_38max', input: 0, output: 0, cacheRead: 0, messageId: 'msg-2' }),
    // Volcengine Ark custom provider → vendor host, unmapped.
    qoderRecord({
      time: at('2026-10-24', 10),
      model: 'qoder-custom-22222222-2222-2222-2222-222222222222/glm-5.3-flash',
      input: 400,
      output: 100,
      cacheRead: 100,
      messageId: 'msg-3',
    }),
  ])
  const result = readQoderUsage({ home: dir })
  assert.equal(result.harness, 'qoder')
  assert.equal(result.rows, 2)
  assert.equal(result.requests, 2)
  const commandcode = result.groups.find((group) => group.providerId === 'commandcode')
  assert.equal(commandcode.day, '2026-10-25')
  assert.deepEqual(commandcode.bucket, {
    input: 700,
    output: 200,
    cacheRead: 300,
    cacheWrite: 0,
    total: 1200,
    messages: 1,
  })
  const ark = result.groups.find((group) => group.providerId.includes('volces'))
  assert.deepEqual(ark.bucket, { input: 300, output: 100, cacheRead: 100, cacheWrite: 0, total: 500, messages: 1 })
})

test('providerForBaseUrl maps known vendors and keeps unknown hosts', () => {
  assert.equal(providerForBaseUrl('https://api.commandcode.ai/provider/v1'), 'commandcode')
  assert.equal(providerForBaseUrl('https://opencode.ai/inference/go/v1'), 'opencode-go')
  assert.equal(providerForBaseUrl('https://api.deepseek.com/v1'), 'deepseek')
  assert.equal(providerForBaseUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'ark.cn-beijing.volces.com')
  assert.equal(providerForBaseUrl('not-a-url'), null)
})

test('stats service composes WorkBuddy and Qoder alongside DSH', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  const workbuddy = await mkdtemp(join(tmpdir(), 'tokenlens-wb-'))
  const qoder = await mkdtemp(join(tmpdir(), 'tokenlens-qd-'))
  t.after(async () => {
    await rm(dshHome, { recursive: true, force: true })
    await rm(workbuddy, { recursive: true, force: true })
    await rm(qoder, { recursive: true, force: true })
  })
  await writeTranscript(workbuddy, 's1', [
    workbuddyRecord({ time: at(realToday(), 10), model: 'deepseek-v4.1-flash', prompt: 1000, completion: 200, cacheRead: 400, requestId: 'r1' }),
  ])
  await writeFile(
    join(qoder, 'settings.json'),
    JSON.stringify({ providers: { 'qoder-custom-11111111-1111-1111-1111-111111111111': { baseUrl: 'https://api.commandcode.ai/provider/v1' } } }),
    'utf8',
  )
  await writeTranscript(qoder, 's1', [
    qoderRecord({
      time: at(realToday(), 11),
      model: 'qoder-custom-11111111-1111-1111-1111-111111111111/deepseek/deepseek-v4.1-flash',
      input: 500,
      output: 100,
      cacheRead: 100,
      messageId: 'msg-1',
    }),
  ])
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 0,
        harnesses: { dsh: false, zcode: false, opencode: false, workbuddy: true, qoder: true },
        workbuddy: { root: workbuddy },
        qoder: { home: qoder },
      },
    },
    providerCatalog: async () => ({ commandcode: ['deepseek/deepseek-v4.1-flash'] }),
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  assert.deepEqual(result.harnesses.map((harness) => harness.harnessId), ['workbuddy', 'qoder'])
  assert.deepEqual(result.harnesses.map((harness) => harness.label), ['WorkBuddy', 'Qoder'])
  assert.equal(result.harnesses[0].today.total, 1200)
  assert.equal(result.harnesses[1].today.total, 600)
  assert.equal(result.today.total, 1800, 'combined across the JSONL harnesses')
  const commandcode = result.providers.find((provider) => provider.providerId === 'commandcode')
  assert.equal(commandcode.today.total, 600, 'Qoder custom provider mapped via its base URL')
  assert.equal(commandcode.harnesses.qoder.today.total, 600)
  assert.equal(result.unmapped.length, 1)
  assert.equal(result.unmapped[0].harnessId, 'workbuddy')
  assert.equal(result.workbuddy.available, true)
  assert.equal(result.qoder.available, true)
  assert.equal(result.scan.workbuddy.available, true)
  assert.equal(result.scan.qoder.available, true)
})
