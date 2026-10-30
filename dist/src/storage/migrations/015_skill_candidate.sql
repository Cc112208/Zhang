-- 015_skill_candidate.sql —— Stage 5 Phase 1：Skill Candidate 与版本化候选快照
--
-- 设计边界（Stage 5 Phase 0 已批准）：
--   * Candidate 是跨版本的稳定身份，不直接承载可变步骤内容；
--   * 版本是不可变快照：任何内容变化都新增一行，旧版本永不覆盖；
--   * Procedure / Trigger / Precondition / ExpectedOutcome / 成功标准全部在版本内 JSON，
--     因为它们只按整版读写，不单独查询（避免 4 张稀疏表与大量 join）；
--   * 所有核心表都带 scope_id，Repository 与事务层双重校验，禁止跨 Scope 关联；
--   * Candidate is not executable Skill：本表没有任何执行入口字段。

CREATE TABLE IF NOT EXISTS skill_candidates (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,

  -- 来源：Pattern 是主要来源；source_memory_ids_json 保存当时的支持知识快照
  -- （真正可下钻的证据仍走 pattern_evidence / memory_evidence，不复制原文）。
  source_pattern_id TEXT,
  source_memory_ids_json TEXT NOT NULL DEFAULT '[]',

  title TEXT NOT NULL,
  description TEXT,

  -- 候选类型：guideline / procedure / decision_rule / checklist / other
  kind TEXT NOT NULL,

  -- 生命周期：drafting / ready_for_review / in_review / changes_requested /
  --           approved / rejected / superseded / stale_candidate
  status TEXT NOT NULL DEFAULT 'drafting',

  current_version_id TEXT,
  latest_version_no INTEGER NOT NULL DEFAULT 0,

  -- 来源发生 supersede / pattern 变 stale 时置 1，只影响展示与 Review，不自动改状态。
  provenance_changed INTEGER NOT NULL DEFAULT 0,
  review_due_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 一个 Pattern 在同一 Scope 内最多派生一个候选（重复 discovery 必须命中这条唯一索引）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_candidates_pattern
  ON skill_candidates (scope_id, source_pattern_id)
  WHERE source_pattern_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_candidates_scope_status ON skill_candidates (scope_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_scope_kind ON skill_candidates (scope_id, kind);
CREATE INDEX IF NOT EXISTS idx_skill_candidates_updated ON skill_candidates (scope_id, updated_at);

CREATE TABLE IF NOT EXISTS skill_candidate_versions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,

  version_no INTEGER NOT NULL,
  parent_version_id TEXT,

  -- draft / submitted / approved / rejected / superseded
  status TEXT NOT NULL DEFAULT 'draft',

  title TEXT NOT NULL,

  -- ProcedureDraft：steps / triggers / preconditions / expectedOutcomes /
  -- exceptions / limitations / successCriteria 全部是经过 schema 校验的 JSON。
  procedure_json TEXT NOT NULL DEFAULT '{"steps":[]}',
  trigger_json TEXT NOT NULL DEFAULT '[]',
  preconditions_json TEXT NOT NULL DEFAULT '[]',
  expected_outcomes_json TEXT NOT NULL DEFAULT '[]',
  exceptions_json TEXT NOT NULL DEFAULT '[]',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  success_criteria_json TEXT NOT NULL DEFAULT '[]',

  -- 来源快照：patternId / memoryIds / episodeIds / experienceIds + 当时的 status 与 confidence，
  -- 用于「来源后来被 supersede 了，但版本仍然说明当时依据什么」。
  evidence_snapshot_json TEXT NOT NULL DEFAULT '{}',

  change_reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (candidate_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_scope ON skill_candidate_versions (scope_id, candidate_id, version_no);
CREATE INDEX IF NOT EXISTS idx_skill_versions_status ON skill_candidate_versions (scope_id, status);
