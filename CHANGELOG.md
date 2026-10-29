# Changelog

版本号约定（用户约定）：**每次对话如果改动了文件，就更新一次版本号**。
语义化版本：修 bug / 小调整 = PATCH，新功能 = MINOR，不兼容改动 = MAJOR。
用 `scripts/bump-version.mjs <version> "<说明>"` 一次完成 `package.json` + `index.js`
（`PLUGIN_VERSION`）+ 本文件的同步更新。

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

- 首个公开版本：包名与内部标识统一为 dsh-tokenlens / tokenlens、开源配套文件、MIT 许可

## 0.36.3 — 2026-10-28

- feat(ui): 弹窗/管理页标题中的插件名同时显示中英文「dsh-TokenLens · 词元透镜」（后接供应商名或管理页）

## 0.36.2 — 2026-10-28

- feat(ui): 弹窗标题改为「插件名 · 供应商名」（如 词元透镜 · OpenCode），管理页标题改为「插件名 · 管理页」；新增 appTitleShort/managePageLabel i18n 键并更新测试

## 0.36.1 — 2026-10-28

- chore(ui): 移除供应商配置 tab 已过时的「添加自定义用量适配器」创建/编辑流程（按钮、表单、草稿、保存请求、i18n/CSS 与相关测试）；保留已保存自定义适配器的展示与删除；dshUnsupportedHint 改为中性文案

## 0.36.0 — 2026-10-28

- chore!: 技术包名统一为 dsh-tokenlens（显示名 dsh-TokenLens / 词元透镜）；同步 plugin patch、client module id/CELL、Host PLUGIN_NAME、profile 依赖/bundles/patch/lock 与 node_modules junction；bridge URL/配置目录/locale NS 保持稳定

## 0.35.1 — 2026-10-28

- chore: 插件正式命名——英文 dsh-TokenLens、中文「词元透镜」；更新 package meta.title/description、界面 i18n 标题与 README；技术包名沿用私有命名

## 0.35.0 — 2026-10-28

- feat: 插件命名为「TokenLens · 用量透镜」（package meta/title、README）；图标 svg 增加内联尺寸/flex-shrink 保护与 overflow:visible，修复套餐容量标题前小图标被挤成细条/遮挡的问题

## 0.34.4 — 2026-10-28

- fix(ui): 工作区悬浮卡「总计」显示 0——entry.total 是数字却按 bucket 对象取值；改为 Number.isFinite(entry.total) 直接取值；同时保留 5s 补刷保证统计到位后四行自动出现

## 0.34.3 — 2026-10-28

- fix(ui): 工作区悬浮卡统计在首轮统计未返回时不显示——装饰器增加 5s 轻量刷新（仅装饰器成功安装后创建并随 dispose 清理），统计到位后自动补上四行数据；修复临时 interval 的作用域/清理

## 0.34.2 — 2026-10-28

- fix(ui): 工作区悬停卡片 Token 统计真正改为 4 行——之前的容器 CSS 因附加 margin-top 未匹配而未替换；现在容器 flex-direction:column，每行标签左/数值右

## 0.34.1 — 2026-10-28

- fix(ui): 工作区悬停卡片的 Token 统计改为分 4 行显示（标签左、数值右对齐），不再横向换行拥挤

## 0.34.0 — 2026-10-28

- feat(ui+stats): 工作区悬浮卡片显示该工作区今日/最近7天/最近30天/总计 Token；Host 按 cwd 保留每日桶并输出四个窗口（缓存版本 5），客户端在 hoverContent 卡片追加四列统计（按标题/路径匹配，纯装饰降级）；侧栏徽标保留总计

## 0.33.2 — 2026-10-28

- fix(ui): 工作区徽标出现两个 Token 数字——旧版徽标的裸文本节点残留；升级到图标+数值结构前先移除 badge 内非空文本节点，只保留小图标与数值 span

## 0.33.1 — 2026-10-28

- feat(ui): 工作区 Token 徽标前增加小数据库图标（内联 SVG），徽标改为 inline-flex 图标+数值，宽度略增；无图标资源依赖

## 0.33.0 — 2026-10-28

