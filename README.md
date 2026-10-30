# 3D Memory Sea V0.2

DeepSeek（Cordis）插件形式的**认知记忆系统**：`Experience → Episode → Consolidation → Semantic Memory → Pattern → Hybrid Recall`。

不是聊天记录插件：原始经历（Experience）是不可覆盖的证据，连续经历自动收束成 Episode，
Episode 关闭后由**持久化后台任务**补上摘要，再整理成带证据的 Semantic Memory（一段经历说明了什么），
召回同时检索 Episode 与 Memory 且永远带 `reasons`（为什么被想起），
并保留给现有 `3d-memory-sea` 前端的兼容 Scene 接口。

```
DeepSeek 会话事件
      ↓  capture（同步快路径，按 scope 隔离）
  Experience（原文不可改写）
      ↓  EpisodeBuilder（session + 时间 + idle 规则）
    Episode ──关闭──▶ EpisodeSweeper ──入队──▶ memory_jobs
      ↓                                              │
  SQLite + FTS5                                  JobRunner
      ↓                                    ├─ episode_summary
      │                                    ├─ episode_embedding
      │                                    ├─ experience_embedding
      │                                    ├─ episode_consolidation（Stage 3）
      │                                    └─ memory_embedding（Stage 3）
      │                                              ├─ memory_pattern_analysis（Stage 4）
      │                                              ├─ pattern_embedding（Stage 4）
      │                                              └─ memory_review（Stage 4）
      │                                              ↓
      │                          Consolidation（规则式 / LLM）
      │                                              ↓
      │                          Semantic Memory + memory_evidence（必须可追溯）
      │                                              ↓
      │                          Pattern Analysis（多条知识共同反映的长期模式）
      │                                              ↓
      │                          Pattern Memory + pattern_evidence（描述性，不可执行）
      ↓                                              ↓
RecallEngine（lexical / semantic / temporal / importance / recency / memory / pattern）
      ↓
Explainable Recall（reasons：keyword / semantic / temporal / importance / confidence / reinforcement / support / stability）
      ↓
MemorySeaService（ctx.memorySea）+ Agent 工具 + 3D Scene
```

## 安装

```bash
npm install          # 只装 devDependencies（typescript、@types/node）
npm run build        # tsc → dist/，并复制 migrations 资产
npm test             # 206 个用例（node:test，真实 SQLite 文件）
npm run smoke        # 端到端冒烟：场景 A–D + 插件入口 + Stage 2/3/4 后台链路
npm run verify       # Stage 2 验收取证：scope 隔离 / Episode 收割 / 语义通道 / 重启恢复 + 性能数字
npm run verify:stage3   # Stage 3：Semantic Memory 认知闭环 + 证据链 + 性能
npm run verify:stage4   # Stage 4：Pattern 认知闭环 + 真实 HTTP 向量通道 + 性能
npm run verify:stage45  # Stage 4.5：弱查询上下文召回 + 参与者隔离 + Episode 连续性 + 性能
npm run verify:stage46  # Stage 4.6：摘要质量八类输入 + 身份审计/dry-run 回填（加 --live 跑宿主库）
node scripts/verify-stage4-live.mjs   # Stage 4：写入宿主真实数据库，再用活实例 HTTP 读回
```

作为插件安装进 DeepSeek Desktop（desktop profile）：

```bash
# 在 Harness 里：
plugin_manager action=install_bundle target=<本目录绝对路径>
```

`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后会把
`3d-memory-sea` 挂进插件列表并调用 `apply(ctx, config)`。改完代码后：

```bash
npm run build
# plugin_manager: set_bundle enabled=false 再 set_bundle enabled=true（热替换 dist）
```

运行时**零第三方依赖**：数据库用 Node 24 内置的 `node:sqlite`（要求 Node >= 22.5）。

## Scope（按项目隔离）

记忆按 **scope** 隔离，scope id 由「规范化后的项目绝对路径」哈希得到（`project_<sha256 前16位>`），
因此 Windows 下大小写、分隔符、末尾斜杠都不会产生不同 scope，重装插件也不会失忆。

解析优先级：`session.header.cwd` → `session.cwd` → session metadata 的 cwd/projectRoot → 配置的 `scope.rootPath` → 宿主 cwd 兜底。

- 同一个 session 的事件自动落到该 session 的 workspace scope；
- 工具调用用 `exec.agent.id` 反查 session→scope；
- 召回**不会**跨项目（`global` 类型只预留）。

## 配置

默认数据库：`$DSH_HOME/3d-memory-sea/memory-sea.db`（`DSH_MEMORY_SEA_DB` 可覆盖）。

```yaml
enabled: true
databasePath: ~/.dsh/3d-memory-sea/memory-sea.db
scope: { type: project, rootPath: ~/code/my-project }   # 可省略 rootPath，运行时按 session 推导

capture:
  enabled: true
  userMessages: true
  assistantMessages: true
  toolResults: true
  episodeIdleMs: 1200000        # 20 分钟；也可写 episode.idleMs

episode:                        # Episode 生命周期（spec §45）
  idleMs: 1200000
  sweepIntervalMs: 60000

recall:
  maxResults: 8
  lexicalWeight: 0.45
  semanticWeight: 0.25
  temporalWeight: 0.12
  importanceWeight: 0.10
  recencyWeight: 0.08
  expandEpisodes: false          # true → Memory 展开证据 Episode、Episode 展开代表 Experience

embedding:                       # 不配 provider/model/apiKey 时自动 Noop
  enabled: true
  provider: openai-compatible
  baseUrl: https://api.example.com/v1
  apiKey: ${DSH_MEMORY_SEA_EMBEDDING_API_KEY}
  model: text-embedding-3-small
  dimensions: 1536
  timeoutMs: 15000

