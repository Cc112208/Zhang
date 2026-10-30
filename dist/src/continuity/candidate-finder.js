/**
 * candidate-finder.ts —— 为「新 Episode 是否延续旧 Episode」准备确定性候选（Stage 4.5）。
 *
 * 流程：Episode close + summary ready → 同 scope 近期 Episode（lookback 内、按时间倒序）
 * → 提取每条的 actor / thread / topic / token / 文本特征 → 交给 analyzer 判定关系。
 *
 * 这里不做任何 LLM 调用，也不改写 Episode 内容（spec §21 / §22）。
 */
import { knownActorIds, normalizeActorIdentity, strongActorIds } from './actor-identity.js';
import { bigramSimilarity, tokenize } from '../recall/tokenizer.js';
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CANDIDATES = 10;
const DEFAULT_MAX_EXPERIENCES = 6;
const MAX_TEXT_CHARS = 600;
export class ContinuityCandidateFinder {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    build(scopeId, episode, options = {}) {
        const lookbackMs = Math.max(1, options.lookbackMs ?? DEFAULT_LOOKBACK_MS);
        const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
        const maxExperiences = Math.max(1, options.maxExperiencesPerEpisode ?? DEFAULT_MAX_EXPERIENCES);
        const now = this.deps.now();
        const anchor = episodeAnchor(episode);
        const trigger = this.profileOf(episode, maxExperiences);
        // 多取一些以补偿过滤开销；最终只保留 lookback 内、且不是自己的 Episode。
        const pool = this.deps.episodes.recent(scopeId, { limit: Math.max(12, maxCandidates * 3) });
        const candidates = [];
        for (const candidate of pool) {
            if (candidate.id === episode.id)
                continue;
            if (candidate.status === 'open')
                continue;
            const at = episodeAnchor(candidate);
            if (!Number.isFinite(at))
                continue;
            if (anchor - at > lookbackMs)
                continue;
            const profile = this.profileOf(candidate, maxExperiences);
            candidates.push({
                profile,
                gapMs: Math.max(0, anchor - at),
                similarity: round4(bigramSimilarity(trigger.text, profile.text, MAX_TEXT_CHARS)),
            });
        }
        candidates.sort((left, right) => left.gapMs - right.gapMs);
        return {
            scopeId,
            trigger,
            candidates: candidates.slice(0, maxCandidates),
        };
    }
    /** 只把特征提到外部分析器，不在这里决定关系。 */
    profile(episode, options = {}) {
        return this.profileOf(episode, Math.max(1, options.maxExperiencesPerEpisode ?? DEFAULT_MAX_EXPERIENCES));
    }
    profileOf(episode, maxExperiences) {
        let experiences = [];
        try {
            experiences = this.deps.experiences.listByEpisode(episode.id);
        }
        catch {
            experiences = [];
        }
        const trimmed = experiences.slice(0, maxExperiences);
        const actorIds = new Set();
        const strong = new Set();
        const threadKeys = new Set();
        for (const experience of experiences) {
            const metadata = experience.metadata ?? {};
            // 身份规范化统一走 actor-identity：昵称不参与，平台稳定 ID 优先。
            for (const actorId of knownActorIds(metadata))
                actorIds.add(actorId);
            for (const actorId of strongActorIds(metadata))
                strong.add(actorId);
            if (normalizeActorIdentity(metadata) === null && typeof metadata.actorId === 'string') {
                actorIds.add(metadata.actorId);
            }
            const threadKey = metadata.threadKey;
            if (typeof threadKey === 'string' && threadKey.length > 0)
                threadKeys.add(threadKey);
        }
        const pieces = [];
        if (episode.title)
            pieces.push(episode.title);
        if (episode.summary)
            pieces.push(episode.summary);
        for (const experience of trimmed) {
            if (typeof experience.content === 'string' && experience.content.length > 0) {
                pieces.push(experience.content);
            }
        }
        const text = pieces.join(' ').slice(0, MAX_TEXT_CHARS);
        const topics = [...new Set([...(episode.topics ?? []), ...tokenize(text).slice(0, 12)])];
        const actorConfidence = strong.size > 0 ? 'high' : actorIds.size > 0 ? 'medium' : 'none';
        return {
            episode,
            actorIds: [...actorIds],
            strongActorIds: [...strong],
            actorConfidence,
            threadKeys: [...threadKeys],
            topics: topics.slice(0, 16),
            tokens: tokenize(text).slice(0, 24),
            text,
        };
    }
}
export function episodeAnchor(episode) {
    const value = episode.endedAt ?? episode.lastExperienceAt ?? episode.startedAt;
    return Number.isFinite(value) ? Number(value) : Number.NaN;
}
function round4(value) {
    return Math.round(value * 10_000) / 10_000;
}