- feat(stats+ui): 新增按工作区统计——Host 按会话 cwd 聚合所有 Token 并映射 workspaceRegistry（workspaceId/title/path/total/messages，payload workspaces）；客户端在左侧工作区行名称右侧注入 Token 徽标（3 位小数，tooltip 含请求数），MutationObserver+统计订阅自动刷新，宿主未解析到 id 时按标题回退；后台每 60s 刷新统计；纯装饰、失败自动降级

## 0.32.3 — 2026-10-28

- fix(ui): 图表模式明细的图例改为共享网格（legend 用 grid，行 display:contents），百分比与 Token 数值列跨行右对齐，视觉整齐

## 0.32.2 — 2026-10-28

- fix(ui): 套餐容量卡的「已消耗·预计可消耗」移到重置日期右侧（重置时间 → 绝对日期 → 估算）；图表模式明细三组环形图之间补上竖分割线/间距（窄屏顶部横线），图例名称最多两行换行显示不再省略

## 0.32.1 — 2026-10-27

- fix(ui): 套餐容量卡片的「已消耗 · 预计可消耗」不再单独起一行，改为内联到现有重置/续期行（resetText · 已消耗 X · 预计可消耗 Y），卡片高度不变；逻辑/回退/双模式不变

## 0.32.0 — 2026-10-27

- feat(stats+ui): 本机 Token 统计新增 rolling 5 小时窗口（DSH 会话按小时折叠，客户端 provider 行 fiveHours）；套餐容量卡片在数据/图表模式都新增每窗口「已消耗 X · 预计可消耗 Y」——Y 由本机用量÷套餐百分比估算（百分比为 0/无数据时显示 —），附估算说明 tooltip；缓存版本 3 使旧缓存失效

## 0.30.13 — 2026-10-27

- feat(ui): 明细表所有表头（名称/今日/最近7天/最近X天/总计）统一为 12px tertiary 样式；窗口列宽 58→64px，三列比例首列改为 minmax(320px,1fr) 以容纳完整表头

## 0.30.12 — 2026-10-27

- fix(ui): 名称列表头字号改为与「按 Harness」标题一致（12px、tertiary、常规字重、下边框），不再是 9px 小字

## 0.30.11 — 2026-10-27

- fix(ui): 名称列表头（Harness/供应商/模型）改为与窗口表头完全一致的样式（9px、tertiary 色、字重 400、下边框、内边距、省略号），不再使用默认 th 加粗居中样式

## 0.30.10 — 2026-10-27

- feat(ui): 明细三列的名称列表头分别改为 Harness / 供应商 / 模型（en: Harness / Provider / Model），替换通用「名称」

## 0.30.9 — 2026-10-27

- fix(ui): 明细表名列表头真正补上（nameHeader 之前未传入表头构造函数）；三列之间增加竖分割线/间距，窄屏改为顶部横线；新增测试

## 0.30.8 — 2026-10-27

- feat(ui): 明细三列增加列分割线（第二/三列左侧竖线+间距，窄屏改为顶部横线）；每列名称列补上表头「名称」；新增对应测试

## 0.30.7 — 2026-10-27

- fix(ui): 明细表全部使用内联 table 语义（table/thead/tbody/tr/td 的 display 与 width/table-layout/右对齐），即使浏览器残留旧样式也不会把行/单元格变成普通 box；同时移除临时 LAYOUT 探针

## 0.30.6 — 2026-10-27

- debug: 布局探针扩展——输出首个表 th/td 的宽度、右边缘与 text-align，以及注入样式表长度/是否包含右对齐规则，用于确认表头/数值是否真的同列右对齐

## 0.30.5 — 2026-10-27

- debug: 临时布局探针（无条件 hook + 明细卡片底部 LAYOUT 读数：grid 列模板、各块/各表宽度、表头 th 宽度），用于定位第一列窄表与右对齐问题；随后移除

## 0.30.4 — 2026-10-27

- fix: 注入样式表在已有 <style> 时不再直接返回——HMR 重载后沿用旧 CSS 导致新布局规则不生效（第一列窄表/错位等问题反复出现）；现在每次重载都刷新样式内容

## 0.30.3 — 2026-10-27

- fix: 移除 v0.30.2 的调试代码（条件调用 useEffect 导致 Hook 顺序错误、弹窗无法打开）；恢复 v0.30.1 三列明细布局

