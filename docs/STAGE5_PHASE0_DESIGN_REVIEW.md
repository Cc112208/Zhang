# Memory Sea Stage 5 — Phase 0 设计评审（Skill Candidate / Procedure / Attempt / Outcome Evidence）

> 本文只做审查与设计，**不包含任何代码改动、migration、配置或依赖**。
> 所有结论都以当前仓库实际代码为准；无法从代码确认的内容在 §10 标记为「假设」。
> 基线：Memory Sea `150/150`、Live Agent `30/30`、Stage 4.6.1 宿主绑定 `15/15 PASS`。

---

## 1. 审查范围与方法

逐文件阅读了以下实现（未依赖旧设计文档推断）：

| 分层 | 文件 |
| --- | --- |
| 类型 | `src/types.ts`（1100+ 行：Episode/Memory/Pattern/Job/Recall/Scene/Status） |
| 存储 | `src/storage/migrations/001..014`、`src/storage/database.ts`、`src/storage/repositories/*` |
| Episode | `src/capture/episode-builder.ts`、`src/capture/episode-sweeper.ts`、`src/storage/repositories/episode-repository.ts` |
| Memory | `src/memory/{memory-repository,evidence-repository,memory-lifecycle}.ts`、`src/consolidation/*` |
| Pattern | `src/pattern/{pattern-repository,pattern-evidence-repository,pattern-lifecycle}.ts`、`src/pattern-analysis/*` |
| Review | `src/review/memory-review-service.ts` |
| Recall | `src/recall/{recall-engine,contextual-recall,fusion}.ts` |
| 后台 | `src/jobs/{job-repository,job-runner}.ts`、`src/dream/dream-runner.ts`、`src/service.ts` |
| 对外 | `src/index.ts`（插件入口/路由）、`src/tools/*` |

检索结论：**全仓库没有任何 `Skill / Procedure / Attempt / Outcome / SuccessCriteria` 概念**——
除 `src/util/text.ts:140` 的宿主提示词过滤词「a skill is a reusable set」外，`grep -rn "skill|procedure|attempt|outcome" src` 无业务命中。
这意味着 Stage 5 是**全新层**，现有对象只能作为「候选来源」，不能冒充执行证据。

---

## 2. 当前证据链审查（八问，逐条给代码位置）

### 2.1 Pattern 如何记录支持证据、反例、置信度与生命周期？

- **证据表**：`pattern_evidence(pattern_id, memory_id, relation, weight, created_at)`，
  `PRIMARY KEY (pattern_id, memory_id, relation)`，`relation ∈ {supports, contradicts}`。
  位置：`src/storage/migrations/011_pattern_memory.sql:63-77`。
- **幂等写入**：`PatternEvidenceRepository.insert()` 用 `INSERT OR IGNORE`（`src/pattern/pattern-evidence-repository.ts:37-53`）；
  `insertMany()` 返回**真正新增**条数（`:59-72`），这个返回值决定 `support_count` 是否增长。
- **计数与置信度**：`patterns.support_count / contradiction_count / confidence / first_observed_at / last_observed_at`
  （`011_pattern_memory.sql:23-35`）；置信度公式 `initialPatternConfidence / reinforcedConfidence / weakenedConfidence`
  （`src/pattern/pattern-lifecycle.ts:87-103`），强化为 `1-(1-c)(1-d)`，永不直接到 1.0。
- **生命周期**：`candidate → active` 门槛 `supportCount >= max(2, minSupport) && confidence >= activationThreshold`
  （`pattern-lifecycle.ts:68-84`）；`weakened` 判定 `confidence < 0.45 || contradictionCount >= max(2, supportCount)`
  （`:106-110`）；Review 侧只做 `active → weakened → stale` 两级降级，且**绝不判定 superseded**
  （`src/review/memory-review-service.ts:1-16` 注释 + 实现）。
- **应用事务**：`PatternApplier.apply()` 一个 `db.transaction` 包住整批 create/reinforce/weaken/supersede/noop，
  单条失败只计数不写半条（`src/pattern-analysis/pattern-applier.ts:83-111`）；`create` 支持者 <2 直接 skip（`:141-145`）。
- **可解释性**：每个 Pattern 都有 `reason` 文本（连续性）与 evidence 行，`memory_inspect` 可下钻。

**结论**：Pattern 有完整「支持 / 反例 / 置信度 / 生命周期」，但它的证据单位是 **Semantic Memory**，
不是「发生过一次执行」。这与 Stage 5 需要的「行为重复 + 执行结果」不是同一类证据。

### 2.2 哪些现有对象可以作为技能候选的来源？

