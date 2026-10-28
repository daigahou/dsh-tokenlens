import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { redactEndpoint, redactPath, redactPaths } from '../lib/redact.mjs'

test('redactPath replaces only the current home prefix', () => {
  const home = homedir()
  if (home === '') return
  const inside = join(home, '.dsh', 'dsh-tokenlens', 'providers.json')
  assert.equal(redactPath(inside).startsWith('~/'), true)
  assert.equal(redactPath(inside).includes('.dsh/dsh-tokenlens/providers.json'), true)
  assert.equal(redactPath('/var/lib/tokenlens'), '/var/lib/tokenlens')
  assert.equal(redactPath('https://example.com/path?token=secret'), 'https://example.com/path?token=secret')
  assert.equal(redactPath(''), '')
})

test('redactPaths walks nested objects and arrays', () => {
  const home = homedir()
  if (home === '') return
  const redacted = redactPaths({
    path: join(home, '.zcode', 'cli', 'db.sqlite'),
    nested: [{ root: join(home, '.workbuddy', 'projects') }],
    label: 'not a path',
    count: 3,
  })
  assert.equal(redacted.path.startsWith('~/'), true)
  assert.equal(redacted.nested[0].root.startsWith('~/'), true)
  assert.equal(redacted.label, 'not a path')
  assert.equal(redacted.count, 3)
})

test('redactEndpoint strips credentials, query and fragment', () => {
  assert.equal(
    redactEndpoint('https://user:pass@example.com/v1/usage?api_key=sk-secret#frag'),
    'https://example.com/v1/usage',
  )
  assert.equal(redactEndpoint('https://example.com/v1/usage?token=abc'), 'https://example.com/v1/usage')
  assert.equal(redactEndpoint('not a url?token=abc'), 'not a url')
})
