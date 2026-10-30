-- 009_consolidation_status.sql —— Stage 3：Episode 的长期记忆整理状态（spec §13）。
--
-- 独立字段，不改变 Episode 主状态（status），整理失败也不会让 Episode 回退。
-- pending  → 已关闭但尚未整理（也会被摘要在完成后触发）
-- ready    → 整理完成（可能 no_op）
-- failed   → 整理失败（可重试；超过 maxAttempts 停在 failed）
-- disabled → 配置关闭了 consolidation

ALTER TABLE episodes ADD COLUMN consolidation_status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_episodes_consolidation ON episodes(scope_id, consolidation_status);