summary:                         # 不配 endpoint/model 时用抽取式摘要
  enabled: true
  provider: llm                  # llm | extractive
  endpoint: https://api.example.com/v1
  apiKey: ${DSH_MEMORY_SEA_SUMMARY_API_KEY}
  model: gpt-4o-mini

consolidation:                   # Stage 3：Episode → Semantic Memory
  enabled: true
  provider: rule-based           # rule-based | llm
  maxRelatedEpisodes: 8
  maxRelatedMemories: 12
  minConfidence: 0.5
  autoSupersede: true            # 只有明确「迁移/改为/不再使用」才取代
  requireMultipleEvidenceForPreference: true
  # provider=llm 时还需要：endpoint / apiKey / model

pattern:                         # Stage 4：Semantic Memory → Pattern Memory
  enabled: true
  provider: rule                 # rule | llm
  minSupport: 3                  # 至少几条独立知识才算「反复出现的模式」
  activationThreshold: 0.7       # candidate → active 的置信度门槛
  maxRelatedMemories: 12
  maxExistingPatterns: 8
  confidenceDecayOnContradiction: 0.1
  # provider=llm 时还需要：endpoint / apiKey / model（缺配置自动降级规则式）

review:                          # Stage 4：陈旧知识复核（stale ≠ 错误 ≠ superseded）
  enabled: true
  intervalMs: 21600000           # 6h
  memoryStaleAfterMs: 15552000000  # 180 天未强化才进入复核队列
  patternStaleAfterMs: 7776000000  # 90 天
  maxItemsPerRun: 20
  memoryStaleConfidence: 0.95    # 低于该置信度的久置知识才允许标 stale

background:                      # 也可以写 jobs.*（spec §44 两种命名都接受）
  enabled: true
  pollIntervalMs: 5000
  maxJobsPerTick: 8
  staleJobTimeoutMs: 60000
  maxAttempts: 3

contextualRecall:                # Stage 4.5：弱查询（主播好 / 嗯 / 然后呢）的上下文召回
  enabled: true
  maxCandidates: 5               # 只从「该 actor 的近期记忆」里取少量候选，不扫全库
  weakQueryMaxLength: 6          # 长度 ≤ 6 视为弱查询
  returningActorBoost: 1.25
  recentMemoryWindowMs: 1814400000  # 21 天

episodeContinuity:               # Stage 4.5：Episode 碎片 → 关系链（只 Link，不 Merge）
  enabled: true
  lookbackMs: 2592000000         # 只在 30 天内找候选
  maxCandidates: 10
  minConfidence: 0.45            # 低于该置信度不建关系
  maxExpansionDepth: 2           # expandContinuity 时每方向最多展开几个

scene:
  maxPoints: 4000
```

环境变量别名：`DSH_MEMORY_SEA_EMBEDDING_API_KEY`、`DSH_MEMORY_SEA_EMBEDDING_BASE_URL`、
`DSH_MEMORY_SEA_SUMMARY_ENDPOINT/API_KEY/MODEL`、`DSH_MEMORY_SEA_CONSOLIDATION_ENDPOINT/API_KEY/MODEL`、
`DSH_MEMORY_SEA_PATTERN_ENDPOINT/API_KEY/MODEL`（缺省回退到 consolidation 的同名变量）、`DSH_MEMORY_SEA_ROOT`。

降级承诺：

- semantic 不可用 → 其余四路权重**自动重新归一化**，召回照常；
- embedding 出错 → 该对象 `embedding_status='failed'`，召回走 lexical；
- FTS 不可用 → 自动降级 `LIKE`；
- 摘要失败 → Episode 照常关闭，`summary_status='failed'`；
- 整理失败 → Episode 照常 `closed`，`consolidation_status='failed'`，任务按退避重试；
- 模式分析失败/证据不足 → 不产出 Pattern（`noop`），绝不因为「想总结」而编造模式；
- Memory Sea 整体故障 → 记录 + 返回可处理异常，不影响宿主。

## 数据位置（记忆存在哪个文件夹 / 怎么换）

**默认位置**：`$DSH_HOME/3d-memory-sea/memory-sea.db`
在本机（desktop profile）就是 `C:\Users\Administrator\.dsh\3d-memory-sea\memory-sea.db`，同目录下还会有 SQLite 的 `-wal` / `-shm` 伴随文件。

### 查看当前路径

三种方式都可以，读到的是同一份真实路径：

1. 页面右上「设置」面板 → 「数据位置」一行（只读展示）；
2. `GET /api/memory-sea/status` 的 `databasePath` 字段；
3. `GET /api/memory-sea/health` 也会带 `databasePath`。

### 改成自定义位置

配置解析优先级：插件 `config.databasePath` → 环境变量 `DSH_MEMORY_SEA_DB` → 默认 `$DSH_HOME/3d-memory-sea/memory-sea.db`。

**方式 A（推荐）**：在 profile 的 `cordis.patch.yml` 里按插件 id 覆盖 config（`C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml`）：

```yaml
- id: 3d-memory-sea
  config:
    databasePath: 'D:/MemorySea/memory-sea.db'
