-- 001_init.sql —— 3D Memory Sea V0.2 初始 schema（核心表 / 索引 / 关联）
--
-- 数据安全约定（spec §3.1）：
--   experiences.content 是原始证据，只 INSERT，不 UPDATE。
--   Episode 的 summary / topics 等派生物写在自己的表里，不回写 Experience。
-- 关联约定（spec §7）：一个 Experience 最多属于一个 Episode —— 由
--   episode_experiences.experience_id UNIQUE 约束保证。

CREATE TABLE IF NOT EXISTS experiences (
  id               TEXT PRIMARY KEY,
  source_type      TEXT    NOT NULL,
  source_id        TEXT,
  session_id       TEXT,
  turn_id          TEXT,
  role             TEXT,
  content          TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  observed_at      INTEGER NOT NULL,
  importance       REAL    NOT NULL DEFAULT 0.5,
  metadata_json    TEXT    NOT NULL DEFAULT '{}',
  episode_id       TEXT,
  embedding_status TEXT    NOT NULL DEFAULT 'disabled',
  -- 作用域：V0.2 只写当前 project，global 为预留。
  scope_type       TEXT    NOT NULL DEFAULT 'global',
  scope_id         TEXT,
  scope_root       TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiences_session_id    ON experiences(session_id);
CREATE INDEX IF NOT EXISTS idx_experiences_episode_id    ON experiences(episode_id);
CREATE INDEX IF NOT EXISTS idx_experiences_created_at    ON experiences(created_at);
CREATE INDEX IF NOT EXISTS idx_experiences_observed_at   ON experiences(observed_at);
CREATE INDEX IF NOT EXISTS idx_experiences_scope         ON experiences(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS episodes (
  id               TEXT PRIMARY KEY,
  title            TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  summary          TEXT,
  participants_json TEXT   NOT NULL DEFAULT '[]',
  locations_json   TEXT    NOT NULL DEFAULT '[]',
  topics_json      TEXT    NOT NULL DEFAULT '[]',
  importance       REAL    NOT NULL DEFAULT 0.5,
  salience         REAL    NOT NULL DEFAULT 0.5,
  confidence       REAL    NOT NULL DEFAULT 0.5,
  status           TEXT    NOT NULL DEFAULT 'open',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  embedding_status TEXT    NOT NULL DEFAULT 'disabled',
  session_id       TEXT,
  scope_type       TEXT    NOT NULL DEFAULT 'global',
  scope_id         TEXT,
  scope_root       TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_status     ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at);
CREATE INDEX IF NOT EXISTS idx_episodes_ended_at   ON episodes(ended_at);
CREATE INDEX IF NOT EXISTS idx_episodes_session_id ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_scope      ON episodes(scope_type, scope_id);

-- Episode ↔ Experience 关联。experience_id UNIQUE 即「一个 Experience 只属于一个 Episode」。
CREATE TABLE IF NOT EXISTS episode_experiences (
  episode_id    TEXT    NOT NULL,
  experience_id TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (episode_id, experience_id),
  UNIQUE (experience_id),
  FOREIGN KEY (episode_id)    REFERENCES episodes(id)    ON DELETE CASCADE,
  FOREIGN KEY (experience_id) REFERENCES experiences(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_episode_experiences_episode ON episode_experiences(episode_id, position);