| 来源 | 可用性 | 理由（代码） |
| --- | --- | --- |
| Pattern | ✅ 主来源 | `status='active'`、`support_count>=3`、`kind ∈ {recurring_decision, recurring_solution, recurring_problem, strategy, habit, principle}`；来自多个 Memory，天然是「重复结构」 |
| Semantic Memory | ✅ 辅助来源 | `kind ∈ {decision, constraint, principle, goal, preference}` 本身就是可执行意图（如「本地优先」「先 SQLite 后升级」）；`memory_evidence` 可回到 Episode |
| Episode | ✅ 步骤证据来源 | `summary`（`001_init.sql:40`）+ `experienceIds`（`episode_experiences`）；`episode_relations` 提供跨场次叙事链 |
| Experience | ✅ 最小证据单位 | `source_type ∈ chat|tool|manual|diary|file|web`、`role ∈ user|assistant|system|tool`（`src/types.ts`）；工具结果类 Experience 是唯一可能携带「执行」痕迹的原始数据 |
| Scene / Recall | ❌ | 纯读视图，不能作为证据 |

关键限制：**Pattern 是描述性的**（`pattern-lifecycle.ts:1-10` 文件头明确 "Pattern is descriptive. Skill is executable."），
所以 Pattern 只能回答「反复出现的结构」，不能回答「步骤是什么、做过几次、成功了吗」。

### 2.3 哪些证据能证明「某种行为重复发生」？

可证明到「重复」的现有信号（按强度排序）：

1. **多个独立 Semantic Memory 指向同一结构**：`pattern_evidence` 的 `supports` 行数 = `support_count`，
   每个 memory 由不同 Episode 经 Consolidation 产生 —— 但**不保证独立**（见 2.6）。
2. **多个独立 Episode**：`memory_evidence(evidence_type='episode')`（`007_semantic_memory.sql:52-62`）
   → Episode 1:N Experience（`episode_experiences UNIQUE(experience_id)`，`001_init.sql:63-73`）。
3. **跨场次叙事**：`episode_relations`（`014_episode_relations.sql`）提供 `continues/followup`，
   是「同一件事持续发展」而非「同一动作重复」。
4. **时间跨度**：Pattern `first_observed_at/last_observed_at` → `stabilityScore` 的 `spanFactor`（`pattern-lifecycle.ts:47-53`）。

不能证明的：**重复执行同一过程**。原因：当前没有「过程」对象，也没有「一次执行」对象。

### 2.4 哪些证据能证明「某次实际执行及其结果」？

**当前没有。** 逐条核对：

- Experience 可以记录工具结果（`sourceType='tool'`、`role='tool'`），但：
  - 没有 `attemptId`/`procedureId`/`stepId` 字段（`CaptureInput` 定义在 `src/types.ts`，metadata 是自由 JSON）；
  - 没有「执行前声明的成功标准」对象；
  - 没有「这次执行属于哪个候选版本」的关联。
- `memory_jobs` 记录的是**内部后台任务**（`005_jobs.sql`），不是对外动作尝试。
- `episode_relations` / `memory_evidence` 记录的是叙事与派生关系，不是执行。

**结论**：Stage 5 必须新增 Attempt 与 Outcome Evidence 两层，且必须允许它们**先为空**——
否则候选会因为「没有执行证据」而被误判为无效（违反 "Unknown is not failure"）。

### 2.5 是否已有可复用的执行尝试记录？最小 Atttempt 模型？

无。最小 Attempt 模型（字段级提案见 §5.3）：

```text
Attempt = 一个候选版本在某个 scope、某个时间窗内被实际执行（或观察到被执行）的一次记录
必需的 7 个字段：
  id, scope_id, candidate_id, version_id,
  status ∈ planned|running|completed|aborted,
  result ∈ success|partial_success|failure|unknown|inconclusive,
  started_at / ended_at（ended_at 可为空）
可选：trigger_snapshot、attribution、note、external_key（幂等键）
```

最小性理由：没有 `version_id` 就无法回答「哪一版有效」；没有 `scope_id` 就无法阻止跨项目污染；
没有 `result` 就无法区分 Unknown 与 Failure；没有 `external_key` 就无法去重重复上报。

### 2.6 同一 Experience 被多个 Memory / Episode / Pattern 引用时如何避免重复计算？

现状：**只在行级去重，不在语义级去重**。

- `pattern_evidence` PK 保证同一 `(pattern, memory, relation)` 只一行 → 重复 reinforce 不涨 `support_count`（已正确）。
- 但 `support_count` 数的是 **Memory 条数**，不是 Experience 条数：
  同一个 Episode 的标题句与摘要句在 Stage 3 曾被整理成 2 条 Memory（Stage 3 的 `touched` 集合只拦同批次，
  `src/consolidation/consolidation-applier.ts` 的批内去重），若跨批次产生两条同义 Memory，
  它们会同时成为 Pattern 的 supports → 重复计数。
- 反向查询已有基础：`memory_evidence` 可 `evidence → memories` 双向查（`src/memory/evidence-repository.ts:116-140`）。

Stage 5 需要的独立证据规则（§6.3）：以 **(scope, experience_id)** 为最小不可再分单位，
Episode 级去重时同 Episode 的多个 Experience 只算 1；并区分「派生同义」与「独立观察」。