```

**方式 B**：设置环境变量 `DSH_MEMORY_SEA_DB=D:\MemorySea\memory-sea.db` 后重启 DeepSeek。

路径写法：支持绝对路径与 `~` 展开；相对路径以宿主进程工作目录为基准，**建议一律用绝对路径**。目录不存在时会自动创建。

### 迁移已有记忆到新位置

1. 完全退出 DeepSeek（不是关窗口，要退出进程，确保 WAL 已落盘）；
2. 整目录拷贝旧库：`C:\Users\Administrator\.dsh\3d-memory-sea\`（含 `-wal`/`-shm`）→ 新目录，例如 `D:\MemorySea\`；
3. 改上面的 `config.databasePath`（或环境变量）；
4. 启动 DeepSeek，打开 `/memory-sea/atlas`，设置面板「数据位置」应显示新路径，底部节点数与迁移前一致（本机当前为 316 个节点 / 312 条边，会随使用增长）。

注意：改路径必须**完整重启**才生效（热重载不会重新打开数据库）；Live Agent 不写死路径，它通过 `ctx.memorySea` 取数据，会自动跟随新位置。

## Stage 3：Semantic Memory 是怎么产生的

```
Episode（closed + summary ready）
   ↓  enqueue episode_consolidation（持久化 job）
Candidate Discovery（同 scope：topics + bigram + 时间 + Memory FTS + evidence 反查）
   ↓
Consolidator（默认规则式，可切 LLM）→ 操作数组：create / reinforce / update / supersede / contradict / noop
   ↓  整批一个事务
ConsolidationApplier（dedup → 证据唯一键 → 幂等；supersede 必须先立后废）
   ↓
Semantic Memory + memory_evidence（derived_from / supports / contradicts / supersedes）
```

- **创建门槛**：明确 decision/preference/goal/constraint，或多段 Episode 支持，或单段 Episode 重要度极高；
  编译输出、打开文件、`npm test` 这类噪音在候选阶段就被过滤 → `noop`。
- **强化**：同一知识再次被支持时只加证据与计数、提升置信度，不产生重复知识。
- **取代**：只有明确时间变化措辞（迁移/改为/不再使用…）才 supersede，旧知识 `status='superseded'` 且 `supersededBy` 指向新知识。
- **冲突**：无法判断新旧时只记 `contradicts` 并降置信度，不自动取代。
- **无 LLM 也能跑**：规则式整理是默认且完整可用；`consolidation.provider=llm` 是增强项，失败自动回退。

## Stage 4：Pattern 是怎么产生的

```
Semantic Memory（多条独立知识）
   ↓  enqueue memory_pattern_analysis（整理产出知识后自动触发，后台执行）
Candidate Discovery（同 scope：FTS/bigram + 概念层 + 已有证据 + 已有模式家族）
   ↓
PatternAnalyzer（规则式：概念层识别结构相似；或 LLM，失败自动回退规则式）
   ↓  结构化操作：create / reinforce / weaken / supersede / noop
PatternApplier（事务 + 幂等：证据唯一键 + 批内 touched 去重）
   ↓
Pattern Memory（candidate → active → weakened → stale；历史永不删除）
   ↓  pattern_evidence 指向 Semantic Memory（不是原始 Experience）
Pattern-aware Recall / Scene / memory_inspect
```

几条硬规则：

- **Pattern 不得来自单个 Memory**：至少 2 个独立 Semantic Memory 支持（默认 3 个才 `active`）。
- **Pattern 是描述性知识**：「该项目在早期架构决策中持续倾向避免过早引入额外基础设施」可以，
  「用户是保守的人」「以后选数据库自动选 SQLite」禁止 —— 后者是 Skill，Stage 4 不实现。
- **一次例外不摧毁模式**：新反证只 `weaken`（降置信度 + 计矛盾数）；只有明确的长期趋势改变且新模式有 ≥2 支持才 `supersede`，且先立后废。
- **查询意图决定模式是否靠前**：问「我们架构上一直有什么倾向」→ Pattern 第一；问「为什么 V0.2 先用 SQLite」→ 具体 Memory 第一。
- **陈旧只是陈旧**：久未强化的知识标 `stale`（可复核恢复），不删、不当作错误；只有明确新证据才 `superseded`。

## Stage 4.5：短查询召回 + Episode 连续性

直播/实时场景暴露两个召回问题：低信息量输入（「主播好」）召不回关键记忆；同一人的经历被 idle 切碎，跨场次断链。Stage 4.5 只做 retrieval / continuity 加固，**不进入 Skill**。

```text
主播好（weak query）+ 回访观众 + actor scope
   ↓ ShortQueryDetector（无 LLM：长度 / 问候 / 确认 / 代词 / 续接）
   ↓ ContextualRecall（不按文本检索：该 actor 的近期 Memory / Episode）
   命中「我下周要复试」+ reasons: continuation / context / temporal / confidence

Session1 我下周复试 → Session2 专业课差不多了 → Session3 今天复试完了
   ↓ episode_continuity（后台 job）
episode_relations：A --continues--> B --continues/followup--> C
   ↓ expandContinuity:true
召回中段 Episode 时，自动带出前后片段（仍是 Episode，不合并）
```

几条硬规则：

- **不改写 query**：弱查询只触发「按 actor / 时间 / 重要性取候选」，绝不把「主播好」猜成「想聊复试」。
- **无 actor 不召回**：「你好」在没有 actor 上下文时返回 0 命中，宁可空也不随机召回重要记忆。
- **actor 不越 scope**：上下文只在已解析的 `scope_id` 内过滤；不同观众各自隔离（live-agent 用 `live_<platform>_<channelHash>_v_<viewerId>` 做观众 scope）。
- **只 Link 不 Merge**：Episodes 的 summary/title/Experience 一律不回写，连续性只加关系。
- **关系不是证据**：`episode_relations` 与 `memory_evidence` 互不写入；连续性只影响召回展开与 inspect 展示。
- **保守连边**：同参与者但话题不同最多 `same_thread`；只有「同参与者 + 实质关联 + 7 天内（或计划接续）」才 `continues`；Scene 只画 `continues/followup`。

## Stage 4.6：摘要质量与身份连续性

工具/代码密集的会话曾是摘要质量的黑洞：整段多行输出被当成一句话，摘要里出现文件路径与编译日志。

现在的处理：

```text
Experience 原文（不可改）
   ↓ stripRuntimeLines + stripMachineLines（行级剔除宿主流 / 日志 / 路径 / 代码行）
   ↓ scoreSentence：决定 / 目标 / 偏好 / 约束句 +0.9，第一人称 +0.2
   ↓ assessSummaryQuality → good | fair | poor（+ flags）
