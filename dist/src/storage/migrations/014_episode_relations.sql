-- Stage 4.5：Episode Continuity（跨 Episode 的连续经历关系）
--
-- 为什么不是合并：Episode 的生命周期 / Evidence ID / 时间结构都必须保留，
-- 所以只建「关系」，Narrative Chain 是查询视图而不是新实体（spec §17 / §26）。
-- Relation is not evidence：本表不会自动变成 memory_evidence（spec §28 / §68）。
-- 关系必须稀疏（spec §74）：每条边都要有 confidence 与可读 reason。

CREATE TABLE IF NOT EXISTS episode_relations (
  source_episode_id TEXT NOT NULL,
  target_episode_id TEXT NOT NULL,

  scope_id TEXT NOT NULL,

  relation TEXT NOT NULL,

  confidence REAL NOT NULL,

  reason TEXT,

  created_at INTEGER NOT NULL,

  PRIMARY KEY (source_episode_id, target_episode_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_episode_relations_source ON episode_relations (scope_id, source_episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_relations_target ON episode_relations (scope_id, target_episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_relations_scope ON episode_relations (scope_id, relation);

-- Episode 连续性分析状态：独立于 consolidation_status，可重跑、失败不影响整理。
ALTER TABLE episodes ADD COLUMN continuity_status TEXT NOT NULL DEFAULT 'pending';