### 2.7 如何在 Scope 隔离下汇总证据？

- Repository 层普遍以 `scope_id` 单键过滤（如 `scopeWhere(scopeId)`，`src/storage/repositories/*`）。
- **但 `pattern_evidence`、`memory_evidence` 表本身没有 `scope_id` 列**
  （`011_pattern_memory.sql:63-77`、`007_semantic_memory.sql:52-62`），
  scope 只能通过 `pattern_id → patterns.scope_id` / `memory_id → memories.scope_id` 间接推断，DB 层无外键约束。
  这是 Stage 5 需要显式处理的风险：新增表必须自带 `scope_id`，并在写入时校验「证据与候选同 scope」。
- Live Agent 使用的是按观众隔离的独立 scope（`live_<platform>_<channelHash>_v_<viewerHash>`），
  Stage 5 的候选/尝试必须沿用同一 scope 语义，禁止跨 scope 聚合。

### 2.8 Memory 被 supersede 或 stale 后，候选如何保留历史并反映来源变化？

现状（已正确）：supersede 只改 `status/superseded_by/valid_until`，**证据行保留、内容保留**
（`007_semantic_memory.sql` 注释 + `src/consolidation/consolidation-applier.ts`）；recall 用 `includeSuperseded` 才能看到历史。

对 Stage 5 的含义：
- 候选的 `supportingMemoryIds` 必须**固化为快照**（版本内保存），而不是实时 join；
- 同时保留「来源当前状态」派生视图：每个来源 memory 的 `status` 实时读取，
  用于显示「3 个来源里 1 个已 superseded」；
- 旧版本不因来源失效而删除，只降低「有效支持数」（`effectiveSupport`），并允许在 Review 中标记 `provenance_changed`。

---

## 3. ER 图与对象职责

### 3.1 ER 图（新增表以 `+` 标出）

```mermaid
erDiagram
  EXPERIENCES ||--o{ EPISODE_EXPERIENCES : "belongs"
  EPISODES ||--o{ EPISODE_EXPERIENCES : "contains"
  EPISODES ||--o{ MEMORY_EVIDENCE : "supports (evidence_type=episode)"
  MEMORIES ||--o{ MEMORY_EVIDENCE : "has"
  MEMORIES ||--o{ PATTERN_EVIDENCE : "supports/contradicts"
  PATTERNS ||--o{ PATTERN_EVIDENCE : "has"

  PATTERNS ||--o{ SKILL_CANDIDATES : "derives (source_pattern_id)"
  SKILL_CANDIDATES ||--o{ SKILL_CANDIDATE_VERSIONS : "versioned as"
  SKILL_CANDIDATE_VERSIONS ||--o{ SKILL_ATTEMPTS : "attempted as"
  SKILL_ATTEMPTS ||--o{ SKILL_OUTCOME_EVIDENCE : "evidenced by"
  SKILL_CANDIDATES ||--o{ SKILL_REVIEWS : "reviewed by"
  SKILL_CANDIDATE_VERSIONS ||--o{ SKILL_REVIEWS : "about"

  +SKILL_CANDIDATES {
    id TEXT PK
    scope_id TEXT
    source_pattern_id TEXT
    source_memory_ids_json TEXT
    title TEXT
    kind TEXT
    status TEXT
    maturity TEXT
    current_version_id TEXT
    latest_version_no INTEGER
    created_at INTEGER
    updated_at INTEGER
  }
  +SKILL_CANDIDATE_VERSIONS {
    id TEXT PK
    candidate_id TEXT FK
    version_no INTEGER
    parent_version_id TEXT
    procedure_json TEXT
    trigger_json TEXT
    preconditions_json TEXT
    evidence_snapshot_json TEXT
    change_reason TEXT
    status TEXT
    created_at INTEGER
    created_by TEXT
    UNIQUE candidate_id_version_no
  }
  +SKILL_ATTEMPTS {
    id TEXT PK
    scope_id TEXT
    candidate_id TEXT FK
    version_id TEXT FK
    status TEXT
    result TEXT
    attribution TEXT
    external_key TEXT
    started_at INTEGER
    ended_at INTEGER
    note TEXT
    UNIQUE scope_external_key
  }
  +SKILL_OUTCOME_EVIDENCE {
    attempt_id TEXT FK
    evidence_type TEXT
    evidence_id TEXT
    relation TEXT
    weight REAL
    observed_at INTEGER
    PRIMARY KEY attempt_id_evidence_type_evidence_id
  }
  +SKILL_REVIEWS {
    id TEXT PK
    candidate_id TEXT FK
    version_id TEXT FK
    decision TEXT
    reviewer TEXT
    reason TEXT
    created_at INTEGER
  }
```

### 3.2 对象职责与持久化取舍

