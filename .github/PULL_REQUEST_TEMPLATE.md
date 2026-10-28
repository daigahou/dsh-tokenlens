# Pull request

## What does this PR change?

<!-- A short summary, plus the motivation. -->

## Related issue

<!-- e.g. Fixes #12 / Relates to #34 -->

## Type of change

- [ ] Bug fix (PATCH release)
- [ ] New feature (MINOR release)
- [ ] Documentation only
- [ ] Tests / CI / release tooling
- [ ] Refactor or performance (no behavior change)
- [ ] Breaking change (MAJOR release) — describe the migration:

## How was it tested?

- Node.js version: <!-- e.g. v24.19.0 -->
- `node --test` result: <!-- e.g. 223/223 passing -->
- Manual verification (for UI changes): <!-- what you clicked, what you saw -->

## Checklist

- [ ] `node --test` passes locally with Node.js >= 24
- [ ] New or changed behavior has tests; tests are offline and deterministic
- [ ] No `.dev/`, `.refs/`, `releases/`, `node_modules/`, `*.tgz` or log files committed
- [ ] No API keys, tokens, cookies, credentials, personal absolute paths, or unredacted usage data/screenshots
- [ ] No third-party code copied out of the DSH app.asar
- [ ] Docs updated where needed (`README.md` / `README.en.md`; `PROTOCOL.md` for bridge or stats contract changes)
- [ ] No new runtime dependencies, and the Node.js >= 24 requirement is preserved
- [ ] Version bump and `CHANGELOG.md` are handled by the maintainer at release time (external PRs only)

By submitting this pull request you agree that your contribution is licensed under the
[MIT License](LICENSE) (inbound = outbound).
