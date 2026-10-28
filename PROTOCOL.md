# Plan usage plugin — Host ↔ Client protocol (v3, capacity vs local usage)

This file is the frozen contract between the Host half (`index.js` + `lib/`) and the
Client half (`client.js`). Both halves must agree on it; change it in one commit.

v3 adds: provider-native capacity amounts on windows (`used`/`cap`/`unit`), the
`version` field in the `hello` envelope, and the dialog split into
「套餐容量」(server-side) vs 「本机 Token 用量」(DSH session logs).

## Package

- name: `dsh-tokenlens`
- Host entry: `index.js` (cordis plugin, `apply(ctx, config)`)
- Client entry: `client.js` (browser module, `window.__ModuleLoader__.load`)
- Locale namespace: `dsh-tokenlens`

## Bridge route

The Client calls a Host-side Connection Fetch route (same mechanism as
`dsh-session-rollback`):

```
POST /api/tokenlens
Content-Type: application/json
```

The client uses a **document-relative** URL: `fetch('api/tokenlens', …)`
(never a hard-coded `http://127.0.0.1:<port>`; the desktop shell serves the page
from `dsh-app://app/` and forwards non-asset paths to the Host).

### Request

```jsonc
{
  "action": "snapshot" | "refresh" | "hello" | "stats" | "diagnostics",
  "providerId": "opencode-go",   // optional; defaults to the active provider
  "fresh": false,                 // stats only: bypass the scan TTL
  "origin": "dsh-app://app",      // hello only, optional
  "primitives": 290,              // hello only, optional (seeded primitives count)
  "locale": "zh-CN"               // hello only, optional
}
```

- `snapshot` — cached usage for `providerId`, refreshed when older than the TTL.
- `refresh` — force a fresh upstream read for `providerId`.
- `hello` — client announces itself (and its current provider); Host records it and
  answers with a snapshot so the first paint needs one round trip.
- `stats` — today/all-time token statistics folded from the local session logs.
- `diagnostics` — config/cache/error state (verification aid, no secrets).
- Unknown action → HTTP 400 `{ "ok": false, "error": { "code": "unknown-action", … } }`.

### Response envelope

```jsonc
{ "ok": true,  "snapshot": <Snapshot> }            // snapshot / refresh / hello
{ "ok": true,  "stats": <Stats> }                  // stats
{ "ok": false, "error": <Error>, "snapshot": <Snapshot|null> }
```

`hello` answers `{ ok: true, plugin, version, bridge, pid, …snapshotResult }`.

## Snapshot (wire shape, v3)

```jsonc
{
  "ok": true,
  "version": 3,
  "provider": { "id": "opencode-go", "label": "OpenCode", "kind": "windows" },
  "plan": { "id": "individual-go-v1", "label": "Go" } | null,
  "windows": {                               // canonical ids, display order
    "rolling": { "id": "rolling", "percent": 8, "status": "ok",
                 "resetsAt": "2026-10-25T11:31:25.000Z", "remainingMs": 123456,
                 "used": 0.5, "cap": 2.5, "unit": "USD" } | null,
    "weekly":  { … } | null,
    "monthly": { … } | null
  } | null,                                  // null for balance-only providers
  "balance": { "amount": 2.26, "currency": "CNY", "granted": 0, "toppedUp": 2.26 } | null,
  "credits": { "remaining": 4.5, "granted": 10, "purchased": 0 } | null,
  "account": { "name": "…", "userName": "…" } | null,   // non-secret display info
  "links": { "console": "https://opencode.ai/console" } | null,  // provider-owned web page, follows the selection
  "fetchedAt": "2026-10-25T09:03:00.000Z",
  "ageMs": 1200,
  "stale": false,
  "latencyMs": 87,
  "source": "api" | "cache" | "stale-cache",
  "key": { "ref": "OPENCODE_GO_API_KEY", "source": "credentials", "detail": "file" }
}
```

Provider semantics:

