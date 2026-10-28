# 贡献指南 · Contributing to dsh-TokenLens

感谢你愿意参与「dsh-TokenLens · 词元透镜」！本文说明本地开发、测试、提交与发版约定。英文摘要见文末。

## 先决条件

- **Node.js >= 24**（硬性要求）。插件使用 `node:sqlite` 与 `node:zlib` 的 zstd 解码，更低版本会直接失败。
- **零运行时依赖**：仓库没有需要安装的依赖，clone 之后直接跑测试即可。请不要新增 `dependencies` / `devDependencies`（除非维护者已在 issue 中明确同意）。
- 可选：安装 DSH Desktop 用于人工验证界面；`client.js` 的 HMR 热更新由 DSH 提供。

```bash
node --version   # 期望 v24.x 或更高
```

## 快速开始

```bash
git clone https://github.com/daigahou/dsh-tokenlens.git
cd dsh-tokenlens
node --test
```

`node --test` 会自动发现 `test/*.test.mjs`，当前 **231 个用例**、约 13 秒跑完，**不需要联网**。全部通过即环境就绪。

> 想在 DSH 里实际试用插件，见 [README](README.md) 的「安装」章节：开发者可以直接用本地路径安装，不需要先发布到 npm。

## 目录结构

```
.
├── index.js                 # Host 半体：HTTP bridge、缓存、本机统计、Agent 工具
├── client.js                # 浏览器半体：用量 chip、详情弹窗、供应商管理页（单文件）
├── cordis.patch.yml         # DSH bundle patch，负责挂载 Host 半体
├── lib/
│   ├── providers.mjs        # 供应商元数据 + 各家用量接口适配器
│   ├── key-source.mjs       # API Key 解析（配置 / DSH 凭据 / 环境变量 / 本机凭据文件）
│   ├── provider-store.mjs   # 管理页覆盖项（providers.json）读写，原子写入 + 0600
│   ├── custom-provider.mjs  # 自定义供应商适配器定义的校验
│   ├── usage-stats.mjs      # DSH 会话日志 → 本机 Token 统计折叠
│   ├── usage-zcode.mjs      # ZCode SQLite（只读）
│   ├── usage-opencode.mjs   # OpenCode CLI SQLite（只读）
│   ├── usage-jsonl.mjs      # WorkBuddy / Qoder 等 JSONL 转录（只读）
│   └── go-usage.mjs         # OpenCode Go 套餐容量解析
├── test/                    # node --test 用例（host / providers / stats / zcode / client …）
├── scripts/bump-version.mjs # 发版脚本：同步版本号与 CHANGELOG
├── docs/                    # 文档图片等
├── .github/workflows/       # CI（三平台测试）与 npm 发布
├── README.md / README.en.md
├── PROTOCOL.md              # bridge / stats 数据契约
├── CHANGELOG.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── LICENSE
```

维护者本机可能还有 `.dev/`（研究脚本、探针、备份）与 `.refs/`（从 DSH app.asar 抽取的第三方内部包）。这两个目录已被 `.gitignore` 忽略，**永远不会发布**，请不要在 PR 中提交它们。

## 代码风格

- 纯 ESM（`"type": "module"`）；`lib/` 与 `test/` 使用 `.mjs`；沿用现有无分号风格。
- 2 空格缩进、LF 换行、UTF-8、文件末尾保留一个换行（见 `.editorconfig` 与 `.gitattributes`）。
- 没有构建步骤：`index.js`、`client.js`、`lib/*.mjs` 就是发布内容，不需要打包器。
- 注释语言不限（现有代码中英混合）；面向用户的文案默认中文，新增英文文案请同步 `README.en.md`。
- 优先使用 Node 内置模块（`node:sqlite`、`node:zlib`、`node:fs` 等），不要为小功能引入依赖。

## 测试要求

- 行为改动必须带测试；纯文档/注释改动可以只跑现有测试。
- 测试必须**离线、确定、可重复**：不要请求真实供应商接口；不要把真实 API Key、真实用量数字或本机绝对路径写进测试；用脱敏 fixture 模拟响应形状。
- 改动 `client.js` 时注意 `test/client.test.mjs` 是纯 Node 环境下的渲染/行为冒烟测试，必须同时能在 Linux / macOS / Windows 通过（不要依赖真实浏览器）。
- 提交前本地跑一次 `node --test`；CI 会在 Ubuntu / Windows / macOS 三平台各跑一遍。

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，中英文均可，但同一个 PR 内保持统一：

```
<type>(<scope>): <简短说明>

<可选正文：动机与影响>
```

| type | 用途 |
| --- | --- |
| `feat` | 新功能（对应 MINOR 版本） |
| `fix` | 修 bug（对应 PATCH 版本） |
| `docs` | 文档 |
| `test` | 测试 |
| `refactor` | 不改变行为的重构 |
| `perf` | 性能 |
| `ci` / `build` | CI、构建、发版脚本 |
| `chore` | 杂项 |

示例：

```
fix(providers): parse Command Code credits when the window is missing
feat(client): show the rolling 5-hour window in the capacity card
docs: explain how to add a provider adapter
```

## 发版规则（维护者）

本项目约定：**每一轮有文件变更的改动都必须升一次版本号，并同步更新 CHANGELOG**。

- 修 bug → **PATCH**（1.0.1、1.0.2 …）
- 新功能 → **MINOR**（1.1.0、1.2.0 …）
- 不兼容变更（bridge 契约、配置字段、对外导出或数据形状）→ **MAJOR**（2.0.0 …）

