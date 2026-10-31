/**
 * OpenCode CLI harness adapter tests.
 *
 * A real SQLite `message` table is created from the shape observed in
 * `~/.local/share/opencode/opencode.db` (1,178 assistant messages): the `data`
 * JSON carries `tokens { total, input, output, reasoning, cache { read, write } }`
 * with `total = input + output + reasoning + cache.read` on every live row.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { defaultOpencodeDbPath, opencodeDbSignature, readOpencodeUsage } from '../lib/usage-opencode.mjs'

const TODAY = '2026-10-25'
const YESTERDAY = '2026-10-24'

/** Local epoch-ms for a day key at a fixed local hour. */
function at(day, hour = 12) {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime()
}

/** Create a temp OpenCode-style `message` database. */
async function opencodeDatabase(t, rows) {
  const dir = await mkdtemp(join(tmpdir(), 'tokenlens-opencode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  rows.forEach((row, index) => {
    insert.run(`m-${index}`, 'session-1', row.time, JSON.stringify(row.data))
  })
  db.close()
  return path
}

test('readOpencodeUsage normalizes OpenCode token semantics per (day, hour, provider, model)', async (t) => {
  const path = await opencodeDatabase(t, [
    {
      time: at(TODAY, 10),
      data: {
        role: 'assistant',
        providerID: 'huoshanyinqing',
        modelID: 'glm-5.3-flash',
        tokens: { total: 8789, input: 6915, output: 146, reasoning: 0, cache: { read: 1728, write: 0 } },
      },
    },
    {
      // reasoning is folded into output (DSH-style) and total still adds up.
      time: at(TODAY, 11),
      data: {
        role: 'assistant',
        providerID: 'huoshanyinqing',
        modelID: 'glm-5.3-flash',
        tokens: { total: 1000, input: 500, output: 100, reasoning: 150, cache: { read: 250, write: 0 } },
      },
    },
    {
      // A user message never carries tokens, and a zero row must not count.
      time: at(YESTERDAY, 9),
      data: {
        role: 'assistant',
        providerID: 'opencode',
        modelID: 'mimo-v2.5-free',
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
    {
      time: at(YESTERDAY, 10),
      data: {
        role: 'assistant',
        providerID: 'opencode',
        modelID: 'mimo-v2.5-free',
        tokens: { total: 420, input: 200, output: 20, reasoning: 0, cache: { read: 200, write: 0 } },
      },
    },
    // Non-token rows are ignored.
    { time: at(YESTERDAY, 11), data: { role: 'user' } },
  ])
  const result = readOpencodeUsage({ dbPath: path })
  assert.equal(result.harness, 'opencode')
  assert.equal(result.rows, 3, 'one group per (day, hour, provider, model)')
  assert.deepEqual(result.groups.map((group) => [group.day, group.hour, group.providerId]), [
    [YESTERDAY, 10, 'opencode'],
    [TODAY, 10, 'huoshanyinqing'],
    [TODAY, 11, 'huoshanyinqing'],
  ])
  // Two messages of the same day/provider/model in different local hours stay
  // distinct; the zero-token row at 09:00 leaves no group behind.
  const todayGroups = result.groups.filter((group) => group.day === TODAY)
  assert.deepEqual(todayGroups.map((group) => group.hour), [10, 11])
  assert.deepEqual(todayGroups.find((group) => group.hour === 10).bucket, {
    input: 6915,
    output: 146,
    cacheRead: 1728,
    cacheWrite: 0,
    total: 8789,
    messages: 1,
  })
  assert.deepEqual(todayGroups.find((group) => group.hour === 11).bucket, {
    input: 500,
    output: 250,
    cacheRead: 250,
    cacheWrite: 0,
    total: 1000,
    messages: 1,
  })
  const yesterdayGroup = result.groups.find((group) => group.day === YESTERDAY)
  assert.equal(yesterdayGroup.hour, 10)
  assert.equal(yesterdayGroup.providerId, 'opencode')
  assert.deepEqual(yesterdayGroup.bucket, {
    input: 200,
    output: 20,
    cacheRead: 200,
    cacheWrite: 0,
    total: 420,
    messages: 1,
  })
  assert.equal(typeof result.durationMs, 'number')
})

test('readOpencodeUsage tolerates an empty database and throws for a missing one', async (t) => {
  const empty = await opencodeDatabase(t, [])
  const result = readOpencodeUsage({ dbPath: empty })
  assert.equal(result.rows, 0)
  assert.deepEqual(result.groups, [])
  assert.throws(() => readOpencodeUsage({ dbPath: join(tmpdir(), 'definitely-missing-opencode-db.sqlite') }))
})

test('defaultOpencodeDbPath honours the env override and the home fallback', () => {
  assert.equal(
    defaultOpencodeDbPath({ OPENCODE_DB_PATH: 'D:\\o\\opencode.db' }, 'C:\\u'),
    'D:\\o\\opencode.db',
  )
  assert.equal(defaultOpencodeDbPath({}, 'C:\\u'), join('C:\\u', '.local', 'share', 'opencode', 'opencode.db'))
})

test('opencodeDbSignature changes when the database changes', async (t) => {
  const path = await opencodeDatabase(t, [])
  const before = opencodeDbSignature(path)
  assert.equal(before, opencodeDbSignature(path))
  assert.notEqual(opencodeDbSignature(join(tmpdir(), 'nope', 'opencode.db')), '')
})
