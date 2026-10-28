/**
 * Where the OpenCode Go API key comes from.
 *
 * Resolution order — the first source with a non-empty value wins:
 *
 *   1. `config.apiKey`                  (explicit plugin config; discouraged)
 *   2. `ctx.credentials`                (the credential store the composition
 *                                        uses: `~/.dsh/.credentials.yaml` refs,
 *                                        then the launch environment)
 *   3. the process environment          (`OPENCODE_GO_API_KEY`)
 *   4. `$DSH_HOME/.credentials.yaml`    (direct read when no credential service
 *                                        is composed; same document as 2)
 *   5. the OpenCode CLI auth file       (`auth.json` written by `opencode /connect`,
 *                                        tried in its known per-platform locations)
 *
 * The value never leaves this module except as the resolved secret handed to
 * the HTTP request; every other public shape carries `source` and a short
 * `detail` only.
 */
import { readFile as readFileDefault } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default credential reference the DSH provider profile also names. */
export const DEFAULT_KEY_REF = 'OPENCODE_GO_API_KEY'

/** Candidate keys inside an OpenCode CLI `auth.json`, best first. */
const OPENCODE_AUTH_KEYS = ['opencode-go', 'opencode', 'opencode-zen', 'opencode_api']

/** Non-throwing default reader: a missing/unreadable file is simply absent. */
async function tryRead(path, readFile) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Parse the `refs:` mapping out of a `$DSH_HOME/.credentials.yaml` document.
 *
 * Only that one mapping is needed, so this is a deliberately small YAML reader:
 * top-level `refs:` followed by `NAME: value` lines indented under it. Quoted
 * values lose their quotes; a `#` comment after an unquoted value is dropped.
 *
 * @returns `{ [name]: value }` — never throws.
 */
export function parseCredentialRefs(text) {
  const refs = {}
  if (typeof text !== 'string' || text === '') return refs
  let inRefs = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!line.startsWith(' ') && !line.startsWith('-')) {
      // A new top-level key ends the refs mapping.
      inRefs = /^refs\s*:\s*(?:#.*)?$/.test(trimmed)
      continue
    }
    if (!inRefs) continue
    const match = /^-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed) ??
      /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed)
    if (match === null) continue
    const [, name, rest] = match
    refs[name] = parseScalar(rest)
  }
  return refs
}

/** Read one YAML scalar (quoted or plain) from the right-hand side of a mapping line. */
function parseScalar(rest) {
  const value = rest.trim()
  if (value === '' || value === '~' || value === 'null') return ''
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    return end === -1 ? value.slice(1) : value.slice(1, end)
  }
  const comment = value.search(/\s#/)
  return (comment === -1 ? value : value.slice(0, comment)).trim()
}

/**
 * Pick the OpenCode API key out of a CLI `auth.json` document.
 *
 * The file is `{ "<provider-id>": { "type": "api", "key": "oc_sk_…" }, … }`;
 * OAuth entries carry no API key and are ignored.
 *
 * @returns the key, or `undefined` when the document holds none.
 */
export function parseOpencodeAuth(text) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const entries = Object.entries(document)
  const apiKeyOf = (entry) =>
    entry !== null && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim() !== ''
      ? entry.key.trim()
      : undefined
  for (const name of OPENCODE_AUTH_KEYS) {
    const key = apiKeyOf(document[name])
    if (key !== undefined) return key
  }
  for (const [, entry] of entries) {
    const key = apiKeyOf(entry)
    if (key !== undefined && key.startsWith('oc_sk_')) return key
  }
  // Deliberately no "any provider's key" fallback: auth.json may also hold
  // Anthropic/OpenAI credentials, and sending those as a Bearer token to the
  // OpenCode endpoint would leak them to a third party.
  return undefined
}

/**
 * The OpenCode CLI auth file locations to try, most likely first.
 * OpenCode resolves its data directory through `xdg` on every platform, so
 * Windows usually holds `%LOCALAPPDATA%\\opencode\\auth.json`, but the XDG
 * location is also possible on Unix-like setups.
 */