| 对象 | 职责 | 持久化方式 | 唯一键 | 理由 |
| --- | --- | --- | --- | --- |
| SkillCandidate | 候选身份与总体状态、来源指针、成熟度 | **独立表** | `id`；`UNIQUE(scope_id, source_pattern_id)`（一个 Pattern 默认只派生一个候选，除非 procedure 不同） | 被列表、筛选、审核、跨版本引用，必须可查询 |
| CandidateVersion | 不可变版本快照（procedure/trigger/preconditions/证据快照） | **独立表** | `UNIQUE(candidate_id, version_no)` | 版本是审计单位；attempts 与 reviews 都指向 version |
| ProcedureDraft / ProcedureStep | 步骤序列、每步动作/证据/来源 | **版本内 JSON**（`procedure_json`） | 版本内 `step_no` | 整体读写、不跨版本查询；拆表会产生 4 张稀疏表与大量 join；写入时用 schema 校验（`step_no` 连续、`description` 非空、`evidenceRefs` 必须存在） |
| TriggerCondition / Precondition | 触发与前置条件 | **版本内 JSON** | 版本内 `id` | 同上；条件天然是版本化的 |
| Attempt | 一次真实执行/观察 | **独立表** | `id`；`UNIQUE(scope_id, external_key)` | 按时间/结果/版本查询、会持续增长、需要索引；不能塞 JSON |
| OutcomeEvidence | 尝试与证据的关联（结果来自哪条 Experience/Episode/记忆/人工） | **独立表** | `PRIMARY KEY(attempt_id, evidence_type, evidence_id)` | 需要「这个结果被哪些原始证据支撑/反驳」的双向查询，与 memory_evidence 同构 |
| ReviewRecord | 人工批准/拒绝/修订记录 | **独立表**（append-only） | `id` | 审计要求「谁在何时基于哪一版做了什么决定」；不可覆盖 |

**不建表**：Procedure 的步骤/条件、候选的「证据成熟度明细」——前者版本化 JSON，后者是**派生视图**（实时计算，见 §6.2）。

---

## 4. 状态机与生命周期

### 4.1 SkillCandidate

```text
                    ┌──────────────────────────── evidence 不足仍可创建
                    ▼
              [candidate:drafting]
                    │ 至少 1 个 pattern + 步骤草案
                    ▼
              [candidate:ready_for_review] ──(缺口: 无步骤证据/无 outcome)──┐
                    │ 提交审核                                              │
                    ▼                                                      │
              [in_review] ──(人工要求修订)──► [changes_requested] ──────────┘
                    │ 批准                              │ 拒绝
                    ▼                                  ▼
              [approved] ──(新版本出现)──► [superseded]  [rejected] ──►（可 reopen 为新版本）
                    │
                    └──(来源 Pattern 变 stale / 全部来源 superseded)──► [stale_candidate]（不删除）
```

规则：
- `approved` **只表示接受描述**，没有任何执行入口（`Candidate is not executable Skill`）。
- `superseded` 只发生在「同一候选出现更高版本」；**不删除旧版本**。
- 来源 Pattern 转 `weakened/stale` 时，候选不自动失效，只标记 `provenance_changed` 并降低 `effectiveSupport`，等待 Review。

### 4.2 CandidateVersion

```text
draft → submitted → approved | rejected | superseded(by newer version)
```

- `approved` 版本不可修改；任何内容变化 = 新版本（`parent_version_id` 指向旧版，`change_reason` 必填）。
- `superseded` 的版本仍可被历史 Attempt 引用。

### 4.3 Attempt

```text
planned → running → completed(success|partial_success|failure|unknown|inconclusive)
              └──► aborted（未产生结果，不计入成功率分母）
```

规则：
- 完成后的 Attempt 不可编辑；纠错走「新增一条 attempt + `corrects_attempt_id`」（Phase 2 可加）。
- `aborted`、`unknown`、`inconclusive` **都不计入**失败或成功率。

### 4.4 Evidence 的三种独立性等级（候选成熟度核心）

| 等级 | 定义 | 计入 |
| --- | --- | --- |
| independent | 不同 Episode 且不同 Experience；或不同 Attempt 且不同时间窗 | ✅ |
| derived | 同一 Episode 派生的多条 Memory；同一 Memory 的多条 reinforce | ❌（只算 1） |
| repeated-text | 同句重复叙述（不同 Experience，同一 Episode） | ❌ |

---

## 5. Outcome Evidence 与 Attempt 的关联方案

### 5.1 关联模型

```text
Attempt ──(1:N)── OutcomeEvidence ──(N:1)── Experience | Episode | SemanticMemory | manual
```

- 每条 OutcomeEvidence 必须带 `evidence_type + evidence_id`，可指向原始 Experience（最强）、Episode（次强）、
  Memory（弱，派生）或 `manual`（人在审核界面录入的观察）。
- `relation ∈ {supports, contradicts, partial}`，`weight ∈ [0.1, 1]`，`observed_at` 独立于 `created_at`。
- **禁止把结果写进 Attempt 的 note 就完事**：note 只是补充说明，结果必须有结构化 evidence 行，否则不可计数。

