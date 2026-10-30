-- 002_fts.sql —— FTS5 索引 + 向量表
--
-- 单独一个迁移文件的原因：部分 SQLite 构建不带 fts5。迁移器把这份文件标为
-- 「可选迁移」，失败时记 ftsAvailable=false 继续运行，Recall 自动走
-- 普通 SQLite LIKE fallback（spec §21）。带 fts5 的环境则正常启用。
--
-- 注意：FTS 表的文本由 JS 侧预处理后写入（中文 bigram 切分，见 recall/tokenizer.ts），
-- 不使用触发器自动同步 —— 因为同步需要中文分词逻辑，SQL 触发器做不到。

CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(
  experience_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  episode_id UNINDEXED,
  title,
  summary,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 向量（V0.2 默认不用：NoopEmbeddingProvider，表结构先留，避免以后加迁移）
CREATE TABLE IF NOT EXISTS embeddings (
  owner_type  TEXT    NOT NULL,
  owner_id    TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL DEFAULT '',
  dimensions  INTEGER NOT NULL,
  vector      BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
