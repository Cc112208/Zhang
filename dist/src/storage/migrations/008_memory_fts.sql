-- 008_memory_fts.sql —— Stage 3：Semantic Memory 的 FTS5 索引（spec §8）。
--
-- 可选迁移：SQLite 没编译 FTS5 时失败只降级到 LIKE（memory-repository 内部处理），
-- 绝不让 Memory FTS 成为启动硬依赖。
--
-- 文本由 JS 侧用中文 bigram 预处理（与 experience_fts 一致），不使用 SQL 触发器。

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  content,
  subject,
  tokenize = 'unicode61 remove_diacritics 2'
);