Episode.title / summary（派生数据，可后台重算）
```

- 没有可靠人话时明确回退：`title='一段经历'`、`summary=''`、`grade='poor'`，不编造。
- `memory_inspect` 的 Episode 输出会带一行 `摘要质量：good 1.00`。
- 低质量可以重排：`requeueLowQualitySummaries(scope, { dryRun })`（默认 dry-run，只入队后台 job）。

身份连续性（跨 Session）：

```text
actorId     = act_<sha256(platform:platformUserId)[0..16]>   # 跨 Session 稳定
threadKey   = 一次连续互动的线程（Live Agent Episode Policy 决定）
sessionId   = 一次 Session
scopeId     = 记忆隔离硬边界
nickname    = 可变展示字段，永不参与身份
```

- 优先级：`actorId` > `platformUserId + platform` > `viewerId`（弱身份，只能出 `same_thread`）；昵称不参与。
- 缺少可靠 ID → 记为 `missing`，不猜、不合并；不同平台默认不合并。
- 历史回填 `normalizeActorMetadata(scope, { dryRun })`：只补 `metadata_json.actorId`，
  幂等、可重复、绝不改 Experience 原文与 Evidence。

两条只读调试接口（没有写操作）：

- `GET /api/memory-sea/summary-quality?scope=&limit=` → 分布 + 明细
- `GET /api/memory-sea/actor-identity?scope=&limit=` → 身份审计分类计数

## Stage 5 Phase 2：人工审核入口

候选的「审核」不是执行许可，只是一次可审计的描述验收。写入路径全部走本机操作者令牌：

```bash
TOKEN=$(cat ~/.dsh/3d-memory-sea/operator-token)

# 只读：候选详情（含成熟度、独立样本、Wilson 区间）
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:PORT/api/memory-sea/operator/candidates?scope=project_xxx'

# 提交审核（reviewer 由令牌派生，不接受请求体伪造）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"描述清晰"}' \
  'http://127.0.0.1:PORT/api/memory-sea/operator/candidates/skc_xxx/submit?scope=project_xxx'

# 批准描述（不等于已验证有效，也不产生任何执行）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve","versionId":"skv_xxx","reason":"措辞与证据一致"}' \
  'http://127.0.0.1:PORT/api/memory-sea/operator/candidates/skc_xxx/review?scope=project_xxx'
```

硬规则：`validated` 必须来自真实 Attempt（独立样本 ≥5、至少 1 次 direct、成功率 ≥0.5）；批准只改状态；
编辑 Procedure 永远开新版本，新版本不继承旧批准；来源变化只标记 `provenance_changed` 并重新评估。

## Stage 5 Phase 1：Skill Candidate 是怎么产生的

Phase 1 的目标不是「让 Agent 学会做事」，而是把**反复出现的模式**变成一份可审核、可证伪的描述。

```text
active Pattern（supportCount ≥ 3、confidence ≥ 0.5）
        ↓  SkillService.ensureCandidateForPattern()
Skill Candidate（drafting）+ v1 Procedure Draft（由支持 Memory 派生，默认没有成功标准）
        ↓  createVersion()（人工补充成功标准与证据引用）
Skill Candidate Version（不可变，旧版本永不覆盖）
        ↓  recordAttempt() / completeAttempt()（真实发生的尝试 + OutcomeEvidence）
独立证据折叠（按 scope + 原始 id 去重，同 Episode 不重复计数）
        ↓
成熟度：insufficient → structural_only → observed → validated
        ↓
submitForReview() → review(approve/reject/request_changes)（需要可审计 reviewer）
        ↓
批准 = 接受这份描述；**不执行任何步骤**
```

硬规则：

1. Candidate 不能凭空产生：必须有 active Pattern、至少 3 条支持 Memory、至少 2 个独立 Episode。
2. 版本只追加：新版本不修改旧版本，历史永远可回看。
3. 没有预定义成功标准时，`success` / `failure` 会被降级为 `inconclusive`，不报告成功率。
4. `inferred` 尝试不算验证；`unknown` / `inconclusive` 不进分母。
5. 审核必须有可审计身份，审核记录 append-only。
6. Phase 1 没有任何执行能力：`SkillService` 上不存在 `execute / run / invoke / apply`。

只读查询：

```bash
curl 'http://127.0.0.1:58043/api/memory-sea/skill-candidates?limit=10'
curl 'http://127.0.0.1:58043/api/memory-sea/skill-candidates/skc_xxx'
curl 'http://127.0.0.1:58043/api/memory-sea/skill-attempts/ska_xxx/evidence'
```

### 嵌入 DeepSeek 界面（Stage 6 客户端半端）

- 左侧栏出现「记忆海」入口，点击后主区域整页渲染 3D 页面（`memory-sea` 面板 key 与侧栏 id 同名）。
- 客户端半端：`assets/client/memory-sea-client.js` → 构建产物 `dist/client/memory-sea-client.js`，由 `package.json` 的
  `exports["./client"]` 与 `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-runtime"], immediately: true }` 声明。
- 宿主契约三件套（缺一会静默跳过、不报错）：`exports["./package.json"]` + `dsh.client` + 用 `slots.inject(slot, () => slots.register(...))` 包裹注册。
- 改动客户端半端后必须**完整重启 DeepSeek**（页面刷新只会重跑旧启动图）。

