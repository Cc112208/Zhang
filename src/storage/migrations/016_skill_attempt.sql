-- 016_skill_attempt.sql —— Stage 5 Phase 1：Attempt 与 Outcome Evidence
--
-- 设计边界：
--   * Attempt 记录「某一版候选被实际执行 / 被观察到执行」的一次尝试，独立持久化；
--   * 外部操作必须提供稳定幂等键（UNIQUE(scope_id, external_key)），重试不会产生第二次执行；
--   * 成功标准在 Attempt 开始时快照（success_criteria_snapshot_json），事后不能追溯成「预先声明」；
--   * OutcomeEvidence 只保存「指向真实证据的引用」，绝不复制原文当新事实来源；
--   * 完成的 Attempt 不允许静默改写：更正走 corrections_attempt_id 新记录。

CREATE TABLE IF NOT EXISTS skill_attempts (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  version_id TEXT NOT NULL,

  external_key TEXT NOT NULL,

  -- planned / running / completed / aborted
  status TEXT NOT NULL DEFAULT 'planned',

  -- completed 时的结果：success / partial_success / failure / unknown / inconclusive
  result TEXT,

  -- direct / user_reported / inferred / none
  attribution TEXT NOT NULL DEFAULT 'none',

  success_criteria_snapshot_json TEXT NOT NULL DEFAULT '[]',

  started_at INTEGER NOT NULL,
  ended_at INTEGER,

  note TEXT,
  corrections_attempt_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (scope_id, external_key)
);

CREATE INDEX IF NOT EXISTS idx_skill_attempts_version ON skill_attempts (scope_id, version_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_attempts_candidate ON skill_attempts (scope_id, candidate_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_attempts_result ON skill_attempts (scope_id, result);

CREATE TABLE IF NOT EXISTS skill_outcome_evidence (
  attempt_id TEXT NOT NULL,

  -- 冗余保存，便于按 scope/version 直接查询，同时由事务层校验一致性
  scope_id TEXT NOT NULL,
  version_id TEXT NOT NULL,

  -- experience / episode / memory / manual
  evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL,

  -- supports / contradicts / partial
  relation TEXT NOT NULL,

  -- direct / user_reported / inferred / none
  attribution TEXT NOT NULL DEFAULT 'direct',

  weight REAL NOT NULL DEFAULT 1.0,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,

  PRIMARY KEY (attempt_id, evidence_type, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_outcome_scope ON skill_outcome_evidence (scope_id, version_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcome_source ON skill_outcome_evidence (evidence_type, evidence_id);
CREATE INDEX IF NOT EXISTS idx_skill_outcome_attempt ON skill_outcome_evidence (attempt_id, relation);