## 0.30.2 — 2026-10-27

- debug: 临时在明细卡片渲染布局测量信息（列容器/各块/各表宽度与 grid 模板），用于定位第一列被压窄问题；诊断后移除

## 0.30.1 — 2026-10-27

- feat(ui): 明细卡片改为一行三列（按 Harness / DSH 按供应商 / DSH Top 模型）并使用确定性 Grid（minmax(280px,1fr) / 1.15fr / 1.35fr）；每列真实 table、名称+右对齐数值、表头完整标签；收起明细仅 Harness 单列占满

## 0.30.0 — 2026-10-27

- restore: 回退到 v0.30.0 数据模式明细布局（按 Harness / DSH 按供应商 / Top 模型 三组全宽表格上下堆叠），保留图表模式、最近7天、管理页设置等全部功能；版本号回到 0.30.0

## 0.31.2 — 2026-10-27

- fix(ui): 明细第一列（按 Harness）设置最小宽度 280px（grid minmax(280px,1fr)），防止被压窄导致名称/数值竖排；其余两列比例不变

## 0.31.1 — 2026-10-27

- fix(ui): 明细三列改为确定性 Grid（1 / 1.15 / 1.35 fr）并给表格 min-width:100%，避免第一列在 flex 布局下被压窄导致名称/数值竖排；表头与数值仍统一右对齐、窗口列 58px

## 0.31.0 — 2026-10-27

- fix(ui): 明细表头恢复完整窗口标签（今日/最近7天/最近X天或最近30天/总计）并右对齐到对应数值列；窗口列宽 54→58px，表头与数值统一右对齐、内边距对齐；修复名称/数值列挤压

## 0.30.9 — 2026-10-27

- fix(ui): 明细第一列挤压/竖排根因——名称 td 上用了 display:-webkit-box（把 table-cell 变成 box，破坏表格列宽）；改为 td 保持 table-cell、内部 div 做两行 clamp；表格列宽恢复，Harness 列不再被压成竖排字符

## 0.30.8 — 2026-10-27

- fix(ui): 明细表简化为「每个条目一行」的真实 table——名称 td + 数值 td 与表头 th 同列（浏览器保证对齐），名称最多两行+tooltip，窗口列 54px，三列宽度比例 Harness 1 / 供应商 1.15 / Top模型 1.35；移除两行结构

## 0.30.7 — 2026-10-27

- fix(ui): 明细表改用真实 HTML table（table-layout:fixed + colgroup 58px 窗口列）——名称行 colspan 整行、数值行与 th 表头由浏览器保证同列；移除 grid/display:contents 兼容 hack；备注/错误行改为 colspan 行

## 0.30.6 — 2026-10-27

- fix(ui): 明细表头/数值错位真正原因——harness/breakdown/model 行的旧 CSS display:flex 覆盖了表行的 display:contents，导致这些行脱离共享 grid；新增 .dsh-tokenlens-details-table .dsh-tokenlens-details-table-row{display:contents} 强制所有明细行参与同一列轨道

## 0.30.5 — 2026-10-27

- fix(ui): 彻底修复明细表头/数值不对齐——每张明细表改为单一 CSS grid，表头与各行用 display:contents 共享同一列轨道（名称 1fr + 每个窗口 58px），不再各自成 grid；名称仍独占一行，数值与表头严格同列，行 tooltip 保留

## 0.30.4 — 2026-10-27

- fix(ui): 数据模式明细行改为两行——名称独占整行（不再被数值列挤压截断），数值在下一行与表头列严格对齐（显式 gridColumn 2..）；表头使用独立 spacer 类；保留 58px 数值列宽

## 0.30.3 — 2026-10-27

- fix(ui): 修复数据模式明细表头与数值不对齐——表头和数据行各自是独立 grid，auto 列宽导致每行按内容自行定宽；改为固定 58px 的数值列宽，表头/所有数据行共用同一列模板（名称列 1fr + 数值列 58px）

## 0.30.2 — 2026-10-27

- fix(ui): 数据模式明细去重标签——每列只在组标题下显示一次窗口表头（今日/7天/X天/总计，旧 Host 今日/30天/总计），数据行仅保留名称+右对齐数值，请求数移入 tooltip；表头与数值共用 grid 列模板，减少重复文字、提升可读性