## Stage 6：3D Memory Sea 页面（只读）

**当前视觉方向：A · 深空摄影风**。背景使用低饱和蓝灰色银河尘埃与确定性星点，取消高饱和霓虹丝带，节点发光与 HUD 都更克制。改造记录见 [`docs/STAGE6_VISUAL_REDESIGN_A.md`](docs/STAGE6_VISUAL_REDESIGN_A.md)。

后端已经有 4 类对象（Experience / Episode / Semantic Memory / Pattern），但在此之前只有旧版
`legacy/` 里的静态页面能看。Stage 6 提供由插件自己托管的交互式 3D 页面，**数据全部来自 `/api/memory-sea/scene`
与节点详情接口，不读 SQLite、不伪造节点、不写任何数据**。

页面地址（端口就是宿主 DeepSeek 的 Web 端口，会随重启变化）：

```text
http://127.0.0.1:<宿主端口>/memory-sea/scene
回退地址（如果上面的路径被宿主占用）：http://127.0.0.1:<宿主端口>/api/memory-sea/ui
```

页面能力：

- 真正的三维渲染：Canvas 2D + 手写 yaw/pitch 旋转、透视投影、按深度远→近绘制与尺寸衰减；拖拽旋转、滚轮缩放、双击复位、`R` 复位 / `F` 聚焦选中 / `Esc` 取消。
- 节点选择与详情面板：Experience 显示原文、角色、时间、重要性、所属 Episode；Episode 显示摘要、成员经历预览（≤240 字）、证据 Memory、前后连续性片段；Memory / Pattern 显示置信度、支持度、证据链入口。详情里所有 `id` 都能继续点开。
- 搜索与类型过滤：按文本过滤节点，四类节点可分别开关（体验 / 连续经历 / 长期记忆 / 模式）。
- Scope 选择：`/api/memory-sea/scopes` 列出的 scope 可切换，页面按 `?scope=` 拉取；未知 scope 后端返回 404，不会静默回落到默认 scope。
- 空数据如实呈现：Memory 数量为 0 时就是 0（`stats.memories=0`），页面显示空态而不是编造节点。
- 自包含：HTML / CSS / JS 全部内联在一个响应里（36KB 左右），不引用任何 CDN 或外部资源，不发写请求。

技术选择（依据 `docs/STAGE6_PHASE1_DESIGN_REVIEW.md`）：沿用 legacy 前端已验证的「Canvas2D + 手写三维投影」路线，
**不引入 three.js 或任何新增运行时依赖**，插件仍然是零运行时依赖。

数据来源映射：

| 页面元素 | 数据来源 |
| --- | --- |
| Experience 小节点 | `experiences` 表（真实 Experience） |
| Episode 中节点 | `episodes` 表（真实 Episode，带 `experienceCount`） |
| Memory 大节点 | `memories` 表（active/superseded 都来自真实记录） |
| `contains` 边 | `episode_experiences` 关联（经历归属） |
| `derived_from` / `supports` 边 | `memory_evidence`（Memory 的证据） |
| `continues` / `followup` 边 | `episode_relations`（Episode 连续性） |
| 节点位置 | `scene-builder` 的稳定伪随机布局（同一数据刷新后位置不变） |

Stage 6 新增的只读能力（没有新增写 HTTP）：

- `GET /api/memory-sea/scene?scope=` / `status?scope=` / `health?scope=` / `legacy-scene?scope=` —— scope 必须是已知 scope，否则 404 `{ok:false,error:'unknown scope'}`。
- `GET /api/memory-sea/experiences/<id>?scope=` —— Experience 原文 + 所属 Episode。
- `GET /api/memory-sea/episodes/<id>?scope=` —— Episode + 成员经历预览 + 证据 Memory + 连续性（原来的 `/episodes/<id>/continuity` 保持可用）。
- `GET /memory-sea/scene`（页面）与回退 `GET /api/memory-sea/ui`。

验收脚本（不写数据，只读校验页面/契约/Scope/详情/空数据/只读边界）：

```bash
npm run build
node scripts/verify-stage6.mjs --port <宿主端口>
# 或者 DSH_WEB_URL=http://127.0.0.1:<端口> node scripts/verify-stage6.mjs
```

截图证据（历史 Stage 6 首版真实宿主 61505，headless Chromium 实测；这些 PNG 不是本轮 A 视觉的最新截图）：

- `docs/stage6-scene.png` — 首屏：312 Experience + 4 Episode + 312 `contains` 边，状态栏显示节点/边计数。
- `docs/stage6-scene-selected.png` — 点击画布节点后右侧详情面板：节点 ID、时间、重要性、激活度、来源、角色、
  完整正文（按需从 `/api/memory-sea/experiences/<id>` 读取）、以及可点击的「所属经历片段」chip。
- `docs/stage6-scene-rotated.png` — 拖拽旋转 + 滚轮缩放后的同一场景（相机真的在动，不是静态图）。

已知限制：

- 页面是只读，没有编辑 / 删除 / 打标签等写操作（写入口仍然只有 Service 与后台任务）。
- 3D 采用 Canvas2D 投影而非 WebGL，节点量级到几千时仍可交互，但更大规模需要分页或 LOD。
- 宿主热重载不会 dispose 旧插件实例；如果同一路径由旧实例先响应（缺少 `scopeId` / 详情路由 404），需要完整重启 DeepSeek 后再验收。

## Stage 7：全景星图（All Scopes）

默认进入「全景」模式：把**所有已知 Scope** 的真实 Experience / Episode / Semantic Memory / Pattern 画在同一片星海里；需要深挖某个项目时切回「单 Scope」模式。两种模式共用同一套详情面板。