### 5.2 结果类型与判据

| result | 判据 | 计入成功率 |
| --- | --- | --- |
| success | 执行完成，且满足**预先定义的成功标准**，有直接证据 | ✅ 分子/分母 |
| partial_success | 部分步骤完成或结果部分满足标准 | ✅（单独统计，不并入 success） |
| failure | 执行完成但明确未满足标准（或有 contradict 证据） | ✅ 分母 |
| unknown | 没有可判定结果的证据（只观察到尝试发生） | ❌ |
| inconclusive | 有证据但不足以判断（证据冲突、标准缺失、归因不清） | ❌ |

硬规则：**没有预先声明的成功标准（`version.success_criteria`）时，任何 Attempt 不得判定为 success/failure，只能是 unknown 或 inconclusive。**

### 5.3 Attribution（归因）类型与置信度

| attribution | 含义 | 置信度来源 |
| --- | --- | --- |
| `direct` | 结果由同一 Attempt 直接观察（工具输出、命令回执） | 证据 weight；默认 0.9 |
| `user_reported` | 用户明确陈述结果 | 0.6（可被后续证据覆盖） |
| `inferred` | 从文本/LLM 推断（不能当事实） | ≤0.4，且标记 `inferred=true`，不计入成功分母 |
| `none` | 无归因 | 0，只用于显示 |

`attribution` 存在 Attempt 上，`OutcomeEvidence.weight` 用于同一 Attempt 内多证据加权；
**成功率只在 `attribution ∈ {direct, user_reported}` 且 `result ∈ {success, partial_success, failure}` 上计算**。

---

## 6. 候选生成、证据去重与评估规则

### 6.1 Pattern → SkillCandidate 生成门槛

必须同时满足（否则不生成，或只生成 `drafting` 且 `maturity=insufficient`）：

1. `pattern.status ∈ {active, weakened}`（`weakened` 允许，但成熟度降级）；
2. `pattern.support_count >= max(3, config.skill.minSupport)`；
3. 独立 Episode 数 `>= config.skill.minIndependentEpisodes`（默认 2）；
4. `pattern.kind ∈ {recurring_decision, recurring_solution, recurring_problem, strategy, habit, principle}`；
5. `stabilityScore(pattern) >= config.skill.minStability`（默认 0.45，`pattern-lifecycle.ts:56-65`）；
6. **步骤可提取**：Pattern 的 supports 里至少有 2 条 Memory 能给出「动作/约束」语义，
   否则只生成「无步骤候选」（`procedure_json.steps = []`，成熟度 `insufficient`，不可提交审核）。

去重：`UNIQUE(scope_id, source_pattern_id)`；同一 Pattern 若内容结构变化 > 阈值才允许新候选（默认不新建，走新版本）。
另有内容级去重：`normalized(procedure titles + step headings)` 相似度 > 0.85 视为重复候选（沿用 Pattern 的 `0.72` 阈值思路，但更严格）。

### 6.2 证据成熟度（派生，不入库）

```text
maturity = {
  level: 'insufficient' | 'structural_only' | 'observed' | 'validated',
  supportingPatterns: N,
  independentMemories: N,
  independentEpisodes: N,
  attempts: { observed, success, partial, failure, unknown, inconclusive },
  successCriteriaDefined: boolean,
  stepCoverage: 0..1,        // 有证据的步骤 / 总步骤
  missing: string[]          // ['step_2_without_evidence', 'no_success_criteria', 'no_attempts']
}
```

- `insufficient`：没有步骤证据 → 不允许提交审核。
- `structural_only`：步骤有证据但 0 次 Attempt → 可提交审核（人工可批「描述」），但 UI 必须显示「无执行证据」。
- `observed`：≥1 次 Attempt，但标准缺失或结果 unknown → 不可声称有效。
- `validated`：≥`minValidatedAttempts`（默认 3）个独立 success Attempt 且标准事先定义。

### 6.3 独立证据去重规则（新增，必须独立实现）

```text
independenceKey(evidence) =
  evidence_type === 'experience' ? `xp:${scope_id}:${id}`
: evidence_type === 'episode'    ? `ep:${scope_id}:${id}`
: evidence_type === 'memory'     ? `mem:${scope_id}:${id}`
:                                  `manual:${scope_id}:${hash}`
```

计数规则：
1. 先按 `independenceKey` 去重；
2. 再把「属于同一 Episode 的 Experience」折叠成 1 个 Episode 单位（`episode_experiences` 反查）；
3. 再把「同一 Episode 派生的多条 Memory」折叠（`memory_evidence(evidence_type='episode')` 反查）；
4. reinforce 计数**不增加**独立证据数（`reinforcement_count` 只是强度，不是次数）；
5. 同一 Attempt 内重复上报同一 evidence 只算 1（PK 天然保证）。

### 6.4 不当结论禁令

