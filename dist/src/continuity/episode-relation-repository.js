/**
 * episode-relation-repository.ts —— episode_relations 的唯一访问入口（Stage 4.5）。
 *
 * 关系方向约定：`source` 是**较早**的 Episode，`target` 是**较晚**的 Episode。
 * 因此对某个 Episode 来说：
 *   previous = target_episode_id = 自己（谁延续到了我）
 *   next     = source_episode_id = 自己（我延续到了谁）
 *
 * 写入一律 INSERT OR IGNORE：PK(source, target, relation) 保证幂等（spec §32）。
 */
const RELATION_TYPES = ['continues', 'followup', 'same_thread', 'same_topic'];
const RELATION_SET = new Set(RELATION_TYPES);
export class EpisodeRelationRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? (() => Date.now());
    }
    /** 写入一条关系；重复写入返回 false（幂等）。 */
    upsert(input) {
        if (input.sourceEpisodeId === input.targetEpisodeId)
            return false;
        const result = this.db.run(`INSERT OR IGNORE INTO episode_relations
         (source_episode_id, target_episode_id, scope_id, relation, confidence, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, input.sourceEpisodeId, input.targetEpisodeId, input.scopeId, input.relation, clamp01(input.confidence), input.reason ?? null, this.now());
        return Number(result.changes ?? 0) > 0;
    }
    /** 批量写入，返回真正新增的条数。 */
    insertMany(inputs) {
        let inserted = 0;
        for (const input of inputs) {
            if (this.upsert(input))
                inserted += 1;
        }
        return inserted;
    }
    /** 删除一条关系（用于修正方向错误的历史数据；正常路径不会删关系）。 */
    deleteOne(sourceEpisodeId, targetEpisodeId, relation) {
        const result = this.db.run(`DELETE FROM episode_relations
        WHERE source_episode_id = ? AND target_episode_id = ? AND relation = ?`, sourceEpisodeId, targetEpisodeId, relation);
        return Number(result.changes ?? 0);
    }
    /** 与某个 Episode 有关的全部关系（两个方向）。 */
    listByEpisode(scopeId, episodeId, limit = 20) {
        const rows = this.db.all(`SELECT * FROM episode_relations
        WHERE scope_id = ? AND (source_episode_id = ? OR target_episode_id = ?)
        ORDER BY confidence DESC, created_at ASC LIMIT ?`, scopeId, episodeId, episodeId, clampLimit(limit));
        return rows.map(mapRow);
    }
    /** 谁延续到了这个 Episode（更早的一方）。 */
    previous(scopeId, episodeId, limit = 2) {
        const rows = this.db.all(`SELECT * FROM episode_relations
        WHERE scope_id = ? AND target_episode_id = ?
        ORDER BY confidence DESC, created_at ASC LIMIT ?`, scopeId, episodeId, clampLimit(limit));
        return rows.map(mapRow);
    }
    /** 这个 Episode 延续到了谁（更晚的一方）。 */
    next(scopeId, episodeId, limit = 2) {
        const rows = this.db.all(`SELECT * FROM episode_relations
        WHERE scope_id = ? AND source_episode_id = ?
        ORDER BY confidence DESC, created_at ASC LIMIT ?`, scopeId, episodeId, clampLimit(limit));
        return rows.map(mapRow);
    }
    /** scope 内关系总数。 */
    count(scopeId) {
        const row = this.db.get('SELECT COUNT(*) AS total FROM episode_relations WHERE scope_id = ?', scopeId);
        return Number(row?.total ?? 0);
    }
    /** scope 内被至少一条关系连接的 Episode 数（含两端去重）。 */
    episodesLinked(scopeId) {
        const row = this.db.get(`SELECT COUNT(*) AS total FROM (
         SELECT source_episode_id AS id FROM episode_relations WHERE scope_id = ?
         UNION
         SELECT target_episode_id AS id FROM episode_relations WHERE scope_id = ?
       )`, scopeId, scopeId);
        return Number(row?.total ?? 0);
    }
    /** scope 内全部关系（调试接口用，按时间倒序）。 */
    listForScope(scopeId, limit = 100) {
        const rows = this.db.all('SELECT * FROM episode_relations WHERE scope_id = ? ORDER BY created_at DESC LIMIT ?', scopeId, clampLimit(limit));
        return rows.map(mapRow);
    }
    /** 某个 Episode 已有多少条关系（用于稀疏度控制，spec §74）。 */
    countByEpisode(scopeId, episodeId) {
        const row = this.db.get(`SELECT COUNT(*) AS total FROM episode_relations
        WHERE scope_id = ? AND (source_episode_id = ? OR target_episode_id = ?)`, scopeId, episodeId, episodeId);
        return Number(row?.total ?? 0);
    }
}
function mapRow(row) {
    return {
        sourceEpisodeId: row.source_episode_id,
        targetEpisodeId: row.target_episode_id,
        scopeId: row.scope_id,
        relation: asRelationType(row.relation),
        confidence: clamp01(Number(row.confidence)),
        ...(row.reason ? { reason: row.reason } : {}),
        createdAt: Number(row.created_at),
    };
}
function asRelationType(value) {
    return RELATION_SET.has(value) ? value : 'same_topic';
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 100;
    return Math.min(1000, Math.max(1, Math.round(value)));
}
