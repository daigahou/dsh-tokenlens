/**
 * Token-statistics tests: session-log decoding, folding, and the incremental
 * cache. Synthetic session files are real zstd frame runs, so the decoder is
 * exercised exactly as it is against `$DSH_HOME/sessions`.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  addBucket,
  createUsageStats,
  dayKey,
  decodeSessionLog,
  emptyBucket,
  foldSession,
  listSessionFiles,
  usageOf,
} from '../lib/usage-stats.mjs'

/** One JSONL record as the log stores it. */
function record(type, seq, extra = {}) {
  return { type, seq, time: extra.time ?? 1_792_900_000_000 + seq, data: extra.data ?? {} }
}

/** A usage event for a given time/provider/model as the log stores it. */
function usageEvent(seq, time, usage, config = { turn: 1, step: seq }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { ...config, usage },
  }
}

function headerEvent(seq, provider, model) {
  return { type: 'request/header', seq, time: 1_792_900_000_000 + seq, data: { header: { config: { provider, model } } } }
}

function sessionHeader(extra = {}) {
  return { type: 'session', version: 4, id: 'session-test', createdAt: 1_792_900_000_000, cwd: 'C:\\work', isSeeded: false, delegationDepth: 0, ...extra }
}

/** Write a session log as one zstd frame per append (the real layout). */
async function writeSession(root, id, records, options = {}) {
  const dir = join(root, 'sessions', '--test--', id)
  await mkdir(dir, { recursive: true })
  const frames = records.map((entry) => zstdCompressSync(Buffer.from(JSON.stringify(entry) + '\n', 'utf8')))
  let body = Buffer.concat(frames)
  if (options.corruptTail === true) body = Buffer.concat([body, Buffer.from('garbage trailing bytes')])
  if (options.partialTail === true) body = body.subarray(0, body.length - 5)
  const path = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(path, body)
  return path
}

const NOW = Date.now() // anchored on the real 'today' so the suite keeps working across midnight
const TODAY = dayKey(NOW)

function todayAt(hour, minute = 0) {
  const date = new Date(NOW)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

test('usageOf extracts one normalized bucket and rejects non-usage events', () => {
  const usage = usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 115 } } })
  assert.deepEqual(usage, { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, total: 115, messages: 1 })
  assert.equal(usageOf({ type: 'assistant/message', data: {} }), null)
  assert.equal(usageOf({ type: 'tool/call', data: { usage: {} } }), null)
  // totalTokens missing 閳?folded from the parts
  const folded = usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 } } })
  assert.equal(folded.total, 9)
})

test('dayKey formats the local calendar day', () => {
  assert.match(dayKey(NOW), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(dayKey(new Date(2026, 9, 25, 23, 59).getTime()), '2026-10-25')
  assert.equal(dayKey(new Date(2026, 9, 26, 0, 1).getTime()), '2026-10-26')
})

test('decodeSessionLog folds frame runs by seq and survives a corrupt/partial tail', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenlens-stats-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const records = [sessionHeader(), headerEvent(1, 'opencode-go', 'deepseek-v4.1-flash'), usageEvent(2, NOW, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })]
  const clean = await writeSession(root, 'clean', records)
  const corrupt = await writeSession(root, 'corrupt', records, { corruptTail: true })
  const partial = await writeSession(root, 'partial', records, { partialTail: true })

  const decoded = decodeSessionLog(await readFile(clean))
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.records.length, 3)
  assert.deepEqual(decoded.records.map((entry) => entry.seq), [undefined, 1, 2])
  assert.equal(decodeSessionLog(await readFile(corrupt)).records.length >= 3, true)
  assert.equal(decodeSessionLog(await readFile(partial)).records.length >= 2, true, 'a torn frame costs at most that frame')
  assert.deepEqual(listSessionFiles(join(root, 'sessions')).length, 3)
})

