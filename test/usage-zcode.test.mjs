/**
 * ZCode harness adapter tests: a real SQLite database is created in a temp dir
 * with the `model_usage` shape observed on this machine (verified against
 * 14,969 live rows), then read back through the same read-only path the Host uses.
 */
import assert from 'node:assert/strict'
import { statSync, utimesSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  defaultZcodeDbPath,
  localDayKey,
  readZcodeUsage,
  zcodeDbSignature,
  zcodeProviderLabel,
} from '../lib/usage-zcode.mjs'

const TODAY = '2026-10-25'
const YESTERDAY = '2026-10-24'

/** Create a temp `model_usage` database with the columns the adapter selects. */
async function zcodeDatabase(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-zcode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'db.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      status TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      provider_total_tokens INTEGER,
      computed_total_tokens INTEGER
    )
  `)
  const insert = db.prepare(`
    INSERT INTO model_usage (id, session_id, provider_id, model_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      provider_total_tokens, computed_total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  rows.forEach((row, index) => {
    insert.run(
      `row-${index}`,
      row.sessionId ?? 'session-1',
      row.providerId,
      row.modelId ?? 'model-1',
      row.status ?? 'completed',
      row.completedAt - 1000,
      row.completedAt,
      row.input,
      row.output,
      row.reasoning ?? 0,
      row.cacheWrite ?? 0,
      row.cacheRead ?? 0,
      row.total,
      row.total,
    )
  })
  db.close()
  return path
}

/** Local epoch-ms for a day key at a fixed local time. */
function at(day, hour = 12) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime()
}

test('localDayKey and provider labels', () => {
  assert.match(localDayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(localDayKey(new Date(2026, 9, 25, 23, 59).getTime()), '2026-10-25')
  assert.equal(zcodeProviderLabel('account:bigmodel-start-plan'), 'BigModel Start Plan')
  assert.equal(zcodeProviderLabel('opencode-go-chat'), 'OpenCode')
  assert.equal(zcodeProviderLabel('some-uuid'), 'some-uuid')
  assert.equal(zcodeProviderLabel(undefined), 'ZCode')
})

test('defaultZcodeDbPath honours the env override and the home fallback', () => {
  assert.equal(defaultZcodeDbPath({ ZCODE_DB_PATH: 'D:\\z\\db.sqlite' }, 'C:\\u'), 'D:\\z\\db.sqlite')
  assert.equal(defaultZcodeDbPath({}, 'C:\\u'), join('C:\\u', '.zcode', 'cli', 'db', 'db.sqlite'))
})

test('readZcodeUsage normalizes ZCode semantics per (day, hour, provider, model) group', async (t) => {
  const path = await zcodeDatabase(t, [
    // 470,134 prompt of which 469,760 cached: non-cached input must be 374.
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', completedAt: at(TODAY, 10), input: 470134, output: 267, cacheRead: 469760, total: 470401, sessionId: 's1' },
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', completedAt: at(TODAY, 11), input: 1000, output: 100, cacheRead: 400, total: 1100, sessionId: 's2' },
    { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3', completedAt: at(YESTERDAY, 9), input: 2000, output: 200, cacheRead: 1500, total: 2200, sessionId: 's3' },
    // A failed/cancelled request with no billable tokens is not counted.
    { providerId: 'opencode-go-chat', modelId: 'deepseek-v4.1-flash', completedAt: at(TODAY, 12), input: 0, output: 0, total: 0, status: 'error', sessionId: 's4' },
  ])
  const result = readZcodeUsage({ dbPath: path })
  assert.equal(result.harness, 'zcode')
  assert.equal(result.rows, 3, 'one group per (day, hour, provider, model); zero-total rows filtered by SQL')
  assert.deepEqual(result.groups.map((group) => [group.day, group.hour, group.providerId]), [
    [YESTERDAY, 9, 'account:bigmodel-start-plan'],
    [TODAY, 10, 'opencode-go-chat'],
    [TODAY, 11, 'opencode-go-chat'],
  ])
  // The same day/provider/model in two local hours stays two groups, and the
  // zero-token hour 12 row leaves no group behind.
  const todayGroups = result.groups.filter((group) => group.day === TODAY)
  assert.deepEqual(todayGroups.map((group) => group.hour), [10, 11])
  assert.deepEqual(todayGroups[0].bucket, {
    input: 374,
    output: 267,
    cacheRead: 469760,
    cacheWrite: 0,
    total: 470401,
    messages: 1,
  })
  assert.deepEqual(todayGroups[1].bucket, { input: 600, output: 100, cacheRead: 400, cacheWrite: 0, total: 1100, messages: 1 })
  const yesterdayGroup = result.groups.find((group) => group.day === YESTERDAY)
  assert.equal(yesterdayGroup.hour, 9)
  assert.equal(yesterdayGroup.providerId, 'account:bigmodel-start-plan')
  assert.equal(yesterdayGroup.modelId, 'GLM-5.3')
  assert.deepEqual(yesterdayGroup.bucket, { input: 500, output: 200, cacheRead: 1500, cacheWrite: 0, total: 2200, messages: 1 })
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(result.dbPath, path)
})

test('readZcodeUsage tolerates an empty database and throws for a missing one', async (t) => {
  const empty = await zcodeDatabase(t, [])
  const result = readZcodeUsage({ dbPath: empty })
  assert.equal(result.rows, 0)
  assert.deepEqual(result.groups, [])
  assert.throws(() => readZcodeUsage({ dbPath: join(tmpdir(), 'definitely-missing-zcode-db.sqlite') }))
})

test('zcodeDbSignature changes when the database changes', async (t) => {
  const path = await zcodeDatabase(t, [
    { providerId: 'p', completedAt: at(TODAY), input: 10, output: 1, total: 11 },
  ])
  const before = zcodeDbSignature(path)
  assert.equal(before, zcodeDbSignature(path), 'stable while untouched')
  const later = new Date(Date.now() + 5000)
  utimesSync(path, later, later)
  assert.notEqual(before, zcodeDbSignature(path))
  assert.equal(typeof statSync(path).mtimeMs, 'number')
})