| provider id | kind | windows | extra |
|---|---|---|---|
| `opencode-go` | `windows` | rolling/weekly/monthly percentages | — |
| `commandcode` | `windows` | rolling = 5-hour `used/cap`, weekly = `used/cap`, monthly = `(granted - remaining)/granted` (only when the API reports the grant) | `plan`, `credits` (USD), `account` |
| `deepseek` (picker id `deepseek-official`) | `balance` | `null` | `balance` (API-key account balance, CNY/USD) |
| `deepseek-account` | `balance` | `null` | `balance` from the composed Platform account service (signed-in wallets) |

`balance` is `{ amount, currency }` plus, for the account provider,
`wallets: [{currency, amount}]` and `bonus: [{currency, amount}]`.

Rules:

- `percent` is clamped to `0..100`; an unknown percentage is `null` (render "—"), never a fake 0.
- `status` is the upstream status string; anything not `"ok"` is rendered as a warning.
- Times are ISO-8601 UTC strings; `remainingMs` is computed by the Host.
- `source` is `api` (fresh), `cache` (TTL hit, `latencyMs: null`) or `stale-cache`
  (refresh failed, `stale: true`, paired with an error envelope).
- The model picker emits `deepseek-official` / `deepseek-account`, never a bare
  `deepseek`: the Host aliases `deepseek-official` onto the `deepseek` adapter.
  A provider without an adapter answers `unsupported-provider`.
- **Plan capacity vs local usage (v3 split):** the snapshot above is the
  server-side **plan capacity** (provider-native units). `used` / `cap` / `unit`
  appear only for providers that report their allowance in a native unit
  (Command Code: USD); OpenCode reports percentages only; balance providers
  report `balance`. The dialog must label this section as coming from the
  provider API. Local token totals come from the separate `stats` action and must
  be labeled as DSH session records, never as the plan allowance.

## Stats (wire shape, v3)

Token statistics are **provider-scoped across all local harnesses** and reported
in three windows: **今日** (`today`), **最近 30 天** (`last30Days`, rolling 30
calendar days including today) and **总计** (`allTime`). `harnesses[]` is an
extensible list (currently DSH, ZCode, OpenCode CLI; more adapters can be added
without a wire change), and a harness's own provider ids are mapped onto the
canonical DSH provider ids so that, e.g., ZCode usage on `opencode-go-chat`
counts toward the `opencode-go` provider selected in DSH.

v3 additionally carries the rolling **最近 7 天** window (`last7Days`), the
provider effective-date fallback (`effectiveDay`, `effectiveDays`,
`sinceEffective`), per-workspace totals (`workspaces[]`: `workspaceId`, `label`,
`total`, `messages`, `today`/`last7Days`/`last30Days`; local `cwd`/`path` are
Host-only and never sent on the wire), the rolling 5-hour local window
(`fiveHours`, DSH-only because external harnesses are day-granular), and the
bounded `daily[]` series used by the chart view. Absolute local paths are
stripped from the wire; free-form error messages have path substrings replaced
with `[path]`.

