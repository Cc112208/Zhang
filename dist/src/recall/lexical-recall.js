/**
 * lexical-recall.ts —— FTS5 关键词召回（spec §12）。
 *
 * 检索字段：Experience.content；Episode.title + summary（summary 为空时由 EpisodeBuilder
 * 把 Experience 原文拼进 body 列，见 episode-repository.refreshSearchIndex）。
 *
 * 降级（spec §21）：FTS 不可用 / MATCH 语法出错时自动走普通 SQLite LIKE（instr）检索。
 * 本模块只负责「谁命中、命中多强」，不做跨 lane 融合。
 */
import { TABLES, scopeWhere } from '../storage/schema.js';
import { likeTerms, toFtsQuery } from './tokenizer.js';
const DEFAULT_LANE_LIMIT = 40;
export class LexicalRecall {
    db;
    experiences;
    episodes;
    constructor(deps) {
        this.db = deps.db;
        this.experiences = deps.experiences;
        this.episodes = deps.episodes;
    }
    get ftsAvailable() {
        return this.db.ftsAvailable;
    }
    search(query, options) {
        const types = options.types ?? ['experience', 'episode'];
        const limit = clampLimit(options.limit);
        const hits = [];
        for (const type of types) {
            if (type === 'experience')
                hits.push(...this.searchExperiences(query, options, limit));
            else
                hits.push(...this.searchEpisodes(query, options, limit));
        }
        return hits;
    }
    // ---------------------------------------------------------------- Experience lane
    searchExperiences(query, options, limit) {
        if (this.db.ftsAvailable) {
            const ftsHits = this.ftsSearch('experience', query, options, limit);
            if (ftsHits !== null)
                return ftsHits;
        }
        return this.likeSearchExperiences(query, options, limit);
    }
    searchEpisodes(query, options, limit) {
        if (this.db.ftsAvailable) {
            const ftsHits = this.ftsSearch('episode', query, options, limit);
            if (ftsHits !== null)
                return ftsHits;
        }
        return this.likeSearchEpisodes(query, options, limit);
    }
    /** 返回 null 表示 FTS 路径不可用（语法错误等），调用方转 LIKE。 */
    ftsSearch(type, query, options, limit) {
        const match = toFtsQuery(query);
        if (!match)
            return [];
        // 作用域过滤要带表名前缀（这里同时 join 了 FTS 表与主表）。
        const scoped = scopeWhere(options.scopeId, type === 'experience' ? 'experiences' : 'episodes');
        const params = [match, ...scoped.params];
        const timeClause = [];
        if (typeof options.after === 'number') {
            timeClause.push(`${type === 'experience' ? 'experiences.observed_at' : 'COALESCE(episodes.ended_at, episodes.started_at)'} > ?`);
            params.push(options.after);
        }
        if (typeof options.before === 'number') {
            timeClause.push(`${type === 'experience' ? 'experiences.observed_at' : 'COALESCE(episodes.ended_at, episodes.started_at)'} < ?`);
            params.push(options.before);
        }
        params.push(limit);
        const sql = type === 'experience'
            ? `SELECT ${TABLES.experienceFts}.experience_id AS id, bm25(${TABLES.experienceFts}) AS rank
           FROM ${TABLES.experienceFts}
           JOIN ${TABLES.experiences} ON ${TABLES.experiences}.id = ${TABLES.experienceFts}.experience_id
           WHERE ${TABLES.experienceFts} MATCH ?
             AND ${scoped.clause}
             ${timeClause.map((clause) => `AND ${clause}`).join(' ')}
           ORDER BY rank ASC
           LIMIT ?`
            : `SELECT ${TABLES.episodeFts}.episode_id AS id, bm25(${TABLES.episodeFts}) AS rank
           FROM ${TABLES.episodeFts}
           JOIN ${TABLES.episodes} ON ${TABLES.episodes}.id = ${TABLES.episodeFts}.episode_id
           WHERE ${TABLES.episodeFts} MATCH ?
             AND ${scoped.clause}
             ${timeClause.map((clause) => `AND ${clause}`).join(' ')}
           ORDER BY rank ASC
           LIMIT ?`;
        try {
            const rows = this.db.all(sql, ...params);
            // bm25 的绝对值随语料规模/文档长度漂移（小库里常见 1e-6 量级），
            // 直接做 strength/(strength+2) 会把真实命中压成 0 分。这里按「本次查询的最强命中」
            // 做相对饱和：最强=1，其它命中落在 0.35..1，保证「命中了」在融合分里看得见。
            const strengths = rows.map((row) => Math.max(0, -Number(row.rank ?? 0)));
            const top = strengths.reduce((max, value) => Math.max(max, value), 0);
            return rows.map((row, index) => {
                const strength = strengths[index] ?? 0;
                const score = top > 0 && strength > 0 ? Math.round((0.35 + 0.65 * (strength / top)) * 1e4) / 1e4 : 0;
                return { id: row.id, type, strength, score };
            });
        }
        catch (error) {
            console.warn(`[memory-sea] FTS 查询失败，降级 LIKE: ${error.message}`);
            return null;
        }
    }
    likeSearchExperiences(query, options, limit) {
        const terms = likeTerms(query);
        const rows = this.experiences.findByLike(options.scopeId, terms, {
            limit,
            ...(typeof options.after === 'number' ? { after: options.after } : {}),
            ...(typeof options.before === 'number' ? { before: options.before } : {}),
        });
        return rows.map((row) => {
            const matched = terms.filter((term) => row.content.includes(term)).length;
            const strength = matched;
            return { id: row.id, type: 'experience', strength, score: likeScore(matched, terms.length) };
        });
    }
    likeSearchEpisodes(query, options, limit) {
        const terms = likeTerms(query);
        const rows = this.episodes.findByLike(options.scopeId, terms, {
            limit,
            ...(typeof options.after === 'number' ? { after: options.after } : {}),
            ...(typeof options.before === 'number' ? { before: options.before } : {}),
        });
        return rows.map((row) => {
            const haystack = `${row.title ?? ''} ${row.summary ?? ''} ${row.topics.join(' ')}`;
            const matched = terms.filter((term) => haystack.includes(term)).length;
            return { id: row.id, type: 'episode', strength: matched, score: likeScore(matched, terms.length) };
        });
    }
}
function likeScore(matched, total) {
    if (matched === 0 || total === 0)
        return 0;
    // 命中占比 60% + 绝对命中数 40%，两者都饱和到 1。
    return Math.min(1, 0.6 * (matched / total) + 0.4 * Math.min(1, matched / 3));
}
function clampLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_LANE_LIMIT;
    return Math.min(200, Math.max(1, Math.round(value)));
}
