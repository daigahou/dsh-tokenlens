# dsh-TokenLens

[简体中文](README.md) · **English**

[![npm version](https://img.shields.io/npm/v/dsh-tokenlens.svg)](https://www.npmjs.com/package/dsh-tokenlens)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/daigahou/dsh-tokenlens/actions/workflows/ci.yml/badge.svg)](https://github.com/daigahou/dsh-tokenlens/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

> One glance at your usage: plan capacity for the selected provider plus local token statistics across harnesses, right below the DSH composer.

**dsh-TokenLens** is a usage plugin for DSH (DeepSeek Harness), version v1.0.7. It keeps two kinds of numbers separate:

- **Plan capacity** — the provider's authoritative server-side values (percentage windows, used / cap, balance or remaining credit);
- **Local token stats** — tokens consumed on this machine across every connected harness, for the selected provider or for all providers combined.

Everything is computed locally: zero runtime dependencies, no external database, no cloud service.

## Features

- **Usage chip below the composer** — follows the selected model provider and shows its plan capacity; providers without an adapter or credentials stay hidden.
- **Details dialog** — plan capacity windows with reset times (plus an optional "consumed · estimated consumable" hint) and local token stats for today / last 7 days / last 30 days / all-time, scoped to the current provider or all harnesses.
- **Data and chart modes** — tables, a daily trend chart and ring charts; breakdowns by harness, provider, top model and unmapped providers.
- **Provider management page** — enabled / built-in / all filters, enable switches, credential status, console links, label editing, connection tests, subscription badges and plugin settings.
- **Auto-discovery and agent tool** — providers configured in DSH Settings → Model Services are detected by route id or base-URL host and reuse their DSH credentials; `tokenlens_usage` lets the model query snapshots, local stats and diagnostics.
- **Local-only** — 5 harnesses (DSH, ZCode, OpenCode CLI, WorkBuddy / CodeBuddy CLI, Qoder CN CLI), 25 built-in providers (15 with plan / balance adapters), read-only local data, no telemetry.

## Screenshots

> Captured on the author's machine (DSH Desktop, dark theme) with real statistics; the layout follows the selected provider, window and theme.

**Usage chip below the composer**

![Usage chip below the composer](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/composer-chip.png)

**Workspace token badge and hover card**

![Workspace token badge and hover card](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/workspace-badge-hover.png)

**Usage dialog**

| Chart mode | Data mode |
|:---:|:---:|
| ![Chart mode](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/stats-chart.png) | ![Data mode](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/stats-data.png) |

**Provider management page**

| Provider settings | Plugin settings |
|:---:|:---:|
| ![Provider settings](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/settings-providers.png) | ![Plugin settings](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/settings-plugin.png) |

**Built-in provider pool**

![Built-in provider pool](https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/docs/images/settings-builtin.png)

## Install

Prerequisites: DSH Desktop 0.2.1-rc.3 or newer 0.2.x (the plugin declares `engines.dsh: ">=0.2.1-rc.3 <0.3.0-0"`, and DSH bundles Node.js 24), an existing DSH profile, and `$DSH_HOME` (default `~/.dsh`).

**Option A — from npm (recommended).** `dsh-tokenlens` is published on [npm](https://www.npmjs.com/package/dsh-tokenlens); the DSH install-source picker also offers a mainland-China mirror.

```powershell
dsh plugin --profile <profile> add dsh-tokenlens
```

Then make sure `dsh.profile.bundles` in `$DSH_HOME/profiles/<profile>/package.json` contains `"dsh-tokenlens"`:

```jsonc
{ "dependencies": { "dsh-tokenlens": "^1.0.7" },
  "dsh": { "profile": { "bundles": ["…", "dsh-tokenlens"] } } }
```

Restart DSH or wait for profile hot recomposition.

**Option B — from GitHub.** In DSH, open **Plugins → Add plugin**, enter `https://github.com/daigahou/dsh-tokenlens` (or `github:daigahou/dsh-tokenlens`) and install. DSH selects the bundle in `dsh.profile.bundles` and enables it by default. CLI equivalent (installs the dependency only; add `"dsh-tokenlens"` to `dsh.profile.bundles` yourself):

```powershell
dsh plugin --profile <profile> add "github:daigahou/dsh-tokenlens"
```

GitHub installs track the latest commit on the default branch (not a tag); updates require uninstall + reinstall, and GitHub access can be unreliable from some networks.

**Option C — from source.** `dsh plugin --profile <profile> add "link:<path-to-dsh-tokenlens>"`.

**Option D — from the DSH plugin market.** This repository maintains a DSH plugin market index ([`market/index.json`](market/index.json)); add it once and the plugin shows up in the **Discover** tab with a one-click install:

1. DSH → **Plugins** → **More** next to *Experimental plugins* → enable **Custom plugin market**;
2. Open **Discover** → **Add index source** → paste:
   ```
   https://raw.githubusercontent.com/daigahou/dsh-tokenlens/main/market/index.json
   ```
3. Search for `TokenLens` in **Discover** and install.

> The index is served over GitHub raw; use Option A instead on networks that cannot reach GitHub. Each release workflow run adds the new version to the index automatically.

Uninstall: `dsh plugin --profile <profile> remove dsh-tokenlens`, remove it from `dsh.profile.bundles`, restart DSH.

## Configuration summary

Every option is optional. Override the `dsh-tokenlens` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

- Top level: `enabled`, `defaultProvider`, `minRefreshIntervalMs`, `timeoutMs`, `pollIntervalMs`, `statusFile` (empty = no diagnostics file), `providerStoreFile` (empty = `$DSH_HOME/dsh-tokenlens/providers.json`).
- `stats`: `enabled`, `ttlMs`, `cacheFile`, `dshHome`, `harnesses` (`dsh` / `zcode` / `opencode` / `workbuddy` / `qoder`), `showUninstalled`, per-harness `dbPath` / `root` / `home` and `providerAliases`.
- `providers.<id>` overrides merge over built-in defaults; management-page overrides live in `$DSH_HOME/dsh-tokenlens/providers.json` and take precedence over profile config.

Credentials come from DSH itself: providers configured in DSH inherit their `apiKeyEnv`, or you can set environment variables such as `OPENCODE_GO_API_KEY`, `COMMANDCODE_API_KEY` and `DEEPSEEK_API_KEY`.

See the [Chinese README](README.md) for the full configuration reference, preview and provider tables.

## Supported providers and harnesses

**Plan capacity / balance adapters:** OpenCode (`opencode-go`, `opencode`), Command Code, DeepSeek, DeepSeek Account, OpenRouter, Moonshot / Kimi, SiliconFlow, StepFun, Novita, Hyperbolic, DeepInfra, Z.ai GLM Coding Plan, MiniMax Coding Plan, Zhipu AI (GLM Coding Plan, CN), Volcengine (Coding / Agent Plan).

**Harnesses:** DSH, ZCode, OpenCode CLI, WorkBuddy / CodeBuddy CLI, Qoder CN CLI.

Host bridge route: `/api/tokenlens`; agent tool: `tokenlens_usage`.

## Privacy and security

- **Read-only**: only local session logs and harness databases are read; SQLite is opened read-only and only token counters, timestamps and provider / model fields are queried — never message contents.
- **Keys stay local**: API keys are resolved in the Host process from DSH credentials, environment variables or the DSH credentials file, and are sent only to the matching provider's official HTTPS endpoint. They are never exposed to the browser, logged or included in diagnostics.
- **No telemetry**: nothing is collected, uploaded, or fetched from remote config / CDN sources (icons are inline SVG).
- **Owner-only data**: management overrides are written atomically to `$DSH_HOME/dsh-tokenlens/providers.json` with owner-only permissions; DSH model settings are never modified.

## Limitations

- Provider usage endpoints are mostly private / undocumented and may change at any time; the plugin degrades gracefully (retryable errors, hidden chips, per-row fallbacks) but availability is not guaranteed.
- Plan capacity shows native server values only: no token → money conversion; Command Code monthly percentage is not guessed when no grant is reported.
- "Estimated consumable" is derived from local tokens and the plan percentage; it is only a hint, not a provider commitment.
- Local stats cover connected harnesses on this machine only; uninstalled harnesses are hidden by default (`stats.showUninstalled: true` shows them). Workspace token badges are experimental.
- **Trademarks**: OpenCode, Command Code, DeepSeek, ZCode, WorkBuddy, CodeBuddy, Qoder and other names are trademarks of their respective owners. This is an independent third-party project, not affiliated with or endorsed by them.

## Development

Node.js ≥ 24, zero runtime dependencies: `node --test` runs the 231 tests.

Release: `node scripts/bump-version.mjs <version> "<note>"` updates `package.json`, `PLUGIN_VERSION` and `CHANGELOG.md`; see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © daigahou