```jsonc
{
  "ok": true,
  "stats": {
    "version": 3,
    "generatedAt": "2026-10-25T13:20:00.000Z",
    "timezone": "Asia/Shanghai",
    "day": "2026-10-25",                       // the local day "today" means here
    "last30DaysStart": "2026-09-26",           // rolling window start (inclusive)
    "today":      { …bucket… },                // all harnesses, all providers
    "last30Days": { …bucket… },
    "allTime":    { …bucket… },
    "harnesses": [                              // extensible: any adapter may appear
      { "harnessId": "dsh",   "label": "DSH",
        "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } },
      { "harnessId": "zcode", "label": "ZCode",
        "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… },
        "error": null },                        // `{code:"stats-unavailable",…}` when the DB is unusable
      { "harnessId": "opencode", "label": "OpenCode",
        "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… },
        "error": null },                        // same degradation contract
      { "harnessId": "workbuddy", "label": "WorkBuddy", "today": … },
      { "harnessId": "qoder", "label": "Qoder", "today": … }
    ],
    "missingHarnesses": [],                     // uninstalled harness ids (hidden from harnesses[] by default)
    "providers": [                              // canonical provider id, ALL harnesses
      { "providerId": "opencode-go", "label": "OpenCode",
        "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… },
        "harnesses": {                          // per-harness split for this provider (arbitrary keys)
          "dsh":   { "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } },
          "zcode": { "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } },
          "opencode": { "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } }
        } }
    ],
    "models": [                                 // DSH-only top 12 by all-time total
      { "key": "opencode-go/deepseek-v4.1-flash", "providerId": "opencode-go",
        "modelId": "deepseek-v4.1-flash",
        "today": { "total": …, "messages": … },
        "last30Days": { "total": …, "messages": … },
        "allTime": { "total": …, "messages": … } }
    ],
    "zcode": {                                  // extra-harness detail
      "dbPath": "C:\\Users\\…\\.zcode\\cli\\db\\db.sqlite",
      "available": true, "error": null, "rows": 65, "cached": false,
      "providerAliases": { "opencode-go-chat": "opencode-go" },
      "mappedProviders": [                      // ZCode usage that reached a canonical provider
        { "providerId": "opencode-go", "label": "OpenCode",
          "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } }
      ],
      "unmapped": [                             // ZCode providers with no DSH counterpart
        { "providerId": "account:bigmodel-start-plan", "label": "BigModel Start Plan",
          "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } }
      ]
    },
    "opencode": {                               // same detail node shape as zcode
      "dbPath": "C:\\Users\\…\\.local\\share\\opencode\\opencode.db",
      "available": true, "error": null, "rows": 2, "cached": false,
      "providerAliases": {}, "mappedProviders": [ … ], "unmapped": [ … ]
    },
    "workbuddy": { "root": "C:\\Users\\…\\.workbuddy\\projects", "available": true, "rows": 29, "unmapped": [ … ] },
    "qoder": { "dbPath": "C:\\Users\\…\\.qoder-cn", "available": true, "rows": 3, "unmapped": [ … ] },
    "missingHarnesses": ["zcode"],               // enabled harnesses whose local store is gone
    "unmapped": [                               // combined, across every harness
      { "harnessId": "opencode", "harnessLabel": "OpenCode",
        "providerId": "opencode", "label": "opencode",
        "today": { …bucket… }, "last30Days": { …bucket… }, "allTime": { …bucket… } }
    ],
    "scan": { …DSH scan metadata…,
              "zcode": { "dbPath": "…", "available": true, "rows": 65,
                         "durationMs": 30, "cached": false, "error": null },
              "opencode": { "dbPath": "…", "available": true, "rows": 2,
                            "durationMs": 20, "cached": false, "error": null },
              "workbuddy": { "dbPath": "…", "available": true, "rows": 29,
                             "durationMs": 690, "cached": false, "error": null },
              "qoder": { "dbPath": "…", "available": true, "rows": 3,
                         "durationMs": 6500, "cached": false, "error": null } }
  }
}
```

- Buckets always have all six counters (`input`, `output`, `cacheRead`,
  `cacheWrite`, `total`, `messages`). DSH `input` excludes cache reads; ZCode's
  `input_tokens` include them, so the adapter normalizes
  `input = input_tokens - cache_read_input_tokens`; OpenCode CLI's
  `total = input + output + reasoning + cache.read`, so its adapter normalizes
  `output = output + reasoning` (DSH-style) and keeps `input` exclusive of cache.
  Both external harnesses' `total` includes cache.
- **Provider mapping (per harness):** that harness's `providerAliases` config is
  tried first; then an exact provider id; then a unique model-catalog match for
  vendor-namespaced model ids (the model id appears in exactly one DSH provider's
  installed model list). Unmapped providers stay out of `providers[]`, appear in
  the harness detail + the combined `unmapped` array, and only contribute to the
  all-harness buckets.
- A **missing** external harness store (uninstalled / deleted) is hidden from
  `harnesses[]` by default and listed in `missingHarnesses`: no permanent zero
  row. `stats.showUninstalled: true` (alias `showMissingHarnesses`) keeps the row
  with a non-retryable `harness-missing` error. A store that **exists** but cannot
  be read keeps an error row, so temporary locks remain actionable. In every case
  the other harnesses stay correct.
- The DSH scan is incremental (per session file `{mtimeMs,size}` cache) and
  on-demand; `fresh: true` forces a filesystem re-check, otherwise a
  `stats.ttlMs` cache is served. The ZCode query is memoized by the database/WAL
  generation.