test('foldSession attributes usage to the current provider/model and per-day buckets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokenlens-stats-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const day1 = todayAt(10)
  const day2 = todayAt(11)
  const records = [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'deepseek-v4.1-flash'),
    usageEvent(2, day1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 }),
    usageEvent(3, day1, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 450, totalTokens: 505 }),
    headerEvent(4, 'commandcode', 'deepseek/deepseek-v4.1-flash'),
    usageEvent(5, day2, { inputTokens: 7, outputTokens: 3, totalTokens: 10 }),
  ]
  const fold = foldSession(records)
  assert.equal(fold.session.seeded, false)
  assert.equal(fold.providers['opencode-go'].total, 1515)
  assert.equal(fold.providers['opencode-go'].messages, 2)
  assert.equal(fold.providers.commandcode.total, 10)
  assert.equal(fold.days[dayKey(day1)].providers['opencode-go'].total, 1515)
  assert.equal(fold.days[dayKey(day2)].providers.commandcode.total, 10)
  assert.equal(fold.models['opencode-go/deepseek-v4.1-flash'].total.total, 1515)
  assert.equal(fold.models['commandcode/deepseek/deepseek-v4.1-flash'].total.messages, 1)
})

test('an attempt that really consumed tokens is counted; zero-token retries are not', () => {
  const day = todayAt(10, 30)
  const records = [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    {
      type: 'assistant/attempt',
      seq: 2,
      time: day,
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } }],
      },
    },
    { type: 'assistant/attempt', seq: 3, time: day, data: { turn: 1, step: 2, stream: [] } },
    {
      type: 'assistant/attempt',
      seq: 4,
      time: day,
      data: { turn: 1, step: 3, stream: [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }] },
    },
  ]
  const fold = foldSession(records)
  assert.equal(fold.providers['opencode-go'].total, 120)
  assert.equal(fold.providers['opencode-go'].messages, 1)
})

test('a successful message prefers its own source route over the last request header', () => {
  const day = todayAt(11, 30)
  const records = [
    sessionHeader(),
    headerEvent(1, 'commandcode', 'deepseek/deepseek-v4.1-flash'),
    {
      type: 'assistant/message',
      seq: 2,
      time: day,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
        usage: { inputTokens: 10, totalTokens: 10 },
      },
    },
  ]
  const fold = foldSession(records)
  assert.equal(fold.providers['deepseek-official'].total, 10)
  assert.equal(fold.models['deepseek-official/deepseek-flash'].total.total, 10)
})

test('only the inherited prefix of a forked session is excluded', () => {
  const day = todayAt(12, 30)
  const records = [
    sessionHeader({ isSeeded: true }),
    headerEvent(1, 'opencode-go', 'm'),
    usageEvent(2, day, { inputTokens: 1000, totalTokens: 1000 }),
    { type: 'session/end-seed', seq: 3, time: day, data: { inherited: true } },
    usageEvent(4, day, { inputTokens: 5, totalTokens: 5 }),
  ]
  const fold = foldSession(records)
  assert.equal(fold.providers['opencode-go'].total, 5)
  assert.equal(fold.session.seeded, true)
})

test('an unseeded session/end-seed event cuts nothing', () => {
  const day = todayAt(13, 30)
  const records = [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm'),
    usageEvent(2, day, { inputTokens: 10, totalTokens: 10 }),
    { type: 'session/end-seed', seq: 3, time: day, data: {} },
    usageEvent(4, day, { inputTokens: 1, totalTokens: 1 }),
  ]
  assert.equal(foldSession(records).providers['opencode-go'].total, 11)
})

