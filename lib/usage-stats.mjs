/**
 * Token statistics: today and all-time totals from this machine's DSH session
 * logs, with a small persistent cache so repeated reads only rescan the files
 * that changed.
 *
 * Why raw session logs: the DSH Host records one `assistant/message` event per
 * successful model response, carrying `data.usage`
 * `{ inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens? }`.
 * The effective route comes from the preceding `request/header` event
 * (`data.header.config.{provider, model}`), and the event `time` is epoch ms.
 * Nothing above the Host aggregates those across sessions, so this module folds
 * them itself.
 *
 * A session log file is a run of independent zstd frames (one per append). Node's
 * streaming zstd decoder stops at the first frame's end, so the decoder below
 * walks every frame start (the zstd magic), decomposes the suffix and folds the
 * JSONL records by `type:seq` — which also makes a torn trailing frame harmless.
 *
 * The cache lives at `$DSH_HOME/dsh-tokenlens/usage-cache.json`; each entry
 * is keyed by the session file's {mtimeMs,size}, and holds per-day / per-provider
 * / per-model buckets. Only prompts' usage numbers are stored: no prompt text,
 * no message content.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { UsageError } from './go-usage.mjs'
import { defaultZcodeDbPath, readZcodeUsage, zcodeDbSignature, zcodeProviderLabel } from './usage-zcode.mjs'
import { defaultOpencodeDbPath, opencodeDbSignature, readOpencodeUsage } from './usage-opencode.mjs'
import {
  defaultQoderHome,
  defaultWorkbuddyRoot,
  jsonlTreeSignature,
  readQoderUsage,
  readWorkbuddyUsage,
} from './usage-jsonl.mjs'

/** zstd frame magic (skippable frames included, as the log writer never uses them). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Whether this Node decompresses every frame of a concatenated zstd buffer.
 *
 * Node < 24.22 only decodes the first frame of a buffer (and ignores trailing
 * bytes); Node >= 24.22 decodes every concatenated frame and rejects the whole
 * call with Z_BUF_ERROR when the last frame is truncated. Session logs can end
 * with a torn frame, so the decoder below has to adapt.
 */
const DECODES_CONCATENATED_FRAMES = (() => {
  try {
    const frame = (value) => zstdCompressSync(Buffer.from(value, 'utf8'))
    const joined = Buffer.concat([frame('a'), frame('b')])
    return zstdDecompressSync(joined).toString('utf8') === 'ab'
  } catch {
    return false
  }
})()


/** The session log file name inside each session directory. */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** Cache schema version; a mismatch discards the cache. */
const CACHE_VERSION = 5

/** What the numbers are, by provider id (display fallback; config can override). */
const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode Go',
  commandcode: 'Command Code',
  'deepseek-official': 'DeepSeek',
  deepseek: 'DeepSeek',
  'deepseek-account': 'DeepSeek Account',
}

/** An empty usage bucket. */
export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 }
}

/** The local-timezone day key (`YYYY-MM-DD`) for an epoch-ms instant. */
export function dayKey(ms) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The last usage chunk inside an embedded request stream, or null. */
function usageFromStream(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const item = stream[index]
    if (item?.type === 'usage' && item.usage !== null && typeof item.usage === 'object') return item.usage
    if (item?.chunk?.type === 'usage' && item.chunk.usage !== null && typeof item.chunk.usage === 'object') {
      return item.chunk.usage
    }
  }
  return null
}

/**
 * A JSON-able usage record from one event, or null when it is not billable usage.
 *
 * Authoritative shapes (verified against the persisted tokenUsage projection):
 *   - `assistant/message.data.usage` — one per successful model response;
 *   - `assistant/message.data.stream[last].chunk.usage` — fallback when the
 *     durable usage field is missing;
 *   - `assistant/attempt.data.stream[last].chunk.usage` — a retried attempt that
 *     really consumed tokens (attempts never carry `data.usage` otherwise).
 * Zero-token attempts (failed retries that produced nothing) are not counted.
 */
export function usageOf(event) {
  const type = event?.type
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return null
  const usage = event.data?.usage ?? usageFromStream(event.data?.stream)
  if (usage === null || typeof usage !== 'object') return null
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const input = number(usage.inputTokens)
  const output = number(usage.outputTokens)
  const cacheRead = number(usage.cacheReadTokens)
  const cacheWrite = number(usage.cacheWriteTokens)
  const total = usage.totalTokens === undefined ? input + output + cacheRead + cacheWrite : number(usage.totalTokens)
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && total === 0) return null
  return { input, output, cacheRead, cacheWrite, total, messages: 1 }
}

/**
 * Decode one session log file into its records, in sequence order.
 *
 * @returns `{ records, frames }`; a corrupt frame is skipped, never fatal.
 */
export function decodeSessionLog(bytes) {
  const starts = [0]
  let at = 1
  for (;;) {
    const found = bytes.indexOf(ZSTD_MAGIC, at)
    if (found < 0) break
    starts.push(found)
    at = found + 1
  }
  const records = new Map()
  let frames = 0
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : bytes.length
    let text
    try {
      text = decompressFrame(bytes, start, end)
    } catch {
      continue
    }
    frames += 1
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const key = `${record.type}:${record.seq ?? record.id ?? ''}`
      if (!records.has(key)) records.set(key, record)
    }
  }
  const ordered = [...records.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return { records: ordered, frames }
}

/**
 * Decompress the single zstd frame that starts at `start`.
 *
 * Node < 24.22 already stops at the first frame's end when given the suffix (and
 * quietly tolerates a torn trailing frame), so the suffix keeps working there.
 * Node >= 24.22 decodes all concatenated frames and rejects the whole call when a
 * later frame is torn, so each frame is decompressed from its own byte range.
 */
function decompressFrame(bytes, start, end) {
  if (!DECODES_CONCATENATED_FRAMES) return zstdDecompressSync(bytes.subarray(start)).toString('utf8')
  try {
    return zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
  } catch {
    // A `0x28b52ffd` byte run can also occur inside compressed data, so the sliced
    // candidate may not be a whole frame; retry over the suffix to recover it.
    return zstdDecompressSync(bytes.subarray(start)).toString('utf8')
  }
}

/** Add one bucket into another (in place on `target`). */
export function addBucket(target, from) {
  if (from === null || typeof from !== 'object') return target
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'messages']) {
    target[key] += typeof from[key] === 'number' && Number.isFinite(from[key]) ? from[key] : 0
  }
  return target
}

