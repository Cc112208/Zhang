# Stage 6 Phase 1：3D Memory Sea 前端只读核查与设计评审

> 状态：**只读核查完成，未修改任何生产代码，未新增 migration。** 等待批准后进入实现阶段。
> 核查时间：2026-10-30；宿主实例：`127.0.0.1:61505`（端口随重启变化，不作为配置写死）。

---

## 0. 结论摘要

1. 后端已具备渲染所需的**全部节点坐标与关系**：`/api/memory-sea/scene` 一次返回 `points + edges + stats`，坐标是稳定伪随机（刷新不变）。
2. 当前默认 scope 的 Scene 是 **316 点 / 312 边**：`episode 4 + experience 312`，`memory 0 / pattern 0`，边全部是 `contains`。数据真实、完整、可用。
3. `memories.total = 0` **不是 bug**。该 scope 的 4 个 Episode 全部已完成摘要与 consolidation（4 个 job `completed`），但内容是工具输出与代码路径，`RuleBasedConsolidator` 按设计返回 `noop`（"绝大多数 Episode 应该 no_op"）。全库 42 条真实 Memory 分布在其他 scope。
4. 现有前端 `legacy/public/index.html` 已是一个**可旋转的 3D 星海**：纯 Canvas 2D + 手写 3D 投影/透视/深度排序 + 拾取 + 详情面板，**没有任何 3D 引擎依赖**。因此不需要引入 three.js/WebGL，也不需要重写渲染核心——**在其思路上重写一个专用页面**，比"改造 legacy 页面"更干净（legacy 的数据契约与字段命名已过时）。
5. 宿主 `webServer` **只支持注册路由处理函数**（`exact`/`prefix`），**没有静态文件托管 API**。页面必须以「单个自包含 HTML 字符串」由路由直接返回（内联 CSS/JS，无 CDN、无外部静态资源）。
6. 需要新增 **3 个只读接口能力**（不改数据模型）：`scene?scope=`、`experiences/:id`、`episodes/:id`。其余详情（memory / pattern / 证据 / 连续性 / 审核）已有现成只读路由可复用。
7. 建议目录：`src/web/{scene-page.ts, scene-page-app.ts}` + `src/scene/node-detail.ts`（或 service 方法）+ 测试 `tests/scene-web.test.ts`；不改 migration 001–017。

---

## 1. 现状核查（文件清单与调用链）

### 1.1 后端相关文件

| 文件 | 作用 | 现状 |
| --- | --- | --- |
| `src/scene/scene-builder.ts` | 点/边/统计生成，稳定伪随机坐标，Episode 外壳、Memory 内层、Pattern 质心 | 已实现 |
| `src/scene/legacy-adapter.ts` | 转换为 legacy 前端契约（`ok/name/builtAt/points/edges/stats`） | 已实现 |
| `src/index.ts` | 注册 5 条 exact 只读路由 + 若干 prefix 只读路由 | 已实现，见 §1.3 |
| `src/service.ts` | `getScene(options)` / `getLegacyScene(options)` / `inspect(id)` / `getEpisodeContinuity` | 已实现 |
| `src/types.ts` | `ScenePoint` / `SceneEdge` / `SceneStats` / `MemorySeaScene` | 已实现 |
| `legacy/public/index.html` | 旧前端（Canvas 2D 3D 投影：旋转/滚轮缩放/点击拾取/详情/标签/聚焦） | 可复用思路，不直接复用契约 |
| `legacy/src/mind-sea.js` | 旧前端布局与交互模块（421 行） | 仅供参考 |

### 1.2 现有 Scene 契约（`GET /api/memory-sea/scene`）

```jsonc
// 顶层
{ "scopeId": "project_...", "points": [...], "edges": [...], "stats": {...} }

// point（按类型有不同可选字段）
{
  "id": "ep_...", "type": "episode",          // experience | episode | memory | pattern
  "label": "3D Memory Sea V0.2 第一阶段验收：Ex…",
  "x": -10.95, "y": -57.6, "z": 9.44,          // 稳定伪随机，刷新不变
  "size": 4.04, "importance": 0.9, "activation": 0.9567,
  "createdAt": 1793219331030,
  "experienceCount": 195,                       // episode 专有
  "summary": "134: private refreshDerived(...)" // episode 专有（可选，可能为空）
  // memory: kind / confidence / reinforcementCount
  // pattern: patternKind / supportCount / stabilityScore / patternStatus
  // experience: sourceType
}

// edge（必带可读 reason）
{ "a": "ep_...", "b": "xp_...", "score": 0.9, "kind": "contains", "reason": "这段经历属于该段连续经历" }
// kind 取值：contains | supports | derived_from | supported_by | contradicted_by
//            | continues | followup | same_thread | same_topic

// stats
{ "experiences": 312, "episodes": 4, "memories": 0, "patterns": 0,
  "relations": 0, "edges": 312, "span": { "from": 1793219331030, "to": 1793220939201 } }
```