test('createUsageStats reports today + all-time totals and per-provider rows', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const today = todayAt(12)
  const yesterday = today - 24 * 3600 * 1000
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'deepseek-v4.1-flash'),
    usageEvent(2, today, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 }),
    usageEvent(3, yesterday, { inputTokens: 20, outputTokens: 5, totalTokens: 25 }),
  ])
  await writeSession(dshHome, 'session-b', [
    sessionHeader(),
    headerEvent(1, 'commandcode', 'deepseek/deepseek-v4.1-flash'),
    usageEvent(2, today, { inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
  ])
  // A forked (seeded) session: the inherited prefix before
  // `session/end-seed {inherited:true}` is not its spend; its own events after
  // that boundary are real spend and must be counted.
  await writeSession(dshHome, 'session-seeded', [
    sessionHeader({ isSeeded: true }),
    headerEvent(1, 'opencode-go', 'deepseek-v4.1-flash'),
    usageEvent(2, today, { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 }),
    { type: 'session/end-seed', seq: 3, time: today, data: { inherited: true } },
    usageEvent(4, today, { inputTokens: 7, outputTokens: 0, totalTokens: 7 }),
  ])

  const stats = createUsageStats({ dshHome, config: { stats: { ttlMs: 0, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } }, log: { info() {}, warn() {} } })
  const result = await stats.get()
  assert.equal(result.today.messages, 3)
  assert.equal(result.today.total, 1027, '1010 + 10 + the fork\'s own 7')
  assert.equal(result.allTime.messages, 4)
  assert.equal(result.allTime.total, 1052)
  assert.equal(result.providers.length, 2)
  assert.equal(result.providers[0].providerId, 'opencode-go', 'sorted by all-time total')
  assert.equal(result.providers[0].today.total, 1017)
  assert.equal(result.providers[1].providerId, 'commandcode')
  // v0.22.0: local effective date + since-effective window per provider.
  assert.equal(result.providers[0].effectiveDay, dayKey(yesterday))
  assert.equal(result.providers[0].effectiveDays, 2, 'inclusive day count from the first record to today')
  assert.equal(result.providers[0].sinceEffective.total, result.providers[0].allTime.total)
  assert.equal(result.providers[0].harnesses.dsh.sinceEffective.total, result.providers[0].allTime.total)
  // v0.30.0: rolling 7-day window (today + the preceding 6 days).
  // v0.33.0: per-workspace (session cwd) totals for the sidebar badges.
  assert.ok(Array.isArray(result.workspaces), 'the stats payload carries workspace totals')
  assert.equal(result.workspaces.length, 1)
  assert.equal(result.workspaces[0].cwd, 'C:\\work')
  assert.equal(result.workspaces[0].total, 1052, 'per-workspace totals sum every session under that cwd')
  assert.equal(result.workspaces[0].messages, 4)
  assert.equal(result.workspaces[0].today.total, 1027, 'workspace today window')
  assert.equal(result.workspaces[0].last7Days.total, 1052, 'workspace 7-day window')
  assert.equal(result.workspaces[0].last30Days.total, 1052, 'workspace 30-day window')
  assert.equal(result.last7Days.total, 1052, '7-day window includes yesterday and today')
  assert.equal(result.providers[0].last7Days.total, 1042)
  assert.equal(result.providers[0].harnesses.dsh.last7Days.total, 1042)
  assert.equal(result.harnesses[0].last7Days.total, 1052)
  assert.equal(result.models[0].last7Days.total, result.models[0].allTime.total)
  // v0.24.0: daily series for the chart view.
  assert.ok(Array.isArray(result.daily), 'the stats payload carries a daily series')
  const lastDay = result.daily[result.daily.length - 1]
  assert.equal(lastDay.day, TODAY)
  assert.equal(lastDay.total.total, result.today.total)
  assert.equal(lastDay.providers['opencode-go'].total, result.providers[0].today.total)
  assert.equal(result.models[0].key, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(result.models[0].sinceEffective.total, result.models[0].allTime.total)
  assert.equal(result.scan.sessions, 3)
  assert.equal(typeof result.generatedAt, 'string')
  assert.match(result.day, /^\d{4}-\d{2}-\d{2}$/)
})

test('the cache rescans only changed files and honours the TTL', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const today = todayAt(13)
  const first = await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 10, outputTokens: 0, totalTokens: 10 }),
  ])
  const stats = createUsageStats({ dshHome, config: { stats: { ttlMs: 60_000, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } }, log: { info() {}, warn() {} } })
  const cold = await stats.get()
  assert.equal(cold.allTime.total, 10)
  assert.equal(cold.scan.scanned, 1)
  assert.equal(cold.scan.reused, 0)

  // Within the TTL the cached answer is served verbatim.
  const warm = await stats.get()
  assert.equal(warm, cold)

  // A new append changes mtime/size; fresh:true rescans only that file.
  const appended = await readFile(first)
  const frame = zstdCompressSync(Buffer.from(JSON.stringify(usageEvent(3, today, { inputTokens: 5, outputTokens: 0, totalTokens: 5 })) + '\n'))
  await writeFile(first, Buffer.concat([appended, frame]))
  const refreshed = await stats.get({ fresh: true })
  assert.equal(refreshed.allTime.total, 15)
  assert.equal(refreshed.scan.scanned, 1)
  assert.equal(refreshed.scan.reused, 0)
})