数据完全来自后端真实 Scene，没有 Mock、没有静态图、也不会把多个 Scope 合成一个数据库：

- 后端逐 Scope 调真实的 Scene 构建（与单 Scope 页面用的是同一个 `SceneBuilder`），再聚合。
- 节点全局 id 是 `<scopeId>::<原始 id>`；边只在本 Scope 内部重映射端点，**不会因为文本相似/同一个人/同一画面自动生成跨 Scope 关系**。
- 某个 Scope 读取失败时，响应里 `complete=false` 且 `failures[]` 会写清是哪个 Scope、为什么失败；页面状态条同时标红，绝不把部分数据当成完整全景。
- 只读：没有任何写接口、没有把 Skill 候选或审核状态放进星图。

```bash
# 全景（默认全部 scope）
curl -s http://127.0.0.1:<port>/api/memory-sea/global-scene | head -c 400
# 只看某几个 scope（逗号分隔）
curl -s "http://127.0.0.1:<port>/api/memory-sea/global-scene?scopes=project_4ac392fdccfaa5c0,project_1b1a0fab281b0678" | head -c 400
# 页面
open http://127.0.0.1:<port>/memory-sea/atlas
```

响应结构（节选）：

```jsonc
{
  "ok": true,
  "points": [{ "id": "project_xxx::xp_yyy", "scopeId": "project_xxx", "originalId": "xp_yyy", "type": "experience", "x": 1.2, "y": -3.4, "z": 5.6, "...": "..." }],
  "edges": [{ "a": "project_xxx::ep_1", "b": "project_xxx::xp_yyy", "kind": "contains", "reason": "这段经历归属于该段连续经历", "scopeId": "project_xxx" }],
  "scopes": [{ "scopeId": "project_xxx", "points": 316, "edges": 312, "experiences": 312, "episodes": 4, "memories": 0, "patterns": 0 }],
  "stats": { "experiences": 3014, "episodes": 74, "memories": 47, "patterns": 4, "scopes": 11, "loadedScopes": 11, "nodeTotal": 3139 },
  "failures": [],
  "complete": true,
  "builtAt": 1793300000000
}
```

页面能力：模式切换（全景 / 单 Scope）、Scope 多选过滤、四类节点开关（带实时计数）、搜索、刷新、复位、聚焦选中、拖拽旋转、滚轮缩放、单击看详情（Experience 全文 / Episode 成员预览与证据 / Memory / Pattern + 所属 Scope + 连续性）。视觉仍是 A4 黑底关系网络：经历是小白点、连续经历是青色节点、长期记忆是绿色核心、模式是琥珀色结构。

真实宿主验收：`node scripts/verify-stage7.mjs --port <port>`（未给端口会自动探测），检查 32 项（聚合计数、命名空间 id、边端点不跨 scope、每条边有 reason、`?scopes=` 过滤、未知 scope 显式失败、页面自包含且无写请求、POST 不改变数据）。

## Stage 7.1：全景关系线为什么之前看不见

边从来没有丢：全景聚合后 3144 条边端点全部匹配、无跨 scope、无悬空。看不见是三个问题：

1. **统计口径**：`SceneStats.relations` 只统计 Episode 连续性（19），不含 `derived_from`/`supported_by`；现在按真实边统计（101），每 scope 也各带 `relations`。
2. **全叠在一个原点**：11 个 scope 原本共用同一片坐标，节点叠成毛球。现在每个 scope 的布局压缩到相近体量后放到薄球壳上（只动视图坐标），聚类中心标 scope 短 id。
3. **取景太远/太近**：球壳中心是空的，原来放大只会钻进空白；现在按最远真实节点取景，一屏看全 11 个 scope。

另外做了两件事让关系真正「看得见」：**缩略层级**（镜头很远时先只画 Episode / 长期记忆 / 模式，约 124 个语义节点，放大后 Experience 全部出现，底部统计始终是真实总数）和**关系两条叠加层**（柔光 + 亮芯，只画真实非 contains 边）。`contains` 的浓淡随镜头变化，远景不糊成白云。

验证：`node scripts/diagnose-global-edges.mjs --port <port>`（逐 scope 边统计 / 聚合前后 / 端点匹配 / 去重 / 关系统计口径）；真实库全景 3291 节点 / 3246 边 / 关系 101。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `memory_remember` | Agent 主动记录用户明确要求记住的内容。参数 `content`、`importance?`、`metadata?`。**仍然只写 Experience**。 |
| `memory_recall` | 参数 `query`、`limit?`、`before?`、`after?`、`includeSuperseded?`。同时检索 Experience / Episode / **Memory / Pattern**，返回内容、时间、类型、score、展开的证据、以及「为什么召回」（含置信度/强化/支持数/稳定度）。 |
| `memory_skill_status` | 列出 Skill 候选与成熟度（只读；Phase 1 不允许执行） |
| `memory_skill_inspect` | 查看候选 / 版本 / 尝试 / 审核 / 证据链（只读） |
| `memory_inspect` | 参数 `id`。Experience → 所属 Episode + 同 Episode 其他经历；Episode → 全部原始 Experience + **前后连续性片段（Stage 4.5，不是证据）**；Memory → 证据 Episode → 原始 Experience；**Pattern → 支持/反证知识 → 再下钻到 Episode → Experience**（完整证据链）+ supersededBy + 向量元数据。 |

其他插件可以直接调用 Service（`ctx.get('memorySea')` 或注入 `'memorySea'`）：

