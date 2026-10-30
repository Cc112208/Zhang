-- 007_semantic_memory.sql —— Stage 3：Semantic Memory 与 Evidence（spec §6 / §7）。
--
-- 设计约束：
--   * Memory 是派生知识，允许更新 content；Experience 仍然绝对不可改写。
--   * Evidence 是一等公民：独立行，可双向查询，绝不塞进 JSON。
--   * 旧知识不删除：supersede 只改 status + superseded_by + valid_until。

CREATE TABLE IF NOT EXISTS memories (
  id                  TEXT PRIMARY KEY,

  scope_id            TEXT NOT NULL,

  kind                TEXT NOT NULL,

  subject             TEXT,

  content             TEXT NOT NULL,
  normalized_content  TEXT,

  confidence          REAL NOT NULL DEFAULT 0.5,
  importance          REAL NOT NULL DEFAULT 0.5,

  status              TEXT NOT NULL DEFAULT 'active',

  valid_from          INTEGER,
  valid_until         INTEGER,

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  last_reinforced_at  INTEGER,
  last_accessed_at    INTEGER,

  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  access_count        INTEGER NOT NULL DEFAULT 0,

  superseded_by       TEXT,

  embedding_status    TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_scope_kind ON memories(scope_id, kind);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_normalized ON memories(scope_id, normalized_content);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id     TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_id   TEXT NOT NULL,
  relation      TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  created_at    INTEGER NOT NULL,

  PRIMARY KEY (memory_id, evidence_type, evidence_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_lookup ON memory_evidence(evidence_type, evidence_id);