/** A detached copy of one bucket (so aggregating into it cannot alias another view). */
export function cloneBucket(from) {
  return addBucket(emptyBucket(), from)
}

/** Fold one decoded session into per-day / per-provider / per-model buckets. */
export function foldSession(records) {
  const days = Object.create(null)
  const providers = Object.create(null)
  const models = Object.create(null)
  const hours = Object.create(null)
  const workspaces = Object.create(null)
  let latestTime = 0
  let sessionCwd = null
  const session = { seeded: false, subagent: false, createdAt: null, id: null, inheritedEvents: 0 }
  // A forked (seeded) session starts with the parent's inherited prefix, which it
  // did not spend. The last `session/end-seed` record with `inherited: true`
  // marks that boundary; everything at or before it is somebody else's usage.
  let boundarySeq = null
  for (const record of records) {
    if (record.type === 'session/end-seed' && record.data?.inherited === true && Number.isSafeInteger(record.seq)) {
      boundarySeq = record.seq
    }
  }
  let provider = 'unknown'
  let model = 'unknown'
  for (const record of records) {
    if (record.type === 'session') {
      session.seeded = record.isSeeded === true
      session.subagent = record.origin === 'subagent' || (typeof record.delegationDepth === 'number' && record.delegationDepth > 0)
      session.createdAt = record.createdAt ?? null
      session.id = record.id ?? null
      if (typeof record.cwd === 'string' && record.cwd !== '') sessionCwd = record.cwd
      continue
    }
    if (record.type === 'request/header') {
      const config = record.data?.header?.config
      if (config !== null && typeof config === 'object') {
        if (typeof config.provider === 'string' && config.provider !== '') provider = config.provider
        if (typeof config.model === 'string' && config.model !== '') model = config.model
      }
      continue
    }
    if (boundarySeq !== null && Number.isSafeInteger(record.seq) && record.seq <= boundarySeq) continue
    const usage = usageOf(record)
    if (usage === null) continue
    const time = typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : null
    if (time === null) continue
    // A successful message names its own route authoritatively; an attempt only
    // knows the route of the request header that preceded it.
    let attributedProvider = provider
    let attributedModel = model
    const source = record.data?.message?.source
    if (
      record.type === 'assistant/message' &&
      typeof source?.provider === 'string' &&
      source.provider !== '' &&
      typeof source?.model === 'string' &&
      source.model !== ''
    ) {
      attributedProvider = source.provider
      attributedModel = source.model
    }
    if (time > latestTime) latestTime = time
    const hour = Math.floor(time / 3600_000)
    const hourBucket = (hours[hour] ??= { providers: Object.create(null) })
    addBucket((hourBucket.providers[attributedProvider] ??= emptyBucket()), usage)
    if (sessionCwd !== null) {
      const workspaceBucket = (workspaces[sessionCwd] ??= { days: {}, total: emptyBucket() })
      addBucket(workspaceBucket.total, usage)
      const workspaceDay = (workspaceBucket.days[dayKey(time)] ??= emptyBucket())
      addBucket(workspaceDay, usage)
    }
    const day = dayKey(time)
    const dayBucket = (days[day] ??= { providers: Object.create(null) })
    const dayProvider = (dayBucket.providers[attributedProvider] ??= emptyBucket())
    addBucket(dayProvider, usage)
    addBucket((providers[attributedProvider] ??= emptyBucket()), usage)
    const modelKey = `${attributedProvider}/${attributedModel}`
    const modelBucket = (models[modelKey] ??= {
      provider: attributedProvider,
      model: attributedModel,
      today: {},
      total: emptyBucket(),
    })
    addBucket(modelBucket.total, usage)
    const modelDay = (modelBucket.today[day] ??= emptyBucket())
    addBucket(modelDay, usage)
  }
  if (latestTime > 0) {
    const cutoff = Math.floor((latestTime - 35 * 24 * 3600_000) / 3600_000)
    for (const key of Object.keys(hours)) {
      if (Number(key) < cutoff) delete hours[key]
    }
  }
  return { days, providers, models, hours, workspaces, session }
}

/** Merge one file's folded contribution into an aggregate being built. */
function mergeFold(aggregate, fold) {
  for (const [day, dayBucket] of Object.entries(fold.days ?? {})) {
    const target = (aggregate.days[day] ??= { providers: Object.create(null) })
    for (const [provider, bucket] of Object.entries(dayBucket.providers ?? {})) {
      addBucket((target.providers[provider] ??= emptyBucket()), bucket)
    }
  }
  for (const [provider, bucket] of Object.entries(fold.providers ?? {})) {
    addBucket((aggregate.providers[provider] ??= emptyBucket()), bucket)
  }
  for (const [key, model] of Object.entries(fold.models ?? {})) {
    const target = (aggregate.models[key] ??= { provider: model.provider, model: model.model, today: {}, total: emptyBucket() })
    addBucket(target.total, model.total)
    for (const [day, bucket] of Object.entries(model.today ?? {})) {
      addBucket((target.today[day] ??= emptyBucket()), bucket)
    }
  }
  addBucket(aggregate.total, foldTotal(fold))
}

/** The all-time bucket of one file fold. */
function foldTotal(fold) {
  const total = emptyBucket()
  for (const bucket of Object.values(fold.providers ?? {})) addBucket(total, bucket)
  return total
}

/** Every `session.v4.jsonl.zstd` under the sessions root, sorted shallow-last. */
export function listSessionFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === SESSION_FILE) out.push(path)
    }
  }
  walk(root)
  return out.sort((a, b) => a.localeCompare(b))
}