- A forked session's **inherited prefix** (up to its last
  `session/end-seed {inherited:true}`) is excluded; its own events are real spend.
  Subagent sessions are included; zero-token retries are not counted.
- ZCode rows with `computed_total_tokens = 0` are excluded; day = local day of
  `completed_at`; `readOnly` database, counters only (no prompt/message content).
- A missing/unreadable ZCode database is **not** fatal: the ZCode harness row gets
  an `error`, DSH totals stay correct, and `providers[]` still carries DSH usage.
- Client tabs: default 「当前供应商 · 全部 Harness」 (cards = the matching
  `providers[]` row, i.e. the selected provider's tokens across every harness)
  and 「全部 Harness」 (cards = the top-level buckets); cards show 今日 / 最近30天 /
  总计. 「按 Harness」 iterates `stats.harnesses[]` in host order and renders each
  harness `label` (extensible list, not only DSH/ZCode); in the provider scope only
  harnesses whose `provider.harnesses[harness].last30Days.total > 0` are listed (a harness
  with no 30-day usage for that provider is omitted; an all-empty breakdown shows a hint);
  hidden/uninstalled harnesses are explained by a muted footnote from `stats.missingHarnesses`. The DSH provider
  breakdown and top models are labeled DSH-only.
- An unavailable/disabled statistics service answers
  `{ ok: false, error: { code: "stats-unavailable" } }`.

## Error shape

```jsonc
{
  "code": "missing-key" | "unsupported-provider" | "unauthorized" | "forbidden" |
          "network" | "timeout" | "http" | "parse" | "disabled" | "rate-limited" |
          "unknown-action" | "stats-unavailable" | "internal",
  "message": "human readable, English, no secrets",
  "status": 401,          // upstream HTTP status when applicable
  "retryable": true
}
```

Client behaviour:

- `missing-key`, `unsupported-provider`, `disabled` → hide the chip (silent).
- everything else → show the chip in a warning state with a retry action.

## Provider selection (client side)

The browser half learns the provider the user selected from the session projection
`modelSelection` (available to session-scoped slot entries as the `useProjection`
prop):

```js
const model = useProjection('modelSelection')
const selection = model?.next ?? model?.lastUsed   // { provider, model, reasoningEffort? }
const providerId = selection?.provider             // e.g. "opencode-go"
```

Send that `providerId` with every bridge call and re-request when it changes. The
Host returns the provider display label in `snapshot.provider.label`; the client
needs no provider catalog of its own.

## Provider management (v0.9.0, browser bridge)

The dialog 「供应商管理」 page talks to three additional actions:

- `{action:"providers"}` → `{ok:true, providers:[{providerId,label,shortLabel,kind,enabled,hasKey,keySource,apiKeyRef,baseURL,consoleUrl,builtin,dshManaged,dshProviderId}], dshProviders:[{providerId,label,supported,usageProviderId}], settings:{labelStyle:"short"|"full"}, storeFile, storeFileDisplay}`. `storeFile` is the real path (local tooling); `storeFileDisplay` replaces the user's home directory with `~` and is what the management page renders.
- `{action:"providerUpdate", providerId, update:{enabled?,apiKey?,apiKeyRef?,baseURL?,consoleUrl?,label?,shortLabel?}}` → same list payload;
  empty strings clear a stored value (falling back to the profile/default). `label` (全名, ≤40 chars) and
  `shortLabel` (短标签, ≤12 chars) let the management page rename a provider. The shipped management page no
  longer edits API keys or base URLs: every provider inherits them from DSH model settings, and the page only
  saves enabled/consoleUrl/label/shortLabel. Overrides are persisted atomically to
  `$DSH_HOME/dsh-tokenlens/providers.json` (plugin-owned, not the profile patch); the same file also
- `{action:"providerTest", providerId}` → the normal snapshot envelope (`{ok,snapshot}` or `{ok:false,error}`), forcing one upstream read.
- `{action:"settingsUpdate", settings:{labelStyle:"short"|"full"}}` → the same providers payload; the choice is
  persisted in the store (`settings.labelStyle`) and controls whether the composer chip shows each
  provider's `shortLabel` or full `label`. Invalid values answer `unsupported-provider`.

`dshProviders` lists every route registered in DSH model settings (in order) with a `supported` flag (whether a usage adapter exists); the shipped management page renders those routes as the primary list and keeps unconfigured preset adapters in a collapsed secondary section. `dshManaged`/`dshProviderId` tell the management page that the route already exists in DSH model settings
(opencode-go / commandcode / deepseek), so the page can inherit the key and base URL instead of asking for them
again; such providers can still be overridden explicitly from the page (the override wins).

### Signed quota adapters (v0.21.0)

- `zhipu-cn`: `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` with the profile API key;
  reuses the GLM Coding Plan parser (`windows`).
- `volcengine`: `POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01`
  signed with Volcengine Signature V4 (service `ark`, region `cn-beijing`). The key pair is read from
  `VOLCENGINE_ACCESS_KEY_ID` / `VOLCENGINE_SECRET_ACCESS_KEY` (environment or credential service); an Ark
  API key cannot query plan quota. Responses (`Result.QuotaUsage[]` or `Result.AFP*`) normalize to the
  canonical 5h/weekly/monthly windows. Missing AK/SK produce a `missing-key` error, never a silent zero.

### Automatic DSH provider sync (v0.18.0)

The management page reads the providers actually saved in DSH model settings from the active profile
(`configEditor.configuration()` → `llm-pi-ai` entry → `config.providers`, plus the `deepseek-account`
account service when composed). Dynamic plugin channels registered through `ctx.llm.listProviders()` are
NOT treated as configured.

Each configured route is auto-mapped to a built-in usage adapter either by route id (built-in provider id
or alias) or by the hostname of its model `baseURL` (openrouter.ai, moonshot.ai/.cn, siliconflow.cn/.com,
stepfun.com/.ai, novita.ai, hyperbolic.xyz/.ai, deepinfra.com, z.ai/bigmodel.cn, minimax.io/.com/.chat,
deepseek.com, commandcode.ai, opencode.ai). The profile `apiKeyEnv` becomes the credential reference, so
no manual setup is needed. Auto-mapped routes appear in `providers[]` as virtual entries with
`autoMapped:true, dshManaged:true`; `dshProviders[]` reports `adapterId`, `autoMapped` and a `reason`
(`no-usage-adapter`) when no usage API is recognised. Profile changes invalidate cached snapshots.

### Custom usage adapters (v0.16.0)

A DSH route without a built-in adapter can be taught to the plugin from the management page with a
declarative definition stored in `providers.json` under `customProviders`:

- `{action:"customProviderSave", provider:{providerId, label, shortLabel?, kind:"balance"|"windows",
  apiKeyRef, baseURL, usagePath, consoleUrl?, note?, …}}` → the normal providers payload; the provider
  id must match `[a-z0-9][a-z0-9._-]{0,63}` and must not collide with a built-in adapter.
  - `kind:"balance"`: `amountPath` (required), `currency`, optional `grantedPath`/`toppedUpPath`; the
    adapter reads the JSON at `baseURL + usagePath` and resolves the paths (`data.balance`, `limits.0.used`).
  - `kind:"windows"`: `windows:{rolling?,weekly?,monthly?}` each `{percentPath, resetPath?}` (at least one)
    and `percentScale:"percent"|"fraction"`; `resetPath` may be epoch ms, seconds or an ISO string.
- `{action:"customProviderDelete", providerId}` → the normal providers payload.
- `providerTest` works for custom providers too (forces one read using the DSH-resolved credential
  `apiKeyRef`).

Custom providers appear in `providers[]` with `builtin:false, custom:true`; when their id matches a DSH
model-settings route they are reported as `supported` in `dshProviders`, so the chip works exactly like a
built-in provider (including the plan-capacity section and provider-scoped token statistics).

Effective provider config = built-in defaults ← profile `providers.<id>` ← store override. A provider without a
resolvable key answers `missing-key` and the chip hides (silent), exactly like before.

## Host config (`cordis.patch.yml` `config`, every field optional)

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` unloads the bridge, tool, timer and stats |
| `defaultProvider` | `opencode-go` | fallback when the browser has not reported a selection |
| `minRefreshIntervalMs` | `20000` | cache TTL per provider |
| `timeoutMs` | `15000` | per-request timeout |
| `pollIntervalMs` | `120000` | background poll of the active provider; `0` disables |
| `statusFile` | `''` | diagnostics JSON (dev aid) |
| `providerStoreFile` | `''` | empty → `$DSH_HOME/dsh-tokenlens/providers.json` (provider-management overrides) |
| `stats.enabled` | `true` | token statistics service |
| `stats.ttlMs` | `30000` | scan answer TTL |
| `stats.cacheFile` | `''` | empty → `$DSH_HOME/dsh-tokenlens/usage-cache.json` |
| `stats.dshHome` | `''` | empty → `$DSH_HOME` |
| `stats.showUninstalled` | `false` | keep a hidden-able row for a harness whose local store is gone (diagnostics aid) |
| `stats.harnesses.dsh` | `true` | include DSH session logs |
| `stats.harnesses.zcode` | `true` | include the ZCode SQLite usage database |
| `stats.harnesses.opencode` | `true` | include the OpenCode CLI SQLite usage database |
| `stats.showUninstalled` | `false` | keep a row for a harness whose local store is missing (otherwise it is hidden + listed in `missingHarnesses`) |
| `stats.zcode.dbPath` | `''` | empty → `~/.zcode/cli/db/db.sqlite` (or `$ZCODE_DB_PATH`) |
| `stats.zcode.providerAliases` | `{ "opencode-go-chat": "opencode-go" }` | ZCode provider id → canonical DSH provider id |
| `stats.opencode.dbPath` | `''` | empty → `~/.local/share/opencode/opencode.db` (or `$OPENCODE_DB_PATH`) |
| `stats.opencode.providerAliases` | `{}` | OpenCode CLI provider id → canonical DSH provider id |
| `stats.harnesses.workbuddy` | `true` | include the WorkBuddy/CodeBuddy CLI JSONL transcripts |
| `stats.harnesses.qoder` | `true` | include the Qoder CN CLI JSONL transcripts |
| `stats.workbuddy.root` | `''` | empty → `~/.workbuddy/projects` (or `$WORKBUDDY_HOME/projects`) |
| `stats.workbuddy.providerAliases` | `{}` | WorkBuddy provider id → canonical DSH provider id (no provider ids stored) |
| `stats.qoder.home` | `''` | empty → `~/.qoder-cn` (or `$QODER_HOME`) |
| `stats.qoder.providerAliases` | `{}` | Qoder provider id → canonical DSH provider id (after settings.json base-URL mapping) |
| `providers.<id>.enabled` | `true` | per-provider switch |
| `providers.<id>.apiKeyRef` | per provider | credential reference |
| `providers.<id>.baseURL` / path fields | per provider | endpoint overrides |
| `providers.<id>.consoleUrl` | per provider | provider web console/usage page for the dialog link |

Legacy v1 flat fields (`baseURL`, `usagePath`, `apiKeyRef`, `apiKey`) still
configure the `opencode-go` provider.

## Client surfaces (agreed UI contract)

1. **Composer dock chip** — slot `conversation.composer.dock`, order `5`, locale
   `dsh-tokenlens`. Compact: provider label + windows percentages, or the balance
   for balance providers. Click opens the detail modal. Hidden for
   `missing-key` / `unsupported-provider` / `disabled`.
2. **Detail modal** — slot `conversation.input.overlay`, id
   `dsh-tokenlens-dialog`, order `3`, locale `dsh-tokenlens`:
   - usage: provider + plan header, three window rows with bars/reset countdowns,
     or a balance card; Command Code also shows remaining/granted credits;
   - **token statistics**: tabs 「当前供应商 · 全部 Harness」 (default; cards = that
     provider's tokens across DSH + ZCode) / 「全部 Harness」 (all providers);
     cards show 今日 / 最近30天 / 总计 (total tokens, input/output/cache, request
     count); a 「按 Harness」breakdown for the active scope; DSH provider
     breakdown and DSH top models; an unmapped-ZCode note when present;
   - refresh (usage + stats), last-updated/stale line, error banners, console link.
3. Everything client-side must work with only the shell's seeded modules
   (`react`, `react-dom`, `@deepseek-ai/dsh-client-ui-primitives`) — no build step.