export function opencodeAuthCandidates(input = {}) {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const platform = input.platform ?? process.platform
  const candidates = []
  if (platform === 'win32') {
    if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '') {
      candidates.push(join(env.LOCALAPPDATA, 'opencode', 'auth.json'))
    }
    if (typeof env.APPDATA === 'string' && env.APPDATA !== '') {
      candidates.push(join(env.APPDATA, 'opencode', 'auth.json'))
    }
  } else {
    if (typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME !== '') {
      candidates.push(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'))
    }
    candidates.push(join(home, '.local', 'share', 'opencode', 'auth.json'))
    if (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '') {
      candidates.push(join(env.XDG_CONFIG_HOME, 'opencode', 'auth.json'))
    }
    candidates.push(join(home, '.config', 'opencode', 'auth.json'))
  }
  candidates.push(join(home, '.opencode', 'auth.json'))
  return candidates
}

/** Map a credential-service `source` onto the wire vocabulary. */
function wireSource(source) {
  if (source === 'env') return 'env'
  if (source === 'file') return 'credentials'
  return 'credentials'
}

/** The DSH home directory (`$DSH_HOME`, else `~/.dsh`). */
export function dshHomeOf(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(home, '.dsh')
}

/**
 * Resolve the API key. Never throws: an unusable credential store or file is
 * just a source that did not answer.
 *
 * @param input.config - normalized plugin config (`apiKey`, `apiKeyRef`).
 * @param input.credentials - `ctx.credentials` when composed.
 * @param input.env - environment (test seam).
 * @param input.home - user home (test seam).
 * @param input.platform - `process.platform` (test seam).
 * @param input.readFile - file reader (test seam).
 * @returns `{ value, source, detail, ref }` where `value` is `undefined` when absent.
 */
export async function resolveApiKey(input) {
  const config = input.config ?? {}
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const platform = input.platform ?? process.platform
  const readFile = input.readFile ?? readFileDefault
  const ref = typeof config.apiKeyRef === 'string' && config.apiKeyRef.trim() !== ''
    ? config.apiKeyRef.trim()
    : DEFAULT_KEY_REF

  const literal = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (literal !== '') return { value: literal, source: 'config', detail: 'plugin config', ref }

  if (input.credentials !== undefined && typeof input.credentials.resolve === 'function') {
    try {
      const hit = await input.credentials.resolve(ref)
      if (hit !== null && typeof hit === 'object' && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return {
          value: hit.value.trim(),
          source: wireSource(hit.source),
          detail: typeof hit.source === 'string' ? hit.source : 'credentials',
          ref,
        }
      }
    } catch {
      /* an unusable store is a miss, not a failure of this plugin */
    }
  }

  const fromEnv = env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: 'env', detail: 'process environment', ref }
  }

  const dshHome = dshHomeOf(env, home)
  const credentialsPath = join(dshHome, '.credentials.yaml')
  const credentialsText = await tryRead(credentialsPath, readFile)
  if (credentialsText !== undefined) {
    const refs = parseCredentialRefs(credentialsText)
    const stored = refs[ref]
    if (typeof stored === 'string' && stored.trim() !== '') {
      return { value: stored.trim(), source: 'credentials', detail: '.credentials.yaml (direct)', ref }
    }
  }

  // The CLI auth file is an OpenCode credential: only it can stand in for the
  // default reference. A plugin configured with some other reference must not
  // silently borrow the user's OpenCode CLI login.
  if (ref === DEFAULT_KEY_REF) {
    for (const candidate of opencodeAuthCandidates({ env, home, platform })) {
      const text = await tryRead(candidate, readFile)
      if (text === undefined) continue
      const key = parseOpencodeAuth(text)
      if (key !== undefined) {
        return { value: key, source: 'file', detail: 'opencode auth.json', ref }
      }
    }
  }

  return { value: undefined, source: 'none', detail: 'no OpenCode Go credential found', ref }
}
