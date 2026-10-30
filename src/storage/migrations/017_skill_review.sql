-- 017_skill_review.sql —— Stage 5 Phase 1：审核记录（append-only 审计）
--
-- 设计边界：
--   * 只追加，不更新、不删除：审核历史不可被静默覆盖；
--   * reviewer 必填（没有身份时拒绝审核，Service 层校验）；
--   * 每次状态转换与审核记录在同一个事务里提交；
--   * 批准只表示接受「描述」，不产生任何执行、注册或工作流。

CREATE TABLE IF NOT EXISTS skill_reviews (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  version_id TEXT NOT NULL,

  -- approve / reject / request_changes
  decision TEXT NOT NULL,

  reviewer TEXT NOT NULL,
  reason TEXT NOT NULL,

  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_reviews_candidate ON skill_reviews (scope_id, candidate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_skill_reviews_version ON skill_reviews (version_id, decision);
