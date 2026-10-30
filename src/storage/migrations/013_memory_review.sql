-- Stage 4：Semantic Memory 的 Review / Stale 字段（spec §31–§34）
--
-- stale ≠ 错误：只是"很久没有被强化/验证"，绝不删除，也绝不因此 supersede。
-- 记忆的物理内容仍然只在 supersede / expire 时改变状态，不做物理删除。

ALTER TABLE memories ADD COLUMN last_reviewed_at INTEGER;
ALTER TABLE memories ADD COLUMN review_status TEXT NOT NULL DEFAULT 'fresh';

CREATE INDEX IF NOT EXISTS idx_memories_review
  ON memories (scope_id, status, review_status, last_reinforced_at);

-- Pattern 也需要"很久没被支持 + 不断出现反证 → weakened → stale"的扫描入口。
CREATE INDEX IF NOT EXISTS idx_patterns_sweep
  ON patterns (scope_id, status, last_reinforced_at);
