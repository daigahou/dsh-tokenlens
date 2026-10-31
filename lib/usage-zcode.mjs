/**
 * ZCode harness token statistics (local SQLite).
 *
 * ZCode (a coding agent on this machine) keeps one row per model request in
 * `~/.zcode/cli/db/db.sqlite` -> `model_usage`:
 *
 *   input_tokens, output_tokens, reasoning_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens,
 *   computed_total_tokens, provider_id, model_id, started_at, completed_at, status
 *
 * Semantics verified against 14,969 live rows: `computed_total_tokens` equals
 * `input_tokens + output_tokens` on every row, and `cache_read_input_tokens` is
 * always <= `input_tokens` — i.e. ZCode's `input_tokens` INCLUDES cached prompt
 * tokens. DSH's `inputTokens` EXCLUDES cache reads. To keep one comparable
 * "total includes cache" bucket across harnesses, every group is normalized:
 *
 *   input      = input_tokens - cache_read_input_tokens   (non-cached prompt)
 *   output     = output_tokens
 *   cacheRead  = cache_read_input_tokens
 *   cacheWrite = cache_creation_input_tokens
 *   total      = computed_total_tokens (= input + output, cache included)
 *
 * Only token counters, provider/model ids and the completion time are read: no
 * prompt or message content. The database is opened read-only.
 *
 * The result is a flat `groups` list (local day + local hour + ZCode provider id
 * + model id + bucket). Mapping a ZCode provider onto a canonical DSH provider
 * (e.g. `opencode-go-chat` -> `opencode-go`) is the caller's job, because the
 * mapping needs the Harness model catalog.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Friendly names for provider ids seen in the ZCode database. */
export const ZCODE_PROVIDER_LABELS = {
  'account:bigmodel-start-plan': 'BigModel Start Plan',
  'opencode-go-chat': 'OpenCode',
  'opencode-go': 'OpenCode',
  'new-provider': 'custom provider',
  'new-provider-2': 'custom provider',
  'new-provider-3': 'custom provider',
}

/** The default ZCode database location. */
export function defaultZcodeDbPath(env = process.env, home = homedir()) {
  if (typeof env.ZCODE_DB_PATH === 'string' && env.ZCODE_DB_PATH.trim() !== '') return env.ZCODE_DB_PATH.trim()
  return join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

/** A friendly label for a ZCode provider id. */
export function zcodeProviderLabel(providerId) {
  if (typeof providerId !== 'string' || providerId === '') return 'ZCode'
  return ZCODE_PROVIDER_LABELS[providerId] ?? providerId
}

/** A stable cache key from the database and its WAL generation. */
export function zcodeDbSignature(dbPath) {
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

/** The local `YYYY-MM-DD` for an epoch-ms instant. */
export function localDayKey(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The local clock hour (0..23) of an epoch-ms instant.
 *
 * A DST fall-back day repeats one wall-clock hour, so both instants collapse
 * into the same slot — which is exactly how the chart's 24 bars are defined.
 */
export function localHour(ms) {
  const hour = new Date(ms).getHours()
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0
}

/**
 * Read ZCode usage groups.
 *
 * @param input.dbPath - database file (read-only).
 * @param input.openDatabase - test seam: `(path) => DatabaseSync`-like handle.
 * @returns `{ groups: [{day, hour, providerId, modelId, bucket}], rows, durationMs, dbPath }`.
 */
export function readZcodeUsage(input = {}) {
  const dbPath = typeof input.dbPath === 'string' && input.dbPath !== '' ? input.dbPath : defaultZcodeDbPath()
  const openDatabase = input.openDatabase ?? defaultOpen
  const started = Date.now()
  const db = openDatabase(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT date(completed_at / 1000, 'unixepoch', 'localtime') AS day,
                CAST(strftime('%H', completed_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                provider_id AS providerId,
                model_id AS modelId,
                COUNT(*) AS messages,
                SUM(input_tokens) AS input,
                SUM(output_tokens) AS output,
                SUM(cache_read_input_tokens) AS cacheRead,
                SUM(cache_creation_input_tokens) AS cacheWrite,
                SUM(computed_total_tokens) AS total
           FROM model_usage
          WHERE computed_total_tokens > 0 AND completed_at IS NOT NULL
          GROUP BY day, hour, provider_id, model_id
          ORDER BY day, hour`,
      )
      .all()
    const groups = rows
      .filter((row) => typeof row.day === 'string' && row.day !== '')
      .map((row) => {
        const input = Math.max(0, Number(row.input ?? 0))
        const cacheRead = Math.max(0, Number(row.cacheRead ?? 0))
        const hour = Number(row.hour)
        return {
          day: row.day,
          // SQLite yields '00'..'23'; keep the wire field an integer.
          hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0,
          providerId: typeof row.providerId === 'string' && row.providerId !== '' ? row.providerId : 'unknown',
          modelId: typeof row.modelId === 'string' && row.modelId !== '' ? row.modelId : 'unknown',
          bucket: {
            // ZCode's input includes cache reads; store the non-cached part.
            input: Math.max(0, input - cacheRead),
            output: Math.max(0, Number(row.output ?? 0)),
            cacheRead,
            cacheWrite: Math.max(0, Number(row.cacheWrite ?? 0)),
            total: Math.max(0, Number(row.total ?? 0)),
            messages: Math.max(0, Number(row.messages ?? 0)),
          },
        }
      })
    return {
      harness: 'zcode',
      label: 'ZCode',
      dbPath,
      groups,
      rows: groups.length,
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

/** Open the ZCode database read-only; a missing runtime/file throws to the caller. */
function defaultOpen(path) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}