- 分母为 0 或 `attribution` 全为 `inferred` → **不得输出成功率/有效性**，只能输出「未知」。
- `unknown` / `inconclusive` 不得并入 failure（显示为灰色而不是红色）。
- 步骤数 < 2 或 `stepCoverage < 0.5` → 不得标为「Procedure」，只能标「描述性候选」。

---

## 7. 版本管理与人工审核

### 7.1 版本

- 版本 = 不可变快照：`procedure_json`（步骤数组）、`trigger_json`、`preconditions_json`、`evidence_snapshot_json`（来源 id + 当时的 status/confidence）。
- 新版本触发条件（任一）：步骤增删改、trigger/precondition 变化、成功标准变化、证据来源发生 supersede 需要重述。
- `version_no` 单调递增；`parent_version_id` 指向被替代版本；`change_reason` 必填。
- **旧版本永不覆盖**：任何写入都是新行；`approved` 版本只读。

### 7.2 人工审核

- `submitReview(versionId)` → 状态 `in_review`；审核记录 append-only：
  `decision ∈ {approve, reject, request_changes}`，`reviewer` 必填（无用户体系时用显式字符串，见 §10 P4）。
- 批准只写 `approved` + `current_version_id`，**不触发任何工具调用/工作流**（硬约束，测试用例 §8.9）。
- 拒绝可 reopen 为新版本；不允许原地改旧版本。
- 复核到期：来源 Pattern 转 stale、或 `validated` 版本的 Attempt 出现 failure 时，产生 `review_due` 标记（不自动改状态）。

---

## 8. Migration / JobRunner / Service API / 工具设计（本阶段不创建）

### 8.1 新增 migration（编号从 015 起，001–014 immutable）

| 文件 | 表 | 索引 |
| --- | --- | --- |
| `015_skill_candidate.sql` | `skill_candidates`、`skill_candidate_versions` | `(scope_id,status)`、`(scope_id,kind)`、`UNIQUE(scope_id,source_pattern_id)`、`UNIQUE(candidate_id,version_no)` |
| `016_skill_attempt.sql` | `skill_attempts`、`skill_outcome_evidence` | `(scope_id,version_id,started_at)`、`(attempt_id)`、`UNIQUE(scope_id,external_key)`、`PK(attempt_id,evidence_type,evidence_id)` |
| `017_skill_review.sql` | `skill_reviews` | `(candidate_id,created_at)`、`(version_id,decision)` |

注意事项：
- 所有新表**必须自带 `scope_id`**（修正 2.7 的历史弱点），写入前校验「证据 scope == 候选 scope」。
- 不建 FK 级联删除（与现有风格一致：`memory_evidence` 也无 FK）；删除通过状态标记。
- `skill_candidates.source_memory_ids_json` 只存来源指针快照，真正证据走 `skill_outcome_evidence`。

### 8.2 后台 Job 设计（复用 `JobRunner` / `JobRepository`）

| Job type | owner | 触发 | 幂等键 | 失败策略 |
| --- | --- | --- | --- | --- |
| `skill_candidate_discovery` | `pattern` | Pattern 变 active / reinforce 后 | `UNIQUE(type,owner_type,owner_id)`（现有约束） | 继承 `fail()` 指数退避（`job-repository.ts:246-290`），≤3 次 |
| `skill_candidate_reevaluate` | `skill_candidate` | 来源 Pattern 状态变化 / Attempt 完成后 | 同上 | 同上 |
| `skill_attempt_evaluate` | `skill_attempt` | Attempt 写入后 | 同上 | 结果写入失败则保留 pending |

必须同步的既有逻辑（历史教训）：`JOB_OWNER_TYPES` 白名单（`src/jobs/job-repository.ts:33`）
现在是 `['episode','experience','memory','pattern']`，**新增 owner 类型必须同步加进白名单**，
否则 `claim()` 会抛「未知 owner_type」且被 `tick()` 吞掉，表现为任务永不消费（Stage 4 已踩过）。
`MEMORY_JOB_TYPES`（`src/types.ts:645`）同理。

崩溃恢复：沿用 `reclaimStale()`（`job-repository.ts:290-320`）——running 超时回到 pending，attempts 不重复消耗。

### 8.3 Service API（`ctx.memorySea`，全部 Scope 校验）

