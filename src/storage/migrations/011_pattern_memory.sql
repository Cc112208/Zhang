-- Stage 4：Pattern Memory（跨多个 Semantic Memory 反复出现的模式）
--
-- 分层：Semantic Memory → Pattern。Pattern 的证据优先指向 Memory，而不是原始 Experience。
-- Pattern is descriptive. Skill is executable —— 本表只存描述性知识。

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,

  scope_id TEXT NOT NULL,

  kind TEXT NOT NULL,
  subject TEXT,
  domain TEXT,

  content TEXT NOT NULL,
  normalized_content TEXT,

  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,

  support_count INTEGER NOT NULL DEFAULT 0,
  contradiction_count INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'candidate',

  first_observed_at INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  last_reinforced_at INTEGER,
  last_reviewed_at INTEGER,
  last_accessed_at INTEGER,

  access_count INTEGER NOT NULL DEFAULT 0,

  superseded_by TEXT,

  embedding_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_patterns_scope_status ON patterns (scope_id, status);
CREATE INDEX IF NOT EXISTS idx_patterns_scope_kind ON patterns (scope_id, kind);
CREATE INDEX IF NOT EXISTS idx_patterns_updated ON patterns (scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_patterns_normalized ON patterns (scope_id, normalized_content);

-- Pattern 的证据：指向 Semantic Memory（memory_id），关系只有 supports / contradicts。
CREATE TABLE IF NOT EXISTS pattern_evidence (
  pattern_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,

  relation TEXT NOT NULL,

  weight REAL NOT NULL DEFAULT 1.0,

  created_at INTEGER NOT NULL,

  PRIMARY KEY (pattern_id, memory_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_pattern_evidence_pattern ON pattern_evidence (pattern_id, relation);
CREATE INDEX IF NOT EXISTS idx_pattern_evidence_memory ON pattern_evidence (memory_id, relation);