```ts
await memorySea.capture({ sourceType: 'manual', content: '...' }, { rootPath: '/path/to/project' })
const hits = await memorySea.recallDetailed({ query: 'SQLite 选型', includeSuperseded: true }, { scopeId })
const episode = await memorySea.getEpisode(id)
const inspection = memorySea.inspect(id)          // 证据链（Experience / Episode / Memory）
const memory = memorySea.getMemory(memoryId)      // Stage 3
const memories = memorySea.listMemories({ status: 'active', kind: 'decision' }, { scopeId })
const evidence = memorySea.listMemoryEvidence(memoryId)
const scene = await memorySea.getScene({ scopeId })
const status = memorySea.status({ scopeId })      // 含 jobs / memories / consolidation / patterns / review / embedding
const pattern = memorySea.getPattern(patternId)     // Stage 4
const patterns = memorySea.listPatterns({ status: 'active' }, { scopeId })
const patternEvidence = memorySea.listPatternEvidence(patternId)
await memorySea.consolidateEpisode(episodeId, { scopeId })   // 手动触发整理
await memorySea.runDreamMaintenance({ scopeId })            // 扫一遍漏掉的已关闭 Episode
await memorySea.drainJobs()                                 // 测试/调试：立刻跑一轮后台队列

// Stage 4.5
const hits = await memorySea.recall(
  {
    query: '主播好',
    context: { actorId: 'vwr_xxx', returningActor: true, interactionType: 'greeting' },
    expandContinuity: true,
  },
  { scopeId: liveScopeId },
)
const continuity = memorySea.getEpisodeContinuity(scopeId, episodeId)  // { previous, next }
const relations = memorySea.listEpisodeRelations(scopeId, 100)
const added = memorySea.backfillEpisodeContinuity(scopeId, { maxEpisodes: 20, lookbackDays: 30 })
```

## 数据迁移

| 迁移 | 内容 |
| --- | --- |
| `001_init.sql` | `experiences` / `episodes` / `episode_experiences` |
| `002_fts.sql`（可选） | `experience_fts` / `episode_fts`（FTS5）+ 旧 `embeddings` |
| `003_scope.sql` | Stage 1 数据标 `project_legacy` + scope 索引 |
| `004_episode_lifecycle.sql` | `last_experience_at` / `closed_at` / `closed_reason` / `summary_status` |
| `005_jobs.sql` | `memory_jobs`（持久化后台任务队列，`UNIQUE(type,owner_type,owner_id)`） |
| `006_embedding_versioning.sql`（可选） | `embeddings_v2`（按 provider/model 版本化 + `content_hash`），自动迁移旧表 |
| `007_semantic_memory.sql` | `memories` + `memory_evidence`（证据关系表，PK 去重）+ 索引 |
| `008_memory_fts.sql`（可选） | `memories_fts`（Memory 全文检索；失败降级 LIKE） |
| `009_consolidation_status.sql` | `episodes.consolidation_status`（独立于 Episode 主状态） |
| `010_memory_relations.sql` | `memory_relations`（supports / contradicts / supersedes / related） |
| `011_pattern_memory.sql` | `patterns` + `pattern_evidence`（证据指向 Memory，PK 去重）+ 索引 |
| `012_pattern_fts.sql`（可选） | `patterns_fts`（Pattern 全文检索；失败降级 LIKE） |
| `013_memory_review.sql` | `memories.last_reviewed_at` / `review_status` + 复核 sweep 索引 |
| `014_episode_relations.sql` |
| `015_skill_candidate.sql` | Skill 候选与 Procedure 版本（append-only 版本） |
| `016_skill_attempt.sql` | Attempt 与 OutcomeEvidence（幂等键 + 证据引用） |
| `017_skill_review.sql` | 审核记录（append-only，无 update/delete） | `episode_relations`（Episode 连续性关系，PK(source,target,relation) 幂等）+ `episodes.continuity_status` |

启动时 `backfillScopeIds()` 会把 `project_legacy` 的旧数据按 `scope_root` 回填成精确 scope id（幂等）。

## HTTP（只读，给现有前端/调试用）

- `GET /api/memory-sea/status` — 计数、open/closed Episode、FTS、jobs、embedding、scope、最近错误（支持 `?scope=`）
- `GET /api/memory-sea/scene` — 新 `MemorySeaScene`：`{scopeId, points, edges, stats}`（Episode 节点带 summary/experienceCount；每条边都有 `reason`；支持 `?scope=`）
- `GET /api/memory-sea/experiences/<id>` — Experience 原文 + 所属 Episode（支持 `?scope=`，跨 scope 404）
- `GET /api/memory-sea/episodes/<id>` — Episode + 成员经历预览 + 证据 Memory + 连续性视图（支持 `?scope=`）
- `GET /memory-sea/scene` — Stage 6 的 3D 页面（回退入口 `/api/memory-sea/ui`）
- `GET /api/memory-sea/legacy-scene` — 旧 `3d-memory-sea` 契约：`{ok, name, builtAt, points, edges, stats}`
- `GET /api/memory-sea/scopes` — 已知 scope 与默认 scope
- `GET /api/memory-sea/memories` — Semantic Memory 列表（`scope` / `status` / `kind` / `limit` / `includeSuperseded`）
- `GET /api/memory-sea/memories/<id>` — 单条 Memory + 它的证据（Memory → Episode → Experience）
- `GET /api/memory-sea/patterns` — Pattern 列表（`scope` / `status` / `kind` / `limit` / `includeSuperseded`）
- `GET /api/memory-sea/patterns/<id>` — 单条 Pattern + 支持/反证知识（Pattern → Memory → Episode → Experience）
- `GET /api/memory-sea/episode-relations` — Episode 连续性关系（`scope` / `limit`；`continues` / `followup` / `same_thread` / `same_topic`，带 confidence 与 reason）
- `GET /api/memory-sea/episodes/<id>/continuity` — 单个 Episode 的前后片段（`depth` 默认 2）
- `GET /api/memory-sea/health` — `{ok, status}`

