/**
 * tests/stage3.test.ts —— Stage 3 验收（spec §65–§77 十三项）。
 *
 * 全部用真实 SQLite + FTS5（临时库）、可控时钟、关掉后台定时器后手动 drainJobs()，
 * 因此每个断言都是「真实持久化 + 真实事务」的结果，而不是 mock 行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestService, reopenService, MINUTE, HOUR } from './helpers.js';
const JOBS_OFF = {
    jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
};
const SCOPE = { rootPath: 'C:/work/stage3' };
/** 手动把队列抽干（摘要完成会再排 consolidation，所以要循环到没有 pending）。 */
async function settle(service, scope = SCOPE) {
    for (let i = 0; i < 12; i += 1) {
        await service.drainJobs();
        if (service.status(scope).jobs.pending === 0)
            return;
    }
}
/** 写入一组连续消息 → 触发 idle 关闭 → 摘要 → 整理，返回该 Episode id。 */
async function runEpisode(harness, messages, sessionId, scope = SCOPE) {
    let episodeId = '';
    for (const content of messages) {
        episodeId = harness.service.capture({ content, sessionId }, scope).episode.id;
    }
    harness.clock.advance(30 * MINUTE);
    harness.service.runMaintenance();
    await settle(harness.service, scope);
    return episodeId;
}
test('创建：一段明确决定形成 decision Memory，并携带 Episode 证据', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['今天讨论 Memory Sea V0.3 的存储选型。', '决定 V0.3 暂时不用 Neo4j，继续用 SQLite 存记忆。'], 's-create');
        const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(memories.length, 1);
        const memory = memories[0];
        assert.ok(memory);
        assert.equal(memory.kind, 'decision');
        assert.equal(memory.status, 'active');
        assert.equal(memory.scopeId, harness.service.status(SCOPE).scope.id);
        assert.ok(memory.confidence >= 0.6 && memory.confidence <= 1, `置信度应在 0.6..1，实际 ${memory.confidence}`);
        // 没有配置 embedding 时必须标 disabled，而不是永远卡在 pending。
        assert.equal(memory.embeddingStatus, 'disabled');
        const evidence = harness.service.listMemoryEvidence(memory.id);
        assert.ok(evidence.length >= 1);
        assert.equal(evidence[0]?.evidenceType, 'episode');
        assert.ok(evidence.some((item) => item.evidenceId.length > 0));
    }
    finally {
        harness.cleanup();
    }
});
test('强化：第二段相关经历只增计数与证据，不新建重复 Memory', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆，不上 Neo4j。'], 's-r1');
        const before = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(before.length, 1);
        const original = before[0];
        assert.ok(original);
        harness.clock.advance(2 * HOUR);
        await runEpisode(harness, ['再确认一次：继续用 SQLite 存记忆，Neo4j 暂时不上。'], 's-r2');
        const after = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(after.length, 1, '强化不能产生第二条知识');
        const reinforced = after[0];
        assert.ok(reinforced);
        assert.equal(reinforced.id, original.id);
        assert.equal(reinforced.reinforcementCount, 1);
        assert.ok(reinforced.confidence > original.confidence, '强化后置信度必须上升');
        assert.ok(reinforced.confidence <= 1, '一次强化不能把置信度顶到超过 1');
        assert.ok(reinforced.lastReinforcedAt !== undefined);
        const evidence = harness.service.listMemoryEvidence(reinforced.id);
        assert.ok(evidence.length >= 2, '两个 Episode 都应成为证据');
        const evidenceEpisodes = new Set(evidence.filter((item) => item.evidenceType === 'episode').map((item) => item.evidenceId));
        assert.ok(evidenceEpisodes.size >= 2, '证据应覆盖两个不同的 Episode');
    }
    finally {
        harness.cleanup();
    }
});
test('No-op：编译/打开文件/测试通过这类噪音不产生长期知识', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['npm test 通过。', '打开了 src/index.ts 看了一下，没有改动。'], 's-noop');
        const memories = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(memories.length, 0, `噪音不应产生 Memory，实际：${memories.map((item) => item.content).join(' | ')}`);
        // 但 Episode 本身必须还在：no-op 只是不提炼知识，不丢原始经历。
        const status = harness.service.status(SCOPE);
        assert.ok(status.episodes >= 1);
        assert.equal(status.consolidation.pending + status.consolidation.ready, 1);
    }
    finally {
        harness.cleanup();
    }
});
test('取代：明确迁移后旧知识 superseded、新知识 active，历史仍可查', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆，暂时不上 Neo4j。'], 's-sup-old');
        const oldMemories = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(oldMemories.length, 1);
        const oldMemory = oldMemories[0];
        assert.ok(oldMemory);
        harness.clock.advance(3 * HOUR);
        await runEpisode(harness, ['数据规模上来了，决定迁移到 PostgreSQL 并评估图数据库。'], 's-sup-new');
        const all = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        const superseded = all.find((item) => item.id === oldMemory.id);
        assert.ok(superseded);
        assert.equal(superseded.status, 'superseded');
        assert.equal(typeof superseded.supersededBy, 'string');
        assert.ok(typeof superseded.validUntil === 'number');
        const next = all.find((item) => item.id === superseded.supersededBy);
        assert.ok(next, '被取代的旧知识必须指向一个真实存在的新知识');
        assert.equal(next.status, 'active');
        assert.match(next.content, /PostgreSQL/);
        // 旧知识的证据不能因为被取代而消失（历史必须可回答）。
        assert.ok(harness.service.listMemoryEvidence(oldMemory.id).length >= 1);
    }
    finally {
        harness.cleanup();
    }
});
test('冲突：语焉不详的新说法不自动 supersede，只记录 contradicts 并降置信度', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定继续用 SQLite 存记忆，不上 Neo4j。'], 's-con-1');
        const before = harness.service.listMemories({ includeSuperseded: true }, SCOPE)[0];
        assert.ok(before);
        harness.clock.advance(2 * HOUR);
        await runEpisode(harness, ['这次先试试 Redis 缓存，也许更合适。'], 's-con-2');
        const all = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        const original = all.find((item) => item.id === before.id);
        assert.ok(original);
        assert.equal(original.status, 'active', '语焉不详的冲突不能推翻旧结论');
        assert.ok(original.confidence <= before.confidence, '冲突应降低置信度而不是提升');
        const evidence = harness.service.listMemoryEvidence(original.id);
        const hasContradiction = evidence.some((item) => item.relation === 'contradicts');
        assert.equal(hasContradiction, true, '冲突必须留下记录，不能静默吞掉');
    }
    finally {
        harness.cleanup();
    }
});
test('幂等：同一个 Episode 整理三次，知识数量与证据都不重复增长', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const episodeId = await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆。'], 's-idem');
        const first = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(first.length, 1);
        const memory = first[0];
        assert.ok(memory);
        const evidenceBefore = harness.service.listMemoryEvidence(memory.id).length;
        const reinforcementBefore = memory.reinforcementCount;
        for (let i = 0; i < 3; i += 1) {
            assert.equal(harness.service.consolidateEpisode(episodeId, SCOPE), true);
            await settle(harness.service);
        }
        const after = harness.service.listMemories({ includeSuperseded: true }, SCOPE);
        assert.equal(after.length, 1, '重复整理不能产生新知识');
        const again = after[0];
        assert.ok(again);
        assert.equal(harness.service.listMemoryEvidence(again.id).length, evidenceBefore, '证据不能重复累积');
        assert.equal(again.reinforcementCount, reinforcementBefore, '重复整理不能错误累加强化次数');
    }
    finally {
        harness.cleanup();
    }
});
test('Scope 隔离：Project A 的知识不出现在 Project B', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    const scopeA = { rootPath: 'C:/work/project-a' };
    const scopeB = { rootPath: 'C:/work/project-b' };
    try {
        await runEpisode(harness, ['决定 A 项目继续用 SQLite 存记忆。'], 's-a', scopeA);
        harness.clock.advance(2 * HOUR);
        await runEpisode(harness, ['决定 B 项目改用 PostgreSQL 存记忆。'], 's-b', scopeB);
        const memoriesA = harness.service.listMemories({ includeSuperseded: true }, scopeA);
        const memoriesB = harness.service.listMemories({ includeSuperseded: true }, scopeB);
        assert.equal(memoriesA.length, 1);
        assert.equal(memoriesB.length, 1);
        assert.notEqual(memoriesA[0]?.scopeId, memoriesB[0]?.scopeId);
        assert.notEqual(memoriesA[0]?.id, memoriesB[0]?.id);
        const hitsA = await harness.service.recall({ query: 'PostgreSQL 存储选型', limit: 10, includeSuperseded: true }, scopeA);
        assert.equal(hitsA.some((hit) => hit.id === memoriesB[0]?.id), false);
    }
    finally {
        harness.cleanup();
    }
});
test('没有 embedding 时：Episode → Memory 仍然成立，并明确标 disabled', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆，减少外部依赖。'], 's-noembed');
        const status = harness.service.status(SCOPE);
        assert.equal(status.embedding.available, false);
        assert.equal(status.memories.active, 1);
        const memory = harness.service.listMemories({}, SCOPE)[0];
        assert.ok(memory);
        assert.equal(memory.embeddingStatus, 'disabled');
    }
    finally {
        harness.cleanup();
    }
});
test('语义记忆召回：命中 Memory，理由包含置信度与强化，并展开证据 Episode', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆，暂时不上 Neo4j。'], 's-recall');
        const memory = harness.service.listMemories({}, SCOPE)[0];
        assert.ok(memory);
        const hits = await harness.service.recall({ query: 'SQLite 存记忆', limit: 5, expandEpisodes: true }, SCOPE);
        const memoryHit = hits.find((hit) => hit.type === 'memory');
        assert.ok(memoryHit, `应召回 Memory，实际类型：${hits.map((hit) => hit.type).join(',')}`);
        assert.equal(memoryHit.id, memory.id);
        assert.ok(memoryHit.reasons.some((reason) => reason.type === 'confidence'));
        assert.ok(memoryHit.reasons.some((reason) => reason.type === 'reinforcement'));
        assert.ok(Array.isArray(memoryHit.expanded) && memoryHit.expanded.length >= 1, 'Memory 命中应展开证据 Episode');
        assert.equal(memoryHit.expanded?.[0]?.type, 'episode');
    }
    finally {
        harness.cleanup();
    }
});
test('证据下钻：memory_inspect 能从 Memory 走到 Episode 再到原始 Experience', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆。', '早期阶段优先本地低复杂度方案。'], 's-inspect');
        const memory = harness.service.listMemories({}, SCOPE)[0];
        assert.ok(memory);
        const inspection = harness.service.inspect(memory.id);
        assert.ok(inspection);
        assert.equal(inspection.type, 'memory');
        assert.equal(inspection.memory?.id, memory.id);
        assert.ok((inspection.evidence ?? []).length >= 1);
        assert.ok((inspection.episodes ?? []).length >= 1);
        assert.ok(inspection.experiences.length >= 1, '必须能继续看到最原始的 Experience');
        for (const episode of inspection.episodes ?? []) {
            assert.equal(episode.status, 'closed');
        }
    }
    finally {
        harness.cleanup();
    }
});
test('历史：默认召回只看 active，includeSuperseded 才返回旧观点', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆。'], 's-hist-1');
        const oldMemory = harness.service.listMemories({}, SCOPE)[0];
        assert.ok(oldMemory);
        harness.clock.advance(3 * HOUR);
        await runEpisode(harness, ['决定迁移到 PostgreSQL 并评估图数据库。'], 's-hist-2');
        const activeOnly = await harness.service.recall({ query: 'SQLite 存记忆', limit: 10 }, SCOPE);
        assert.equal(activeOnly.some((hit) => hit.type === 'memory' && hit.id === oldMemory.id), false);
        const withHistory = await harness.service.recall({ query: 'SQLite 存记忆', limit: 10, includeSuperseded: true }, SCOPE);
        assert.equal(withHistory.some((hit) => hit.type === 'memory' && hit.id === oldMemory.id), true);
    }
    finally {
        harness.cleanup();
    }
});
test('崩溃恢复：整理任务没跑完就退出，重启后补跑且不产生重复知识', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    let second = null;
    try {
        const episodeId = await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆。'], 's-crash-1');
        // 清空知识，模拟「整理还没发生就崩了」。
        const statusBefore = harness.service.status(SCOPE);
        assert.ok(statusBefore.consolidation.ready >= 1);
        harness.clock.advance(2 * HOUR);
        await runEpisode(harness, ['再确认：继续用 SQLite 存记忆，保持本地优先。'], 's-crash-2');
        const enqueued = harness.service.consolidateEpisode(episodeId, SCOPE);
        assert.equal(enqueued, true);
        // 故意不 drain，直接关闭（任务留在 memory_jobs 里 pending）。
        harness.service.closeSync();
        second = reopenService(harness.dbPath, harness.clock, JOBS_OFF);
        const pending = second.status(SCOPE).jobs.pending;
        assert.ok(pending >= 1, '重启后 pending 任务必须还在');
        await settle(second);
        const memories = second.listMemories({ includeSuperseded: true }, SCOPE);
        assert.ok(memories.length >= 1);
        const stableCount = memories.length;
        // 再跑一次也不能多出知识。
        await settle(second);
        assert.equal(second.listMemories({ includeSuperseded: true }, SCOPE).length, stableCount);
    }
    finally {
        second?.closeSync();
        harness.cleanup();
    }
});
test('端到端：Scene / legacy Scene / status 都能看到 Memory 与证据边', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        await runEpisode(harness, ['决定 V0.3 继续用 SQLite 存记忆，暂时不上 Neo4j。'], 's-e2e');
        const memory = harness.service.listMemories({}, SCOPE)[0];
        assert.ok(memory);
        const scene = harness.service.getScene(SCOPE);
        assert.equal(scene.stats.memories, 1);
        const memoryPoint = scene.points.find((point) => point.type === 'memory');
        assert.ok(memoryPoint, 'Scene 必须包含 Memory 节点');
        assert.equal(memoryPoint.id, memory.id);
        assert.equal(memoryPoint.kind, 'decision');
        assert.ok(Number.isFinite(memoryPoint.x) && Number.isFinite(memoryPoint.y) && Number.isFinite(memoryPoint.z));
        const evidenceEdges = scene.edges.filter((edge) => edge.kind === 'derived_from' || edge.kind === 'supports');
        assert.ok(evidenceEdges.length >= 1, 'Memory 与支持它的 Episode 之间必须有证据边');
        for (const edge of evidenceEdges) {
            assert.ok(typeof edge.reason === 'string' && edge.reason.length > 0, '证据边必须带 reason');
        }
        const legacy = harness.service.getLegacyScene(SCOPE);
        assert.equal(legacy.ok, true);
        const legacyMemory = legacy.points.find((point) => point.id === memory.id);
        assert.ok(legacyMemory);
        assert.equal(legacyMemory.kind, 'conclusion');
        const status = harness.service.status(SCOPE);
        assert.equal(status.memories.active, 1);
        assert.ok(status.consolidation.ready >= 1);
    }
    finally {
        harness.cleanup();
    }
});