## 0.30.1 — 2026-10-27

- feat(ui): 数据模式「明细」改为一行三列——按 Harness / DSH 按供应商 / DSH Top 模型三列并排（窄屏 760px 下单列），每行改为名称+2x2 窗口值（今日/最近7天/最近X天或30天/总计）；收起明细仅显示 Harness 列；移除旧宽表格渲染

## 0.30.0 — 2026-10-27

- feat(ui): 数据模式布局对齐图表模式——上排套餐容量+本机 Token 摘要、下排明细整行（移除三列 grid）；本机 Token 新增「最近7天」窗口——数据卡片 今日/最近7天/最近X天/总计，按 Harness/按供应商/Top模型表格增加最近7天列，图表摘要增加最近7天；Host stats 新增 last7Days（顶层/供应商/分harness/模型），旧 Host 自动回退

## 0.29.0 — 2026-10-27

- feat(ui): 管理页新增「供应商配置 / 插件设置」两个 tab——插件设置可配置标签样式、默认展示模式（图表/数据）、默认统计范围（当前供应商/全部 Harness）、明细默认展开（自动/展开/收起），即时保存到 providers.json 并应用到弹窗初始/重置状态；恢复默认设置按钮；Host settings 扩展为四字段并校验

## 0.28.0 — 2026-10-27

- feat(ui): 用量弹窗默认打开图表模式——初始状态、打开/关闭弹窗、切换供应商、从管理页返回均重置为图表；数据模式仍可切换并保持原卡片/表格；空数据保持图表空态

## 0.27.2 — 2026-10-27

- feat(ui): 每日图表下方统计补充「今日」与「最近X天/最近30天」——图表摘要行现显示 今日 / 当前窗口（订阅用最近X天、无订阅用最近30天）/ 合计 / 峰值；新增对应测试

## 0.27.1 — 2026-10-27

- fix(ui): 图表模式「明细」数据补全——Top 模型不再按当前供应商过滤，与数据模式一致显示全部 Top 模型（避免只显示 1 个模型 100%）；环形图/图例行上限从 8 提到 12，避免数据模式有而图表缺失

## 0.27.0 — 2026-10-27

- feat(ui): 明细卡片图表改为环形占比图 + 排行图例——每组（Harness/供应商/Top模型）一个 SVG 环形图（按占比分色、中心显示合计）+ 图例（色点/名称/百分比/精确值，带 tooltip），三组并排、窄屏换行；移除竖向迷你柱图，无溢出/滚动条

## 0.26.2 — 2026-10-27

- feat(ui): 明细卡片图表改为竖向棒柱图（按 Harness / DSH 按供应商 / Top 模型 三组，柱高按最大值归一化，含数值与标签、悬浮提示），风格对齐本机 Token 每日图；布局行类名已隔离，无溢出风险

## 0.26.1 — 2026-10-27

- fix(ui): 修复图表模式内容溢出弹窗——布局行与明细条形图行共用 dsh-tokenlens-chart-row 类导致条形图被 flex 布局撑散；布局行改名 dsh-tokenlens-chart-layout-row，明细行恢复 chart-row；图表模式改为显式两行容器（上排容量+每日图、下排明细整行），不再用 grid order/flex-basis 技巧

## 0.26.0 — 2026-10-27

- feat(ui): 图表模式下「明细」卡片改到下方单独整行（flex basis 100% + order:3），上排保留「套餐容量 + 每日趋势图」；明细仍为稳定的横向条形图，不引入新的渲染结构，规避上一版整窗异常

## 0.25.5 — 2026-10-27

- fix(ui): 回退到稳定图表布局——图表模式恢复三列（容量 / 每日图 / 明细横向条形图），移除导致整窗异常的下排整行迷你柱图布局；保留图表异常兜底

## 0.25.4 — 2026-10-27

- fix(ui): 图表渲染增加异常保护——每日趋势图或明细图表构建异常时降级为提示块，不再让整个弹窗消失；便于定位真实客户端渲染错误

## 0.25.3 — 2026-10-27

