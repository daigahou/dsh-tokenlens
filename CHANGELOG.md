# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)：修复 = PATCH，新功能 = MINOR，不兼容变更 = MAJOR。发布时同步更新 `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION` 与本文件（`node scripts/bump-version.mjs <version> "<note>"`）；已发布的条目保持原样。

## 1.1.0 — 2026-10-30

- feat(providers): 接入 Open Design（OpenDesign）只读额度查询——Design Plan 的 5 小时 / 7 天窗口已用百分比与重置时间，以及独立的钱包 USD 余额
- feat(providers): Open Design 使用工作区 `workspaceId` + Control Key（`OPENDESIGN_CONTROL_KEY` / `VELA_CONTROL_KEY`）鉴权；推理 API Key 不能查询计费接口
- feat(ui): `windows` 快照现在可以附带钱包余额——详情弹窗在额度窗口下方多一行「账户余额」，chip 悬浮提示追加金额
- docs: 中英 README 与 PROTOCOL 补充 Open Design；说明其余仅元数据供应商没有可用 API Key 查询的公开用量接口（千问/百炼额度仅官方 CLI 可查，腾讯混元/百度千帆只有云账户余额 API）

## 1.0.9 — 2026-10-29

- ci: GitHub Actions 升级到 v7（actions/checkout、actions/setup-node），发布链路仅依赖 OIDC

## 1.0.8 — 2026-10-29

- fix(release): npm registry 发布延迟时索引更新回退到 PUBLISH_TIMESTAMP；补录 1.0.7 到市场索引

## 1.0.7 — 2026-10-29

- ci: 发布改用 npm Trusted Publishing（OIDC），不再依赖仓库令牌；docs: 归并 1.0.0 之前版本历史并修订文档措辞

## 1.0.6 — 2026-10-29

- fix(market): 发布后等待 npm registry 同步再写索引（自动重试）；索引补录 1.0.5

## 1.0.5 — 2026-10-29

- feat(market): 提供 DSH 插件市场索引（market/index.json + icon）并支持发布后自动同步；README 增加从 DSH 市场安装的说明

## 1.0.4 — 2026-10-29

- chore: 插件市场元数据（dsh-plugin 关键词、engines.dsh）与 GitHub 源安装说明

## 1.0.3 — 2026-10-29

- fix(stats): 逐帧解压 zstd，兼容 Node >= 24.22（尾部撕裂帧不再拖垮整份日志，修复 CI 三平台失败）

## 1.0.2 — 2026-10-28

- fix(security+privacy): audit hardening — OpenCode auth key scoping, workspace badge observer loop, canonical provider cache keys, stats path redaction incl. free-form errors, baseURL HTTPS validation (profile/custom), effective-day full history, prototype-pollution-safe maps, WorkBuddy no-id dedupe, immutable provider store writes, secure temp files, DST-safe windows, console link/provider aliases, management scroll; screenshots sanitized

## 1.0.1 — 2026-10-28

- fix(privacy): 状态文件/诊断/管理页路径脱敏（~）、状态文件 0600、网络错误 URL 去凭据/查询串；匿名化测试 fixture 与公共文档中的个人邮箱；工作区统计 tick 增加隐藏页保护；新增 redact 单测与网络错误回归测试

## 1.0.0 — 2026-10-28

首个公开版本：插件定名 **dsh-TokenLens · 词元透镜**，技术包名与内部标识统一为 `dsh-tokenlens` / `tokenlens`，以 MIT 许可开源。本版本合并了此前 0.1.0–0.36.3 的全部开发历史：

**供应商与套餐容量**

- OpenCode（Go 套餐的 5 小时 / 本周 / 本月窗口）、Command Code（美元额度与方案）、DeepSeek 余额、DeepSeek Account 钱包、OpenRouter、Moonshot / Kimi、SiliconFlow、StepFun、Novita、Hyperbolic、DeepInfra、Z.ai GLM Coding Plan、MiniMax Coding Plan；随后接入智谱 AI 国内版与火山引擎 Coding / Agent Plan
- 内置供应商元数据池扩充到 25 家（商汤 SenseNova、通义千问、百度千帆、腾讯混元、讯飞星火、零一万物、百川智能、Intern AI、Agnes AI、Open Design 等）
- 按 DSH 模型设置自动发现路由、自动匹配用量接口并继承凭据；支持短标签 / 全名、启用开关、订阅徽章与控制台链接

**本机 Token 统计**

- 接入 5 个 harness：DSH 会话日志（zstd 逐帧解码、seed 前缀与重试口径）、ZCode（只读 SQLite）、OpenCode CLI、WorkBuddy / CodeBuddy CLI、Qoder CN CLI
- 跨 harness 按供应商合并（alias、同 id、vendor-namespaced 模型唯一匹配），无法映射的供应商单列
- 窗口：今日 / 最近 7 天 / 最近 30 天 / 总计、订阅供应商的「最近 X 天」、滚动 5 小时；按 Harness / 供应商 / Top 模型 / 工作区拆分
- 工作区 Token 徽标与悬浮卡片

**界面**

- 输入框下方的用量 chip（跟随当前供应商）与详情弹窗：套餐容量、本机 Token 两套口径分区展示
- 数据 / 图表两种模式：每日趋势柱状图（坐标轴、悬浮读数）、环形占比图、明细表格
- 供应商管理页（已配置 / 内置 / 全部、凭据状态、短标签编辑、测试连接）与插件设置页；深色主题与窄屏适配

**工程**

- Host ↔ Client bridge 协议 v3、`planUsage` 服务与 `tokenlens_usage` Agent 工具
- 配置覆盖（profile patch 与 providers.json）、统计缓存、诊断与状态文件
- 231 个自动化测试（Node 内置测试器，三平台 CI），零运行时依赖，要求 Node ≥ 24（`node:sqlite`、zstd）
