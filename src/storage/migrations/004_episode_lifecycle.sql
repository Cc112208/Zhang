-- 004_episode_lifecycle.sql —— Stage 2：Episode 生命周期字段（spec §10 / §11 / §12 / §30）
--
-- 目标：
--   1. last_experience_at：Sweeper 判断 idle 时直接读这一列，不再每次 MAX(experience.created_at)；
--   2. closed_at + closed_reason：关闭幂等 + 可解释（为什么关的）；
--   3. summary_status：摘要处理状态与生命周期状态解耦（summary 失败不得让 Episode 回到 open）。
--
-- SQLite 的 ADD COLUMN 支持 NOT NULL + DEFAULT，旧行会自动填充默认值，不需要重建表
-- （重建表会触发 episode_experiences 的外键级联，风险远大于收益）。

ALTER TABLE episodes ADD COLUMN last_experience_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN closed_at INTEGER;
ALTER TABLE episodes ADD COLUMN closed_reason TEXT;
ALTER TABLE episodes ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'pending';

-- 旧数据回填：用 ended_at（最后一次 append 时间）或 started_at 作为最后一条经历时间。
UPDATE episodes SET last_experience_at = COALESCE(ended_at, started_at) WHERE last_experience_at = 0;

-- 已经有 summary 的旧行标成 ready，避免启动时给它们重复排队。
UPDATE episodes SET summary_status = 'ready' WHERE summary IS NOT NULL AND summary <> '' AND summary_status = 'pending';

-- Sweeper 的主查询：status='open' AND last_experience_at < now - idleMs（按 scope 分区）。
CREATE INDEX IF NOT EXISTS idx_episodes_sweep ON episodes(scope_id, status, last_experience_at);
CREATE INDEX IF NOT EXISTS idx_episodes_summary_pending ON episodes(scope_id, status, summary_status);