test('cache file is written and reused by a second service instance', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const today = todayAt(14)
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 42, outputTokens: 0, totalTokens: 42 }),
  ])
  const config = { stats: { ttlMs: 0, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } }
  const first = createUsageStats({ dshHome, config, log: { info() {}, warn() {} } })
  assert.equal((await first.get()).allTime.total, 42)
  const second = createUsageStats({ dshHome, config, log: { info() {}, warn() {} } })
  const result = await second.get()
  assert.equal(result.allTime.total, 42)
  assert.equal(result.scan.reused, 1, 'an unchanged file comes from the persisted cache')
  const raw = JSON.parse(await readFile(join(dshHome, 'dsh-tokenlens', 'usage-cache.json'), 'utf8'))
  assert.equal(raw.version, 5)
  assert.ok(Object.keys(raw.files).length === 1)
})

test('a missing sessions directory yields empty totals, not a crash', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const stats = createUsageStats({ dshHome, config: { stats: { ttlMs: 0, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } }, log: { info() {}, warn() {} } })
  const result = await stats.get()
  assert.equal(result.today.total, 0)
  assert.equal(result.allTime.messages, 0)
  assert.deepEqual(result.providers, [])
  assert.equal(result.scan.sessions, 0)
})

/** Create a temp ZCode `model_usage` database with billable rows. */
async function writeZcodeDb(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-zcode-home-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE model_usage (
    id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT, status TEXT,
    completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`)
  const insert = db.prepare(`INSERT INTO model_usage
    (id, provider_id, model_id, status, completed_at, input_tokens, output_tokens, reasoning_tokens,
     cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
    VALUES (?, ?, ?, 'completed', ?, ?, ?, 0, 0, ?, ?)`)
  rows.forEach((row, index) => {
    insert.run(
      `z-${index}`,
      row.providerId ?? 'custom-uuid',
      row.modelId ?? 'unknown-model',
      row.time,
      row.input,
      row.output,
      row.cacheRead ?? 0,
      row.total,
    )
  })
  db.close()
  return path
}

test('maps ZCode provider ids onto DSH providers and aggregates across harnesses', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const now = Date.now()
  const today = todayAt(12)
  const yesterday = today - 24 * 3600 * 1000
  const fortyDaysAgo = today - 40 * 24 * 3600 * 1000
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 60, outputTokens: 40, totalTokens: 100 }),
  ])
  const zcodePath = await writeZcodeDb(t, [
    // Alias-mapped onto opencode-go (today + yesterday).
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', time: now, input: 1000, output: 100, cacheRead: 400, total: 1100 },
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', time: yesterday, input: 2000, output: 200, cacheRead: 500, total: 2200 },
    // Unknown provider/model: all-harness totals only.
    { providerId: 'custom-uuid', modelId: 'unknown-model', time: now, input: 50, output: 0, total: 50 },
    // Older than the rolling 30-day window: all-time only.
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', time: fortyDaysAgo, input: 5000, output: 0, total: 5000 },
  ])
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 0,
        harnesses: { dsh: true, zcode: true, opencode: false, workbuddy: false, qoder: false },
        zcode: { dbPath: zcodePath, providerAliases: { 'opencode-go-chat': 'opencode-go' } },
      },
    },
    providerCatalog: () => ({ 'opencode-go': ['deepseek-v4.1-flash'], commandcode: ['stealth/space-bunny-alpha'] }),
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  assert.equal(result.version, 3)
  assert.deepEqual(result.harnesses.map((harness) => harness.harnessId), ['dsh', 'zcode'])

  // All-harness, all-provider buckets.
  assert.equal(result.today.total, 100 + 1100 + 50)
  assert.equal(result.last30Days.total, 100 + 1100 + 2200 + 50, '40-day-old usage is outside the 30-day window')
  assert.equal(result.allTime.total, 100 + 1100 + 2200 + 50 + 5000)
  assert.equal(result.harnesses[0].today.total, 100)
  assert.equal(result.harnesses[1].today.total, 1150)
  assert.equal(result.harnesses[1].last30Days.total, 3350)
  assert.equal(result.harnesses[1].allTime.total, 8350)

  // Per-provider aggregation across harnesses: alias + DSH usage merge into one row.
  const provider = result.providers.find((entry) => entry.providerId === 'opencode-go')
  assert.equal(provider.today.total, 1200, 'DSH 100 + ZCode 1100')
  assert.equal(provider.last30Days.total, 3400, 'DSH 100 + ZCode (1100+2200)')
  assert.equal(provider.allTime.total, 8400, 'plus the 40-day-old 5000')
  assert.equal(provider.harnesses.dsh.today.total, 100)
  assert.equal(provider.harnesses.zcode.today.total, 1100)
  assert.equal(provider.harnesses.zcode.allTime.total, 8300)
  assert.equal(result.providers.some((entry) => entry.providerId === 'custom-uuid'), false, 'unmapped providers stay out of the canonical list')

  // ZCode detail: mapped/unmapped bookkeeping.
  assert.equal(result.zcode.available, true)
  assert.equal(result.zcode.rows, 4)
  assert.equal(result.zcode.mappedProviders[0].providerId, 'opencode-go')
  assert.equal(result.zcode.mappedProviders[0].today.total, 1100)
  assert.equal(result.zcode.unmapped[0].providerId, 'custom-uuid')
  assert.equal(result.zcode.unmapped[0].today.total, 50)
  assert.equal(result.scan.zcode.available, true)
  assert.equal(result.scan.zcode.rows, 4)
  assert.equal(result.scan.sessions, 1, 'DSH scan metadata stays intact')
})

test('maps ZCode custom providers through the asynchronous LLM model catalog', async (t) => {
  // Regression: ctx.llm.listModels() returns a Promise. A synchronous catalog
  // read silently produced {} and left every custom ZCode provider unmapped.
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const now = Date.now()
  const zcodePath = await writeZcodeDb(t, [
    // A uuid provider whose exact model id exists only in the commandcode catalog.
    { providerId: 'ccfdde06-1d25-4d4d-af87-c3111250b70d', modelId: 'deepseek/deepseek-v4.1-flash', time: now, input: 1000, output: 0, total: 1000 },
    // The alias-mapped opencode-go route.
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', time: now, input: 500, output: 0, total: 500 },
  ])
  let catalogCalls = 0
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 60_000,
        harnesses: { dsh: true, zcode: true, opencode: false, workbuddy: false, qoder: false },
        zcode: { dbPath: zcodePath, providerAliases: { 'opencode-go-chat': 'opencode-go' } },
      },
    },
    providerCatalog: async () => {
      catalogCalls += 1
      return {
        commandcode: ['deepseek/deepseek-v4.1-flash', 'stealth/space-bunny-alpha'],
        'opencode-go': ['deepseek-v4.1-flash', 'glm-5.3-flash'],
      }
    },
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  assert.equal(catalogCalls, 1, 'the async catalog is resolved once per TTL')
  assert.equal(result.zcode.unmapped.length, 0)
  const commandcode = result.providers.find((provider) => provider.providerId === 'commandcode')
  assert.equal(commandcode.allTime.total, 1000, 'uuid provider mapped by exact model id')
  assert.equal(commandcode.harnesses.zcode.allTime.total, 1000)
  const opencodeGo = result.providers.find((provider) => provider.providerId === 'opencode-go')
  assert.equal(opencodeGo.allTime.total, 500, 'alias-mapped ZCode route')
  assert.equal(opencodeGo.harnesses.zcode.allTime.total, 500)
  assert.equal(result.harnesses.find((harness) => harness.harnessId === 'zcode').allTime.total, 1500)
})

test('a missing ZCode database degrades to DSH-only totals plus a harness error', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const today = todayAt(15)
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 10, outputTokens: 0, totalTokens: 10 }),
  ])
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: { ttlMs: 0, harnesses: { dsh: true, zcode: true, opencode: false, workbuddy: false, qoder: false }, zcode: { dbPath: join(dshHome, 'nope.sqlite') } },
    },
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  assert.equal(result.version, 3)
  assert.equal(result.allTime.total, 10, 'DSH totals are unaffected')
  assert.equal(result.last30Days.total, 10)
  assert.equal(result.harnesses.some((harness) => harness.harnessId === 'zcode'), false, 'uninstalled harness is hidden by default')
  assert.deepEqual(result.missingHarnesses, ['zcode'])
  assert.equal(result.zcode.available, false)
  assert.equal(result.scan.zcode.available, false)

  // `showMissingHarnesses: true` keeps the row, explicitly marked as missing.
  const verbose = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 0,
        showMissingHarnesses: true,
        harnesses: { dsh: true, zcode: true, opencode: false, workbuddy: false, qoder: false },
        zcode: { dbPath: join(dshHome, 'nope.sqlite') },
      },
    },
    log: { info() {}, warn() {} },
  })
  const withMissing = await verbose.get()
  const zcode = withMissing.harnesses.find((harness) => harness.harnessId === 'zcode')
  assert.equal(zcode.error.code, 'harness-missing')
  assert.equal(zcode.missing, true)
  assert.equal(zcode.allTime.total, 0)
})

/** Create a temp OpenCode CLI `message` database. */
async function writeOpencodeDb(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-opencode-home-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  rows.forEach((row, index) => {
    insert.run(
      `o-${index}`,
      'session-1',
      row.time,
      JSON.stringify({
        role: 'assistant',
        providerID: row.providerId ?? 'opencode',
        modelID: row.modelId ?? 'mimo-v2.5-free',
        tokens: {
          total: row.total,
          input: row.input ?? row.total,
          output: row.output ?? 0,
          reasoning: 0,
          cache: { read: row.cacheRead ?? 0, write: 0 },
        },
      }),
    )
  })
  db.close()
  return path
}

test('aggregates an arbitrary set of harnesses (DSH + ZCode + OpenCode) with per-harness splits', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const now = Date.now()
  const today = todayAt(12)
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 60, outputTokens: 40, totalTokens: 100 }),
  ])
  const zcodePath = await writeZcodeDb(t, [
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', time: now, input: 1000, output: 100, total: 1100 },
    { providerId: 'ccfdde06-1d25-4d4d-af87-c3111250b70d', modelId: 'deepseek/deepseek-v4.1-flash', time: now, input: 500, output: 0, total: 500 },
  ])
  const opencodePath = await writeOpencodeDb(t, [
    // Mapped onto commandcode through the OpenCode harness alias map.
    { providerId: 'huoshanyinqing', modelId: 'glm-5.3-flash', time: now, input: 650, output: 50, total: 700 },
    // Not mapped: stays in the all-harness totals and the unmapped list.
    { providerId: 'opencode', modelId: 'mimo-v2.5-free', time: now, input: 300, total: 300 },
  ])
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 0,
        harnesses: { dsh: true, zcode: true, opencode: true, workbuddy: false, qoder: false },
        zcode: { dbPath: zcodePath, providerAliases: { 'opencode-go-chat': 'opencode-go' } },
        opencode: { dbPath: opencodePath, providerAliases: { huoshanyinqing: 'commandcode' } },
      },
    },
    providerCatalog: async () => ({ commandcode: ['deepseek/deepseek-v4.1-flash'] }),
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()

  assert.deepEqual(result.harnesses.map((harness) => harness.harnessId), ['dsh', 'zcode', 'opencode'])
  assert.deepEqual(result.harnesses.map((harness) => harness.label), ['DSH', 'ZCode', 'OpenCode'])
  assert.equal(result.harnesses[0].today.total, 100)
  assert.equal(result.harnesses[1].today.total, 1600)
  assert.equal(result.harnesses[2].today.total, 1000)
  assert.equal(result.today.total, 2700, 'all harnesses are combined')
  assert.equal(result.allTime.total, 2700)

  const opencodeGo = result.providers.find((provider) => provider.providerId === 'opencode-go')
  assert.equal(opencodeGo.today.total, 1200, 'DSH + ZCode mapped usage')
  assert.equal(opencodeGo.harnesses.zcode.today.total, 1100)
  const commandcode = result.providers.find((provider) => provider.providerId === 'commandcode')
  assert.equal(commandcode.today.total, 1200, 'ZCode (model match) + OpenCode (alias) usage')
  assert.equal(commandcode.harnesses.zcode.today.total, 500)
  assert.equal(commandcode.harnesses.opencode.today.total, 700)
  assert.equal(result.providers.some((provider) => provider.providerId === 'opencode'), false)

  assert.equal(result.opencode.available, true)
  assert.equal(result.opencode.rows, 2)
  assert.equal(result.opencode.unmapped.length, 1)
  assert.equal(result.opencode.unmapped[0].providerId, 'opencode')
  assert.equal(result.opencode.unmapped[0].today.total, 300)
  assert.equal(result.unmapped.length, 1)
  assert.equal(result.unmapped[0].harnessId, 'opencode')
  assert.equal(result.scan.opencode.available, true)
  assert.equal(result.scan.zcode.available, true)
})

test('a missing OpenCode database degrades to the remaining harnesses', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const today = todayAt(15)
  await writeSession(dshHome, 'session-a', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'm1'),
    usageEvent(2, today, { inputTokens: 10, outputTokens: 0, totalTokens: 10 }),
  ])
  const stats = createUsageStats({
    dshHome,
    config: {
      stats: {
        ttlMs: 0,
        harnesses: { dsh: true, zcode: false, opencode: true, workbuddy: false, qoder: false },
        opencode: { dbPath: join(dshHome, 'nope', 'opencode.db') },
      },
    },
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  assert.equal(result.allTime.total, 10, 'DSH totals are unaffected')
  assert.equal(result.harnesses.some((harness) => harness.harnessId === 'opencode'), false, 'uninstalled harness is hidden by default')
  assert.deepEqual(result.missingHarnesses, ['opencode'])
  assert.equal(result.opencode.available, false)
  assert.equal(result.scan.opencode.available, false)
})

test('addBucket and emptyBucket are plain-number helpers', () => {
  const bucket = emptyBucket()
  addBucket(bucket, { input: 1, output: 2, total: 3, messages: 1 })
  addBucket(bucket, { input: 4, output: 5, total: 9, messages: 1, cacheRead: 6 })
  assert.deepEqual(bucket, { input: 5, output: 7, cacheRead: 6, cacheWrite: 0, total: 12, messages: 2 })
  addBucket(bucket, null)
  addBucket(bucket, { input: 'nope' })
  assert.equal(bucket.input, 5)
})

test('fiveHours keeps only the rolling five-hour local usage window', async (t) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'tokenlens-home-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const now = Date.now()
  const recent = now - 1 * 3600 * 1000
  const older = now - 8 * 3600 * 1000
  await writeSession(dshHome, 'session-five', [
    sessionHeader(),
    headerEvent(1, 'opencode-go', 'deepseek-v4.1-flash'),
    usageEvent(2, recent, { inputTokens: 40, outputTokens: 0, totalTokens: 40 }),
    usageEvent(3, older, { inputTokens: 60, outputTokens: 0, totalTokens: 60 }),
  ])
  const stats = createUsageStats({
    dshHome,
    config: { stats: { ttlMs: 0, harnesses: { dsh: true, zcode: false, opencode: false, workbuddy: false, qoder: false } } },
    log: { info() {}, warn() {} },
  })
  const result = await stats.get()
  const provider = result.providers.find((row) => row.providerId === 'opencode-go')
  assert.ok(provider, 'the provider row exists')
  assert.equal(provider.fiveHours.total, 40, 'only the event inside 5h counts')
  assert.equal(provider.fiveHours.messages, 1)
  assert.equal(provider.last7Days.total, 100, 'the older event still counts in the 7-day window')
})