**判断：契约足以表达「三类节点 + 三类证据关系」，不需要新增 Scene 数据结构。**
缺的只是「按 scope 查询」与「单节点完整正文」，见 §4。

### 1.3 现有 HTTP 路由能力

| 路由 | 方法 | 能力 | 备注 |
| --- | --- | --- | --- |
| `/api/memory-sea/scene` | GET | 全量点/边/统计 | **不解析 `scope` 参数**（固定默认 scope） |
| `/api/memory-sea/legacy-scene` | GET | legacy 契约 | 同上 |
| `/api/memory-sea/status` | GET | 计数/健康 | 同上 |
| `/api/memory-sea/scopes` | GET | 已出现过的 scope 列表 | 906B，10 个 scope |
| `/api/memory-sea/health` | GET | 精简健康 | 同上 |
| `/api/memory-sea/memories[/:id]` | GET | Memory 列表 / 详情（含 evidence） | 可复用 |
| `/api/memory-sea/patterns[/:id]` | GET | Pattern 列表 / 详情（含 evidence） | 可复用 |
| `/api/memory-sea/episodes/:id/continuity` | GET | 某 Episode 的前后连续性 | 可复用 |
| `/api/memory-sea/episode-relations` | GET | 全 scope 连续性关系 | 可复用 |
| `/api/memory-sea/skill-*` | GET | Phase 1/2 只读查询 | **第一版 Scene 不展示** |
| `/api/memory-sea/operator/*` | GET/POST | 人工审核写入 | **与可视化无关，页面不调用** |

**缺口（仅 3 处，均为只读）**：
1. `scene` / `status` 不接受 `?scope=`（多 scope 切换必需）。
2. 无 `experiences/:id`（Experience 完整正文 + 所属 Episode 上下文）。
3. 无 `episodes/:id`（Episode 详情 + 成员 Experience + 关联 Memory/证据 + 连续性），目前只有 `continuity` 片段。

### 1.4 宿主 Web 能力

- `webServer.register({ kind: 'exact' | 'prefix', path, handler })`：**只有请求处理器，没有静态目录托管**。
- 结论：页面必须是**单个自包含 HTML 字符串**（内联 `<style>`/`<script>`），由 `exact` 路由返回；不引入 CDN、不引入外部静态文件（也就不需要 `copy-assets` 扩展）。
- 页面内的 API 请求必须用**同源相对路径**（`/api/memory-sea/...`），因为宿主端口会变（历史值：59817 → 51451 → 58043 → 61505）。
- 页面本身无法被其他机器访问时也无需额外鉴权（与现有只读 API 同级：本机 GUI 同源）。operator 写接口仍需要令牌，页面不涉及。

---

## 2. `memories.total = 0` 的根因（取证结论）

### 2.1 事实

- 默认 scope `project_4ac392fdccfaa5c0`（rootPath `c:/users/administrator/.dsh/profiles/desktop`）：
  - Episode 4 个，全部 `summary_status='ready'`、`consolidation_status='ready'`；
  - `episode_consolidation` 任务 4 个，全部 `completed`、`attempts=1`、`error=null`；
  - Experience 312 条，来源分布：**tool 283 / chat-assistant 6 / chat-user 22 / manual 1**；
  - Episode 摘要样本：`134: private refreshDerived(episodeId: string, now: number): void {…}`、`C:\Users\Administrator\Desktop\记忆插件\src\capture\episode-builder.ts`。
- 全库（同一 DB）：memories 表 42 条、memory_evidence 66 行，分布：
  `project_1b1a0fab281b0678` 12 active、`project_p2host` 18、`project_5ca055eda66d0003` 6、
  `project_bb74376c60f1c966` 3 active + 1 superseded、两个 live 观众 scope 各 2。

### 2.2 机制

`RuleBasedConsolidator` 的设计目标是「不撒谎」（文件头注释）：