- fix(ui): 图表模式布局改为上排「套餐容量 + 本机 Token 每日图」、下排「明细」单独整行；明细卡片改成竖向迷你柱状图（按 Harness / DSH 按供应商 / Top 模型，含数值与相对高度），与每日趋势图风格一致

## 0.25.2 — 2026-10-27

- fix(ui): 图表模式下「明细」卡片改为图表——按 Harness / DSH 按供应商 / Top 模型 三组横向条形图（含标签、数值、相对宽度），每日趋势图保留在中间列；数据模式与其它图表交互不变

## 0.25.1 — 2026-10-27

- fix(ui): 图表模式不再让「明细」列空白——切换图表后隐藏数据摘要列，把宽幅图表区块放在「明细」列位置并占满剩余宽度（flex:2 1 560px）；数据模式不变，新增布局回归测试

## 0.25.0 — 2026-10-27

- feat(ui): 图表模式增加 X/Y 轴与实时读数——Y 轴 5 档刻度+网格线（3 位小数格式化），X 轴日期标签（≤10 天全显示，否则约 6 个含首尾），鼠标在绘图区滑动按最近柱实时高亮并浮动显示 日期·数值（占比%），移出清除；空数据保持空态，数据模式不变

## 0.24.2 — 2026-10-27

- fix(ui): 套餐容量窗口重置时间增加绝对日期（本地 YYYY/MM/DD HH:mm，来自 resetsAt 或 remainingMs 推算），显示在 X 后重置旁；修复区块标题 SVG 图标底部被裁切（display:block、overflow:visible、去掉 vertical-align 偏移）；新增回归测试

## 0.24.1 — 2026-10-27

- fix(ui): 数据/图表切换从 Token 区块的 scope 行移到弹窗顶部工具栏、紧跟「管理」按钮左侧（工具栏内不再右推），数据模式/图表模式行为不变；新增工具栏位置回归测试

## 0.24.0 — 2026-10-27

- feat(ui): 本机 Token 用量新增「数据/图表」模式切换——数据模式保留卡片与明细；图表模式用纯 CSS 日柱状图展示每日 token（供应商维度按订阅生效窗口、全部 Harness 按最近30天，含合计/峰值/悬浮提示与空态）；Host stats 载荷新增 daily 日序列（DSH + 外部 harness 映射，最多120天）

## 0.23.0 — 2026-10-26

- feat(ui): 管理页供应商卡片新增「已订阅/未订阅」徽章——Host providers 载荷新增 subscribed（最近成功快照有 plan id 或真实百分比窗口才为 true），卡片元信息行显示绿色 已订阅或灰色未订阅并附说明，内置/自动映射/自定义适配器一致；zh/en i18n 与测试

## 0.22.2 — 2026-10-26

- fix(stats): Command Code 免费/无套餐不再误判为订阅——subscribed 仅认 plan 或百分比窗口（Number.isFinite(percent)），免费快照的 null 百分比窗口归为无订阅，显示最近30天

## 0.22.1 — 2026-10-26

- fix(stats): 最近X天仅在供应商有订阅时启用——Host 按最近快照的 plan/windows 判定 subscribed，客户端有订阅用 sinceEffective+最近X天，无订阅（余额/按量付费/未知）保持最近30天与 last30Days；旧 Host 缺字段回退最近30天

## 0.22.0 — 2026-10-26

- feat(stats): 供应商维度「最近30天」改为「最近X天」——按该供应商本机最早用量记录作为生效日期，X = 生效日期到今天的天数（含首日），数值取 sinceEffective（等于该供应商全量，模型/按 Harness/按供应商行同步）；全部 Harness 保持最近30天；旧 Host 回退 last30Days

## 0.21.0 — 2026-10-26

- feat: 火山引擎 Coding Plan/AgentPlan 额度接入——Volcengine Signature V4 调 GetCodingPlanUsage（AK/SK 从 VOLCENGINE_ACCESS_KEY_ID/SECRET_ACCESS_KEY 读取），解析 5h/weekly/monthly 百分比窗口与 plan；新增签名/解析/主机集成测试；智谱国内版沿用 v0.20.0

## 0.20.0 — 2026-10-26