| API | 读/写 | Scope 校验 | 幂等 | 副作用 |
| --- | --- | --- | --- | --- |
| `listSkillCandidates(scopeId, {status,kind,limit})` | 读 | 必须 | — | 无 |
| `getSkillCandidate(candidateId)` | 读 | 必须 | — | 无 |
| `listCandidateVersions(candidateId)` | 读 | 必须 | — | 无 |
| `getCandidateVersion(versionId)` | 读 | 必须 | — | 无 |
| `getCandidateMaturity(candidateId)` | 读 | 必须 | — | 无（派生计算） |
| `listSkillAttempts(versionId, {result,limit})` | 读 | 必须 | — | 无 |
| `listOutcomeEvidence(attemptId)` | 读 | 必须 | — | 无 |
| `createCandidateVersion(candidateId, {procedure,trigger,preconditions,successCriteria,changeReason})` | 写 | 必须 | `idempotencyKey` 可选（重复提交返回同版本） | 新版本行；旧版本不变 |
| `recordAttempt({versionId, externalKey, result, attribution, evidence[], startedAt, endedAt})` | 写 | 必须；证据必须同 scope | `UNIQUE(scope_id,external_key)` 命中返回原 Attempt | 尝试行 + 证据行（单事务） |
| `reevaluateCandidate(candidateId)` | 写 | 必须 | 幂等（只重算 maturity + 入队） | 更新派生缓存 / 入队 job |
| `submitSkillReview({versionId, decision, reviewer, reason})` | 写 | 必须 | `idempotencyKey`（同 reviewer+decision 重复提交返回原记录） | 审核行 append；**不执行任何动作** |

### 8.4 Harness 工具（少量）

- `memory_skill_candidates`（只读）：列出/查看候选、版本、成熟度、缺口。
- 不提供批准/拒绝工具：批准是人工动作，**不能交给 Agent 自己批自己**（产品约束）。
- 不提供 `execute_skill` / `run_skill`（Phase 0 明文禁止）。

### 8.5 只读 HTTP（沿用 `/api/memory-sea/*` 风格）

```text
GET /api/memory-sea/skill-candidates?scope=&status=&kind=&limit=
GET /api/memory-sea/skill-candidates/:id
GET /api/memory-sea/skill-candidates/:id/versions
GET /api/memory-sea/skill-candidates/:id/maturity
GET /api/memory-sea/skill-versions/:id/attempts
GET /api/memory-sea/skill-attempts/:id/evidence
```

**不提供任何写操作 HTTP**（与既有「只读调试 API」原则一致）；写只走 Service API（供宿主 UI / 测试）。

---

## 9. 测试矩阵、风险与分阶段实施计划

### 9.1 测试矩阵（12 项，映射到新 `tests/stage5*.test.ts`）

| # | 问题 | 断言要点 |
| --- | --- | --- |
| 1 | Pattern 不无限生成重复候选 | 同一 Pattern 重复触发 discovery → `COUNT(candidates)=1`；版本数不增长 |
| 2 | 派生证据不重复计数 | 同一 Episode 3 条 Memory 支持同一候选 → `independentEpisodes=1`，`independentMemories=1` |
| 3 | 缺步骤证据不伪造 Procedure | 无步骤证据 → `steps=[]`、`maturity.level=insufficient`、`submitReview` 抛错 |
| 4 | 缺 Outcome 不声称有效 | 0 次 Attempt → `validated` 不出现；`effectiveness` 字段为 `unknown` |
| 5 | unknown/inconclusive 不误判 failure | `attempts.unknown=2` → `failureRate` 不计入分母 |
| 6 | 反例可追溯 | `contradicts` 证据可回到原 Experience；UI/API 返回 provenance |
| 7 | 版本不覆盖旧版 | 创建 v2 后 v1 内容不变，`parent_version_id` 正确，Attempt 仍指向 v1 |
| 8 | 跨 Scope 不污染 | A scope 的 evidence 写入 B scope 候选 → 拒绝（错误码）+ 计数不变 |
| 9 | 批准不执行 | `submitSkillReview(approve)` 后：无 job、无工具调用、无 Experience 新增 |
| 10 | Job 重试/恢复/重复执行幂等 | 同一 owner 三次 enqueue → 1 条；崩溃 reclaim 后 attempts 不重复；结果不重复 |
| 11 | Memory/Pattern 生命周期不破坏历史 | Memory supersede 后候选证据仍可查，`effectiveSupport` 下降、历史版本不变 |
| 12 | 现有测试回归 | `node --test "dist/tests/*.test.js"` 150/150；Live Agent 30/30 |

### 9.2 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 证据计数通胀（同源多 Memory） | 候选虚高、误批准 | §6.3 独立性规则 + 单元测试 #2 |
| 步骤「脑补」 | 产出无法执行的伪流程 | 每步必须有 evidenceRefs；缺证据步骤不计入 `stepCoverage` |
| 成功率造假 | 用户被误导 | 无预设标准不得判定 success/failure；分母为 0 显示未知 |
| Scope 泄漏 | 跨项目知识污染 | 新表自带 scope_id + 写入校验 + 测试 #8 |
| Job owner 白名单漏加 | 任务永不消费 | 同步 `JOB_OWNER_TYPES` / `MEMORY_JOB_TYPES`（历史 bug） |
| 版本膨胀 | DB 增长、审核困惑 | 新版本需 `change_reason`；同类内容去重；旧版本归档不删 |
| 审核即执行误解 | 安全事故 | 批准只写元数据；无执行入口（测试 #9） |
| 无用户体系 | reviewer 身份不可信 | 显式 reviewer 字符串 + 审核记录不可改（P4 决策） |

