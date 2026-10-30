/**
 * capture-manager.ts —— Capture 流程编排（spec §8）。
 *
 * 顺序固定：
 *   1. 造 Experience   2. 持久化   3. 找 open Episode   4. append / 新建
 *   5. 更新时间       6. 返回 Experience + Episode
 *
 * 硬约束：capture 路径里**不做** LLM 摘要、embedding、复杂 entity extraction。
 * 只允许 O(当前 Episode 长度) 的确定性派生（topics/时间t窗），保证写入延迟可控。
 */
import { randomUUID } from 'node:crypto';
import { CaptureError, wrapError } from '../errors.js';
import { cleanText } from '../util/text.js';
export class CaptureManager {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    now() {
        return this.deps.now ? this.deps.now() : Date.now();
    }
    /** 写入一条原始经历并归入 Episode。幂等：同一 id 重复调用不会产生第二条记录。 */
    capture(input) {
        const now = this.now();
        const draft = this.buildExperience(input, now);
        let inserted;
        try {
            inserted = this.deps.experiences.insert(draft, this.deps.scopeId);
        }
        catch (error) {
            throw wrapError(CaptureError, error, '写入 Experience 失败');
        }
        if (!inserted)
            return this.handleDuplicate(draft);
        let assignment;
        try {
            assignment = this.deps.builder.assign(draft);
        }
        catch (error) {
            // Experience 已经落库（原始证据不能丢），Episode 归属失败只影响组织层。
            throw wrapError(CaptureError, error, 'Experience 已写入，但归属 Episode 失败');
        }
        const experience = { ...draft, episodeId: assignment.episode.id, scopeId: this.deps.scopeId };
        this.notifyCaptured(experience, assignment.episode);
        return {
            experience,
            episode: assignment.episode,
            createdEpisode: assignment.created,
            deduplicated: false,
            scopeId: this.deps.scopeId,
        };
    }
    /** 把 CaptureInput 变成不可变的 Experience 值。 */
    buildExperience(input, now = this.now()) {
        if (!input || typeof input !== 'object') {
            throw new CaptureError('capture 需要 CaptureInput 对象');
        }
        const content = cleanText(typeof input.content === 'string' ? input.content : '');
        if (content.length === 0) {
            throw new CaptureError('capture 的 content 不能为空');
        }
        const observedAt = finiteOr(input.observedAt, now);
        const sourceType = input.sourceType ?? 'manual';
        const importance = clamp01(typeof input.importance === 'number' && Number.isFinite(input.importance)
            ? input.importance
            : estimateImportance({ sourceType, role: input.role, content }));
        const experience = {
            id: typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : `xp_${randomUUID()}`,
            sourceType,
            content,
            // createdAt 是「写入时间」，observedAt 是「事件发生时间」，两者分开才能表达补录。
            createdAt: now,
            observedAt: Math.min(observedAt, now),
            importance,
            metadata: sanitizeMetadata(input.metadata),
            embeddingStatus: this.deps.embeddingStatus ?? 'disabled',
        };
        if (input.sourceId)
            experience.sourceId = input.sourceId;
        if (input.sessionId)
            experience.sessionId = input.sessionId;
        if (input.turnId)
            experience.turnId = input.turnId;
        if (input.role)
            experience.role = input.role;
        return experience;
    }
    // ---------------------------------------------------------------- 内部
    /** 幂等命中：返回最早写入的那份原文，绝不覆盖（spec §3.1）。 */
    handleDuplicate(draft) {
        const existing = this.deps.experiences.get(draft.id);
        if (!existing) {
            throw new CaptureError(`Experience ${draft.id} 写入冲突且读取不到，数据异常`);
        }
        if (existing.episodeId) {
            const episode = this.deps.episodes.get(existing.episodeId);
            if (episode) {
                return {
                    experience: existing,
                    episode,
                    createdEpisode: false,
                    deduplicated: true,
                    scopeId: this.deps.scopeId,
                };
            }
        }
        // 历史数据没有归属（例如上次 capture 在 Episode 阶段崩了）：补一次归属。
        const assignment = this.deps.builder.assign(existing);
        const experience = { ...existing, episodeId: assignment.episode.id, scopeId: this.deps.scopeId };
        this.notifyCaptured(experience, assignment.episode);
        return {
            experience,
            episode: assignment.episode,
            createdEpisode: assignment.created,
            deduplicated: true,
            scopeId: this.deps.scopeId,
        };
    }
    notifyCaptured(experience, episode) {
        try {
            this.deps.onCaptured?.(experience, episode);
        }
        catch (error) {
            // 排后台任务是旁路：失败只记录，绝不影响 capture 成功语义。
            console.warn(`[memory-sea] capture 后置钩子失败: ${String(error)}`);
        }
    }
}
/**
 * 重要度启发式（确定性，可解释，无模型）：
 *   基线 0.35；用户原话 +0.1；manual（Agent 明确记住）+0.25；长内容 +0.05；
 *   含「记住 / 重要 / 必须 / 决定」等信号 +0.15。上限 1。
 */
export function estimateImportance(input) {
    let score = 0.35;
    if (input.role === 'user')
        score += 0.1;
    if (input.sourceType === 'manual')
        score += 0.25;
    if (input.sourceType === 'diary')
        score += 0.15;
    // 工具结果是原始证据，但绝大多数是过程性输出（日志、文件片段），
    // 默认不该和用户亲口说的话同等重要，否则会稀释召回质量。
    if (input.sourceType === 'tool')
        score -= 0.2;
    if (input.content.length > 120)
        score += 0.05;
    if (input.content.length > 1200)
        score -= 0.05;
    if (/(记住|重要|必须|不要忘|决定|结论|承诺)/u.test(input.content))
        score += 0.15;
    return clamp01(score);
}
function sanitizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof key !== 'string' || key.length === 0)
            continue;
        // 只保留可 JSON 序列化的值与有限大小，避免把巨型对象写进数据库。
        try {
            const json = JSON.stringify(value);
            if (json === undefined)
                continue;
            if (json.length > 4000)
                continue;
            out[key] = value;
        }
        catch {
            continue;
        }
    }
    return out;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0.5;
    return Math.min(1, Math.max(0, value));
}
function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
