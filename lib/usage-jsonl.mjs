/**
 * Claude-Code-style JSONL harness adapters: WorkBuddy/CodeBuddy CLI and Qoder CN CLI.
 *
 * Both harnesses persist per-session JSONL transcripts; only token counters,
 * model ids and timestamps are read (never message content). Verified on this
 * machine against the live stores:
 *
 * WorkBuddy (`~/.workbuddy/projects/<cwd>/<session>.jsonl`)
 *   Records carrying a model response expose `providerData.rawUsage`:
 *     prompt_tokens            input INCLUDING cached prompt tokens
 *     completion_tokens        output INCLUDING reasoning tokens
 *     total_tokens             == prompt_tokens + completion_tokens
 *     prompt_cache_hit_tokens  cached prompt tokens
 *     cache_creation_input_tokens
 *   `providerData.model` is the model id; `timestamp` is epoch ms.
 *   No vendor/provider id is stored → groups carry providerId `workbuddy`.
 *
 * Qoder CN (`~/.qoder-cn/projects/<cwd>/<session>.jsonl`)
 *   `type:"assistant"` records carry `message.usage`:
 *     input_tokens             input INCLUDING cached prompt tokens
 *     output_tokens, cache_read_input_tokens, cache_creation_input_tokens
 *     (built-in Qoder models report all-zero tokens + only `credits` → skipped)
 *   `message.id` identifies one API response (deduped); `timestamp` is ISO-8601
 *   UTC. Custom providers are user-configured in `~/.qoder-cn/settings.json`
 *   under `providers[<uuid>] = { baseUrl }`, and their model ids look like
 *   `qoder-custom-<uuid>/<vendor>/<model>`; the base-URL host is mapped to a
 *   canonical DSH provider when it is recognizable (commandcode.ai → commandcode,
 *   opencode.ai → opencode-go, api.deepseek.com → deepseek), else to the host.
 *
 * Buckets are normalized to the plugin convention: input excludes cache,
 * output includes reasoning, total includes cache.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { localDayKey } from './usage-zcode.mjs'

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** Epoch-ms or ISO timestamp → epoch ms (0 when unparseable). */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Recursively list `.jsonl` files under a directory (missing dir → []). */
export function listJsonlFiles(root) {
  const files = []
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
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(root)
  return files
}

/** A cheap cache signature for a JSONL directory tree (paths + mtime/size). */
export function jsonlTreeSignature(root) {
  return listJsonlFiles(root)
    .map((file) => {
      try {
        const stat = statSync(file)
        return `${file}:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `${file}:?`
      }
    })
    .join('|')
}

/** Merge one row into a day/provider/model group map. */
function addGroup(groups, { day, providerId, modelId, input, output, cacheRead, cacheWrite, total }) {
  const key = `${day}\u0000${providerId}\u0000${modelId}`
  const group = groups.get(key) ?? {
    day,
    providerId,
    modelId,
    bucket: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 },
  }
  group.bucket.input += Math.max(0, input)
  group.bucket.output += Math.max(0, output)
  group.bucket.cacheRead += Math.max(0, cacheRead)
  group.bucket.cacheWrite += Math.max(0, cacheWrite)
  group.bucket.total += Math.max(0, total)
  group.bucket.messages += 1
  groups.set(key, group)
}

/** Walk every JSONL file, calling `visit(record, file)` for each parsed JSON object. */
function forEachRecord(files, visit) {
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      visit(record, file)
    }
  }
}

/** Default `~/.workbuddy/projects` (or `$WORKBUDDY_HOME/projects`). */
export function defaultWorkbuddyRoot(env = process.env, home = homedir()) {
  const override = typeof env.WORKBUDDY_HOME === 'string' && env.WORKBUDDY_HOME.trim() !== ''
  return override ? join(env.WORKBUDDY_HOME.trim(), 'projects') : join(home, '.workbuddy', 'projects')
}

/**
 * Read WorkBuddy/CodeBuddy CLI usage groups.
 * @returns `{harness, label, root, groups, rows, requests, durationMs}`.
 */
export function readWorkbuddyUsage(input = {}) {
  const root = typeof input.root === 'string' && input.root !== '' ? input.root : defaultWorkbuddyRoot()
  const started = Date.now()
  const files = listJsonlFiles(root)
  const groups = new Map()
  const seen = new Set()
  let requests = 0
  let skippedZero = 0
  forEachRecord(files, (obj) => {
    const providerData = obj?.providerData
    const raw = providerData?.rawUsage
    if (raw === null || typeof raw !== 'object') return
    const time = toEpochMs(obj.timestamp)
    if (time === 0) return
    const dedupeKey = `${providerData.conversationRequestId ?? obj.id ?? ''}|${providerData.messageId ?? ''}|${providerData.stepSeq ?? ''}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    const prompt = num(raw.prompt_tokens)
    const completion = num(raw.completion_tokens)
    const cacheRead = num(raw.prompt_cache_hit_tokens) || num(raw.prompt_tokens_details?.cached_tokens)
    const total = num(raw.total_tokens) || prompt + completion
    if (total === 0) {
      skippedZero += 1
      return
    }
    requests += 1
    const model = String(providerData.model ?? providerData.requestModelId ?? 'unknown')
    addGroup(groups, {
      day: localDayKey(time),
      providerId: 'workbuddy',
      modelId: model,
      // prompt_tokens includes the cached prefix.
      input: prompt - cacheRead,
      output: completion,
      cacheRead,
      cacheWrite: num(raw.cache_creation_input_tokens),
      total,
    })
  })
  const list = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))
  return { harness: 'workbuddy', label: 'WorkBuddy', root, groups: list, rows: list.length, requests, skippedZero, durationMs: Date.now() - started }
}