升版本只需一条命令，它会同步 `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`，并在 `CHANGELOG.md` 顶部插入一条记录：

```bash
node scripts/bump-version.mjs 1.0.1 "fix: 修复某供应商金额窗口解析"
```

然后提交并推 tag：

```bash
git add -A
git commit -m "chore(release): v1.0.1"
git tag v1.0.1
git push origin main --tags
```

推送 tag 后，`.github/workflows/release.yml` 会依次：校验 tag 与 `package.json` 版本一致 → 跑 `node --test` → 执行 `npm publish --provenance --access public`（使用仓库 secret `NPM_TOKEN`，并附带 npm provenance 来源证明）。

**外部贡献者不需要改版本号**：由维护者在合并后的发版轮次统一升版本、更新 CHANGELOG，避免每个 PR 互相冲突。

## Pull Request 要求

- [ ] 本地 `node --test` 全绿（Node >= 24）
- [ ] 新增/修改的行为附带测试；测试离线、可重复
- [ ] 未提交 `.dev/`、`.refs/`、`releases/`、`node_modules/`、`*.tgz`、日志等本地文件
- [ ] 未包含任何 API Key、token、凭据、cookie、个人绝对路径（如 Windows 用户目录、macOS/Linux 家目录）或未脱敏的用量截图/数字
- [ ] 未拷贝 DSH app.asar 内的第三方内部代码
- [ ] 文档同步：用户可见改动更新 README / README.en.md；bridge 或 stats 契约变化更新 `PROTOCOL.md`
- [ ] 不破坏「零运行时依赖」与「Node >= 24」两条约束
- [ ] 提交信息符合上面的 Conventional Commits 约定
- [ ] 关联相关 issue（如 `Fixes #12`）

CI 通过后由维护者 review 合并。提出 PR 即表示你同意以 [MIT License](LICENSE) 授权你的贡献（inbound = outbound）。

## 如何新增供应商适配器

1. **元数据**：在 `lib/providers.mjs` 的 `PROVIDER_DEFAULTS` 增加条目：`id`、`label`、`shortLabel`、`kind`（余额或额度窗口）、`baseURL`、`apiKeyRef`（环境变量名）、`consoleUrl`。
2. **适配器**：在同一个文件里实现解析函数，把供应商原始响应归一成统一形状（余额，或 5 小时 / 本周 / 每月的百分比窗口 + 重置时间）。**不要把供应商私有字段泄漏给 client**。
3. **凭证**：只通过 `lib/key-source.mjs` 的 `resolveApiKey()` 读取；`apiKeyRef` 指向环境变量名（如 `MY_PROVIDER_API_KEY`）。不要自行散读 `process.env`，更不要把 Key 写进日志、快照或诊断输出。
4. **自动映射**（可选）：如果希望供应商在 DSH 模型设置里配置后自动出现，补充按路由 id 或模型 `baseURL` 主机名的映射（参考现有 `dshRouteMapping` 与 host 正则表）。
5. **只读、可降级**：只调用供应商的用量/余额接口（不要爬网页）；超时、非 2xx、字段缺失都要降级到 `lastError`，不能让整个弹窗失败。
6. **测试**：在 `test/providers.test.mjs` 增加脱敏后的真实响应 fixture、解析断言与错误路径；不要联网。
7. **文档**：更新 README 的供应商表；`CHANGELOG.md` 由 `bump-version.mjs` 自动生成条目；若新增外部域名或凭据来源，同步更新 `SECURITY.md`。

## 如何新增 Harness 数据源

1. 在 `lib/` 新增 `usage-<harness>.mjs`，导出与现有模块相同形状的扫描器：按 `day / provider / model` 聚合 Token 计数（today / 7d / 30d / all-time 由 `usage-stats.mjs` 统一折叠）。
2. **只读**：SQLite 必须 `new DatabaseSync(path, { readOnly: true })`；JSONL 逐行读取；绝不修改、回写或删除其他工具的数据。
3. 在 `index.js` 的 stats 配置（`stats.harnesses`）与聚合逻辑中注册；缺失、锁定或已卸载的数据源要显示为「不可用 / 未安装」，而不是抛错。
4. 用 `test/usage-<harness>.test.mjs` 覆盖：空库、库缺失、真实行形状、聚合口径（注意 `input` 是否包含 cache，参考 ZCode 的归一逻辑）。
5. 更新 README 的数据源表，以及 `cordis.patch.yml` 中对应的配置注释。

## 安全与隐私

- 发现安全问题**不要**开公开 issue，请按 [SECURITY.md](SECURITY.md) 私下报告。
- 任何 PR 都不应新增遥测、上报、远程配置或自动更新行为。
- 不要读取与统计无关的用户数据（对话正文、文件内容等）：本插件只统计 Token 计数与时间戳。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## English summary

- Requires **Node.js >= 24** (uses `node:sqlite` and `node:zlib` zstd). The project has **zero runtime dependencies**: clone and run `node --test` directly, there is nothing to install.
- Conventional Commits; 2-space indent, LF, UTF-8; no new dependencies; tests must be offline and deterministic.
- Maintainers bump the version for every round of file changes with `node scripts/bump-version.mjs <x.y.z> "<note>"` (syncs `package.json`, `index.js#PLUGIN_VERSION` and `CHANGELOG.md`), then push a `v*` tag to publish with npm provenance. External contributors do not bump versions.
- Never commit `.dev/`, `.refs/`, API keys, personal paths or unredacted usage data. See [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
