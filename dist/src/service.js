/**
 * service.ts —— MemorySeaService（spec §15 / Stage 2 §2）。
 *
 * 唯一的门面：捕获、召回、检查、场景、后台任务状态全部从这里出。
 * 宿主插件、Agent 工具、Scene 适配层都不应该直接碰 repository 或 SQL。
 *
 * Stage 2 的三个结构性变化：
 *   1. **scope 不固化**：每次调用按 session 的 cwd 解析 scopeId，读写都带 scope_id；
 *   2. **Episode 生命周期可收割**：EpisodeBuilder 提供关闭事件，Sweeper 定期收割 idle Episode；
 *   3. **后台可插拔**：摘要与 embedding 都走持久化 Job 队列（JobRunner），
 *      崩溃后重启会补排 pending 任务，不丢工作。
 *
 * 错误边界（spec §21）：
 *   构造失败 → 抛 StorageError，由 index.ts 降级成「插件不可用但宿主照常跑」；
 *   capture / recall 失败 → 抛 MemorySeaError 子类，宿主继续运行；
 *   摘要 / embedding / FTS 失败 → 各自通道降级，绝不影响 Experience 的原始事实。
 */
import { resolveConfig } from './config.js';
import { MemoryDatabase } from './storage/database.js';
import { ExperienceRepository } from './storage/repositories/experience-repository.js';
import { EpisodeRepository } from './storage/repositories/episode-repository.js';
import { EpisodeBuilder } from './capture/episode-builder.js';
import { CaptureManager } from './capture/capture-manager.js';
import { EpisodeSweeper } from './capture/episode-sweeper.js';
import { LexicalRecall } from './recall/lexical-recall.js';
import { TemporalRecall } from './recall/temporal-recall.js';
import { RecallEngine } from './recall/recall-engine.js';
import { NullSemanticRecall, SqliteSemanticRecall } from './recall/semantic-recall.js';
import { createEmbeddingProvider } from './embedding/embedding-provider.js';
import { EmbeddingRepository, contentHashOf } from './embedding/embedding-repository.js';
import { createEpisodeSummarizer } from './summary/episode-summarizer.js';
import { MemoryRepository } from './memory/memory-repository.js';
import { EvidenceRepository } from './memory/evidence-repository.js';
import { ConsolidationCandidateFinder } from './consolidation/candidate-finder.js';
import { ConsolidationApplier } from './consolidation/consolidation-applier.js';
import { createMemoryConsolidator, } from './consolidation/memory-consolidator.js';
import { DreamRunner } from './dream/dream-runner.js';
import { EpisodeRelationRepository, } from './continuity/episode-relation-repository.js';
import { ContinuityCandidateFinder } from './continuity/candidate-finder.js';
import { RuleBasedContinuityAnalyzer } from './continuity/continuity-analyzer.js';
import { PatternRepository } from './pattern/pattern-repository.js';
import { PatternEvidenceRepository } from './pattern/pattern-evidence-repository.js';
import { PatternCandidateFinder } from './pattern-analysis/candidate-finder.js';
import { PatternApplier } from './pattern-analysis/pattern-applier.js';
import { createPatternAnalyzer } from './pattern-analysis/pattern-analyzer.js';
import { MemoryReviewService } from './review/memory-review-service.js';
import { SkillCandidateRepository } from './skill/candidate-repository.js';
import { SkillAttemptRepository } from './skill/attempt-repository.js';
import { SkillService } from './skill/skill-service.js';
import { assessSummaryQuality } from './summary/summary-quality.js';
import { auditActorMetadata, actorMetadataPatch, classifyActorMetadata } from './continuity/actor-identity.js';
import { ContextualRecall } from './recall/contextual-recall.js';
import { JobRepository } from './jobs/job-repository.js';
import { JobRunner } from './jobs/job-runner.js';
import { ScopeResolver } from './scope/scope-resolver.js';
import { SceneBuilder } from './scene/scene-builder.js';
import { toLegacyScene } from './scene/legacy-adapter.js';
import { buildGlobalScene, } from './scene/global-scene.js';
import { preview } from './util/text.js';
import { CaptureError, MemorySeaError, RecallError, StorageError, errorMessage, wrapError } from './errors.js';
const DEFAULT_MAINTENANCE_LIMIT = 25;
export class MemorySeaService {
    config;
    logger;
    now;
    db;
    experiences;
    episodes;
    scopeResolver;
    contexts = new Map();
    embedding;
    embeddingRepository;
    semantic;
    summarizer;
    lexicalRecall;
    temporalRecall;
    recallEngine;
    sceneBuilder;
    memories;
    evidence;
    consolidator;
    candidateFinder;
    applier;
    patterns;
    patternEvidence;
    skill;
    patternCandidateFinder;
    patternApplier;
    patternAnalyzer;
    reviewService;
    contextualRecall;
    relations;
    continuityFinder;
    continuityAnalyzer;
    jobs;
    runner;
    dream = null;
    maintenanceTimer = null;
    lastError;
    closed = false;
    constructor(options = {}) {
        this.config = resolveConfig(options.config, options.env);
        this.logger = options.logger ?? consoleLogger();
        this.now = options.now ?? Date.now;
        try {
            this.db = MemoryDatabase.open(this.config.databasePath);
        }
        catch (error) {
            throw wrapError(StorageError, error, `无法打开 Memory Sea 数据库：${this.config.databasePath}`);
        }
        this.experiences = new ExperienceRepository({ db: this.db });
        this.episodes = new EpisodeRepository({ db: this.db });
        this.memories = new MemoryRepository({ db: this.db, now: this.now });
        this.evidence = new EvidenceRepository({ db: this.db, now: this.now });
        // ---- scope 解析：配置只给「期望的根路径」，id 一律由规范化路径派生 ----
        this.scopeResolver = new ScopeResolver({
            ...(this.config.scope.rootPath ? { configuredRootPath: this.config.scope.rootPath } : {}),
            ...(options.hostCwd ? { hostCwd: options.hostCwd } : {}),
        });
        // ---- 可插拔能力：都是有默认实现的「零配置可用」路径 ----
        this.embedding = createEmbeddingProvider({
            enabled: this.config.embedding.enabled,
            ...(this.config.embedding.provider ? { provider: this.config.embedding.provider } : {}),
            ...(this.config.embedding.model ? { model: this.config.embedding.model } : {}),
            ...(this.config.embedding.apiKey ? { apiKey: this.config.embedding.apiKey } : {}),
            ...(this.config.embedding.baseUrl ? { baseUrl: this.config.embedding.baseUrl } : {}),
            ...(this.config.embedding.dimensions !== undefined ? { dimensions: this.config.embedding.dimensions } : {}),
            ...(this.config.embedding.timeoutMs !== undefined ? { timeoutMs: this.config.embedding.timeoutMs } : {}),
        }, envObject(options.env));
        this.embeddingRepository = this.embedding.configured
            ? new EmbeddingRepository({ db: this.db, provider: this.embedding.label, model: this.embedding.model, now: this.now })
            : null;
        this.semantic =
            this.embeddingRepository && this.embedding.provider
                ? new SqliteSemanticRecall({
                    embeddings: this.embeddingRepository,
                    embedder: this.embedding.provider,
                    logger: { warn: (message) => this.logger.warn?.(message) },
                })
                : new NullSemanticRecall();
        this.summarizer = createEpisodeSummarizer({
            enabled: this.config.summary.enabled,
            ...(this.config.summary.provider ? { provider: this.config.summary.provider } : {}),
            ...(this.config.summary.endpoint ? { endpoint: this.config.summary.endpoint } : {}),
            ...(this.config.summary.apiKey ? { apiKey: this.config.summary.apiKey } : {}),
            ...(this.config.summary.model ? { model: this.config.summary.model } : {}),
            ...(this.config.summary.timeoutMs !== undefined ? { timeoutMs: this.config.summary.timeoutMs } : {}),
        }, envObject(options.env));
        this.consolidator = createMemoryConsolidator({
            enabled: this.config.consolidation.enabled,
            provider: this.config.consolidation.provider,
            minConfidence: this.config.consolidation.minConfidence,
            autoSupersede: this.config.consolidation.autoSupersede,
            requireMultipleEvidenceForPreference: this.config.consolidation.requireMultipleEvidenceForPreference,
            ...(this.config.consolidation.endpoint ? { endpoint: this.config.consolidation.endpoint } : {}),
            ...(this.config.consolidation.apiKey ? { apiKey: this.config.consolidation.apiKey } : {}),
            ...(this.config.consolidation.model ? { model: this.config.consolidation.model } : {}),
            ...(this.config.consolidation.timeoutMs !== undefined ? { timeoutMs: this.config.consolidation.timeoutMs } : {}),
        }, envObject(options.env));
        this.candidateFinder = new ConsolidationCandidateFinder({
            episodes: this.episodes,
            memories: this.memories,
            evidence: this.evidence,
            now: this.now,
        });
        this.applier = new ConsolidationApplier({
            db: this.db,
            memories: this.memories,
            evidence: this.evidence,
            now: this.now,
            embeddingStatus: this.embedding.configured ? 'pending' : 'disabled',
        });
        this.patterns = new PatternRepository({ db: this.db, now: this.now });
        this.patternEvidence = new PatternEvidenceRepository({ db: this.db, now: this.now });
        this.skill = new SkillService({
            candidates: new SkillCandidateRepository({ db: this.db, now: this.now }),
            attempts: new SkillAttemptRepository({ db: this.db, now: this.now }),
            patterns: this.patterns,
            patternEvidence: this.patternEvidence,
            memories: this.memories,
            evidence: this.evidence,
            episodes: this.episodes,
            experiences: this.experiences,
            settings: skillSettingsOf(this.config.skill),
            now: this.now,
            logger: this.logger,
        });
        this.patternCandidateFinder = new PatternCandidateFinder({
            memories: this.memories,
            patterns: this.patterns,
            evidence: this.patternEvidence,
            now: this.now,
        });
        this.patternApplier = new PatternApplier({
            db: this.db,
            patterns: this.patterns,
            evidence: this.patternEvidence,
            now: this.now,
            minSupport: this.config.pattern.minSupport,
            activationThreshold: this.config.pattern.activationThreshold,
            embeddingStatus: this.embedding.configured ? 'pending' : 'disabled',
        });
        this.patternAnalyzer = createPatternAnalyzer({
            enabled: this.config.pattern.enabled,
            provider: this.config.pattern.provider,
            minSupport: this.config.pattern.minSupport,
            activationThreshold: this.config.pattern.activationThreshold,
            ...(this.config.pattern.endpoint ? { endpoint: this.config.pattern.endpoint } : {}),
            ...(this.config.pattern.apiKey ? { apiKey: this.config.pattern.apiKey } : {}),
            ...(this.config.pattern.model ? { model: this.config.pattern.model } : {}),
            ...(this.config.pattern.timeoutMs !== undefined ? { timeoutMs: this.config.pattern.timeoutMs } : {}),
        }, envObject(options.env));
        this.reviewService = new MemoryReviewService({
            memories: this.memories,
            patterns: this.patterns,
            now: this.now,
            settings: {
                memoryStaleAfterMs: this.config.review.memoryStaleAfterMs,
                patternStaleAfterMs: this.config.review.patternStaleAfterMs,
                maxItemsPerRun: this.config.review.maxItemsPerRun,
                memoryStaleConfidence: this.config.review.memoryStaleConfidence,
            },
        });
        this.contextualRecall = new ContextualRecall({
            memories: this.memories,
            episodes: this.episodes,
            experiences: this.experiences,
            evidence: this.evidence,
            now: this.now,
            settings: {
                maxCandidates: this.config.contextualRecall.maxCandidates,
                returningActorBoost: this.config.contextualRecall.returningActorBoost,
                recentMemoryWindowMs: this.config.contextualRecall.recentMemoryWindowMs,
            },
        });
        this.relations = new EpisodeRelationRepository({ db: this.db, now: this.now });
        this.continuityFinder = new ContinuityCandidateFinder({
            episodes: this.episodes,
            experiences: this.experiences,
            now: this.now,
        });
        this.continuityAnalyzer = new RuleBasedContinuityAnalyzer({
            minConfidence: this.config.episodeContinuity.minConfidence,
        });
        this.lexicalRecall = new LexicalRecall({
            db: this.db,
            experiences: this.experiences,
            episodes: this.episodes,
        });
        this.temporalRecall = new TemporalRecall({ now: this.now });
        this.recallEngine = new RecallEngine({
            experiences: this.experiences,
            episodes: this.episodes,
            lexical: this.lexicalRecall,
            semantic: this.semantic,
            temporal: this.temporalRecall,
            weights: this.config.recall,
            maxResults: this.config.recall.maxResults,
            memories: this.memories,
            evidence: this.evidence,
            patterns: this.patterns,
            patternEvidence: this.patternEvidence,
            now: this.now,
            expandEpisodes: this.config.recall.expandEpisodes,
            contextual: this.config.contextualRecall.enabled ? this.contextualRecall : undefined,
            relations: this.relations,
            weakQueryMaxLength: this.config.contextualRecall.weakQueryMaxLength,
            continuityMaxExpansion: this.config.episodeContinuity.enabled
                ? this.config.episodeContinuity.maxExpansionDepth
                : 0,
            onDegrade: (channel, error) => {
                this.recordError(`${channel} 召回降级：${errorMessage(error)}`);
                this.logger.warn?.(`[memory-sea] ${channel} 召回降级：${errorMessage(error)}`);
            },
        });
        this.sceneBuilder = new SceneBuilder({
            experiences: this.experiences,
            episodes: this.episodes,
            maxPoints: this.config.scene.maxPoints,
            now: this.now,
            memories: this.memories,
            evidence: this.evidence,
            patterns: this.patterns,
            patternEvidence: this.patternEvidence,
            relations: this.relations,
        });
        // ---- 后台任务层 ----
        this.jobs = new JobRepository({ db: this.db, now: this.now });
        this.runner = new JobRunner({
            jobs: this.jobs,
            handlers: {
                episode_summary: (job) => this.runEpisodeSummary(job),
                experience_embedding: (job) => this.runExperienceEmbedding(job),
                episode_embedding: (job) => this.runEpisodeEmbedding(job),
                memory_embedding: (job) => this.runMemoryEmbedding(job),
                episode_consolidation: (job) => this.runEpisodeConsolidation(job),
                memory_pattern_analysis: (job) => this.runPatternAnalysis(job),
                pattern_embedding: (job) => this.runPatternEmbedding(job),
                memory_review: (job) => this.runReview(job),
                episode_continuity: (job) => this.runEpisodeContinuity(job),
                skill_candidate_discovery: (job) => this.runSkillCandidateDiscovery(job),
                skill_candidate_reevaluate: (job) => this.runSkillCandidateReevaluate(job),
                skill_attempt_evaluate: (job) => this.runSkillAttemptEvaluate(job),
            },
            now: this.now,
            intervalMs: this.config.jobs.intervalMs,
            maxPerTick: this.config.jobs.maxPerTick,
            staleMs: this.config.jobs.staleMs,
            logger: this.logger,
        });
        this.dream = new DreamRunner({ episodes: this.episodes, jobs: this.jobs, logger: this.logger });
        this.startupMaintenance();
    }
    // ---------------------------------------------------------------- 写入
    capture(input, options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(input.sessionId, options);
        try {
            const result = this.context(scope.id).captureManager.capture(input);
            this.logger.info?.(`[memory-sea] captured ${result.experience.id} → episode ${result.episode.id}${result.createdEpisode ? '（新建）' : ''} (${scope.id})`);
            return result;
        }
        catch (error) {
            this.recordError(`capture 失败：${errorMessage(error)}`);
            this.logger.error?.('[memory-sea] capture 失败', error);
            throw wrapError(CaptureError, error, 'capture 失败');
        }
    }
    /** memory_remember 走这里：仍然写 Experience（sourceType 'manual'），绝不直接造长期记忆。 */
    remember(input, options = {}) {
        this.assertOpen();
        return this.capture({
            sourceType: 'manual',
            sourceId: 'memory_remember',
            role: 'user',
            content: input.content,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.importance !== undefined ? { importance: input.importance } : {}),
            metadata: { ...(input.metadata ?? {}), rememberedBy: 'agent' },
        }, options);
    }
    // ---------------------------------------------------------------- 召回
    async recall(request, options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(request?.sessionId, options);
        try {
            return await this.recallEngine.recall(request, scope.id);
        }
        catch (error) {
            this.recordError(`recall 失败：${errorMessage(error)}`);
            this.logger.error?.('[memory-sea] recall 失败', error);
            throw wrapError(RecallError, error, 'recall 失败');
        }
    }
    async recallDetailed(request, options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(request?.sessionId, options);
        try {
            return await this.recallEngine.recallDetailed(request, scope.id);
        }
        catch (error) {
            this.recordError(`recall 失败：${errorMessage(error)}`);
            throw wrapError(RecallError, error, 'recall 失败');
        }
    }
    // ---------------------------------------------------------------- 读取
    getExperience(id) {
        this.assertOpen();
        return this.experiences.get(id) ?? null;
    }
    getEpisode(id) {
        this.assertOpen();
        return this.episodes.get(id) ?? null;
    }
    /** Experience 详情（只读）：原始正文 + 所属 Episode 的轻量上下文。 */
    getExperienceDetail(id) {
        this.assertOpen();
        const experience = this.experiences.get(id);
        if (!experience)
            return null;
        const episodeId = experience.episodeId;
        return {
            experience,
            episode: episodeId ? (this.episodes.get(episodeId) ?? null) : null,
        };
    }
    /**
     * Episode 详情（只读）：成员经历预览 + 以该 Episode 为证据的语义记忆 + 连续性。
     * 这里只做读取与裁剪——Experience 正文不可改写，关系也不因为展示而新建。
     */
    getEpisodeDetail(episodeId, options = {}) {
        this.assertOpen();
        const episode = this.episodes.get(episodeId);
        if (!episode)
            return null;
        const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
        const experiences = this.experiences.listByEpisode(episodeId);
        const links = this.evidence.listEvidenceFor('episode', episodeId);
        const memories = [];
        for (const link of links) {
            if (memories.length >= limit)
                break;
            const memory = this.memories.getById(link.memoryId);
            if (!memory)
                continue;
            memories.push({
                memoryId: memory.id,
                kind: memory.kind,
                status: memory.status,
                content: memory.content,
                confidence: memory.confidence,
                importance: memory.importance,
                relation: link.relation,
            });
        }
        let previewTruncated = false;
        const previews = experiences.slice(0, limit).map((experience) => {
            const contentPreview = preview(experience.content, 240);
            // 预览是硬上限：只要预览短于完整单行文本，就说明这次响应被截断过。
            if (contentPreview.length < preview(experience.content, Number.MAX_SAFE_INTEGER).length)
                previewTruncated = true;
            return {
                id: experience.id,
                sourceType: experience.sourceType,
                ...(experience.role ? { role: experience.role } : {}),
                createdAt: experience.createdAt,
                observedAt: experience.observedAt,
                importance: experience.importance,
                contentPreview,
            };
        });
        return {
            episode,
            experiences: previews,
            memories,
            continuity: this.getEpisodeContinuity(episode.scopeId ?? this.defaultScope.id, episodeId, 2),
            stats: {
                experienceCount: experiences.length,
                memoryCount: links.length,
                truncated: previewTruncated || experiences.length > limit || links.length > memories.length,
            },
        };
    }
    /** 某个 Episode 的前后连续性（只读关系，不改写任何对象）。 */
    getEpisodeContinuity(scopeId, episodeId, depth = 2) {
        this.assertOpen();
        const limit = Math.max(1, Math.min(3, depth));
        const previous = this.relations.previous(scopeId, episodeId, limit);
        const next = this.relations.next(scopeId, episodeId, limit);
        return {
            // previous 的「前一段」是 relation 的 source；next 的「后一段」是 target。
            previous: previous.map((relation) => toRelationView(relation, relation.sourceEpisodeId)),
            next: next.map((relation) => toRelationView(relation, relation.targetEpisodeId)),
        };
    }
    /** scope 内的 Episode 关系（只读调试用）。 */
    listEpisodeRelations(scopeId, limit = 100) {
        this.assertOpen();
        return this.relations.listForScope(scopeId, limit);
    }
    /**
     * 关系方向统一为「source 较早 → target 较晚」，并合并同一对 Episode 的反向重复（spec §20）。
     * analyzer 给出的是 candidate → trigger，触发 Episode 可能更早，所以必须在这里按 startedAt 重排。
     */
    orderedRelations(context, links) {
        const startedAt = new Map();
        startedAt.set(context.trigger.episode.id, context.trigger.episode.startedAt);
        for (const candidate of context.candidates) {
            startedAt.set(candidate.profile.episode.id, candidate.profile.episode.startedAt);
        }
        const best = new Map();
        for (const link of links) {
            if (link.sourceEpisodeId === link.targetEpisodeId)
                continue;
            const forward = (startedAt.get(link.sourceEpisodeId) ?? 0) <= (startedAt.get(link.targetEpisodeId) ?? 0);
            const sourceEpisodeId = forward ? link.sourceEpisodeId : link.targetEpisodeId;
            const targetEpisodeId = forward ? link.targetEpisodeId : link.sourceEpisodeId;
            const key = `${sourceEpisodeId}|${targetEpisodeId}|${link.relation}`;
            const existing = best.get(key);
            if (!existing || existing.confidence < link.confidence) {
                best.set(key, {
                    sourceEpisodeId,
                    targetEpisodeId,
                    scopeId: context.scopeId,
                    relation: link.relation,
                    confidence: link.confidence,
                    reason: link.reason,
                });
            }
        }
        return [...best.values()];
    }
    /**
     * 一次性修复历史关系方向：旧版 analyzer 直接写 candidate → trigger，可能产生「source 比 target 晚」
     * 的反向行（表现为同一对 Episode 双向各一条）。按 Episode.startedAt 重排，保证 previous/next 语义正确。
     */
    repairContinuityDirections(scopeId) {
        const relations = this.relations.listForScope(scopeId, 5000);
        if (relations.length === 0)
            return 0;
        const startedAt = new Map();
        const at = (episodeId) => {
            const cached = startedAt.get(episodeId);
            if (cached !== undefined)
                return cached;
            const episode = this.episodes.get(episodeId);
            const value = episode?.startedAt ?? 0;
            startedAt.set(episodeId, value);
            return value;
        };
        let repaired = 0;
        for (const relation of relations) {
            if (at(relation.sourceEpisodeId) <= at(relation.targetEpisodeId))
                continue;
            this.relations.deleteOne(relation.sourceEpisodeId, relation.targetEpisodeId, relation.relation);
            this.relations.upsert({
                sourceEpisodeId: relation.targetEpisodeId,
                targetEpisodeId: relation.sourceEpisodeId,
                scopeId: relation.scopeId,
                relation: relation.relation,
                confidence: relation.confidence,
                reason: relation.reason,
            });
            repaired += 1;
        }
        return repaired;
    }
    /**
     * 手动补齐连续性（spec §31）：不要在启动时无限扫描。
     * 默认只处理最近 maxEpisodes 个「已关闭 + 摘要就绪 + 未分析」的 Episode。
     */
    backfillEpisodeContinuity(scopeId, options = {}) {
        this.assertOpen();
        if (!this.config.episodeContinuity.enabled)
            return 0;
        const maxEpisodes = Math.max(1, Math.min(200, options.maxEpisodes ?? 20));
        const lookbackDays = Math.max(1, Math.min(365, options.lookbackDays ?? 30));
        const pending = this.episodes.listPendingContinuity(scopeId, maxEpisodes);
        let linked = 0;
        for (const episode of pending) {
            const context = this.continuityFinder.build(scopeId, episode, {
                lookbackMs: lookbackDays * 24 * 60 * 60 * 1000,
                maxCandidates: this.config.episodeContinuity.maxCandidates,
            });
            const links = this.continuityAnalyzer.analyze(context);
            linked += this.relations.insertMany(this.orderedRelations(context, links));
            this.episodes.setContinuityStatus(episode.id, 'ready', this.now());
        }
        return linked;
    }
    // ---- Stage 4.6：摘要质量（读时计算，可重算，不改 Experience） ----
    /** 评估单个 Episode 的摘要质量；Episode 不存在返回 null。 */
    assessEpisodeSummary(episodeId) {
        this.assertOpen();
        const episode = this.episodes.get(episodeId);
        if (!episode)
            return null;
        const experiences = this.experiences.listByEpisode(episode.id);
        return {
            episodeId: episode.id,
            title: episode.title,
            summary: episode.summary,
            quality: assessSummaryQuality({
                title: episode.title,
                summary: episode.summary,
                experiences,
            }),
        };
    }
    /** 列出某个 scope 的摘要质量报告（有界取样，供只读调试接口/巡检）。 */
    listSummaryQuality(scopeId, options = {}) {
        this.assertOpen();
        const limit = Math.max(1, Math.min(200, options.limit ?? 50));
        const episodes = this.episodes.recent(scopeId, { limit });
        const items = episodes.map((episode) => {
            const experiences = this.experiences.listByEpisode(episode.id);
            return {
                episodeId: episode.id,
                title: episode.title,
                summaryStatus: episode.summaryStatus,
                quality: assessSummaryQuality({
                    title: episode.title,
                    summary: episode.summary,
                    experiences,
                }),
            };
        });
        const counts = { total: items.length, good: 0, fair: 0, poor: 0 };
        for (const item of items)
            counts[item.quality.grade] += 1;
        return { scopeId, counts, items };
    }
    /**
     * 把低质量摘要重新排队（dry-run 默认开启）。
     * 只重算派生字段：Experience 原文与 memory_evidence 一律不动。
     */
    requeueLowQualitySummaries(scopeId, options = {}) {
        this.assertOpen();
        const dryRun = options.dryRun !== false;
        const limit = Math.max(1, Math.min(200, options.limit ?? 20));
        const grades = new Set(options.grades ?? ['poor']);
        const report = this.listSummaryQuality(scopeId, { limit: Math.max(limit, 50) });
        const targets = report.items
            .filter((item) => grades.has(item.quality.grade))
            .slice(0, limit);
        const queued = [];
        if (!dryRun) {
            for (const item of targets) {
                if (this.enqueueSummary(scopeId, item.episodeId))
                    queued.push(item.episodeId);
            }
        }
        return {
            dryRun,
            scanned: report.counts.total,
            candidates: targets.map((item) => ({
                episodeId: item.episodeId,
                grade: item.quality.grade,
                score: item.quality.score,
                flags: item.quality.flags,
            })),
            queued: queued.length,
        };
    }
    // ---- Stage 4.6：身份审计与幂等回填（只补 metadata.actorId） ----
    /** 统计某 scope 的身份证据分布；不做任何猜测。 */
    auditActorIdentity(scopeId, options = {}) {
        this.assertOpen();
        const limit = Math.max(1, Math.min(2000, options.limit ?? 500));
        const rows = this.experiences.listForAudit(scopeId, limit);
        const counts = auditActorMetadata(rows.map((row) => row.metadata));
        return { scopeId, sampled: rows.length, ...counts };
    }
    /**
     * 幂等回填：只在能证明身份时补 metadata.actorId（显式 actorId / 平台稳定 ID）。
     * 不读昵称、不跨 scope、不改 content。dry-run 默认 true。
     */
    normalizeActorMetadata(scopeId, options = {}) {
        this.assertOpen();
        const dryRun = options.dryRun !== false;
        const limit = Math.max(1, Math.min(2000, options.limit ?? 200));
        const rows = this.experiences.listForAudit(scopeId, limit);
        const samples = [];
        let updated = 0;
        let skipped = 0;
        for (const row of rows) {
            const patch = actorMetadataPatch(row.metadata);
            const bucket = classifyActorMetadata(row.metadata);
            if (!patch) {
                skipped += 1;
                continue;
            }
            if (samples.length < 5) {
                samples.push({ experienceId: row.id, actorId: patch.actorId, source: patch.actorSource });
            }
            if (!dryRun) {
                const metadata = { ...row.metadata, ...patch };
                if (this.experiences.updateMetadata(row.id, metadata))
                    updated += 1;
            }
            else {
                updated += 1;
            }
            void bucket;
        }
        return { dryRun, scopeId, scanned: rows.length, wouldUpdate: updated, skipped, samples };
    }
    summaryQualityStats(scopeId) {
        const empty = { total: 0, good: 0, fair: 0, poor: 0, sampled: 0 };
        try {
            const report = this.listSummaryQuality(scopeId, { limit: 60 });
            return { ...report.counts, sampled: report.counts.total };
        }
        catch (error) {
            this.recordError(errorMessage(error));
            return empty;
        }
    }
    actorAuditStats(scopeId) {
        const empty = {
            total: 0,
            normalizedActorId: 0,
            stablePlatformId: 0,
            legacyViewerId: 0,
            nicknameOnly: 0,
            missing: 0,
            sampled: 0,
        };
        try {
            return this.auditActorIdentity(scopeId, { limit: 300 });
        }
        catch (error) {
            this.recordError(errorMessage(error));
            return empty;
        }
    }
    /** Evidence Chain：Experience ↔ Episode 双向可查（spec §16 memory_inspect）。 */
    inspect(id) {
        this.assertOpen();
        const experience = this.experiences.get(id);
        if (experience) {
            const episode = experience.episodeId ? this.episodes.get(experience.episodeId) : null;
            // 与被检 Experience 同一 Episode 的全部原始经历（含自身），保证证据链完整。
            const members = episode ? this.experiences.listByEpisode(episode.id) : [];
            const embeddings = this.embeddingMetadata('experience', experience.id);
            return {
                id: experience.id,
                type: 'experience',
                ...(experience.scopeId ? { scopeId: experience.scopeId } : {}),
                experience,
                ...(episode ? { episode } : {}),
                experiences: members,
                embeddings,
            };
        }
        const memory = this.memories.getById(id);
        if (memory) {
            const evidence = this.evidence.listByMemory(memory.id);
            // 证据链：Memory → 支持它的 Episode → 那些 Episode 的原始 Experience。
            const episodeIds = uniqueStrings(evidence.filter((item) => item.evidenceType === 'episode').map((item) => item.evidenceId));
            const episodes = this.episodes.listByIds(episodeIds);
            const memberIds = uniqueStrings(episodes.flatMap((item) => item.experienceIds));
            return {
                id: memory.id,
                type: 'memory',
                ...(memory.scopeId ? { scopeId: memory.scopeId } : {}),
                memory,
                evidence,
                episodes,
                experiences: this.experiences.listByIds(memberIds),
                ...(this.embeddingMetadata('memory', memory.id).length > 0
                    ? { embeddings: this.embeddingMetadata('memory', memory.id) }
                    : { embeddings: [] }),
            };
        }
        const pattern = this.patterns.getById(id);
        if (pattern) {
            const patternEvidence = this.patternEvidence.listByPattern(pattern.id);
            const supportingIds = uniqueStrings(patternEvidence.filter((item) => item.relation === 'supports').map((item) => item.memoryId));
            const contradictingIds = uniqueStrings(patternEvidence.filter((item) => item.relation === 'contradicts').map((item) => item.memoryId));
            const memories = this.memories.listByIds([...supportingIds, ...contradictingIds]);
            // 证据链：Pattern → 支持它的 Semantic Memory → 那些 Memory 的证据 Episode → 原始 Experience。
            const episodeIds = uniqueStrings(memories.flatMap((memory) => this.evidence
                .listByMemory(memory.id)
                .filter((item) => item.evidenceType === 'episode')
                .map((item) => item.evidenceId)));
            const episodes = this.episodes.listByIds(episodeIds);
            const experienceIds = uniqueStrings(episodes.flatMap((item) => item.experienceIds));
            return {
                id: pattern.id,
                type: 'pattern',
                ...(pattern.scopeId ? { scopeId: pattern.scopeId } : {}),
                pattern,
                patternEvidence,
                memories: memories.filter((memory) => supportingIds.includes(memory.id)),
                evidence: patternEvidence.map((item) => ({
                    memoryId: item.patternId,
                    evidenceType: 'memory',
                    evidenceId: item.memoryId,
                    relation: item.relation === 'supports' ? 'supports' : 'contradicts',
                    weight: item.weight,
                    createdAt: item.createdAt,
                })),
                episodes,
                experiences: this.experiences.listByIds(experienceIds),
                embeddings: this.embeddingMetadata('pattern', pattern.id),
            };
        }
        const episode = this.episodes.get(id);
        if (!episode)
            return null;
        const experiences = this.experiences.listByEpisode(episode.id);
        // 关联表里说「属于本 Episode」、但 experiences.episode_id 指向别处（或为空）的记录，
        // 就是证据链断裂的地方：不隐藏，明确报出来。
        const linkedIds = this.episodes.experienceIds(episode.id);
        const byEpisodeColumn = new Set(experiences.map((item) => item.id));
        const orphans = linkedIds.filter((experienceId) => !byEpisodeColumn.has(experienceId));
        const embeddings = this.embeddingMetadata('episode', episode.id);
        return {
            id: episode.id,
            type: 'episode',
            ...(episode.scopeId ? { scopeId: episode.scopeId } : {}),
            episode,
            experiences,
            orphanExperienceIds: orphans,
            embeddings,
            continuity: this.continuityView(episode),
        };
    }
    getScene(options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(undefined, options);
        return this.sceneBuilder.build(scope.id);
    }
    /** 给现有 3d-memory-sea 前端用的兼容格式（不重写前端，只换数据来源）。 */
    getLegacyScene(options = {}) {
        this.assertOpen();
        const { scopeId: _scopeId, rootPath: _rootPath, ...adapterOptions } = options;
        const scene = this.getScene(options);
        return toLegacyScene(scene, { ...adapterOptions, now: adapterOptions.now ?? this.now() });
    }
    /**
     * Stage 7：多 scope 全景视图（只读聚合）。
     *
     * - 默认聚合 `knownScopes()` 里的全部 scope；调用方可用 `scopeIds` 显式限定。
     * - 未知 scope 与读取异常都计入 `failures`（`complete=false`），不静默丢弃，
     *   避免把「少了一个 scope 的部分数据」当成完整全景返回。
     * - 每条边都来自某个 scope 内部真实存在的边，本方法不创建任何跨 scope 关系。
     */
    getGlobalScene(options = {}) {
        this.assertOpen();
        const known = this.knownScopes();
        const knownById = new Map(known.map((scope) => [scope.id, scope]));
        const requested = options.scopeIds && options.scopeIds.length > 0
            ? options.scopeIds
            : known.map((scope) => scope.id);
        const uniqueRequested = requested.filter((scopeId, index, list) => typeof scopeId === 'string' && scopeId.length > 0 && list.indexOf(scopeId) === index);
        const sources = [];
        const failures = [];
        for (const scopeId of uniqueRequested) {
            const scope = knownById.get(scopeId);
            if (!scope) {
                failures.push({ scopeId, error: 'unknown scope' });
                continue;
            }
            try {
                const scene = this.sceneBuilder.build(scopeId);
                sources.push({
                    scopeId,
                    ...(scope.rootPath ? { rootPath: scope.rootPath } : {}),
                    scene,
                });
            }
            catch (error) {
                const message = errorMessage(error);
                failures.push({ scopeId, error: message });
                this.recordError(message);
                this.logger.warn?.(`[memory-sea] 全景聚合 scope=${scopeId} 失败：${message}`);
            }
        }
        return buildGlobalScene(sources, { failures, now: this.now });
    }
    status(options = {}) {
        const scope = this.resolveScopeForInput(undefined, options);
        const payload = {
            enabled: this.config.enabled && !this.closed,
            databasePath: this.config.databasePath,
            scope,
            experiences: this.safeCount(() => this.experiences.count(scope.id)),
            episodes: this.safeCount(() => this.episodes.count(scope.id)),
            openEpisodes: this.safeCount(() => this.episodes.countOpen(scope.id)),
            closedEpisodes: this.safeCount(() => this.episodes.countClosed(scope.id)),
            fts: this.db.ftsAvailable,
            jobs: this.safeJobs(),
            embedding: {
                enabled: this.config.embedding.enabled,
                available: this.embedding.configured,
                provider: this.embedding.label,
                model: this.embedding.model,
                dimensions: this.embedding.dimensions,
            },
            background: {
                enabled: this.config.jobs.enabled,
                running: this.runner.running,
            },
            memories: this.safeMemoryStats(scope.id),
            consolidation: this.safeConsolidation(scope.id),
            patterns: this.safePatternStats(scope.id),
            review: this.safeReview(scope.id),
            continuity: this.safeContinuity(scope.id),
            skills: this.safeSkillStats(scope.id),
            summaries: this.summaryQualityStats(scope.id),
            actors: this.actorAuditStats(scope.id),
            recall: { contextualEnabled: this.config.contextualRecall.enabled },
        };
        if (this.lastError)
            payload.lastError = this.lastError;
        return payload;
    }
    getConfig() {
        return this.config;
    }
    /** 已解析过的 scope 列表（含默认 scope），HTTP/状态接口用它展示隔离情况。 */
    knownScopes() {
        const seen = new Map();
        seen.set(this.scopeResolver.defaultScope.id, this.scopeResolver.defaultScope);
        for (const scope of this.scopeResolver.knownScopes())
            seen.set(scope.id, scope);
        for (const scopeId of this.contexts.keys()) {
            if (!seen.has(scopeId))
                seen.set(scopeId, { type: 'project', id: scopeId });
        }
        // 库里已有的 scope 也要算进来：重启后可能还没有任何会话事件，
        // 但上一轮留下的 open Episode / pending 任务必须能被收割与补排。
        for (const scopeId of this.listStoredScopeIds()) {
            if (!seen.has(scopeId))
                seen.set(scopeId, { type: 'project', id: scopeId });
        }
        return [...seen.values()];
    }
    /** 数据库中出现过的 scope（experiences 与 episodes 的并集）。 */
    listStoredScopeIds() {
        const ids = new Set();
        try {
            for (const scopeId of this.experiences.listScopeIds())
                ids.add(scopeId);
            for (const scopeId of this.episodes.listScopeIds())
                ids.add(scopeId);
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 读取 scope 列表失败：${errorMessage(error)}`);
        }
        return [...ids].sort();
    }
    // ---------------------------------------------------------------- scope
    /** 宿主事件入口：拿 session 的 cwd 解析出 scope，并记住这层映射。 */
    resolveScopeForSession(session) {
        return this.scopeResolver.resolveForSession(session);
    }
    /** 工具调用入口：插件只知道 agent/session id，用它查缓存映射。 */
    resolveScopeForSessionId(sessionId) {
        return this.scopeResolver.resolveForSessionId(sessionId);
    }
    /** 记住「session 属于哪个 scope」，供后续无 cwd 的工具调用复用。 */
    rememberSessionScope(sessionId, scope) {
        this.scopeResolver.rememberSessionScope(sessionId, scope);
    }
    get defaultScope() {
        return this.scopeResolver.defaultScope;
    }
    // ---------------------------------------------------------------- 后台
    /** 立刻跑一轮维护：收割 idle Episode + 补排 pending 任务（崩溃恢复也走这里）。 */
    runMaintenance() {
        this.assertOpen();
        let closedEpisodes = 0;
        let enqueued = 0;
        for (const scope of this.knownScopes()) {
            const ctx = this.context(scope.id);
            try {
                closedEpisodes += ctx.sweeper.sweep().closedCount;
            }
            catch (error) {
                this.logger.warn?.(`[memory-sea] Episode 收割失败：${errorMessage(error)}`);
            }
            enqueued += this.backfillJobs(scope.id);
        }
        return { closedEpisodes, enqueued };
    }
    /**
     * 立刻跑一轮后台任务队列（摘要 / 向量索引），返回处理条数。
     * 给测试与 smoke 用：不必等 2s 的定时器，也不依赖真实后台线程。
     */
    async drainJobs() {
        this.assertOpen();
        return this.runner.tick();
    }
    /** 会话结束：立刻关闭该会话的 Episode，并把它推进摘要队列。 */
    closeSession(sessionId, scope) {
        this.assertOpen();
        const resolved = scope ?? this.resolveScopeForSessionId(sessionId);
        try {
            const closed = this.context(resolved.id).builder.closeForSession(sessionId, this.now());
            return closed.length;
        }
        catch (error) {
            this.recordError(`关闭会话 Episode 失败：${errorMessage(error)}`);
            return 0;
        }
    }
    /** 优雅关闭：停定时器 → 等当前 tick 收尾 → 关库（宿主 dispose 用）。 */
    async close() {
        if (this.closed)
            return;
        this.teardown();
        try {
            // 等当前 tick 收尾再关库，避免 handler 在 db.close() 之后回写。
            await this.runner.whenIdle();
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 关闭后台任务失败：${errorMessage(error)}`);
        }
        this.closeDatabase();
    }
    /** 同步关闭：结构测试/进程退出用，不等待进行中的任务（可能牺牲最后一条在途写入）。 */
    closeSync() {
        if (this.closed)
            return;
        this.teardown();
        this.closeDatabase();
    }
    teardown() {
        this.closed = true;
        this.stopMaintenance();
        for (const ctx of this.contexts.values())
            ctx.sweeper.stop();
        try {
            this.runner.stop();
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 停止后台任务失败：${errorMessage(error)}`);
        }
    }
    closeDatabase() {
        try {
            this.db.close();
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 关闭数据库失败：${errorMessage(error)}`);
        }
    }
    // ---------------------------------------------------------------- 内部：scope 上下文
    context(scopeId) {
        const existing = this.contexts.get(scopeId);
        if (existing)
            return existing;
        this.logger.info?.(`[memory-sea] scope resolved id=${scopeId}`);
        const builder = new EpisodeBuilder({
            experiences: this.experiences,
            episodes: this.episodes,
            scopeId,
            episodeIdleMs: this.config.episode.idleMs,
            now: this.now,
            onEpisodeClosed: (episode, reason) => {
                // Episode 关闭 = 该总结了。这里只排队，摘要本身在 JobRunner 里跑。
                this.logger.info?.(`[memory-sea] episode closed id=${episode.id} scope=${scopeId} reason=${reason ?? 'unknown'} experiences=${episode.experienceIds.length}`);
                this.enqueueSummary(scopeId, episode.id);
            },
        });
        const captureManager = new CaptureManager({
            experiences: this.experiences,
            episodes: this.episodes,
            builder,
            scopeId,
            embeddingStatus: this.embedding.configured ? 'pending' : 'disabled',
            now: this.now,
            onCaptured: (experience) => {
                if (this.embedding.configured)
                    this.enqueueEmbedding(scopeId, 'experience', experience.id);
            },
        });
        const sweeper = new EpisodeSweeper({ builder, now: this.now, logger: this.logger });
        const ctx = { builder, captureManager, sweeper };
        this.contexts.set(scopeId, ctx);
        return ctx;
    }
    resolveScopeForInput(sessionId, options) {
        if (options.scopeId && options.scopeId.trim().length > 0) {
            return { type: 'project', id: options.scopeId.trim() };
        }
        if (options.rootPath)
            return this.scopeResolver.resolveForRoot(options.rootPath);
        if (sessionId) {
            const scope = this.scopeResolver.resolveForSessionId(sessionId);
            if (scope)
                return scope;
        }
        return this.scopeResolver.defaultScope;
    }
    // ---------------------------------------------------------------- 内部：后台任务
    startupMaintenance() {
        try {
            // 启动恢复：上次进程可能死在 Episode 还开着的时候；
            // 同时把「已关闭但还 pending / failed 可重试」的摘要与向量任务补排进队列。
            for (const scope of this.knownScopes()) {
                this.context(scope.id).sweeper.sweep('startup_recovery');
                this.backfillJobs(scope.id);
                const repaired = this.repairContinuityDirections(scope.id);
                if (repaired > 0) {
                    this.logger.info?.(`[memory-sea] 修正 ${repaired} 条连续性关系的方向 (${scope.id})`);
                }
            }
            // 历史 episode_fts 是用原文写的（中文不可分词），启动时按 bigram 重建一次。
            const rebuilt = this.episodes.rebuildSearchIndexes();
            if (rebuilt > 0) {
                this.logger.info?.(`[memory-sea] 重建 ${rebuilt} 个 Episode 的搜索索引`);
            }
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 启动恢复失败：${errorMessage(error)}`);
        }
        if (this.config.jobs.enabled) {
            try {
                this.runner.start();
            }
            catch (error) {
                this.logger.warn?.(`[memory-sea] 后台任务启动失败：${errorMessage(error)}`);
            }
            this.startMaintenance();
        }
    }
    startMaintenance() {
        if (this.maintenanceTimer)
            return;
        // 维护周期与 JobRunner 的 tick 分开：收割 Episode 属于「整理」，不属于「执行任务」。
        const period = Math.max(1000, Math.round(this.config.episode.sweepIntervalMs));
        this.maintenanceTimer = setInterval(() => {
            try {
                this.runMaintenance();
            }
            catch (error) {
                this.logger.warn?.(`[memory-sea] 定期维护失败：${errorMessage(error)}`);
            }
        }, period);
        this.maintenanceTimer.unref?.();
    }
    stopMaintenance() {
        if (this.maintenanceTimer) {
            clearInterval(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
    }
    /** 把库里所有「待处理」的对象补排进队列：崩溃恢复与迁移后重算都走这里。 */
    backfillJobs(scopeId) {
        let enqueued = 0;
        // 已被关闭但还没摘要的 Episode：重启后必须补上，否则它们永远是「无摘要」。
        for (const episode of this.episodes.listPendingSummary(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
            if (this.enqueueSummary(scopeId, episode.id))
                enqueued += 1;
        }
        // 已关闭 + 摘要就绪但还没整理的 Episode：重启后补排（幂等由 (type,owner) 唯一键保证）。
        if (this.dream) {
            enqueued += this.dream.scanScope(scopeId, DEFAULT_MAINTENANCE_LIMIT);
        }
        if (this.embedding.configured) {
            for (const memory of this.memories.listPendingEmbedding(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
                if (this.enqueueEmbedding(scopeId, 'memory', memory.id))
                    enqueued += 1;
            }
            for (const pattern of this.patterns.listPendingEmbedding(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
                if (this.enqueuePatternEmbedding(scopeId, pattern.id))
                    enqueued += 1;
            }
            for (const episode of this.episodes.listPendingEmbedding(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
                if (this.enqueueEmbedding(scopeId, 'episode', episode.id))
                    enqueued += 1;
            }
            for (const experience of this.experiences.listPendingEmbedding(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
                if (this.enqueueEmbedding(scopeId, 'experience', experience.id))
                    enqueued += 1;
            }
        }
        // 已关闭 + 摘要就绪但还没有连续性分析的 Episode：重启后补排。
        if (this.config.episodeContinuity.enabled) {
            for (const episode of this.episodes.listPendingContinuity(scopeId, DEFAULT_MAINTENANCE_LIMIT)) {
                if (this.enqueueContinuity(scopeId, episode.id))
                    enqueued += 1;
            }
        }
        // 久未强化的知识补排复核任务（崩溃恢复后也要能继续降级，而不是永远卡在 active）。
        if (this.config.review.enabled) {
            for (const memory of this.reviewService.findDueMemories(scopeId)) {
                if (this.enqueueReview(scopeId, memory.id))
                    enqueued += 1;
            }
        }
        // Stage 5：已有 Pattern 但还没有候选的，补排候选发现任务（幂等，由唯一索引兜底）。
        if (this.config.skill.enabled) {
            for (const pattern of this.patterns.list(scopeId, { status: 'active', limit: 20 })) {
                if (this.skill.hasCandidateForPattern(scopeId, pattern.id))
                    continue;
                if (this.enqueueSkillCandidateDiscovery(scopeId, pattern.id))
                    enqueued += 1;
            }
        }
        return enqueued;
    }
    enqueueSummary(scopeId, episodeId) {
        try {
            const job = this.jobs.enqueue({ type: 'episode_summary', ownerType: 'episode', ownerId: episodeId, scopeId });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=episode_summary job=${job.id} owner=${episodeId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 摘要任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    /** 连续性分析入队（Episode close + summary ready 后调用）。 */
    enqueueContinuity(scopeId, episodeId) {
        try {
            const job = this.jobs.enqueue({
                type: 'episode_continuity',
                ownerType: 'episode',
                ownerId: episodeId,
                scopeId,
            });
            if (job) {
                this.logger.info?.(`[memory-sea] job enqueued type=episode_continuity job=${job.id} owner=${episodeId}`);
            }
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 连续性任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    /**
     * 连续性处理器：只写 relation，绝不合并或改写 Episode（spec §21 / §36）。
     * 同一 Episode 重复执行是幂等的（PK + INSERT OR IGNORE）。
     */
    async runEpisodeContinuity(job) {
        const episode = this.episodes.get(job.ownerId);
        if (!episode)
            return;
        if (!this.config.episodeContinuity.enabled) {
            this.episodes.setContinuityStatus(episode.id, 'disabled', this.now());
            return;
        }
        if (episode.status === 'open')
            return;
        if (episode.summaryStatus !== 'ready')
            return;
        if (episode.continuityStatus === 'ready')
            return;
        try {
            const context = this.continuityFinder.build(job.scopeId, episode, {
                lookbackMs: this.config.episodeContinuity.lookbackMs,
                maxCandidates: this.config.episodeContinuity.maxCandidates,
            });
            const links = this.continuityAnalyzer.analyze(context);
            const inserted = this.relations.insertMany(this.orderedRelations(context, links));
            this.episodes.setContinuityStatus(episode.id, 'ready', this.now());
            if (inserted > 0 || links.length > 0) {
                this.logger.info?.(`[memory-sea] continuity links=${inserted} episode=${episode.id} scope=${job.scopeId}`);
            }
        }
        catch (error) {
            this.episodes.setContinuityStatus(episode.id, 'failed', this.now());
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    enqueueEmbedding(scopeId, ownerType, ownerId) {
        if (!this.embedding.configured)
            return false;
        try {
            const type = ownerType === 'memory'
                ? 'memory_embedding'
                : ownerType === 'episode'
                    ? 'episode_embedding'
                    : ownerType === 'pattern'
                        ? 'pattern_embedding'
                        : 'experience_embedding';
            const job = this.jobs.enqueue({ type, ownerType, ownerId, scopeId });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=${type} job=${job.id} owner=${ownerId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] embedding 任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueueConsolidation(scopeId, episodeId) {
        try {
            const job = this.jobs.enqueue({
                type: 'episode_consolidation',
                ownerType: 'episode',
                ownerId: episodeId,
                scopeId,
            });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=episode_consolidation job=${job.id} owner=${episodeId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 整理任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueuePatternAnalysis(scopeId, memoryId) {
        if (!this.patternAnalyzer.configured)
            return false;
        try {
            const job = this.jobs.enqueue({
                type: 'memory_pattern_analysis',
                ownerType: 'memory',
                ownerId: memoryId,
                scopeId,
            });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=memory_pattern_analysis job=${job.id} owner=${memoryId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 模式分析任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueuePatternEmbedding(scopeId, patternId) {
        if (!this.embedding.configured)
            return false;
        try {
            const job = this.jobs.enqueue({ type: 'pattern_embedding', ownerType: 'pattern', ownerId: patternId, scopeId });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=pattern_embedding job=${job.id} owner=${patternId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 模式向量化任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueueReview(scopeId, memoryId) {
        if (!this.config.review.enabled)
            return false;
        try {
            const job = this.jobs.enqueue({ type: 'memory_review', ownerType: 'memory', ownerId: memoryId, scopeId });
            if (job)
                this.logger.info?.(`[memory-sea] job enqueued type=memory_review job=${job.id} owner=${memoryId}`);
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 复核任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    async runEpisodeSummary(job) {
        const episode = this.episodes.get(job.ownerId);
        if (!episode)
            return;
        if (!this.summarizer.configured) {
            // 摘要被关闭：标 disabled 而不是 failed —— 这不是错误，是配置。
            this.episodes.setSummaryStatus(episode.id, 'disabled', this.now());
            return;
        }
        const experiences = this.experiences.listByEpisode(episode.id);
        if (experiences.length === 0)
            return;
        try {
            const result = await this.summarizer.summarizer.summarize(episode, experiences);
            this.context(job.scopeId).builder.applySummary(episode.id, result, this.now());
            // 摘要变了意味着 Episode 的 embedding 也过期了。
            if (this.embedding.configured)
                this.enqueueEmbedding(job.scopeId, 'episode', episode.id);
            // 摘要就绪是整理的前置条件（spec §13）：现在才排 Dream 任务。
            this.enqueueConsolidation(job.scopeId, episode.id);
            // 连续性也在摘要就绪后进行：只有可读的 Episode 才值得被链起来（spec §30）。
            if (this.config.episodeContinuity.enabled)
                this.enqueueContinuity(job.scopeId, episode.id);
        }
        catch (error) {
            this.episodes.setSummaryStatus(episode.id, 'failed', this.now());
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    async runExperienceEmbedding(job) {
        const repository = this.embeddingRepository;
        if (!repository || !this.embedding.provider)
            return;
        const experience = this.experiences.get(job.ownerId);
        if (!experience)
            return;
        try {
            const vector = await this.embedding.provider.embed(experience.content);
            repository.upsert({
                scopeId: job.scopeId,
                ownerType: 'experience',
                ownerId: experience.id,
                vector,
                contentHash: contentHashOf(experience.content),
            });
            this.experiences.setEmbeddingStatus(experience.id, 'ready');
        }
        catch (error) {
            this.experiences.setEmbeddingStatus(experience.id, 'failed');
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    async runEpisodeEmbedding(job) {
        const repository = this.embeddingRepository;
        if (!repository || !this.embedding.provider)
            return;
        const episode = this.episodes.get(job.ownerId);
        if (!episode)
            return;
        const text = episodeEmbeddingText(episode);
        if (text.trim().length === 0) {
            this.episodes.setSummaryStatus(episode.id, episode.summaryStatus, this.now());
            return;
        }
        try {
            const vector = await this.embedding.provider.embed(text);
            repository.upsert({
                scopeId: job.scopeId,
                ownerType: 'episode',
                ownerId: episode.id,
                vector,
                contentHash: contentHashOf(text),
            });
            this.episodes.updateDerived(episode.id, { embeddingStatus: 'ready' }, this.now());
        }
        catch (error) {
            this.episodes.updateDerived(episode.id, { embeddingStatus: 'failed' }, this.now());
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    /**
     * 整理一个 Episode（spec §13–§31）：候选人发现 → 整理器决策 → 事务应用。
     *
     * 幂等性三道闸：
     *   1. 只有 closed + summary ready 才处理，否则原样退回 pending；
     *   2. 已经 ready 的直接跳过（重复入队不会重复建 Memory）；
     *   3. Applier 里 evidence 唯一键 —— 同一 Episode 的证据第二次插入返回 0，退化为 skip。
     */
    async runEpisodeConsolidation(job) {
        const episode = this.episodes.get(job.ownerId);
        if (!episode)
            return;
        if (!this.consolidator.configured) {
            // 整理被关闭：标 disabled 而不是 failed —— 这是配置，不是错误。
            this.episodes.setConsolidationStatus(episode.id, 'disabled', this.now());
            return;
        }
        if (episode.consolidationStatus === 'ready')
            return;
        if (episode.status !== 'closed' || episode.summaryStatus !== 'ready') {
            // 前置条件还没满足：保持 pending，等摘要完成或 Episode 关闭后重新排队。
            this.episodes.setConsolidationStatus(episode.id, 'pending', this.now());
            return;
        }
        try {
            const context = this.candidateFinder.buildContext(episode, {
                maxRelatedEpisodes: this.config.consolidation.maxRelatedEpisodes,
                maxRelatedMemories: this.config.consolidation.maxRelatedMemories,
            });
            const result = await this.consolidator.consolidator.consolidate(context);
            const applied = this.applier.apply(context, result);
            this.episodes.setConsolidationStatus(episode.id, 'ready', this.now());
            this.logger.info?.(`[memory-sea] consolidation done episode=${episode.id} scope=${job.scopeId} created=${applied.created.length} reinforced=${applied.reinforced.length} superseded=${applied.superseded.length} contradicted=${applied.contradicted.length} skipped=${applied.skipped}`);
            // 新知识要在后台向量化（异步，不阻塞；embedding 只是增强项）。
            if (this.embedding.configured) {
                for (const memoryId of applied.created)
                    this.enqueueEmbedding(job.scopeId, 'memory', memoryId);
            }
            // 知识发生实质变化后，才值得重新看「这些知识背后有没有反复出现的模式」（spec §14）。
            for (const memoryId of [...applied.created, ...applied.reinforced, ...applied.superseded]) {
                this.enqueuePatternAnalysis(job.scopeId, memoryId);
            }
            // Phase 2D：来源知识被取代或出现反例时，候选的成熟度与来源可信度要重算。
            if (applied.superseded.length > 0 || applied.contradicted.length > 0) {
                this.refreshSkillCandidatesForMemories(job.scopeId, [...applied.superseded, ...applied.contradicted], '来源知识被取代或出现反例');
            }
        }
        catch (error) {
            this.episodes.setConsolidationStatus(episode.id, 'failed', this.now());
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    // ---------------------------------------------------------------- 模式（Stage 4）
    /**
     * 分析一条 Semantic Memory 背后的模式（spec §13–§24）。
     *
     * 幂等性：
     *   1. 只有 active memory 才分析；
     *   2. Applier 里 pattern_evidence 唯一键 —— 同一 Memory 再次插入返回 0，退化为 skip；
     *   3. 同一批内 touched 集合挡住对同一个 Pattern 的重复 reinforce/weaken。
     */
    async runPatternAnalysis(job) {
        if (!this.patternAnalyzer.configured)
            return;
        const trigger = this.memories.getById(job.ownerId);
        if (!trigger)
            return;
        // superseded / stale 的知识不该再生出新的模式；它们只能作为历史证据存在。
        if (trigger.status !== 'active')
            return;
        try {
            const context = this.patternCandidateFinder.buildContext(trigger, {
                maxRelatedMemories: this.config.pattern.maxRelatedMemories,
                maxExistingPatterns: this.config.pattern.maxExistingPatterns,
            });
            const result = await this.patternAnalyzer.analyzer.analyze(context);
            const applied = this.patternApplier.apply(context, result);
            this.logger.info?.(`[memory-sea] pattern analysis done memory=${trigger.id} scope=${job.scopeId} created=${applied.created.length} reinforced=${applied.reinforced.length} weakened=${applied.weakened.length} superseded=${applied.superseded.length} skipped=${applied.skipped}`);
            for (const patternId of applied.created) {
                this.enqueuePatternEmbedding(job.scopeId, patternId);
                this.enqueueSkillCandidateDiscovery(job.scopeId, patternId);
            }
            // Phase 2D：模式被强化/削弱/取代后，它的候选成熟度需要重算（关系变化会影响支撑与反例）。
            if (applied.weakened.length > 0 || applied.superseded.length > 0) {
                for (const patternId of [...applied.weakened, ...applied.superseded]) {
                    this.refreshSkillCandidatesForPattern(job.scopeId, patternId, '来源模式状态变化');
                }
            }
        }
        catch (error) {
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    async runPatternEmbedding(job) {
        const repository = this.embeddingRepository;
        if (!repository || !this.embedding.provider)
            return;
        const pattern = this.patterns.getById(job.ownerId);
        if (!pattern)
            return;
        const text = patternEmbeddingText(pattern);
        try {
            const vector = await this.embedding.provider.embed(text);
            repository.upsert({
                scopeId: job.scopeId,
                ownerType: 'pattern',
                ownerId: pattern.id,
                vector,
                contentHash: contentHashOf(text),
            });
            this.patterns.setEmbeddingStatus(pattern.id, 'ready');
        }
        catch (error) {
            this.patterns.setEmbeddingStatus(pattern.id, 'failed');
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    /** 复核一条知识（spec §31–§36）：久未强化 + 低置信度才降级为 stale，绝不自动删除。 */
    async runReview(job) {
        if (!this.config.review.enabled)
            return;
        const result = this.reviewService.reviewMemory(job.ownerId);
        if (!result)
            return;
        if (result.decision === 'mark_stale') {
            this.logger.info?.(`[memory-sea] memory marked stale id=${job.ownerId} scope=${job.scopeId}`);
            this.refreshSkillCandidatesForMemories(job.scopeId, [job.ownerId], '来源知识降级为 stale');
        }
        // 模式侧只做状态推进（active → weakened → stale），不删除、不猜测新事实。
        this.reviewService.sweepPatterns(job.scopeId);
    }
    async runMemoryEmbedding(job) {
        const repository = this.embeddingRepository;
        if (!repository || !this.embedding.provider)
            return;
        const memory = this.memories.getById(job.ownerId);
        if (!memory)
            return;
        const text = memoryEmbeddingText(memory);
        try {
            const vector = await this.embedding.provider.embed(text);
            repository.upsert({
                scopeId: job.scopeId,
                ownerType: 'memory',
                ownerId: memory.id,
                vector,
                contentHash: contentHashOf(text),
            });
            this.memories.setEmbeddingStatus(memory.id, 'ready');
        }
        catch (error) {
            this.memories.setEmbeddingStatus(memory.id, 'failed');
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
    }
    // ---------------------------------------------------------------- 语义记忆（Stage 3）
    getMemory(id) {
        this.assertOpen();
        return this.memories.getById(id) ?? null;
    }
    listMemories(query = {}, options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(undefined, options);
        return this.memories.list(scope.id, query);
    }
    listMemoryEvidence(memoryId) {
        this.assertOpen();
        return this.evidence.listByMemory(memoryId);
    }
    // ---------------------------------------------------------------- 模式（Stage 4）
    getPattern(id) {
        this.assertOpen();
        return this.patterns.getById(id) ?? null;
    }
    listPatterns(query = {}, options = {}) {
        this.assertOpen();
        const scope = this.resolveScopeForInput(undefined, options);
        return this.patterns.list(scope.id, query);
    }
    listPatternEvidence(patternId) {
        this.assertOpen();
        return this.patternEvidence.listByPattern(patternId);
    }
    /** 手动触发某个 Episode 的整理（Dream 的 C 路径，spec §47）。 */
    consolidateEpisode(episodeId, options = {}) {
        this.assertOpen();
        const episode = this.episodes.get(episodeId);
        if (!episode)
            return false;
        return this.enqueueConsolidation(episode.scopeId ?? options.scopeId ?? this.defaultScope.id, episodeId);
    }
    /** Dream 维护：扫描库里所有 scope，把该整理的 Episode 排队（不阻塞、不自建队列）。 */
    runDreamMaintenance(options = {}) {
        this.assertOpen();
        if (!this.dream)
            return 0;
        const scopes = options.scopeId ? [options.scopeId] : this.knownScopes().map((scope) => scope.id);
        return this.dream.scanScopes(scopes, DEFAULT_MAINTENANCE_LIMIT);
    }
    // ---------------------------------------------------------------- 内部：杂项
    embeddingMetadata(ownerType, ownerId) {
        try {
            const metadata = this.embeddingRepository?.metadata(ownerType, ownerId);
            return metadata ? [metadata] : [];
        }
        catch {
            return [];
        }
    }
    safeCount(fn) {
        try {
            return fn();
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 统计失败：${errorMessage(error)}`);
            return 0;
        }
    }
    safeMemoryStats(scopeId) {
        try {
            return this.memories.stats(scopeId);
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 记忆统计失败：${errorMessage(error)}`);
            return { active: 0, superseded: 0, stale: 0, total: 0 };
        }
    }
    /** 候选的完整只读视图（审核入口用）：候选 + 成熟度 + 版本 + 尝试 + 证据 + 审核历史。 */
    getSkillCandidateDetail(scopeId, candidateId) {
        this.assertOpen();
        const candidate = this.skill.getCandidate(scopeId, candidateId);
        if (!candidate)
            return null;
        const maturity = this.skill.getMaturity(scopeId, candidate.id);
        const versions = this.skill.listVersions(scopeId, candidate.id);
        const attempts = this.skill.listAttempts(scopeId, { candidateId: candidate.id, limit: 200 });
        return {
            candidate,
            maturity,
            versions,
            attempts,
            outcomes: attempts.map((attempt) => ({ attemptId: attempt.id, rows: this.skill.listOutcomes(scopeId, attempt.id) })),
            reviews: this.skill.listReviews(scopeId, candidate.id),
        };
    }
    /**
     * Phase 2C：人工编辑 Procedure → 新版本（旧版本不覆盖、批准结论不继承）。
     * 编辑后立刻排一个 reevaluate 任务，让成熟度基于新版本重算。
     */
    editSkillProcedure(scopeId, candidateId, input) {
        this.assertOpen();
        const version = this.skill.editProcedure(scopeId, candidateId, input);
        this.enqueueSkillCandidateReevaluate(scopeId, candidateId);
        return version;
    }
    /** Phase 2D：重新评估（同步版本，供测试与 maintenance；后台由 job 驱动）。 */
    reevaluateSkillCandidate(scopeId, candidateId) {
        this.assertOpen();
        return this.skill.reevaluate(scopeId, candidateId);
    }
    /** 来源证据变化：打 provenanceChanged 标记，不改历史版本/审核记录。 */
    markSkillProvenanceChanged(scopeId, candidateId, reason) {
        this.assertOpen();
        return this.skill.markProvenanceChanged(scopeId, candidateId, reason);
    }
    /**
     * 把一个 Scope 里「来源包含这些 Memory」的候选全部标记来源变化并重算。
     * 只读扫描（候选数很少），在后台任务里调用，不在 capture 快路径。
     */
    refreshSkillCandidatesForMemories(scopeId, memoryIds, cause) {
        if (!this.config.skill.enabled || memoryIds.length === 0)
            return 0;
        const target = new Set(memoryIds);
        let affected = 0;
        try {
            for (const candidate of this.skill.listCandidates(scopeId, { limit: 200 })) {
                const references = new Set(candidate.sourceMemoryIds);
                for (const version of this.skill.listVersions(scopeId, candidate.id)) {
                    for (const memoryId of version.evidenceSnapshot.memoryIds)
                        references.add(memoryId);
                }
                let hit = false;
                for (const memoryId of references) {
                    if (target.has(memoryId)) {
                        hit = true;
                        break;
                    }
                }
                if (!hit)
                    continue;
                this.skill.markProvenanceChanged(scopeId, candidate.id, cause);
                this.skill.reevaluate(scopeId, candidate.id);
                this.enqueueSkillCandidateReevaluate(scopeId, candidate.id);
                affected += 1;
            }
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 刷新候选来源状态失败：${errorMessage(error)}`);
        }
        return affected;
    }
    /** 某个 Pattern 状态变化后，重算它的候选。 */
    refreshSkillCandidatesForPattern(scopeId, patternId, cause) {
        if (!this.config.skill.enabled)
            return 0;
        let affected = 0;
        try {
            for (const candidate of this.skill.listCandidates(scopeId, { limit: 200 })) {
                if (candidate.sourcePatternId !== patternId)
                    continue;
                this.skill.markProvenanceChanged(scopeId, candidate.id, cause);
                this.skill.reevaluate(scopeId, candidate.id);
                this.enqueueSkillCandidateReevaluate(scopeId, candidate.id);
                affected += 1;
            }
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 刷新候选失败：${errorMessage(error)}`);
        }
        return affected;
    }
    safeConsolidation(scopeId) {
        try {
            return this.episodes.countConsolidation(scopeId);
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 整理统计失败：${errorMessage(error)}`);
            return { pending: 0, ready: 0, failed: 0 };
        }
    }
    safePatternStats(scopeId) {
        try {
            return this.patterns.stats(scopeId);
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 模式统计失败：${errorMessage(error)}`);
            return { candidate: 0, active: 0, weakened: 0, stale: 0, superseded: 0, total: 0 };
        }
    }
    safeReview(scopeId) {
        try {
            return this.reviewService.dueCounts(scopeId);
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 复核统计失败：${errorMessage(error)}`);
            return { dueMemories: 0, duePatterns: 0 };
        }
    }
    continuityView(episode) {
        try {
            return this.getEpisodeContinuity(episode.scopeId ?? 'global', episode.id);
        }
        catch {
            return { previous: [], next: [] };
        }
    }
    // ---------------------------------------------------------------- Skill（Stage 5）
    /**
     * 从 Pattern 派生候选（幂等）。这是「候选生成」的唯一入口：
     * 不执行任何流程，只把描述性步骤 + 证据快照写下来。
     */
    ensureSkillCandidate(scopeId, patternId) {
        this.assertOpen();
        return this.skill.ensureCandidateForPattern(scopeId, patternId);
    }
    /** 批量发现（同步版本，供测试与手动 maintenance；后台由 job 驱动）。 */
    discoverSkillCandidates(scopeId, options = {}) {
        this.assertOpen();
        if (!this.config.skill.enabled)
            return { scanned: 0, created: 0, skipped: 0, errors: 0 };
        return this.skill.discover(scopeId, options);
    }
    listSkillCandidates(scopeId, query = {}) {
        this.assertOpen();
        return this.skill.listCandidates(scopeId, query);
    }
    getSkillCandidate(scopeId, candidateId) {
        this.assertOpen();
        return this.skill.getCandidate(scopeId, candidateId);
    }
    getSkillMaturity(scopeId, candidateId) {
        this.assertOpen();
        return this.skill.getMaturity(scopeId, candidateId);
    }
    listSkillVersions(scopeId, candidateId) {
        this.assertOpen();
        return this.skill.listVersions(scopeId, candidateId);
    }
    getSkillVersion(scopeId, versionId) {
        this.assertOpen();
        return this.skill.getVersion(scopeId, versionId);
    }
    createSkillVersion(scopeId, candidateId, input) {
        this.assertOpen();
        const version = this.skill.createVersion(scopeId, candidateId, input);
        this.enqueueSkillCandidateReevaluate(scopeId, candidateId);
        return version;
    }
    recordSkillAttempt(input) {
        this.assertOpen();
        return this.skill.recordAttempt(input);
    }
    completeSkillAttempt(input) {
        this.assertOpen();
        const result = this.skill.completeAttempt(input);
        this.enqueueSkillAttemptEvaluate(input.scopeId, result.attempt.id);
        this.enqueueSkillCandidateReevaluate(input.scopeId, result.attempt.candidateId);
        return result;
    }
    listSkillAttempts(scopeId, options = {}) {
        this.assertOpen();
        return this.skill.listAttempts(scopeId, options);
    }
    listSkillOutcomes(scopeId, attemptId) {
        this.assertOpen();
        return this.skill.listOutcomes(scopeId, attemptId);
    }
    /** 提交审核：必须有可审计的审核人身份。 */
    submitSkillCandidate(scopeId, candidateId, input) {
        this.assertOpen();
        return this.skill.submitForReview(scopeId, candidateId, input);
    }
    /** 审核（Approve 只接受描述；不注册工具、不执行、不改 Prompt）。 */
    reviewSkillCandidate(input) {
        this.assertOpen();
        return this.skill.review(input);
    }
    listSkillReviews(scopeId, candidateId) {
        this.assertOpen();
        return this.skill.listReviews(scopeId, candidateId);
    }
    async runSkillCandidateDiscovery(job) {
        if (!this.config.skill.enabled)
            return;
        this.skill.ensureCandidateForPattern(job.scopeId, job.ownerId);
    }
    async runSkillCandidateReevaluate(job) {
        if (!this.config.skill.enabled)
            return;
        // ownerId 既可能是候选 id，也可能是版本 id（旧任务）。
        let candidate = this.skill.getCandidate(job.scopeId, job.ownerId);
        if (!candidate) {
            const version = this.skill.getVersion(job.scopeId, job.ownerId);
            if (version)
                candidate = this.skill.getCandidate(job.scopeId, version.candidateId);
        }
        if (!candidate)
            return;
        const maturity = this.skill.reevaluate(job.scopeId, candidate.id);
        this.logger.info?.(`[memory-sea] skill reevaluate candidate=${candidate.id} level=${maturity.level} missing=${maturity.missing.join("|") || "-"}`);
    }
    async runSkillAttemptEvaluate(job) {
        if (!this.config.skill.enabled)
            return;
        const attempt = this.skill.listAttempts(job.scopeId, { limit: 200 }).find((item) => item.id === job.ownerId);
        if (!attempt)
            return;
        const candidate = this.skill.getCandidate(job.scopeId, attempt.candidateId);
        if (!candidate)
            return;
        const maturity = this.skill.getMaturity(job.scopeId, candidate.id);
        this.logger.info?.(`[memory-sea] skill attempt evaluated attempt=${attempt.id} candidate=${candidate.id} level=${maturity.level}`);
    }
    enqueueSkillCandidateDiscovery(scopeId, patternId) {
        if (!this.config.skill.enabled)
            return false;
        try {
            const job = this.jobs.enqueue({
                type: "skill_candidate_discovery",
                ownerType: "pattern",
                ownerId: patternId,
                scopeId,
            });
            if (job) {
                this.logger.info?.(`[memory-sea] job enqueued type=skill_candidate_discovery job=${job.id} owner=${patternId}`);
            }
            return job !== null;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 技能候选发现任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueueSkillCandidateReevaluate(scopeId, versionId) {
        if (!this.config.skill.enabled)
            return false;
        try {
            this.jobs.enqueue({
                type: "skill_candidate_reevaluate",
                ownerType: "skill_candidate",
                ownerId: versionId,
                scopeId,
            });
            return true;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 候选重评估任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    enqueueSkillAttemptEvaluate(scopeId, attemptId) {
        if (!this.config.skill.enabled)
            return false;
        try {
            this.jobs.enqueue({
                type: "skill_attempt_evaluate",
                ownerType: "skill_attempt",
                ownerId: attemptId,
                scopeId,
            });
            return true;
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 尝试评估任务入队失败：${errorMessage(error)}`);
            return false;
        }
    }
    safeSkillStats(scopeId) {
        const empty = {
            candidates: 0,
            drafting: 0,
            readyForReview: 0,
            inReview: 0,
            approved: 0,
            rejected: 0,
            superseded: 0,
            attempts: 0,
            attemptsCompleted: 0,
        };
        try {
            const stats = this.skill.stats(scopeId);
            const byStatus = stats.candidates;
            return {
                candidates: Number(byStatus.total ?? 0),
                drafting: Number(byStatus.drafting ?? 0),
                readyForReview: Number(byStatus.ready_for_review ?? 0),
                inReview: Number(byStatus.in_review ?? 0),
                approved: Number(byStatus.approved ?? 0),
                rejected: Number(byStatus.rejected ?? 0),
                superseded: Number(byStatus.superseded ?? 0),
                attempts: stats.attempts.total,
                attemptsCompleted: stats.attempts.completed,
            };
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 技能统计失败：${errorMessage(error)}`);
            return empty;
        }
    }
    safeContinuity(scopeId) {
        try {
            return {
                relations: this.relations.count(scopeId),
                episodesLinked: this.relations.episodesLinked(scopeId),
            };
        }
        catch (error) {
            this.logger.warn?.(`[memory-sea] 连续性统计失败：${errorMessage(error)}`);
            return { relations: 0, episodesLinked: 0 };
        }
    }
    safeJobs() {
        try {
            return this.jobs.stats();
        }
        catch {
            return { pending: 0, running: 0, failed: 0, completed: 0 };
        }
    }
    recordError(message) {
        this.lastError = { at: this.now(), message };
    }
    assertOpen() {
        if (this.closed)
            throw new MemorySeaError('disabled', 'Memory Sea 服务已关闭');
    }
}
function toRelationView(relation, episodeId) {
    return {
        episodeId,
        relation: relation.relation,
        confidence: relation.confidence,
        ...(relation.reason ? { reason: relation.reason } : {}),
    };
}
/** Episode 的向量化文本：标题 + 摘要，缺摘要时退回正文预览（保证新 Episode 也能被语义召回）。 */
function skillSettingsOf(config) {
    return {
        enabled: config.enabled,
        minSupportMemories: config.minSupportMemories,
        minIndependentEpisodes: config.minIndependentEpisodes,
        minStability: config.minStability,
        maxStepsPerDraft: config.maxStepsPerDraft,
        minValidatedAttempts: config.minValidatedAttempts,
        minIndependentAttempts: config.minIndependentAttempts,
        minDirectAttempts: config.minDirectAttempts,
        minSuccessRateForValidated: config.minSuccessRateForValidated,
        minReportableSamples: config.minReportableSamples,
        wilsonZ: config.wilsonZ,
        minStepCoverage: config.minStepCoverage,
        minConfidence: config.minConfidence,
        allowWeakenedPatterns: config.allowWeakenedPatterns,
    };
}
function episodeEmbeddingText(episode) {
    const parts = [];
    if (episode.title)
        parts.push(episode.title);
    if (episode.summary)
        parts.push(episode.summary);
    if (parts.length === 0)
        parts.push(episode.topics.join(' '));
    return parts.join(String.fromCharCode(10)).slice(0, 4000);
}
/** Memory 的向量化文本：subject + content，截断到 4000 字。 */
function memoryEmbeddingText(memory) {
    const parts = [];
    if (memory.subject)
        parts.push(memory.subject);
    parts.push(memory.content);
    return parts.join(String.fromCharCode(10)).slice(0, 4000);
}
/** Pattern 的向量化文本：subject + content，截断到 4000 字。 */
function patternEmbeddingText(pattern) {
    const parts = [];
    if (pattern.subject)
        parts.push(pattern.subject);
    parts.push(pattern.content);
    return parts.join(String.fromCharCode(10)).slice(0, 4000);
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
function envObject(env) {
    return (env ?? process.env);
}
function consoleLogger() {
    return {
        info: (message) => console.log(message),
        warn: (message) => console.warn(message),
        error: (message, error) => console.error(message, error),
    };
}
