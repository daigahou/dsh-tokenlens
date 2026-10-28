# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

Only the latest released 1.x version receives security fixes. Builds before 1.0.0 were
internal pre-release iterations and are not published anywhere.

## Privacy notes for reporters

The optional status file and the `diagnostics` bridge action replace the current user home
directory with `~` before exposing paths, and provider network errors redact URL credentials,
query strings and fragments. The provider-management payload keeps the raw `storeFile` for
local tooling but the UI renders `storeFileDisplay` (home-relative). Still redact tokens,
API keys and usage data manually before pasting logs into an issue.

## Reporting a vulnerability

Please do **not** open a public issue, discussion, or pull request for a security problem.

- Open a private report through GitHub Security Advisories:
  <https://github.com/daigahou/dsh-tokenlens/security/advisories/new>

Please include:

- the affected `dsh-TokenLens` version and DSH version,
- your operating system,
- a minimal reproduction (steps or a small script),
- the impact you expect (credential leak, data exposure, code execution, …),
- whether any API key, credential, or personal usage data may have been exposed.
  Redact secrets, tokens, and personal paths before sending.

What to expect:

- acknowledgement within 3 business days;
- an assessment and a fix/patch timeline after triage;
- a fix released as a **PATCH** version with a `CHANGELOG.md` entry and, when
  appropriate, a GitHub Security Advisory;
- credit for the reporter, unless you prefer to stay anonymous.

Please allow a reasonable disclosure window (typically 90 days, or a date we agree on)
before publishing details. We will coordinate the disclosure date with you.

## Security model

dsh-TokenLens is a local-first DSH plugin. It has zero runtime npm dependencies and does
not start a server, listener, or socket of its own.

### Credentials

- API keys are resolved per request by `lib/key-source.mjs` from, depending on
  configuration: the explicit plugin `apiKey` setting (discouraged), the DSH credential
  service, the process environment via `apiKeyRef` (for example `OPENCODE_GO_API_KEY`,
  `COMMANDCODE_API_KEY`, `DEEPSEEK_API_KEY`), `$DSH_HOME/.credentials.yaml`, or the
  OpenCode CLI `auth.json` for legacy OpenCode setups.
- A key is only used to sign a request to that provider's own usage/billing endpoint
  (defaults are listed in `lib/providers.mjs`, or the `baseURL` you explicitly set).
- Keys are **not** included in bridge payloads, snapshots, logs, diagnostics, status
  files, or the browser UI. The management page receives only `hasKey`, `keySource`, and
  `apiKeyRef` — a reference name, never the secret.
- Keys entered or overridden in the management page are stored locally in
  `$DSH_HOME/dsh-tokenlens/providers.json`. That file is written atomically
  (temp file + rename) and created with owner-only permissions (`chmod 0600`) on POSIX
  systems; on Windows it inherits the user profile ACL. Environment variables and the
  DSH credential service are preferred over storing keys in a config file.

### Network behavior

The plugin only connects to:

1. the DSH local web server — the browser half talks to `POST /api/tokenlens`; and
2. the usage/billing APIs of the providers **you** have configured, over HTTPS, at the
   default `baseURL` from `lib/providers.mjs` (or a base URL you explicitly override).

There is no telemetry, analytics, crash reporting, remote configuration, advertising, or
auto-update channel, and no third-party proxy or relay. A disabled provider is never
contacted.

### Local data is read-only

To compute local token statistics the plugin reads — and only reads:

- DSH session logs under `$DSH_HOME/sessions/*.jsonl.zstd`, decoded in memory; only token
  counters and timestamps are extracted, message content is neither stored nor sent
  anywhere;
- the ZCode and OpenCode CLI SQLite databases, opened with `readOnly: true`;
- WorkBuddy/CodeBuddy and Qoder CN JSONL transcripts, read line by line.

Other applications' data is never modified, written back, or deleted. A missing, locked,
or corrupt store degrades to an "unavailable" row instead of failing the plugin.

### Local bridge

The only browser-facing route (`/api/tokenlens`) is registered inside DSH's own `/api`
connection route (`@deepseek-ai/dsh-client-connection`), which applies the DSH
Host/Origin fence and browser authentication before dispatching to the plugin. The plugin
never opens its own port or listens on the network.

### Files written

- `$DSH_HOME/dsh-tokenlens/providers.json` — management-page overrides (owner-only
  permissions as described above);
- `$DSH_HOME/dsh-tokenlens/usage-cache.json` — local cache of computed statistics
  per-session-file keys and token counters (no prompt/message content; file mode 0600 on POSIX);
- an optional diagnostics JSON at the path you configure via `statusFile` (disabled by
  default; a development aid).

Nothing is written outside those paths.

### Supply chain

- Zero runtime dependencies; there is no `postinstall` or other install-time script.
- Releases are published from GitHub Actions with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so the
  published tarball can be traced to this repository and the tagged commit. Verify with
  `npm audit signatures` after installing.

## Scope

In scope:

- leaking credentials or personal usage data through logs, diagnostics, bridge payloads,
  error messages, or the UI;
- XSS / HTML injection through provider-controlled strings rendered by the client, or
  through custom provider definitions;
- path traversal or symlink attacks in file paths derived from configuration;
- privilege escalation through the local bridge endpoints;
- any code path that writes to or deletes harness data.

Out of scope:

- vulnerabilities in DSH itself, in the providers' usage endpoints, or in your
  browser/operating system;
- the risk of deliberately storing an API key in plaintext config (documented and
  discouraged);
- denial of service against a single-user local installation by its own user;
- the fact that provider plan/usage endpoints are undocumented and may change or
  misreport data — a known limitation, see the README.

## Known limitations (not vulnerabilities)

Provider plan/usage endpoints are generally undocumented internal APIs. The plugin parses
their responses defensively and degrades gracefully: a failing provider view does not take
down the rest of the plugin, and no usage data is ever fabricated. Upstream interface or
rate-limit changes may break one provider's view until its adapter is updated.

## Release integrity

Each `v*` tag is published by `.github/workflows/release.yml` only after `node --test`
passes and the tag is verified to match `package.json#version`. Security fixes are shipped
as new PATCH releases; no version is ever re-published.
