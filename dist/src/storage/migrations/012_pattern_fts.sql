-- Stage 4：Pattern 全文检索（可选迁移）
--
-- 与 experience_fts / memories_fts 一致：中文由 JS bigram 预切后写入，不用 SQL 触发器。
-- FTS5 不可用时降级 LIKE，绝不让插件启动失败。

CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
  pattern_id UNINDEXED,
  content,
  subject,
  tokenize = 'unicode61 remove_diacritics 2'
);
