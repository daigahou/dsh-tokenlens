/**
 * dsh-tokenlens — client half (protocol v2, provider-aware).
 *
 * Adds a compact plan-usage chip to the composer dock and, on click, a detail
 * dialog in the composer overlay slot. The chip follows the AI provider the user
 * selected in the current session: allowance-window providers (OpenCode,
 * Command Code) show their three percentages, balance providers (DeepSeek) show
 * the account balance. The dialog shows the provider/plan header, allowance rows
 * or a balance card, Command Code credits, and today/all-time token statistics
 * folded from the local session logs.
 *
 * Two deliberate choices, both copied from dsh-session-rollback because
 * it is the proven shape on this platform:
 *
 *   - There is no build step: the bundle is a plain script that registers a
 *     factory on `window.__ModuleLoader__`, and it may require only the platform
 *     seed modules (`react`, `react-dom`, `@deepseek-ai/dsh-client-ui-primitives`).
 *   - The Host half is reached over a Connection Fetch route rather than
 *     `ctx.remote`, because that facade is assembled from build-time generated
 *     artifacts and a runtime plugin cannot add a method to it. The URL is
 *     document-relative (`api/tokenlens`) so the same code works under
 *     the desktop shell's `dsh-app://app/` document and under a `dsh web` tab.
 *
 * The provider id comes from the session-scoped slot's `useProjection` prop
 * (`modelSelection` → `next`/`lastUsed` → `provider`). That is the simple path:
 * `ctx.modelDirectories` would need a session id and scope plumbing. When the
 * hook is absent the client sends no providerId and the Host falls back to its
 * configured default provider.
 *
 * Rendering is defensive by doctrine: both entries are injected into shipped
 * seats, and a throw inside one of them would break the composer. Wire data is
 * normalized field by field, all data logic lives in try/catch-safe builders,
 * and the dialog falls back to a one-line "render failed" body it can close.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tokenlens',
  factory(require) {
    const React = require('react')
    // `@deepseek-ai/dsh-client-ui-primitives` and `react-dom` are platform seed
    // words in the shell's module table, so they need no `dsh.client.external`.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Modal, Button, Tooltip, IconRefreshOutlineRegular } = primitives

    const h = React.createElement

    /** Locale namespace, owned seats, and the Host route this plugin calls. */
    const NS = 'dsh-tokenlens'
    const DOCK_SLOT = 'conversation.composer.dock'
    const DIALOG_SLOT = 'conversation.input.overlay'
    const CELL = 'dsh-tokenlens'
    const ROUTE = '/api/tokenlens'.slice(1)
    const STYLE_ID = 'dsh-tokenlens-styles'
    /** Legacy fallback: used only when a snapshot carries no provider `links`. */
    const LEGACY_CONSOLE_URL = 'https://opencode.ai/console'
    /** Allowance-window ids in display order (see PROTOCOL.md). */
    const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']
    /** Error codes that make the chip disappear entirely (PROTOCOL.md). */
    const HIDDEN_CODES = new Set(['missing-key', 'unsupported-provider', 'disabled'])
    /** Background poll cadence while the plugin is active. */
    const POLL_INTERVAL_MS = 60000
    /** Opening the dialog refreshes usage older than this. */
    const OPEN_REFRESH_MS = 30000
    /** Re-reading stats older than this when the dialog opens. */
    const STATS_TTL_MS = 60000
    /** Re-reading the provider management list older than this when it opens. */
    const PROVIDERS_TTL_MS = 30000
    /** Auto-sync cadence of the provider list while the management page is open (v0.17.0). */
    const MANAGEMENT_SYNC_MS = 15000
    /** Retry delay of a 明细-window save blocked by an in-flight settings request (v1.2.1). */
    const DETAILS_WINDOW_SAVE_RETRY_MS = 200
    /** How many per-provider / per-model stats rows the dialog lists. */
    const MAX_PROVIDER_ROWS = 5
    const MAX_MODEL_ROWS = 3
    /** Host-enforced name limits (v0.12.0): an empty override restores the built-in name. */
    const PROVIDER_SHORT_LABEL_MAX = 12
    const PROVIDER_LABEL_MAX = 40
    /** Backoff for a bridge that is not reachable yet (Host half still loading). */
    const BRIDGE_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000, 20000]
    /** The upstream status value that means "this window is healthy". */
    const OK_STATUS = 'ok'
    /** Canonical provider labels, used when a snapshot is not (yet) available. */
    const PROVIDER_LABELS = {
      'opencode-go': 'OpenCode',
      commandcode: 'Command Code',
      deepseek: 'DeepSeek',
      'deepseek-official': 'DeepSeek',
      'deepseek-account': 'DeepSeek Account',
      openrouter: 'OpenRouter',
      moonshot: 'Moonshot / Kimi',
      siliconflow: 'SiliconFlow',
      stepfun: 'StepFun',
      novita: 'Novita',
      hyperbolic: 'Hyperbolic',
      deepinfra: 'DeepInfra',
      zai: 'Z.ai GLM Coding Plan',
      minimax: 'MiniMax Coding Plan',
    }
    /** Compact chip labels per provider (the chip stays narrow). */
    const PROVIDER_SHORT_LABELS = {
      'opencode-go': 'OC',
      commandcode: 'CC',
      deepseek: 'DS',
      'deepseek-official': 'DS',
      'deepseek-account': 'DSA',
      openrouter: 'OR',
      moonshot: 'MS',
      siliconflow: 'SF',
      stepfun: 'ST',
      novita: 'NV',
      hyperbolic: 'HB',
      deepinfra: 'DI',
      zai: 'ZAI',
      minimax: 'MM',
    }
    /** Picker ids the Host's adapter canonicalizes (snapshot.provider.id is canonical). */
    const PROVIDER_ID_ALIASES = { 'deepseek-official': 'deepseek', opencode: 'opencode-go' }
    /** Nicer names for known local harnesses (wire labels win; raw ids fall back). */
    const HARNESS_LABELS = {
      dsh: 'DSH',
      zcode: 'ZCode',
      opencode: 'OpenCode CLI',
      'opencode-cli': 'OpenCode CLI',
      codex: 'Codex',
    }
    /** Currency symbols for the common provider currencies. */
    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }
    /** Fixed segment palette of the 明细 donut charts (v0.27.0, color-blind friendly order). */
    const DONUT_PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#f97316']
    /**
     * Host-side display defaults (v0.29.0; the five fields include the v1.2.1
     * 明细 donut window). 「恢复默认设置」 sends exactly these; must stay in sync
     * with DEFAULT_SETTINGS in lib/provider-store.mjs.
     */
    const DEFAULT_PLUGIN_SETTINGS = {
      labelStyle: 'full',
      defaultView: 'chart',
      defaultScope: 'provider',
      detailsExpanded: 'auto',
      detailsWindow: 'total',
    }

    const zh = {
      title: '词元透镜（dsh-TokenLens）',
      chipHint: '当前模型供应商的套餐用量，点击查看详情',
      chipUnavailable: '用量读取失败',
      chipNoUsage: '暂无用量',
      chipRolling: '5时',
      chipWeekly: '周',
      chipMonthly: '月',
      rowRolling: '5 小时',
      rowWeekly: '本周',
      rowMonthly: '本月',
      percent: '{percent}%',
      unknownPercent: '—',
      barLabel: '{window}已用 {percent}',
      resetIn: '{time}后重置',
      resettingNow: '即将重置',
      resetUnknown: '重置时间未知',
      durationDay: '{n} 天',
      durationHour: '{n} 小时',
      durationMinute: '{n} 分',
      durationSecond: '{n} 秒',
      statusPrefix: '上游状态：{status}',
      planPrefix: '套餐：{plan}',
      accountPrefix: '账户：{name}',
      balanceLabel: '账户余额',
      balanceGranted: '赠送 {amount}',
      balanceToppedUp: '充值 {amount}',
      balanceWallets: '钱包：{amounts}',
      balanceBonus: '奖励：{amounts}',
      creditsRemaining: '剩余 {amount}',
      creditsGranted: '本月额度 {amount}',
      creditsPurchased: '加购 {amount}',
      refresh: '刷新',
      refreshing: '正在刷新…',
      retry: '重试',
      close: '关闭',
      consoleLink: '打开 opencode.ai 控制台',
      consoleLinkProvider: '打开 {provider} 控制台',
      consoleLinkCommandCode: '打开 Command Code 用量页',
      consoleLinkDeepSeek: '打开 DeepSeek 平台',
      updatedAt: '上次更新：{time}',
      updatedAgo: '（{age}）',
      ageJustNow: '刚刚',
      ageMinutes: '{n} 分钟前',
      ageHours: '{n} 小时前',
      ageDays: '{n} 天前',
      stale: '数据可能已过期',
      loading: '正在读取用量…',
      statsTitle: '本机 Token 用量',
      statsSubtitle: '本机各 Harness 记录（不是供应商侧额度）',
      statsSubtitleList: '{base}：{list}',
      statsSubtitleMore: ' 等 {n} 个',
      statsTabProvider: '当前供应商 · 全部 Harness',
      statsTabAll: '全部 Harness',
      statsScopeLabel: '统计范围',
      statsCombinedLabel: '全部 Harness 合计',
      statsProviderScopeLabel: '当前供应商 · 全部 Harness：{provider}',
      statsProviderFallback: '当前供应商（{provider}）没有本机记录，显示全部 Harness 合计',
      statsDshTotalLabel: 'DSH 合计',
      statsLast30Days: '最近30天',
      statsLast7Days: '最近7天',
      stats7DaysShort: '7天',
      statsDaysShort: '{n}天',
      statsSinceEffective: '最近{n}天',
      statsViewLabel: '展示方式',
      statsViewData: '数据',
      statsViewChart: '图表',
      statsChartEmpty: '暂无每日用量数据',
      statsChartEmptyHint: '本地 Harness 尚未产生按日统计',
      statsChartTotal: '合计 {value}',
      statsChartPeak: '峰值 {value}（{day}）',
      statsChartBarTitle: '{date}: {tokens}',
      statsChartReadout: '{date} · {value}（{share}%）',
      statsChartBack: '← 返回日趋势',
      statsChartBackHint: '返回每日趋势图',
      statsChartHourTitle: '按小时 · {date}',
      statsChartHourBarTitle: '{date} {hour} · {tokens}',
      statsChartHourEmpty: '该日没有小时级数据',
      statsWindowLabel: '明细统计窗口',
      statsByHarness: '按 Harness',
      statsHarnessUnavailable: '不可用',
      statsHarnessRetryHint: '检查本机 Harness 数据源后点刷新重试',
      statsUnmapped: '未归属到 DSH 供应商的本机用量',
      statsUnmappedHint: '仅计入全部 Harness 合计',
      statsMoreDetails: '更多明细（DSH 按供应商 / Top 模型）',
      statsLessDetails: '收起明细',
      statsDetailsTitle: '明细',
      statsMissingHarnesses: '已卸载/无数据的 Harness：{list}',
      statsMissingHarnessesHint: '根据本机数据目录自动检测，不参与统计；重新安装后会自动恢复',
      statsProviderHarnessEmpty: '该供应商最近 30 天在本机各 Harness 没有用量',
      statsHarnessMissing: '未安装',
      statsHarnessMissingHint: '本地数据源不存在',
      capacityTitle: '套餐容量',
      capacitySource: '数据来自供应商接口（服务端权威）',
      capacityTokenUsed: '已消耗 {used}',
      capacityTokenEstimate: '预计可消耗 {quota}',
      capacityTokenNoEstimate: '预计可消耗 —',
      capacityTokenEstimateHint: '本机 Token 记录 ÷ 当前套餐百分比估算，仅供参考',
      pluginVersion: '插件 v{version}',
      statsToday: '今日',
      statsAllTime: '总计',
      statsInput: '输入',
      statsOutput: '输出',
      statsCacheRead: '缓存读',
      statsRequests: '共 {n} 次请求',
      statsByProvider: 'DSH 按供应商',
      statsTodayCol: '今日',
      statsAllTimeCol: '总计',
      statsTopModels: 'DSH Top 模型',
      statsNameCol: '名称',
      statsNameColHarness: 'Harness',
      statsNameColProvider: '供应商',
      statsNameColModel: '模型',
      statsGenerated: '统计生成：{time}',
      statsLoading: '正在统计本地会话…',
      statsEmpty: '还没有 Token 使用记录',
      errorMissingKey: '没有找到该供应商的 API Key',
      errorUnsupportedProvider: '当前模型供应商不受用量插件支持',
      errorDisabled: '插件或该供应商已被停用',
      errorUnauthorized: 'API Key 无效或已过期',
      errorForbidden: '没有权限读取该套餐用量',
      errorNetwork: '无法连接用量服务（网络错误）',
      errorTimeout: '请求用量服务超时',
      errorHttp: '用量服务返回了错误',
      errorParse: '无法解析用量服务的返回内容',
      errorRateLimited: '请求过于频繁，请稍后再试',
      errorStatsUnavailable: 'Token 统计不可用',
      errorInternal: '用量插件内部错误',
      errorBridge: '无法连接 DSH 的 Host 桥接（Host 半可能还没加载）',
      errorGeneric: '读取用量失败（{code}）',
      buildFailed: '用量详情渲染失败：{message}',
      manageOpen: '管理',
      manageOpenHint: '查看供应商如何继承 DSH 模型设置，编辑名称与控制台地址，并测试连接',
      manageTitle: '供应商管理',
      appTitleShort: '词元透镜',
      appTitleFull: 'dsh-TokenLens · 词元透镜',
      managePageLabel: '管理页',
      manageBack: '← 返回',
      manageBackHint: '返回用量详情',
      manageSubtitle: '展开供应商即可编辑；开关立即生效，保存只提交修改过的字段',
      providersLoading: '正在读取供应商配置…',
      providersEmpty: 'Host 没有返回任何供应商',
      providersStoreFile: '配置文件：{file}',
      providerKindWindows: '额度窗口',
      providerKindBalance: '余额',
      providerKindUnknown: '未知类型',
      providerEnabled: '启用',
      providerEnableHint: '启用或停用 {provider}',
      providerBuiltin: '内置',
      providerSubscribed: '已订阅',
      providerNotSubscribed: '未订阅',
      providerSubscribedHint: '已检测到套餐额度',
      providerNotSubscribedHint: '未检测到订阅（余额/按量付费或尚未配置）',
      providerStatusConfigured: '已配置',
      providerStatusMissingKey: '缺 Key',
      providerStatusDisabled: '已停用',
      providerStatusTesting: '测试中…',
      providerStatusOk: '可用',
      providerStatusError: '错误',
      providerKeySource: '来源：{source}',
      providerKeyService: '使用 DSH 账户服务，无需 API Key',
      providerDshInherited: 'Key 与接口地址继承自 DSH 模型设置（{provider}），无需在此重复填写',
      providerDshUnmanaged:
        '未在 DSH 模型设置中找到该供应商路由；请先在 DSH「设置 → 模型服务」中添加/登录该供应商（建议路由 id：{provider}），插件会自动复用其 Key 与地址',
      dshSectionTitle: 'DSH 模型设置中的供应商',
      dshSectionHint: '来自 DSH「设置 → 模型服务」；插件直接复用其 Key 与接口地址',
      dshSectionCount: '共 {n} 个',
      dshUnsupportedHint: 'DSH 已配置，但插件暂时无法自动识别其用量接口',
      presetSectionTitle: '插件适配器（DSH 未配置）',
      presetSectionHint: '这些是插件内置的适配器；在 DSH「设置 → 模型服务」中配置后，它们会自动移到上方的 DSH 列表',
      presetSectionCount: '共 {n} 个',
      presetExpand: '展开',
      presetCollapse: '收起',
      providerConsoleURL: '控制台地址（Console URL）',
      providerConsoleURLPlaceholder: '留空则使用内置默认地址',
      providerSave: '保存',
      providerSaving: '保存中…',
      providerTest: '测试连接',
      providerTesting: '测试中…',
      providerUpdateFailed: '更新供应商失败',
      providerTestFailed: '测试连接失败',
      labelStyleTitle: '提词器名称：',
      labelStyleShort: '短标签',
      labelStyleFull: '全名',
      labelStyleSaving: '保存中…',
      labelStyleHint: '选择输入框上方用量提词器显示短标签还是供应商全名',
      manageTabProviders: '供应商配置',
      manageTabSettings: '插件设置',
      manageTabsLabel: '管理分区',
      settingsHint: '修改后立即保存；默认值在下次打开用量详情时生效',
      settingsLabelStyle: '标签样式',
      settingsDefaultView: '默认展示模式',
      settingsDefaultScope: '默认统计范围',
      settingsScopeProvider: '当前供应商',
      settingsScopeAll: '全部 Harness',
      settingsDetailsExpanded: '明细默认展开',
      settingsDetailsAuto: '自动',
      settingsDetailsExpandedOption: '展开',
      settingsDetailsCollapsed: '收起',
      settingsResetDefaults: '恢复默认设置',
      settingsResetDefaultsHint: '恢复为插件默认的显示设置',
      providerBothLabels: '短标签：{short} · 全名：{full}',
      providerShortLabel: '短标签',
      providerShortLabelHint: '1–12 字符',
      providerShortLabelTooLong: '短标签最多 12 个字符',
      providerFullName: '全名',
      providerFullNameHint: '1–40 字符',
      providerFullNameTooLong: '全名最多 40 个字符',
      providerRestoreNames: '恢复默认名称',
      providerRestoreNamesHint: '清空自定义名称，恢复内置默认名称',
      customSectionTitle: '自定义适配器',
      customSectionCount: '共 {n} 个',
      customSectionHint: '通过声明的接口与 JSON 字段路径读取用量；未匹配 DSH 路由时显示在这里',
      customDelete: '删除',
      customDeleting: '删除中…',
      customDeleteHint: '删除这个自定义用量适配器',
      customProviderBadge: '自定义',
      customProviderHint: '自定义适配器：按声明的接口与 JSON 字段路径读取用量',
      providerFilterLabel: '供应商来源',
      filterConfigured: '已配置',
      filterBuiltin: '内置',
      filterAll: '全部',
      filterEmptyConfigured: '暂无已配置的供应商',
      filterEmptyConfiguredHint: '在 DSH「设置 → 模型服务」中添加供应商后，会自动出现在这里',
      builtinSectionTitle: '内置供应商适配器',
      builtinSectionHint: '插件内置的预设适配器；在 DSH「设置 → 模型服务」中配置后也会同时出现在「已配置」',
    }
    const en = {
      title: 'dsh-TokenLens',
      chipHint: 'Plan usage for the selected provider — click for details',
      chipUnavailable: 'Usage unavailable',
      chipNoUsage: 'No usage',
      chipRolling: '5h',
      chipWeekly: 'wk',
      chipMonthly: 'mo',
      rowRolling: '5 hours',
      rowWeekly: 'This week',
      rowMonthly: 'This month',
      percent: '{percent}%',
      unknownPercent: '—',
      barLabel: '{window} used {percent}',
      resetIn: 'Resets in {time}',
      resettingNow: 'Resetting now',
      resetUnknown: 'Reset time unknown',
      durationDay: '{n}d',
      durationHour: '{n}h',
      durationMinute: '{n}m',
      durationSecond: '{n}s',
      statusPrefix: 'Upstream: {status}',
      planPrefix: 'Plan: {plan}',
      accountPrefix: 'Account: {name}',
      balanceLabel: 'Account balance',
      balanceGranted: 'Granted {amount}',
      balanceToppedUp: 'Topped up {amount}',
      balanceWallets: 'Wallets: {amounts}',
      balanceBonus: 'Bonus: {amounts}',
      creditsRemaining: 'Remaining {amount}',
      creditsGranted: 'Granted {amount}',
      creditsPurchased: 'Purchased {amount}',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      retry: 'Retry',
      close: 'Close',
      consoleLink: 'Open opencode.ai console',
      consoleLinkProvider: 'Open {provider} console',
      consoleLinkCommandCode: 'Open Command Code usage',
      consoleLinkDeepSeek: 'Open DeepSeek platform',
      updatedAt: 'Updated {time}',
      updatedAgo: ' ({age})',
      ageJustNow: 'just now',
      ageMinutes: '{n}m ago',
      ageHours: '{n}h ago',
      ageDays: '{n}d ago',
      stale: 'Data may be stale',
      loading: 'Reading usage…',
      statsTitle: 'Local token usage',
      statsSubtitle: 'Local records from every harness on this machine — not provider-side allowance',
      statsSubtitleList: '{base}: {list}',
      statsSubtitleMore: ' +{n} more',
      statsTabProvider: 'Current provider · all harnesses',
      statsTabAll: 'All harnesses',
      statsScopeLabel: 'Scope',
      statsCombinedLabel: 'All harnesses combined',
      statsProviderScopeLabel: 'Current provider · all harnesses: {provider}',
      statsProviderFallback: 'No local records for the current provider ({provider}) — showing all-harness totals',
      statsDshTotalLabel: 'DSH total',
      statsLast30Days: 'Last 30 days',
      statsLast7Days: 'Last 7 days',
      stats7DaysShort: '7d',
      statsDaysShort: '{n}d',
      statsSinceEffective: 'Last {n}d',
      statsViewLabel: 'View',
      statsViewData: 'Data',
      statsViewChart: 'Chart',
      statsChartEmpty: 'No daily usage data yet',
      statsChartEmptyHint: 'The local harnesses have not recorded daily statistics yet',
      statsChartTotal: 'Total {value}',
      statsChartPeak: 'Peak {value} ({day})',
      statsChartBarTitle: '{date}: {tokens}',
      statsChartReadout: '{date} · {value} ({share}%)',
      statsChartBack: '← Back to daily',
      statsChartBackHint: 'Back to the daily trend chart',
      statsChartHourTitle: 'By hour · {date}',
      statsChartHourBarTitle: '{date} {hour} · {tokens}',
      statsChartHourEmpty: 'No hourly data for this day',
      statsWindowLabel: 'Details window',
      statsByHarness: 'By harness',
      statsHarnessUnavailable: 'Unavailable',
      statsHarnessRetryHint: 'Check the harness data source, then click Refresh to retry',
      statsUnmapped: 'Local usage not attributed to a DSH provider',
      statsUnmappedHint: 'Counts only toward all-harness totals',
      statsMoreDetails: 'More details (DSH providers / top models)',
      statsLessDetails: 'Hide details',
      statsDetailsTitle: 'Details',
      statsMissingHarnesses: 'Hidden harnesses (uninstalled or no local data): {list}',
      statsMissingHarnessesHint: 'Detected from local data directories; excluded from totals and restored automatically after reinstall',
      statsProviderHarnessEmpty: 'No usage for this provider in the last 30 days across local harnesses',
      statsHarnessMissing: 'Not installed',
      statsHarnessMissingHint: 'Local data store is missing',
      capacityTitle: 'Plan capacity',
      capacitySource: 'From the provider API (server-authoritative)',
      capacityTokenUsed: 'Consumed {used}',
      capacityTokenEstimate: 'Est. quota {quota}',
      capacityTokenNoEstimate: 'Est. quota —',
      capacityTokenEstimateHint: 'Local token records ÷ current plan percentage; estimate only',
      pluginVersion: 'Plugin v{version}',
      statsToday: 'Today',
      statsAllTime: 'All time',
      statsInput: 'Input',
      statsOutput: 'Output',
      statsCacheRead: 'Cache read',
      statsRequests: '{n} requests',
      statsByProvider: 'DSH by provider',
      statsTodayCol: 'Today',
      statsAllTimeCol: 'All time',
      statsTopModels: 'DSH top models',
      statsNameCol: 'Name',
      statsNameColHarness: 'Harness',
      statsNameColProvider: 'Provider',
      statsNameColModel: 'Model',
      statsGenerated: 'Generated {time}',
      statsLoading: 'Scanning local sessions…',
      statsEmpty: 'No token usage recorded yet',
      errorMissingKey: 'No API key is configured for this provider',
      errorUnsupportedProvider: 'The selected provider is not supported by this usage plugin',
      errorDisabled: 'The plugin or this provider is disabled',
      errorUnauthorized: 'The API key is invalid or expired',
      errorForbidden: 'This account may not read the usage',
      errorNetwork: 'Could not reach the usage service (network error)',
      errorTimeout: 'The usage request timed out',
      errorHttp: 'The usage service returned an error',
      errorParse: 'Could not parse the response from the usage service',
      errorRateLimited: 'Too many requests — try again shortly',
      errorStatsUnavailable: 'Token statistics are unavailable',
      errorInternal: 'Internal error in the usage plugin',
      errorBridge: 'The DSH Host bridge is unreachable (the Host half may still be loading)',
      errorGeneric: 'Reading usage failed ({code})',
      buildFailed: 'Could not render the usage details: {message}',
      manageOpen: 'Manage',
      manageOpenHint: 'Review how providers inherit the DSH model settings, edit names and console URLs, and test connections',
      manageTitle: 'Provider management',
      appTitleShort: 'dsh-TokenLens',
      appTitleFull: 'dsh-TokenLens · 词元透镜',
      managePageLabel: 'Management',
      manageBack: '← Back',
      manageBackHint: 'Back to usage details',
      manageSubtitle: 'Expand a provider to edit it; toggles apply immediately and Save submits only changed fields',
      providersLoading: 'Loading provider settings…',
      providersEmpty: 'The Host returned no providers',
      providersStoreFile: 'Settings file: {file}',
      providerKindWindows: 'Quota windows',
      providerKindBalance: 'Balance',
      providerKindUnknown: 'Unknown kind',
      providerEnabled: 'Enabled',
      providerEnableHint: 'Enable or disable {provider}',
      providerBuiltin: 'Built-in',
      providerSubscribed: 'Subscribed',
      providerNotSubscribed: 'Not subscribed',
      providerSubscribedHint: 'Plan quota detected',
      providerNotSubscribedHint: 'No subscription detected (balance / pay-as-you-go or not configured yet)',
      providerStatusConfigured: 'Configured',
      providerStatusMissingKey: 'Missing key',
      providerStatusDisabled: 'Disabled',
      providerStatusTesting: 'Testing…',
      providerStatusOk: 'Available',
      providerStatusError: 'Error',
      providerKeySource: 'Source: {source}',
      providerKeyService: 'Uses the DSH account service — no API key needed',
      providerDshInherited: 'The API key and base URL are inherited from the DSH model settings ({provider}) — no need to fill them in here',
      providerDshUnmanaged:
        'No route for this provider was found in the DSH model settings. Add or sign in to it under DSH "Settings → Model services" first (suggested route id: {provider}); the plugin will then reuse its key and endpoint automatically',
      dshSectionTitle: 'Providers in DSH model settings',
      dshSectionHint: 'From DSH "Settings → Model services"; the plugin reuses their key and endpoint',
      dshSectionCount: '{n} total',
      dshUnsupportedHint: 'Configured in DSH, but the plugin cannot automatically detect its usage API yet',
      presetSectionTitle: 'Plugin adapters (not in DSH)',
      presetSectionHint:
        'These built-in adapter presets move to the DSH list above once they are configured under DSH "Settings → Model services"',
      presetSectionCount: '{n} total',
      presetExpand: 'Expand',
      presetCollapse: 'Collapse',
      providerConsoleURL: 'Console URL',
      providerConsoleURLPlaceholder: 'Leave empty for the built-in default',
      providerSave: 'Save',
      providerSaving: 'Saving…',
      providerTest: 'Test connection',
      providerTesting: 'Testing…',
      providerUpdateFailed: 'Updating the provider failed',
      providerTestFailed: 'The connection test failed',
      labelStyleTitle: 'Chip name:',
      labelStyleShort: 'Short label',
      labelStyleFull: 'Full name',
      labelStyleSaving: 'Saving…',
      labelStyleHint: 'Choose whether the usage chip above the composer shows the short label or the full provider name',
      manageTabProviders: 'Provider config',
      manageTabSettings: 'Plugin settings',
      manageTabsLabel: 'Management sections',
      settingsHint: 'Changes save immediately; the defaults apply the next time the usage dialog opens',
      settingsLabelStyle: 'Label style',
      settingsDefaultView: 'Default view',
      settingsDefaultScope: 'Default stats scope',
      settingsScopeProvider: 'Current provider',
      settingsScopeAll: 'All harnesses',
      settingsDetailsExpanded: 'Details default',
      settingsDetailsAuto: 'Auto',
      settingsDetailsExpandedOption: 'Expanded',
      settingsDetailsCollapsed: 'Collapsed',
      settingsResetDefaults: 'Restore defaults',
      settingsResetDefaultsHint: 'Restore the plugin default display settings',
      providerBothLabels: 'Short label: {short} · Full name: {full}',
      providerShortLabel: 'Short label',
      providerShortLabelHint: '1–12 characters',
      providerShortLabelTooLong: 'The short label may be at most 12 characters',
      providerFullName: 'Full name',
      providerFullNameHint: '1–40 characters',
      providerFullNameTooLong: 'The full name may be at most 40 characters',
      providerRestoreNames: 'Restore default names',
      providerRestoreNamesHint: 'Clear the custom names and restore the built-in defaults',
      customSectionTitle: 'Custom adapters',
      customSectionCount: '{n} total',
      customSectionHint: 'Reads usage from a declared API endpoint and JSON field paths; listed here when no DSH route matches',
      customDelete: 'Delete',
      customDeleting: 'Deleting…',
      customDeleteHint: 'Delete this custom usage adapter',
      customProviderBadge: 'Custom',
      customProviderHint: 'Custom adapter: reads usage from the declared API endpoint and JSON field paths',
      providerFilterLabel: 'Provider source',
      filterConfigured: 'Configured',
      filterBuiltin: 'Built-in',
      filterAll: 'All',
      filterEmptyConfigured: 'No configured providers yet',
      filterEmptyConfiguredHint: 'Add providers under DSH "Settings → Model services" and they will appear here automatically',
      builtinSectionTitle: 'Built-in provider adapters',
      builtinSectionHint: 'Built-in preset adapters; configuring one under DSH "Settings → Model services" also lists it under Configured',
    }

    /** Interpolate `{name}` placeholders. */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) =>
        params !== undefined && params[key] !== undefined ? String(params[key]) : `{${key}}`,
      )
    }

    /** The framework-bound `t` seat captured in `apply`, used only as a fallback. */
    let boundTranslate = null
    /** The app locale reported to the Host in `hello` (diagnostics only). */
    let appLocale = ''

    /** Fallback translator for the (unexpected) case a component gets no `t`. */
    function fallbackTranslate(key, params) {
      const template = typeof boundTranslate === 'function' ? boundTranslate(key) : undefined
      const source = typeof template === 'string' && template !== '' ? template : (zh[key] ?? en[key] ?? key)
      return params === undefined ? source : fill(source, params)
    }

    /** The `t` seat of one component: the framework's, else the captured one. */
    function tOf(props) {
      return typeof props?.t === 'function' ? props.t : fallbackTranslate
    }

    // ---------------------------------------------------------------------
    // Inline icons (dependency-free; no text nodes, so `textOf` stays clean).
    // ---------------------------------------------------------------------

    /**
     * 16×16 stroke icons: name → path `d` list. `stroke` is `currentColor`, so
     * an icon inherits the color of the title / button / pill that hosts it.
     * The list is deliberately small and local: the bundle may import no asset
     * and no icon package.
     */
    const ICON_PATHS = {
      gauge: ['M2.5 12.5a5.5 5.5 0 1 1 11 0', 'M8 9.6 10.6 6.2', 'M8 12.5h.01'],
      chart: ['M3 13V8.2', 'M6.4 13V5', 'M9.8 13V9.6', 'M13.2 13V3.2', 'M2.4 13h11.2'],
      list: ['M3 4.2h.01', 'M6.4 4.2H13.2', 'M3 8h.01', 'M6.4 8H13.2', 'M3 11.8h.01', 'M6.4 11.8H13.2'],
      server: ['M2.8 3.2h10.4v3.4H2.8z', 'M2.8 9.4h10.4v3.4H2.8z', 'M4.8 4.9h.01', 'M4.8 11.1h.01'],
      cube: ['M8 2.4 13.4 5.4v5.2L8 13.6 2.6 10.6V5.4z', 'M2.8 5.6 8 8.5l5.2-2.9', 'M8 8.5v4.9'],
      layers: ['M8 2.4 13.4 5.2 8 8 2.6 5.2z', 'M2.8 7.9 8 10.7l5.2-2.8', 'M2.8 10.6 8 13.4l5.2-2.8'],
      gear: [
        'M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z',
        'M8 2v1.3',
        'M8 12.7V14',
        'M2 8h1.3',
        'M12.7 8H14',
        'M3.7 3.7l.9.9',
        'M11.4 11.4l.9.9',
        'M12.3 3.7l-.9.9',
        'M4.6 11.4l-.9.9',
      ],
      external: ['M6.6 3.4H3.9a.9.9 0 0 0-.9.9v7.8a.9.9 0 0 0 .9.9h7.8a.9.9 0 0 0 .9-.9V9.4', 'M9.4 2.5h4.1v4.1', 'M8.1 7.9 13.4 2.6'],
      windows: ['M2.6 3.4h10.8v9.2H2.6z', 'M8 3.4v9.2', 'M2.6 7.9h10.8'],
      coin: ['M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Z', 'M8 5.2v5.6', 'M6.3 6.6h3.4', 'M6.3 9.4h3.4'],
      check: ['M3 8.4 6.2 11.4 13 4.4'],
      alert: ['M8 2.5 14 13.2H2z', 'M8 6.2v3.2', 'M8 11.3h.01'],
      spinner: ['M8 2.5a5.5 5.5 0 1 1-5.5 5.5', 'M8 5.5v2.8'],
      ban: ['M3.2 3.2 12.8 12.8', 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Z'],
      key: ['M5.6 8.8a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8Z', 'M7.8 6.7 13.2 12.1', 'M11.1 10 12.3 8.8', 'M12.1 11 13.2 9.9'],
      tag: ['M2.6 2.6h4.9l5.9 5.9-4.9 4.9-5.9-5.9z', 'M5.3 5.3h.01'],
      text: ['M2.8 4.2h10.4', 'M2.8 8h7.4', 'M2.8 11.8h9.2'],
      save: ['M3.1 3.1h7.5L13 5.4v7.5H3.1z', 'M5.6 3.1v3.1h4.6V3.1', 'M5.6 12.9V9.7h4.8v3.2'],
      trash: ['M3.4 4.4h9.2', 'M6 4.4V2.9h4v1.5', 'M4.5 4.4 5.2 13.1h5.6l.7-8.7', 'M6.7 7v3.6', 'M9.3 7v3.6'],
      bolt: ['M8.9 2 4.4 8.9h2.7L7.1 14l4.5-6.9H8.9z'],
      plus: ['M8 3.2v9.6', 'M3.2 8h9.6'],
      edit: ['M3.2 12.8h2.4L13 5.4l-2.4-2.4L3.2 10.4z', 'M9.3 3.3l2.4 2.4'],
      info: ['M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Z', 'M8 7.2v4', 'M8 5.1h.01'],
    }

    /**
     * One inline SVG icon element (12–16px stroke icon, `aria-hidden`).
     *
     * It returns an SVG *element* rather than a component so the rendered tree
     * really contains `<svg>`/`<path>` nodes (a hook-less test renderer or the
     * real React renderer both see them). Because the element carries no text
     * child, the existing `textOf` assertions keep matching exactly.
     */
    function Icon(name, size) {
      const paths = ICON_PATHS[name]
      if (!Array.isArray(paths) || paths.length === 0) return null
      const px = Number.isFinite(size) ? Math.min(16, Math.max(12, size)) : 14
      return h(
        'svg',
        {
          className: 'dsh-tokenlens-icon',
          viewBox: '0 0 16 16',
          width: px,
          height: px,
          style: { flex: '0 0 auto', width: `${px}px`, height: `${px}px`, minWidth: `${px}px`, overflow: 'visible' },
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    // ---------------------------------------------------------------------
    // Formatting helpers (pure; hostile input must never throw).
    // ---------------------------------------------------------------------

    /** 0..100 number or null. */
    function clampPercent(value) {
      let numeric = value
      if (typeof numeric === 'string' && numeric.trim() !== '') numeric = Number(numeric)
      if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null
      return Math.min(100, Math.max(0, numeric))
    }

    /** A finite non-negative number or null. */
    function numberOrNull(value) {
      const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 ? numeric : null
    }

    /** A non-empty string or ''. */
    function stringOrEmpty(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Percent text: `2%`, `2.5%`, or the em dash for unknown. */
    function formatPercent(value, t) {
      if (!Number.isFinite(value)) return t('unknownPercent')
      const rounded = Math.round(value * 10) / 10
      const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
      return t('percent', { percent: text })
    }

    /** Bar width as a percentage number. */
    function barWidth(value) {
      return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
    }

    /** Drop trailing zeroes from a fixed-point string: `2.00` → `2`, `268.50` → `268.5`. */
    function trimZeroes(text) {
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
    }

    /** Compact token count: `812`, `268.5M`, `2.98B`. */
    function formatTokensCompact(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1e9) return `${trimZeroes((value / 1e9).toFixed(2))}B`
      if (value >= 1e6) return `${trimZeroes((value / 1e6).toFixed(1))}M`
      if (value >= 1e3) return `${trimZeroes((value / 1e3).toFixed(1))}K`
      return String(Math.round(value))
    }

    /**
     * Precise local-token count (v0.12.1): every number in the local-token
     * section keeps EXACTLY three decimal places once it is scaled, e.g. `812`,
     * `1.234K`, `448.902M`, `2.882B`, `3.000B` (trailing zeros stay).
     *
     * This is deliberately separate from {@link formatTokensCompact}: request /
     * message counts keep their compact, trimmed style and must not change.
     */
    function formatTokensPrecise(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value < 1e3) return String(Math.round(value))
      const units = [
        [1e12, 'T'],
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
      ]
      for (let index = 0; index < units.length; index += 1) {
        const [scale, suffix] = units[index]
        if (value < scale) continue
        const scaled = value / scale
        // Three-decimal rounding may carry into the next unit (999,999,999 → 1.000B).
        if (scaled >= 999.9995 && index > 0) {
          const [largerScale, largerSuffix] = units[index - 1]
          return `${(value / largerScale).toFixed(3)}${largerSuffix}`
        }
        return `${scaled.toFixed(3)}${suffix}`
      }
      return String(Math.round(value))
    }

    /** Request/message counts: localized below 10k, compact above. */
    function formatCount(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value >= 10000) return formatTokensCompact(value)
      try {
        return Math.round(value).toLocaleString()
      } catch {
        return String(Math.round(value))
      }
    }

    /** Money text: `¥2.26`, `$4.50`; unknown currencies fall back to Intl. */
    function formatMoney(amount, currency) {
      if (!Number.isFinite(amount)) return '—'
      const code = typeof currency === 'string' && currency !== '' ? currency.toUpperCase() : ''
      const symbol = CURRENCY_SYMBOLS[code]
      if (symbol !== undefined) return `${symbol}${amount.toFixed(2)}`
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: code === '' ? 'USD' : code,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(amount)
      } catch {
        return `${amount.toFixed(2)}${code === '' ? '' : ` ${code}`}`
      }
    }

    /**
     * Severity of one window: <70 normal, 70–89 warning, >=90 critical.
     * A non-ok upstream status is critical whatever the percentage says.
     */
    function levelOf(percent, status) {
      if (typeof status === 'string' && status !== '' && status !== OK_STATUS && status !== 'unknown') return 'critical'
      if (!Number.isFinite(percent)) return 'unknown'
      if (percent >= 90) return 'critical'
      if (percent >= 70) return 'warning'
      return 'normal'
    }

    const LEVEL_RANK = { unknown: 0, normal: 1, warning: 2, critical: 3 }

    /** The worse of two levels. */
    function worseLevel(a, b) {
      return (LEVEL_RANK[b] ?? 0) > (LEVEL_RANK[a] ?? 0) ? b : a
    }

    /** A reset countdown, live-ticking against `now`. */
    function formatReset(remainingMs, t) {
      if (!Number.isFinite(remainingMs)) return t('resetUnknown')
      if (remainingMs <= 0) return t('resettingNow')
      const total = Math.ceil(remainingMs / 1000)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const parts = []
      if (days > 0) parts.push(t('durationDay', { n: days }))
      if (hours > 0) parts.push(t('durationHour', { n: hours }))
      if (minutes > 0 && days === 0) parts.push(t('durationMinute', { n: minutes }))
      if (parts.length === 0) parts.push(t('durationSecond', { n: Math.max(1, seconds) }))
      return t('resetIn', { time: parts.join(' ') })
    }

    /** Local wall-clock text for an ISO timestamp. */
    function formatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const ms = Date.parse(iso)
      if (!Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch {
        return ''
      }
    }

    /** A coarse "how long ago" label. */
    function formatAge(ageMs, t) {
      if (!Number.isFinite(ageMs) || ageMs < 60000) return t('ageJustNow')
      const minutes = Math.floor(ageMs / 60000)
      if (minutes < 60) return t('ageMinutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('ageHours', { n: hours })
      return t('ageDays', { n: Math.floor(hours / 24) })
    }

    /** Reset time for one window, counting down from the message's `now`. */
    function remainingOf(window, loadedAt, now) {
      const resetsMs = typeof window.resetsAt === 'string' && window.resetsAt !== '' ? Date.parse(window.resetsAt) : NaN
      if (Number.isFinite(resetsMs)) return Math.max(0, resetsMs - now)
      if (Number.isFinite(window.remainingMs)) {
        const anchor = Number.isFinite(loadedAt) && loadedAt > 0 ? loadedAt : now
        return Math.max(0, window.remainingMs - (now - anchor))
      }
      return null
    }

    /** The wall-clock reset moment as `YYYY/MM/DD HH:mm` (local), or null. */
    function resetDateOf(window, loadedAt, now) {
      if (window === null || typeof window !== 'object') return null
      let ms = typeof window.resetsAt === 'string' && window.resetsAt !== '' ? Date.parse(window.resetsAt) : NaN
      if (!Number.isFinite(ms) && Number.isFinite(window.remainingMs)) {
        const anchor = Number.isFinite(loadedAt) && loadedAt > 0 ? loadedAt : now
        ms = anchor + window.remainingMs
      }
      if (!Number.isFinite(ms)) return null
      try {
        return new Date(ms).toLocaleString(undefined, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return null
      }
    }

    // ---------------------------------------------------------------------
    // Wire normalization (defensive: every field may be missing or wrong).
    // ---------------------------------------------------------------------

    /** Normalize a wire window; `null` stays `null` (the provider cannot report it). */
    function normalizeWindow(id, raw) {
      if (raw === null || typeof raw !== 'object') return null
      return {
        id,
        percent: clampPercent(raw.percent),
        status: typeof raw.status === 'string' && raw.status !== '' ? raw.status : 'unknown',
        resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
        remainingMs: Number.isFinite(raw.remainingMs) ? raw.remainingMs : null,
        // Provider-native capacity (e.g. Command Code USD): shown only when all
        // three fields are usable, so an unsized window never renders "$undefined".
        used: numberOrNull(raw.used),
        cap: numberOrNull(raw.cap),
        unit: typeof raw.unit === 'string' && raw.unit !== '' ? raw.unit : '',
      }
    }

    /** A provider description from the wire. */
    function normalizeProvider(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const id = stringOrEmpty(source.id)
      const label = stringOrEmpty(source.label) || PROVIDER_LABELS[id] || id
      const kind = source.kind === 'windows' || source.kind === 'balance' ? source.kind : 'unknown'
      return { id, label, kind }
    }

    /** A plan description (`{id,label}`) or null. */
    function normalizePlan(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const label = stringOrEmpty(raw.label) || stringOrEmpty(raw.id)
      if (label === '') return null
      return { id: stringOrEmpty(raw.id), label }
    }

    /** The `{amount, currency, granted, toppedUp}` balance (+ wallets for account providers), or null. */
    function normalizeBalance(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const amount = numberOrNull(raw.amount)
      if (amount === null) return null
      const walletList = (list) =>
        Array.isArray(list)
          ? list
              .filter((entry) => entry !== null && typeof entry === 'object')
              .map((entry) => ({ currency: stringOrEmpty(entry.currency), amount: numberOrNull(entry.amount) }))
              .filter((entry) => entry.amount !== null)
          : []
      return {
        amount,
        currency: stringOrEmpty(raw.currency),
        granted: numberOrNull(raw.granted),
        toppedUp: numberOrNull(raw.toppedUp),
        wallets: walletList(raw.wallets),
        bonus: walletList(raw.bonus),
      }
    }

    /** The `{remaining, granted, purchased}` credits, or null when nothing is known. */
    function normalizeCredits(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const credits = {
        remaining: numberOrNull(raw.remaining),
        granted: numberOrNull(raw.granted),
        purchased: numberOrNull(raw.purchased),
      }
      if (credits.remaining === null && credits.granted === null && credits.purchased === null) return null
      return credits
    }

    /** The `{name, userName}` account display info, or null. */
    function normalizeAccount(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const name = stringOrEmpty(raw.name)
      const userName = stringOrEmpty(raw.userName)
      if (name === '' && userName === '') return null
      return { name, userName }
    }

    /** The `{console}` provider web links (v0.5.2 wire), or null when unknown. */
    function normalizeLinks(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const url = typeof raw.console === 'string' ? raw.console.trim() : ''
      // Only real web URLs: a junk/protocol-relative value must never become an
      // anchor href (no `javascript:` and no relative navigation).
      if (!/^https?:\/\//i.test(url)) return null
      return { console: url }
    }

    /** The whole wire snapshot, or null. */
    function normalizeSnapshot(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const windows = raw.windows !== null && typeof raw.windows === 'object' ? raw.windows : null
      const normalizedWindows =
        windows === null
          ? null
          : {
              rolling: normalizeWindow('rolling', windows.rolling),
              weekly: normalizeWindow('weekly', windows.weekly),
              monthly: normalizeWindow('monthly', windows.monthly),
            }
      return {
        version: Number.isFinite(raw.version) ? raw.version : 0,
        provider: normalizeProvider(raw.provider),
        plan: normalizePlan(raw.plan),
        windows: normalizedWindows,
        balance: normalizeBalance(raw.balance),
        credits: normalizeCredits(raw.credits),
        account: normalizeAccount(raw.account),
        links: normalizeLinks(raw.links),
        fetchedAt: stringOrEmpty(raw.fetchedAt),
        ageMs: Number.isFinite(raw.ageMs) ? raw.ageMs : null,
        stale: raw.stale === true,
        source: stringOrEmpty(raw.source),
      }
    }

    /** One provider from the management list, or null when it has no usable id. */
    function normalizeProviderEntry(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const providerId = (stringOrEmpty(raw.providerId) || stringOrEmpty(raw.id)).trim()
      if (providerId === '') return null
      const label = (stringOrEmpty(raw.label) || PROVIDER_LABELS[providerId] || providerId).trim()
      // v0.10.0 wire carries the compact brand too; an old Host omits it, so fall
      // back to the local catalog (and finally to the full label).
      const wireShort = (stringOrEmpty(raw.shortLabel) || '').trim()
      const mappedShort = PROVIDER_SHORT_LABELS[canonicalProviderId(providerId)] ?? PROVIDER_SHORT_LABELS[providerId]
      const shortLabel = wireShort !== '' ? wireShort : (mappedShort ?? (label === '' ? providerId : label))
      // v0.13.0: the Host flags providers whose route already lives in the DSH
      // model settings (`dshManaged`, plus the route id for the hint). Both the
      // flag and a usable route id are required; a missing hint (an older Host, or
      // a partial payload) reads as "not managed", and the editor then explains
      // how to add that route instead of offering any credential input.
      const wireDshProviderId = (stringOrEmpty(raw.dshProviderId) || '').trim()
      const dshManaged = raw.dshManaged === true && wireDshProviderId !== ''
      // v0.16.0: user-declared custom adapters are flagged `custom:true` (and are
      // no longer builtin). The Host currently returns only the display/credential
      // hints, so the optional declaration tail is normalized defensively: a Host
      // that later echoes the definition makes the edit form prefilled for free.
      return {
        providerId,
        label: label === '' ? providerId : label,
        shortLabel,
        kind: raw.kind === 'windows' || raw.kind === 'balance' ? raw.kind : 'unknown',
        enabled: raw.enabled !== false,
        hasKey: raw.hasKey === true,
        keySource: (stringOrEmpty(raw.keySource) || 'none').trim(),
        consoleUrl: stringOrEmpty(raw.consoleUrl).trim(),
        builtin: raw.builtin === true,
        custom: raw.custom === true,
        // v0.23.0: the Host detects a plan/quota subscription from the last
        // successful snapshot (a plan id or a real numeric percentage window).
        // Anything but an explicit `true` reads as "not subscribed".
        subscribed: raw.subscribed === true,
        note: stringOrEmpty(raw.note).trim(),
        apiKeyRef: stringOrEmpty(raw.apiKeyRef).trim(),
        baseURL: stringOrEmpty(raw.baseURL).trim(),
        usagePath: stringOrEmpty(raw.usagePath).trim(),
        amountPath: stringOrEmpty(raw.amountPath).trim(),
        currency: stringOrEmpty(raw.currency).trim(),
        grantedPath: stringOrEmpty(raw.grantedPath).trim(),
        toppedUpPath: stringOrEmpty(raw.toppedUpPath).trim(),
        percentScale: raw.percentScale === 'fraction' ? 'fraction' : 'percent',
        windows: normalizeCustomWindows(raw.windows),
        dshManaged,
        dshProviderId: dshManaged ? wireDshProviderId : '',
      }
    }

    /** The `{rolling,weekly,monthly}` percent/reset paths of a custom windows adapter, or null. */
    function normalizeCustomWindows(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const windows = {}
      let found = false
      for (const id of WINDOW_ORDER) {
        const entry = raw[id]
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const percentPath = stringOrEmpty(entry.percentPath).trim()
        if (percentPath === '') continue
        windows[id] = { percentPath, resetPath: stringOrEmpty(entry.resetPath).trim() }
        found = true
      }
      return found ? windows : null
    }

    /** The chip-brand style of the providers payload; junk/absent values mean `short`. */
    function normalizeLabelStyle(raw) {
      return raw === 'full' ? 'full' : 'short'
    }

    /** One `defaultView` setting: 'chart' | 'data' (junk means the chart default). */
    function normalizeDisplayView(raw) {
      return raw === 'data' ? 'data' : 'chart'
    }

    /** One `defaultScope` setting: 'provider' | 'all' (junk means the provider default). */
    function normalizeDisplayScope(raw) {
      return raw === 'all' ? 'all' : 'provider'
    }

    /** One `detailsExpanded` setting: 'auto' | 'expanded' | 'collapsed'. */
    function normalizeDetailsExpanded(raw) {
      return raw === 'expanded' || raw === 'collapsed' ? raw : 'auto'
    }

    /** One `detailsWindow` setting: 'today' | 'last7Days' | 'second' | 'total' (junk means 总计). */
    function normalizeDetailsWindow(raw) {
      return raw === 'today' || raw === 'last7Days' || raw === 'second' ? raw : 'total'
    }

    /**
     * The five display settings of the `providers` payload (v0.29.0; the 明细
     * donut window joined them in v1.2.1), every field normalized to a usable
     * value so old Hosts keep the previous defaults.
     */
    function normalizePluginSettings(raw) {
      const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      return {
        labelStyle: normalizeLabelStyle(source.labelStyle),
        defaultView: normalizeDisplayView(source.defaultView),
        defaultScope: normalizeDisplayScope(source.defaultScope),
        detailsExpanded: normalizeDetailsExpanded(source.detailsExpanded),
        detailsWindow: normalizeDetailsWindow(source.detailsWindow),
      }
    }

    /**
     * One route discovered in the DSH model settings (v0.15.0), or null when it
     * has no usable id. `supported` plus a `usageProviderId` means the plugin has
     * a usage adapter for this route; a route without one is listed read-only.
     */
    function normalizeDshProviderEntry(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const providerId = (stringOrEmpty(raw.providerId) || stringOrEmpty(raw.id)).trim()
      if (providerId === '') return null
      const label = (stringOrEmpty(raw.label) || providerId).trim()
      const usageProviderId = (stringOrEmpty(raw.usageProviderId) || '').trim()
      const supported = raw.supported === true && usageProviderId !== ''
      return {
        providerId,
        label: label === '' ? providerId : label,
        supported,
        usageProviderId: supported ? usageProviderId : '',
      }
    }

    /** Dedupe a provider list by `providerId` (last entry wins, first position kept). */
    function dedupeByProviderId(items) {
      const byId = new Map()
      for (const item of items) {
        if (item === null || item === undefined || typeof item !== 'object') continue
        const providerId = stringOrEmpty(item.providerId).trim()
        if (providerId === '') continue
        byId.set(providerId, item)
      }
      return [...byId.values()]
    }

    /**
     * The `{providers, dshProviders, settings, storeFile}` management payload;
     * junk lists collapse to empty. `labelCatalog` caches the wire labels per
     * provider so the chip can resolve a brand before the page is ever opened.
     * `dshProviders` (v0.15.0) is every route in the DSH model settings; an old
     * Host omits it and the page falls back to the flat preset list.
     */
    function normalizeProvidersPayload(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      const list = Array.isArray(raw.providers) ? raw.providers : []
      const providers = []
      const labelCatalog = {}
      for (const entry of list) {
        const provider = normalizeProviderEntry(entry)
        if (provider === null) continue
        providers.push(provider)
        labelCatalog[provider.providerId] = { label: provider.label, shortLabel: provider.shortLabel }
        const canonical = canonicalProviderId(provider.providerId)
        if (typeof canonical === 'string' && canonical !== '' && labelCatalog[canonical] === undefined) {
          labelCatalog[canonical] = { label: provider.label, shortLabel: provider.shortLabel }
        }
      }
      const dshProviders = Array.isArray(raw.dshProviders)
        ? raw.dshProviders.map((entry) => normalizeDshProviderEntry(entry)).filter((entry) => entry !== null)
        : []
      const settings = raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : {}
      return {
        // v0.17.0 identity: dedupe by providerId, last-wins, so the filter tabs
        // never list the same provider twice even if the Host sends a duplicate.
        providers: dedupeByProviderId(providers),
        dshProviders: dedupeByProviderId(dshProviders),
        // Whether this Host knows about DSH model-settings discovery at all. A
        // present-but-empty array means "new Host, no DSH routes configured", so
        // the page shows the 已配置 empty state instead of the legacy flat list.
        hasDshProviders: Array.isArray(raw.dshProviders),
        storeFile: stringOrEmpty(raw.storeFile).trim(),
        storeFileDisplay: stringOrEmpty(raw.storeFileDisplay).trim(),
        settings: normalizePluginSettings(settings),
        labelCatalog,
      }
    }

    /** Whether this provider reads a DSH-managed account instead of a stored API key. */
    function providerUsesAccountService(provider) {
      return (
        provider !== null &&
        typeof provider === 'object' &&
        (provider.providerId === 'deepseek-account' || provider.keySource === 'service')
      )
    }

    /**
     * Whether the provider's key + base URL are inherited from a route already
     * configured in the DSH model settings (v0.13.0). Such a provider needs no
     * key or endpoint in this page, and missing hints read as "not managed".
     */
    function providerUsesDshModelSettings(provider) {
      return (
        provider !== null &&
        typeof provider === 'object' &&
        provider.dshManaged === true &&
        typeof provider.dshProviderId === 'string' &&
        provider.dshProviderId.trim() !== ''
      )
    }

    /** One stats bucket, all six counters. */
    function normalizeBucket(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const bucket = {
        input: numberOrNull(source.input) ?? 0,
        output: numberOrNull(source.output) ?? 0,
        cacheRead: numberOrNull(source.cacheRead) ?? 0,
        cacheWrite: numberOrNull(source.cacheWrite) ?? 0,
        total: numberOrNull(source.total) ?? 0,
        messages: numberOrNull(source.messages) ?? 0,
      }
      if (bucket.total === 0) {
        const summed = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite
        if (summed > 0) bucket.total = summed
      }
      return bucket
    }

    /** A nullable bucket: `null` when the wire omits it (older Hosts, absent splits). */
    function normalizeOptionalBucket(raw) {
      return raw !== null && raw !== undefined && typeof raw === 'object' ? normalizeBucket(raw) : null
    }

    /** A `{today, last7Days, last30Days, allTime, sinceEffective}` triple, each field possibly absent. */
    function normalizeWindowTriple(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        today: normalizeOptionalBucket(source.today),
        // v0.30.0: the rolling 7-day window, optional on old Hosts.
        last7Days: normalizeOptionalBucket(source.last7Days),
        last30Days: normalizeOptionalBucket(source.last30Days),
        allTime: normalizeOptionalBucket(source.allTime),
        // v0.22.0: the provider's local effective window (from its first record).
        sinceEffective: normalizeOptionalBucket(source.sinceEffective),
      }
    }

    /**
     * The local 0..23 hour histogram of one daily entry (v1.2.0), or null when
     * the wire omits it (old Hosts). Anything but a length-24 array is treated
     * as unsupported; a non-finite / negative slot degrades to 0 so hostile data
     * can never poison the chart.
     */
    function normalizeHourHistogram(raw) {
      if (!Array.isArray(raw) || raw.length !== 24) return null
      return raw.map((value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0))
    }

    /** One provider attribution row (stats v3 aggregates DSH + ZCode per provider). */
    function normalizeProviderRow(entry) {
      const providerId = stringOrEmpty(entry.providerId)
      const today = normalizeOptionalBucket(entry.today)
      // v0.30.13: the Host reports the rolling 5-hour window on every provider row.
      const fiveHours = normalizeOptionalBucket(entry.fiveHours)
      const last7Days = normalizeOptionalBucket(entry.last7Days)
      const last30Days = normalizeOptionalBucket(entry.last30Days)
      const allTime = normalizeOptionalBucket(entry.allTime)
      // v0.22.0 provider-scoped window: the Host reports the effective day and
      // the inclusive day count, plus the matching token bucket.
      const sinceEffective = normalizeOptionalBucket(entry.sinceEffective)
      const effectiveDay = stringOrEmpty(entry.effectiveDay).trim()
      const effectiveDays = Number.isFinite(entry.effectiveDays) && entry.effectiveDays >= 1
        ? Math.floor(entry.effectiveDays)
        : null
      const splits = entry.harnesses !== null && typeof entry.harnesses === 'object' ? entry.harnesses : {}
      // The harness set is arbitrary: keep every split key the Host sent.
      const harnesses = {}
      for (const [harnessId, split] of Object.entries(splits)) {
        if (harnessId === '' || split === null || typeof split !== 'object') continue
        harnesses[harnessId] = normalizeWindowTriple(split)
      }
      // A legacy (v1/v2) provider row is DSH-only: give it the DSH split so the
      // provider-scope harness breakdown can still name where the tokens came from.
      if (Object.keys(harnesses).length === 0) {
        harnesses.dsh = { today, fiveHours, last7Days, last30Days, allTime, sinceEffective }
      }
      return {
        providerId,
        label: stringOrEmpty(entry.label) || PROVIDER_LABELS[providerId] || providerId,
        today,
        fiveHours,
        last7Days,
        last30Days,
        allTime,
        sinceEffective,
        effectiveDay,
        effectiveDays,
        // v0.22.1: only subscription-backed providers use the 最近X天 window.
        subscribed: entry.subscribed === true,
        harnesses,
      }
    }

    /** The display label of one harness: wire label first, known names, then the raw id. */
    function harnessLabel(harnessId, wireLabel) {
      const fromWire = stringOrEmpty(wireLabel)
      if (fromWire !== '') return fromWire
      if (typeof harnessId === 'string' && HARNESS_LABELS[harnessId] !== undefined) return HARNESS_LABELS[harnessId]
      return typeof harnessId === 'string' && harnessId !== '' ? harnessId : '—'
    }

    /** One harness row (any harness id) with its three windows. */
    function normalizeHarness(raw, fallbackId) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const harnessId = stringOrEmpty(source.harnessId) || fallbackId
      return {
        harnessId,
        label: harnessLabel(harnessId, source.label),
        today: normalizeOptionalBucket(source.today),
        last7Days: normalizeOptionalBucket(source.last7Days),
        last30Days: normalizeOptionalBucket(source.last30Days),
        allTime: normalizeOptionalBucket(source.allTime),
        // Defensive: the Host currently puts the effective window on the provider
        // splits, but a top-level harness row may carry it in the future.
        sinceEffective: normalizeOptionalBucket(source.sinceEffective),
        missing: source.missing === true || source.error?.code === 'harness-missing',
        error:
          source.error !== null && source.error !== undefined && typeof source.error === 'object'
            ? normalizeError(source.error)
            : null,
      }
    }

    /** The whole stats payload, or null. Handles v1/v2 (DSH-ish) and v3 (provider-scoped). */
    function normalizeStats(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const version = Number.isFinite(raw.version) ? raw.version : 1
      const today = normalizeOptionalBucket(raw.today)
      const last7Days = normalizeOptionalBucket(raw.last7Days)
      const last30Days = normalizeOptionalBucket(raw.last30Days)
      const allTime = normalizeOptionalBucket(raw.allTime)
      const providers = Array.isArray(raw.providers)
        ? raw.providers
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => normalizeProviderRow(entry))
        : []
      const models = Array.isArray(raw.models)
        ? raw.models
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => ({
              key: stringOrEmpty(entry.key),
              providerId: stringOrEmpty(entry.providerId),
              modelId: stringOrEmpty(entry.modelId) || stringOrEmpty(entry.key) || '—',
              today: normalizeOptionalBucket(entry.today),
              last7Days: normalizeOptionalBucket(entry.last7Days),
              last30Days: normalizeOptionalBucket(entry.last30Days),
              allTime: normalizeOptionalBucket(entry.allTime),
              // v0.22.0: model rows follow the provider's effective window.
              sinceEffective: normalizeOptionalBucket(entry.sinceEffective),
            }))
        : []
      // v2/v3 carry a harness list. A v1 payload (no `harnesses` key) is DSH-only,
      // so synthesize the single DSH row from the old top-level buckets: older
      // Hosts keep rendering, with the harness breakdown showing just DSH.
      const harnesses = Array.isArray(raw.harnesses)
        ? raw.harnesses
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => normalizeHarness(entry, ''))
        : [{ harnessId: 'dsh', label: 'DSH', today, last7Days, last30Days, allTime, sinceEffective: null, error: null }]
      const zcodeSource = raw.zcode !== null && raw.zcode !== undefined && typeof raw.zcode === 'object' ? raw.zcode : null
      const mapProviderRows = (list) =>
        Array.isArray(list)
          ? list
              .filter((entry) => entry !== null && typeof entry === 'object')
              .map((entry) => normalizeProviderRow(entry))
          : []
      // v0.24.0: the Host reports a per-day token series (ascending, <=120 days)
      // for the chart mode. Every field is normalized defensively.
      // v1.2.0: each day (and each provider split of that day) may also carry
      // the local 0..23 hour histogram used by the chart drill-down.
      const daily = Array.isArray(raw.daily)
        ? raw.daily
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => {
              const providerRaw =
                entry.providers !== null && typeof entry.providers === 'object' && !Array.isArray(entry.providers)
                  ? entry.providers
                  : {}
              const dailyProviders = {}
              for (const [providerId, bucketRaw] of Object.entries(providerRaw)) {
                if (providerId === '' || bucketRaw === null || typeof bucketRaw !== 'object') continue
                dailyProviders[providerId] = {
                  ...normalizeBucket(bucketRaw),
                  hours: normalizeHourHistogram(bucketRaw.hours),
                }
              }
              const day = stringOrEmpty(entry.day).trim()
              return {
                day,
                total: normalizeOptionalBucket(entry.total),
                hours: normalizeHourHistogram(entry.hours),
                providers: dailyProviders,
              }
            })
            .filter((entry) => entry.day !== '')
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        : []
      const zcode =
        zcodeSource === null
          ? null
          : {
              available: zcodeSource.available === true,
              error:
                zcodeSource.error !== null && zcodeSource.error !== undefined && typeof zcodeSource.error === 'object'
                  ? normalizeError(zcodeSource.error)
                  : null,
              rows: Number.isFinite(zcodeSource.rows) ? zcodeSource.rows : null,
              cached: zcodeSource.cached === true,
              // v3 splits mapped/unmapped; v2 had a single `providers` list.
              mappedProviders: mapProviderRows(zcodeSource.mappedProviders ?? zcodeSource.providers),
              unmapped: mapProviderRows(zcodeSource.unmapped),
            }
      // Experimental (sidebar badge): per-workspace DSH usage. Each row carries
      // today / 最近7天 / 最近30天 buckets plus the all-time total/messages.
      const workspaces = Array.isArray(raw.workspaces)
        ? raw.workspaces
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => ({
              workspaceId:
                entry.workspaceId === null || entry.workspaceId === undefined ? null : stringOrEmpty(entry.workspaceId),
              label: stringOrEmpty(entry.label),
              path: stringOrEmpty(entry.path),
              today: normalizeWorkspaceBucket(entry.today),
              last7Days: normalizeWorkspaceBucket(entry.last7Days),
              last30Days: normalizeWorkspaceBucket(entry.last30Days),
              total: Number.isFinite(entry.total) ? entry.total : 0,
              messages: Number.isFinite(entry.messages) ? entry.messages : 0,
            }))
        : []
      return {
        version,
        generatedAt: stringOrEmpty(raw.generatedAt),
        timezone: stringOrEmpty(raw.timezone),
        day: stringOrEmpty(raw.day),
        last30DaysStart: stringOrEmpty(raw.last30DaysStart),
        today,
        last7Days,
        last30Days,
        allTime,
        harnesses,
        // Enabled harnesses whose local store is gone (uninstalled). The Host
        // omits their rows by default, so the dialog can explain the absence.
        missingHarnesses: Array.isArray(raw.missingHarnesses)
          ? raw.missingHarnesses.filter((entry) => typeof entry === 'string' && entry !== '')
          : [],
        providers,
        models,
        // Experimental: per-workspace all-time totals for the sidebar badge.
        workspaces,
        // v0.24.0 daily series for the chart mode (may be empty on old Hosts).
        daily,
        zcode,
      }
    }

    /** One harness row by id, or null. */
    function harnessOf(stats, harnessId) {
      if (stats === null) return null
      return stats.harnesses.find((harness) => harness.harnessId === harnessId) ?? null
    }

    /** Localized label for a window id. */
    function rowLabel(id, t) {
      if (id === 'rolling') return t('rowRolling')
      if (id === 'weekly') return t('rowWeekly')
      return t('rowMonthly')
    }

    /** Localized compact chip label for a window id. */
    function chipLabelFor(id, t) {
      if (id === 'rolling') return t('chipRolling')
      if (id === 'weekly') return t('chipWeekly')
      return t('chipMonthly')
    }

    /** The provider display label: wire label first, then a known catalog label. */
    function providerLabelOf(snapshot, providerId) {
      const wireLabel = snapshot?.provider?.label
      if (typeof wireLabel === 'string' && wireLabel !== '') return wireLabel
      const id = snapshot?.provider?.id !== undefined && snapshot?.provider?.id !== '' ? snapshot.provider.id : providerId
      if (typeof id === 'string' && id !== '') return PROVIDER_LABELS[id] ?? id
      return ''
    }

    /**
     * The `{short, full}` labels of a provider (v0.10.0).
     *
     * Wire labels cached from the providers payload win, then the local catalog,
     * then the snapshot / raw id. Both fields are always usable strings, so the
     * chip never renders an empty brand.
     */
    function providerLabelsFor(snapshot, providerId, labelCatalog) {
      const rawId =
        snapshot?.provider?.id !== undefined && snapshot?.provider?.id !== '' ? snapshot.provider.id : providerId
      const id = typeof rawId === 'string' ? rawId : ''
      const canonical = typeof id === 'string' && id !== '' ? canonicalProviderId(id) : ''
      const catalog = labelCatalog !== null && typeof labelCatalog === 'object' ? labelCatalog : {}
      const entry =
        (canonical !== '' && catalog[canonical] !== undefined && catalog[canonical] !== null ? catalog[canonical] : null) ??
        (id !== '' && catalog[id] !== undefined && catalog[id] !== null ? catalog[id] : null)
      const wireFull = typeof entry?.label === 'string' && entry.label !== '' ? entry.label : ''
      const wireShort = typeof entry?.shortLabel === 'string' && entry.shortLabel !== '' ? entry.shortLabel : ''
      const snapshotFull = typeof snapshot?.provider?.label === 'string' ? snapshot.provider.label : ''
      const mappedFull =
        (canonical !== '' ? PROVIDER_LABELS[canonical] : undefined) ?? (id !== '' ? PROVIDER_LABELS[id] : undefined)
      const full = wireFull || snapshotFull || mappedFull || id || '—'
      const mappedShort =
        (canonical !== '' ? PROVIDER_SHORT_LABELS[canonical] : undefined) ??
        (id !== '' ? PROVIDER_SHORT_LABELS[id] : undefined)
      const short = wireShort || mappedShort || full
      return { short, full }
    }

    /** The composer-chip brand for the chosen label style (v0.10.0, default `short`). */
    function providerBrand(state, snapshot) {
      const labels = providerLabelsFor(snapshot, state?.providerId, state?.labelCatalog)
      return state?.labelStyle === 'full' ? labels.full : labels.short
    }

    /** The provider's console/usage URL from the wire snapshot, or '' when unknown. */
    function consoleUrlFor(snapshot) {
      const url = snapshot?.links?.console
      return typeof url === 'string' && url !== '' ? url : ''
    }

    /** The provider-aware label of the footer console link. */
    function consoleLabelFor(snapshot, providerId, t) {
      const rawId = snapshot?.provider?.id !== undefined && snapshot?.provider?.id !== '' ? snapshot.provider.id : providerId
      const id = canonicalProviderId(rawId)
      if (id === 'commandcode') return t('consoleLinkCommandCode')
      if (id === 'deepseek' || id === 'deepseek-account') return t('consoleLinkDeepSeek')
      const label = providerLabelOf(snapshot, providerId)
      if (label !== '') return t('consoleLinkProvider', { provider: label })
      return t('consoleLink')
    }

    /** `5 小时 8% · 本周 24% · 本月 32%` — the windows chip's hover detail. */
    function windowsSummaryText(windows, t) {
      return WINDOW_ORDER.map((id) => `${rowLabel(id, t)} ${formatPercent(windows?.[id]?.percent ?? null, t)}`).join(' · ')
    }

    /** Localized copy for one wire error code. */
    function describeError(error, t) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      switch (code) {
        case 'missing-key':
          return t('errorMissingKey')
        case 'unsupported-provider':
          return t('errorUnsupportedProvider')
        case 'disabled':
          return t('errorDisabled')
        case 'unauthorized':
          return t('errorUnauthorized')
        case 'forbidden':
          return t('errorForbidden')
        case 'network':
          return t('errorNetwork')
        case 'timeout':
          return t('errorTimeout')
        case 'http':
          return t('errorHttp')
        case 'parse':
          return t('errorParse')
        case 'rate-limited':
          return t('errorRateLimited')
        case 'stats-unavailable':
          return t('errorStatsUnavailable')
        case 'bridge':
          return t('errorBridge')
        case 'internal':
          return t('errorInternal')
        default:
          return t('errorGeneric', { code })
      }
    }

    // ---------------------------------------------------------------------
    // Host bridge + shared store.
    // ---------------------------------------------------------------------

    /**
     * One request to the Host half.
     *
     * The URL is document-relative on purpose: the desktop shell serves the page
     * from `dsh-app://app/` and forwards every non-asset path to the Host with
     * the authentication cookie, while a browser tab at the `dsh web` URL
     * resolves the same path against that origin. The route rides Connection's
     * `/api` fence, so it needs no header or token of ours.
     */
    async function call(payload) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (error) {
        throw new Error(`bridge unreachable: ${String(error?.message ?? error)}`)
      }
      const text = await response.text()
      if (response.ok !== true) {
        // Keep the whole body on the error: the Host answers validation failures
        // (e.g. a label longer than 40 chars) with HTTP 500 *and* a cached
        // snapshot, so the JSON envelope can be longer than the message preview.
        // `managementErrorOf` parses `error.body` to recover the wire error and
        // render its localized message instead of a truncated JSON blob.
        const failure = new Error(text.slice(0, 200) || `HTTP ${response.status}`)
        failure.body = text
        failure.status = response.status
        throw failure
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200) || 'empty bridge response')
      }
    }

    /** The page origin, for the Host's status diagnostics. */
    function shellOrigin() {
      try {
        return typeof location === 'undefined' ? '' : String(location.origin ?? '')
      } catch {
        return ''
      }
    }

    /** Whether a wire error must hide the chip (silent, per PROTOCOL.md). */
    function isHidden(error) {
      return error !== null && typeof error === 'object' && HIDDEN_CODES.has(error.code)
    }

    /** Normalize a wire error so the render code can trust it. */
    function normalizeError(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const code = typeof source.code === 'string' && source.code !== '' ? source.code : 'internal'
      const knownRetryable =
        code !== 'missing-key' &&
        code !== 'unsupported-provider' &&
        code !== 'disabled' &&
        code !== 'unauthorized' &&
        code !== 'forbidden' &&
        code !== 'parse' &&
        code !== 'stats-unavailable'
      return {
        code,
        message: typeof source.message === 'string' ? source.message : '',
        status: Number.isSafeInteger(source.status) ? source.status : undefined,
        retryable: typeof source.retryable === 'boolean' ? source.retryable : knownRetryable,
      }
    }

    /** The transport-level failure shape (route missing, page not authorized, …). */
    function transportError(error) {
      return { code: 'bridge', message: String(error?.message ?? error ?? 'unknown bridge error'), retryable: true }
    }

    /** The provider-management page state (v0.9.0), kept apart from usage. */
    function defaultManagementState() {
      return {
        /** idle | loading | ready | error (of the provider LIST read). */
        phase: 'idle',
        providers: [],
        /** Every route in the DSH model settings (v0.15.0); empty on an old Host. */
        dshProviders: [],
        /** Whether the Host sent a `dshProviders` array at all (v0.17.0 capability flag). */
        hasDshProviders: false,
        /** Whether the secondary 「插件适配器」 section is expanded (collapsed by default). */
        presetOpen: false,
        /** The provider-list filter tab (v0.17.0): 'configured' | 'builtin' | 'all'. */
        filter: 'configured',
        /** The management section tab (v0.29.0): 'providers' | 'settings'. */
        tab: 'providers',
        storeFile: '',
        storeFileDisplay: '',
        error: null,
        loadedAt: 0,
        inFlight: false,
        /** The provider whose editor is expanded (one at a time). */
        editingId: null,
        /** Editor drafts per provider: `{consoleUrl, shortLabel, label}` (credentials never leave the Host). */
        drafts: {},
        /** In-flight action per provider: `saving` | `testing`. */
        busy: {},
        /** Test-connection outcome per provider: `{phase:'testing'}` / `{phase:'ok', snapshot}` / `{phase:'error', error}`. */
        rowTest: {},
        /** Last mutation error per provider (a normalized wire error). */
        rowError: {},
        /** In-flight state of the global chip-label style selector (v0.10.0). */
        settingsBusy: false,
        /** Last settingsUpdate failure (a normalized wire error). */
        settingsError: null,
      }
    }

    const createStore = () => {
      let state = {
        // Provider reported by the session projection; null = "Host default".
        providerId: null,
        // Usage for the current provider.
        phase: 'idle', // idle | loading | ready | error
        snapshot: null,
        error: null,
        loadedAt: 0,
        lastAttemptAt: 0,
        inFlight: false,
        busyAction: null, // 'snapshot' | 'refresh' | null
        // Token statistics (global; independent loading/error state).
        statsPhase: 'idle', // idle | loading | ready | error
        stats: null,
        statsError: null,
        statsLoadedAt: 0,
        statsLastAttemptAt: 0,
        statsInFlight: false,
        // Scope of the local token cards: 'provider' = the selected provider's
        // cross-harness row; 'all' = all-harness totals. v0.29.0: initial and
        // reset values come from the persisted defaultScope setting.
        statsScope: DEFAULT_PLUGIN_SETTINGS.defaultScope,
        // v0.28.0 presentation of the token section: 'chart' (daily chart +
        // 明细 donuts) or 'data' (cards/details tables). v0.29.0: initial and
        // reset values come from the persisted defaultView setting.
        statsView: DEFAULT_PLUGIN_SETTINGS.defaultView,
        // v0.25.0 chart hover: the nearest bar index under the pointer, or null.
        // Reset on mouse leave and whenever the scope/view/provider changes.
        chartHover: null,
        // v1.2.0 chart drill-down: the clicked day whose 0..23 hour histogram
        // is charted instead of the daily trend, or null (daily trend).
        chartDay: null,
        // v1.2.0 明细 donut window: 'today' | 'last7Days' | 'second' | 'total'.
        // v1.2.1: persisted setting (the last choice survives reopening the dialog
        // and restarting DSH; the startup bootstrap loads it back).
        detailsWindow: DEFAULT_PLUGIN_SETTINGS.detailsWindow,
        // Provider management page (v0.9.0).
        view: 'usage', // 'usage' | 'management'
        management: defaultManagementState(),
        // Chip brand style (v0.10.0): 'short' (default) or the provider's full label.
        labelStyle: 'short',
        // v0.29.0 display defaults loaded from the `providers` settings payload.
        // The usage dialog's initial/reset state derives from these.
        defaultView: DEFAULT_PLUGIN_SETTINGS.defaultView,
        defaultScope: DEFAULT_PLUGIN_SETTINGS.defaultScope,
        detailsExpanded: DEFAULT_PLUGIN_SETTINGS.detailsExpanded,
        // Wire labels cached from the providers payload, keyed by providerId:
        // `{[providerId]: {label, shortLabel}}` — lets the chip resolve a brand
        // (and honor a persisted 'full' style) before the 管理 page is opened.
        labelCatalog: {},
        // Plugin version from the hello envelope (dialog footnote).
        pluginVersion: '',
        // Extra DSH-only detail blocks (provider split / top models). Collapsed by
        // default on short screens so the dialog fits without a scrollbar.
        showDetails:
          typeof window === 'undefined' || !Number.isFinite(window.innerHeight)
            ? true
            : window.innerHeight >= 820,
        // Dialog.
        dialogOpen: false,
        dialogSessionId: null,
      }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              /* a subscriber must not break the store */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }
    const store = createStore()

    /** Bumped whenever the selected provider changes; stale responses are dropped. */
    let usageEpoch = 0

    /**
     * The five display settings currently in effect (v0.29.0; the 明细 donut
     * window joined them in v1.2.1).
     */
    function currentPluginSettings() {
      const state = store.get()
      return {
        labelStyle: state.labelStyle === 'full' ? 'full' : 'short',
        defaultView: normalizeDisplayView(state.defaultView),
        defaultScope: normalizeDisplayScope(state.defaultScope),
        detailsExpanded: normalizeDetailsExpanded(state.detailsExpanded),
        detailsWindow: normalizeDetailsWindow(state.detailsWindow),
      }
    }

    /**
     * Whether the 明细 blocks start expanded: `expanded`/`collapsed` override the
     * legacy window-height heuristic of the `auto` default (v0.29.0).
     */
    function showDetailsFor(detailsExpanded) {
      if (detailsExpanded === 'expanded') return true
      if (detailsExpanded === 'collapsed') return false
      return typeof window === 'undefined' || !Number.isFinite(window.innerHeight)
        ? true
        : window.innerHeight >= 820
    }

    /** The usage-view fields the dialog resets to from the persisted settings. */
    function usageViewDefaultsPatch() {
      const settings = currentPluginSettings()
      return {
        statsView: settings.defaultView,
        statsScope: settings.defaultScope,
        showDetails: showDetailsFor(settings.detailsExpanded),
        // v1.2.1: the 明细 donut window is a persisted setting, so reopening the
        // dialog or switching provider keeps the last saved choice instead of
        // always snapping back to 总计 (detailsWindowOf still falls back when the
        // chosen window is absent from the stats payload).
        detailsWindow: settings.detailsWindow,
        chartHover: null,
        chartDay: null,
      }
    }

    /** Merge a patch into the management sub-state (usage state is untouched). */
    function patchManagement(patch) {
      const current = store.get().management
      store.set({ management: { ...current, ...patch } })
    }

    /** A copy of one keyed map with `key` set. */
    function mapWith(map, key, value) {
      return { ...map, [key]: value }
    }

    /** A copy of one keyed map without `key`. */
    function mapWithout(map, key) {
      const next = { ...map }
      delete next[key]
      return next
    }

    /** Build a bridge payload, omitting the provider when the Host should pick. */
    function usagePayload(action, providerId) {
      return providerId === null || providerId === undefined ? { action } : { action, providerId }
    }

    /** Build a stats payload (stats are global but the call reports the provider too). */
    function statsPayload(providerId, fresh) {
      const payload =
        providerId === null || providerId === undefined ? { action: 'stats' } : { action: 'stats', providerId }
      if (fresh === true) payload.fresh = true
      return payload
    }

    /** Open the detail dialog (remembering the session that asked, when known). */
    function openDialog(sessionId) {
      store.set({
        dialogOpen: true,
        dialogSessionId: typeof sessionId === 'string' ? sessionId : null,
        view: 'usage',
        // v0.29.0: the token section starts from the persisted display defaults
        // (defaultView / defaultScope / detailsExpanded).
        ...usageViewDefaultsPatch(),
      })
    }

    /** Close the detail dialog (the next open starts on the usage view). */
    function closeDialog() {
      // Pre-reset so the next open paints with the persisted defaults immediately.
      store.set({ dialogOpen: false, view: 'usage', ...usageViewDefaultsPatch() })
      stopManagementSync()
    }

    /**
     * Ask the Host for the current provider's snapshot (or a forced refresh).
     *
     * Returns a small outcome tag: `ok` / `envelope` (a wire error answered the
     * request) / `transport` (the route itself is unreachable) / `busy` /
     * `stale` (the provider changed while the request was in flight).
     * Never throws.
     */
    async function requestUsage(action) {
      const before = store.get()
      if (before.inFlight === true) return { kind: 'busy' }
      const providerId = before.providerId
      const epoch = usageEpoch
      store.set({
        inFlight: true,
        busyAction: action,
        lastAttemptAt: Date.now(),
        ...(before.snapshot === null ? { phase: 'loading' } : {}),
      })
      let data
      try {
        data = await call(usagePayload(action, providerId))
      } catch (error) {
        if (epoch !== usageEpoch) return { kind: 'stale' }
        const current = store.get()
        store.set({
          inFlight: false,
          busyAction: null,
          error: transportError(error),
          phase: current.snapshot === null ? 'error' : 'ready',
        })
        return { kind: 'transport' }
      }
      // A provider switch happened while this request was in flight: its answer
      // belongs to the old selection and must not paint over the new one.
      if (epoch !== usageEpoch) return { kind: 'stale' }
      const current = store.get()
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true && data.snapshot !== null && typeof data.snapshot === 'object') {
          store.set({
            inFlight: false,
            busyAction: null,
            error: null,
            snapshot: data.snapshot,
            phase: 'ready',
            loadedAt: Date.now(),
          })
          return { kind: 'ok' }
        }
        if (data.ok === false) {
          store.set({
            inFlight: false,
            busyAction: null,
            error: normalizeError(data.error),
            // The Host may return a stale snapshot together with the error; keep
            // the previous one otherwise so a transient failure does not blank
            // the numbers the user was reading.
            snapshot:
              data.snapshot !== null && typeof data.snapshot === 'object' ? data.snapshot : current.snapshot,
            phase: 'error',
          })
          return { kind: 'envelope' }
        }
      }
      store.set({
        inFlight: false,
        busyAction: null,
        error: { code: 'internal', message: 'unexpected bridge response', retryable: true },
        phase: current.snapshot === null ? 'error' : 'ready',
      })
      return { kind: 'transport' }
    }

    /**
     * Ask the Host for today/all-time token statistics.
     *
     * Stats have their own loading/error state: a stats failure must never hide
     * the usage content that is already on screen. Never throws.
     */
    async function requestStats(options = {}) {
      const before = store.get()
      if (before.statsInFlight === true) return { kind: 'busy' }
      store.set({
        statsInFlight: true,
        statsLastAttemptAt: Date.now(),
        ...(before.stats === null ? { statsPhase: 'loading' } : {}),
      })
      let data
      try {
        data = await call(statsPayload(store.get().providerId, options.fresh === true))
      } catch (error) {
        store.set({ statsInFlight: false, statsError: transportError(error), statsPhase: 'error' })
        return { kind: 'transport' }
      }
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true && data.stats !== null && typeof data.stats === 'object') {
          store.set({
            statsInFlight: false,
            statsError: null,
            stats: data.stats,
            statsPhase: 'ready',
            statsLoadedAt: Date.now(),
          })
          return { kind: 'ok' }
        }
        if (data.ok === false) {
          store.set({ statsInFlight: false, statsError: normalizeError(data.error), statsPhase: 'error' })
          return { kind: 'envelope' }
        }
      }
      store.set({
        statsInFlight: false,
        statsError: { code: 'internal', message: 'unexpected stats response', retryable: true },
        statsPhase: 'error',
      })
      return { kind: 'transport' }
    }

    // ---------------------------------------------------------------------
    // Provider management bridge actions (v0.9.0). Never throw.
    // ---------------------------------------------------------------------

    /**
     * A failed management call still carries the Host's wire error when the
     * route answered with a JSON body on a non-2xx status; recover its code so
     * the row shows the real reason instead of a raw JSON string.
     */
    function managementErrorOf(error) {
      const body = typeof error?.body === 'string' && error.body !== '' ? error.body : ''
      const text = body !== '' ? body : String(error?.message ?? '')
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object' && parsed.ok === false) return normalizeError(parsed.error)
        } catch {
          /* truncated or non-JSON: fall back to the transport shape */
        }
      }
      return transportError(error)
    }

    /**
     * Adopt the display settings and wire label cache of a providers payload
     * (v0.10.0, extended v0.29.0 with the plugin display defaults).
     *
     * `options.adoptDetailsWindow` is only set by the startup bootstrap: the
     * persisted 明细 window must be loaded once, but a plain settingsUpdate
     * answer must never repaint a just-clicked pill (the answer of an earlier
     * save would otherwise overwrite the last of a fast click series, v1.2.1).
     * The management list itself is applied by the caller, so a read-only
     * startup load can reuse this without touching the page state.
     */
    function adoptProvidersMeta(parsed, options = {}) {
      if (parsed === null || typeof parsed !== 'object') return
      const current = store.get()
      const patch = {}
      const settings = normalizePluginSettings(parsed.settings)
      if (current.labelStyle !== settings.labelStyle) patch.labelStyle = settings.labelStyle
      if (current.defaultView !== settings.defaultView) patch.defaultView = settings.defaultView
      if (current.defaultScope !== settings.defaultScope) patch.defaultScope = settings.defaultScope
      if (current.detailsExpanded !== settings.detailsExpanded) patch.detailsExpanded = settings.detailsExpanded
      if (options.adoptDetailsWindow === true && current.detailsWindow !== settings.detailsWindow) {
        patch.detailsWindow = settings.detailsWindow
      }
      if (parsed.labelCatalog !== null && typeof parsed.labelCatalog === 'object') {
        const catalog = { ...current.labelCatalog, ...parsed.labelCatalog }
        if (Object.keys(catalog).length > 0) patch.labelCatalog = catalog
      }
      if (Object.keys(patch).length > 0) store.set(patch)
    }

    /**
     * Read the providers payload once at controller startup (v0.10.0).
     *
     * Only the display style, the persisted 明细 window and the wire label
     * cache are adopted: the chip must honor a persisted 'full' style and the
     * dialog must restore the saved donut window before the 管理 page is ever
     * opened, while the page keeps its own lazy load. Silent on failure — an
     * old Host without the action (or an unreachable bridge) keeps the defaults.
     */
    async function bootstrapProviders() {
      let data
      try {
        data = await call({ action: 'providers' })
      } catch {
        return { kind: 'transport' }
      }
      if (data === null || typeof data !== 'object' || data.ok !== true) return { kind: 'envelope' }
      const parsed = normalizeProvidersPayload(data)
      if (parsed === null) return { kind: 'transport' }
      adoptProvidersMeta(parsed, { adoptDetailsWindow: true })
      return { kind: 'ok' }
    }

    /** Read the provider list for the management page. Never throws. */
    async function requestProviders() {
      const before = store.get().management
      if (before.inFlight === true) return { kind: 'busy' }
      const hasList = before.providers.length > 0 || before.dshProviders.length > 0
      patchManagement(hasList ? { inFlight: true } : { inFlight: true, phase: 'loading', error: null })
      let data
      try {
        data = await call({ action: 'providers' })
      } catch (error) {
        patchManagement({ inFlight: false, phase: 'error', error: managementErrorOf(error) })
        return { kind: 'transport' }
      }
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true) {
          const parsed = normalizeProvidersPayload(data)
          if (parsed !== null) adoptProvidersMeta(parsed)
          patchManagement({
            inFlight: false,
            phase: 'ready',
            error: null,
            providers: parsed !== null ? parsed.providers : [],
            dshProviders: parsed !== null ? parsed.dshProviders : [],
            hasDshProviders: parsed !== null ? parsed.hasDshProviders === true : false,
            storeFile: parsed !== null ? parsed.storeFile : '',
            storeFileDisplay: parsed !== null ? parsed.storeFileDisplay : '',
            loadedAt: Date.now(),
          })
          return { kind: 'ok' }
        }
        patchManagement({ inFlight: false, phase: 'error', error: normalizeError(data.error) })
        return { kind: 'envelope' }
      }
      patchManagement({
        inFlight: false,
        phase: 'error',
        error: { code: 'internal', message: 'unexpected providers response', retryable: true },
      })
      return { kind: 'transport' }
    }

    /**
     * Persist one provider edit (enable toggle, names, console URL) and adopt the
     * provider list the Host answers with. Never throws; failures land on the
     * row instead of the whole page.
     */
    async function requestProviderUpdate(providerId, update) {
      const before = store.get().management
      if (before.busy[providerId] !== undefined) return { kind: 'busy' }
      patchManagement({
        busy: mapWith(before.busy, providerId, 'saving'),
        rowError: mapWith(before.rowError, providerId, null),
      })
      let data
      try {
        data = await call({ action: 'providerUpdate', providerId, update })
      } catch (error) {
        const current = store.get().management
        patchManagement({
          busy: mapWithout(current.busy, providerId),
          rowError: mapWith(current.rowError, providerId, managementErrorOf(error)),
        })
        return { kind: 'transport' }
      }
      const current = store.get().management
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true) {
          const parsed = normalizeProvidersPayload(data)
          if (parsed !== null) {
            adoptProvidersMeta(parsed)
            // A successful save drops the saved endpoint draft so the next editor
            // seeds itself from the answered list. An enabled-only toggle keeps any
            // unsaved draft. A name-only save or 恢复默认名称 resets just the two
            // name fields, so an unsaved console-URL draft survives it.
            const hasField = (field) =>
              update !== null && typeof update === 'object' && Object.prototype.hasOwnProperty.call(update, field)
            const clearedDraft = hasField('consoleUrl')
            const resetNames = !clearedDraft && (hasField('shortLabel') || hasField('label'))
            const rowTest = { ...current.rowTest }
            delete rowTest[providerId]
            // Adopt the answered list; a Host that omits it must not blank the page.
            const adoptsList = Array.isArray(data.providers)
            let nextDrafts = current.drafts
            if (clearedDraft) {
              nextDrafts = mapWithout(current.drafts, providerId)
            } else if (resetNames) {
              const draft = current.drafts[providerId]
              const answered = adoptsList
                ? parsed.providers.find((entry) => entry.providerId === providerId)
                : undefined
              if (draft !== undefined && draft !== null && typeof draft === 'object') {
                nextDrafts = mapWith(current.drafts, providerId, {
                  ...draft,
                  shortLabel: answered !== undefined ? answered.shortLabel : draft.shortLabel,
                  label: answered !== undefined ? answered.label : draft.label,
                })
              }
            }
            patchManagement({
              busy: mapWithout(current.busy, providerId),
              providers: adoptsList ? parsed.providers : current.providers,
              // v0.15.0: the DSH discovery list travels with every providers
              // payload; a Host that omits it keeps the current one.
              dshProviders: Array.isArray(data.dshProviders) ? parsed.dshProviders : current.dshProviders,
              hasDshProviders: Array.isArray(data.dshProviders) ? true : current.hasDshProviders === true,
              storeFile: adoptsList ? parsed.storeFile : current.storeFile,
              storeFileDisplay: adoptsList ? parsed.storeFileDisplay : current.storeFileDisplay,
              phase: 'ready',
              error: null,
              loadedAt: Date.now(),
              drafts: nextDrafts,
              rowTest,
              rowError: mapWith(current.rowError, providerId, null),
            })
            return { kind: 'ok' }
          }
        }
        if (data.ok === false) {
          patchManagement({
            busy: mapWithout(current.busy, providerId),
            rowError: mapWith(current.rowError, providerId, normalizeError(data.error)),
          })
          return { kind: 'envelope' }
        }
      }
      patchManagement({
        busy: mapWithout(current.busy, providerId),
        rowError: mapWith(current.rowError, providerId, {
          code: 'internal',
          message: 'unexpected providerUpdate response',
          retryable: true,
        }),
      })
      return { kind: 'transport' }
    }

    /**
     * Persist one display-settings change (v0.29.0): the FULL five-field settings
     * object is always sent (the v1.2.1 明细 window included), because the Host
     * accepts any subset but the page keeps a single source of truth. The
     * answered payload's settings, wire labels and provider list are adopted.
     * Never throws.
     */
    async function requestSettingsUpdate(settings) {
      const next = normalizePluginSettings(settings)
      const before = store.get().management
      if (before.settingsBusy === true) return { kind: 'busy' }
      patchManagement({ settingsBusy: true, settingsError: null })
      let data
      try {
        data = await call({ action: 'settingsUpdate', settings: next })
      } catch (error) {
        patchManagement({ settingsBusy: false, settingsError: managementErrorOf(error) })
        return { kind: 'transport' }
      }
      const current = store.get().management
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true) {
          const parsed = normalizeProvidersPayload(data)
          if (parsed !== null) adoptProvidersMeta(parsed)
          const adoptsList = parsed !== null && Array.isArray(data.providers)
          patchManagement({
            settingsBusy: false,
            settingsError: null,
            ...(adoptsList
              ? {
                  providers: parsed.providers,
                  // v0.15.0: adopt the DSH discovery list when the Host sends it.
                  dshProviders: Array.isArray(data.dshProviders) ? parsed.dshProviders : current.dshProviders,
                  hasDshProviders: Array.isArray(data.dshProviders) ? true : current.hasDshProviders === true,
                  storeFile: parsed.storeFile,
                  storeFileDisplay: parsed.storeFileDisplay,
                  phase: 'ready',
                  error: null,
                  loadedAt: Date.now(),
                }
              : {}),
          })
          return { kind: 'ok' }
        }
        patchManagement({ settingsBusy: false, settingsError: normalizeError(data.error) })
        return { kind: 'envelope' }
      }
      patchManagement({
        settingsBusy: false,
        settingsError: { code: 'internal', message: 'unexpected settingsUpdate response', retryable: true },
      })
      return { kind: 'transport' }
    }

    /** Pending retry timer of the 明细-window save (a single timer, v1.2.1). */
    let detailsWindowSaveTimer = null

    /**
     * Persist the 明细 donut window choice (v1.2.1).
     *
     * The store field is also the persisted setting value, so a pill click saves
     * the FULL current settings through `settingsUpdate`. When another settings
     * request is still in flight, one 200ms retry timer keeps the LAST click of a
     * fast series (the earlier answer must not overwrite it: adoptProvidersMeta
     * ignores detailsWindow for non-bootstrap answers). The bridge answers
     * locally within a few milliseconds, so a single retry is enough. The Host's
     * answer then refreshes the provider list as usual.
     */
    function persistDetailsWindow() {
      if (detailsWindowSaveTimer !== null) {
        window.clearTimeout(detailsWindowSaveTimer)
        detailsWindowSaveTimer = null
      }
      if (store.get().management.settingsBusy === true) {
        detailsWindowSaveTimer = window.setTimeout(() => {
          detailsWindowSaveTimer = null
          if (store.get().management.settingsBusy === true) return
          void requestSettingsUpdate(currentPluginSettings())
        }, DETAILS_WINDOW_SAVE_RETRY_MS)
        return
      }
      void requestSettingsUpdate(currentPluginSettings())
    }

    /** Change one display setting; the other four keep their current values. */
    function savePluginSetting(field, value) {
      if (store.get().management.settingsBusy === true) return
      const next = { ...currentPluginSettings(), [field]: value }
      void requestSettingsUpdate(next)
    }

    /** 「恢复默认设置」: send the Host-side display defaults as one full payload. */
    function resetPluginSettings() {
      if (store.get().management.settingsBusy === true) return
      // v1.2.1: reset the persisted 明细 window locally too — a plain
      // settingsUpdate answer intentionally does not adopt that field.
      store.set({ detailsWindow: DEFAULT_PLUGIN_SETTINGS.detailsWindow })
      void requestSettingsUpdate({ ...DEFAULT_PLUGIN_SETTINGS })
    }

    /** Force one upstream read for a provider and keep the row outcome. Never throws. */
    async function requestProviderTest(providerId) {
      const before = store.get().management
      if (before.busy[providerId] !== undefined) return { kind: 'busy' }
      patchManagement({
        busy: mapWith(before.busy, providerId, 'testing'),
        rowTest: mapWith(before.rowTest, providerId, { phase: 'testing' }),
        rowError: mapWith(before.rowError, providerId, null),
      })
      let data
      try {
        data = await call({ action: 'providerTest', providerId })
      } catch (error) {
        const current = store.get().management
        patchManagement({
          busy: mapWithout(current.busy, providerId),
          rowTest: mapWith(current.rowTest, providerId, { phase: 'error', error: managementErrorOf(error) }),
        })
        return { kind: 'transport' }
      }
      const current = store.get().management
      if (data !== null && typeof data === 'object' && typeof data.ok === 'boolean') {
        if (data.ok === true) {
          patchManagement({
            busy: mapWithout(current.busy, providerId),
            rowTest: mapWith(current.rowTest, providerId, {
              phase: 'ok',
              snapshot: data.snapshot !== undefined ? data.snapshot : null,
            }),
          })
          return { kind: 'ok' }
        }
        patchManagement({
          busy: mapWithout(current.busy, providerId),
          rowTest: mapWith(current.rowTest, providerId, { phase: 'error', error: normalizeError(data.error) }),
        })
        return { kind: 'envelope' }
      }
      patchManagement({
        busy: mapWithout(current.busy, providerId),
        rowTest: mapWith(current.rowTest, providerId, {
          phase: 'error',
          error: { code: 'internal', message: 'unexpected providerTest response', retryable: true },
        }),
      })
      return { kind: 'transport' }
    }

    /**
     * Adopt a successful providers payload after a custom-adapter mutation
     * (v0.16.0): list, DSH discovery and store file in one patch.
     */
    function adoptProvidersList(data) {
      const parsed = normalizeProvidersPayload(data)
      if (parsed === null) return null
      adoptProvidersMeta(parsed)
      const current = store.get().management
      patchManagement({
        providers: parsed.providers,
        dshProviders: Array.isArray(data.dshProviders) ? parsed.dshProviders : current.dshProviders,
        hasDshProviders: Array.isArray(data.dshProviders) ? true : current.hasDshProviders === true,
        storeFile: parsed.storeFile,
        phase: 'ready',
        error: null,
        loadedAt: Date.now(),
      })
      return parsed
    }

    /** Delete one custom usage adapter (v0.16.0). Never throws. */
    async function requestCustomProviderDelete(providerId) {
      const before = store.get().management
      if (before.busy[providerId] !== undefined) return { kind: 'busy' }
      patchManagement({
        busy: mapWith(before.busy, providerId, 'deleting'),
        rowError: mapWith(before.rowError, providerId, null),
      })
      let data
      try {
        data = await call({ action: 'customProviderDelete', providerId })
      } catch (error) {
        const current = store.get().management
        patchManagement({
          busy: mapWithout(current.busy, providerId),
          rowError: mapWith(current.rowError, providerId, managementErrorOf(error)),
        })
        return { kind: 'transport' }
      }
      const current = store.get().management
      if (data !== null && typeof data === 'object' && data.ok === true) {
        adoptProvidersList(data)
        const after = store.get().management
        patchManagement({
          busy: mapWithout(after.busy, providerId),
          editingId: after.editingId === providerId ? null : after.editingId,
        })
        return { kind: 'ok' }
      }
      const failure =
        data !== null && typeof data === 'object' && data.ok === false
          ? normalizeError(data.error)
          : { code: 'internal', message: 'unexpected customProviderDelete response', retryable: true }
      patchManagement({
        busy: mapWithout(current.busy, providerId),
        rowError: mapWith(current.rowError, providerId, failure),
      })
      return { kind: 'envelope' }
    }

    // ---------------------------------------------------------------------
    // Provider management page events (all state lives in the shared store).
    // ---------------------------------------------------------------------

    /** The running management-page auto-sync controller, if any (v0.17.0). */
    let managementSyncDisposer = null

    /**
     * Start the provider-list auto-sync while the management page is open
     * (v0.17.0): poll every 15s, and refresh as soon as the page becomes visible
     * again or the window regains focus. Idempotent; the disposer is what
     * {@link stopManagementSync} calls.
     */
    function startManagementSync() {
      if (managementSyncDisposer !== null) return
      let timer = null
      const refreshIfVisible = () => {
        if (!isVisible()) return
        void requestProviders()
      }
      if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
        timer = window.setInterval(refreshIfVisible, MANAGEMENT_SYNC_MS)
      }
      const onVisibilityChange = () => {
        if (isVisible()) void requestProviders()
      }
      const onFocus = () => {
        void requestProviders()
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', onFocus)
      }
      managementSyncDisposer = () => {
        if (timer !== null && typeof window !== 'undefined' && typeof window.clearInterval === 'function') {
          window.clearInterval(timer)
        }
        timer = null
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('focus', onFocus)
        }
      }
    }

    /** Stop the management-page auto-sync (view closed, dialog closed or plugin disposed). */
    function stopManagementSync() {
      if (managementSyncDisposer === null) return
      const disposer = managementSyncDisposer
      managementSyncDisposer = null
      try {
        disposer()
      } catch {
        /* stopping the timer must never break a caller */
      }
    }

    /** Switch the provider-list filter tab (v0.17.0). */
    function setProviderFilter(filter) {
      const next = filter === 'builtin' || filter === 'all' ? filter : 'configured'
      if (store.get().management.filter !== next) patchManagement({ filter: next })
    }

    /** Switch the dialog body to the provider management page (loading lazily). */
    function openManagement() {
      store.set({ view: 'management' })
      // Every visit starts on the 供应商配置 tab and the 已配置 filter, with the
      // secondary preset section collapsed and any half-filled custom-adapter form
      // closed. While the page stays open the list auto-syncs so new DSH
      // model-settings routes appear by themselves.
      patchManagement({ tab: 'providers', presetOpen: false, filter: 'configured' })
      startManagementSync()
      const current = store.get().management
      const stale = current.loadedAt === 0 || Date.now() - current.loadedAt >= PROVIDERS_TTL_MS
      if (current.inFlight !== true && stale) void requestProviders()
    }

    /** Switch back to the usage page (the modal chrome stays). */
    function closeManagement() {
      // Returning from 管理 resets the token section to the persisted defaults.
      store.set({ view: 'usage', ...usageViewDefaultsPatch() })
      stopManagementSync()
    }

    /** Switch the management section tab: 'providers' | 'settings' (v0.29.0). */
    function setManagementTab(tab) {
      const next = tab === 'settings' ? 'settings' : 'providers'
      if (store.get().management.tab !== next) patchManagement({ tab: next })
    }

    /** Expand/collapse the secondary 「插件适配器（DSH 未配置）」 section (v0.15.0). */
    function togglePresetSection() {
      const current = store.get().management
      patchManagement({ presetOpen: current.presetOpen !== true })
    }

    /** The editor draft of one provider, seeded from the current wire values. */
    function providerDraftOf(provider, management) {
      const draft = management.drafts[provider.providerId]
      if (draft !== undefined && draft !== null && typeof draft === 'object') return draft
      return {
        consoleUrl: provider.consoleUrl,
        shortLabel: provider.shortLabel,
        label: provider.label,
      }
    }

    /**
     * Only the non-credential fields the user actually changed. The API key and
     * base URL are never edited here (v0.14.0): every provider inherits them from
     * the DSH model settings, so a providerUpdate from this page can only carry
     * an enable flag, the two names or the display-only console URL.
     */
    function providerUpdatePatch(provider, draft) {
      const source = draft !== null && typeof draft === 'object' ? draft : {}
      const update = {}
      const consoleUrl = typeof source.consoleUrl === 'string' ? source.consoleUrl.trim() : provider.consoleUrl
      if (consoleUrl !== provider.consoleUrl) update.consoleUrl = consoleUrl
      // v0.12.0 name overrides: only changed names are sent; an empty string clears
      // the override in providers.json and restores the built-in name on the Host.
      const shortLabel = typeof source.shortLabel === 'string' ? source.shortLabel.trim() : provider.shortLabel
      if (shortLabel !== provider.shortLabel) update.shortLabel = shortLabel
      const label = typeof source.label === 'string' ? source.label.trim() : provider.label
      if (label !== provider.label) update.label = label
      return update
    }

    /** Expand/collapse the editor of one provider (expanding seeds its drafts). */
    function toggleProviderEditor(provider) {
      const current = store.get().management
      if (current.editingId === provider.providerId) {
        patchManagement({ editingId: null })
        return
      }
      const seeded =
        current.drafts[provider.providerId] !== undefined &&
        current.drafts[provider.providerId] !== null &&
        typeof current.drafts[provider.providerId] === 'object'
      patchManagement({
        editingId: provider.providerId,
        drafts: seeded
          ? current.drafts
          : mapWith(current.drafts, provider.providerId, {
              consoleUrl: provider.consoleUrl,
              shortLabel: provider.shortLabel,
              label: provider.label,
            }),
      })
    }

    /** Record one typed editor value (names and the display-only console URL). */
    function updateProviderDraft(provider, field, value) {
      if (field !== 'consoleUrl' && field !== 'shortLabel' && field !== 'label') return
      if (provider === null || provider === undefined) return
      const current = store.get().management
      const draft = providerDraftOf(provider, current)
      patchManagement({
        drafts: mapWith(current.drafts, provider.providerId, {
          ...draft,
          [field]: typeof value === 'string' ? value : '',
        }),
      })
    }

    /** The enable/disable toggle: one providerUpdate carrying only `{enabled}`. */
    function setProviderEnabled(provider, next) {
      if (provider === null || provider === undefined) return
      void requestProviderUpdate(provider.providerId, { enabled: next === true })
    }

    /** The save button: one providerUpdate carrying only the changed fields. */
    function saveProviderDraft(provider) {
      if (provider === null || provider === undefined) return
      const current = store.get().management
      const draft = providerDraftOf(provider, current)
      const update = providerUpdatePatch(provider, draft)
      if (Object.keys(update).length === 0) return
      void requestProviderUpdate(provider.providerId, update)
    }

    /**
     * 「恢复默认名称」(v0.12.0): clear both name overrides in one providerUpdate.
     * Empty strings mean "no override", so the Host answers the built-in names.
     */
    function restoreProviderNames(provider) {
      if (provider === null || provider === undefined) return
      void requestProviderUpdate(provider.providerId, { shortLabel: '', label: '' })
    }

    /** Store the plugin version reported by the hello envelope (dialog footnote). */
    function applyHelloInfo(data) {
      if (data === null || typeof data !== 'object') return
      if (typeof data.version === 'string' && data.version !== '') {
        if (store.get().pluginVersion !== data.version) store.set({ pluginVersion: data.version })
      }
    }

    /** Announce this browser half to the Host (also records the current provider). */
    function announce(providerId) {
      const payload = usagePayload('hello', providerId)
      payload.origin = shellOrigin()
      payload.primitives = Object.keys(primitives).length
      if (appLocale !== '') payload.locale = appLocale
      try {
        void call(payload)
          .then((data) => applyHelloInfo(data))
          .catch(() => undefined)
      } catch {
        /* never let the announcement break activation */
      }
    }

    /** The adapter id behind a picker id (mirrors the Host's alias table for comparisons). */
    function canonicalProviderId(providerId) {
      return typeof providerId === 'string' && PROVIDER_ID_ALIASES[providerId] !== undefined
        ? PROVIDER_ID_ALIASES[providerId]
        : providerId
    }

    /**
     * Report the provider selected in the session.
     *
     * Ignored while the projection has not reported one (the Host then uses its
     * default provider). A change drops the previous provider's snapshot before
     * refetching, so stale percentages never paint under a new provider label.
     */
    function syncProvider(providerId) {
      const next = typeof providerId === 'string' && providerId !== '' ? providerId : null
      const current = store.get()
      if (current.providerId === next) return
      // The same provider may already be on screen (the first request went to the
      // Host default, which happens to equal the user's pick): just remember it.
      // A picker id the Host canonicalizes (`deepseek-official` → `deepseek`)
      // compares equal to the canonical id the snapshot carries.
      const shownProvider = current.snapshot !== null ? normalizeSnapshot(current.snapshot)?.provider?.id : ''
      if (
        next !== null &&
        shownProvider !== '' &&
        canonicalProviderId(shownProvider) === canonicalProviderId(next)
      ) {
        store.set({ providerId: next, ...usageViewDefaultsPatch() })
        announce(next)
        return
      }
      usageEpoch += 1
      store.set({
        providerId: next,
        snapshot: null,
        error: null,
        phase: next === null ? 'idle' : 'loading',
        loadedAt: 0,
        inFlight: false,
        busyAction: null,
        lastAttemptAt: 0,
        // Provider switches reset the token section to the persisted defaults.
        ...usageViewDefaultsPatch(),
      })
      announce(next)
      void requestUsage('snapshot')
    }

    /** The refresh button: usage first, then a fresh stats scan, independently. */
    async function refreshAll() {
      await requestUsage('refresh')
      await requestStats({ fresh: true })
    }

    // ---------------------------------------------------------------------
    // The client-side controller: announce, load, poll, catch up on visibility.
    // ---------------------------------------------------------------------

    /** `document.visibilityState === 'visible'`; a missing document counts as visible. */
    function isVisible() {
      try {
        return typeof document === 'undefined' || document.visibilityState !== 'hidden'
      } catch {
        return true
      }
    }

    /**
     * Start the data controller and return its disposer.
     *
     * Lifecycle: one `hello` announcement (proves this bundle loaded and the
     * route is reachable), an immediate snapshot read for the Host's default
     * provider (replaced by the projection's pick when the chip mounts), a 60s
     * poll while the page is visible, and a catch-up read when a hidden page
     * becomes visible again. A transport-level failure (the Host route is not
     * registered yet) is retried with backoff instead of waiting a full poll
     * interval, because the Host half of a freshly installed bundle may apply a
     * moment after the page.
     */
    function startController() {
      let disposed = false
      let pollTimer = null
      let retryTimer = null
      let retryAttempt = 0

      const scheduleRetry = () => {
        if (disposed || retryTimer !== null || retryAttempt >= BRIDGE_RETRY_DELAYS_MS.length) return
        const delay = BRIDGE_RETRY_DELAYS_MS[retryAttempt]
        retryAttempt += 1
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          void poll()
        }, delay)
      }

      async function poll() {
        if (disposed || !isVisible()) return
        const outcome = await requestUsage('snapshot')
        if (disposed) return
        if (outcome.kind === 'transport') scheduleRetry()
        else if (outcome.kind === 'ok' || outcome.kind === 'envelope') retryAttempt = 0
      }

      function onVisibilityChange() {
        if (!isVisible()) return
        const state = store.get()
        const last = Math.max(state.loadedAt, state.lastAttemptAt)
        if (Date.now() - last >= POLL_INTERVAL_MS) void poll()
      }

      announce(null)
      void poll()
      // v0.10.0: learn the persisted chip label style + wire labels once, without
      // touching the management page state (silent when an old Host answers nothing).
      void bootstrapProviders()
      pollTimer = window.setInterval(() => {
        void poll()
      }, POLL_INTERVAL_MS)
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }

      return () => {
        disposed = true
        if (pollTimer !== null) window.clearInterval(pollTimer)
        if (retryTimer !== null) window.clearTimeout(retryTimer)
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }
    }

    // ---------------------------------------------------------------------
    // Styles (one injected <style>; theme tokens from ui-theme).
    // ---------------------------------------------------------------------

    const CSS = `
.dsh-tokenlens-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.dsh-tokenlens-chip{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.dsh-tokenlens-chip:hover,.dsh-tokenlens-chip:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);outline:none}
.dsh-tokenlens-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dsh-tokenlens-dot[data-level=normal]{background:#2e9e5b}
.dsh-tokenlens-dot[data-level=warning]{background:#d98a1f}
.dsh-tokenlens-dot[data-level=critical]{background:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-brand{font-weight:600;color:var(--dsw-alias-label-secondary)}
/* Experimental: per-workspace token badge in the left sidebar workspace rows. */
.dsh-tokenlens-workspace-tokens{display:inline-flex;align-items:center;gap:3px;margin-left:auto;flex:none;font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:104px}
.dsh-tokenlens-workspace-tokens>svg{flex:none;width:11px;height:11px;opacity:.72}
.dsh-tokenlens-workspace-tokens-value{min-width:0;overflow:hidden;text-overflow:ellipsis}
/* Experimental: token stats inside the floating workspace hover card. */
.dsh-tokenlens-workspace-hover-tokens{display:flex;flex-direction:column;gap:2px;color:#cfd3d6;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;margin-top:6px;min-width:0}
.dsh-tokenlens-workspace-hover-token{display:flex;align-items:baseline;justify-content:space-between;gap:12px;white-space:nowrap}
.dsh-tokenlens-workspace-hover-label{opacity:.7;margin-right:3px}
.dsh-tokenlens-sep{color:var(--dsw-alias-separator-primary,rgba(127,127,127,.45));margin:0 1px}
.dsh-tokenlens-metric{color:inherit}
.dsh-tokenlens-money{font-variant-numeric:tabular-nums}
.dsh-tokenlens-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;background:rgba(0,0,0,.48)}
.dsh-tokenlens-modal{box-sizing:border-box;width:min(1120px,calc(100vw - 24px));max-height:calc(100vh - 24px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-elevated,#202124);color:var(--dsw-alias-label-primary,#f2f2f2);box-shadow:0 18px 60px rgba(0,0,0,.45)}
.dsh-tokenlens-modal-head{align-items:center;gap:8px;display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.2));flex:none}
.dsh-tokenlens-modal-title{font-size:15px;font-weight:600;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tokenlens-modal-close{border:0;background:0 0;color:var(--dsw-alias-label-tertiary,#aaa);font-size:20px;line-height:1;padding:0 4px;cursor:pointer;border-radius:6px}
.dsh-tokenlens-modal-close:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsh-tokenlens-modal-body{padding:10px 12px;min-height:0;flex:1 1 auto;overflow:hidden}
.dsh-tokenlens-dialog-manage{max-height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dsh-tokenlens-modal-foot{align-items:center;gap:8px;flex-wrap:wrap;display:flex;justify-content:flex-end;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.2));flex:none}
@media (max-width:680px){.dsh-tokenlens-overlay{padding:8px}.dsh-tokenlens-modal{width:calc(100vw - 16px);max-height:calc(100vh - 16px)}.dsh-tokenlens-modal-body{padding:8px 10px}.dsh-tokenlens-modal-foot{padding:8px 10px}}
@media (max-height:720px){.dsh-tokenlens-modal-head{padding:6px 10px}.dsh-tokenlens-modal-body{padding:7px 10px}.dsh-tokenlens-modal-foot{padding:6px 10px}.dsh-tokenlens-modal-title{font-size:14px}}
@media (max-height:620px){.dsh-tokenlens-modal-head{padding:5px 10px}.dsh-tokenlens-modal-body{padding:6px 8px}.dsh-tokenlens-modal-foot{padding:5px 10px;gap:6px}}
.dsh-tokenlens-dialog{display:flex;flex-direction:column;gap:8px;min-width:0;box-sizing:border-box;width:100%;max-width:100%}
.dsh-tokenlens-providers{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px;align-items:start}
.dsh-tokenlens-providers>*{min-width:0}
@media (max-width:680px){.dsh-tokenlens-providers{grid-template-columns:minmax(0,1fr)}}
.dsh-tokenlens-details-toggle{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;background:none;border:0;padding:1px 0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);cursor:pointer;text-decoration:underline;text-underline-offset:2px}@media (max-width:560px){.dsh-tokenlens-dialog,.dsh-tokenlens-manage-view{width:100%;box-sizing:border-box;min-width:0;overflow-x:hidden}.dsh-tokenlens-section-head{flex-wrap:wrap;row-gap:2px}.dsh-tokenlens-section-title{flex:1 1 auto;min-width:0}.dsh-tokenlens-section-meta{white-space:normal;overflow-wrap:anywhere;text-align:left}.dsh-tokenlens-toolbar{flex-wrap:wrap;justify-content:flex-start;row-gap:4px}.dsh-tokenlens-scope-row{flex-wrap:wrap;gap:4px}.dsh-tokenlens-cards,.dsh-tokenlens-card,.dsh-tokenlens-card-head,.dsh-tokenlens-card-row{min-width:0}.dsh-tokenlens-card-head{flex-wrap:wrap}.dsh-tokenlens-harness-row{flex-wrap:wrap;gap:2px 8px}.dsh-tokenlens-harness-name{min-width:0;flex:1 1 100%}.dsh-tokenlens-harness-meta{margin-left:0;white-space:normal}.dsh-tokenlens-harness-providers{padding-left:0}.dsh-tokenlens-breakdown-head,.dsh-tokenlens-breakdown-row,.dsh-tokenlens-model-row,.dsh-tokenlens-harness-provider-row,.dsh-tokenlens-row-head{flex-wrap:wrap;gap:2px 8px}.dsh-tokenlens-breakdown-value,.dsh-tokenlens-model-value,.dsh-tokenlens-harness-provider-value,.dsh-tokenlens-harness-value{white-space:normal;overflow-wrap:anywhere}.dsh-tokenlens-subtitle{margin-top:0}.dsh-tokenlens-console{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.dsh-tokenlens-provider{align-items:center;flex-wrap:wrap;gap:6px 10px;display:flex;font-size:var(--dsw-alias-font-size-sm,12px);color:var(--dsw-alias-label-tertiary)}
.dsh-tokenlens-plan{border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-account{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-tokenlens-rows{display:flex;flex-direction:column;gap:10px}
.dsh-tokenlens-row{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-tokenlens-row-head{align-items:baseline;gap:8px;display:flex;justify-content:space-between}
.dsh-tokenlens-row-label{color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:1.4}
.dsh-tokenlens-percent{font-variant-numeric:tabular-nums;font-weight:600;font-size:var(--dsh-content-font-size,14px);line-height:1.4;color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-percent[data-level=warning]{color:#d98a1f}
.dsh-tokenlens-percent[data-level=critical]{color:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-bar{position:relative;height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));overflow:hidden}
.dsh-tokenlens-bar-fill{position:absolute;inset:0 auto 0 0;min-width:2px;border-radius:999px;background:#2e9e5b;transition:width .25s ease}
.dsh-tokenlens-bar-fill[data-level=warning]{background:#d98a1f}
.dsh-tokenlens-bar-fill[data-level=critical]{background:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-bar-fill[data-level=unknown]{background:var(--dsw-alias-label-tertiary);opacity:.35}
.dsh-tokenlens-chart-layout{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-tokenlens-chart-layout-row{display:flex;flex-wrap:wrap;gap:10px;min-width:0}
.dsh-tokenlens-chart-layout-row>.dsh-tokenlens-capacity{flex:0.85 1 260px}
.dsh-tokenlens-chart-layout-row>.dsh-tokenlens-stats{flex:1.25 1 330px;min-width:0}
.dsh-tokenlens-chart-layout-row>.dsh-tokenlens-details{flex:1 1 100%;min-width:0}
@media (max-width:680px){.dsh-tokenlens-chart-layout-row>*{flex-basis:100%!important}}
.dsh-tokenlens-details-charts{min-width:0}
/* Data-mode 明细: three FULL-WIDTH blocks stacked vertically (v0.30.0 layout). */
.dsh-tokenlens-details-columns{display:grid;grid-template-columns:minmax(0,1fr);gap:10px 14px;align-items:start;min-width:0}
.dsh-tokenlens-details-columns>.dsh-tokenlens-details-block{min-width:0}
.dsh-tokenlens-details-columns>.dsh-tokenlens-details-block+.dsh-tokenlens-details-block{border-left:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));padding-left:14px}
@media (max-width:760px){.dsh-tokenlens-details-columns{grid-template-columns:minmax(0,1fr)!important}.dsh-tokenlens-details-columns>.dsh-tokenlens-details-block+.dsh-tokenlens-details-block{border-left:0;padding-left:0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));padding-top:10px}}
.dsh-tokenlens-details-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-tokenlens-details-block{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-tokenlens-details-block .dsh-tokenlens-breakdown-head{margin:0;padding:0;min-width:0}
.dsh-tokenlens-details-table{width:100%;min-width:100%;table-layout:fixed;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dsh-tokenlens-details-table .dsh-tokenlens-details-table-col-window{width:64px}
.dsh-tokenlens-details-table thead .dsh-tokenlens-details-table-label{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);font-weight:400;line-height:1.5;text-align:right;padding:1px 2px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-tokenlens-details-table thead .dsh-tokenlens-details-table-spacer{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);font-weight:400;line-height:1.5;text-align:left;padding:1px 2px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-tokenlens-details-table tbody tr{border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.14))}
.dsh-tokenlens-details-table tbody tr:first-child{border-top:0}
.dsh-tokenlens-details-table td{padding:1px 2px;vertical-align:top;line-height:1.35}
.dsh-tokenlens-details-table td.dsh-tokenlens-details-table-name{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.3;white-space:normal;overflow-wrap:anywhere;min-width:0}
.dsh-tokenlens-details-table-name-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;overflow-wrap:anywhere}
.dsh-tokenlens-details-table td.dsh-tokenlens-details-table-cell{color:var(--dsw-alias-label-secondary);font-size:10px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:2px}
.dsh-tokenlens-details-table td.dsh-tokenlens-details-table-note{font-size:10px;line-height:1.45;padding:2px;overflow-wrap:anywhere;white-space:normal}
.dsh-tokenlens-details-table tr.dsh-tokenlens-harness-error-row .dsh-tokenlens-harness-hint{display:block;margin-top:1px}
.dsh-tokenlens-details-subhead{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4;padding-top:2px;border-top:1px dashed var(--dsw-alias-border-subtle,rgba(127,127,127,.24))}
.dsh-tokenlens-details-block .dsh-tokenlens-harness-hint,.dsh-tokenlens-details-block .dsh-tokenlens-unmapped-hint{font-size:10px;line-height:1.45;overflow-wrap:anywhere}
.dsh-tokenlens-details-block .dsh-tokenlens-harness-unavailable{font-size:10px;white-space:nowrap}
.dsh-tokenlens-details-charts-grid{display:flex;flex-wrap:wrap;gap:10px 18px;min-width:0}
/* 明细 donut share charts + ranked legends (v0.27.0). */
.dsh-tokenlens-details-charts-grid>.dsh-tokenlens-chart-group,.dsh-tokenlens-details-charts>.dsh-tokenlens-chart-group{flex:1 1 260px;min-width:0}
.dsh-tokenlens-details-charts-grid>.dsh-tokenlens-chart-group+.dsh-tokenlens-chart-group,.dsh-tokenlens-details-charts>.dsh-tokenlens-chart-group+.dsh-tokenlens-chart-group{border-left:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));padding-left:14px}
.dsh-tokenlens-details-charts .dsh-tokenlens-chart-group{margin-top:2px}
.dsh-tokenlens-details-charts{display:flex;flex-wrap:wrap;gap:6px 18px}
.dsh-tokenlens-details-charts>.dsh-tokenlens-section-head{flex:1 1 100%}
.dsh-tokenlens-chart-group{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-tokenlens-donut-group{flex:1 1 260px}
.dsh-tokenlens-donut-wrap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;max-width:100%}
.dsh-tokenlens-donut{position:relative;flex:none;width:96px;height:96px;display:flex;align-items:center;justify-content:center}
.dsh-tokenlens-donut-svg{display:block;width:96px;height:96px;overflow:visible}
.dsh-tokenlens-donut-segment{transition:stroke-width .15s ease}
.dsh-tokenlens-donut-segment:hover{stroke-width:12}
.dsh-tokenlens-donut-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;min-width:0}
.dsh-tokenlens-donut-total{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
.dsh-tokenlens-donut-legend{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:2px 6px;align-items:center;flex:1 1 150px;min-width:0;overflow:hidden}
.dsh-tokenlens-donut-legend-row{display:contents;font-size:11px;line-height:1.4}
.dsh-tokenlens-donut-dot{flex:none;width:8px;height:8px;border-radius:50%}
.dsh-tokenlens-donut-legend-label{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-tokenlens-donut-legend-percent{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.dsh-tokenlens-donut-legend-value{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
@media (max-width:680px){.dsh-tokenlens-donut-wrap{align-items:flex-start}.dsh-tokenlens-details-charts-grid>.dsh-tokenlens-chart-group,.dsh-tokenlens-details-charts>.dsh-tokenlens-chart-group{flex-basis:100%}.dsh-tokenlens-details-charts-grid>.dsh-tokenlens-chart-group+.dsh-tokenlens-chart-group,.dsh-tokenlens-details-charts>.dsh-tokenlens-chart-group+.dsh-tokenlens-chart-group{border-left:0;padding-left:0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));padding-top:8px}}
.dsh-tokenlens-reset-date{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;white-space:nowrap}
.dsh-tokenlens-row-foot{flex-wrap:wrap;align-items:baseline;gap:4px 10px;display:flex;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-status{color:#d98a1f}
.dsh-tokenlens-status[data-level=critical]{color:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-balance{border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));padding:10px 12px;display:flex;flex-direction:column;gap:3px}
.dsh-tokenlens-balance-label{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4}
.dsh-tokenlens-balance-amount{color:var(--dsw-alias-label-primary);font-size:22px;font-weight:600;line-height:1.25;font-variant-numeric:tabular-nums}
.dsh-tokenlens-balance-foot{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;flex-wrap:wrap;gap:4px 10px;display:flex}
.dsh-tokenlens-credits{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;flex-wrap:wrap;gap:4px 10px;display:flex}
.dsh-tokenlens-banner{border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:var(--dsw-radius-sm);padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
.dsh-tokenlens-banner-title{color:var(--dsw-alias-label-error,#d9534f);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;font-weight:600}
.dsh-tokenlens-banner-detail{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;overflow-wrap:anywhere}
.dsh-tokenlens-banner-actions{align-items:center;display:flex;gap:8px}
.dsh-tokenlens-meta{align-items:baseline;gap:8px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-stale{color:#d98a1f;white-space:nowrap}
.dsh-tokenlens-loading,.dsh-tokenlens-hint{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-capacity-money{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-tokenlens-capacity-tokens{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dsh-tokenlens-section{box-sizing:border-box;margin-top:0;padding:9px 11px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.22));border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:7px;min-width:0}
.dsh-tokenlens-section-head{align-items:center;gap:6px 8px;display:flex;justify-content:space-between;flex-wrap:wrap;min-width:0}
.dsh-tokenlens-section-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4;flex:none;display:inline-flex;align-items:center;gap:5px}
.dsh-tokenlens-section-meta{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;white-space:normal;text-align:right;min-width:0}
.dsh-tokenlens-source{white-space:normal;text-align:right;min-width:0}
.dsh-tokenlens-details{gap:8px}
.dsh-tokenlens-head-label{display:inline-flex;align-items:center;gap:5px;min-width:0}
.dsh-tokenlens-subtitle{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;margin-top:-4px}
.dsh-tokenlens-scope-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-tokenlens-scope{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;padding:1px}
.dsh-tokenlens-scope-option{font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;padding:1px 10px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-tokenlens-scope-option:hover:not(:disabled){color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-scope-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-scope-option:disabled{opacity:.45;cursor:default}
/* 数据 / 图表 segmented toggle (v0.24.0). */
.dsh-tokenlens-stats-view{display:inline-flex;align-items:center;gap:2px;margin-left:0;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;padding:1px;flex:none}
.dsh-tokenlens-stats-view-option{font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;padding:1px 9px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.dsh-tokenlens-stats-view-option:hover{color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-stats-view-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-stats-view-option:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5))}
/* Daily token bar chart (v0.25.0): axes, gridlines and a live pointer readout;
   pure CSS bars, no dependencies, no scrollbar. */
.dsh-tokenlens-stats-chart{flex:2 1 520px}
.dsh-tokenlens-chart{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:100%}
.dsh-tokenlens-chart-body{display:flex;align-items:flex-start;gap:6px;min-width:0;max-width:100%}
.dsh-tokenlens-chart-yaxis{box-sizing:border-box;flex:none;width:58px;height:162px;padding-top:2px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;font-variant-numeric:tabular-nums;overflow:hidden}
.dsh-tokenlens-chart-tick{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dsh-tokenlens-chart-plot{position:relative;flex:1 1 auto;min-width:0;max-width:100%;display:flex;flex-direction:column;gap:2px}
.dsh-tokenlens-chart-grid{position:absolute;left:0;right:0;top:2px;height:160px;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none;z-index:0}
.dsh-tokenlens-chart-gridline{height:0;border-top:1px dashed var(--dsw-alias-border-subtle,rgba(127,127,127,.2))}
.dsh-tokenlens-chart-gridline:first-child{border-top-style:solid}
.dsh-tokenlens-chart-bars{position:relative;z-index:1;box-sizing:border-box;display:flex;align-items:flex-end;gap:2px;height:160px;min-width:0;max-width:100%;padding:2px 1px 0;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));overflow:hidden}
.dsh-tokenlens-chart-bar-wrap{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;justify-content:center;cursor:default}
.dsh-tokenlens-chart-bar{width:100%;max-width:24px;min-height:0;border-radius:2px 2px 0 0;background:#2e9e5b;transition:height .2s ease,filter .15s ease}
.dsh-tokenlens-chart-bar[data-empty=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsh-tokenlens-chart-bar-wrap:hover .dsh-tokenlens-chart-bar{filter:brightness(1.18)}
.dsh-tokenlens-chart-bar-wrap[data-chart-hover=true] .dsh-tokenlens-chart-bar{background:#40c877;filter:brightness(1.12);box-shadow:0 0 0 1px rgba(64,200,119,.55)}
.dsh-tokenlens-chart-crosshair{position:absolute;top:2px;height:160px;z-index:2;pointer-events:none;border-left:1px dashed #d98a1f;opacity:.7}
.dsh-tokenlens-chart-readout{position:absolute;top:4px;z-index:3;pointer-events:none;max-width:calc(100% - 8px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-elevated,#202124);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.4;padding:2px 6px;box-shadow:0 2px 8px rgba(0,0,0,.25);font-variant-numeric:tabular-nums}
.dsh-tokenlens-chart-xaxis{position:relative;flex:none;height:14px;min-width:0;max-width:100%;overflow:hidden}
.dsh-tokenlens-chart-x-label{position:absolute;top:2px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.2;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-tokenlens-chart-summary{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;min-width:0}
.dsh-tokenlens-chart-summary>span{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-tokenlens-chart-empty{box-sizing:border-box;min-height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border:1px dashed var(--dsw-alias-border-subtle,rgba(127,127,127,.28));border-radius:8px;padding:10px;text-align:center;min-width:0}
.dsh-tokenlens-chart-empty-hint{opacity:.8;font-size:11px}
/* Hourly drill-down of the daily chart (v1.2.0): clickable/focusable day bars,
   a selected-day ring, and the back + title row above the hour bars. */
.dsh-tokenlens-chart-bar-wrap-clickable{cursor:pointer}
.dsh-tokenlens-chart-bar-wrap-clickable:focus-visible{outline:2px solid #2e9e5b;outline-offset:1px;border-radius:3px}
.dsh-tokenlens-chart-bar-wrap[data-chart-selected=true] .dsh-tokenlens-chart-bar{background:#1d6b3d;box-shadow:0 0 0 1px rgba(64,200,119,.9)}
.dsh-tokenlens-chart-drilldown{gap:4px}
.dsh-tokenlens-chart-drill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-tokenlens-chart-back{font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;padding:1px 8px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.dsh-tokenlens-chart-back:hover{color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-chart-back:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5))}
.dsh-tokenlens-chart-drill-title{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 明细 donut window switch (v1.2.0): one pill row under the details title. */
.dsh-tokenlens-details-window{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsh-tokenlens-version{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;text-align:right;opacity:.75}
.dsh-tokenlens-cards{gap:6px;flex-wrap:wrap;display:flex}
.dsh-tokenlens-cards-caption{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;margin-bottom:-3px}
.dsh-tokenlens-harness-breakdown{display:flex;flex-direction:column;gap:4px}
.dsh-tokenlens-harness{display:flex;flex-direction:column;gap:1px}
.dsh-tokenlens-harness-row{align-items:baseline;gap:8px;display:flex;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-harness-name{color:var(--dsw-alias-label-primary);font-weight:600;min-width:3.5em}
.dsh-tokenlens-harness-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-tokenlens-harness-value[data-muted=true]{color:var(--dsw-alias-label-tertiary);opacity:.7}
.dsh-tokenlens-unmapped{display:flex;flex-direction:column;gap:1px;margin-top:2px}
.dsh-tokenlens-unmapped-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;opacity:.8;margin-top:1px}
.dsh-tokenlens-harness-meta{color:var(--dsw-alias-label-tertiary);margin-left:auto;white-space:nowrap}
.dsh-tokenlens-harness-unavailable{color:var(--dsw-alias-label-tertiary);font-style:italic;opacity:.7}
.dsh-tokenlens-harness-hint{color:var(--dsw-alias-label-tertiary);opacity:.75;font-size:11px;line-height:1.4;margin-left:auto;text-align:right;white-space:normal;min-width:0}
.dsh-tokenlens-harness-providers{display:flex;flex-direction:column;gap:1px;padding-left:calc(3.5em + 8px);opacity:.75}
.dsh-tokenlens-harness-provider-row{display:flex;justify-content:space-between;gap:8px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dsh-tokenlens-harness-provider-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-tokenlens-harness-provider-value{font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-tokenlens-card{box-sizing:border-box;flex:1 1 104px;min-width:104px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:2px}
.dsh-tokenlens-card-head{align-items:baseline;gap:6px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4}
.dsh-tokenlens-card-total{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-tokenlens-card-row{gap:6px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.45}
.dsh-tokenlens-card-row-value{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-tokenlens-card-requests{margin-top:1px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.dsh-tokenlens-breakdown{display:flex;flex-direction:column;gap:2px}
.dsh-tokenlens-breakdown-head{align-items:baseline;gap:8px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;margin-bottom:2px}
.dsh-tokenlens-breakdown-row{gap:8px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-breakdown-value{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-tokenlens-models{display:flex;flex-direction:column;gap:2px}
.dsh-tokenlens-model-row{gap:8px;display:flex;justify-content:space-between;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5}
.dsh-tokenlens-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-alias-font-family-mono,ui-monospace,monospace)}
.dsh-tokenlens-model-value{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-tokenlens-footer{align-items:center;gap:8px;flex-wrap:wrap;display:flex;justify-content:flex-end}
.dsh-tokenlens-console{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-alias-font-size-sm,12px);text-decoration:underline;text-underline-offset:2px;margin-right:auto;display:inline-flex;align-items:center;gap:4px}
.dsh-tokenlens-console:hover{color:var(--dsw-alias-label-secondary)}
/* Provider management page (v0.9.0). */
.dsh-tokenlens-toolbar{align-items:center;display:flex;gap:8px;justify-content:flex-end;min-width:0}
.dsh-tokenlens-toolbar-back{justify-content:flex-start}
.dsh-tokenlens-toolbar-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.4;margin-right:auto}
.dsh-tokenlens-manage,.dsh-tokenlens-back{box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;padding:2px 10px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.dsh-tokenlens-manage:hover,.dsh-tokenlens-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-manage:focus-visible,.dsh-tokenlens-back:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5))}
.dsh-tokenlens-manage-view{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-tokenlens-manage-view>.dsh-tokenlens-subtitle{margin-top:-2px}
/* Collapsed cards share one min-height, and the grid is top-aligned
   (align-items:start) instead of stretched, so opening one card's editor grows
   only that card; its neighbours keep their normal collapsed height instead of
   stretching into a tall empty row. */
.dsh-tokenlens-provider-card{box-sizing:border-box;min-height:84px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:8px;padding:8px 9px;display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-tokenlens-provider-card[data-editing=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
/* Deterministic five-column header: avatar | name | kind | status | enable. Badge
   columns never wrap, so every card's status pill stays on one row. */
.dsh-tokenlens-provider-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;align-items:center;gap:4px 6px;min-width:0}
.dsh-tokenlens-provider-toggle{align-items:center;background:0 0;border:none;padding:0;color:inherit;font:inherit;display:flex;min-width:0;overflow:hidden;text-align:left;cursor:pointer}
.dsh-tokenlens-provider-toggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5));border-radius:var(--dsw-radius-sm)}
.dsh-tokenlens-avatar{flex:none;width:22px;height:22px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;line-height:1;letter-spacing:.02em;color:#fff;background:#5a6472;text-transform:uppercase}
.dsh-tokenlens-provider-name{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-tokenlens-kind{flex:none;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;padding:0 7px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.dsh-tokenlens-kind[data-kind=windows]{color:#2e9e5b;border-color:rgba(46,158,91,.45)}
.dsh-tokenlens-kind[data-kind=balance]{color:#d98a1f;border-color:rgba(217,138,31,.45)}
.dsh-tokenlens-builtin{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;opacity:.75;white-space:nowrap;margin-left:auto}
/* Subscription badge (v0.23.0): short nowrap pill in the card metadata line. */
.dsh-tokenlens-subscription-badge{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;white-space:nowrap;border:1px solid currentColor;border-radius:999px;padding:0 6px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary);opacity:.8}
.dsh-tokenlens-subscription-badge[data-kind=subscribed]{color:#2e9e5b;opacity:1}
.dsh-tokenlens-subscription-badge[data-kind=unsubscribed]{color:var(--dsw-alias-label-tertiary);opacity:.75}
.dsh-tokenlens-enabled-wrap{flex:none;align-items:center;gap:4px;display:inline-flex;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;cursor:pointer;white-space:nowrap}
.dsh-tokenlens-enabled{accent-color:var(--dsw-alias-label-primary,#333);margin:0;width:14px;height:14px;cursor:pointer}
.dsh-tokenlens-enabled-label{color:var(--dsw-alias-label-tertiary)}
.dsh-tokenlens-provider-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;border:1px solid currentColor;border-radius:999px;padding:0 7px;opacity:.92}
.dsh-tokenlens-provider-status[data-state=configured],.dsh-tokenlens-provider-status[data-state=ok]{color:#2e9e5b}
.dsh-tokenlens-provider-status[data-state=error]{color:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-provider-status[data-state=missing-key]{color:#d98a1f}
.dsh-tokenlens-provider-status[data-state=testing]{color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-provider-message{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.dsh-tokenlens-provider-message[data-kind=error]{color:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-provider-message[data-kind=ok]{color:#2e9e5b}
.dsh-tokenlens-editor{display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));margin-top:auto}
.dsh-tokenlens-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-tokenlens-field-head{align-items:flex-start;flex-direction:column;display:flex;gap:1px;justify-content:flex-start;min-width:0}
.dsh-tokenlens-field-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4}
.dsh-tokenlens-field-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;white-space:normal;overflow-wrap:anywhere;text-align:left;max-width:100%}
.dsh-tokenlens-field-error{color:var(--dsw-alias-label-error,#d9534f)}
.dsh-tokenlens-input{box-sizing:border-box;width:100%;min-width:0;max-width:100%;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.5;padding:3px 8px}
.dsh-tokenlens-input:disabled{opacity:.55;cursor:not-allowed}
.dsh-tokenlens-input:focus-visible{outline:none;border-color:var(--dsw-alias-border-strong,rgba(127,127,127,.6))}
.dsh-tokenlens-account-hint{color:var(--dsw-alias-label-tertiary)}
/* Every provider inherits its credentials (v0.14.0): a compact note replaces the
   removed key/Base-URL inputs. Managed providers point at their DSH route; every
   other provider gets a hint naming the route id it should be added under. */
.dsh-tokenlens-dsh-inherited{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));padding:5px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dsh-tokenlens-dsh-inherited-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-dsh-inherited>.dsh-tokenlens-icon{flex:0 0 auto;display:block;overflow:visible;margin-top:1px}
.dsh-tokenlens-dsh-unmanaged{display:flex;align-items:flex-start;gap:6px;min-width:0;border:1px solid rgba(217,138,31,.4);border-radius:var(--dsw-radius-sm);background:rgba(217,138,31,.08);padding:5px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.dsh-tokenlens-dsh-unmanaged-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-dsh-unmanaged>.dsh-tokenlens-icon{margin-top:1px;flex:none;color:#d98a1f}
.dsh-tokenlens-inline-btn{box-sizing:border-box;flex:none;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.4;padding:2px 8px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.dsh-tokenlens-inline-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-inline-btn:disabled{opacity:.45;cursor:default}
.dsh-tokenlens-inline-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5))}
.dsh-tokenlens-editor-actions{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.dsh-tokenlens-empty{color:var(--dsw-alias-label-tertiary)}
.dsh-tokenlens-provider-store-file{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;opacity:.75;overflow-wrap:anywhere}
/* DSH-driven management page (v0.15.0): primary DSH discovery section + the
   secondary collapsed preset-adapter section. */
.dsh-tokenlens-manage-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-tokenlens-dsh-route{grid-column:1/-1;display:flex;align-items:flex-start;gap:6px;min-width:0;border:1px dashed var(--dsw-alias-border-subtle,rgba(127,127,127,.3));border-radius:8px;padding:6px 9px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;background:transparent}
.dsh-tokenlens-dsh-route>.dsh-tokenlens-icon{margin-top:1px;flex:none;opacity:.8}
.dsh-tokenlens-dsh-route-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-tokenlens-dsh-route-name{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-tokenlens-dsh-route-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.dsh-tokenlens-preset-section{display:flex;flex-direction:column;gap:5px;min-width:0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18));padding-top:7px}
.dsh-tokenlens-preset-toggle{gap:5px;flex-wrap:wrap;text-decoration:none}
.dsh-tokenlens-preset-count,.dsh-tokenlens-preset-action{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dsh-tokenlens-preset-action{text-decoration:underline;text-underline-offset:2px}
.dsh-tokenlens-preset-hint{margin-top:-1px}
/* Custom usage adapters (v0.16.0): add button, inline form card and section. */
.dsh-tokenlens-custom-hint{display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);min-width:0}
.dsh-tokenlens-custom-hint-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-custom-note{flex:1 1 100%;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-tokenlens-custom-badge{color:#d98a1f;opacity:1}
.dsh-tokenlens-custom-section{display:flex;flex-direction:column;gap:6px;min-width:0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18));padding-top:7px}
/* Provider-list filter tabs (v0.17.0). */
.dsh-tokenlens-filter-row{display:flex;align-items:center;min-width:0}
.dsh-tokenlens-filter-option{display:inline-flex;align-items:center;gap:4px;font-size:12px}
.dsh-tokenlens-filter-empty{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-tokenlens-filter-empty-hint{opacity:.8;font-size:11px}
.dsh-tokenlens-builtin-section{display:flex;flex-direction:column;gap:6px;min-width:0}
/* Chip label-style selector (v0.10.0). */
.dsh-tokenlens-label-style{align-items:center;flex-wrap:wrap;gap:6px 10px;display:flex;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));padding:6px 10px;min-width:0}
.dsh-tokenlens-label-style-label{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.dsh-tokenlens-label-style .dsh-tokenlens-scope-option:disabled{opacity:.55}
/* Management section tabs + 插件设置 (v0.29.0). */
.dsh-tokenlens-manage-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.18))}
.dsh-tokenlens-manage-tab{font:inherit;font-size:var(--dsw-alias-font-size-sm,12px);line-height:1.4;padding:2px 10px;border:1px solid transparent;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.dsh-tokenlens-manage-tab:hover{color:var(--dsw-alias-label-secondary)}
.dsh-tokenlens-manage-tab[data-active=true]{border-color:var(--dsw-alias-border-subtle,rgba(127,127,127,.24));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary)}
.dsh-tokenlens-manage-tab:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-strong,rgba(127,127,127,.5))}
.dsh-tokenlens-settings{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%}
.dsh-tokenlens-settings-row{display:grid;grid-template-columns:minmax(96px,160px) minmax(0,1fr);align-items:center;gap:6px 12px;min-width:0}
.dsh-tokenlens-settings-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;min-width:0}
.dsh-tokenlens-settings-options{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.24));border-radius:999px;padding:1px;width:fit-content;max-width:100%;min-width:0}
.dsh-tokenlens-settings-options .dsh-tokenlens-settings-option{display:inline-flex;align-items:center;gap:4px}
.dsh-tokenlens-settings-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
@media (max-width:560px){.dsh-tokenlens-settings-row{grid-template-columns:minmax(0,1fr)}}
.dsh-tokenlens-provider-labels{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow-wrap:anywhere;display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px}
.dsh-tokenlens-provider-labels .dsh-tokenlens-icon{margin-top:1px}
/* Inline icons: currentColor stroke, never a text node (keeps textOf stable). */
.dsh-tokenlens-icon{flex:none;display:block;vertical-align:0;overflow:visible;color:inherit;pointer-events:none}
.dsh-tokenlens-toolbar .dsh-tokenlens-manage{font-size:12px}
/* Responsive density: last so the compact rules win over the base ones. */
@media (max-height:800px){.dsh-tokenlens-dialog{gap:6px}.dsh-tokenlens-section{padding:7px 9px;gap:6px}.dsh-tokenlens-section-head{gap:4px 6px}.dsh-tokenlens-cards{gap:5px}.dsh-tokenlens-card{padding:6px 8px}.dsh-tokenlens-card-row{line-height:1.4}.dsh-tokenlens-subtitle{font-size:11px}.dsh-tokenlens-balance{padding:8px 10px}.dsh-tokenlens-balance-amount{font-size:19px}.dsh-tokenlens-chart-bars,.dsh-tokenlens-chart-grid,.dsh-tokenlens-chart-crosshair{height:140px}.dsh-tokenlens-chart-yaxis{height:142px}}
@media (max-width:680px){.dsh-tokenlens-details-toggle{align-self:stretch}}
`

    /** Install the stylesheet once, keyed so a reload replaces it rather than stacking. */
    function installStyles() {
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof document.createElement !== 'function' ||
        document.head === null ||
        document.head === undefined
      ) {
        return undefined
      }
      const existing = document.querySelector(`style[data-dsh-plugin="${STYLE_ID}"]`)
      if (existing !== null) {
        // HMR re-evaluates this bundle while the <style> tag from the previous
        // generation is still in <head>; returning it unchanged kept a STALE
        // stylesheet alive (new classes/rules never loaded, old layout bugs
        // persisted until a full page reload). Always refresh its contents.
        existing.textContent = CSS
        return existing
      }
      const style = document.createElement('style')
      style.setAttribute('data-dsh-plugin', STYLE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      return style
    }

    // ---------------------------------------------------------------------
    // Shared hooks.
    // ---------------------------------------------------------------------

    /** Subscribe a component to the shared store. */
    function useUsage() {
      const [state, setState] = React.useState(store.get())
      React.useEffect(() => {
        setState(store.get())
        return store.subscribe(() => setState(store.get()))
      }, [])
      return state
    }

    /** The provider selected in this session, from the slot's `useProjection` prop. */
    function useSelectedProvider(props) {
      const useProjection = props?.useProjection
      if (typeof useProjection !== 'function') return null
      // Call the slot hook outside try/catch: swallowing a hook throw would
      // change the hook order on the next render (React error 310).
      const model = useProjection('modelSelection')
      try {
        const selection = model?.next ?? model?.lastUsed
        const provider = selection?.provider
        return typeof provider === 'string' && provider !== '' ? provider : null
      } catch {
        return null
      }
    }

    /** Keep the shared store's provider in sync with the session selection. */
    function useProviderSync(props) {
      const providerId = useSelectedProvider(props)
      React.useEffect(() => {
        syncProvider(providerId)
      }, [providerId])
      return providerId
    }

    // ---------------------------------------------------------------------
    // The compositor dock chip.
    // ---------------------------------------------------------------------

    /** Whether the chip must stay silent for this state. */
    function chipHidden(state) {
      return isHidden(state.error)
    }

    /** Severity of the chip dot: worst window, balance/unknown mapped to normal. */
    function chipLevel(snapshot, state) {
      let level = 'unknown'
      if (snapshot !== null && snapshot.provider.kind === 'windows' && snapshot.windows !== null) {
        for (const id of WINDOW_ORDER) {
          const window = snapshot.windows[id]
          level = worseLevel(level, window === null ? 'unknown' : levelOf(window.percent, window.status))
        }
        if (LEVEL_RANK[level] === 0) level = 'normal'
      } else if (snapshot !== null) {
        level = 'normal'
      }
      if (state.error !== null || snapshot?.stale === true) level = worseLevel(level, 'warning')
      return level
    }

    /** The money/mixed chip body for one snapshot. */
    function chipPieces(snapshot, providerId, t) {
      const pieces = []
      const windows = snapshot?.windows ?? null
      if (snapshot !== null && snapshot.provider.kind === 'balance' && snapshot.balance !== null) {
        pieces.push(
          h(
            'span',
            { key: 'balance', className: 'dsh-tokenlens-metric dsh-tokenlens-money' },
            formatMoney(snapshot.balance.amount, snapshot.balance.currency),
          ),
        )
      } else if (snapshot !== null && snapshot.provider.kind === 'windows') {
        WINDOW_ORDER.forEach((id, index) => {
          if (index > 0) pieces.push(h('span', { key: `sep-${id}`, className: 'dsh-tokenlens-sep', 'aria-hidden': true }, '·'))
          pieces.push(
            h(
              'span',
              { key: `metric-${id}`, className: 'dsh-tokenlens-metric' },
              `${chipLabelFor(id, t)} ${formatPercent(windows?.[id]?.percent ?? null, t)}`,
            ),
          )
        })
      } else {
        pieces.push(h('span', { key: 'none', className: 'dsh-tokenlens-metric' }, t('chipNoUsage')))
      }
      return pieces
    }

    /** The chip's hover detail. */
    function chipTooltip(snapshot, providerId, t) {
      const providerLabel = providerLabelOf(snapshot, providerId) || t('title')
      if (snapshot !== null && snapshot.provider.kind === 'balance' && snapshot.balance !== null) {
        const parts = [formatMoney(snapshot.balance.amount, snapshot.balance.currency)]
        if (snapshot.balance.granted !== null && snapshot.balance.granted > 0) {
          parts.push(t('balanceGranted', { amount: formatMoney(snapshot.balance.granted, snapshot.balance.currency) }))
        }
        if (snapshot.balance.toppedUp !== null && snapshot.balance.toppedUp > 0) {
          parts.push(t('balanceToppedUp', { amount: formatMoney(snapshot.balance.toppedUp, snapshot.balance.currency) }))
        }
        return `${providerLabel} · ${parts.join(' · ')}`
      }
      if (snapshot !== null && snapshot.provider.kind === 'windows') {
        const summary = `${providerLabel} · ${windowsSummaryText(snapshot.windows, t)}`
        // A windows provider may also carry a wallet balance (OpenDesign): keep the
        // chip body unchanged and append the money to the hover detail only.
        if (snapshot.balance !== null) {
          return `${summary} · ${formatMoney(snapshot.balance.amount, snapshot.balance.currency)}`
        }
        return summary
      }
      return `${providerLabel} · ${t('chipNoUsage')}`
    }

    /** The chip when there is data. */
    function buildChip(state, t, sessionId) {
      const snapshot = normalizeSnapshot(state.snapshot)
      const brand = providerBrand(state, snapshot)
      const tooltip = chipTooltip(snapshot, state.providerId, t)
      return h(
        'span',
        { className: 'dsh-tokenlens-anchor', 'data-composer-stat': 'tokenlens' },
        h(
          Tooltip,
          { label: tooltip, side: 'top' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-tokenlens-chip',
              title: t('chipHint'),
              'aria-label': t('chipHint'),
              'aria-haspopup': 'dialog',
              onClick: () => openDialog(sessionId),
            },
            h('span', { className: 'dsh-tokenlens-dot', 'data-level': chipLevel(snapshot, state), 'aria-hidden': true }),
            h('span', { className: 'dsh-tokenlens-brand' }, brand),
            chipPieces(snapshot, state.providerId, t),
          ),
        ),
      )
    }

    /** The chip when the route has failed and there is no data yet. */
    function buildUnavailableChip(state, t, sessionId) {
      const brand = providerBrand(state, null)
      return h(
        'span',
        { className: 'dsh-tokenlens-anchor', 'data-composer-stat': 'tokenlens' },
        h(
          Tooltip,
          { label: t('chipUnavailable'), side: 'top' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-tokenlens-chip',
              title: t('chipUnavailable'),
              'aria-label': t('chipUnavailable'),
              'aria-haspopup': 'dialog',
              onClick: () => openDialog(sessionId),
            },
            h('span', { className: 'dsh-tokenlens-dot', 'data-level': 'warning', 'aria-hidden': true }),
            h('span', { className: 'dsh-tokenlens-brand' }, brand),
            h('span', { className: 'dsh-tokenlens-metric' }, t('chipUnavailable')),
          ),
        ),
      )
    }

    /** Build the chip; never throws. */
    function buildChipSafe(state, t, sessionId) {
      if (chipHidden(state)) return null
      if (normalizeSnapshot(state.snapshot) === null) {
        return state.error === null ? null : buildUnavailableChip(state, t, sessionId)
      }
      return buildChip(state, t, sessionId)
    }

    /** The composer-dock entry. */
    const UsageChip = React.memo(function UsageChip(props) {
      const state = useUsage()
      useProviderSync(props)
      const t = tOf(props)
      try {
        return buildChipSafe(state, t, props?.sessionId)
      } catch {
        // A broken chip must not take the composer down with it.
        return null
      }
    })

    // ---------------------------------------------------------------------
    // The detail dialog (session-scoped composer overlay).
    // ---------------------------------------------------------------------

    /** A 1s clock that runs only while the dialog is open. */
    function useDialogClock(active) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (active !== true) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [active])
      return now
    }

    /** Whether a mounted overlay should render the dialog (the click's session owns it). */
    function dialogOwnedBy(props, state) {
      if (state.dialogSessionId === null) return true
      return typeof props?.sessionId !== 'string' || props.sessionId === state.dialogSessionId
    }

    /** One allowance-window row: label + percent, bar, reset countdown, status. */
    function buildWindowRow(id, window, state, now, t, statsRow = null) {
      const label = rowLabel(id, t)
      const level = window === null ? 'unknown' : levelOf(window.percent, window.status)
      const percentText = formatPercent(window?.percent ?? null, t)
      const remaining = window === null ? null : remainingOf(window, state.loadedAt, now)
      const resetDate = window === null ? null : resetDateOf(window, state.loadedAt, now)
      // v0.30.13: local-token consumption + estimated consumable quota. The used
      // number comes from the selected provider's local stats buckets; the quota
      // is only an estimate derived from the provider-reported percentage.
      const localUsed =
        id === 'rolling'
          ? statsRow?.fiveHours?.total ?? 0
          : id === 'weekly'
            ? statsRow?.last7Days?.total ?? 0
            : id === 'monthly'
              ? statsRow?.last30Days?.total ?? 0
              : 0
      const percent = window !== null && Number.isFinite(window.percent) ? window.percent : null
      const quota = percent !== null && percent > 0 && localUsed > 0 ? localUsed / (percent / 100) : null
      // v0.30.13 follow-up: the estimate is INLINE on the existing reset line
      // (`{resetText} · 已消耗 X · 预计可消耗 Y`), never its own block row, so
      // the capacity card keeps its height.
      const tokensText = `${t('capacityTokenUsed', { used: formatTokensPrecise(localUsed) })} · ${
        quota === null
          ? t('capacityTokenNoEstimate')
          : t('capacityTokenEstimate', { quota: formatTokensPrecise(quota) })
      }`
      const resetText = window === null ? '' : formatReset(remaining, t)
      const tokensSpan =
        window === null
          ? null
          : h(
              'span',
              {
                key: 'tokens',
                className: 'dsh-tokenlens-capacity-tokens',
                'data-capacity-tokens': id,
                title: t('capacityTokenEstimateHint'),
              },
              resetText === '' ? tokensText : ` · ${tokensText}`,
            )
      // Provider-native allowance (Command Code: dollars). Omitted entirely when
      // the window cannot be sized, so the row never renders "$undefined".
      const capacityMoney =
        window !== null && Number.isFinite(window.used) && Number.isFinite(window.cap) && window.unit !== ''
          ? `${formatMoney(window.used, window.unit)} / ${formatMoney(window.cap, window.unit)}`
          : null
      const upstreamStatus =
        window !== null &&
        typeof window.status === 'string' &&
        window.status !== '' &&
        window.status !== OK_STATUS &&
        window.status !== 'unknown'
          ? h('span', { className: 'dsh-tokenlens-status', 'data-level': level }, t('statusPrefix', { status: window.status }))
          : null
      return h(
        'div',
        { key: id, className: 'dsh-tokenlens-row', 'data-window': id },
        h(
          'div',
          { className: 'dsh-tokenlens-row-head' },
          h('span', { className: 'dsh-tokenlens-row-label' }, label),
          h('span', { className: 'dsh-tokenlens-percent', 'data-level': level }, percentText),
          // Fallback when no reset text exists: same row as the percent content.
          resetText === '' ? tokensSpan : null,
        ),
        h(
          'div',
          {
            className: 'dsh-tokenlens-bar',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': window !== null && Number.isFinite(window.percent) ? window.percent : undefined,
            'aria-label': t('barLabel', { window: label, percent: percentText }),
          },
          h('span', {
            className: 'dsh-tokenlens-bar-fill',
            'data-level': level,
            style: { width: `${barWidth(window?.percent ?? null)}%` },
          }),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-row-foot' },
          resetText === '' ? null : h('span', { className: 'dsh-tokenlens-reset' }, resetText),
          resetDate === null ? null : h('span', { className: 'dsh-tokenlens-reset-date', title: resetDate }, resetDate),
          resetText === '' ? null : tokensSpan,
          capacityMoney === null
            ? null
            : h('span', { className: 'dsh-tokenlens-capacity-money' }, capacityMoney),
          upstreamStatus,
        ),
      )
    }

    /**
     * The wallet-balance row of a windows provider (OpenDesign).
     *
     * Some providers report allowance windows AND an independent account balance:
     * a `windows` snapshot may therefore carry a non-null `balance`. The row reuses
     * the window row's label/value layout so it reads as part of the same card, and
     * the shared narrow-screen wrapping of `.dsh-tokenlens-row-head` keeps it in view.
     */
    function buildCapacityBalanceRow(balance, t) {
      if (balance === null) return null
      return h(
        'div',
        { key: 'balance', className: 'dsh-tokenlens-row', 'data-capacity-balance': 'true' },
        h(
          'div',
          { className: 'dsh-tokenlens-row-head' },
          h('span', { className: 'dsh-tokenlens-row-label' }, t('balanceLabel')),
          h(
            'span',
            { className: 'dsh-tokenlens-percent dsh-tokenlens-capacity-money' },
            formatMoney(balance.amount, balance.currency),
          ),
        ),
      )
    }

    /** The provider/plan/account header line, or null when there is nothing to say. */
    function buildProviderHeader(snapshot, t) {
      if (snapshot === null) return null
      const parts = []
      const plan = snapshot.plan
      if (plan !== null && plan.label !== '') {
        parts.push(h('span', { key: 'plan', className: 'dsh-tokenlens-plan' }, t('planPrefix', { plan: plan.label })))
      }
      const account = snapshot.account
      const name =
        account === null
          ? ''
          : account.userName !== ''
            ? account.userName
            : account.name
      if (name !== '') parts.push(h('span', { key: 'account', className: 'dsh-tokenlens-account' }, t('accountPrefix', { name })))
      if (parts.length === 0) return null
      return h('div', { key: 'provider', className: 'dsh-tokenlens-provider' }, parts)
    }

    /** The account-balance card for balance providers. */
    function buildBalanceCard(snapshot, t) {
      const balance = snapshot.balance
      if (balance === null) return null
      const feet = []
      if (balance.granted !== null && balance.granted > 0) {
        feet.push(
          h('span', { key: 'granted' }, t('balanceGranted', { amount: formatMoney(balance.granted, balance.currency) })),
        )
      }
      if (balance.toppedUp !== null && balance.toppedUp > 0) {
        feet.push(
          h('span', { key: 'topped' }, t('balanceToppedUp', { amount: formatMoney(balance.toppedUp, balance.currency) })),
        )
      }
      if (balance.wallets.length > 0) {
        const amounts = balance.wallets.map((wallet) => formatMoney(wallet.amount, wallet.currency)).join(' · ')
        feet.push(h('span', { key: 'wallets' }, t('balanceWallets', { amounts })))
      }
      if (balance.bonus.length > 0) {
        const amounts = balance.bonus.map((wallet) => formatMoney(wallet.amount, wallet.currency)).join(' · ')
        feet.push(h('span', { key: 'bonus' }, t('balanceBonus', { amounts })))
      }
      return h(
        'div',
        { key: 'balance', className: 'dsh-tokenlens-balance' },
        h('div', { className: 'dsh-tokenlens-balance-label' }, t('balanceLabel')),
        h('div', { className: 'dsh-tokenlens-balance-amount' }, formatMoney(balance.amount, balance.currency)),
        feet.length === 0 ? null : h('div', { className: 'dsh-tokenlens-balance-foot' }, feet),
      )
    }

    /** The Command Code credits line (remaining / granted / purchased, USD). */
    function buildCreditsLine(snapshot, t) {
      const credits = snapshot.credits
      if (credits === null) return null
      const parts = []
      if (credits.remaining !== null) {
        parts.push(
          h('span', { key: 'remaining' }, t('creditsRemaining', { amount: formatMoney(credits.remaining, 'USD') })),
        )
      }
      if (credits.granted !== null) {
        parts.push(h('span', { key: 'granted' }, t('creditsGranted', { amount: formatMoney(credits.granted, 'USD') })))
      }
      if (credits.purchased !== null) {
        parts.push(
          h('span', { key: 'purchased' }, t('creditsPurchased', { amount: formatMoney(credits.purchased, 'USD') })),
        )
      }
      if (parts.length === 0) return null
      return h('div', { key: 'credits', className: 'dsh-tokenlens-credits' }, parts)
    }

    /** The error banner, with a retry button unless the Host says it cannot help. */
    function buildErrorBanner(error, t, onRetry, key) {
      const localized = describeError(error, t)
      const detail = typeof error?.message === 'string' ? error.message.trim() : ''
      const showDetail = detail !== '' && detail !== localized
      const actions = []
      if (error.retryable !== false) {
        actions.push(
          h(Button, { key: 'retry', variant: 'outline', className: 'dsh-tokenlens-retry', onClick: onRetry }, t('retry')),
        )
      }
      return h(
        'div',
        { key: key ?? 'error', className: 'dsh-tokenlens-banner', 'data-kind': 'error', role: 'alert' },
        h('div', { className: 'dsh-tokenlens-banner-title' }, localized),
        showDetail ? h('div', { className: 'dsh-tokenlens-banner-detail' }, detail) : null,
        actions.length > 0 ? h('div', { className: 'dsh-tokenlens-banner-actions' }, actions) : null,
      )
    }

    /** The usage "last updated" line plus a stale marker. */
    function buildMeta(state, snapshot, now, t) {
      if (snapshot === null) return null
      const fetchedMs = snapshot.fetchedAt !== '' ? Date.parse(snapshot.fetchedAt) : NaN
      const ageMs = Number.isFinite(fetchedMs) ? Math.max(0, now - fetchedMs) : snapshot.ageMs
      const clock = formatClock(snapshot.fetchedAt)
      let text = ''
      if (clock !== '') text = t('updatedAt', { time: clock })
      if (Number.isFinite(ageMs)) text += t('updatedAgo', { age: formatAge(ageMs, t) })
      const stale = state.error !== null || snapshot.stale === true
      return h(
        'div',
        { key: 'meta', className: 'dsh-tokenlens-meta' },
        h('span', { className: 'dsh-tokenlens-meta-text' }, text),
        stale ? h('span', { className: 'dsh-tokenlens-stale' }, t('stale')) : null,
      )
    }

    /** One time-window card of the token statistics. */
    function buildStatsCard(key, bucket, label, t) {
      const read = (field) => (bucket === null ? '—' : formatTokensPrecise(bucket[field]))
      return h(
        'div',
        { key, className: 'dsh-tokenlens-card' },
        h(
          'div',
          { className: 'dsh-tokenlens-card-head' },
          h('span', null, label),
          h('span', { className: 'dsh-tokenlens-card-total' }, read('total')),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-card-row' },
          h('span', null, t('statsInput')),
          h('span', { className: 'dsh-tokenlens-card-row-value' }, read('input')),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-card-row' },
          h('span', null, t('statsOutput')),
          h('span', { className: 'dsh-tokenlens-card-row-value' }, read('output')),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-card-row' },
          h('span', null, t('statsCacheRead')),
          h('span', { className: 'dsh-tokenlens-card-row-value' }, read('cacheRead')),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-card-requests' },
          bucket === null ? '—' : t('statsRequests', { n: formatCount(bucket.messages) }),
        ),
      )
    }

    /** The stats row for the current provider (cross-harness), or null. */
    function currentProviderStatsRow(stats, providerId) {
      if (stats === null) return null
      const id = canonicalProviderId(providerId)
      if (typeof id !== 'string' || id === '') return null
      return stats.providers.find((row) => canonicalProviderId(row.providerId) === id) ?? null
    }

    /** The effective local-usage scope: provider-scoped cards by default. */
    function resolveStatsScope(state, stats) {
      if (stats === null) return 'provider'
      return state.statsScope === 'all' ? 'all' : 'provider'
    }

    /** The 当前供应商 · 全部 Harness / 全部 Harness switch of the local-usage section. */
    function buildScopeSwitch(state, stats, effective, t) {
      const option = (scope, label) =>
        h(
          'button',
          {
            key: scope,
            type: 'button',
            className: 'dsh-tokenlens-scope-option',
            'data-scope': scope,
            'data-active': effective === scope ? 'true' : 'false',
            disabled: stats === null,
            onClick: () => store.set({ statsScope: scope, chartHover: null, chartDay: null }),
          },
          label,
        )
      return h(
        'div',
        { className: 'dsh-tokenlens-scope', role: 'group', 'aria-label': t('statsScopeLabel') },
        option('provider', t('statsTabProvider')),
        option('all', t('statsTabAll')),
      )
    }

    /** The 数据 / 图表 segmented toggle of the token section (v0.24.0). */
    function buildStatsViewToggle(state, t) {
      const active = state.statsView === 'chart' ? 'chart' : 'data'
      const option = (view, label, iconName) =>
        h(
          'button',
          {
            key: view,
            type: 'button',
            className: 'dsh-tokenlens-stats-view-option',
            'data-stats-view': view,
            'data-active': active === view ? 'true' : 'false',
            'aria-pressed': active === view ? 'true' : 'false',
            onClick: () => {
              if (active !== view) store.set({ statsView: view, chartHover: null, chartDay: null })
            },
          },
          Icon(iconName, 12),
          label,
        )
      return h(
        'div',
        {
          key: 'stats-view',
          className: 'dsh-tokenlens-stats-view',
          role: 'group',
          'aria-label': t('statsViewLabel'),
        },
        option('data', t('statsViewData'), 'list'),
        option('chart', t('statsViewChart'), 'chart'),
      )
    }

    /**
     * The daily provider ids the chart's provider scope matches (v0.24.0).
     *
     * Both the stats row id and the session-selected id are matched, in exact and
     * canonical form, so `deepseek-official` and `deepseek` find the same bucket.
     */
    function chartDailyProviderIds(ctx) {
      const wanted = []
      if (ctx.currentRow !== null && typeof ctx.currentRow.providerId === 'string' && ctx.currentRow.providerId !== '') {
        wanted.push(ctx.currentRow.providerId)
      }
      if (typeof ctx.selectedProviderId === 'string' && ctx.selectedProviderId !== '') {
        wanted.push(ctx.selectedProviderId)
      }
      return { wanted, canonicalWanted: new Set(wanted.map((id) => canonicalProviderId(id))) }
    }

    /** The daily provider bucket of one day in provider scope, or null. */
    function chartDailyProviderBucket(ctx, entry) {
      const { wanted, canonicalWanted } = chartDailyProviderIds(ctx)
      for (const [key, bucket] of Object.entries(entry.providers)) {
        if (wanted.includes(key) || canonicalWanted.has(canonicalProviderId(key))) return bucket ?? null
      }
      return null
    }

    /** The 24-hour histogram of one chart point, or null when unsupported. */
    function chartHoursOfPoint(point) {
      return point !== null && point !== undefined && Array.isArray(point.hours) && point.hours.length === 24
        ? point.hours
        : null
    }

    /** The `HH:00` label of one local hour of the drill-down chart (v1.2.0). */
    function chartHourLabel(hour) {
      return `${String(hour).padStart(2, '0')}:00`
    }

    /** Enter / Space activate a focusable chart bar (v1.2.0). */
    function isChartActivationKey(event) {
      const key = typeof event?.key === 'string' ? event.key : ''
      return key === 'Enter' || key === ' ' || key === 'Spacebar'
    }

    /**
     * Toggle the chart drill-down (v1.2.0): clicking a day charts its 0..23 hour
     * histogram; clicking the SAME day again returns to the daily trend.
     */
    function activateChartDay(day) {
      if (typeof day !== 'string' || day === '') return
      const next = store.get().chartDay === day ? null : day
      store.set({ chartDay: next, chartHover: null })
    }

    /** Leave the hourly drill-down and chart the daily trend again (v1.2.0). */
    function clearChartDay() {
      if (store.get().chartDay !== null) store.set({ chartDay: null, chartHover: null })
    }

    /**
     * The daily series of the chart (v0.24.0; v1.2.0 adds the day histograms).
     *
     * Provider scope reads the selected provider's daily bucket and limits the
     * window to the provider's effective day when it is subscription-backed
     * (fallback: the last 30 days). The all-harness scope uses the day totals of
     * the last 30 days. Every point also carries its 0..23 hour histogram
     * (`hours`, or null on old Hosts) so the chart can drill into one day.
     */
    function chartSeriesOf(ctx) {
      const stats = ctx.stats
      if (stats === null) return []
      const daily = stats.daily
      if (ctx.scope === 'all') {
        return daily.slice(-30).map((entry) => ({
          day: entry.day,
          total: entry.total?.total ?? 0,
          hours: entry.hours ?? null,
        }))
      }
      const series = daily.map((entry) => {
        const bucket = chartDailyProviderBucket(ctx, entry)
        return { day: entry.day, total: bucket?.total ?? 0, hours: bucket?.hours ?? null }
      })
      const effectiveDay = ctx.currentRow !== null ? ctx.currentRow.effectiveDay : ''
      if (ctx.subscribed && typeof effectiveDay === 'string' && effectiveDay !== '') {
        return series.filter((point) => point.day >= effectiveDay)
      }
      return series.slice(-30)
    }

    /** The 5 Y-axis ticks of the chart, max → 0, as `{ratio, value, text}`. */
    function chartAxisTicks(max) {
      return [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
        ratio,
        value: max * ratio,
        text: formatTokensPrecise(max * ratio),
      }))
    }

    /** The MM-DD axis label of one `YYYY-MM-DD` day (raw fallback). */
    function chartDayLabel(day) {
      const text = typeof day === 'string' ? day : ''
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text.slice(5) : text
    }

    /**
     * The X-axis label indices: every day for <=10 points, otherwise roughly six
     * evenly spaced labels that always include the first and the last day.
     */
    function chartXLabelIndices(count) {
      if (!Number.isFinite(count) || count <= 0) return []
      if (count <= 10) return Array.from({ length: count }, (_, index) => index)
      const step = Math.max(1, Math.ceil((count - 1) / 5))
      const indices = []
      for (let index = 0; index < count; index += step) indices.push(index)
      if (indices[indices.length - 1] !== count - 1) indices.push(count - 1)
      return indices
    }

    /**
     * The nearest bar index for a pointer event on the plot (v0.25.0), or null
     * when the event carries no usable geometry. Accepts a real DOM event
     * (`currentTarget.getBoundingClientRect()` + `clientX`) and a simplified test
     * event (`offsetX`/`clientX` + `currentTarget.clientWidth`).
     */
    function chartIndexFromEvent(event, count) {
      if (!Number.isFinite(count) || count <= 0) return null
      try {
        const target = event?.currentTarget
        const rect =
          target !== null && target !== undefined && typeof target.getBoundingClientRect === 'function'
            ? target.getBoundingClientRect()
            : null
        let width = rect !== null && Number.isFinite(rect.width) ? rect.width : null
        if (width === null || width <= 0) {
          const fallbackWidth = Number.isFinite(target?.clientWidth) ? target.clientWidth : null
          if (fallbackWidth !== null && fallbackWidth > 0) width = fallbackWidth
        }
        if (width === null || width <= 0) return null
        let offset = null
        if (rect !== null && Number.isFinite(event?.clientX) && Number.isFinite(rect.left)) {
          offset = event.clientX - rect.left
        } else if (Number.isFinite(event?.offsetX)) {
          offset = event.offsetX
        } else if (Number.isFinite(event?.clientX)) {
          offset = event.clientX
        }
        if (offset === null || !Number.isFinite(offset)) return null
        const ratio = Math.min(0.999999, Math.max(0, offset / width))
        return Math.min(count - 1, Math.floor(ratio * count))
      } catch {
        return null
      }
    }

    /** Record/clear the chart hover index without redundant store writes (v0.25.0). */
    function setChartHover(index) {
      const next = Number.isInteger(index) && index >= 0 ? index : null
      if (store.get().chartHover !== next) store.set({ chartHover: next })
    }

    /** The active today bucket of the current stats scope (v0.27.2). */
    function todayBucketOf(ctx) {
      return ctx.providerScoped ? ctx.currentRow?.today ?? null : ctx.stats?.today ?? null
    }

    /** The active second-window bucket (最近X天 or 最近30天) of the current scope. */
    function windowBucketOf(ctx) {
      const source = ctx.providerScoped ? ctx.currentRow : ctx.stats
      return typeof ctx.secondBucketOf === 'function' ? ctx.secondBucketOf(source) : null
    }

    /** The active rolling 7-day bucket of the current scope (v0.30.0). */
    function weekBucketOf(ctx) {
      return ctx.providerScoped ? ctx.currentRow?.last7Days ?? null : ctx.stats?.last7Days ?? null
    }

    /**
     * The shared pure-CSS bar plot of the chart modes (v0.25.0; v1.2.0 reuses
     * it for the hourly drill-down): Y-axis ticks, gridlines, bars, the X-axis
     * labels, the crosshair and the live pointer readout. Pure DOM, no deps.
     *
     * `spec.bar(point, index, meta)` returns the wrapper element of one bar
     * (`meta.max` / `meta.hovered` drive its height and highlight),
     * `spec.xLabel(point, index)` returns `{text, attrs}` for the X axis, and
     * `spec.readout(hovered, share)` returns the live readout text.
     */
    function buildChartPlot(state, points, spec) {
      const max = Math.max(...points.map((point) => point.total), 1)
      const total = points.reduce((sum, point) => sum + point.total, 0)
      const hoverIndex =
        Number.isInteger(state.chartHover) && state.chartHover >= 0 && state.chartHover < points.length
          ? state.chartHover
          : null
      const hovered = hoverIndex === null ? null : points[hoverIndex]
      const hoverShare = hovered === null || total <= 0 ? 0 : Math.round((hovered.total / total) * 1000) / 10
      const handleMove = (event) => {
        const index = chartIndexFromEvent(event, points.length)
        if (index !== null) setChartHover(index)
      }
      const handleLeave = () => setChartHover(null)
      const ticks = chartAxisTicks(max)
      const gridLines = ticks.map((tick) =>
        h('div', {
          key: `grid-${tick.ratio}`,
          className: 'dsh-tokenlens-chart-gridline',
          'data-chart-gridline': String(tick.ratio),
          'aria-hidden': 'true',
        }),
      )
      const yTicks = ticks.map((tick) =>
        h(
          'span',
          {
            key: `tick-${tick.ratio}`,
            className: 'dsh-tokenlens-chart-tick',
            'data-chart-tick': String(tick.ratio),
          },
          tick.text,
        ),
      )
      const bars = points.map((point, index) => spec.bar(point, index, { max, hovered: index === hoverIndex }))
      const xLabels = chartXLabelIndices(points.length).map((index) => {
        const point = points[index]
        const label = spec.xLabel(point, index)
        const first = index === 0
        const last = index === points.length - 1
        const style = first
          ? { left: '0%' }
          : last
            ? { right: '0%' }
            : { left: `${((index + 0.5) / points.length) * 100}%`, transform: 'translateX(-50%)' }
        return h(
          'span',
          {
            key: `x-${index}`,
            className: 'dsh-tokenlens-chart-x-label',
            ...(label.attrs === null || label.attrs === undefined ? {} : label.attrs),
            style,
          },
          label.text,
        )
      })
      const crosshair =
        hoverIndex === null
          ? null
          : h('div', {
              key: 'crosshair',
              className: 'dsh-tokenlens-chart-crosshair',
              'data-chart-crosshair': String(hoverIndex),
              'aria-hidden': 'true',
              style: { left: `${((hoverIndex + 0.5) / points.length) * 100}%` },
            })
      const readoutStyle =
        hovered === null
          ? undefined
          : hoverIndex === 0
            ? { left: '0%' }
            : hoverIndex === points.length - 1
              ? { right: '0%' }
              : { left: `${((hoverIndex + 0.5) / points.length) * 100}%`, transform: 'translateX(-50%)' }
      const readout =
        hovered === null
          ? null
          : h(
              'div',
              {
                key: 'readout',
                className: 'dsh-tokenlens-chart-readout',
                'data-chart-readout': 'true',
                role: 'status',
                style: readoutStyle,
              },
              spec.readout(hovered, hoverShare),
            )
      return h(
        'div',
        { key: 'body', className: 'dsh-tokenlens-chart-body' },
        h('div', { key: 'y-axis', className: 'dsh-tokenlens-chart-yaxis', 'aria-hidden': 'true' }, yTicks),
        h(
          'div',
          {
            key: 'plot',
            className: 'dsh-tokenlens-chart-plot',
            'data-chart-plot': 'true',
            onMouseMove: handleMove,
            onMouseLeave: handleLeave,
            onPointerMove: handleMove,
            onPointerLeave: handleLeave,
          },
          h('div', { key: 'grid', className: 'dsh-tokenlens-chart-grid', 'aria-hidden': 'true' }, gridLines),
          h('div', { key: 'bars', className: 'dsh-tokenlens-chart-bars' }, bars),
          crosshair,
          readout,
          h('div', { key: 'xaxis', className: 'dsh-tokenlens-chart-xaxis', 'aria-hidden': 'true' }, xLabels),
        ),
      )
    }

    /**
     * One bar of the daily trend chart (v0.25.0). A day whose entry carries the
     * 0..23 hour histogram is ALSO a real button (v1.2.0): focusable, Enter /
     * Space activate it, `aria-pressed` marks the drilled day. A day without
     * hours is not drillable and keeps the old non-interactive bar.
     */
    function buildDailyChartBar(state, t, point, meta) {
      const height = point.total > 0 ? Math.max(2, Math.round((point.total / meta.max) * 1000) / 10) : 0
      const drillable = chartHoursOfPoint(point) !== null
      const selected = drillable && state.chartDay === point.day
      const attrs = {
        key: point.day,
        className: drillable
          ? 'dsh-tokenlens-chart-bar-wrap dsh-tokenlens-chart-bar-wrap-clickable'
          : 'dsh-tokenlens-chart-bar-wrap',
        'data-chart-day': point.day,
        'data-chart-total': String(point.total),
        'data-chart-hover': meta.hovered ? 'true' : 'false',
        'data-chart-drillable': drillable ? 'true' : 'false',
        'data-chart-selected': selected ? 'true' : 'false',
        title: t('statsChartBarTitle', {
          date: point.day,
          tokens: formatTokensPrecise(point.total),
        }),
      }
      if (drillable) {
        attrs.role = 'button'
        attrs.tabIndex = 0
        attrs['aria-pressed'] = selected ? 'true' : 'false'
        attrs['aria-label'] = t('statsChartBarTitle', {
          date: point.day,
          tokens: formatTokensPrecise(point.total),
        })
        attrs.onClick = () => activateChartDay(point.day)
        attrs.onKeyDown = (event) => {
          if (!isChartActivationKey(event)) return
          if (typeof event?.preventDefault === 'function') event.preventDefault()
          activateChartDay(point.day)
        }
      }
      return h(
        'div',
        attrs,
        h('div', {
          className: 'dsh-tokenlens-chart-bar',
          'data-empty': point.total > 0 ? 'false' : 'true',
          'data-height': String(height),
          style: { height: `${height}%` },
        }),
      )
    }

    /**
     * The drilled day view (v1.2.0): one day's 00:00–23:00 token bars, with a
     * back button to the daily trend. It reuses the shared plot (axes, pointer
     * readout, tooltips) and the existing summary formatters.
     */
    function buildHourChart(state, point, hours, t) {
      const dayLabel = chartDayLabel(point.day)
      const hourPoints = hours.map((value, hour) => ({ hour, total: value }))
      const total = hourPoints.reduce((sum, hourPoint) => sum + hourPoint.total, 0)
      const head = h(
        'div',
        { key: 'drill-head', className: 'dsh-tokenlens-chart-drill-head', 'data-chart-drill-head': 'true' },
        h(
          'button',
          {
            key: 'back',
            type: 'button',
            className: 'dsh-tokenlens-chart-back',
            'data-chart-back': point.day,
            title: t('statsChartBackHint'),
            'aria-label': t('statsChartBack'),
            onClick: () => clearChartDay(),
          },
          t('statsChartBack'),
        ),
        h(
          'span',
          { key: 'title', className: 'dsh-tokenlens-chart-drill-title', 'data-chart-hour-title': point.day },
          t('statsChartHourTitle', { date: point.day }),
        ),
      )
      const containerAttrs = {
        key: 'chart',
        className: 'dsh-tokenlens-chart dsh-tokenlens-chart-drilldown',
        'data-chart': 'true',
        'data-chart-drilldown': 'true',
        'data-chart-drill-day': point.day,
      }
      if (total <= 0) {
        // A hosted histogram that is all zeros carries no data: say so instead of
        // inventing an empty 24-bar chart (old Hosts never get this far: their
        // bars are not drillable at all).
        return h(
          'div',
          containerAttrs,
          head,
          h(
            'div',
            { key: 'empty', className: 'dsh-tokenlens-chart-empty', 'data-chart-hour-empty': 'true' },
            h('span', { key: 'title', className: 'dsh-tokenlens-hint' }, t('statsChartHourEmpty')),
          ),
        )
      }
      let peak = hourPoints[0]
      for (const hourPoint of hourPoints) {
        if (hourPoint.total > peak.total) peak = hourPoint
      }
      const body = buildChartPlot(state, hourPoints, {
        bar: (hourPoint, index, meta) => {
          const height = hourPoint.total > 0 ? Math.max(2, Math.round((hourPoint.total / meta.max) * 1000) / 10) : 0
          return h(
            'div',
            {
              key: `hour-${hourPoint.hour}`,
              className: 'dsh-tokenlens-chart-bar-wrap',
              'data-chart-hour': String(hourPoint.hour),
              'data-chart-total': String(hourPoint.total),
              'data-chart-hover': meta.hovered ? 'true' : 'false',
              title: t('statsChartHourBarTitle', {
                date: dayLabel,
                hour: chartHourLabel(hourPoint.hour),
                tokens: formatTokensPrecise(hourPoint.total),
              }),
            },
            h('div', {
              className: 'dsh-tokenlens-chart-bar',
              'data-empty': hourPoint.total > 0 ? 'false' : 'true',
              'data-height': String(height),
              style: { height: `${height}%` },
            }),
          )
        },
        xLabel: (hourPoint) => ({
          text: chartHourLabel(hourPoint.hour),
          attrs: { 'data-chart-axis-hour': String(hourPoint.hour) },
        }),
        readout: (hovered, share) =>
          t('statsChartReadout', {
            date: `${dayLabel} ${chartHourLabel(hovered.hour)}`,
            value: formatTokensPrecise(hovered.total),
            share: String(share),
          }),
      })
      return h(
        'div',
        containerAttrs,
        head,
        body,
        h(
          'div',
          { key: 'summary', className: 'dsh-tokenlens-chart-summary' },
          h(
            'span',
            { key: 'total', 'data-chart-summary': 'hour-total' },
            t('statsChartTotal', { value: formatTokensPrecise(total) }),
          ),
          h(
            'span',
            { key: 'peak', 'data-chart-summary': 'hour-peak' },
            t('statsChartPeak', { value: formatTokensPrecise(peak.total), day: chartHourLabel(peak.hour) }),
          ),
        ),
      )
    }

    /** The pure-CSS daily bar chart: axes + live pointer readout (v0.25.0; no deps). */
    function buildDailyChart(state, ctx, t) {
      const points = chartSeriesOf(ctx)
      const total = points.reduce((sum, point) => sum + point.total, 0)
      if (points.length === 0 || total === 0) {
        return h(
          'div',
          { key: 'chart', className: 'dsh-tokenlens-chart', 'data-chart': 'true', 'data-chart-empty-series': 'true' },
          h(
            'div',
            { key: 'empty', className: 'dsh-tokenlens-chart-empty', 'data-chart-empty': 'true' },
            h('span', { key: 'title', className: 'dsh-tokenlens-hint' }, t('statsChartEmpty')),
            h(
              'span',
              { key: 'hint', className: 'dsh-tokenlens-hint dsh-tokenlens-chart-empty-hint' },
              t('statsChartEmptyHint'),
            ),
          ),
        )
      }
      // v1.2.0: a drilled day replaces the daily trend with its 24-hour
      // histogram. A stale selection (day gone / no hours) silently falls back to
      // the daily trend instead of charting a fabricated hour series.
      const drillPoint =
        typeof state.chartDay === 'string' && state.chartDay !== ''
          ? (points.find((point) => point.day === state.chartDay) ?? null)
          : null
      const drillHours = drillPoint === null ? null : chartHoursOfPoint(drillPoint)
      if (drillPoint !== null && drillHours !== null) return buildHourChart(state, drillPoint, drillHours, t)
      let peak = points[0]
      for (const point of points) {
        if (point.total > peak.total) peak = point
      }
      const body = buildChartPlot(state, points, {
        bar: (point, index, meta) => buildDailyChartBar(state, t, point, meta),
        xLabel: (point) => ({
          text: chartDayLabel(point.day),
          attrs: { 'data-chart-axis-day': point.day },
        }),
        readout: (hovered, share) =>
          t('statsChartReadout', {
            date: hovered.day,
            value: formatTokensPrecise(hovered.total),
            share: String(share),
          }),
      })
      return h(
        'div',
        { key: 'chart', className: 'dsh-tokenlens-chart', 'data-chart': 'true' },
        body,
        h(
          'div',
          { key: 'summary', className: 'dsh-tokenlens-chart-summary' },
          h(
            'span',
            { key: 'today', 'data-chart-summary': 'today' },
            `${t('statsToday')} ${formatTokensPrecise(todayBucketOf(ctx)?.total ?? 0)}`,
          ),
          ctx.hasWeek
            ? h(
                'span',
                { key: 'week', 'data-chart-summary': 'week' },
                `${t('statsLast7Days')} ${formatTokensPrecise(weekBucketOf(ctx)?.total ?? 0)}`,
              )
            : null,
          h(
            'span',
            { key: 'window', 'data-chart-summary': 'window' },
            `${ctx.secondLabel} ${formatTokensPrecise(windowBucketOf(ctx)?.total ?? 0)}`,
          ),
          h(
            'span',
            { key: 'total', 'data-chart-summary': 'total' },
            t('statsChartTotal', { value: formatTokensPrecise(total) }),
          ),
          h(
            'span',
            { key: 'peak', 'data-chart-summary': 'peak' },
            t('statsChartPeak', { value: formatTokensPrecise(peak.total), day: peak.day }),
          ),
        ),
      )
    }

    /** Expand/collapse the DSH-only detail blocks (no-scroll responsive layout). */
    function toggleStatsDetails() {
      store.set({ showDetails: store.get().showDetails !== true })
    }

    /**
     * The dialog shell: a fixed overlay with an explicitly sized panel.
     *
     * The primitives Modal sizes itself to its content (fit-content); a wide
     * dialog would then be squeezed by the two-column content's min-content
     * width. This shell owns the width/height so the layout can use the whole
     * viewport and never needs an internal scrollbar.
     */
    function DialogShell(props) {
      const { title, closeLabel, footer, onClose, children } = props
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            try {
              onClose?.()
            } catch {
              /* closing must never throw */
            }
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      const close = () => {
        try {
          onClose?.()
        } catch {
          /* closing must never throw */
        }
      }
      return h(
        'div',
        {
          className: 'dsh-tokenlens-overlay',
          role: 'presentation',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'dsh-tokenlens-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h(
            'div',
            { className: 'dsh-tokenlens-modal-head' },
            h('span', { className: 'dsh-tokenlens-modal-title' }, title),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-tokenlens-modal-close',
                'aria-label': closeLabel,
                onClick: close,
              },
              '×',
            ),
          ),
          h('div', { className: 'dsh-tokenlens-modal-body' }, children),
          footer === undefined || footer === null ? null : h('div', { className: 'dsh-tokenlens-modal-foot' }, footer),
        ),
      )
    }

    /** The caption above the cards naming exactly what they aggregate. */
    function statsCardsCaption(stats, scope, currentRow, providerLabel, t) {
      if (stats === null) return ''
      if (scope === 'all') return stats.version >= 2 ? t('statsCombinedLabel') : t('statsDshTotalLabel')
      if (currentRow !== null) return t('statsProviderScopeLabel', { provider: currentRow.label })
      return t('statsProviderFallback', { provider: providerLabel || '—' })
    }

    /**
     * The token-section subtitle: a generic line plus the ACTIVE harness names
     * (the Host's harness list is arbitrary and grows, so nothing is assumed).
     */
    function statsSubtitleText(stats, t) {
      const base = t('statsSubtitle')
      if (stats === null) return base
      const labels = stats.harnesses.map((harness) => harness.label).filter((label) => typeof label === 'string' && label !== '')
      if (labels.length === 0) return base
      const shown = labels.slice(0, 4)
      const more = labels.length > shown.length ? t('statsSubtitleMore', { n: labels.length }) : ''
      return t('statsSubtitleList', { base, list: shown.join(' + ') + more })
    }

    /** The harness rows for the active scope (provider split or all-harness). */
    function scopedHarnessRows(ctx) {
      const { stats, scope, currentRow } = ctx
      if (scope === 'all' || currentRow === null) {
        return stats.harnesses.map((harness) => ({
          harnessId: harness.harnessId,
          label: harness.label,
          buckets: {
            today: harness.today,
            last7Days: harness.last7Days,
            last30Days: harness.last30Days,
            allTime: harness.allTime,
            sinceEffective: harness.sinceEffective,
          },
          present:
            harness.today !== null ||
            harness.last7Days !== null ||
            harness.last30Days !== null ||
            harness.allTime !== null,
          missing: harness.missing === true,
          error: harness.error,
        }))
      }
      // Provider scope: each harness's contribution to this cross-harness row.
      // The harness set is arbitrary: follow the Host's harness order, then add
      // any extra split keys the provider row carries (defensive).
      const rows = []
      const seen = new Set()
      const pushHarness = (harnessId) => {
        if (seen.has(harnessId)) return
        seen.add(harnessId)
        const harness = stats.harnesses.find((entry) => entry.harnessId === harnessId) ?? null
        const split = Object.prototype.hasOwnProperty.call(currentRow.harnesses, harnessId)
          ? currentRow.harnesses[harnessId]
          : null
        rows.push({
          harnessId,
          label: harness !== null ? harness.label : harnessLabel(harnessId, ''),
          buckets: split,
          present: split !== null,
          missing: harness !== null && harness.missing === true,
          error: harness !== null ? harness.error : null,
        })
      }
      for (const harness of stats.harnesses) pushHarness(harness.harnessId)
      for (const harnessId of Object.keys(currentRow.harnesses)) pushHarness(harnessId)
      // The user rule: in provider scope, a harness with no usage in the
      // provider's effective window is not shown at all (no muted placeholder row).
      return rows.filter((row) => {
        if (row.buckets === null) return false
        if (ctx.hasMonth) return (ctx.secondBucketOf(row.buckets)?.total ?? 0) > 0
        return (row.buckets.allTime?.total ?? 0) > 0
      })
    }

    /** The short header label of the rolling 7-day window in the compact tables. */
    function detailsWeekLabel(t) {
      return t('statsLast7Days')
    }

    /** The full header label of the second window (最近X天 or 最近30天). */
    function detailsSecondLabel(ctx, t) {
      if (ctx.subscribed && Number.isFinite(ctx.effectiveDays) && ctx.effectiveDays >= 1) {
        return t('statsSinceEffective', { n: Math.floor(ctx.effectiveDays) })
      }
      return t('statsLast30Days')
    }

    /**
     * The 明细 donut windows in display order (v1.2.0): 今日 → 最近7天 →
     * 最近X天/最近30天 → 总计. Old Hosts omit the 7-day / second windows, so their
     * pills are hidden (never disabled ghosts of a window that cannot exist).
     */
    function detailsWindowChoices(ctx, t) {
      const choices = [{ key: 'today', label: t('statsTodayCol') }]
      if (ctx.hasWeek) choices.push({ key: 'last7Days', label: t('statsLast7Days') })
      if (ctx.hasMonth) choices.push({ key: 'second', label: detailsSecondLabel(ctx, t) })
      choices.push({ key: 'total', label: t('statsAllTimeCol') })
      return choices
    }

    /**
     * The active 明细 donut window (v1.2.1): the stored choice while that window
     * still exists, else 总计. Since v1.2.1 the choice is also persisted to the
     * plugin settings (the startup bootstrap loads it back), so reopening the
     * dialog / restarting DSH restores it.
     */
    function detailsWindowOf(state, ctx) {
      const key = typeof state.detailsWindow === 'string' ? state.detailsWindow : 'total'
      if (key === 'today') return 'today'
      if (key === 'last7Days') return ctx.hasWeek ? 'last7Days' : 'total'
      if (key === 'second') return ctx.hasMonth ? 'second' : 'total'
      return 'total'
    }

    /**
     * The bucket of one 明细 row for a donut window (v1.2.0). Harness/provider
     * rows carry the four stats windows directly; model rows use the caller's
     * second-window accessor (`secondModelOf`) for the effective-window column.
     */
    function detailsWindowBucketOf(windowKey, buckets, secondBucketOf) {
      if (buckets === null || buckets === undefined) return null
      if (windowKey === 'today') return buckets.today ?? null
      if (windowKey === 'last7Days') return buckets.last7Days ?? null
      if (windowKey === 'second') {
        return typeof secondBucketOf === 'function' ? secondBucketOf(buckets) : buckets.last30Days ?? null
      }
      return buckets.allTime ?? null
    }

    /** The token total of one 明细 row for a donut window (v1.2.0). */
    function detailsWindowTotalOf(windowKey, buckets, secondBucketOf) {
      const bucket = detailsWindowBucketOf(windowKey, buckets, secondBucketOf)
      return bucket === null ? 0 : bucket.total ?? 0
    }

    /** The window pill row under the 明细 donut title (v1.2.0; saved since v1.2.1). */
    function buildDetailsWindowSwitch(state, ctx, t) {
      const active = detailsWindowOf(state, ctx)
      const option = (key, label) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'dsh-tokenlens-scope-option',
            'data-details-window': key,
            'data-active': active === key ? 'true' : 'false',
            'aria-pressed': active === key ? 'true' : 'false',
            onClick: () => {
              if (active !== key) {
                store.set({ detailsWindow: key })
                persistDetailsWindow()
              }
            },
          },
          label,
        )
      return h(
        'div',
        { key: 'details-window', className: 'dsh-tokenlens-details-window', 'data-details-window-switch': 'true' },
        h(
          'div',
          { key: 'scope', className: 'dsh-tokenlens-scope', role: 'group', 'aria-label': t('statsWindowLabel') },
          detailsWindowChoices(ctx, t).map((choice) => option(choice.key, choice.label)),
        ),
      )
    }

    /**
     * The compact 明细 table columns of one group (v0.30.2). Harness/provider
     * rows start at 今日; the all-harness top-model table starts at the
     * 7-day/30-day windows. Old Hosts omit the 7-day column entirely.
     */
    function detailsTableColumns(ctx, t, kind) {
      const columns = []
      if (!(kind === 'model' && !ctx.providerScoped)) {
        columns.push({ key: 'today', label: t('statsTodayCol') })
      }
      if (ctx.hasWeek) columns.push({ key: 'week', label: detailsWeekLabel(t) })
      if (ctx.hasMonth) columns.push({ key: 'second', label: detailsSecondLabel(ctx, t) })
      columns.push({ key: 'total', label: t('statsAllTimeCol') })
      return columns
    }

    /** The delivered 3-decimal window values, in the same order as the columns. */
    function detailsTableValues(buckets, ctx, secondBucketOf, kind) {
      const read = (bucket) => formatTokensPrecise(bucket === null || bucket === undefined ? 0 : bucket.total)
      const missing = buckets === null || buckets === undefined
      const values = []
      if (!(kind === 'model' && !ctx.providerScoped)) values.push(missing ? '—' : read(buckets.today))
      if (ctx.hasWeek) values.push(missing ? '—' : read(buckets.last7Days))
      if (ctx.hasMonth) {
        if (missing) {
          values.push('—')
        } else {
          const second = typeof secondBucketOf === 'function' ? secondBucketOf(buckets) : buckets.last30Days
          values.push(second === null || second === undefined ? '—' : read(second))
        }
      }
      values.push(missing ? '—' : read(buckets.allTime))
      return values
    }

    /** The window `<col>` elements: an auto name column + one 54px column per window. */
    function buildDetailsTableColgroup(columns) {
      return h(
        'colgroup',
        { key: 'colgroup' },
        h('col', { key: 'name', className: 'dsh-tokenlens-details-table-col-name' }),
        columns.map((column) =>
          h('col', { key: column.key, className: 'dsh-tokenlens-details-table-col-window', style: { width: '64px' } }),
        ),
      )
    }

    /** The single `<thead>` of one details table: spacer + one label per window. */
    function buildDetailsTableHead(columns, nameHeader) {
      return h(
        'thead',
        { key: 'head', className: 'dsh-tokenlens-details-table-head', style: { display: 'table-header-group' } },
        h(
          'tr',
          { style: { display: 'table-row' } },
          h('th', {
            key: 'spacer',
            className: 'dsh-tokenlens-details-table-spacer',
            scope: 'col',
            style: {
              display: 'table-cell',
              textAlign: 'left',
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: '12px',
              fontWeight: 400,
              lineHeight: 1.5,
              padding: '0 2px 1px',
              borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.18))',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }, nameHeader),
          columns.map((column) =>
            h(
              'th',
              { key: column.key, className: 'dsh-tokenlens-details-table-label', 'data-window-label': column.key, scope: 'col' },
              column.label,
            ),
          ),
        ),
      )
    }

    /** The compact 明细 table of one column: real `<table>` with header + one-row items. */
    function buildDetailsTable(columns, rows, extraClassName, nameHeader) {
      const className = `dsh-tokenlens-details-table${extraClassName === undefined ? '' : ` ${extraClassName}`}`
      return h('table', { className, 'data-details-table': 'true', style: { display: 'table', width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' } }, [
        buildDetailsTableColgroup(columns),
        buildDetailsTableHead(columns, nameHeader),
        h('tbody', { key: 'body', className: 'dsh-tokenlens-details-table-body', style: { display: 'table-row-group' } }, rows),
      ])
    }

    /**
     * One data item as ONE `<tr>` (v0.30.8): a name cell (up to two lines, title
     * tooltip) followed by one right-aligned value cell per window, so the header
     * labels and the values are literally the same table columns.
     */
    function buildDetailsTableItem(name, values, options = {}) {
      const extras = options.attrs !== null && typeof options.attrs === 'object' ? options.attrs : {}
      const title = options.title === undefined ? name : options.title
      return h(
        'tr',
        {
          key: options.key === undefined ? name : options.key,
          className: 'dsh-tokenlens-details-table-row',
          'data-details-row': name,
          style: { display: 'table-row' },
          ...extras,
        },
        h('td', { className: 'dsh-tokenlens-details-table-name', title, style: { display: 'table-cell', textAlign: 'left' } }, h('div', { className: 'dsh-tokenlens-details-table-name-text' }, name)),
        values.map((value, index) =>
          h(
            'td',
            { key: `cell-${index}`, className: 'dsh-tokenlens-details-table-cell', 'data-window-value': String(index), style: { display: 'table-cell', textAlign: 'right' } },
            value,
          ),
        ),
      )
    }

    /** A single full-width `<tr>` note/subhead/error row inside the same table. */
    function buildDetailsTableNoteRow(key, colSpan, className, children, attrs) {
      const extras = attrs !== null && typeof attrs === 'object' ? attrs : {}
      return h(
        'tr',
        { key, className: 'dsh-tokenlens-details-table-row', style: { display: 'table-row' }, ...extras },
        h('td', { className: `dsh-tokenlens-details-table-note${className === undefined ? '' : ` ${className}`}`, colSpan, style: { display: 'table-cell' } }, children),
      )
    }

    /** A muted caption row between compact table items (ZCode mapped/unmapped). */
    function buildDetailsSubhead(key, label, colSpan) {
      return buildDetailsTableNoteRow(key, colSpan, 'dsh-tokenlens-details-subhead', label)
    }

    /** One harness row of the 「按 Harness」column (ZCode gets an error state). */
    function buildHarnessBlock(row, ctx, t) {
      const missing = row.missing === true
      const errored = row.error !== null && !missing
      const muted = !row.present || errored || missing
      const columns = detailsTableColumns(ctx, t, 'standard')
      if (missing || errored) {
        return buildDetailsTableNoteRow(
          'row',
          columns.length + 1,
          'dsh-tokenlens-harness-error-row',
          [
            h('span', { key: 'name', className: 'dsh-tokenlens-details-table-name', title: row.label }, row.label),
            h(
              'span',
              { key: 'state', className: 'dsh-tokenlens-harness-unavailable' },
              missing ? t('statsHarnessMissing') : t('statsHarnessUnavailable'),
            ),
            h(
              'span',
              { key: 'hint', className: 'dsh-tokenlens-harness-hint' },
              missing ? t('statsHarnessMissingHint') : t('statsHarnessRetryHint'),
            ),
          ],
          {
            className: 'dsh-tokenlens-details-table-row dsh-tokenlens-harness-row dsh-tokenlens-harness-error-row',
            'data-harness': row.harnessId,
            'data-details-row': row.label,
            'data-muted': 'true',
          },
        )
      }
      const requests = t('statsRequests', { n: formatCount(row.buckets?.allTime?.messages ?? 0) })
      return buildDetailsTableItem(row.label, detailsTableValues(row.buckets, ctx, ctx.secondBucketOf), {
        title: `${row.label} · ${requests}`,
        attrs: {
          className: 'dsh-tokenlens-details-table-row dsh-tokenlens-harness-row',
          'data-harness': row.harnessId,
          'data-muted': muted ? 'true' : 'false',
        },
      })
    }

    /** The 「按 Harness」column body, following the active scope (+ ZCode notes). */
    function harnessColumnChildren(ctx, t) {
      const { stats, scope } = ctx
      const rows = scopedHarnessRows(ctx)
      if (rows.length === 0) {
        if (ctx.providerScoped) {
          return [h('div', { key: 'empty', className: 'dsh-tokenlens-unmapped-hint' }, t('statsProviderHarnessEmpty'))]
        }
        return []
      }
      const columns = detailsTableColumns(ctx, t, 'standard')
      const colSpan = columns.length + 1
      const tableChildren = rows.map((row) => buildHarnessBlock(row, ctx, t))
      if (stats.missingHarnesses.length > 0) {
        tableChildren.push(
          buildDetailsTableNoteRow('missing-harnesses', colSpan, 'dsh-tokenlens-unmapped', [
            h(
              'div',
              { key: 'hint', className: 'dsh-tokenlens-harness-hint' },
              t('statsMissingHarnesses', {
                list: stats.missingHarnesses.map((id) => harnessLabel(id, '')).join(' / '),
              }),
            ),
            h('div', { key: 'detail', className: 'dsh-tokenlens-unmapped-hint' }, t('statsMissingHarnessesHint')),
          ]),
        )
      }
      // The mapped/unmapped provider detail is a ZCode-ownership explanation and
      // only makes sense in the all-harness scope. Same-shaped compact rows.
      if (scope === 'all' && stats.zcode !== null) {
        if (stats.zcode.available) {
          const mapped = stats.zcode.mappedProviders.slice(0, MAX_MODEL_ROWS)
          if (mapped.length > 0) {
            mapped.forEach((provider) => {
              tableChildren.push(
                buildDetailsTableItem(provider.label, detailsTableValues(provider, ctx, ctx.secondBucketOf), {
                  key: provider.providerId,
                  attrs: { className: 'dsh-tokenlens-details-table-row dsh-tokenlens-harness-provider-row' },
                }),
              )
            })
          }
        }
        const unmapped = stats.zcode.unmapped.slice(0, 2)
        if (unmapped.length > 0) {
          tableChildren.push(buildDetailsSubhead('unmapped-head', t('statsUnmapped'), colSpan))
          unmapped.forEach((provider) => {
            tableChildren.push(
              buildDetailsTableItem(provider.label, detailsTableValues(provider, ctx, ctx.secondBucketOf), {
                key: provider.providerId,
                attrs: {
                  className: 'dsh-tokenlens-details-table-row dsh-tokenlens-harness-provider-row',
                  'data-unmapped': 'true',
                },
              }),
            )
          })
          tableChildren.push(
            buildDetailsTableNoteRow('unmapped-hint', colSpan, 'dsh-tokenlens-unmapped-hint', t('statsUnmappedHint')),
          )
        }
      }
      return [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-breakdown-head' },
          h(
            'span',
            { className: 'dsh-tokenlens-head-label' },
            Icon('list', 13),
            h('span', { key: 'label' }, t('statsByHarness')),
          ),
        ),
        buildDetailsTable(columns, tableChildren, undefined, t('statsNameColHarness')),
      ]
    }

    /**
     * Section 1: the server-side plan capacity in provider-native units.
     *
     * OpenCode reports percentages only; Command Code adds the native dollar
     * capacity on each window (`used / cap`); DeepSeek providers report a balance
     * card. This section is explicitly labelled as provider-API data so it cannot
     * be mistaken for the local session counters in section 2.
     */
    function buildCapacitySection(state, now, t) {
      const snapshot = normalizeSnapshot(state.snapshot)
      // v0.30.13: the local stats provider row powers the per-window consumed /
      // estimated-quota line. Missing stats (null/loading) simply render zeros.
      const stats = normalizeStats(state.stats)
      const wantedProviderId = state.providerId !== null ? state.providerId : (snapshot?.provider?.id ?? null)
      let statsRow = currentProviderStatsRow(stats, wantedProviderId)
      if (statsRow === null && stats !== null && snapshot !== null) {
        const providerLabel = snapshot.provider?.label ?? ''
        if (providerLabel !== '') {
          statsRow = stats.providers.find((row) => row.label === providerLabel) ?? null
        }
      }
      const section = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { className: 'dsh-tokenlens-section-title' },
            Icon('gauge', 14),
            h('span', { key: 'label' }, t('capacityTitle')),
          ),
          h('span', { className: 'dsh-tokenlens-section-meta dsh-tokenlens-source' }, t('capacitySource')),
        ),
      ]
      if (state.error !== null) {
        section.push(
          buildErrorBanner(
            state.error,
            t,
            () => {
              void requestUsage('refresh')
            },
            'usage-error',
          ),
        )
      }
      if (snapshot !== null) {
        const header = buildProviderHeader(snapshot, t)
        if (header !== null) section.push(header)
        if (snapshot.provider.kind === 'balance') {
          const card = buildBalanceCard(snapshot, t)
          if (card !== null) section.push(card)
          else section.push(h('div', { key: 'no-balance', className: 'dsh-tokenlens-hint' }, t('chipNoUsage')))
        } else if (snapshot.provider.kind === 'windows') {
          // A windows provider may ALSO report an independent wallet balance
          // (OpenDesign): show it as one extra row of the same capacity card,
          // after the allowance windows (or after the "no usage" hint).
          const balanceRow = buildCapacityBalanceRow(snapshot.balance, t)
          if (snapshot.windows !== null) {
            const rows = WINDOW_ORDER.map((id) => buildWindowRow(id, snapshot.windows[id], state, now, t, statsRow))
            if (balanceRow !== null) rows.push(balanceRow)
            section.push(h('div', { key: 'rows', className: 'dsh-tokenlens-rows' }, rows))
          } else {
            section.push(h('div', { key: 'no-windows', className: 'dsh-tokenlens-hint' }, t('chipNoUsage')))
            if (balanceRow !== null) section.push(balanceRow)
          }
        } else {
          section.push(h('div', { key: 'no-kind', className: 'dsh-tokenlens-hint' }, t('chipNoUsage')))
        }
        const credits = buildCreditsLine(snapshot, t)
        if (credits !== null) section.push(credits)
        const meta = buildMeta(state, snapshot, now, t)
        if (meta !== null) section.push(meta)
      } else if (state.error === null) {
        section.push(h('div', { key: 'loading', className: 'dsh-tokenlens-loading' }, t('loading')))
      }
      return h('div', { key: 'capacity', className: 'dsh-tokenlens-section dsh-tokenlens-capacity' }, section)
    }

    /**
     * The shared local-stats context of the two stats columns (summary + details).
     *
     * v0.22.0: provider scope uses the provider's LOCAL EFFECTIVE WINDOW as the
     * second column — `sinceEffective`, labelled 最近{effectiveDays}天 — while the
     * all-harness scope keeps the fixed 最近30天 column. Old Hosts without the new
     * fields fall back to `last30Days` and keep the 最近30天 label.
     */
    function statsContextOf(state, t) {
      const stats = normalizeStats(state.stats)
      const currentRow = currentProviderStatsRow(stats, state.providerId)
      const scope = resolveStatsScope(state, stats)
      const providerScoped = scope === 'provider' && currentRow !== null
      // Subscription-backed providers show 最近{effectiveDays}天; pay-as-you-go /
      // balance providers keep the fixed 最近30天 window (v0.22.1).
      const subscribed = providerScoped && currentRow.subscribed === true
      const effectiveDays =
        subscribed && Number.isFinite(currentRow.effectiveDays) && currentRow.effectiveDays >= 1
          ? Math.floor(currentRow.effectiveDays)
          : null
      const secondLabel =
        subscribed && effectiveDays !== null
          ? t('statsSinceEffective', { n: effectiveDays })
          : t('statsLast30Days')
      const secondBucketOf = subscribed
        ? (buckets) => buckets?.sinceEffective ?? buckets?.last30Days ?? null
        : (buckets) => buckets?.last30Days ?? null
      // Model rows: provider scope uses the effective total for subscription
      // providers, and the legacy 30-day series otherwise.
      const secondModelOf = subscribed
        ? (model) => model?.sinceEffective ?? model?.allTime ?? null
        : (model) => model?.last30Days ?? null
      const hasMonth = providerScoped
        ? subscribed
          ? currentRow.sinceEffective !== null || currentRow.last30Days !== null
          : currentRow.last30Days !== null
        : stats !== null && stats.last30Days !== null
      // v0.30.0: the optional rolling 7-day window. Old Hosts omit it and every
      // 7-day card/column/summary item is then left out entirely.
      const hasWeek = providerScoped
        ? currentRow.last7Days !== null
        : stats !== null && stats.last7Days !== null
      return {
        stats,
        currentRow,
        scope,
        providerScoped,
        subscribed,
        hasMonth,
        hasWeek,
        effectiveDays,
        secondLabel,
        secondBucketOf,
        secondModelOf,
        // v0.24.0: the chart looks up daily provider buckets by the selected id.
        selectedProviderId: state.providerId,
      }
    }

    /**
     * Section 2 (middle column): local DSH + ZCode token records, PROVIDER-SCOPED
     * by default.
     *
     * The default cards show the selected provider's tokens across every local
     * harness (DSH + ZCode); the second tab shows the all-harness totals. The
     * second window is 最近{effectiveDays}天 in provider scope (v0.22.0) and
     * 最近30天 in all-harness scope, with a two-window fallback for older Hosts.
     */
    function buildStatsSummary(state, ctx, t) {
      const { stats, currentRow, scope, hasMonth } = ctx
      // Provider scope uses the cross-harness provider row; when the provider has
      // no local records the cards fall back to the all-harness totals.
      const providerScoped = ctx.providerScoped
      const scopedToday = providerScoped ? currentRow.today : stats?.today ?? null
      const scopedWeek = providerScoped ? currentRow.last7Days : stats?.last7Days ?? null
      const scopedMonth = providerScoped ? ctx.secondBucketOf(currentRow) : stats?.last30Days ?? null
      const scopedAll = providerScoped ? currentRow.allTime : stats?.allTime ?? null
      const snapshot = normalizeSnapshot(state.snapshot)
      const providerLabel = currentRow !== null ? currentRow.label : providerLabelOf(snapshot, state.providerId)
      const generated = stats !== null ? formatClock(stats.generatedAt) : ''
      const section = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { className: 'dsh-tokenlens-section-title' },
            Icon('chart', 14),
            h('span', { key: 'label' }, t('statsTitle')),
          ),
          generated === '' ? null : h('span', { className: 'dsh-tokenlens-section-meta' }, t('statsGenerated', { time: generated })),
        ),
        h('div', { key: 'subtitle', className: 'dsh-tokenlens-subtitle' }, statsSubtitleText(stats, t)),
        h(
          'div',
          { key: 'scope', className: 'dsh-tokenlens-scope-row' },
          buildScopeSwitch(state, stats, scope, t),
        ),
      ]
      if (state.statsError !== null) {
        section.push(
          buildErrorBanner(
            state.statsError,
            t,
            () => {
              void requestStats({ fresh: true })
            },
            'stats-error',
          ),
        )
      }
      const chartView = state.statsView === 'chart'
      if (stats !== null) {
        if (chartView) {
          // v0.24.0: 图表 mode replaces the cards/details with the daily chart.
          try {
            section.push(buildDailyChart(state, ctx, t))
          } catch {
            section.push(h('div', { key: 'chart-error', className: 'dsh-tokenlens-hint' }, t('statsEmpty')))
          }
        } else {
          const totalOf = (bucket) => (bucket === null ? 0 : bucket.total)
          const empty =
            totalOf(stats.today) === 0 &&
            totalOf(stats.last7Days) === 0 &&
            totalOf(stats.last30Days) === 0 &&
            totalOf(stats.allTime) === 0 &&
            stats.harnesses.length === 0 &&
            stats.providers.length === 0 &&
            stats.models.length === 0 &&
            stats.daily.length === 0
          if (empty) {
            section.push(h('div', { key: 'empty', className: 'dsh-tokenlens-hint' }, t('statsEmpty')))
          } else {
            const caption = statsCardsCaption(stats, scope, currentRow, providerLabel, t)
            if (caption !== '') {
              section.push(h('div', { key: 'cards-caption', className: 'dsh-tokenlens-cards-caption' }, caption))
            }
            const cards = [buildStatsCard('today', scopedToday, t('statsToday'), t)]
            if (ctx.hasWeek) cards.push(buildStatsCard('week', scopedWeek, t('statsLast7Days'), t))
            if (hasMonth) cards.push(buildStatsCard('month', scopedMonth, ctx.secondLabel, t))
            cards.push(buildStatsCard('all', scopedAll, t('statsAllTime'), t))
            section.push(h('div', { key: 'cards', className: 'dsh-tokenlens-cards' }, cards))
            if (stats.providers.length > 0 || stats.models.length > 0) {
              section.push(
                h(
                  'button',
                  {
                    key: 'details-toggle',
                    type: 'button',
                    className: 'dsh-tokenlens-details-toggle',
                    'aria-expanded': state.showDetails === true,
                    onClick: () => toggleStatsDetails(),
                  },
                  Icon('layers', 13),
                  state.showDetails === true ? t('statsLessDetails') : t('statsMoreDetails'),
                ),
              )
            }

            // The right column owns the harness / provider / model detail blocks.
          }
        }
      } else if (state.statsError === null) {
        section.push(h('div', { key: 'loading', className: 'dsh-tokenlens-loading' }, t('statsLoading')))
      }
      return h(
        'div',
        {
          key: 'stats',
          className: `dsh-tokenlens-section dsh-tokenlens-stats${chartView ? ' dsh-tokenlens-stats-chart' : ''}`,
        },
        section,
      )
    }

    /**
     * Section 3 (right column): the 明细 blocks.
     *
     * The harness breakdown (with its unmapped note) is always listed, because it
     * explains WHERE the middle column's tokens came from. The DSH-only provider
     * split and top-model blocks follow the shared 更多明细 toggle, so a short
     * screen keeps the whole dialog inside the panel without a scrollbar.
     *
     * v0.22.0: in provider scope every block's second column is the provider's
     * effective window (sinceEffective) and the header reads 今日 / 最近X天 / 总计;
     * the all-harness scope keeps the fixed 最近30天 columns.
     */
    /** The wide chart section shown in the 明细 column (v0.25.1). */
    function buildStatsChartSection(state, ctx, t) {
      const { stats, scope } = ctx
      const generated = stats !== null ? formatClock(stats.generatedAt) : ''
      const section = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { className: 'dsh-tokenlens-section-title' },
            Icon('chart', 14),
            h('span', { key: 'label' }, t('statsTitle')),
          ),
          generated === '' ? null : h('span', { className: 'dsh-tokenlens-section-meta' }, t('statsGenerated', { time: generated })),
        ),
        h('div', { key: 'subtitle', className: 'dsh-tokenlens-subtitle' }, statsSubtitleText(stats, t)),
        h(
          'div',
          { key: 'scope', className: 'dsh-tokenlens-scope-row' },
          buildScopeSwitch(state, stats, scope, t),
        ),
      ]
      if (state.statsError !== null) {
        section.push(
          buildErrorBanner(
            state.statsError,
            t,
            () => {
              void requestStats({ fresh: true })
            },
            'stats-error',
          ),
        )
      }
      if (stats !== null) section.push(buildDailyChart(state, ctx, t))
      return h(
        'div',
        { key: 'chart-section', className: 'dsh-tokenlens-section dsh-tokenlens-stats dsh-tokenlens-chart-section' },
        section,
      )
    }

    /** One donut + ranked legend group of the 明细 row (v0.27.0). */
    function buildBreakdownDonutGroup(key, title, iconName, rows, t) {
      const top = rows
        .filter((row) => Number.isFinite(row.value) && row.value > 0)
        .sort((left, right) => right.value - left.value)
        .slice(0, 12)
      const total = top.reduce((sum, row) => sum + row.value, 0)
      if (top.length === 0 || total <= 0) return null
      const center = 48
      const radius = 38
      const circumference = 2 * Math.PI * radius
      let offset = 0
      const segments = top.map((row, index) => {
        const ratio = row.value / total
        const length = circumference * ratio
        const color = DONUT_PALETTE[index % DONUT_PALETTE.length]
        const dasharray =
          ratio >= 0.9995
            ? `${circumference} ${circumference}`
            : `${Math.max(0.01, length)} ${Math.max(0.01, circumference - length)}`
        const segment = h('circle', {
          key: `segment-${index}`,
          className: 'dsh-tokenlens-donut-segment',
          'data-donut-segment': String(index),
          'data-donut-label': row.label,
          'data-donut-value': String(row.value),
          'data-donut-ratio': ratio.toFixed(4),
          'data-donut-color': color,
          cx: center,
          cy: center,
          r: radius,
          fill: 'none',
          stroke: color,
          'stroke-width': 10,
          'stroke-dasharray': dasharray,
          'stroke-dashoffset': String(-offset),
          transform: `rotate(-90 ${center} ${center})`,
        })
        offset += length
        return segment
      })
      const legend = top.map((row, index) =>
        h(
          'div',
          { key: `legend-${index}`, className: 'dsh-tokenlens-donut-legend-row' },
          h('span', {
            className: 'dsh-tokenlens-donut-dot',
            style: { backgroundColor: DONUT_PALETTE[index % DONUT_PALETTE.length] },
            'aria-hidden': 'true',
          }),
          h('span', { className: 'dsh-tokenlens-donut-legend-label', title: row.label }, row.label),
          h(
            'span',
            { className: 'dsh-tokenlens-donut-legend-percent' },
            t('percent', { percent: ((row.value / total) * 100).toFixed(1) }),
          ),
          h('span', { className: 'dsh-tokenlens-donut-legend-value' }, formatTokensPrecise(row.value)),
        ),
      )
      return h(
        'div',
        {
          key,
          className: 'dsh-tokenlens-chart-group dsh-tokenlens-donut-group',
          'data-breakdown-chart': key,
          'data-donut-group': key,
        },
        h(
          'div',
          { className: 'dsh-tokenlens-breakdown-head' },
          h('span', { className: 'dsh-tokenlens-head-label' }, Icon(iconName, 13), h('span', { key: 'label' }, title)),
        ),
        h(
          'div',
          { className: 'dsh-tokenlens-donut-wrap' },
          h(
            'div',
            { className: 'dsh-tokenlens-donut', 'data-donut': key },
            h(
              'svg',
              {
                className: 'dsh-tokenlens-donut-svg',
                viewBox: '0 0 96 96',
                width: 96,
                height: 96,
                'aria-hidden': 'true',
                focusable: 'false',
              },
              segments,
            ),
            h(
              'div',
              { className: 'dsh-tokenlens-donut-center' },
              h(
                'span',
                { className: 'dsh-tokenlens-donut-total', 'data-donut-total': key },
                formatTokensPrecise(total),
              ),
            ),
          ),
          h('div', { className: 'dsh-tokenlens-donut-legend' }, legend),
        ),
      )
    }

    /**
     * The 明细 column in chart mode: donut share charts + ranked legends.
     *
     * v1.2.0: a 今日 / 最近7天 / 最近X天 / 总计 window switch under the title picks
     * which stats window the three donuts aggregate (default 总计). The pills of
     * windows an old Host does not report are hidden; the state lives in the store
     * and, since v1.2.1, is persisted to the plugin settings.
     */
    function buildStatsDetailsCharts(state, ctx, t) {
      const { stats } = ctx
      if (stats === null) return null
      const windowKey = detailsWindowOf(state, ctx)
      const children = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { key: 'title', className: 'dsh-tokenlens-section-title' },
            Icon('layers', 14),
            h('span', { key: 'label' }, t('statsDetailsTitle')),
          ),
        ),
        buildDetailsWindowSwitch(state, ctx, t),
      ]
      const groups = []
      const harnessRows = scopedHarnessRows(ctx).map((row) => ({
        label: row.label,
        value: detailsWindowTotalOf(windowKey, row.buckets, ctx.secondBucketOf),
      }))
      const harnessChart = buildBreakdownDonutGroup('harness-chart', t('statsByHarness'), 'list', harnessRows, t)
      if (harnessChart !== null) groups.push(harnessChart)
      const providerRows = stats.providers.map((provider) => ({
        label: provider.label,
        value: detailsWindowTotalOf(windowKey, provider, ctx.secondBucketOf),
      }))
      const providerChart = buildBreakdownDonutGroup('provider-chart', t('statsByProvider'), 'server', providerRows, t)
      if (providerChart !== null) groups.push(providerChart)
      // The data-mode 明细 lists every top model (each row is annotated with its
      // own provider); the chart mode must not filter by the selected provider or
      // models from other providers silently disappear from the donut (v0.27.1).
      const modelRows = stats.models.map((model) => ({
        label: model.modelId,
        value: detailsWindowTotalOf(windowKey, model, ctx.secondModelOf),
      }))
      const modelChart = buildBreakdownDonutGroup('model-chart', t('statsTopModels'), 'cube', modelRows, t)
      if (modelChart !== null) groups.push(modelChart)
      if (groups.length > 0) {
        children.push(h('div', { key: 'charts', className: 'dsh-tokenlens-details-charts-grid' }, groups))
      } else {
        // An all-zero window renders no donut at all: keep the readable hint.
        children.push(h('div', { key: 'empty', className: 'dsh-tokenlens-hint' }, t('statsEmpty')))
      }
      return h(
        'div',
        {
          key: 'details',
          className: 'dsh-tokenlens-section dsh-tokenlens-details',
          'data-details-window': windowKey,
        },
        children,
      )
    }

    function buildStatsDetails(state, ctx, t) {
      const { stats, hasMonth } = ctx
      if (stats === null) return null
      if (state.statsView === 'chart') {
        try {
          return buildStatsDetailsCharts(state, ctx, t)
        } catch {
          return h(
            'div',
            { key: 'details', className: 'dsh-tokenlens-section dsh-tokenlens-details' },
            h(
              'div',
              { className: 'dsh-tokenlens-section-head' },
              h('span', { className: 'dsh-tokenlens-section-title' }, t('statsDetailsTitle')),
            ),
            h('div', { className: 'dsh-tokenlens-hint' }, t('statsEmpty')),
          )
        }
      }
      const children = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { key: 'title', className: 'dsh-tokenlens-section-title' },
            Icon('layers', 14),
            h('span', { key: 'label' }, t('statsDetailsTitle')),
          ),
        ),
      ]
      // v0.30.0 layout (reconstructed): the three breakdown groups are three
      // FULL-WIDTH blocks stacked vertically inside the full-width 明细 card.
      // Each block keeps its icon/title head and one real full-width HTML table.
      const blocks = []
      const harnessChildren = harnessColumnChildren(ctx, t)
      if (harnessChildren.length > 0) {
        blocks.push(
          h(
            'div',
            { key: 'harness-block', className: 'dsh-tokenlens-details-block', 'data-details-block': 'harness' },
            harnessChildren,
          ),
        )
      }
      if (state.showDetails === true && stats.providers.length > 0) {
        const providerRows = stats.providers
          .slice(0, MAX_PROVIDER_ROWS)
          .map((provider) =>
            buildDetailsTableItem(provider.label, detailsTableValues(provider, ctx, ctx.secondBucketOf), {
              key: provider.providerId,
              title: provider.label,
              attrs: { className: 'dsh-tokenlens-details-table-row dsh-tokenlens-breakdown-row' },
            }),
          )
        blocks.push(
          h(
            'div',
            { key: 'providers-block', className: 'dsh-tokenlens-details-block', 'data-details-block': 'providers' },
            h(
              'div',
              { key: 'head', className: 'dsh-tokenlens-breakdown-head' },
              h(
                'span',
                { className: 'dsh-tokenlens-head-label' },
                Icon('server', 13),
                h('span', { key: 'label' }, t('statsByProvider')),
              ),
            ),
            buildDetailsTable(detailsTableColumns(ctx, t, 'standard'), providerRows, 'dsh-tokenlens-breakdown', t('statsNameColProvider')),
          ),
        )
      }
      if (state.showDetails === true && stats.models.length > 0) {
        const modelRows = stats.models
          .slice(0, MAX_MODEL_ROWS)
          .map((model) =>
            buildDetailsTableItem(model.modelId, detailsTableValues(model, ctx, ctx.secondModelOf, 'model'), {
              key: model.key,
              title: model.modelId,
              attrs: { className: 'dsh-tokenlens-details-table-row dsh-tokenlens-model-row' },
            }),
          )
        blocks.push(
          h(
            'div',
            { key: 'models-block', className: 'dsh-tokenlens-details-block', 'data-details-block': 'models' },
            h(
              'div',
              { key: 'head', className: 'dsh-tokenlens-breakdown-head' },
              h(
                'span',
                { className: 'dsh-tokenlens-head-label' },
                Icon('cube', 13),
                h('span', { key: 'label' }, t('statsTopModels')),
              ),
            ),
            buildDetailsTable(detailsTableColumns(ctx, t, 'model'), modelRows, 'dsh-tokenlens-models', t('statsNameColModel')),
          ),
        )
      }
      if (blocks.length > 0) {
        // v0.30.1: one row of three ordered columns; a single block (collapsed
        // details) simply fills the row.
        const threeColumns = blocks.length >= 3
        children.push(
          h(
            'div',
            {
              key: 'columns',
              className: 'dsh-tokenlens-details-columns',
              'data-details-columns': 'true',
              style: threeColumns
                ? { gridTemplateColumns: 'minmax(320px,1fr) minmax(0,1.15fr) minmax(0,1.35fr)' }
                : undefined,
            },
            blocks,
          ),
        )
      }
      if (children.length === 1) return null
      return h('div', { key: 'details', className: 'dsh-tokenlens-section dsh-tokenlens-details' }, children)
    }

    // ---------------------------------------------------------------------
    // Provider management page builders (v0.9.0).
    // ---------------------------------------------------------------------

    /** The kind badge text of one provider. */
    function providerKindLabel(kind, t) {
      if (kind === 'windows') return t('providerKindWindows')
      if (kind === 'balance') return t('providerKindBalance')
      return t('providerKindUnknown')
    }

    /** A localized error line: the known code plus the Host's own message when new. */
    function managementErrorText(rawError, t) {
      const error = normalizeError(rawError)
      const localized = describeError(error, t)
      const detail = error.message.trim()
      return detail !== '' && detail !== localized ? `${localized} · ${detail}` : localized
    }

    /** A one-line summary of the snapshot a providerTest answered with. */
    function providerSnapshotSummary(raw, t) {
      const snapshot = normalizeSnapshot(raw)
      if (snapshot === null) return ''
      const parts = []
      if (snapshot.windows !== null) {
        for (const id of WINDOW_ORDER) {
          const window = snapshot.windows[id]
          if (window !== null && window.percent !== null) {
            parts.push(`${rowLabel(id, t)} ${formatPercent(window.percent, t)}`)
          }
        }
      }
      if (snapshot.balance !== null) parts.push(formatMoney(snapshot.balance.amount, snapshot.balance.currency))
      return parts.join(' · ')
    }

    /** Where the status line of one provider row comes from. */
    function providerRowStatus(provider, management, t) {
      const test = management.rowTest[provider.providerId] ?? null
      if (test !== null) {
        if (test.phase === 'testing') return { phase: 'testing', label: t('providerStatusTesting'), message: '' }
        if (test.phase === 'ok') {
          return {
            phase: 'ok',
            label: t('providerStatusOk'),
            message: providerSnapshotSummary(test.snapshot, t),
          }
        }
        return { phase: 'error', label: t('providerStatusError'), message: managementErrorText(test.error, t) }
      }
      const rowError = management.rowError[provider.providerId] ?? null
      if (rowError !== null) {
        return { phase: 'error', label: t('providerStatusError'), message: managementErrorText(rowError, t) }
      }
      if (provider.enabled !== true) return { phase: 'disabled', label: t('providerStatusDisabled'), message: '' }
      if (provider.hasKey === true) {
        const source =
          provider.keySource !== '' && provider.keySource !== 'none'
            ? t('providerKeySource', { source: provider.keySource })
            : ''
        return { phase: 'configured', label: t('providerStatusConfigured'), message: source }
      }
      return { phase: 'missing-key', label: t('providerStatusMissingKey'), message: '' }
    }

    /** The 1–2 character avatar badge of one provider (shortLabel, else raw id). */
    function providerAvatarText(provider) {
      const raw = (typeof provider?.shortLabel === 'string' && provider.shortLabel.trim() !== ''
        ? provider.shortLabel
        : typeof provider?.providerId === 'string' && provider.providerId !== ''
          ? provider.providerId
          : '?'
      ).trim()
      const chars = Array.from(raw).slice(0, 2).join('')
      return chars === '' ? '?' : chars.toUpperCase()
    }

    /** A deterministic avatar color from the provider id (same id ⇒ same hue). */
    function providerAvatarColor(providerId) {
      const text = typeof providerId === 'string' ? providerId : ''
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 33 + text.charCodeAt(index)) % 360
      }
      return `hsl(${hash}, 46%, 34%)`
    }

    /** The icon of a provider kind badge. */
    function providerKindIcon(kind) {
      if (kind === 'windows') return 'windows'
      if (kind === 'balance') return 'coin'
      return 'info'
    }

    /** The icon of a provider status pill. */
    function providerStatusIcon(phase) {
      if (phase === 'configured' || phase === 'ok') return 'check'
      if (phase === 'error') return 'alert'
      if (phase === 'testing') return 'spinner'
      if (phase === 'disabled') return 'ban'
      return 'key'
    }

    /** The 管理 button that switches the dialog body to the management page. */
    function buildManageButton(state, t) {
      return h(
        'div',
        { key: 'manage-toolbar', className: 'dsh-tokenlens-toolbar' },
        buildStatsViewToggle(state, t),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-tokenlens-manage',
            title: t('manageOpenHint'),
            'aria-label': t('manageOpen'),
            onClick: () => openManagement(),
          },
          Icon('gear', 13),
          t('manageOpen'),
        ),
      )
    }

    /** The back arrow of the management page. */
    function buildManagementToolbar(t) {
      return h(
        'div',
        { key: 'manage-toolbar', className: 'dsh-tokenlens-toolbar dsh-tokenlens-toolbar-back' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-tokenlens-back',
            title: t('manageBackHint'),
            'aria-label': t('manageBack'),
            onClick: () => closeManagement(),
          },
          t('manageBack'),
        ),
      )
    }

    /** One labelled text field of a provider editor. */
    function buildProviderUrlField(provider, management, t, options) {
      const draft = providerDraftOf(provider, management)
      const disabled = management.busy[provider.providerId] !== undefined
      return h(
        'div',
        { key: options.key, className: 'dsh-tokenlens-field' },
        h('span', { className: 'dsh-tokenlens-field-label' }, options.label),
        h('input', {
          type: 'text',
          className: `dsh-tokenlens-input ${options.className}`,
          [options.dataAttr]: provider.providerId,
          value: typeof draft[options.field] === 'string' ? draft[options.field] : '',
          placeholder: options.placeholder,
          disabled,
          autoComplete: 'off',
          spellCheck: false,
          'aria-label': options.label,
          onChange: (event) => updateProviderDraft(provider, options.field, event?.target?.value),
        }),
      )
    }

    /** The character count the Host validates (the Host compares `.length`). */
    function providerNameLength(value) {
      return (typeof value === 'string' ? value.trim() : '').length
    }

    /**
     * One editable name field (v0.12.0): a text input capped at the Host limit,
     * with a permanent limit hint and an inline error while the draft is longer
     * than allowed (the Host validates again and reports HTTP 500 on save).
     */
    function buildProviderNameField(provider, management, t, options) {
      const providerId = provider.providerId
      const draft = providerDraftOf(provider, management)
      const disabled = management.busy[providerId] !== undefined
      const value = typeof draft[options.field] === 'string' ? draft[options.field] : ''
      const tooLong = providerNameLength(value) > options.maxLength
      return h(
        'div',
        { key: options.key, className: 'dsh-tokenlens-field' },
        h(
          'div',
          { className: 'dsh-tokenlens-field-head' },
          h('span', { className: 'dsh-tokenlens-field-label' }, options.label),
          h('span', { className: 'dsh-tokenlens-field-hint' }, options.hint),
        ),
        h('input', {
          type: 'text',
          className: `dsh-tokenlens-input ${options.className}`,
          [options.dataAttr]: providerId,
          value,
          maxLength: options.maxLength,
          placeholder: options.placeholder,
          disabled,
          autoComplete: 'off',
          spellCheck: false,
          'aria-label': options.label,
          'aria-invalid': tooLong ? 'true' : 'false',
          onChange: (event) => updateProviderDraft(provider, options.field, event?.target?.value),
        }),
        tooLong
          ? h(
              'div',
              { className: 'dsh-tokenlens-field-hint dsh-tokenlens-field-error', 'data-kind': 'error' },
              options.tooLongText,
            )
          : null,
      )
    }

    /**
     * The compact note that replaces the (removed) API-key and Base-URL inputs of a
     * DSH-managed provider (v0.14.0): its key and endpoint are inherited from the
     * DSH model-settings route named in the note.
     */
    function buildDshInheritedRow(provider, t) {
      return h(
        'div',
        {
          key: 'dsh-inherited',
          className: 'dsh-tokenlens-dsh-inherited',
          'data-provider-inherited': provider.providerId,
        },
        Icon('server', 12),
        h(
          'span',
          { key: 'text', className: 'dsh-tokenlens-dsh-inherited-text' },
          t('providerDshInherited', { provider: provider.dshProviderId }),
        ),
      )
    }

    /**
     * The hint shown for a provider with no route in the DSH model settings
     * (v0.14.0). The page offers no key or base-URL inputs at all: the user adds
     * the provider under DSH 「设置 → 模型服务」 and the plugin reuses that route.
     */
    function buildDshUnmanagedRow(provider, t) {
      return h(
        'div',
        {
          key: 'dsh-unmanaged',
          className: 'dsh-tokenlens-dsh-unmanaged',
          'data-provider-unmanaged': provider.providerId,
        },
        Icon('info', 12),
        h(
          'span',
          { key: 'text', className: 'dsh-tokenlens-dsh-unmanaged-text' },
          t('providerDshUnmanaged', { provider: provider.providerId }),
        ),
      )
    }

    /**
     * The expanded editor of one provider: the inherited-model-settings hint, the
     * editable names, the display-only console URL, save and test. No credential
     * input is rendered for any provider (v0.14.0).
     */
    function buildProviderEditor(provider, management, t) {
      const providerId = provider.providerId
      const draft = providerDraftOf(provider, management)
      const busy = management.busy[providerId] ?? null
      const accountService = providerUsesAccountService(provider)
      const dirty = Object.keys(providerUpdatePatch(provider, draft)).length > 0
      // v0.16.0: a user-declared custom adapter explains its own provenance; the
      // built-in providers keep the v0.14.0 credential-free rows (DSH inherit /
      // account service / "add the route in DSH" hint).
      const custom = provider.custom === true
      // v0.14.0: credentials and endpoints are never edited on this page. A provider
      // backed by a DSH model-settings route shows the inherited note; the account
      // service (deepseek-account) keeps its own service hint; every other provider
      // gets a hint naming the DSH route id it should be added under.
      const dshManaged = providerUsesDshModelSettings(provider) && accountService !== true
      const sourceRow = custom
        ? h(
            'div',
            { key: 'custom-hint', className: 'dsh-tokenlens-hint dsh-tokenlens-custom-hint', 'data-custom-hint': providerId },
            Icon('tag', 12),
            h('span', { key: 'text', className: 'dsh-tokenlens-custom-hint-text' }, t('customProviderHint')),
            provider.note !== ''
              ? h('span', { key: 'note', className: 'dsh-tokenlens-custom-note' }, provider.note)
              : null,
          )
        : accountService
          ? h(
              'div',
              { key: 'account-service', className: 'dsh-tokenlens-hint dsh-tokenlens-account-hint', 'data-kind': 'account-service' },
              t('providerKeyService'),
            )
          : dshManaged
            ? buildDshInheritedRow(provider, t)
            : buildDshUnmanagedRow(provider, t)
      const fields = [
        sourceRow,
        buildProviderNameField(provider, management, t, {
          key: 'shortLabel',
          className: 'dsh-tokenlens-shortlabel-input',
          dataAttr: 'data-provider-shortlabel',
          field: 'shortLabel',
          label: t('providerShortLabel'),
          hint: t('providerShortLabelHint'),
          placeholder: provider.shortLabel,
          maxLength: PROVIDER_SHORT_LABEL_MAX,
          tooLongText: t('providerShortLabelTooLong'),
        }),
        buildProviderNameField(provider, management, t, {
          key: 'label',
          className: 'dsh-tokenlens-label-input',
          dataAttr: 'data-provider-label',
          field: 'label',
          label: t('providerFullName'),
          hint: t('providerFullNameHint'),
          placeholder: provider.label,
          maxLength: PROVIDER_LABEL_MAX,
          tooLongText: t('providerFullNameTooLong'),
        }),
        // The console URL is a display link, not a credential: it stays editable.
        buildProviderUrlField(provider, management, t, {
          key: 'consoleUrl',
          className: 'dsh-tokenlens-consoleurl-input',
          dataAttr: 'data-provider-consoleurl',
          field: 'consoleUrl',
          label: t('providerConsoleURL'),
          placeholder: t('providerConsoleURLPlaceholder'),
        }),
      ]
      const actions = h(
        'div',
        { key: 'actions', className: 'dsh-tokenlens-editor-actions' },
        custom
          ? h(
              Button,
              {
                variant: 'outline',
                className: 'dsh-tokenlens-custom-delete',
                'data-custom-delete': providerId,
                title: t('customDeleteHint'),
                disabled: busy !== null,
                onClick: () => {
                  void requestCustomProviderDelete(providerId)
                },
              },
              Icon('trash', 12),
              busy === 'deleting' ? t('customDeleting') : t('customDelete'),
            )
          : null,
        h(
          Button,
          {
            variant: 'outline',
            className: 'dsh-tokenlens-restore-labels',
            title: t('providerRestoreNamesHint'),
            disabled: busy !== null,
            onClick: () => restoreProviderNames(provider),
          },
          Icon('trash', 12),
          t('providerRestoreNames'),
        ),
        h(
          Button,
          {
            variant: 'primary',
            className: 'dsh-tokenlens-save',
            disabled: busy !== null || dirty === false,
            onClick: () => saveProviderDraft(provider),
          },
          Icon('save', 12),
          busy === 'saving' ? t('providerSaving') : t('providerSave'),
        ),
        h(
          Button,
          {
            variant: 'outline',
            className: 'dsh-tokenlens-test',
            disabled: busy !== null,
            onClick: () => {
              void requestProviderTest(providerId)
            },
          },
          Icon('bolt', 12),
          busy === 'testing' ? t('providerTesting') : t('providerTest'),
        ),
      )
      return h('div', { className: 'dsh-tokenlens-editor', 'data-provider-editor': providerId }, [...fields, actions])
    }

    /** One provider card: name, kind badge, enable toggle, status and (when expanded) editor. */
    function buildProviderRow(provider, management, t) {
      const providerId = provider.providerId
      const expanded = management.editingId === providerId
      const busy = management.busy[providerId] ?? null
      const status = providerRowStatus(provider, management, t)
      // Deterministic five-column header (v0.12.0): avatar | name | kind | status |
      // enable. Every column is non-wrapping and the name column truncates, so all
      // 13 cards line up and no status pill can wrap onto a second row.
      const children = [
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-provider-head' },
          h(
            'span',
            {
              className: 'dsh-tokenlens-avatar',
              'data-provider-avatar': providerId,
              style: { backgroundColor: providerAvatarColor(providerId) },
              'aria-hidden': 'true',
            },
            providerAvatarText(provider),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-tokenlens-provider-toggle',
              'data-provider-toggle': providerId,
              'aria-expanded': expanded ? 'true' : 'false',
              onClick: () => toggleProviderEditor(provider),
            },
            h('span', { className: 'dsh-tokenlens-provider-name' }, provider.label),
          ),
          h(
            'span',
            { className: 'dsh-tokenlens-kind', 'data-kind': provider.kind },
            Icon(providerKindIcon(provider.kind), 11),
            h('span', { key: 'label' }, providerKindLabel(provider.kind, t)),
          ),
          h(
            'span',
            { className: 'dsh-tokenlens-provider-status', 'data-state': status.phase },
            Icon(providerStatusIcon(status.phase), 11),
            h('span', { key: 'label' }, status.label),
          ),
          h(
            'label',
            { className: 'dsh-tokenlens-enabled-wrap', title: t('providerEnableHint', { provider: provider.label }) },
            h('input', {
              type: 'checkbox',
              className: 'dsh-tokenlens-enabled',
              'data-provider-enabled': providerId,
              checked: provider.enabled === true,
              disabled: busy !== null,
              'aria-label': t('providerEnableHint', { provider: provider.label }),
              onChange: (event) => setProviderEnabled(provider, event?.target?.checked === true),
            }),
            h('span', { className: 'dsh-tokenlens-enabled-label' }, t('providerEnabled')),
          ),
        ),
      ]
      // Both labels stay visible (v0.10.0): the global style switch above picks
      // which one the composer chip shows, so users can see both readings.
      children.push(
        h(
          'div',
          { key: 'labels', className: 'dsh-tokenlens-provider-labels' },
          Icon('tag', 11),
          h('span', { key: 'text' }, t('providerBothLabels', { short: provider.shortLabel, full: provider.label })),
          provider.builtin === true ? h('span', { key: 'builtin', className: 'dsh-tokenlens-builtin' }, t('providerBuiltin')) : null,
          provider.custom === true
            ? h(
                'span',
                { key: 'custom-badge', className: 'dsh-tokenlens-builtin dsh-tokenlens-custom-badge', 'data-custom-badge': providerId },
                t('customProviderBadge'),
              )
            : null,
          // v0.23.0 subscription pill, right next to the 内置/自定义 badge.
          h(
            'span',
            {
              key: 'subscription',
              className: 'dsh-tokenlens-subscription-badge',
              'data-kind': provider.subscribed === true ? 'subscribed' : 'unsubscribed',
              'data-provider-subscription': providerId,
              'data-subscribed': provider.subscribed === true ? 'true' : 'false',
              title: provider.subscribed === true ? t('providerSubscribedHint') : t('providerNotSubscribedHint'),
            },
            provider.subscribed === true ? t('providerSubscribed') : t('providerNotSubscribed'),
          ),
        ),
      )
      if (status.message !== '') {
        children.push(
          h('div', { key: 'status-message', className: 'dsh-tokenlens-provider-message', 'data-kind': status.phase }, status.message),
        )
      }
      if (expanded) children.push(buildProviderEditor(provider, management, t))
      return h(
        'div',
        {
          key: providerId,
          className: 'dsh-tokenlens-provider-card',
          'data-provider': providerId,
          'data-editing': expanded ? 'true' : 'false',
        },
        children,
      )
    }

    /** One labelled segmented row of the 插件设置 tab (v0.29.0). */
    function buildSettingsRow(state, t, field, label, options) {
      const management = state.management
      const busy = management.settingsBusy === true
      const active = currentPluginSettings()[field]
      return h(
        'div',
        { key: field, className: 'dsh-tokenlens-settings-row', 'data-settings-row': field },
        h('span', { className: 'dsh-tokenlens-field-label dsh-tokenlens-settings-label' }, label),
        h(
          'div',
          { className: 'dsh-tokenlens-scope dsh-tokenlens-settings-options', role: 'group', 'aria-label': label },
          options.map((option) =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                className: `dsh-tokenlens-scope-option dsh-tokenlens-settings-option${field === 'labelStyle' ? ' dsh-tokenlens-label-style-option' : ''}`,
                'data-setting': field,
                'data-value': option.value,
                'data-label-style': field === 'labelStyle' ? option.value : undefined,
                'data-active': active === option.value ? 'true' : 'false',
                'aria-pressed': active === option.value ? 'true' : 'false',
                disabled: busy,
                onClick: () => {
                  if (busy || active === option.value) return
                  savePluginSetting(field, option.value)
                },
              },
              Icon(option.icon, 12),
              option.label,
            ),
          ),
        ),
      )
    }

    /** The 插件设置 tab (v0.29.0): display defaults, reset button and store path. */
    function buildSettingsPanel(state, t) {
      const management = state.management
      const busy = management.settingsBusy === true
      const children = [
        h('div', { key: 'hint', className: 'dsh-tokenlens-subtitle' }, t('settingsHint')),
        buildSettingsRow(state, t, 'labelStyle', t('settingsLabelStyle'), [
          { value: 'short', label: t('labelStyleShort'), icon: 'tag' },
          { value: 'full', label: t('labelStyleFull'), icon: 'text' },
        ]),
        buildSettingsRow(state, t, 'defaultView', t('settingsDefaultView'), [
          { value: 'chart', label: t('statsViewChart'), icon: 'chart' },
          { value: 'data', label: t('statsViewData'), icon: 'list' },
        ]),
        buildSettingsRow(state, t, 'defaultScope', t('settingsDefaultScope'), [
          { value: 'provider', label: t('settingsScopeProvider'), icon: 'server' },
          { value: 'all', label: t('settingsScopeAll'), icon: 'layers' },
        ]),
        buildSettingsRow(state, t, 'detailsExpanded', t('settingsDetailsExpanded'), [
          { value: 'auto', label: t('settingsDetailsAuto'), icon: 'gear' },
          { value: 'expanded', label: t('settingsDetailsExpandedOption'), icon: 'layers' },
          { value: 'collapsed', label: t('settingsDetailsCollapsed'), icon: 'list' },
        ]),
      ]
      const actions = h(
        'div',
        { key: 'actions', className: 'dsh-tokenlens-settings-actions' },
        busy
          ? h('span', { key: 'saving', className: 'dsh-tokenlens-provider-status', 'data-state': 'testing' }, t('labelStyleSaving'))
          : null,
        h(
          Button,
          {
            variant: 'outline',
            className: 'dsh-tokenlens-settings-reset',
            title: t('settingsResetDefaultsHint'),
            disabled: busy,
            onClick: () => resetPluginSettings(),
          },
          Icon('trash', 12),
          t('settingsResetDefaults'),
        ),
      )
      children.push(actions)
      if (management.settingsError !== null) {
        children.push(
          h(
            'div',
            {
              key: 'error',
              className: 'dsh-tokenlens-provider-message',
              'data-kind': 'error',
              'data-settings-error': 'true',
            },
            managementErrorText(management.settingsError, t),
          ),
        )
      }
      if (management.storeFile !== '') {
        children.push(
          h(
            'div',
            { key: 'store-file', className: 'dsh-tokenlens-provider-store-file' },
            t('providersStoreFile', { file: management.storeFileDisplay !== '' ? management.storeFileDisplay : management.storeFile }),
          ),
        )
      }
      return h('div', { key: 'settings-panel', className: 'dsh-tokenlens-settings', 'data-settings-panel': 'true' }, children)
    }

    /** The 供应商配置 / 插件设置 tabs of the management page (v0.29.0). */
    function buildManagementTabs(state, t) {
      const active = state.management.tab === 'settings' ? 'settings' : 'providers'
      const option = (id, label, iconName) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'dsh-tokenlens-manage-tab',
            'data-manage-tab': id,
            'data-active': active === id ? 'true' : 'false',
            'aria-pressed': active === id ? 'true' : 'false',
            onClick: () => setManagementTab(id),
          },
          Icon(iconName, 12),
          label,
        )
      return h(
        'div',
        {
          key: 'manage-tabs',
          className: 'dsh-tokenlens-manage-tabs',
          role: 'tablist',
          'aria-label': t('manageTabsLabel'),
        },
        option('providers', t('manageTabProviders'), 'server'),
        option('settings', t('manageTabSettings'), 'gear'),
      )
    }

    /**
     * Split the DSH discovery list into renderable rows (v0.15.0): a supported
     * route reuses its editable provider card (matched by `usageProviderId`), an
     * unsupported route stays a read-only row. `renderedIds` records which
     * provider entries the primary section already rendered, so the secondary
     * preset section never duplicates them.
     */
    function dshProviderRowsOf(management) {
      const providersById = new Map()
      for (const provider of management.providers) providersById.set(provider.providerId, provider)
      const renderedIds = new Set()
      const rows = []
      for (const dsh of management.dshProviders) {
        const provider =
          dsh.supported && dsh.usageProviderId !== '' ? providersById.get(dsh.usageProviderId) : undefined
        if (provider !== undefined && !renderedIds.has(provider.providerId)) {
          renderedIds.add(provider.providerId)
          rows.push({ kind: 'provider', provider })
        } else {
          rows.push({ kind: 'unsupported', dsh })
        }
      }
      return { rows, renderedIds }
    }

    /** The preset adapters DSH has not configured yet (secondary, collapsed section). */
    function presetProvidersOf(management, renderedIds) {
      // v0.16.0: custom adapters have their own section (or live in the DSH list),
      // so they never mingle with the built-in presets here.
      return management.providers.filter(
        (provider) =>
          provider.custom !== true &&
          provider.dshManaged !== true &&
          (renderedIds === undefined || !renderedIds.has(provider.providerId)),
      )
    }

    /** The custom adapters that do not appear in the DSH section (v0.16.0). */
    function customProvidersOf(management, renderedIds) {
      return management.providers.filter(
        (provider) => provider.custom === true && (renderedIds === undefined || !renderedIds.has(provider.providerId)),
      )
    }

    /** One read-only row of a DSH route without a usage adapter (v0.15.0). */
    function buildDshUnsupportedRow(dsh, t) {
      return h(
        'div',
        {
          key: `dsh-route:${dsh.providerId}`,
          className: 'dsh-tokenlens-dsh-route',
          'data-dsh-route': dsh.providerId,
          'data-supported': 'false',
        },
        Icon('server', 12),
        h(
          'div',
          { key: 'body', className: 'dsh-tokenlens-dsh-route-body' },
          h('span', { key: 'name', className: 'dsh-tokenlens-dsh-route-name', title: dsh.providerId }, dsh.label),
          h('span', { key: 'hint', className: 'dsh-tokenlens-dsh-route-hint' }, t('dshUnsupportedHint')),
        ),
      )
    }

    /** Section 1 (primary): every provider route DSH model settings registers. */
    function buildDshSection(state, rows, t) {
      const management = state.management
      return h(
        'div',
        { key: 'dsh-section', className: 'dsh-tokenlens-dsh-section dsh-tokenlens-manage-section' },
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { key: 'title', className: 'dsh-tokenlens-section-title' },
            Icon('server', 14),
            h('span', { key: 'label' }, t('dshSectionTitle')),
          ),
          h('span', { key: 'count', className: 'dsh-tokenlens-section-meta' }, t('dshSectionCount', { n: rows.length })),
        ),
        h('div', { key: 'hint', className: 'dsh-tokenlens-subtitle' }, t('dshSectionHint')),
        h(
          'div',
          { key: 'list', className: 'dsh-tokenlens-providers' },
          rows.map((row) =>
            row.kind === 'provider'
              ? buildProviderRow(row.provider, management, t)
              : buildDshUnsupportedRow(row.dsh, t),
          ),
        ),
      )
    }

    /** Section 2 (secondary): plugin adapters DSH has not configured, collapsed by default. */
    function buildPresetSection(state, presetProviders, t) {
      const open = state.management.presetOpen === true
      const children = [
        h(
          'button',
          {
            key: 'toggle',
            type: 'button',
            className: 'dsh-tokenlens-details-toggle dsh-tokenlens-preset-toggle',
            'data-preset-toggle': 'true',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => togglePresetSection(),
          },
          Icon('layers', 13),
          h('span', { key: 'label' }, t('presetSectionTitle')),
          h(
            'span',
            { key: 'count', className: 'dsh-tokenlens-preset-count' },
            t('presetSectionCount', { n: presetProviders.length }),
          ),
          h(
            'span',
            { key: 'action', className: 'dsh-tokenlens-preset-action' },
            open ? t('presetCollapse') : t('presetExpand'),
          ),
        ),
        h('div', { key: 'hint', className: 'dsh-tokenlens-subtitle dsh-tokenlens-preset-hint' }, t('presetSectionHint')),
      ]
      if (open) {
        children.push(
          h(
            'div',
            { key: 'list', className: 'dsh-tokenlens-providers dsh-tokenlens-preset-providers' },
            presetProviders.map((provider) => buildProviderRow(provider, state.management, t)),
          ),
        )
      }
      return h('div', { key: 'preset-section', className: 'dsh-tokenlens-preset-section' }, children)
    }

    /** The 「自定义适配器」 section: custom adapters with no matching DSH route. */
    function buildCustomAdaptersSection(state, customProviders, t) {
      return h(
        'div',
        { key: 'custom-section', className: 'dsh-tokenlens-custom-section dsh-tokenlens-manage-section' },
        h(
          'div',
          { key: 'head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { key: 'title', className: 'dsh-tokenlens-section-title' },
            Icon('tag', 14),
            h('span', { key: 'label' }, t('customSectionTitle')),
          ),
          h(
            'span',
            { key: 'count', className: 'dsh-tokenlens-section-meta' },
            t('customSectionCount', { n: customProviders.length }),
          ),
        ),
        h('div', { key: 'hint', className: 'dsh-tokenlens-subtitle' }, t('customSectionHint')),
        h(
          'div',
          { key: 'list', className: 'dsh-tokenlens-providers' },
          customProviders.map((provider) => buildProviderRow(provider, state.management, t)),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Provider-list filter tabs (v0.17.0): 已配置 / 内置 / 全部.
    // ---------------------------------------------------------------------

    /** The 已配置 / 内置 / 全部 segmented filter (v0.17.0). */
    function buildProviderFilterTabs(state, t) {
      const active = state.management.filter
      const option = (id, label, iconName) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'dsh-tokenlens-scope-option dsh-tokenlens-filter-option',
            'data-provider-filter': id,
            'data-active': active === id ? 'true' : 'false',
            'aria-pressed': active === id ? 'true' : 'false',
            onClick: () => setProviderFilter(id),
          },
          Icon(iconName, 12),
          label,
        )
      return h(
        'div',
        { key: 'provider-filters', className: 'dsh-tokenlens-filter-row' },
        h(
          'div',
          { className: 'dsh-tokenlens-scope', role: 'group', 'aria-label': t('providerFilterLabel') },
          option('configured', t('filterConfigured'), 'server'),
          option('builtin', t('filterBuiltin'), 'layers'),
          option('all', t('filterAll'), 'list'),
        ),
      )
    }

    /** The 已配置 tab: DSH model-settings routes, or its empty state. */
    function buildConfiguredTab(state, rows, t) {
      if (rows.length === 0) {
        return h(
          'div',
          {
            key: 'configured-empty',
            className: 'dsh-tokenlens-empty dsh-tokenlens-filter-empty',
            'data-filter-empty': 'configured',
          },
          h('div', { key: 'title', className: 'dsh-tokenlens-hint' }, t('filterEmptyConfigured')),
          h(
            'div',
            { key: 'hint', className: 'dsh-tokenlens-hint dsh-tokenlens-filter-empty-hint' },
            t('filterEmptyConfiguredHint'),
          ),
        )
      }
      return buildDshSection(state, rows, t)
    }

    /** The 内置 tab: every built-in preset adapter as an editable card. */
    function buildBuiltinTab(state, t) {
      const builtins = dedupeByProviderId(
        state.management.providers.filter((provider) => provider.builtin === true),
      )
      const children = [
        h(
          'div',
          { key: 'builtin-head', className: 'dsh-tokenlens-section-head' },
          h(
            'span',
            { key: 'title', className: 'dsh-tokenlens-section-title' },
            Icon('layers', 14),
            h('span', { key: 'label' }, t('builtinSectionTitle')),
          ),
          h(
            'span',
            { key: 'count', className: 'dsh-tokenlens-section-meta' },
            t('presetSectionCount', { n: builtins.length }),
          ),
        ),
        h('div', { key: 'builtin-hint', className: 'dsh-tokenlens-subtitle' }, t('builtinSectionHint')),
      ]
      if (builtins.length === 0) {
        children.push(h('div', { key: 'builtin-empty', className: 'dsh-tokenlens-hint dsh-tokenlens-empty' }, t('providersEmpty')))
      } else {
        children.push(
          h(
            'div',
            { key: 'builtin-list', className: 'dsh-tokenlens-providers' },
            builtins.map((provider) => buildProviderRow(provider, state.management, t)),
          ),
        )
      }
      return h('div', { key: 'builtin-section', className: 'dsh-tokenlens-builtin-section dsh-tokenlens-manage-section' }, children)
    }

    /** The 全部 tab: DSH routes first, then unconfigured builtins, custom adapters last. */
    function buildAllTab(state, rows, renderedIds, t) {
      const management = state.management
      const children = []
      if (rows.length > 0) children.push(buildDshSection(state, rows, t))
      const presets = dedupeByProviderId(presetProvidersOf(management, renderedIds))
      if (presets.length > 0) children.push(buildPresetSection(state, presets, t))
      const customProviders = dedupeByProviderId(customProvidersOf(management, renderedIds))
      if (customProviders.length > 0) children.push(buildCustomAdaptersSection(state, customProviders, t))
      if (children.length === 0) {
        children.push(h('div', { key: 'all-empty', className: 'dsh-tokenlens-hint dsh-tokenlens-empty' }, t('providersEmpty')))
      }
      return children
    }

    /** The 供应商配置 tab body: provider lists (or loading/error/empty) + store hint. */
    function buildProviderConfigTab(state, t) {
      const management = state.management
      const children = [
        h('div', { key: 'subtitle', className: 'dsh-tokenlens-subtitle' }, t('manageSubtitle')),
      ]
      // v0.15.0: the Host reports every route registered in the DSH model settings
      // (`dshProviders`). v0.17.0 turns that discovery into a filterable list:
      // 已配置 (DSH routes) / 内置 (plugin presets) / 全部 (the deduped union).
      // An old Host omits `dshProviders`, so the legacy flat list still renders.
      const dshMode = management.hasDshProviders === true || management.dshProviders.length > 0
      const { rows, renderedIds } = dshProviderRowsOf(management)
      const hasProviders = management.providers.length > 0 || dshMode
      if (management.phase === 'loading' && !hasProviders) {
        children.push(h('div', { key: 'loading', className: 'dsh-tokenlens-loading' }, t('providersLoading')))
      } else if (hasProviders) {
        if (management.phase === 'error' && management.error !== null) {
          children.push(buildErrorBanner(management.error, t, () => void requestProviders(), 'providers-error'))
        }
        if (dshMode) {
          children.push(buildProviderFilterTabs(state, t))
          const filter =
            management.filter === 'builtin' || management.filter === 'all' ? management.filter : 'configured'
          if (filter === 'builtin') children.push(buildBuiltinTab(state, t))
          else if (filter === 'all') children.push(...buildAllTab(state, rows, renderedIds, t))
          else children.push(buildConfiguredTab(state, rows, t))
        } else {
          children.push(
            h(
              'div',
              { key: 'providers', className: 'dsh-tokenlens-providers' },
              management.providers.map((provider) => buildProviderRow(provider, management, t)),
            ),
          )
        }
      } else if (management.phase === 'error') {
        children.push(buildErrorBanner(management.error, t, () => void requestProviders(), 'providers-error'))
      } else {
        children.push(h('div', { key: 'empty', className: 'dsh-tokenlens-hint dsh-tokenlens-empty' }, t('providersEmpty')))
      }
      if (management.storeFile !== '') {
        children.push(
          h(
            'div',
            { key: 'store-file', className: 'dsh-tokenlens-provider-store-file' },
            t('providersStoreFile', { file: management.storeFileDisplay !== '' ? management.storeFileDisplay : management.storeFile }),
          ),
        )
      }
      return children
    }

    /** The management page body: back toolbar, section tabs, then the active tab. */
    function buildManagementSection(state, t) {
      const management = state.management
      const tab = management.tab === 'settings' ? 'settings' : 'providers'
      const children = [buildManagementToolbar(t), buildManagementTabs(state, t)]
      if (tab === 'settings') children.push(buildSettingsPanel(state, t))
      else children.push(...buildProviderConfigTab(state, t))
      return h('div', { className: 'dsh-tokenlens-manage-view' }, children)
    }

    /** The whole dialog while the management page is open (modal chrome preserved). */
    function buildManagementDialog(state, t) {
      const management = state.management
      const busy = management.inFlight === true
      const footer = h(
        React.Fragment,
        null,
        h(
          Button,
          {
            key: 'providers-refresh',
            variant: 'outline',
            className: 'dsh-tokenlens-refresh',
            disabled: busy,
            onClick: () => {
              void requestProviders()
            },
          },
          h(IconRefreshOutlineRegular, {}),
          busy ? t('refreshing') : t('refresh'),
        ),
        h(Button, { key: 'close', variant: 'primary', className: 'dsh-tokenlens-close', onClick: () => closeDialog() }, t('close')),
      )
      return h(DialogShell, {
        open: true,
        onClose: () => closeDialog(),
        title: `${t('appTitleFull')} · ${t('managePageLabel')}`,
        closeLabel: t('close'),
        footer,
        children: h('div', { className: 'dsh-tokenlens-dialog dsh-tokenlens-dialog-manage' }, buildManagementSection(state, t)),
      })
    }

    /** The dialog contents (body + footer); may throw, the caller guards it. */
    function buildDialog(state, now, t) {
      if (state.view === 'management') return buildManagementDialog(state, t)
      const snapshot = normalizeSnapshot(state.snapshot)
      const statsCtx = statsContextOf(state, t)
      // v0.30.0: BOTH the 数据 and 图表 views use the same explicit two-row
      // layout — row 1 = provider capacity + local-token summary, row 2 = the
      // full-width 明细 card (the details tables get the whole width). The rows
      // flex-wrap to one column on narrow screens and never scroll internally.
      const statsArea = h(
        'div',
        { key: 'stats-layout', className: 'dsh-tokenlens-chart-layout', 'data-stats-layout': 'true' },
        h(
          'div',
          { key: 'row-top', className: 'dsh-tokenlens-chart-layout-row' },
          buildCapacitySection(state, now, t),
          buildStatsSummary(state, statsCtx, t),
        ),
        h(
          'div',
          { key: 'row-details', className: 'dsh-tokenlens-chart-layout-row' },
          buildStatsDetails(state, statsCtx, t),
        ),
      )
      const body = [buildManageButton(state, t), statsArea]
      if (typeof state.pluginVersion === 'string' && state.pluginVersion !== '') {
        body.push(
          h(
            'div',
            { key: 'version', className: 'dsh-tokenlens-version' },
            t('pluginVersion', { version: state.pluginVersion }),
          ),
        )
      }

      const busy = state.inFlight === true || state.statsInFlight === true
      // The footer link follows the selected provider from the wire snapshot; when
      // no snapshot/link exists we hide it instead of linking to an unrelated console.
      const consoleUrl = consoleUrlFor(snapshot)
      const consoleLabel = consoleLabelFor(snapshot, state.providerId, t)
      const footer = h(
        React.Fragment,
        null,
        consoleUrl === ''
          ? null
          : h(
              'a',
              {
                className: 'dsh-tokenlens-console',
                href: consoleUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                'aria-label': consoleLabel,
                title: consoleUrl,
                onClick: (event) => openConsole(consoleUrl, event),
              },
              Icon('external', 12),
              consoleLabel,
            ),
        h(
          Button,
          {
            key: 'refresh',
            variant: 'outline',
            className: 'dsh-tokenlens-refresh',
            disabled: busy,
            onClick: () => {
              void refreshAll()
            },
          },
          h(IconRefreshOutlineRegular, {}),
          busy ? t('refreshing') : t('refresh'),
        ),
        h(Button, { key: 'close', variant: 'primary', className: 'dsh-tokenlens-close', onClick: () => closeDialog() }, t('close')),
      )
      const providerTitle = providerLabelOf(snapshot, state.providerId) || t('title')
      const title = `${t('appTitleFull')} · ${providerTitle}`
      return h(DialogShell, {
        open: true,
        onClose: () => closeDialog(),
        title,
        closeLabel: t('close'),
        footer,
        children: h('div', { className: 'dsh-tokenlens-dialog' }, body),
      })
    }

    /** The degraded dialog used when the builder throws: one line it can close. */
    function buildDialogFallback(t, error) {
      try {
        return h(DialogShell, {
          open: true,
          onClose: () => closeDialog(),
          title: t('appTitleShort'),
          closeLabel: t('close'),
          footer: h(Button, { variant: 'outline', onClick: () => closeDialog() }, t('close')),
          children: h(
            'div',
            { className: 'dsh-tokenlens-banner', 'data-kind': 'error', role: 'alert' },
            h('div', { className: 'dsh-tokenlens-banner-title' }, t('buildFailed', { message: String(error?.message ?? error) })),
          ),
        })
      } catch {
        return null
      }
    }

    /** Open one provider console URL in a new tab; fall back to the anchor's target. */
    function openConsole(url, event) {
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer')
        if (opened !== null && opened !== undefined && typeof event?.preventDefault === 'function') event.preventDefault()
      } catch {
        /* let the anchor's target=_blank do the work */
      }
    }

    /** The composer-overlay entry: the detail dialog. */
    const UsageDialog = React.memo(function UsageDialog(props) {
      const state = useUsage()
      const now = useDialogClock(state.dialogOpen)
      const t = tOf(props)
      // Opening the dialog refreshes stale usage and lazily loads the token
      // statistics; both live in the store so polling and the chip share them.
      React.useEffect(() => {
        if (state.dialogOpen !== true) return undefined
        const current = store.get()
        if (Date.now() - current.lastAttemptAt >= OPEN_REFRESH_MS) void requestUsage('snapshot')
        const statsAge = current.statsLoadedAt === 0 ? Infinity : Date.now() - current.statsLoadedAt
        if (statsAge >= STATS_TTL_MS) void requestStats()
        return undefined
      }, [state.dialogOpen])

      if (state.dialogOpen !== true || !dialogOwnedBy(props, state)) return null
      try {
        return buildDialog(state, now, t)
      } catch (error) {
        return buildDialogFallback(t, error)
      }
    })

    // ---------------------------------------------------------------------
    // Experimental: per-workspace token badge in the sidebar (guarded).
    //
    // Decorates the app's left sidebar workspace rows from the outside — the
    // DSH sidebar is not a client-plugin seat, so this is deliberately a
    // best-effort DOM decorator: any selector change, missing document or
    // mutation just renders no badge and can NEVER break the dialog/app.
    // ---------------------------------------------------------------------

    const WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]'
    const WORKSPACE_BADGE_CLASS = 'dsh-tokenlens-workspace-tokens'
    const WORKSPACE_OBSERVER_DEBOUNCE_MS = 150
    const WORKSPACE_STATS_INTERVAL_MS = 60000

    /** The workspaceId suffix of a `workspace:<id>` row, or ''. */
    function workspaceIdOfRow(row) {
      try {
        const key = typeof row?.getAttribute === 'function' ? row.getAttribute('data-row-key') : ''
        if (typeof key !== 'string' || !key.startsWith('workspace:')) return ''
        return key.slice('workspace:'.length).trim()
      } catch {
        return ''
      }
    }

    /** The normalized stats entry for one workspace id (case-insensitive), or null. */
    function workspaceStatsEntryOf(stats, workspaceId) {
      if (stats === null || typeof stats !== 'object' || !Array.isArray(stats.workspaces)) return null
      const wanted = workspaceId.trim().toLowerCase()
      if (wanted === '') return null
      return (
        stats.workspaces.find(
          (entry) => typeof entry?.workspaceId === 'string' && entry.workspaceId.trim().toLowerCase() === wanted,
        ) ?? null
      )
    }

    /**
     * Get/create the badge span of one workspace row. The badge is inserted
     * BEFORE the row's last element child (the actions container), so it sits
     * between the workspace title and the hover actions without touching the
     * row's own markup/classes (which are hashed CSS-module names).
     */
    function workspaceBadgeFor(row) {
      try {
        if (row === null || row === undefined) return null
        let badge = null
        try {
          badge = typeof row.querySelector === 'function' ? row.querySelector(`:scope > .${WORKSPACE_BADGE_CLASS}`) : null
        } catch {
          badge = null
        }
        if (badge === null) {
          // Fallback for engines without :scope support: scan direct children.
          const children = row.children !== null && row.children !== undefined ? [...row.children] : []
          for (const child of children) {
            if (child?.classList !== undefined && child.classList.contains(WORKSPACE_BADGE_CLASS)) {
              badge = child
              break
            }
          }
        }
        if (badge === null) {
          const doc = row.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
          if (doc === null || typeof doc.createElement !== 'function') return null
          badge = doc.createElement('span')
          badge.className = WORKSPACE_BADGE_CLASS
          badge.setAttribute('data-tokenlens-workspace-tokens', '')
          const last = row.lastElementChild
          if (last !== null && last !== undefined && typeof row.insertBefore === 'function') {
            row.insertBefore(badge, last)
          } else if (typeof row.appendChild === 'function') {
            row.appendChild(badge)
          } else {
            return null
          }
        }
        return badge
      } catch {
        return null
      }
    }

    /** Ensure a workspace badge shows a small database icon followed by its token value. */
    function setWorkspaceBadgeValue(badge, text) {
      try {
        let value = null
        try {
          value = typeof badge.querySelector === 'function' ? badge.querySelector(':scope > .dsh-tokenlens-workspace-tokens-value') : null
        } catch {
          value = null
        }
        if (value === null) {
          const children = badge.children !== undefined && badge.children !== null ? [...badge.children] : []
          for (const child of children) {
            if (child?.classList !== undefined && child.classList.contains('dsh-tokenlens-workspace-tokens-value')) {
              value = child
              break
            }
          }
        }
        // Older badges rendered the value as a bare text node; once the icon
        // variant exists the value lives in its own span, so drop stray text
        // nodes first (otherwise the number would appear twice, left of the icon).
        if (badge.childNodes !== undefined && badge.childNodes !== null) {
          for (const node of [...badge.childNodes]) {
            if (node.nodeType === 3 && String(node.textContent ?? '').trim() !== '' && typeof badge.removeChild === 'function') {
              badge.removeChild(node)
            }
          }
        }
        const doc = badge.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
        if (doc === null) return
        if (badge.querySelector === undefined || badge.children === undefined) return
        if (badge.children.length === 0 && typeof doc.createElementNS === 'function') {
          const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('viewBox', '0 0 16 16')
          svg.setAttribute('width', '11')
          svg.setAttribute('height', '11')
          svg.setAttribute('aria-hidden', 'true')
          const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('fill', 'currentColor')
          path.setAttribute('d', 'M8 1.4c3.5 0 6 1 6 2.5S11.5 6.4 8 6.4 2 5.4 2 3.9 4.5 1.4 8 1.4Zm6 4.3c0 1.5-2.5 2.5-6 2.5S2 7.2 2 5.7v1.7c0 1.5 2.5 2.5 6 2.5s6-1 6-2.5V5.7Zm0 3.9c0 1.5-2.5 2.5-6 2.5S2 11.1 2 9.6v1.7c0 1.5 2.5 2.5 6 2.5s6-1 6-2.5V9.6Z')
          svg.appendChild(path)
          badge.appendChild(svg)
        }
        if (value === null) {
          value = doc.createElement('span')
          value.className = 'dsh-tokenlens-workspace-tokens-value'
          badge.appendChild(value)
        }
        if (value.textContent !== text) value.textContent = text
      } catch {
        /* decorative only */
      }
    }

    /** The visible workspace title text of a sidebar row (used when the Host could not resolve an id). */
    function workspaceTitleOfRow(row) {
      try {
        const candidates = typeof row.querySelectorAll === 'function' ? row.querySelectorAll('span, div') : []
        for (const node of candidates) {
          try {
            if (node.children !== undefined && node.children.length > 0) continue
            if (typeof node.closest === 'function' && node.closest('.dsh-tokenlens-workspace-tokens') !== null) continue
            const text = String(node.textContent ?? '').trim()
            if (text === '') continue
            if (/^[\d.]+\s*[KMB]?$/i.test(text)) continue
            return text
          } catch {
            /* one odd node must not hide the title */
          }
        }
        return ''
      } catch {
        return ''
      }
    }

    /** Refresh every visible workspace row badge from the current stats store. */
    function refreshWorkspaceTokens() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
        const stats = normalizeStats(store.get().stats)
        if (stats === null) return
        const rows = document.querySelectorAll(WORKSPACE_ROW_SELECTOR)
        for (const row of rows) {
          try {
            const workspaceId = workspaceIdOfRow(row)
            if (workspaceId === '' || workspaceId === 'ungrouped') continue
            let entry = workspaceStatsEntryOf(stats, workspaceId)
            // The Host resolves cwd → workspace id through the workspace registry;
            // when that service is unavailable (or an id is stale) fall back to the
            // visible row title so default-named workspaces still get a badge.
            if (entry === null) {
              const title = workspaceTitleOfRow(row)
              if (title !== '') {
                const matches = stats.workspaces.filter((candidate) => candidate.label === title)
                if (matches.length === 1) entry = matches[0]
              }
            }
            if (entry === null) continue
            const badge = workspaceBadgeFor(row)
            if (badge === null) continue
            setWorkspaceBadgeValue(badge, formatTokensPrecise(entry.total))
            const label = entry.label !== '' ? entry.label : workspaceId
            badge.title = `${label} · ${fallbackTranslate('statsRequests', { n: formatCount(entry.messages) })}`
            badge.setAttribute('data-tokenlens-workspace-tokens', workspaceId)
            if (typeof row.setAttribute === 'function') row.setAttribute('data-tokenlens-workspace-tokens', workspaceId)
          } catch {
            /* one broken row must not stop the other workspace rows */
          }
        }
      } catch {
        /* decorative only: never let the sidebar break the dialog */
      }
    }

    /** One workspace stats bucket, with numeric 0 defaults for absent/junk fields. */
    function normalizeWorkspaceBucket(raw) {
      const source = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
      return {
        total: Number.isFinite(source.total) ? source.total : 0,
        messages: Number.isFinite(source.messages) ? source.messages : 0,
      }
    }

    /** The numeric total of one normalized workspace bucket. */
    function workspaceBucketTotal(bucket) {
      return bucket !== null && bucket !== undefined && Number.isFinite(bucket.total) ? bucket.total : 0
    }

    /** The basename of a workspace path (path-suffix matching), or ''. */
    function workspacePathSuffixOf(pathText) {
      try {
        const clean = String(pathText ?? '')
          .trim()
          .replace(/[\\/]+$/, '')
        if (clean === '') return ''
        const parts = clean.split(/[\\/]+/)
        return parts[parts.length - 1] ?? ''
      } catch {
        return ''
      }
    }

    /** The visible title text of one hover card (`[class*="hoverTitle"]`), or ''. */
    function workspaceHoverTitleOf(card) {
      try {
        const title = typeof card.querySelector === 'function' ? card.querySelector('[class*="hoverTitle"]') : null
        return title !== null && title !== undefined && typeof title.textContent === 'string' ? title.textContent.trim() : ''
      } catch {
        return ''
      }
    }

    /** The visible path text of one hover card (`[class*="hoverPath"]`), or ''. */
    function workspaceHoverPathOf(card) {
      try {
        const path = typeof card.querySelector === 'function' ? card.querySelector('[class*="hoverPath"]') : null
        return path !== null && path !== undefined && typeof path.textContent === 'string' ? path.textContent.trim() : ''
      } catch {
        return ''
      }
    }

    /**
     * Match one hover card to its stats.workspaces entry: exact trimmed label
     * first, then a UNIQUE path suffix (entry path endsWith the card path, or
     * the card path endsWith the entry basename). Ambiguous → null (no card).
     */
    function workspaceHoverEntryOf(stats, title, pathText) {
      if (stats === null || typeof stats !== 'object' || !Array.isArray(stats.workspaces)) return null
      const wantedTitle = typeof title === 'string' ? title.trim() : ''
      if (wantedTitle !== '') {
        const byLabel = stats.workspaces.filter((entry) => stringOrEmpty(entry?.label).trim() === wantedTitle)
        if (byLabel.length === 1) return byLabel[0]
      }
      const cardPath = typeof pathText === 'string' ? pathText.trim().toLowerCase() : ''
      const suffix = workspacePathSuffixOf(cardPath).toLowerCase()
      if (suffix === '') return null
      const byPath = stats.workspaces.filter((entry) => {
        const entryPath = stringOrEmpty(entry?.path).trim().toLowerCase()
        if (entryPath === '') return false
        if (workspacePathSuffixOf(entryPath).toLowerCase() === suffix) return true
        if (cardPath !== '' && (entryPath.endsWith(cardPath) || cardPath.endsWith(entryPath))) return true
        return false
      })
      return byPath.length === 1 ? byPath[0] : null
    }

    /**
     * Get/create the hover-card token container of one workspace hover card.
     * The container is appended at the END of the hoverContent box so it reads
     * as a footer under the title/path, and is reused in place on re-renders.
     */
    function workspaceHoverTokensFor(card) {
      try {
        if (card === null || card === undefined) return null
        let line = null
        try {
          line =
            typeof card.querySelector === 'function'
              ? card.querySelector(':scope > .dsh-tokenlens-workspace-hover-tokens')
              : null
        } catch {
          line = null
        }
        if (line === null) {
          const children = card.children !== null && card.children !== undefined ? [...card.children] : []
          for (const child of children) {
            if (child?.classList !== undefined && child.classList.contains('dsh-tokenlens-workspace-hover-tokens')) {
              line = child
              break
            }
          }
        }
        if (line === null) {
          const doc = card.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
          if (doc === null || typeof doc.createElement !== 'function') return null
          line = doc.createElement('div')
          line.className = 'dsh-tokenlens-workspace-hover-tokens'
          line.setAttribute('data-tokenlens-workspace-hover', '')
          if (typeof card.appendChild === 'function') card.appendChild(line)
          else return null
        }
        return line
      } catch {
        return null
      }
    }

    /**
     * Refresh the workspace hover cards with the workspace's today / 最近7天 /
     * 最近30天 / 总计 token numbers. The card DOM is created by the app on hover
     * (hashed classes), so everything is matched by stable `[class*=…]` markers
     * and every DOM step is individually guarded.
     */
    function refreshWorkspaceHoverCards() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
        const stats = normalizeStats(store.get().stats)
        if (stats === null) return
        const cards = document.querySelectorAll('[class*="hoverContent"]')
        for (const card of cards) {
          try {
            // Session cards don't carry a hoverPath: only workspace cards do.
            const pathText = workspaceHoverPathOf(card)
            if (pathText === '') continue
            const title = workspaceHoverTitleOf(card)
            const entry = workspaceHoverEntryOf(stats, title, pathText)
            if (entry === null) continue
            const line = workspaceHoverTokensFor(card)
            if (line === null) continue
            const doc = card.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
            if (doc === null || typeof doc.createElement !== 'function') continue
            const buckets = [
              ['statsToday', workspaceBucketTotal(entry.today)],
              ['statsLast7Days', workspaceBucketTotal(entry.last7Days)],
              ['statsLast30Days', workspaceBucketTotal(entry.last30Days)],
              ['statsAllTime', Number.isFinite(entry.total) ? entry.total : 0],
            ]
            const marker = String(entry.workspaceId ?? entry.label ?? pathText)
            // Rebuilding the same content would trigger the body MutationObserver
            // again; only rewrite when labels/numbers/locale actually changed.
            const signature = `${appLocale}|${buckets.map(([key, value]) => `${key}:${value}`).join('|')}`
            const unchanged =
              typeof line.getAttribute === 'function' &&
              line.getAttribute('data-tokenlens-workspace-hover-signature') === signature &&
              line.firstChild !== null &&
              line.firstChild !== undefined
            if (unchanged) {
              line.setAttribute('data-tokenlens-workspace-hover', marker)
              if (typeof card.setAttribute === 'function') card.setAttribute('data-tokenlens-workspace-hover', marker)
              continue
            }
            // Rebuild the children so labels follow the active locale and the
            // numbers update in place (no duplicate blocks on re-render).
            if (typeof line.removeChild === 'function') {
              while (line.firstChild !== null && line.firstChild !== undefined) {
                line.removeChild(line.firstChild)
              }
            }
            for (const [i18nKey, value] of buckets) {
              const item = doc.createElement('span')
              item.className = 'dsh-tokenlens-workspace-hover-token'
              const label = doc.createElement('span')
              label.className = 'dsh-tokenlens-workspace-hover-label'
              label.textContent = fallbackTranslate(i18nKey)
              const amount = doc.createElement('span')
              amount.className = 'dsh-tokenlens-workspace-hover-value'
              amount.textContent = formatTokensPrecise(value)
              item.appendChild(label)
              item.appendChild(amount)
              line.appendChild(item)
            }
            line.setAttribute('data-tokenlens-workspace-hover', marker)
            line.setAttribute('data-tokenlens-workspace-hover-signature', signature)
            if (typeof card.setAttribute === 'function') card.setAttribute('data-tokenlens-workspace-hover', marker)
          } catch {
            /* one odd hover card must not stop the others */
          }
        }
      } catch {
        /* decorative only: never let a hover card break the app */
      }
    }

    /**
     * Install the sidebar decorator: initial refresh, debounced MutationObserver
     * on document.body and a store subscription that refreshes badges after any
     * stats update. Returns the disposer (observer + timers + subscription).
     */
    function startWorkspaceTokenDecorator() {
      if (
        typeof document === 'undefined' ||
        typeof MutationObserver !== 'function' ||
        document.body === null ||
        document.body === undefined
      ) {
        return () => {}
      }
      let stopped = false
      let observer = null
      let debounceTimer = null
      const statsTick = typeof setInterval === 'function'
        ? setInterval(() => {
            try {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              refreshWorkspaceTokens()
              refreshWorkspaceHoverCards()
            } catch {
              /* decorative only */
            }
          }, 5000)
        : null
      // Hover cards can open before the first stats response lands; the 5s
      // tick created above decorates them once the store has data.
      let disposeStore = null
      const debouncedRefresh = () => {
        if (stopped) return
        try {
          if (debounceTimer !== null) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            debounceTimer = null
            refreshWorkspaceTokens()
            refreshWorkspaceHoverCards()
          }, WORKSPACE_OBSERVER_DEBOUNCE_MS)
        } catch {
          /* timers are best-effort */
        }
      }
      try {
        observer = new MutationObserver((mutations) => {
          try {
            // Our own badge/hover writes also produce childList mutations; reacting
            // to them would feed the observer forever (~6 Hz). Ignore mutations
            // whose target is inside one of our decorated containers.
            const ownTarget = (target) => {
              if (target === null || target === undefined || typeof target.closest !== 'function') return false
              return (
                target.closest(`.${WORKSPACE_BADGE_CLASS}`) !== null ||
                target.closest('.dsh-tokenlens-workspace-hover-tokens') !== null
              )
            }
            if (mutations.length > 0 && mutations.every((mutation) => ownTarget(mutation.target))) return
          } catch {
            /* fall through to the debounced refresh */
          }
          debouncedRefresh()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch {
        observer = null
      }
      try {
        disposeStore = store.subscribe(() => debouncedRefresh())
      } catch {
        disposeStore = null
      }
      refreshWorkspaceTokens()
      refreshWorkspaceHoverCards()
      return () => {
        stopped = true
        try {
          if (observer !== null) observer.disconnect()
        } catch {
          /* already gone */
        }
        try {
          if (debounceTimer !== null) clearTimeout(debounceTimer)
        } catch {
          /* already gone */
        }
        try {
          if (typeof disposeStore === 'function') disposeStore()
        } catch {
          /* already gone */
        }
        try {
          if (statsTick !== null && typeof clearInterval === 'function') clearInterval(statsTick)
        } catch {
          /* already gone */
        }
      }
    }

    // ---------------------------------------------------------------------
    // Plugin body.
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        boundTranslate = typeof ctx?.locale?.bind === 'function' ? ctx.locale.bind(NS) : null
        try {
          const localeSnapshot = typeof ctx?.locale?.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined
          appLocale = typeof localeSnapshot?.locale === 'string' ? localeSnapshot.locale : ''
        } catch {
          appLocale = ''
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tokenlens: dictionaries')
        ctx.effect(() => {
          const style = installStyles()
          return () => {
            if (style !== undefined && style.parentNode !== null) style.parentNode.removeChild(style)
          }
        }, 'dsh-tokenlens: styles')
        ctx.effect(() => startController(), 'dsh-tokenlens: usage controller')
        // Experimental: per-workspace token badges in the left sidebar + a
        // background stats fetch/poll so the badges stay fresh outside the dialog.
        ctx.effect(() => startWorkspaceTokenDecorator(), 'dsh-tokenlens: workspace token badges')
        ctx.effect(
          () => {
            let stopped = false
            const poll = () => {
              if (stopped) return
              try {
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
                void requestStats()
              } catch {
                /* the bridge may not be ready yet; the next tick retries */
              }
            }
            poll()
            const timer = setInterval(poll, WORKSPACE_STATS_INTERVAL_MS)
            return () => {
              stopped = true
              clearInterval(timer)
            }
          },
          'dsh-tokenlens: workspace tokens stats poll',
        )
        // v0.17.0: a management-page sync timer may be running while the dialog is
        // open; make sure plugin disposal stops it with everything else.
        ctx.effect(() => () => stopManagementSync(), 'dsh-tokenlens: management sync')

        // The dock control: a new id adds a control next to the shipped
        // `activity` (order 0) and `usage` (order 1) statistics.
        ctx.slots.inject(DOCK_SLOT, () =>
          ctx.slots.register({ name: DOCK_SLOT, id: 'tokenlens', order: 5, locale: NS }, UsageChip),
        )

        // The detail dialog: the session-scoped composer overlay seat, id per
        // PROTOCOL.md so it can be named in diagnostics.
        ctx.slots.inject(DIALOG_SLOT, () =>
          ctx.slots.register({ name: DIALOG_SLOT, id: `${CELL}-dialog`, order: 3, locale: NS }, UsageDialog),
        )
      },
    }
  },
})
