-- 005_jobs.sql —— Stage 2：持久化后台任务（spec §15 / §16 / §17）
--
-- 设计要点：
--   - 任务状态在数据库里，而不是 setInterval + Promise 的内存状态：进程崩了也能恢复；
--   - UNIQUE(type, owner_type, owner_id) 让 enqueue 天然幂等（重复关闭 Episode 不会重复建任务）；
--   - attempts / max_attempts / available_at 支撑指数退避重试；
--   - scope_id 让 worker 可以按项目分区调度，绝不跨 scope 处理。

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,

  type TEXT NOT NULL,

  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,

  status TEXT NOT NULL,

  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,

  available_at INTEGER NOT NULL,

  started_at INTEGER,
  completed_at INTEGER,

  error TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(type, owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim ON memory_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_scope_status ON memory_jobs(scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_stale ON memory_jobs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_owner ON memory_jobs(owner_type, owner_id);