- 只识别强信号措辞（决定 / 结论 / 必须 / 禁止 / 以后 / 优先 …，见 `hasDecisionWording`）；
- `candidateStatements()` 提取不到自然语言陈述 → `noop("没有可整理的自然语言陈述")`；
- 有陈述但门槛不够 → `noop("没有达到长期知识门槛的陈述")`；
- 注释明确写「**绝大多数 Episode 应该 no_op**」（`rule-based-consolidator.ts:1-40`、`:63-132`）。

该 scope 的 Episode 是 **agent 工具调用日志**（plugin_manager / curl / tsc 输出），不是「人做出的决定」，所以 4 个 Episode 全部 `noop` 是**正确行为**，不是丢数据、不是任务失败。

### 2.3 对前端的直接含义

- 第一版页面必须正确处理 **Memory 节点为 0** 的情形：显示统计与空状态说明（"当前 scope 只有 Experience/Episode；Memory 需由 Consolidation 从人话决定中提炼"），而不是报错或渲染空场景。
- 页面需要 scope 切换器，让用户看到有 Memory 的 scope（例如 `project_1b1a0fab281b0678` 的 12 条），否则验收只看到"没有 Memory"会误判实现缺失。

---

## 3. 前端技术选型

### 3.1 现有前端是否已有 3D 引擎

`legacy/public/index.html`（472 行）：`<canvas id="sea">` + `ctx = canvas.getContext('2d')` + 自写 `project(point, t)` + `requestAnimationFrame(frame)` + 深度排序 + `pick(mx, my)` + `showDetail(point)` + 拖拽旋转 + 滚轮缩放 + 标签绘制 + 聚焦。

**结论：没有 three.js / WebGL，是手写 3D 数学的 2D Canvas 投影渲染。** 但它确实是真三维（模型坐标 → 旋转矩阵 → 透视投影 → 按 z 排序绘制），且交互完整。

### 3.2 三个候选方案

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A. Canvas2D + 手写 3D（推荐）** | 新写一个专用页面，沿用 legacy 的投影/拾取思路，重做视觉编码与信息架构 | 零依赖、零 CDN、单文件内联、性能足够（316 点）、与现有零依赖约束一致、风险最低 | 点云/光效不如 WebGL；深度雾需手写 | **采用** |
| B. vendored three.js（WebGL） | 把 three.js 产物下载进仓库、内联进页面 | 渲染质量更高 | 引入 ~600KB 资产 + 维护负担；宿主无静态托管，只能内联，体积翻倍；与「运行时依赖为空」约束冲突 | 不采用（除非后续有明确三维需求） |
| C. 直接改造 legacy 页面 | 复用旧 HTML，只换数据源 | 工作量小 | 旧契约字段（`kind/topic/text/weight/cluster`）已与现 Scene 不同名；旧页面没有类型过滤/搜索/证据面板；改造等于重写 | 不采用（仅参考） |

### 3.3 方案 A 的渲染设计

- **坐标**：直接用 Scene 提供的稳定 `x/y/z`（不再前端重算布局，保证"刷新稳定"且与后端一致）。
- **相机**：球面轨道（yaw/pitch/radius），鼠标拖拽旋转、滚轮缩放、双击/按钮复位、`R` 键复位。
- **投影**：`透视投影 + 深度排序 + 深度雾（越远越暗/越小）`；背景星点静态（低开销）。
- **拾取**：把屏幕坐标反投影到最近可见点（复用 legacy 的 `pick` 思路，阈值按点半径）。
- **LOD**：Episode 标签常显；Experience 标签只在 hover/选中/放大后显示（312 条同屏会糊）。
- **视觉编码**：
  - Experience：小点，按 `sourceType` 着色，亮度 = `activation`；
  - Episode：中球（`size` 来自后端），外圈环形高亮表示 `experienceCount`；
  - Memory：大内核 + 光晕，颜色按 `kind`，光晕强度 = `confidence`；
  - 边：`contains` 细暗线；`derived_from`/`supports` 亮线；`continues`/`followup` 虚线；hover 时高亮并显示 `reason`。
- **确定性**：不引入随机抖动；同一数据两次渲染像素级一致（可加确定性测试：坐标与投影结果）。
- **空状态**：`memories=0` 时在 HUD 显示统计与解释；`points=0` 显示"该 scope 暂无经历"。

---

## 4. 为实现页面所需的只读接口增量（最小）

> 原则：优先复用；只有现有契约无法表达时才新增只读接口；不改数据模型、不加写 HTTP。

