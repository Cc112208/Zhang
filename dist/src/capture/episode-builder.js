/**
 * episode-builder.ts —— Episode 的创建、归属与派生字段（spec §8 / §9 / §10）。
 *
 * V0.2 刻意**不用** LLM 聚类，只用确定性规则：
 *
 *   同一 session
 *   + 上一条 Experience 距当前 < episodeIdleMs（默认 20 分钟）
 *   = 进入当前 open Episode；否则关闭旧 Episode、开新的
 *
 * 为什么这里不做摘要 / embedding：capture 是同步快路径（spec §11），
 * 摘要与向量都属于「以后放后台」的工作，由 Stage 2 的 JobRunner 处理。
 *
 * 派生字段（topics/participants/locations/importance/salience/confidence）每次归属后
 * 从 Episode 全部经历重算：O(当前 Episode 长度)，换来「Episode 永远自洽」。
 */
import { randomUUID } from 'node:crypto';
import { extractKeywords, firstSentence } from '../recall/tokenizer.js';
import { extractLocations, extractParticipants, looksLikeStructuredText, stripRuntimeLines, looksLikePathHeavy, looksLikeToolOutput, trimTitle, } from '../util/text.js';
/** 本阶段允许写入的 Episode 状态（consolidated/archived 属于未来 Dream 阶段）。 */
export const WRITABLE_EPISODE_STATUSES = ['open', 'closed'];
/** 参与 Episode 分组的来源类型（全部来源都进 Episode；这个常量只表达设计边界）。 */
export const EPISODE_GROUPING_SOURCE_TYPES = [
    'chat',
    'tool',
    'manual',
    'diary',
    'file',
    'web',
];
/**
 * 标题来源优先级：一段经历里最「像人说的话」的那条决定 Episode 标题。
 * chat > diary > manual > file/web > tool（工具回执通常是 JSON，不适合当标题）。
 */
export const TITLE_SOURCE_PRIORITY = {
    chat: 5,
    diary: 4,
    manual: 3,
    file: 2,
    web: 2,
    tool: 1,
};
/** 无可用标题时的兜底。 */
export const FALLBACK_TITLE = '工具与操作记录';
/** 最后活动时间：优先 lastExperienceAt（Stage 2 新增列），再退回 endedAt / startedAt。 */
export function lastActivity(episode) {
    const candidates = [episode.lastExperienceAt, episode.endedAt ?? 0, episode.startedAt];
    return candidates.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0);
}
/** 标题派生（无 LLM）：经历第一句，去掉宿主注入行与 markdown 前缀，截断 28 字。 */
export function deriveTitle(experience) {
    if (!experience)
        return undefined;
    if (looksLikeStructuredText(experience.content))
        return undefined;
    const cleaned = stripRuntimeLines(experience.content);
    if (cleaned.length === 0)
        return undefined;
    const title = trimTitle(firstSentence(cleaned, 28), 28);
    return title.length >= 2 ? title : undefined;
}
/**
 * Episode 标题 = 整段经历里最适合当标题的一条（确定性，不调模型）：
 * 来源优先级最高的优先，同优先级保留最早出现的那条，保证标题稳定不跳动。
 */