- feat: 智谱 AI 国内版接入 GLM Coding Plan 额度接口（open.bigmodel.cn/api/monitor/usage/quota/limit，复用 Z.ai quota 解析，5 小时/本周/每月窗口）；bigmodel.cn 自动映射指向国内适配器；其余新增供应商暂无公开 Bearer 额度接口，保持元数据

## 0.19.0 — 2026-10-26

- feat: 扩充内置供应商元数据池——新增商汤(SenseNova)、火山引擎、通义千问、百度千帆、智谱 AI 国内版、Intern AI、Agnes AI、Open Design，另补充腾讯混元、讯飞星火、零一万物、百川智能；字段沿用现有结构（kind/label/shortLabel/baseURL/apiKeyRef/consoleUrl），未新造字段、未改既有条目；管理页「内置」列表可识别与展示，payload kind 回退到元数据

## 0.18.0 — 2026-10-26

- feat: DSH 模型设置供应商自动同步并自动识别用量接口——按路由 id 或模型 baseURL 主机别名自动映射到内置用量适配器（OpenRouter/Moonshot/SiliconFlow/StepFun/Novita/Hyperbolic/DeepInfra/Z.ai/MiniMax/DeepSeek/CommandCode/OpenCode），继承 DSH profile 的 apiKeyEnv，无需手动添加自定义适配器；配置变更时清理缓存；无法识别的路由给出可读提示并引导使用自定义适配器（保留为高级用法）

## 0.17.2 — 2026-10-26

- fix(ui): 自定义用量适配器表单字段重叠——字段标签/提示改为上下堆叠换行、表单网格改 auto-fit minmax(260px) + align-items:start、输入框限制 max-width；新增静态布局回归测试

## 0.17.1 — 2026-10-26

- fix: 管理页「已配置」误把 ctx.llm.listProviders() 的动态注册路由（dsh-our-free-model 等插件渠道）当作已配置；改为以 DSH 模型设置 llm-pi-ai 的 providers 配置为准（通过 ctx.configEditor.configuration() 读取，账号服务 deepseek-account 计入），无 configEditor 时回退旧行为

## 0.17.0 — 2026-10-26

- feat(ui): 管理页供应商列表按「DSH 模型设置」动态发现——新增筛选标签 已配置/内置/全部（默认已配置）；已配置页签只显示 DSH 已配置路由（支持适配器的卡片 + 无适配器灰行），无配置时显示空态；管理页打开期间每 15 秒自动刷新 providers，并在窗口 focus/可见时刷新；按 providerId 去重并按 DSH 顺序/内置顺序/自定义最后排序

## 0.16.0 — 2026-10-26

- feat: 自定义用量适配器（方向2）——管理页可为任意 DSH 路由声明 balance/windows 适配器（URL、凭据引用、JSON 字段路径），保存到 providers.json 并即时参与套餐容量统计与 chip；新增 customProviderSave/customProviderDelete 动作、custom 标记与 definition 回传（编辑表单可回填）；新增自定义适配器单元/集成测试

## 0.15.0 — 2026-10-26

- feat(ui): 管理页改为 DSH 模型设置驱动——providers 载荷新增 dshProviders（DSH 已注册路由及是否有用量适配器），页面主区列出 DSH 供应商（支持的复用卡片、无适配器的灰显提示），未在 DSH 配置的预设适配器收进可折叠次级区；旧 Host 缺字段时回退平铺列表

## 0.14.0 — 2026-10-26

- feat(ui): 管理页移除 API Key / Base URL 与 手动覆盖开关——所有供应商统一复用 DSH 模型设置；已配置路由的供应商显示继承说明，未配置的提示去 DSH 设置中添加（含建议路由 id）；保存只提交 enabled/consoleUrl/短标签/全名

## 0.13.0 — 2026-10-26

- feat(ui): 管理页复用 DSH 模型设置——由 DSH 配置了路由的供应商（OpenCode/Command Code/DeepSeek）默认隐藏 API Key 与 Base URL，显示 继承自 DSH 模型设置；提供手动覆盖开关（覆盖优先），未在 DSH 中配置的供应商仍可手工填写；providers 载荷新增 dshManaged/dshProviderId

## 0.12.2 — 2026-10-26

- fix(ui): 管理页折叠状态供应商卡片高度从 132px 收紧到 84px，去掉卡片内多余空白（展开仍只影响自身）