### 4.1 `GET /api/memory-sea/scene?scope=<id>` 与 `/status?scope=`（扩展已有 exact 路由）

当前 exact 路由忽略 query。改造点很小：handler 从 `req.url` 读 `scope`，传给 `service.getScene({ scopeId })` / `service.status({ scopeId })`。
- 兼容：无 `scope` 时仍用默认 scope，现有调用不受影响。
- 校验：`scope` 必须存在于 `knownScopes()`，否则 404 `{ok:false,error:'unknown scope'}`（防越权枚举）。
- 影响文件：`src/index.ts`（scene/status/health 三个 handler + 一个 `scopeFromRequest` 辅助）。
- 不改 Scene 数据结构，不需要新契约。

### 4.2 `GET /api/memory-sea/experiences/:id`（新增只读）

返回：
```jsonc
{ "ok": true, "experience": { id, sourceType, sourceId, sessionId, role, content, createdAt, observedAt, importance, metadata, episodeId, embeddingStatus },
  "episode": { id, title, startedAt, endedAt, status, summaryStatus } | null,
  "scopeId": "project_..." }
```
- 实现：`service.getExperience(id)` + `service.getEpisode(episodeId)`；scope 校验（item.scopeId 必须等于请求 scope 或省略）。
- 不能加写操作。

### 4.3 `GET /api/memory-sea/episodes/:id`（新增只读）

返回：
```jsonc
{ "ok": true,
  "episode": { ...Episode 全字段 },
  "experiences": [{ id, sourceType, role, createdAt, contentPreview }],  // 分页 limit(默认 50, max 200)
  "memories": [{ id, kind, content, confidence, relation: "derived_from" }], // 通过 memory_evidence 反查
  "continuity": { "previous": [...], "next": [...] },
  "stats": { "experienceCount": 195, "memoryCount": 0 } }
```
- 复用 `service.inspect(episodeId)` 已有数据（inspect 已返回 episode + experiences + continuity）；只需加 `memories`（证据反查）与 `contentPreview` 截断。
- 不改数据模型。

### 4.4 不新增的东西

- 不加 `/api/memory-sea/graph`（scene 已够）。
- 不加任何写 HTTP；页面不能 approve/编辑候选。
- 不把 Skill Candidate/审核状态放进第一版 Scene（它们不在 `getScene()` 的 points 里，天然满足；页面也不请求 `/skill-*`）。

---

## 5. 页面与路由设计

### 5.1 入口

- 新增 exact 路由 `GET /memory-sea/scene`（注意：**不带 `/api` 前缀**，属于页面而非 API），返回 `text/html; charset=utf-8`。
- 实现方式：`src/web/scene-page.ts` 导出 `renderScenePage(): string`（单文件 HTML，内联 CSS/JS）；`src/index.ts` 注册该路由。
- 若宿主对 `/memory-sea/scene` 有拦截/前缀冲突（需实测），回退方案：`GET /api/memory-sea/ui`（同源，仍由同一 webServer 提供），页面内所有 API 调用仍是相对路径。
- **不另起常驻服务。**

### 5.2 页面信息架构

- 顶部 HUD：scope 选择器（来自 `/scopes`）、节点计数（Experience/Episode/Memory）、搜索框、类型过滤（三类 + "关系"开关）、复位按钮。
- 主画布：3D 星海（旋转/缩放/拾取）。
- 右侧详情面板：
  - Experience：来源类型、时间、重要性、完整正文（走 `experiences/:id`）、所属 Episode（可点击跳转）。
  - Episode：时间范围、状态、摘要、成员 Experience 列表（点击查看正文）、关联 Memory、连续性（previous/next + reason）。
  - Memory：kind/status/confidence/importance/reinforcementCount、证据 Episode 列表（点击跳转）、`includeSuperseded` 提示。
  - Pattern：第一版**不显示**（过滤默认关闭；数据结构保留，因为 `getScene` 已含 pattern 点时 `filter` 可隐藏）。
- 底部状态条：请求耗时、点/边数、当前 scope、最近刷新时间。

### 5.3 交互与可访问性

- 鼠标：拖拽旋转、滚轮缩放、单击选中、双击复位；触屏：单指旋转、双指缩放（可后置）。
- 键盘：`R` 复位、`F` 聚焦选中、`Esc` 取消选择、`/` 聚焦搜索框。
- 面板纯文本渲染（`textContent`），不拼 HTML，避免 XSS（Experience 正文来自宿主内容，不可信）。

---