export function pickTitle(experiences) {
    let best;
    for (const experience of experiences) {
        const title = deriveTitle(experience);
        if (!title)
            continue;
        const score = TITLE_SOURCE_PRIORITY[experience.sourceType] ?? 0;
        if (!best || score > best.score)
            best = { score, title };
    }
    return best?.title;
}
export class EpisodeBuilder {
    experiences;
    episodes;
    scopeId;
    episodeIdleMs;
    nowFn;
    onEpisodeClosed;
    constructor(deps) {
        this.experiences = deps.experiences;
        this.episodes = deps.episodes;
        this.scopeId = deps.scopeId;
        this.episodeIdleMs = deps.episodeIdleMs;
        this.nowFn = deps.now ?? (() => Date.now());
        this.onEpisodeClosed = deps.onEpisodeClosed;
    }
    now() {
        return this.nowFn();
    }
    /**
     * 把一条 Experience 归入 Episode（spec §9 主流程第 3–5 步）。调用前必须已持久化。
     *
     * 幂等：若该 Experience 已经属于某 Episode（重放/重复事件），先解绑再重新归属，
     * 保证「一个 Experience 最多属于一个 Episode」在应用层成立（数据库层还有 UNIQUE 兜底）。
     */
    assign(experience) {
        const now = this.now();
        const sessionId = experience.sessionId ?? null;
        // 重复捕获同一事件：如果现有归属还有效，直接沿用它（不制造新 Episode）。
        if (experience.episodeId) {
            const current = this.episodes.get(experience.episodeId);
            if (current && !this.isExpired(current, now)) {
                this.refreshDerived(current.id, now);
                return { episode: this.episodes.get(current.id) ?? current, created: false, closedPrevious: null };
            }
            this.episodes.detachExperience(experience.id);
        }
        const open = this.episodes.findOpen(this.scopeId, sessionId);
        let closedPrevious = null;
        if (open && !this.isExpired(open, now)) {
            this.appendTo(open, experience, now);
            this.refreshDerived(open.id, now);
            return { episode: this.episodes.get(open.id) ?? open, created: false, closedPrevious };
        }
        if (open) {
            const endedAt = lastActivity(open) || open.startedAt;
            if (this.episodes.close(open.id, endedAt, now, 'idle_timeout')) {
                const closed = this.episodes.get(open.id) ?? { ...open, status: 'closed' };
                closedPrevious = closed;
                this.notifyClosed(closed, 'idle_timeout');
            }
        }
        const created = this.createEpisode(experience, now);
        this.appendTo(created, experience, now);
        this.refreshDerived(created.id, now);
        return { episode: this.episodes.get(created.id) ?? created, created: true, closedPrevious };
    }
    /** idle 超时的 open Episode 全部关闭（定时 Sweeper 与启动恢复共用）。 */
    closeIdleEpisodes(now = this.now(), reason = 'idle_timeout') {
        const closed = this.episodes.closeIdle(this.scopeId, now, this.episodeIdleMs, reason);
        for (const episode of closed)
            this.notifyClosed(episode, reason);
        return closed;
    }
    /** 启动恢复：把宿主崩溃前遗留的 open Episode 关掉，避免永久 open。 */
    closeStaleEpisodes(now = this.now()) {
        return this.closeIdleEpisodes(now, 'startup_recovery');
    }
    /** 会话结束：立刻关闭该 session 的 open Episode，不等 idle 超时。 */
    closeForSession(sessionId, now = this.now()) {
        const closed = this.episodes.closeBySession(sessionId, now, 'session_end');
        for (const episode of closed)
            this.notifyClosed(episode, 'session_end');
        return closed;
    }
    /** 超过 idle 窗口（或已关闭）即视为上一段经历已经结束。 */
    isExpired(episode, now) {
        if (episode.status !== 'open')
            return true;
        return now - lastActivity(episode) >= this.episodeIdleMs;
    }
    /**
     * 把摘要结果写回 Episode（由后台 job 调用）。
     * 摘要只影响派生字段，**不改任何原始 Experience**（证据不可变）。
     */
    applySummary(episodeId, result, now = this.now()) {
        const episode = this.episodes.get(episodeId);
        if (!episode)
            return null;
        this.episodes.updateDerived(episodeId, {
            ...(result.title ? { title: trimTitle(result.title, 28) } : {}),
            summary: result.summary.slice(0, 400),
            ...(result.topics ? { topics: result.topics.slice(0, 8) } : {}),
            ...(result.participants ? { participants: result.participants.slice(0, 6) } : {}),
            ...(result.locations ? { locations: result.locations.slice(0, 6) } : {}),
            ...(result.confidence !== undefined ? { confidence: clamp01(result.confidence) } : {}),
            summaryStatus: 'ready',
        }, now);
        this.refreshSearchIndex(episodeId);
        return this.episodes.get(episodeId);
    }
    /** 重算派生字段 + 重建 FTS 文档。V0.2 的 summary 留给后台任务，不在这里造。 */
    refreshDerived(episodeId, now = this.now()) {
        const experiences = this.experiences.listByEpisode(episodeId);
        if (experiences.length === 0)
            return;
        // 派生字段（主题/参与者/地点）只从「人写的经历」里抽：工具输出里的路径、代码、
        // 表格片段会把参与者抽成「的视听」这类噪声，对画像没有意义。
        const narrative = narrativeExperiences(experiences);
        const topics = mergeValues(narrative, (text) => extractKeywords(text, 3), 8);
        const participants = mergeValues(narrative, (text) => extractParticipants(text, 4), 6);
        const locations = mergeValues(narrative, (text) => extractLocations(text, 4), 6);
        const importance = clamp01(experiences.reduce((max, experience) => Math.max(max, clamp01(experience.importance)), 0));
        const count = experiences.length;
        // 确定性启发式：条数越多越「像一段完整经历」，salience/confidence 随之上升，但不上探到 1。
        const salience = clamp01(0.6 * importance + 0.4 * Math.min(1, count / 8));
        // 置信度只反映「证据够不够多」，不假装语义确定。
        const confidence = clamp01(0.4 + 0.3 * Math.min(1, count / 6));
        const existing = this.episodes.get(episodeId);
        this.episodes.updateDerived(episodeId, {
            title: pickTitle(experiences) ??
                (isPoorTitle(existing?.title) ? FALLBACK_TITLE : existing?.title) ??
                FALLBACK_TITLE,
            topics,
            participants,
            locations,
            importance,
            salience,
            confidence,
        }, now);
        this.refreshSearchIndex(episodeId, experiences);
    }
    /** 重建 Episode 的 FTS 文档：正文用经历原文拼接（spec §12：还没 summary 时也要可检索）。 */
    refreshSearchIndex(episodeId, experiences) {
        const items = experiences ?? this.experiences.listByEpisode(episodeId);
        const body = items
            .map((item) => item.content)
            .join(NEWLINE)
            .slice(0, 4000);
        this.episodes.refreshSearchIndex(episodeId, body);
    }
    // ---------------------------------------------------------------- 内部
    createEpisode(experience, now) {
        const episode = {
            id: `ep_${randomUUID()}`,
            title: pickTitle([experience]) ?? FALLBACK_TITLE,
            startedAt: experience.observedAt,
            endedAt: experience.observedAt,
            experienceIds: [],
            participants: extractParticipants(experience.content, 4),
            locations: extractLocations(experience.content, 4),
            topics: extractKeywords(experience.content, 5),
            importance: clamp01(experience.importance),
            salience: 0.5,
            confidence: 0.5,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            embeddingStatus: experience.embeddingStatus === 'disabled' ? 'disabled' : 'pending',
            lastExperienceAt: experience.observedAt,
            summaryStatus: 'pending',
            consolidationStatus: 'pending',
            continuityStatus: 'pending',
            scopeId: this.scopeId,
        };
        this.episodes.insertWithSession(episode, this.scopeId, experience.sessionId ?? null);
        return episode;
    }
    appendTo(episode, experience, now) {
        this.episodes.appendExperience(episode.id, experience.id, experience.observedAt, experience.importance, now);
        this.episodes.extendStart(episode.id, experience.observedAt);
        this.experiences.setEpisodeId(experience.id, episode.id);
    }
    notifyClosed(episode, reason) {
        try {
            this.onEpisodeClosed?.(episode, reason);
        }
        catch (error) {
            // 排后台任务失败不能影响 capture / sweeper 主流程。
            console.warn(`[memory-sea] Episode 关闭回调失败: ${String(error)}`);
        }
    }
}
const NEWLINE = String.fromCharCode(10);
function mergeValues(experiences, extract, max) {
    const seen = new Set();
    const out = [];
    for (const experience of experiences) {
        for (const value of extract(experience.content)) {
            if (seen.has(value))
                continue;
            seen.add(value);
            out.push(value);
            if (out.length >= max)
                return out;
        }
    }
    return out;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0.5;
    return Math.min(1, Math.max(0, value));
}
const NARRATIVE_SOURCE_TYPES = new Set(['chat', 'manual', 'diary', 'web']);
/** 只保留「人写的经历」：结构化回执 / 工具输出 / 纯宿主运行上下文不参与派生字段抽取。 */
export function narrativeExperiences(experiences) {
    const readable = experiences.filter((experience) => {
        if (typeof experience.content !== 'string')
            return false;
        if (looksLikeStructuredText(experience.content))
            return false;
        if (looksLikeToolOutput(experience.content))
            return false;
        return stripRuntimeLines(experience.content).length >= 2;
    });
    // 优先「人写的来源」：chat / manual / diary / web。工具体回执（tool/file）虽然是真实经历，
    // 但它们的正文是路径、代码、日志，进了摘要只会变成噪音；只有在完全没有人类文本时才退回使用。
    const preferred = readable.filter((experience) => NARRATIVE_SOURCE_TYPES.has(experience.sourceType));
    return preferred.length > 0 ? preferred : readable.length > 0 ? readable : experiences;
}
/** 已有标题是不是「不能给人看」的：运行时上下文行、工具输出、路径堆。 */
function isPoorTitle(title) {
    if (typeof title !== 'string')
        return true;
    if (stripRuntimeLines(title).length < 2)
        return true;
    if (looksLikeToolOutput(title))
        return true;
    if (looksLikePathHeavy(title))
        return true;
    return false;
}
