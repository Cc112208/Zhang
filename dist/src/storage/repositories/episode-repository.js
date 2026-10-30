/**
 * episode-repository.ts —— episodes / episode_experiences 的唯一访问入口。
 *
 * 关键不变量（spec §8 / §9 / §11）：
 *   - 一个 Experience 最多属于一个 Episode：由 episode_experiences 上的 UNIQUE(experience_id) 兜底，
 *     这里所有挂载操作都用 INSERT OR IGNORE，保证并发/重放都不会产生双归属。
 *   - Episode 的关闭是幂等的：close() 只在 status='open' 时改写，重复调用不改变 closed_at。
 *   - last_experience_at 是 Sweeper 的唯一判据：它由 appendExperience / insertWithSession 维护，
 *     不从 experiences 表反查（避免每轮扫描都做聚合）。
 */
import { asEmbeddingStatus, asEpisodeStatus, asProcessingStatus, parseStringArray, serializeStringArray, scopeColumns, scopeWhere, } from '../../storage/schema.js';
import { buildTimeFilters } from './experience-repository.js';
import { toFtsText } from '../../recall/tokenizer.js';
const COLUMNS = [
    'id',
    'title',
    'started_at',
    'ended_at',
    'summary',
    'participants_json',
    'locations_json',
    'topics_json',
    'importance',
    'salience',
    'confidence',
    'status',
    'created_at',
    'updated_at',
    'embedding_status',
    'session_id',
    'scope_type',
    'scope_id',
    'scope_root',
    'last_experience_at',
    'closed_at',
    'closed_reason',
    'summary_status',
    'consolidation_status',
    'continuity_status',
].join(', ');
export class EpisodeRepository {
    db;
    constructor(deps) {
        this.db = deps.db;
    }
    insertWithSession(episode, scopeId, sessionId) {
        const scope = scopeColumns({ type: 'project', id: scopeId });
        this.db.run(`INSERT INTO episodes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, episode.id, episode.title ?? null, episode.startedAt, episode.endedAt ?? null, episode.summary ?? null, serializeStringArray(episode.participants), serializeStringArray(episode.locations), serializeStringArray(episode.topics), episode.importance, episode.salience, episode.confidence, episode.status, episode.createdAt, episode.updatedAt, episode.embeddingStatus, sessionId, scope.scopeType, scope.scopeId, scope.scopeRoot, episode.lastExperienceAt, episode.closedAt ?? null, episode.closedReason ?? null, episode.summaryStatus, episode.consolidationStatus, episode.continuityStatus);
    }
    get(id) {
        const row = this.db.get(`SELECT ${COLUMNS} FROM episodes WHERE id = ?`, id);
        if (!row)
            return null;
        return mapEpisodeRow(row, this.experienceIds(id));
    }
    /** 批量读取（保持入参顺序，召回结果排序依赖它）。 */
    listByIds(ids) {
        if (ids.length === 0)
            return [];
        const rows = [];
        for (let start = 0; start < ids.length; start += 400) {
            const chunk = ids.slice(start, start + 400);
            const placeholders = chunk.map(() => '?').join(', ');
            rows.push(...this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE id IN (${placeholders})`, ...chunk));
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        const out = [];
        for (const id of ids) {
            const row = byId.get(id);
            if (row)
                out.push(mapEpisodeRow(row, this.experienceIds(row.id)));
        }
        return out;
    }
    /** 当前 session 最近的 open Episode（EpisodeBuilder 的唯一入口查询）。 */
    findOpen(scopeId, sessionId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT ${COLUMNS} FROM episodes WHERE ${scope.clause} AND status = 'open' AND session_id IS ?
       ORDER BY updated_at DESC LIMIT 1`, ...scope.params, sessionId);
        return row ? mapEpisodeRow(row, this.experienceIds(row.id)) : null;
    }
    /**
     * 把 Experience 挂到 Episode 上。
     * 同时推进 ended_at / last_experience_at / updated_at，并取 importance 最大值。
     */
    appendExperience(episodeId, experienceId, at, importance, now) {
        this.db.transaction(() => {
            const position = this.db.get('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM episode_experiences WHERE episode_id = ?', episodeId);
            this.db.run('INSERT OR IGNORE INTO episode_experiences (episode_id, experience_id, position, created_at) VALUES (?, ?, ?, ?)', episodeId, experienceId, Number(position?.next ?? 1), now);
            this.db.run(`UPDATE episodes
            SET ended_at = MAX(COALESCE(ended_at, started_at), ?),
                last_experience_at = MAX(last_experience_at, ?),
                importance = MAX(importance, ?),
                updated_at = ?
          WHERE id = ?`, at, at, importance, now, episodeId);
        });
    }
    extendStart(episodeId, at) {
        this.db.run('UPDATE episodes SET started_at = MIN(started_at, ?) WHERE id = ?', at, episodeId);
    }
    /** 解绑（仅在重复归属纠正时使用；不会删除 Experience）。 */
    detachExperience(experienceId) {
        this.db.run('DELETE FROM episode_experiences WHERE experience_id = ?', experienceId);
    }
    /**
     * 关闭 Episode（幂等）。
     * 已经关闭的不会被重新关闭，也不会覆盖 closed_at —— 证据链里的"什么时候结束"必须稳定。
     */
    close(episodeId, endedAt, now, reason) {
        const result = this.db.run(`UPDATE episodes
          SET status = 'closed',
              ended_at = COALESCE(ended_at, ?),
              closed_at = COALESCE(closed_at, ?),
              closed_reason = COALESCE(closed_reason, ?),
              updated_at = ?
        WHERE id = ? AND status = 'open'`, endedAt, now, reason, now, episodeId);
        return result.changes > 0;
    }
    /**
     * 关闭该 scope 下所有 idle 超时的 open Episode。
     * @returns 被本次调用关闭的 Episode（供上层排摘要任务）。
     */
    closeIdle(scopeId, now, idleMs, reason = 'idle_timeout') {
        const scope = scopeWhere(scopeId);
        const candidates = this.db.all(`SELECT ${COLUMNS} FROM episodes
        WHERE ${scope.clause} AND status = 'open' AND last_experience_at > 0 AND last_experience_at <= ?`, ...scope.params, now - idleMs);
        const closed = [];
        for (const row of candidates) {
            const endedAt = Number(row.ended_at ?? row.last_experience_at ?? row.started_at);
            if (this.close(row.id, endedAt, now, reason)) {
                closed.push(mapEpisodeRow({ ...row, status: 'closed', closed_at: now, closed_reason: reason }, this.experienceIds(row.id)));
            }
        }
        return closed;
    }
    /** 启动恢复：把「很久以前还开着」的 Episode 一次性关掉（防宿主崩溃后永久 open）。 */
    closeStale(scopeId, now, idleMs) {
        return this.closeIdle(scopeId, now, idleMs, 'startup_recovery');
    }
    /** 会话结束：立刻关闭该 session 的 open Episode（不等 idle 超时）。 */
    closeBySession(sessionId, now, reason = 'session_end') {
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE session_id = ? AND status = 'open'`, sessionId);
        const closed = [];
        for (const row of rows) {
            const endedAt = Number(row.ended_at ?? row.last_experience_at ?? row.started_at);
            if (this.close(row.id, endedAt, now, reason)) {
                closed.push(mapEpisodeRow({ ...row, status: 'closed', closed_at: now, closed_reason: reason }, this.experienceIds(row.id)));
            }
        }
        return closed;
    }
    updateDerived(episodeId, patch, now) {
        const sets = [];
        const params = [];
        const push = (column, value) => {
            sets.push(`${column} = ?`);
            params.push(value);
        };
        if (patch.title !== undefined)
            push('title', patch.title);
        if (patch.summary !== undefined)
            push('summary', patch.summary);
        if (patch.topics !== undefined)
            push('topics_json', serializeStringArray(patch.topics));
        if (patch.participants !== undefined)
            push('participants_json', serializeStringArray(patch.participants));
        if (patch.locations !== undefined)
            push('locations_json', serializeStringArray(patch.locations));
        if (patch.importance !== undefined)
            push('importance', clamp01(patch.importance));
        if (patch.salience !== undefined)
            push('salience', clamp01(patch.salience));
        if (patch.confidence !== undefined)
            push('confidence', clamp01(patch.confidence));
        if (patch.embeddingStatus !== undefined)
            push('embedding_status', patch.embeddingStatus);
        if (patch.summaryStatus !== undefined)
            push('summary_status', patch.summaryStatus);
        if (sets.length === 0)
            return;
        push('updated_at', now);
        params.push(episodeId);
        this.db.run(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }
    setSummaryStatus(episodeId, status, now) {
        this.db.run('UPDATE episodes SET summary_status = ?, updated_at = ? WHERE id = ?', status, now, episodeId);
    }
    /**
     * Stage 3：长期记忆整理状态。独立于 Episode 主状态（spec §13）：
     * 整理失败不会让 Episode 回退，也不会影响摘要与召回。
     */
    setConsolidationStatus(episodeId, status, now) {
        this.db.run('UPDATE episodes SET consolidation_status = ?, updated_at = ? WHERE id = ?', status, now, episodeId);
    }
    /**
     * Stage 4.5：Episode 连续性分析状态。
     * 独立于 consolidation_status —— 连续性可以重跑，失败也不能影响整理结果。
     */
    setContinuityStatus(episodeId, status, now) {
        this.db.run('UPDATE episodes SET continuity_status = ?, updated_at = ? WHERE id = ?', status, now, episodeId);
    }
    /**
     * Stage 4.5：可以进入连续性分析的 Episode：已关闭 + 摘要就绪 + 还没分析过。
     * 只看 scope 内实例，不跨 scope 关联（scope 是硬边界）。
     */
    listPendingContinuity(scopeId, limit = 20) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes
        WHERE ${scope.clause}
          AND status <> 'open'
          AND summary_status = 'ready'
          AND continuity_status = 'pending'
        ORDER BY COALESCE(ended_at, started_at) ASC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    /** 各连续性分析状态的数量（status API 用）。 */
    countContinuity(scopeId) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT continuity_status, COUNT(*) AS total FROM episodes
        WHERE ${scope.clause} AND status <> 'open'
        GROUP BY continuity_status`, ...scope.params);
        const out = { pending: 0, ready: 0, failed: 0, disabled: 0 };
        for (const row of rows) {
            const key = row.continuity_status;
            if (key === 'pending' || key === 'ready' || key === 'failed' || key === 'disabled') {
                out[key] = Number(row.total ?? 0);
            }
        }
        return out;
    }
    /** 重建 episode 的 FTS 文档（标题 + 摘要 + 拼接的经历正文）。 */
    refreshSearchIndex(episodeId, body) {
        if (!this.db.ftsAvailable)
            return;
        try {
            const row = this.db.get('SELECT title, summary FROM episodes WHERE id = ?', episodeId);
            if (!row)
                return;
            this.db.run('DELETE FROM episode_fts WHERE episode_id = ?', episodeId);
            this.db.run('INSERT INTO episode_fts (episode_id, title, summary, body) VALUES (?, ?, ?, ?)', episodeId, 
            // 中文没有空格分词，必须走 JS bigram（与 experience_fts 一致），
            // 否则 unicode61 会把整句当成一个 token，关键词永远匹配不到。
            toFtsText(row.title ?? ''), toFtsText(row.summary ?? ''), toFtsText(body));
        }
        catch {
            // FTS 失败只影响召回精度，不影响 Episode 本身。
        }
    }
    /**
     * 重建全表 episode_fts（一次性修复历史数据）。
     *
     * 早期版本把中文原文直接写进 FTS 列，unicode61 分词器会把整句当成一个 token，
     * 于是「Episode 关键词召回」在中文库上永远为空。这里用与 experience_fts 相同的
     * bigram 文本重建一次，幂等且只做 SQLite 读写。
     */
    rebuildSearchIndexes(limit = 5000) {
        if (!this.db.ftsAvailable)
            return 0;
        let rebuilt = 0;
        try {
            const rows = this.db.all('SELECT id, title, summary FROM episodes ORDER BY started_at DESC LIMIT ?', limit);
            for (const row of rows) {
                const bodies = this.db.all(`SELECT experiences.content AS content
             FROM episode_experiences
             JOIN experiences ON experiences.id = episode_experiences.experience_id
            WHERE episode_experiences.episode_id = ?
            ORDER BY episode_experiences.position ASC`, row.id);
                const body = bodies.map((item) => item.content).join('\n').slice(0, 4000);
                this.db.run('DELETE FROM episode_fts WHERE episode_id = ?', row.id);
                this.db.run('INSERT INTO episode_fts (episode_id, title, summary, body) VALUES (?, ?, ?, ?)', row.id, toFtsText(row.title ?? ''), toFtsText(row.summary ?? ''), toFtsText(body));
                rebuilt += 1;
            }
        }
        catch (error) {
            console.warn(`[memory-sea] episode FTS 重建失败: ${error.message}`);
        }
        return rebuilt;
    }
    experienceIds(episodeId) {
        const rows = this.db.all('SELECT experience_id FROM episode_experiences WHERE episode_id = ? ORDER BY position ASC', episodeId);
        return rows.map((row) => row.experience_id);
    }
    recent(scopeId, options = {}) {
        const scope = scopeWhere(scopeId);
        const time = buildTimeFilters(options, 'COALESCE(ended_at, started_at)');
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE ${scope.clause} AND ${time.clause}
       ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`, ...scope.params, ...time.params, clampLimit(options.limit ?? 50));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    findByLike(scopeId, terms, options = {}) {
        const cleaned = terms.filter((term) => term.length > 0);
        if (cleaned.length === 0)
            return [];
        const scope = scopeWhere(scopeId);
        const time = buildTimeFilters(options, 'COALESCE(ended_at, started_at)');
        const likeClause = cleaned
            .map(() => '(instr(lower(COALESCE(title, \'\')), lower(?)) > 0 OR instr(lower(COALESCE(summary, \'\')), lower(?)) > 0)')
            .join(' OR ');
        const likeParams = [];
        for (const term of cleaned) {
            likeParams.push(term, term);
        }
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE ${scope.clause} AND (${likeClause}) AND ${time.clause}
       ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`, ...scope.params, ...likeParams, ...time.params, clampLimit(options.limit ?? 100));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    listForScene(scopeId, maxEpisodes) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT * FROM (
         SELECT ${COLUMNS}, rowid AS seq FROM episodes WHERE ${scope.clause}
         ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?
       ) ORDER BY COALESCE(ended_at, started_at) ASC, seq ASC`, ...scope.params, clampLimit(maxEpisodes));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    listOpen(scopeId) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE ${scope.clause} AND status = 'open' ORDER BY started_at ASC`, ...scope.params);
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    /** 后台摘要任务：已关闭但摘要还没就绪的 Episode。 */
    listPendingSummary(scopeId, limit = 50) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes
        WHERE ${scope.clause} AND summary_status = 'pending' AND status <> 'open'
        ORDER BY COALESCE(ended_at, started_at) ASC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    /**
     * Stage 3：可以进入长期记忆整理的 Episode。
     * 条件（spec §12）：已关闭 + 摘要就绪 + 还没整理过。
     * embedding 是增强项，绝不作为筛选条件 —— 没有向量也要能整理。
     */
    listPendingConsolidation(scopeId, limit = 25) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes
        WHERE ${scope.clause}
          AND status <> 'open'
          AND summary_status = 'ready'
          AND consolidation_status = 'pending'
        ORDER BY COALESCE(ended_at, started_at) ASC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    /** 各整理状态的数量（status API 用）。 */
    countConsolidation(scopeId) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT consolidation_status, COUNT(*) AS total FROM episodes
        WHERE ${scope.clause} AND status <> 'open'
        GROUP BY consolidation_status`, ...scope.params);
        const out = { pending: 0, ready: 0, failed: 0, disabled: 0 };
        for (const row of rows) {
            const key = row.consolidation_status;
            if (key === 'pending' || key === 'ready' || key === 'failed' || key === 'disabled') {
                out[key] = Number(row.total ?? 0);
            }
        }
        return out;
    }
    /** 后台 embedding 任务：还没算出 Episode 级向量的 Episode。 */
    listPendingEmbedding(scopeId, limit = 50) {
        const scope = scopeWhere(scopeId);
        const rows = this.db.all(`SELECT ${COLUMNS} FROM episodes WHERE ${scope.clause} AND embedding_status = 'pending'
       ORDER BY COALESCE(ended_at, started_at) ASC LIMIT ?`, ...scope.params, clampLimit(limit));
        return rows.map((row) => mapEpisodeRow(row, this.experienceIds(row.id)));
    }
    count(scopeId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT COUNT(*) AS total FROM episodes WHERE ${scope.clause}`, ...scope.params);
        return Number(row?.total ?? 0);
    }
    countOpen(scopeId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT COUNT(*) AS total FROM episodes WHERE ${scope.clause} AND status = 'open'`, ...scope.params);
        return Number(row?.total ?? 0);
    }
    /** 数据库里出现过的全部 scope（启动时用于收割陈旧 Episode / 补排任务）。 */
    listScopeIds() {
        return this.db
            .all('SELECT DISTINCT scope_id FROM episodes WHERE scope_id IS NOT NULL ORDER BY scope_id')
            .map((row) => row.scope_id);
    }
    countClosed(scopeId) {
        const scope = scopeWhere(scopeId);
        const row = this.db.get(`SELECT COUNT(*) AS total FROM episodes WHERE ${scope.clause} AND status <> 'open'`, ...scope.params);
        return Number(row?.total ?? 0);
    }
}
export function mapEpisodeRow(row, experienceIds) {
    const closedReason = asClosedReason(row.closed_reason);
    return {
        id: row.id,
        ...(row.title ? { title: row.title } : {}),
        startedAt: Number(row.started_at),
        ...(row.ended_at === null || row.ended_at === undefined ? {} : { endedAt: Number(row.ended_at) }),
        experienceIds: [...experienceIds],
        ...(row.summary ? { summary: row.summary } : {}),
        participants: parseStringArray(row.participants_json),
        locations: parseStringArray(row.locations_json),
        topics: parseStringArray(row.topics_json),
        importance: clamp01(Number(row.importance)),
        salience: clamp01(Number(row.salience)),
        confidence: clamp01(Number(row.confidence)),
        status: asEpisodeStatus(row.status),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        embeddingStatus: asEmbeddingStatus(row.embedding_status),
        lastExperienceAt: Number(row.last_experience_at ?? row.ended_at ?? row.started_at ?? 0),
        ...(row.closed_at === null || row.closed_at === undefined ? {} : { closedAt: Number(row.closed_at) }),
        ...(closedReason ? { closedReason } : {}),
        summaryStatus: asProcessingStatus(row.summary_status, 'pending'),
        consolidationStatus: asProcessingStatus(row.consolidation_status, 'pending'),
        continuityStatus: asProcessingStatus(row.continuity_status, 'pending'),
        ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    };
}
const CLOSED_REASONS = new Set([
    'idle_timeout',
    'session_end',
    'manual',
    'startup_recovery',
    'topic_shift',
]);
function asClosedReason(value) {
    return typeof value === 'string' && CLOSED_REASONS.has(value)
        ? value
        : undefined;
}
function clampLimit(value) {
    if (!Number.isFinite(value))
        return 100;
    return Math.min(10_000, Math.max(1, Math.round(value)));
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(1, Math.max(0, value));
}
