-- 006_embedding_versioning.sql —— Stage 2：embedding 版本化（spec §24 / §25）
--
-- Stage 1 的 embeddings 表主键是 (owner_type, owner_id)，只够存「一个对象一个向量」。
-- Stage 2 需要：
--   - 按 provider + model 版本化（换模型不会污染旧向量）；
--   - content_hash：文本没变就跳过重算；
--   - scope_id：语义检索必须按项目隔离。
--
-- 旧行（如果有）会被搬到新表：id 由 owner + provider + model 拼出来，
-- scope_id 从对应的 experience / episode 继承，content_hash 标记为 'legacy'（下次 job 会重算）。
-- 这是一个纯 CREATE + COPY + RENAME 的迁移：embeddings 没有任何外键指向它，不存在级联风险。

CREATE TABLE IF NOT EXISTS embeddings_v2 (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,

  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,

  provider TEXT NOT NULL,
  model TEXT NOT NULL,

  dimensions INTEGER NOT NULL,

  content_hash TEXT NOT NULL,

  vector BLOB NOT NULL,

  created_at INTEGER NOT NULL,

  UNIQUE(owner_type, owner_id, provider, model)
);

INSERT OR IGNORE INTO embeddings_v2 (id, scope_id, owner_type, owner_id, provider, model, dimensions, content_hash, vector, created_at)
SELECT
  embeddings.owner_type || ':' || embeddings.owner_id || ':' || embeddings.provider || ':' || embeddings.model,
  COALESCE(
    (SELECT scope_id FROM experiences WHERE experiences.id = embeddings.owner_id),
    (SELECT scope_id FROM episodes WHERE episodes.id = embeddings.owner_id),
    'project_legacy'
  ),
  embeddings.owner_type,
  embeddings.owner_id,
  embeddings.provider,
  embeddings.model,
  embeddings.dimensions,
  'legacy',
  embeddings.vector,
  embeddings.created_at
FROM embeddings;

DROP TABLE IF EXISTS embeddings;
ALTER TABLE embeddings_v2 RENAME TO embeddings;

CREATE INDEX IF NOT EXISTS idx_embeddings_scope ON embeddings(scope_id, owner_type);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner ON embeddings(owner_type, owner_id);