## 0.12.1 — 2026-10-26

- fix(ui): 管理页仅展开被点击的供应商卡片（网格改 align-items:start + 卡片 min-height，去掉 stretch/1fr/height:100% 导致整行拉高）；本机 Token 用量所有数字统一精确到小数点后三位（<1000 整数，≥1000 用 K/M/B/T 固定 3 位小数，含进位保护）

## 0.12.0 — 2026-10-26

- feat(ui): 管理页供应商卡片高度统一（align-items:stretch + grid-auto-rows:1fr + 卡片 height:100%，头部固定 5 列布局，状态徽章不再换行）；短标签/全名支持在管理页编辑并持久化（providerUpdate label/shortLabel，≤12/≤40 字符，清空恢复默认，含恢复默认名称按钮与校验错误渲染）

## 0.11.0 — 2026-10-26

- feat(ui): 弹窗与供应商管理页视觉/布局重构——宽屏三栏（套餐容量 / Token 摘要 / 明细）、管理页供应商卡片响应式多列、面板加宽到 1120px；新增内联 SVG 图标（区块标题、管理、状态、类型徽章、供应商首字母头像、按钮图标），压缩留白

## 0.10.7 — 2026-10-26

- fix: 弹窗改用自有 overlay 面板（宽度 min(1080px, 100vw-24px)、高度 min(100vh-24px)），彻底摆脱 primitives Modal 的 fit-content 宽度限制；容量/统计按容器宽度 flex-wrap 双栏，窄屏自动单列；正文不出现滚动条

## 0.10.6 — 2026-10-26

- fix: 弹窗宽度不再被内部网格 min-content 压扁——对话框主动申请 min(860px,视口-48px) 宽度，容量/统计两栏改用 flex-wrap 按容器宽度自动折行（容器足够宽才并排），修复窄条状弹窗与文字逐字换行

## 0.10.5 — 2026-10-26

- fix: 窄窗口排版错位——≤560px 时标题/行/卡片/分组自动换行、禁止横向溢出、harness 名称与数值分行、footer 链接省略号收窄；不引入滚动条

## 0.10.4 — 2026-10-26

- fix: 弹窗改为无滚动条自适应布局：容量与本机统计在宽屏双列排布、<=800px 高度紧凑、<=680px 宽度单列；DSH 按供应商/Top 模型收进「更多明细」折叠（矮屏默认收起），管理页供应商卡片自动多列

## 0.10.3 — 2026-10-26

- fix: 弹窗改为可滚动内容区并按屏幕高度/宽度自适应压缩（小分辨率不再显示不全）：max-height 滚动、<=760px 紧凑间距与两列卡片、<=620px 单列卡片

## 0.10.2 — 2026-10-26

- test: 客户端夹具与断言对齐 v0.10.1 缩写短标签（OC/DS/DSA/OR/MS）并新增用例覆盖短标签缩写、全名还原、以及 wire 缺失 shortLabel 时的本地回退

## 0.10.1 — 2026-10-26

- fix: 所有供应商短标签改为真正的缩写（OC/CC/DS/DSA/OR/MS/SF/ST/NV/HB/DI/ZAI/MM，与全名可区分）；默认 chip 名称样式改为全名，管理页可切短标签

## 0.10.0 — 2026-10-26

- feat: 每个供应商提供短标签与全名；供应商管理页新增「提词器名称：短标签 / 全名」选择（settingsUpdate 持久化到 providers.json，chip 实时跟随；启动时静默读取设置）

## 0.9.1 — 2026-10-26

- fix: 输入框下的用量 chip 品牌名改为供应商名 OpenCode（之前误用了套餐档位 Go）；为新增的 9 家供应商补齐 chip 短标签与全名

## 0.9.0 — 2026-10-26

- feat: 供应商管理页面（列表/启停/Key/baseURL/测试连接，覆盖写入插件 providers.json）+ 供应商扩展到 13 家（新增 OpenRouter、Moonshot/Kimi、SiliconFlow、StepFun、Novita、Hyperbolic、DeepInfra、Z.ai GLM Coding Plan、MiniMax Coding Plan）；新增 bridge 动作 providers/providerUpdate/providerTest

## 0.8.2 — 2026-10-26

