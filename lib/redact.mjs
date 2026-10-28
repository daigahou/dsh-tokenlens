/**
 * Small privacy helpers for anything the plugin surfaces outside its own
 * in-memory state: status files, diagnostics, provider-management payloads and
 * error messages. They never touch the values used for real I/O.
 */
import { homedir } from 'node:os'

/** Replace the current user's home directory prefix with `~`. */
export function redactPath(value) {
  if (typeof value !== 'string' || value === '') return value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  let home = ''
  try {
    home = homedir()
  } catch {
    home = ''
  }
  if (home === '') return value
  const normalized = value.replace(/\\/g, '/')
  const normalizedHome = home.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedHome === '') return value
  const windows = process.platform === 'win32'
  const haystack = windows ? normalized.toLowerCase() : normalized
  const needle = windows ? normalizedHome.toLowerCase() : normalizedHome
  if (haystack === needle) return '~'
  if (!haystack.startsWith(`${needle}/`)) return value
  return `~/${normalized.slice(normalizedHome.length + 1)}`
}

/** Recursively redact home-directory prefixes in a JSON-ish value. */
export function redactPaths(value, depth = 0) {
  if (depth > 12) return value
  if (typeof value === 'string') return redactPath(value)
  if (Array.isArray(value)) return value.map((entry) => redactPaths(entry, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redactPaths(entry, depth + 1)
    return out
  }
  return value
}

/** Strip credentials, query string and fragment from an endpoint for display. */
export function redactEndpoint(value) {
  const raw = String(value ?? '')
  if (raw === '') return raw
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.replace(/[?#].*$/, '')
  }
}

/** Remove absolute-path like substrings from free-form error/status text. */
export function redactTextPaths(value) {
  if (typeof value !== 'string' || value === '') return value
  // Never touch URL strings: `dsh-app://…` must not be mistaken for `p:` path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  return value
    .replace(/[A-Za-z]:[\\/][^\s"'\u0000]+/g, '[path]')
    .replace(/(?:^|\s)(?:\/(?:home|Users|root|tmp|var|opt|mnt|private)\/[^\s"'\u0000]+)/g, ' [path]')
}