/** A bucket cast to plain numbers (defensive against a hand-edited cache). */
function cleanBucket(bucket) {
  const out = emptyBucket()
  if (bucket === null || typeof bucket !== 'object') return out
  for (const key of Object.keys(out)) {
    const value = bucket[key]
    out[key] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  return out
}

/**
 * Token statistics service.
 *
 * @param input.dshHome - `$DSH_HOME` (session logs live under `<dshHome>/sessions`).
 * @param input.config - normalized plugin config; `config.stats` tunes TTL/cache path.
 * @param input.log - `{ info, warn }` (optional).
 */
export function createUsageStats(input) {
  const dshHome = typeof input.dshHome === 'string' && input.dshHome !== '' ? input.dshHome : undefined
  if (dshHome === undefined) {
    throw new UsageError('stats-unavailable', 'no DSH home directory is known', { retryable: false })
  }
  const statsConfig = input.config?.stats ?? {}
  const sessionsRoot = join(dshHome, 'sessions')
  const cacheFile = typeof statsConfig.cacheFile === 'string' && statsConfig.cacheFile !== ''
    ? statsConfig.cacheFile
    : join(dshHome, 'dsh-tokenlens', 'usage-cache.json')
  const ttlMs = Number.isSafeInteger(statsConfig.ttlMs) && statsConfig.ttlMs >= 0 ? statsConfig.ttlMs : 30_000
  // By default a harness whose local store is gone (uninstalled) is hidden from
  // the dialog instead of lingering as a zero row; diagnostics still record it.
  const showUninstalled = statsConfig.showUninstalled === true || statsConfig.showMissingHarnesses === true
  const maxFileBytes = Number.isSafeInteger(statsConfig.maxFileBytes) && statsConfig.maxFileBytes > 0
    ? statsConfig.maxFileBytes
    : 128 * 1024 * 1024
  // Which local harnesses contribute: DSH session logs (always the default) and
  // optional harness databases such as ZCode's SQLite store.
  const harnessesConfig =
    statsConfig.harnesses !== null && typeof statsConfig.harnesses === 'object' ? statsConfig.harnesses : {}
  const dshEnabled = harnessesConfig.dsh !== false
  const zcodeEnabled = harnessesConfig.zcode !== false
  const opencodeEnabled = harnessesConfig.opencode !== false
  const zcodeConfig = statsConfig.zcode !== null && typeof statsConfig.zcode === 'object' ? statsConfig.zcode : {}
  const zcodeDbPath =
    typeof zcodeConfig.dbPath === 'string' && zcodeConfig.dbPath !== ''
      ? zcodeConfig.dbPath
      : defaultZcodeDbPath()
  const zcodeAliases = parseAliasMap(zcodeConfig.providerAliases)
  const opencodeConfig =
    statsConfig.opencode !== null && typeof statsConfig.opencode === 'object' ? statsConfig.opencode : {}
  const opencodeDbPath =
    typeof opencodeConfig.dbPath === 'string' && opencodeConfig.dbPath !== ''
      ? opencodeConfig.dbPath
      : defaultOpencodeDbPath()
  const opencodeAliases = parseAliasMap(opencodeConfig.providerAliases)
  const workbuddyEnabled = harnessesConfig.workbuddy !== false
  const workbuddyConfig =
    statsConfig.workbuddy !== null && typeof statsConfig.workbuddy === 'object' ? statsConfig.workbuddy : {}
  const workbuddyRoot =
    typeof workbuddyConfig.root === 'string' && workbuddyConfig.root !== '' ? workbuddyConfig.root : defaultWorkbuddyRoot()
  const workbuddyAliases = parseAliasMap(workbuddyConfig.providerAliases)
  const qoderEnabled = harnessesConfig.qoder !== false
  const qoderConfig = statsConfig.qoder !== null && typeof statsConfig.qoder === 'object' ? statsConfig.qoder : {}
  const qoderHome =
    typeof qoderConfig.home === 'string' && qoderConfig.home !== '' ? qoderConfig.home : defaultQoderHome()
  const qoderAliases = parseAliasMap(qoderConfig.providerAliases)
  // Model catalog per canonical provider, used to map a harness's own provider
  // ids (ZCode uuids, `opencode-go-chat`, …) onto the DSH provider ids.
  const providerCatalog = typeof input.providerCatalog === 'function' ? input.providerCatalog : () => ({})
  let catalogMemo = { at: 0, value: {} }
  const log = input.log ?? { info() {}, warn() {} }

  let cache = loadCache()
  let lastResult = null
  let lastResultAt = 0
  let inflight = null
  let lastScan = null
  let zcodeMemo = { sig: null, at: 0, value: null, error: null }
  let opencodeMemo = { sig: null, at: 0, value: null, error: null }
  let workbuddyMemo = { sig: null, at: 0, value: null, error: null }
  let qoderMemo = { sig: null, at: 0, value: null, error: null }

  function loadCache() {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (parsed?.version === CACHE_VERSION && parsed.files !== null && typeof parsed.files === 'object') {
        return { version: CACHE_VERSION, files: parsed.files }
      }
    } catch {
      /* a missing or corrupt cache is simply a cold start */
    }
    return { version: CACHE_VERSION, files: {} }
  }

  function saveCache() {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const temporary = `${cacheFile}.${process.pid}.${Date.now().toString(36)}.tmp`
      writeFileSync(temporary, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        renameSync(temporary, cacheFile)
      } catch (error) {
        try {
          unlinkSync(temporary)
        } catch {
          /* best-effort cleanup */
        }
        throw error
      }
    } catch (error) {
      log.warn(`cannot persist the token-statistics cache: ${String(error?.message ?? error)}`)
    }
  }

  function providerLabel(providerId) {
    const configured = input.config?.providers?.[providerId]?.label
    return typeof configured === 'string' && configured !== ''
      ? configured
      : PROVIDER_LABELS[providerId] ?? providerId
  }

  /** Turn the per-file folds into the DSH aggregate (today, 30 days, all time). */
  function aggregate(scan) {
    const now = Date.now()
    const today = dayKey(now)
    // Rolling 30 calendar days including today.
    const daysAgo = (days) => {
      const date = new Date(now)
      date.setDate(date.getDate() - days)
      return dayKey(date.getTime())
    }
    const thirtyStart = daysAgo(29)
    const sevenStart = daysAgo(6)
    const daysAggregate = Object.create(null)
    const providersAggregate = Object.create(null)
    const modelsAggregate = Object.create(null)
  const hoursAggregate = Object.create(null)
  const workspacesAggregate = Object.create(null)
    for (const entry of Object.values(cache.files)) {
      for (const [day, dayBucket] of Object.entries(entry.days ?? {})) {
        const target = (daysAggregate[day] ??= { providers: Object.create(null) })
        for (const [provider, bucket] of Object.entries(dayBucket.providers ?? {})) {
          addBucket((target.providers[provider] ??= emptyBucket()), cleanBucket(bucket))
        }
      }
      for (const [provider, bucket] of Object.entries(entry.providers ?? {})) {
        addBucket((providersAggregate[provider] ??= emptyBucket()), cleanBucket(bucket))
      }
      for (const [cwd, bucket] of Object.entries(entry.workspaces ?? {})) {
        const target = (workspacesAggregate[cwd] ??= { days: {}, total: emptyBucket() })
        if (bucket !== null && typeof bucket === 'object' && bucket.days !== undefined) {
          addBucket(target.total, cleanBucket(bucket.total))
          for (const [day, dayBucket] of Object.entries(bucket.days ?? {})) {
            addBucket((target.days[day] ??= emptyBucket()), cleanBucket(dayBucket))
          }
        } else {
          addBucket(target.total, cleanBucket(bucket))
        }
      }
      for (const [hour, bucket] of Object.entries(entry.hours ?? {})) {
        const target = (hoursAggregate[hour] ??= { providers: Object.create(null) })
        for (const [provider, providerBucket] of Object.entries(bucket.providers ?? {})) {
          addBucket((target.providers[provider] ??= emptyBucket()), cleanBucket(providerBucket))
        }
      }
      for (const [key, model] of Object.entries(entry.models ?? {})) {
        const target = (modelsAggregate[key] ??= { provider: model.provider, model: model.model, today: {}, last7Days: emptyBucket(), last30Days: emptyBucket(), total: emptyBucket() })
        addBucket(target.total, cleanBucket(model.total))
        for (const [day, bucket] of Object.entries(model.today ?? {})) {
          addBucket((target.today[day] ??= emptyBucket()), cleanBucket(bucket))
          if (day >= thirtyStart) addBucket(target.last30Days, cleanBucket(bucket))
          if (day >= sevenStart) addBucket(target.last7Days, cleanBucket(bucket))
        }
      }
    }

    const allTime = emptyBucket()
    for (const bucket of Object.values(providersAggregate)) addBucket(allTime, bucket)
    // Rolling 5-hour window from the hourly DSH buckets.
    const fiveHourStart = Math.floor((now - 5 * 3600_000) / 3600_000)
    const fiveHoursByProvider = Object.create(null)
    for (const [hour, bucket] of Object.entries(hoursAggregate)) {
      if (Number(hour) < fiveHourStart) continue
      for (const [provider, providerBucket] of Object.entries(bucket.providers ?? {})) {
        addBucket((fiveHoursByProvider[provider] ??= emptyBucket()), providerBucket)
      }
    }
    const todayBucket = emptyBucket()
    const last7Bucket = emptyBucket()
    const last30Bucket = emptyBucket()
    const providerBuckets = new Map()
    for (const [providerId, bucket] of Object.entries(providersAggregate)) {
      providerBuckets.set(providerId, {
        today: emptyBucket(),
        last7Days: emptyBucket(),
        last30Days: emptyBucket(),
        fiveHours: fiveHoursByProvider[providerId] === undefined ? emptyBucket() : cleanBucket(fiveHoursByProvider[providerId]),
        allTime: bucket,
      })
    }
    // Earliest day with an attributed record (the fallback "effective date"
    // when the provider exposes no subscription start date). This must look at
    // ALL cached days: a provider first used months ago is still effective from
    // that first day, even though the window buckets only cover the last 30.
    const providerFirstDay = new Map()
    for (const [day, dayBucket] of Object.entries(daysAggregate)) {
      for (const provider of Object.keys(dayBucket.providers ?? {})) {
        const known = providerFirstDay.get(provider)
        if (known === undefined || day < known) providerFirstDay.set(provider, day)
      }
    }
    for (const [day, dayBucket] of Object.entries(daysAggregate)) {
      const inToday = day === today
      const in7 = day >= sevenStart
      const in30 = day >= thirtyStart
      if (!inToday && !in30) continue
      for (const [provider, bucket] of Object.entries(dayBucket.providers ?? {})) {
        if (inToday) addBucket(todayBucket, bucket)
        if (in7) addBucket(last7Bucket, bucket)
        if (in30) addBucket(last30Bucket, bucket)
        const entry = providerBuckets.get(provider) ?? { today: emptyBucket(), last7Days: emptyBucket(), last30Days: emptyBucket(), allTime: emptyBucket() }
        if (inToday) addBucket(entry.today, bucket)
        if (in7) addBucket(entry.last7Days, bucket)
        if (in30) addBucket(entry.last30Days, bucket)
        providerBuckets.set(provider, entry)
      }
    }

    const providers = [...providerBuckets.entries()]
      .map(([providerId, buckets]) => ({
        providerId,
        label: providerLabel(providerId),
        today: buckets.today,
        last7Days: buckets.last7Days,
        last30Days: buckets.last30Days,
        fiveHours: buckets.fiveHours,
        allTime: buckets.allTime,
        firstDay: providerFirstDay.get(providerId) ?? null,
      }))
      .sort((a, b) => b.allTime.total - a.allTime.total)

    // Per-workspace windows from the workspace day buckets (matching the
    // rolling 7/30-day windows used elsewhere).
    const workspaceWindow = (bucket, startDay) => {
      const out = emptyBucket()
      for (const [day, dayBucket] of Object.entries(bucket.days ?? {})) {
        if (day < startDay) continue
        addBucket(out, dayBucket)
      }
      return { total: out.total, messages: out.messages }
    }
    const aggregateWorkspaces = Object.entries(workspacesAggregate)
      .map(([cwd, bucket]) => {
        const todayBucket = workspaceWindow(bucket, today)
        const last7Bucket = workspaceWindow(bucket, sevenStart)
        const last30Bucket = workspaceWindow(bucket, thirtyStart)
        return {
          cwd,
          today: todayBucket,
          last7Days: last7Bucket,
          last30Days: last30Bucket,
          total: bucket.total.total,
          messages: bucket.total.messages,
        }
      })
      .sort((a, b) => b.total - a.total)

    const models = Object.entries(modelsAggregate)
      // (model totals are all-time; a model cannot have records before its
      // provider effective day, so since-effective == all-time)
      .map(([key, model]) => {
        const todayModel = emptyBucket()
        addBucket(todayModel, model.today?.[today])
        return {
          key,
          providerId: model.provider,
          modelId: model.model,
          today: { total: todayModel.total, messages: todayModel.messages },
          last7Days: { total: model.last7Days.total, messages: model.last7Days.messages },
          last30Days: { total: model.last30Days.total, messages: model.last30Days.messages },
          allTime: { total: model.total.total, messages: model.total.messages },
          sinceEffective: { total: model.total.total, messages: model.total.messages },
        }
      })
      .sort((a, b) => b.allTime.total - a.allTime.total)

    // Compact daily series (bounded) for the client chart view.
    const daily = Object.entries(daysAggregate)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-120)
      .map(([day, bucket]) => {
        const providers = Object.create(null)
        const totals = emptyBucket()
        for (const [providerId, providerBucket] of Object.entries(bucket.providers ?? {})) {
          providers[providerId] = { total: providerBucket.total ?? 0, messages: providerBucket.messages ?? 0 }
          addBucket(totals, providerBucket)
        }
        return { day, total: { total: totals.total, messages: totals.messages }, providers }
      })

    return {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      timezone: safeTimezone(),
      day: today,
      thirtyStart,
      sevenStart,
      today: todayBucket,
      last7Days: last7Bucket,
      last30Days: last30Bucket,
      allTime,
      workspaces: aggregateWorkspaces,
      providers,
      models: models.slice(0, 12),
      daily,
      scan,
    }
  }

  /** Fold every changed session file (cold scan or incremental). */
  function scan() {
    const started = Date.now()
    const files = listSessionFiles(sessionsRoot)
    const nextFiles = {}
    let scanned = 0
    let reused = 0
    let skipped = 0
    let bytesRead = 0
    let frames = 0
    const failures = []
    for (const path of files) {
      let stat
      try {
        stat = statSync(path)
      } catch {
        skipped += 1
        continue
      }
      const known = cache.files[path]
      if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
        nextFiles[path] = known
        reused += 1
        continue
      }
      if (stat.size > maxFileBytes) {
        skipped += 1
        failures.push({ path, reason: 'too-large', size: stat.size })
        continue
      }
      let bytes
      try {
        bytes = readFileSync(path)
      } catch (error) {
        skipped += 1
        failures.push({ path, reason: 'unreadable', message: String(error?.message ?? error) })
        continue
      }
      let decoded
      try {
        decoded = decodeSessionLog(bytes)
      } catch (error) {
        skipped += 1
        failures.push({ path, reason: 'decode', message: String(error?.message ?? error) })
        continue
      }
      const fold = foldSession(decoded.records)
      // A forked session's inherited prefix is already cut in foldSession; its
      // own usage is real spend and stays in the totals.
      const entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        frames: decoded.frames,
        seeded: fold.session.seeded,
        subagent: fold.session.subagent,
        days: fold.days,
        providers: fold.providers,
        models: fold.models,
        hours: fold.hours,
        workspaces: fold.workspaces,
      }
      nextFiles[path] = entry
      scanned += 1
      bytesRead += bytes.length
      frames += decoded.frames
    }
    // Drop files that disappeared from disk.
    cache = { version: CACHE_VERSION, files: nextFiles }
    saveCache()
    const scanInfo = {
      sessions: files.length,
      scanned,
      reused,
      skipped,
      failures: failures.slice(0, 5),
      bytes: bytesRead,
      frames,
      durationMs: Date.now() - started,
      cacheFile,
    }
    lastScan = scanInfo
    if (scanned > 0) log.info(`token statistics rescanned ${scanned} session file(s) in ${scanInfo.durationMs} ms`)
    return scanInfo
  }

  /** Whether the cached answer can be served without touching the filesystem. */
  function isFresh(now) {
    return lastResult !== null && now - lastResultAt < ttlMs
  }

  /** An aggregate with no DSH contribution (when DSH is disabled in config). */
  function emptyDshAggregate(now) {
    return {
      version: 1,
      generatedAt: new Date(now).toISOString(),
      timezone: safeTimezone(),
      day: dayKey(now),
      thirtyStart: dayKey(new Date(now - 29 * 24 * 60 * 60 * 1000).getTime()),
      sevenStart: dayKey(new Date(now - 6 * 24 * 60 * 60 * 1000).getTime()),
      today: emptyBucket(),
      last7Days: emptyBucket(),
      last30Days: emptyBucket(),
      allTime: emptyBucket(),
      providers: [],
      models: [],
      scan: {
        sessions: 0,
        scanned: 0,
        reused: 0,
        skipped: 0,
        failures: [],
        bytes: 0,
        frames: 0,
        durationMs: 0,
        cacheFile,
      },
    }
  }

  /** The ZCode harness contribution, memoized by database/WAL generation. */
  function zcodeSlice(now) {
    if (!zcodeEnabled) return { enabled: false, dbPath: zcodeDbPath, value: null, error: null, cached: false }
    const sig = zcodeDbSignature(zcodeDbPath)
    if (zcodeMemo.sig === sig && zcodeMemo.at !== 0 && now - zcodeMemo.at < ttlMs) {
      return { enabled: true, dbPath: zcodeDbPath, value: zcodeMemo.value, error: zcodeMemo.error, cached: true }
    }
    try {
      const value = readZcodeUsage({ dbPath: zcodeDbPath })
      zcodeMemo = { sig, at: now, value, error: null }
      log.info(`ZCode usage: ${value.rows} grouped day/provider/model rows in ${value.durationMs} ms`)
      return { enabled: true, dbPath: zcodeDbPath, value, error: null, cached: false }
    } catch (error) {
      const wire = {
        code: 'stats-unavailable',
        message: `ZCode database unavailable: ${String(error?.message ?? error)}`,
        retryable: true,
      }
      zcodeMemo = { sig, at: now, value: null, error: wire }
      log.warn(`ZCode statistics unavailable: ${wire.message}`)
      return { enabled: true, dbPath: zcodeDbPath, value: null, error: wire, cached: false }
    }
  }

  /** Map one harness row's provider/model onto a canonical (DSH) provider. */
  function mapHarnessProvider(originalProviderId, modelId, aliases, catalog) {
    const alias = aliases[originalProviderId]
    if (typeof alias === 'string' && alias !== '') return { providerId: alias, via: 'alias' }
    if (Object.prototype.hasOwnProperty.call(catalog, originalProviderId)) {
      return { providerId: originalProviderId, via: 'id' }
    }
    // Model-catalog matching is only trusted for vendor-namespaced ids such as
    // `deepseek/deepseek-v4.1-flash` (Command Code style): the same bare model
    // name (`glm-5.3-flash`, `step-5-preview`) is resold by several providers, so
    // matching those would mis-attribute a plan's usage. Ambiguous rows stay in
    // `unmapped` and can be pinned with the harness providerAliases config.
    if (typeof modelId !== 'string' || !modelId.includes('/')) return null
    const matches = []
    for (const [providerId, models] of Object.entries(catalog)) {
      if (Array.isArray(models) && models.includes(modelId)) matches.push(providerId)
    }
    if (matches.length === 1) return { providerId: matches[0], via: 'model' }
    return null
  }

  /** The external harness readers this composition can use. */
  function externalHarnessDefs() {
    return [
      {
        id: 'zcode',
        label: 'ZCode',
        enabled: zcodeEnabled,
        dbPath: zcodeDbPath,
        storePath: zcodeDbPath,
        storeKind: 'file',
        aliases: zcodeAliases,
        signature: zcodeDbSignature,
        memo: () => zcodeMemo,
        setMemo: (value) => {
          zcodeMemo = value
        },
        read: () => readZcodeUsage({ dbPath: zcodeDbPath }),
        missing: () => !existsSync(zcodeDbPath),
        providerLabel: zcodeProviderLabel,
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        enabled: opencodeEnabled,
        dbPath: opencodeDbPath,
        storePath: opencodeDbPath,
        storeKind: 'file',
        aliases: opencodeAliases,
        signature: opencodeDbSignature,
        memo: () => opencodeMemo,
        setMemo: (value) => {
          opencodeMemo = value
        },
        read: () => readOpencodeUsage({ dbPath: opencodeDbPath }),
        missing: () => !existsSync(opencodeDbPath),
        providerLabel: (providerId) =>
          typeof providerId === 'string' && providerId !== '' ? providerId : 'OpenCode',
      },
      {
        id: 'workbuddy',
        label: 'WorkBuddy',
        enabled: workbuddyEnabled,
        dbPath: workbuddyRoot,
        storePath: workbuddyRoot,
        storeKind: 'dir',
        aliases: workbuddyAliases,
        signature: jsonlTreeSignature,
        memo: () => workbuddyMemo,
        setMemo: (value) => {
          workbuddyMemo = value
        },
        read: () => readWorkbuddyUsage({ root: workbuddyRoot }),
        missing: () => !existsSync(workbuddyRoot),
        providerLabel: () => 'WorkBuddy',
      },
      {
        id: 'qoder',
        label: 'Qoder',
        enabled: qoderEnabled,
        dbPath: qoderHome,
        storePath: join(qoderHome, 'projects'),
        storeKind: 'dir',
        aliases: qoderAliases,
        signature: (path) => jsonlTreeSignature(join(path, 'projects')),
        memo: () => qoderMemo,
        setMemo: (value) => {
          qoderMemo = value
        },
        read: () => readQoderUsage({ home: qoderHome }),
        missing: () => !existsSync(qoderHome),
        providerLabel: () => 'Qoder',
      },
    ]
  }

  /** One harness's groups, memoized by database/WAL generation. */
  function externalSlice(now, def) {
    if (def.enabled !== true) {
      return { enabled: false, dbPath: def.dbPath, value: null, error: null, cached: false }
    }
    if (typeof def.missing === 'function' && def.missing()) {
      const wire = {
        code: 'harness-missing',
        message: def.label + ' is not installed or its local data is gone',
        // Reinstalling the harness is the fix; retrying the same read cannot help.
        retryable: false,
      }
      return { enabled: true, dbPath: def.dbPath, value: null, error: wire, cached: false, missing: true }
    }
    const memo = def.memo()
    const sig = def.signature(def.dbPath)
    if (memo.sig === sig && memo.at !== 0 && now - memo.at < ttlMs) {
      return { enabled: true, dbPath: def.dbPath, value: memo.value, error: memo.error, cached: true, installed: true }
    }
    try {
      const value = def.read()
      def.setMemo({ sig, at: now, value, error: null })
      log.info(def.label + ' usage: ' + value.rows + ' grouped day/provider/model rows in ' + value.durationMs + ' ms')
      return { enabled: true, dbPath: def.dbPath, value, error: null, cached: false, installed: true }
    } catch (error) {
      const wire = {
        code: 'stats-unavailable',
        message: def.label + ' database unavailable: ' + String(error?.message ?? error),
        retryable: true,
      }
      def.setMemo({ sig, at: now, value: null, error: wire })
      log.warn(def.label + ' statistics unavailable: ' + wire.message)
      return { enabled: true, dbPath: def.dbPath, value: null, error: wire, cached: false, installed: true }
    }
  }

  /** Fold one external harness into buckets + mapped/unmapped provider rows. */
  function foldExternal(def, slice, dsh, catalog) {
    const buckets = { today: emptyBucket(), last7Days: emptyBucket(), last30Days: emptyBucket(), allTime: emptyBucket() }
    const providers = new Map()
    const providerFirstDay = new Map()
    const unmapped = new Map()
    const daily = new Map()
    if (slice.value !== null) {
      for (const group of slice.value.groups) {
        const inToday = group.day === dsh.day
        const in7 = group.day >= dsh.sevenStart
        const in30 = group.day >= dsh.thirtyStart
        addBucket(buckets.allTime, group.bucket)
        if (inToday) addBucket(buckets.today, group.bucket)
        if (in7) addBucket(buckets.last7Days, group.bucket)
        if (in30) addBucket(buckets.last30Days, group.bucket)
        const mapped = mapHarnessProvider(group.providerId, group.modelId, def.aliases, catalog)
        const target = mapped === null ? unmapped : providers
        const key = mapped === null ? group.providerId : mapped.providerId
        const entry = target.get(key) ?? {
          providerId: key,
          label: mapped === null ? def.providerLabel(group.providerId) : providerLabel(key),
          today: emptyBucket(),
          last7Days: emptyBucket(),
          last30Days: emptyBucket(),
          allTime: emptyBucket(),
        }
        addBucket(entry.allTime, group.bucket)
        if (inToday) addBucket(entry.today, group.bucket)
        if (in7) addBucket(entry.last7Days, group.bucket)
        if (in30) addBucket(entry.last30Days, group.bucket)
        target.set(key, entry)
        const dayEntry = daily.get(group.day) ?? { total: emptyBucket(), providers: new Map() }
        addBucket(dayEntry.total, group.bucket)
        if (mapped !== null) {
          const dayProvider = dayEntry.providers.get(key) ?? emptyBucket()
          addBucket(dayProvider, group.bucket)
          dayEntry.providers.set(key, dayProvider)
          const known = providerFirstDay.get(key)
          if (typeof group.day === 'string' && (known === undefined || group.day < known)) {
            providerFirstDay.set(key, group.day)
          }
        }
        daily.set(group.day, dayEntry)
      }
    }
    return { buckets, providers, providerFirstDay, daily, unmapped }
  }

  /**
   * Resolve `providerId → [model ids]` from the Host LLM catalog.
   * The supplier is async (`listModels()` is a Promise) and is memoized for one
   * stats TTL: rebuilding it on every stats read would be pure overhead.
   */
  async function resolveProviderCatalog(now) {
    if (catalogMemo.at !== 0 && now - catalogMemo.at < ttlMs) return catalogMemo.value
    try {
      const value = await providerCatalog()
      const catalog = Object.create(null)
      if (value !== null && typeof value === 'object') {
        for (const [id, models] of Object.entries(value)) {
          if (typeof id === 'string' && Array.isArray(models)) {
            catalog[id] = models.filter((model) => typeof model === 'string' && model !== '')
          }
        }
      }
      catalogMemo = { at: now, value: catalog }
      return catalog
    } catch (error) {
      log.warn('could not read the provider model catalog: ' + String(error?.message ?? error))
      return catalogMemo.value
    }
  }

  /** Compose DSH + external harnesses into the wire stats (v3). */
  async function compose(dsh, catalog, now) {
    const thirtyStart = dsh.thirtyStart
    const today = emptyBucket()
    const last7Days = emptyBucket()
    const last30Days = emptyBucket()
    const allTime = emptyBucket()
    addBucket(today, dsh.today)
    addBucket(last7Days, dsh.last7Days)
    addBucket(last30Days, dsh.last30Days)
    addBucket(allTime, dsh.allTime)

    // Provider aggregation across harnesses (canonical provider ids).
    const workspaces = Array.isArray(dsh.workspaces) ? dsh.workspaces : []
    const providerMap = new Map()
    for (const provider of dsh.providers) {
      providerMap.set(provider.providerId, {
        providerId: provider.providerId,
        label: provider.label,
        today: cloneBucket(provider.today),
        last7Days: cloneBucket(provider.last7Days),
        last30Days: cloneBucket(provider.last30Days),
        fiveHours: cloneBucket(provider.fiveHours),
        allTime: cloneBucket(provider.allTime),
        harnesses: {
          dsh: {
            today: cloneBucket(provider.today),
            last7Days: cloneBucket(provider.last7Days),
            last30Days: cloneBucket(provider.last30Days),
            allTime: cloneBucket(provider.allTime),
          },
        },
      })
    }

    const harnesses = []
    const missingHarnesses = []
    if (dshEnabled) {
      harnesses.push({ harnessId: 'dsh', label: 'DSH', today: dsh.today, last7Days: dsh.last7Days, last30Days: dsh.last30Days, allTime: dsh.allTime })
    }
    const details = {}
    const scanDetails = {}
    const unmappedRows = []
    const externalFirstDays = new Map()

    for (const def of externalHarnessDefs()) {
      if (!def.enabled) continue
      const slice = externalSlice(now, def)
      const fold = foldExternal(def, slice, dsh, catalog)
      for (const [providerId, day] of fold.providerFirstDay ?? []) {
        const known = externalFirstDays.get(providerId)
        if (known === undefined || day < known) externalFirstDays.set(providerId, day)
      }
      if (slice.missing === true) missingHarnesses.push(def.id)
      if (slice.missing !== true || showUninstalled) {
        harnesses.push({
          harnessId: def.id,
          label: def.label,
          today: fold.buckets.today,
          last7Days: fold.buckets.last7Days,
          last30Days: fold.buckets.last30Days,
          allTime: fold.buckets.allTime,
          error: slice.error,
          missing: slice.missing === true,
        })
      }
      addBucket(today, fold.buckets.today)
      addBucket(last7Days, fold.buckets.last7Days)
      addBucket(last30Days, fold.buckets.last30Days)
      addBucket(allTime, fold.buckets.allTime)
      for (const [providerId, buckets] of fold.providers) {
        const existing = providerMap.get(providerId)
        if (existing === undefined) {
          providerMap.set(providerId, {
            providerId,
            label: providerLabel(providerId),
            today: cloneBucket(buckets.today),
            last7Days: cloneBucket(buckets.last7Days),
            last30Days: cloneBucket(buckets.last30Days),
            allTime: cloneBucket(buckets.allTime),
            harnesses: {
              [def.id]: {
                today: cloneBucket(buckets.today),
                last7Days: cloneBucket(buckets.last7Days),
                last30Days: cloneBucket(buckets.last30Days),
                allTime: cloneBucket(buckets.allTime),
              },
            },
          })
        } else {
          addBucket(existing.today, buckets.today)
          addBucket(existing.last7Days, buckets.last7Days)
          addBucket(existing.last30Days, buckets.last30Days)
          addBucket(existing.allTime, buckets.allTime)
          existing.harnesses[def.id] = {
            today: cloneBucket(buckets.today),
            last7Days: cloneBucket(buckets.last7Days),
            last30Days: cloneBucket(buckets.last30Days),
            allTime: cloneBucket(buckets.allTime),
          }
        }
      }
      const mappedProviders = [...fold.providers].map(([providerId, buckets]) => ({
        providerId,
        label: providerLabel(providerId),
        today: buckets.today,
        last7Days: buckets.last7Days,
        last30Days: buckets.last30Days,
        fiveHours: emptyBucket(),
        allTime: buckets.allTime,
      }))
      const unmapped = [...fold.unmapped.values()]
      details[def.id] = {
        dbPath: def.dbPath,
        available: slice.value !== null,
        error: slice.error,
        rows: slice.value?.rows ?? 0,
        cached: slice.cached,
        providerAliases: { ...def.aliases },
        mappedProviders,
        unmapped,
      }
      scanDetails[def.id] = {
        dbPath: def.dbPath,
        available: slice.value !== null,
        rows: slice.value?.rows ?? null,
        durationMs: slice.value?.durationMs ?? null,
        cached: slice.cached,
        error: slice.error,
      }
      for (const entry of unmapped) unmappedRows.push({ harnessId: def.id, harnessLabel: def.label, ...entry })
    }

    // Daily series (last 120 days) for the chart view.
    const dailyMap = new Map()
    for (const entry of dsh.daily ?? []) {
      const dayEntry = dailyMap.get(entry.day) ?? { total: emptyBucket(), providers: new Map() }
      addBucket(dayEntry.total, entry.total)
      for (const [providerId, totals] of Object.entries(entry.providers ?? {})) {
        const bucket = dayEntry.providers.get(providerId) ?? emptyBucket()
        addBucket(bucket, totals)
        dayEntry.providers.set(providerId, bucket)
      }
      dailyMap.set(entry.day, dayEntry)
    }
    for (const def of externalHarnessDefs()) {
      if (!def.enabled) continue
      const slice = externalSlice(now, def)
      if (slice.value === null) continue
      for (const group of slice.value.groups) {
        const mapped = mapHarnessProvider(group.providerId, group.modelId, def.aliases, catalog)
        if (mapped === null) continue
        const dayEntry = dailyMap.get(group.day) ?? { total: emptyBucket(), providers: new Map() }
        addBucket(dayEntry.total, group.bucket)
        const bucket = dayEntry.providers.get(mapped.providerId) ?? emptyBucket()
        addBucket(bucket, group.bucket)
        dayEntry.providers.set(mapped.providerId, bucket)
        dailyMap.set(group.day, dayEntry)
      }
    }
    const daily = [...dailyMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-120)
      .map(([day, entry]) => ({
        day,
        total: { total: entry.total.total, messages: entry.total.messages },
        providers: Object.fromEntries(
          [...entry.providers.entries()].map(([providerId, bucket]) => [
            providerId,
            { total: bucket.total, messages: bucket.messages },
          ]),
        ),
      }))

    // Earliest record per provider across every contributing harness. This is
    // the local "effective date" used for the 最近X天 provider window.
    const firstDays = new Map(externalFirstDays)
    for (const provider of dsh.providers) {
      if (typeof provider.firstDay !== 'string' || provider.firstDay === '') continue
      const known = firstDays.get(provider.providerId)
      if (known === undefined || provider.firstDay < known) firstDays.set(provider.providerId, provider.firstDay)
    }
    const todayDay = dsh.day
    const dayMs = 24 * 60 * 60 * 1000
    const dayCount = (from, to) => {
      const start = Date.parse(`${from}T00:00:00Z`)
      const end = Date.parse(`${to}T00:00:00Z`)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1
      return Math.max(1, Math.round((end - start) / dayMs) + 1)
    }
    const providers = [...providerMap.values()].sort((a, b) => b.allTime.total - a.allTime.total)
    for (const provider of providers) {
      const effectiveDay = firstDays.get(provider.providerId) ?? todayDay
      provider.effectiveDay = effectiveDay
      provider.effectiveDays = dayCount(effectiveDay, todayDay)
      // A provider has no records before its effective day, so the all-time
      // bucket is exactly the since-effective window.
      provider.sinceEffective = cloneBucket(provider.allTime)
      for (const harness of Object.values(provider.harnesses ?? {})) {
        harness.sinceEffective = cloneBucket(harness.allTime)
      }
    }
    return {
      version: 3,
      generatedAt: new Date(now).toISOString(),
      timezone: dsh.timezone,
      day: dsh.day,
      last30DaysStart: thirtyStart,
      today,
      last7Days,
      last30Days,
      allTime,
      workspaces,
      providers,
      harnesses,
      models: dsh.models,
      daily,
      zcode: details.zcode ?? null,
      opencode: details.opencode ?? null,
      workbuddy: details.workbuddy ?? null,
      qoder: details.qoder ?? null,
      unmapped: unmappedRows,
      missingHarnesses,
      scan: { ...dsh.scan, ...scanDetails },
    }
  }

  async function get(options = {}) {
    const now = Date.now()
    if (options.fresh !== true && isFresh(now)) return lastResult
    if (inflight !== null) return await inflight
    const work = (async () => {
      const dsh = dshEnabled ? aggregate(scan()) : emptyDshAggregate(Date.now())
      const catalog = await resolveProviderCatalog(Date.now())
      const result = await compose(dsh, catalog, Date.now())
      lastResult = result
      lastResultAt = Date.now()
      return result
    })()
    inflight = work
    try {
      return await work
    } finally {
      inflight = null
    }
  }

  return {
    get,
    /** Diagnostics without walking the filesystem. */
    diagnostics() {
      return {
        sessionsRoot,
        cacheFile,
        ttlMs,
        files: Object.keys(cache.files).length,
        lastScan,
        lastResultAt: lastResultAt === 0 ? null : new Date(lastResultAt).toISOString(),
        harnesses: {
          dsh: dshEnabled,
          zcode: { enabled: zcodeEnabled, dbPath: zcodeDbPath, cachedAt: zcodeMemo.at === 0 ? null : new Date(zcodeMemo.at).toISOString(), available: zcodeMemo.value !== null, error: zcodeMemo.error },
          opencode: { enabled: opencodeEnabled, dbPath: opencodeDbPath, cachedAt: opencodeMemo.at === 0 ? null : new Date(opencodeMemo.at).toISOString(), available: opencodeMemo.value !== null, error: opencodeMemo.error },
          workbuddy: { enabled: workbuddyEnabled, root: workbuddyRoot, cachedAt: workbuddyMemo.at === 0 ? null : new Date(workbuddyMemo.at).toISOString(), available: workbuddyMemo.value !== null, error: workbuddyMemo.error },
          qoder: { enabled: qoderEnabled, home: qoderHome, cachedAt: qoderMemo.at === 0 ? null : new Date(qoderMemo.at).toISOString(), available: qoderMemo.value !== null, error: qoderMemo.error },
        },
        providerCatalog: {
          resolvedAt: catalogMemo.at === 0 ? null : new Date(catalogMemo.at).toISOString(),
          providers: Object.fromEntries(
            Object.entries(catalogMemo.value).map(([id, models]) => [id, Array.isArray(models) ? models.length : 0]),
          ),
        },
      }
    },
  }
}

/** A `{ from: to }` provider-alias map from raw config. */
export function parseAliasMap(raw) {
  const aliases = Object.create(null)
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '') aliases[key] = value
    }
  }
  return aliases
}

/** The process timezone name, never throwing. */
function safeTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'
  } catch {
    return 'local'
  }
}