### 9.3 分阶段实施计划（Phase 0 之后）

| 阶段 | 内容 | 交付 |
| --- | --- | --- |
| Phase 1 | 迁移 015 + `SkillCandidateRepository` / `VersionRepository` + 类型 + 单测 | 数据模型可用，无生成逻辑 |
| Phase 2 | Pattern → Candidate 发现（规则式，无 LLM）+ 去重 + `skill_candidate_discovery` job | 候选可自动产生（maturity=structural_only） |
| Phase 3 | `skill_attempts` + outcome evidence + `recordAttempt` + 幂等 | 可记录执行与结果 |
| Phase 4 | 评估：成功率/有效性门槛、`unknown` 语义、`effectiveSupport` | 能回答「这一版是否真的有效」 |
| Phase 5 | 版本 + 审核流（submit/approve/reject）+ 复核到期 | 人工审核闭环 |
| Phase 6 | 只读 HTTP + `memory_skill_candidates` 工具 + status 指标 | 可观测 |

每阶段结束都要：`npm run build`、全量测试、`verify:stage45` 等既有脚本回归、宿主重载验证。

---

## 10. 需要产品决策的问题 & 已证实 / 假设清单

### 10.1 产品决策（需要你确认）

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| P1 | 步骤有证据、但没有执行证据的候选，**允许批准吗**？ | (a) 允许，标注「未验证」 (b) 不允许，只能停在 in_review | (a)，但 UI 必须显著标注，且禁止出现成功率 |
| P2 | Attempt 由谁产生？ | (a) 人工/宿主 UI 上报 (b) 从 `sourceType='tool'` 的 Experience 自动推断 (c) 两者 | (c) 但自动推断只标 `inferred`，不计入成功分母 |
| P3 | 成功标准由谁定义？ | (a) 审核人书写 (b) 从 Pattern/Memory 推断 | (a)；推断的标准只能作为建议 |
| P4 | 没有用户体系，`reviewer` 用什么？ | (a) 自由字符串 (b) 固定 `local-operator` | (a)，Phase 5 前定 |
| P5 | 允许从 `weakened` Pattern 派生候选吗？ | (a) 允许（成熟度降级） (b) 只允许 active | (a) |
| P6 | 候选需要几个独立 Episode 才「结构成立」？ | 2 / 3 | 2，另加 Pattern `support_count>=3` |
| P7 | 是否允许跨 scope 共享候选（同一 procedure 在多个项目）？ | (a) 不（严格隔离） (b) 允许「模板」但证据隔离 | (a)，Phase 0 先严格 |
| P8 | Attempt 的 `external_key` 由谁生成？ | 调用方 / 插件 | 调用方必填；缺省时插件用 `hash(version+startedAt+evidence)` 兜底 |

### 10.2 现有代码能证明的（非假设）

- Pattern 的 evidence / 计数 / 生命周期 / 事务边界：§2.1 的代码位置。
- Memory 的 supersede 保留证据与历史：`007_semantic_memory.sql` + `src/consolidation/consolidation-applier.ts`。
- Job 的幂等键、退避、僵死回收、owner 白名单：`005_jobs.sql`、`job-repository.ts:33/119-160/246-320`。
- Scope 过滤在 Repository 层：`scopeWhere(scopeId)`；`pattern_evidence`/`memory_evidence` **无 scope_id 列**（§2.7）。
- 全仓库无 Skill/Attempt/Outcome 概念（`grep` 结果）。

### 10.3 仍是假设（需 Phase 1 用真实数据验证）

- 「多个 Memory 的 supports 通常来自不同 Episode」——Stage 3/4 的语义去重只在批内（`touched`），
  跨批次同义 Memory 是否会重复支持同一 Pattern，需要真实库统计（`project_*` 下 pattern_evidence 的 memory→episode 分布）。
- 「工具结果类 Experience 足以作为 execution 证据」——当前 metadata 是自由 JSON，没有 attempt 关联，
  是否能在不新增捕获字段的前提下还原执行，需要抽样 100 条 `source_type='tool'` 的 Experience 验证。
- 「Pattern `recurring_decision` 与可执行 Procedure 有稳定映射」——规则式分析器目前只有 6 个概念
  （`pattern-lifecycle.ts:134-189`），是否覆盖足够多的决策结构未知，Phase 2 用真实 Pattern 抽样评估。

---

## 11. 结论

- 现有链路在「经历 → 事件 → 知识 → 模式」四层是完整且可审计的；
  **Stage 5 需要新增的是第五层「可验证的执行」，而不是第六层「技能」**。
- 最小可行新增：候选（表）+ 版本（表，procedure 为 JSON）+ 尝试（表）+ 结果证据（表）+ 审核记录（表）。
- 三条硬边界必须写进代码与测试：批准不可执行、无标准不可判定成功、unknown ≠ failure。

**评审到此为止，等待批准后再进入 Phase 1 编码。**