- fix: 供应商显示名由 OpenCode Go 修正为 OpenCode（Go 仅是套餐档位）；接受选择器上报的 opencode 路由 id 作为 opencode-go 的别名，配置/协议向后兼容

## 0.8.1 — 2026-10-25

- fix: 「按 Harness」在当前供应商视图下只显示最近30天有该供应商用量的 harness；30天内无用量的 harness 不再显示占位行，全部无用量时显示说明文案

## 0.8.0 — 2026-10-25

- feat: 卸载/缺失的 harness 不再常驻弹窗（默认隐藏并记录到 missingHarnesses），临时读取失败仍显示错误行；新增 stats.showUninstalled 开关（旧名 showMissingHarnesses 兼容）

## 0.7.0 — 2026-10-25

- feat: 新增 WorkBuddy/CodeBuddy CLI 与 Qoder CN CLI 两个本地 harness 适配器（Claude-Code 风格 JSONL，只读；Qoder 自定义 provider 按 settings.json baseUrl 映射 commandcode），本机统计共 5 个 harness

## 0.6.0 — 2026-10-25

- feat: 多 Harness 本地统计框架：新增 OpenCode CLI（只读 SQLite message.tokens，reasoning 归一进 output）参与今日/30天/总计与按 Harness 拆分；harnesses[] 改为可扩展列表，支持每 Harness providerAliases、未映射汇总与按 Harness 错误降级

## 0.5.2 — 2026-10-25

- feat: 弹窗控制台/用量链接跟随所选供应商（snapshot.links.console：opencode 控制台 / commandcode 用量页 / DeepSeek 平台），支持 providers.<id>.consoleUrl 覆盖

## 0.5.1 — 2026-10-25

- fix: ZCode 供应商映射失效（ctx.llm.listModels 为异步，之前同步读取导致模型目录为空）；改为 await 目录 + 仅对 vendor-namespaced 模型 id 做模型匹配，其余保持 unmapped 可配 alias

## 0.5.0 — 2026-10-25

- feat: provider-scoped multi-harness token stats（当前供应商跨 DSH+ZCode 汇总）与 今日/最近30天/总计 三窗口，ZCode 供应商映射（alias + 模型目录匹配）

## 0.4.0 — 2026-10-25

- feat: ZCode harness token statistics（只读 SQLite model_usage，与 DSH 合并为「全部 Harness 合计」+ 按 Harness 拆分）

## 0.3.1 — 2026-10-25

- docs: 多 harness Token 统计可行性调研（opencode/ZCode/Codex/Cursor）

## 0.3.0 — 2026-10-25

- 弹窗明确分区：**套餐容量**（供应商服务端口径，命令式供应商显示原生单位：Command Code
  显示美元 `已用 / 上限` 与剩余额度，OpenCode Go 只有百分比，DeepSeek 显示余额）与
  **本机 Token 用量**（DSH 会话记录，可切换“当前供应商 / 全部供应商”）。
- Host：Command Code 的窗口额外携带 `used` / `cap`（USD）与 `unit`；协议升到 v3。
- 新增版本号维护：`CHANGELOG.md` + `scripts/bump-version.mjs`，状态文件/诊断展示版本。

## 0.2.0 — 2026-10-25

- 供应商感知：chip 跟随当前选择的模型供应商（OpenCode Go / Command Code / DeepSeek
  API Key / DeepSeek Account），Host 侧四家适配器 + 别名（`deepseek-official` → `deepseek`）。
- 弹窗新增 **Token 统计**：今日 / 全部时间（总量、输入/输出/缓存读、请求数、按供应商、
  Top 模型），来自本机会话日志的增量折叠。
- 统计口径修正：fork 会话只排除继承前缀、重试的非零用量计入、消息自带
  `message.source` 权威归属、`session.v4.jsonl.zstd` 生成代际。

## 0.1.0 — 2026-10-25

- 首个版本：composer dock chip + 详情对话框显示 OpenCode Go 套餐 5 小时 / 本周 / 本月
  已用百分比与重置倒计时；`tokenlens_usage` 工具；`/api/tokenlens` 桥；
  凭证解析（credentials → 环境变量 → `.credentials.yaml` → opencode CLI `auth.json`）；
  真实接口 + 热安装验证。
