-- 003_scope.sql —— Stage 2 第一步：统一 scope 键（spec §5 / §6）
--
-- 背景：Stage 1 的 experiences / episodes 已经有 scope_type / scope_id / scope_root 三列，
-- 但 scope_id 的值是 `p_<hash>`，且旧代码会按 scope_type + scope_id 双条件过滤。
-- Stage 2 统一成「只按 scope_id 过滤」的稳定键：
--     project_<16位hex>   ← 由规范化项目根路径派生（Windows 大小写/分隔符归一）
--     project_legacy      ← 无法推导 rootPath 的旧数据兜底（永不删数据）
--     global              ← 预留的全局作用域
--
-- 本迁移只做两件事：
--   1. 把 NULL/空 scope_id 填成 project_legacy（随后由 JS 回填按 scope_root 精确推导）；
--   2. 建立 scope 维度的查询索引。
-- 已发布的 001/002 视为 immutable，不在这里改写。

UPDATE experiences SET scope_id = 'project_legacy' WHERE scope_id IS NULL OR scope_id = '' OR (scope_id NOT LIKE 'project_%' AND scope_id <> 'global');
UPDATE episodes SET scope_id = 'project_legacy' WHERE scope_id IS NULL OR scope_id = '' OR (scope_id NOT LIKE 'project_%' AND scope_id <> 'global');

CREATE INDEX IF NOT EXISTS idx_experiences_scope_created_at ON experiences(scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_experiences_scope_session_id ON experiences(scope_id, session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_scope_status ON episodes(scope_id, status);
CREATE INDEX IF NOT EXISTS idx_episodes_scope_created_at ON episodes(scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_episode_experiences_experience ON episode_experiences(experience_id);