**没有任何写操作 HTTP**：所有写入只能经由插件内部（capture / 后台任务）或 Agent 工具。

旧前端（`public/index.html`）挂在 legacy-scene 上即可，字段语义：
Experience → 小球（chat→`event`、tool/file/web→`fact`、manual→`plan`、diary→`feeling`），
Episode → 大球（`conclusion`，`full` 优先 summary），**Memory → 更大更稳定的核心球（同样映射为 `conclusion`，`topic='memory'`，`full` 优先 Memory 摘要）**，
**Pattern → 最内层最稳定的核心球（`conclusion`，`topic='pattern'`，`cluster='长期模式'`，`weight` 含 supportCount）**。
`contains`、Stage 3 的 `supports/derived_from`、Stage 4 的 `supported_by/contradicted_by`、Stage 4.5 的 `continues/followup/same_thread/same_topic` 关系在旧格式里统一表现为 `edge.kind = 'topic'`。

## 目录

```
src/
├─ index.ts                 插件入口（ctx.provide / 工具 / 事件捕获 / 只读路由）
├─ service.ts               MemorySeaService（唯一对外门面）
├─ config.ts types.ts errors.ts
├─ scope/                   path-normalizer（稳定 scope id）/ scope-resolver（session → scope）
├─ capture/                 capture-manager / message-capture / episode-builder / episode-sweeper
├─ recall/                  recall-engine / lexical / temporal / semantic / fusion / tokenizer
│                           short-query-detector（弱查询判定）/ contextual-recall（actor 上下文候选）
├─ embedding/               provider / noop / openai-compatible / repository
├─ summary/                 episode-summarizer / extractive / llm
├─ memory/                  memory-repository / evidence-repository / normalizer / lifecycle
├─ consolidation/           candidate-finder / rule-based / llm / applier / memory-consolidator
├─ pattern/                 pattern-repository / pattern-evidence-repository / normalizer / lifecycle
├─ pattern-analysis/        candidate-finder / rule-based / llm / analyzer / pattern-applier
├─ review/                  memory-review-service（stale 复核，不重复实现 Consolidation）
├─ continuity/              episode-relation-repository / candidate-finder / continuity-analyzer
├─ dream/                   dream-runner（只发现并入队，不自己跑队列）
├─ jobs/                    job-repository / job-runner
├─ storage/                 database / schema / migrations/*.sql / repositories/*
├─ scene/                   scene-builder / legacy-adapter
├─ web/                      scene-page（内联 HTML）/ scene-page-data（映射与校验）/ client（原生 JS + CSS）
├─ tools/                   remember / recall / inspect-memory / skill-status
└─ util/                    text / stable-random
tests/                      episode-builder / storage / recall / jobs / embedding / summary / pattern-analyzer / review / personal-plan / stage2 / stage3 / stage4 / stage45 / stage46 / stage5 / stage5b / scene-web
```

## 设计约束（不要随意破坏）

1. 原始 `Experience.content` 永不被 LLM 或后续流程改写（Repository 没有更新内容的方法）；`Memory.content` 是派生的，可以被 update / supersede。
2. `Experience ≠ Memory`：每条消息只是原始观察；Semantic Memory 只能由已关闭的 Episode 整理而来，且**必须带 evidence**。
3. Capture 同步快路径：不做 LLM 摘要 / embedding / 实体抽取，全部交给后台任务。
4. 召回必须可解释：`RecallHit.reasons` 至少一条，且带人类可读 detail。
5. 本地优先：SQLite + FTS5，不引入 Neo4j / Qdrant / Redis / Kafka。
6. Memory Sea 故障不得影响宿主：失败只记录 + 抛可处理异常。
7. 前端不重写：新 scene 通过 `legacy-adapter` 兼容旧契约。
8. 后台任务必须可崩溃恢复：状态落库，重启后 reclaim/backfill，而不是只活在内存里。
9. **Evidence before inference**：没有证据不许有知识；reinforce 幂等靠证据唯一键，同一 Episode 整理 N 次结果一致。
10. **Reinforce before duplicate / History before overwrite / Contradiction before guessing**：优先强化旧知识，其次才新建；取代必须先立后废并保留历史；判断不了新旧时只记冲突，不猜。
11. 知识只在后台整理：capture 快路径绝不 await consolidation / LLM / embedding。
12. **Repeated evidence before pattern**：没有 ≥2 条独立 Semantic Memory 支持，不产出 Pattern。
13. **Pattern is descriptive. Skill is executable.**：Pattern 只描述「长期倾向什么」，不含任何可执行动作；Stage 4 没有 `execute()/runSkill()/autoToolCall()/policyApply()`。
14. **Weakening before superseding / Exception before contradiction**：一次例外只 weaken，明确的长期趋势改变才 supersede，且先立后废。
15. Pattern 尺寸与支持数解耦：节点大小 clamp（4–9），证据再多也不无限放大。
16. **Context is not query rewriting**：弱查询不改写、只按 actor/时间/重要性取候选；无 actor 上下文宁可 0 命中。
17. **Link before merge / Relation is not evidence**：Episode 碎片只加关系不改写；`episode_relations` 与 `memory_evidence` 互不写入。
18. **Scene 是只读投影**：页面只消费 `scene` / 详情接口，不读 SQLite、不发写请求、不伪造节点；未知 scope 一律 404。
19. 页面零外部依赖：CSS/JS 内联在 HTML 响应里，不引 CDN；3D 由 Canvas2D + 手写投影完成，不新增运行时依赖。

详见 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)（进度、决策 96 条、已知问题）。
