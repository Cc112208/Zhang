-- 010_memory_relations.sql —— Stage 3：Memory ↔ Memory 的关系（spec §54）。
--
-- 只记录「知识之间」的关系：supersede / contradict / related。
-- 不做通用图数据库，不引入多跳推理。

CREATE TABLE IF NOT EXISTS memory_relations (
  from_memory_id TEXT NOT NULL,
  to_memory_id   TEXT NOT NULL,
  relation       TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL,

  PRIMARY KEY (from_memory_id, to_memory_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id, relation);
CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id, relation);