## 6. 测试与验收计划

### 6.1 新增测试（`tests/scene-web.test.ts`，全部离线）

1. **数据映射**：构造 Scene（含 memory/pattern/edge），断言页面数据模型转换后节点数、边引用完整性（每条边两端都存在）、`reason` 非空。
2. **Scope 隔离**：两个 scope 各造数据，断言页面加载函数按 scope 请求、不存在跨 scope 点。
3. **空数据**：`points=[]` 与 `memories=0` 两种情形不抛错、输出空态标记。
4. **确定性布局**：同一 Scene 两次生成页面数据 → 坐标/顺序完全一致。
5. **详情接口**：`experiences/:id`、`episodes/:id` 返回字段齐全、未知 id 404、跨 scope 404。
6. **无写能力**：断言页面不包含 `operator`、不发送 POST；路由清单里没有 `execute/run`。

### 6.2 回归

- Memory Sea 全量 182 项测试 + Live Agent 30 项 + `npm run smoke` 全通过。
- `npm run build`（tsc + copy-assets）干净。

### 6.3 真实宿主验收（新增脚本 `scripts/verify-stage6.mjs`）

- 参数：`--port`（必填或从 `DSH_WEB_PORT` 读取；不写死端口）；找不到端口则报错说明如何获取（运行时上下文 / `netstat`）。
- 检查：`/api/memory-sea/scene?scope=...` 200、点数与 stats 一致、边两端存在、详情接口 200、未知 scope 404、页面路由 200 且 `content-type: text/html`、页面自包含（无 `http://`/`https://` 外链、无 CDN）。
- 冷启动后人工打开页面：旋转/缩放/复位/选择/搜索/过滤/详情面板，截图或录屏留存。

---

## 7. 实施计划（批准后）

| 步骤 | 内容 | 文件 |
| --- | --- | --- |
| 1 | scene/status 支持 `?scope=` + scope 校验 | `src/index.ts` |
| 2 | `experiences/:id`、`episodes/:id` 只读路由 + service 辅助方法 | `src/index.ts`、`src/service.ts`（或 `src/web/node-detail.ts`） |
| 3 | 页面数据适配层（Scene → 渲染模型、边分类、详情拼装） | `src/web/scene-page-app.ts` |
| 4 | 页面 HTML（Canvas2D 3D 投影、交互、HUD、详情面板、空态） | `src/web/scene-page.ts` |
| 5 | 注册页面路由 `/memory-sea/scene` | `src/index.ts` |
| 6 | 测试（6 组） + `scripts/verify-stage6.mjs` | `tests/scene-web.test.ts`、`scripts/verify-stage6.mjs` |
| 7 | 文档（README/IMPLEMENTATION_STATUS）+ 真实宿主截图 | `README.md`、`IMPLEMENTATION_STATUS.md`、`docs/` |

预计新增 ~1,200 行（页面 ~700、适配层 ~200、路由/服务 ~150、测试 ~150），不改任何既有数据模型与 migration。

---

## 8. 风险与限制

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 宿主无静态托管 | 页面只能内联字符串 | 单文件、无外链；如体积影响可读性可拆分常量模块但仍内联输出 |
| 端口不稳定 | 61505 只是当前值 | 页面同源相对路径；脚本必须传端口 |
| 312 个 Experience 同屏 | 标签重叠、性能 | LOD 标签 + 点尺寸按相机距离 + 只对 episode 常显 |
| 该 scope Memory 为 0 | 用户可能误判"没有 Memory" | 空态解释 + scope 切换器（默认 scope 无 Memory，其他 scope 有） |
| Episode 摘要含代码/路径 | 详情面板观感差 | 面板原样展示并标注"摘要来自自动整理"；不影响节点渲染 |
| 热重载残留实例 | 新旧实例路由竞争（历史问题） | 验收前完整重启宿主 |

---

## 9. 需要批准的事项

1. **技术选型 A**：Canvas2D + 手写 3D 投影（零依赖、单文件内联），不引入 three.js/WebGL。
2. **接口增量**：`scene?scope=`、`experiences/:id`、`episodes/:id` 三个只读能力（不改数据模型、不加写 HTTP）。
3. **入口路由**：`GET /memory-sea/scene`（若宿主冲突则回退 `/api/memory-sea/ui`）。
4. **第一版不展示** Skill Candidate / 审核状态 / Pattern（Pattern 数据保留但默认过滤）。

批准后按 §7 顺序实现；未批准前不写生产代码。