/** Default `~/.qoder-cn` (or `$QODER_HOME`). */
export function defaultQoderHome(env = process.env, home = homedir()) {
  return typeof env.QODER_HOME === 'string' && env.QODER_HOME.trim() !== ''
    ? env.QODER_HOME.trim()
    : join(home, '.qoder-cn')
}

/** Map a configured provider base URL host onto a canonical DSH provider id. */
export function providerForBaseUrl(baseUrl) {
  let host = ''
  try {
    host = new URL(String(baseUrl)).host.toLowerCase()
  } catch {
    return null
  }
  if (host === 'api.commandcode.ai') return 'commandcode'
  if (host === 'opencode.ai' || host === 'api.opencode.ai') return 'opencode-go'
  if (host === 'api.deepseek.com') return 'deepseek'
  return host
}

/** `providers[<uuid>] = { baseUrl }` from Qoder's settings.json (keys never read). */
function readQoderProviders(settingsPath) {
  const providers = new Map()
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    for (const [key, provider] of Object.entries(settings?.providers ?? {})) {
      const providerId = providerForBaseUrl(provider?.baseUrl) ?? `qoder:${key}`
      providers.set(key, providerId)
      // Qoder model ids reference the provider as `qoder-custom-<uuid>/...`: the
      // settings key may be either the bare uuid or the `qoder-custom-<uuid>` form.
      const bare = key.replace(/^qoder-custom-/, '')
      providers.set(bare, providerId)
      providers.set(`qoder-custom-${bare}`, providerId)
    }
  } catch {
    /* settings are optional: fall back to qoder:<uuid> ids */
  }
  return providers
}

/**
 * Read Qoder CN usage groups.
 * @returns `{harness, label, root, groups, rows, requests, durationMs}`.
 */
export function readQoderUsage(input = {}) {
  const home = typeof input.home === 'string' && input.home !== '' ? input.home : defaultQoderHome()
  const root = join(home, 'projects')
  const settingsPath = join(home, 'settings.json')
  const started = Date.now()
  const files = listJsonlFiles(root)
  const providers = readQoderProviders(settingsPath)
  const groups = new Map()
  const seen = new Set()
  let requests = 0
  forEachRecord(files, (obj, file) => {
    if (obj?.type !== 'assistant') return
    const message = obj.message
    const usage = message?.usage
    if (usage === null || typeof usage !== 'object') return
    const inputTokens = num(usage.input_tokens)
    const outputTokens = num(usage.output_tokens)
    const cacheRead = num(usage.cache_read_input_tokens)
    const cacheWrite = num(usage.cache_creation_input_tokens)
    const total = inputTokens + outputTokens
    if (total <= 0) return
    const messageId = typeof message.id === 'string' && message.id !== '' ? message.id : `${file}:${obj.timestamp ?? ''}`
    if (seen.has(messageId)) return
    seen.add(messageId)
    const time = toEpochMs(obj.timestamp)
    if (time === 0) return
    requests += 1
    const rawModel = String(message.model ?? 'unknown')
    const custom = /^qoder-custom-([^/]+)\//.exec(rawModel)
    const providerId = custom !== null ? providers.get(custom[1]) ?? `qoder:${custom[1]}` : rawModel
    const modelId = custom !== null ? rawModel : rawModel
    addGroup(groups, {
      day: localDayKey(time),
      providerId,
      modelId,
      // Qoder's input_tokens include the cached prompt.
      input: inputTokens - cacheRead,
      output: outputTokens,
      cacheRead,
      cacheWrite,
      total,
    })
  })
  const list = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day))
  return { harness: 'qoder', label: 'Qoder', root, groups: list, rows: list.length, requests, durationMs: Date.now() - started }
}
