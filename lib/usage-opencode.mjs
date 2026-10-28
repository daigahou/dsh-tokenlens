/**
 * OpenCode CLI harness token statistics (local SQLite).
 *
 * The `opencode` CLI stores sessions/messages in
 * `~/.local/share/opencode/opencode.db` (SQLite). Each assistant message row's
 * `data` JSON carries:
 *
 *   { role: 'assistant', providerID, modelID, time: { created, completed },
 *     tokens: { total, input, output, reasoning, cache: { read, write } } }
 *
 * Verified against 1,178 live assistant messages: `total = input + output +
 * reasoning + cache.read` on every row. DSH folds reasoning into `output` and
 * keeps `input` exclusive of cache, so this adapter normalizes:
 *
 *   input      = tokens.input
 *   output     = tokens.output + tokens.reasoning
 *   cacheRead  = tokens.cache.read
 *   cacheWrite = tokens.cache.write
 *   total      = tokens.total   (== input + output + cacheRead above)
 *
 * Only counters, provider/model ids and the message time are read — no content.
 * The database is opened read-only.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { localDayKey } from './usage-zcode.mjs'

/** The default OpenCode CLI database location. */
export function defaultOpencodeDbPath(env = process.env, home = homedir()) {
  if (typeof env.OPENCODE_DB_PATH === 'string' && env.OPENCODE_DB_PATH.trim() !== '') {
    return env.OPENCODE_DB_PATH.trim()
  }
  return join(home, '.local', 'share', 'opencode', 'opencode.db')
}

/** A stable cache key from the database and its WAL generation. */
export function opencodeDbSignature(dbPath) {
  const part = (path) => {
    try {
      const stat = statSync(path)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return '-'
    }
  }
  return `${part(dbPath)}|${part(`${dbPath}-wal`)}`
}

/**
 * Read OpenCode CLI usage groups.
 *
 * @param input.dbPath - database file (read-only).
 * @param input.openDatabase - test seam: `(path) => DatabaseSync`-like handle.
 * @returns `{ groups: [{day, providerId, modelId, bucket}], rows, durationMs, dbPath }`.
 */
export function readOpencodeUsage(input = {}) {
  const dbPath =
    typeof input.dbPath === 'string' && input.dbPath !== '' ? input.dbPath : defaultOpencodeDbPath()
  const openDatabase = input.openDatabase ?? defaultOpen
  const started = Date.now()
  const db = openDatabase(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT time_created AS timeCreated, data
           FROM message
          WHERE data LIKE '%"tokens"%'`,
      )
      .all()
    const groups = new Map()
    for (const row of rows) {
      let message
      try {
        message = JSON.parse(row.data)
      } catch {
        continue
      }
      const tokens = message?.tokens
      if (tokens === null || typeof tokens !== 'object') continue
      const inputTokens = Number(tokens.input ?? 0)
      const outputTokens = Number(tokens.output ?? 0)
      const reasoningTokens = Number(tokens.reasoning ?? 0)
      const cacheRead = Number(tokens.cache?.read ?? 0)
      const cacheWrite = Number(tokens.cache?.write ?? 0)
      const total = Number(tokens.total ?? 0)
      if (![inputTokens, outputTokens, reasoningTokens, cacheRead, cacheWrite, total].every(Number.isFinite)) {
        continue
      }
      if (total <= 0 && inputTokens + outputTokens + reasoningTokens + cacheRead + cacheWrite <= 0) continue
      const time = typeof row.timeCreated === 'number' ? row.timeCreated : null
      if (time === null) continue
      const day = localDayKey(time)
      const providerId =
        typeof message.providerID === 'string' && message.providerID !== '' ? message.providerID : 'unknown'
      const modelId = typeof message.modelID === 'string' && message.modelID !== '' ? message.modelID : 'unknown'
      const key = `${day}\u0000${providerId}\u0000${modelId}`
      const group = groups.get(key) ?? {
        day,
        providerId,
        modelId,
        bucket: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 },
      }
      group.bucket.input += Math.max(0, inputTokens)
      // OpenCode keeps reasoning separate; DSH-style output includes it.
      group.bucket.output += Math.max(0, outputTokens) + Math.max(0, reasoningTokens)
      group.bucket.cacheRead += Math.max(0, cacheRead)
      group.bucket.cacheWrite += Math.max(0, cacheWrite)
      group.bucket.total += Math.max(0, total)
      group.bucket.messages += 1
      groups.set(key, group)
    }
    const list = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))
    return {
      harness: 'opencode',
      label: 'OpenCode',
      dbPath,
      groups: list,
      rows: list.length,
      durationMs: Date.now() - started,
    }
  } finally {
    try {
      db.close()
    } catch {
      /* closing a read-only handle never breaks the report */
    }
  }
}

/** Open the OpenCode database read-only; a missing runtime/file throws to the caller. */
function defaultOpen(path) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}
