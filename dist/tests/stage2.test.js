/**
 * tests/stage2.test.ts —— Stage 2 的核心承诺。
 *
 * 覆盖：
 *   1. scope 隔离（同进程多项目互不串味）
 *   2. Episode 生命周期（lastExperienceAt / closedAt / closedReason）
 *   3. 后台任务：空闲收割 → 摘要任务 → Episode 有了 summary 且 summaryStatus ready
 *   4. 会话结束立刻关闭 Episode
 *   5. inspect 的 embedding 元数据在无向量时也是稳定空值
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestService, MINUTE } from './helpers.js';
import { deriveProjectScopeId, isLegacyScopeId, isProjectScopeId, normalizeProjectPath } from '../src/scope/path-normalizer.js';
/** 关掉后台定时器：测试里用 drainJobs() 显式推进，避免 2s 定时器造成抖动。 */
const JOBS_OFF = {
    jobs: { enabled: false, intervalMs: 2000, maxPerTick: 8, staleMs: 60_000, maxAttempts: 3 },
};
test('不同项目目录各自成 scope，召回不跨项目', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const rootA = 'C:/work/memory-sea-a';
        const rootB = 'C:/work/memory-sea-b';
        const first = harness.service.capture({ content: 'A 项目决定先用 SQLite 做本地存储', sessionId: 's-a' }, { rootPath: rootA });
        const second = harness.service.capture({ content: 'B 项目决定先用 Neo4j 画图', sessionId: 's-b' }, { rootPath: rootB });
        assert.notEqual(first.scopeId, second.scopeId);
        const hitsA = await harness.service.recall({ query: 'SQLite' }, { rootPath: rootA });
        const hitsB = await harness.service.recall({ query: 'SQLite' }, { rootPath: rootB });
        assert.equal(hitsA.length > 0, true);
        assert.equal(hitsA.every((hit) => hit.content.includes('SQLite')), true);
        assert.equal(hitsB.length, 0);
        const statusA = harness.service.status({ rootPath: rootA });
        const statusB = harness.service.status({ rootPath: rootB });
        assert.equal(statusA.experiences, 1);
        assert.equal(statusB.experiences, 1);
        assert.equal(statusA.episodes, 1);
        assert.equal(statusB.episodes, 1);
        assert.ok(harness.service.knownScopes().length >= 2);
    }
    finally {
        harness.cleanup();
    }
});
test('同一段文字写进两个 scope 各自独立，不互相去重', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const content = '决定 V0.2 先用 SQLite，Neo4j 后面再上';
        const a = harness.service.capture({ content, sessionId: 's-a' }, { rootPath: 'C:/work/p-a' });
        const b = harness.service.capture({ content, sessionId: 's-b' }, { rootPath: 'C:/work/p-b' });
        assert.notEqual(a.experience.id, b.experience.id);
        assert.equal(a.deduplicated, false);
        assert.equal(b.deduplicated, false);
        assert.notEqual(a.episode.id, b.episode.id);
        assert.equal(harness.service.status({ rootPath: 'C:/work/p-a' }).experiences, 1);
        assert.equal(harness.service.status({ rootPath: 'C:/work/p-b' }).experiences, 1);
    }
    finally {
        harness.cleanup();
    }
});
test('Episode 生命周期字段随经历增长，空闲后被收割并标记原因', () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const scope = { rootPath: 'C:/work/lifecycle' };
        const first = harness.service.capture({ content: '今天研究 Memory Sea', sessionId: 's-life' }, scope);
        harness.clock.advance(2 * MINUTE);
        const second = harness.service.capture({ content: '决定 V0.2 先用 SQLite', sessionId: 's-life' }, scope);
        harness.clock.advance(1 * MINUTE);
        const third = harness.service.capture({ content: 'Neo4j 暂时不上', sessionId: 's-life' }, scope);
        assert.equal(first.episode.id, third.episode.id);
        const open = harness.service.getEpisode(first.episode.id);
        assert.ok(open);
        assert.equal(open.status, 'open');
        assert.equal(open.experienceIds.length, 3);
        assert.equal(open.lastExperienceAt, third.experience.observedAt);
        assert.equal(open.closedAt, undefined);
        harness.clock.advance(30 * MINUTE);
        const maintenance = harness.service.runMaintenance();
        assert.equal(maintenance.closedEpisodes >= 1, true);
        const closed = harness.service.getEpisode(first.episode.id);
        assert.ok(closed);
        assert.equal(closed.status, 'closed');
        assert.equal(closed.closedReason, 'idle_timeout');
        assert.equal(typeof closed.closedAt, 'number');
        assert.equal(closed.endedAt, third.experience.observedAt);
        assert.equal(second.episode.id, first.episode.id);
    }
    finally {
        harness.cleanup();
    }
});
test('关闭后的 Episode 会被摘要任务补上 title/summary，并把 summaryStatus 置为 ready', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const scope = { rootPath: 'C:/work/summary' };
        const captured = harness.service.capture({ content: '今天研究 Memory Sea 的技术选型', sessionId: 's-sum' }, scope);
        harness.service.capture({ content: '决定 V0.2 先用 SQLite 存记忆', sessionId: 's-sum' }, scope);
        harness.service.capture({ content: 'Neo4j 暂时不上，等以后再说', sessionId: 's-sum' }, scope);
        harness.clock.advance(30 * MINUTE);
        harness.service.runMaintenance();
        const pending = harness.service.getEpisode(captured.episode.id);
        assert.ok(pending);
        assert.equal(pending.status, 'closed');
        assert.equal(pending.summaryStatus, 'pending');
        const processed = await harness.service.drainJobs();
        assert.equal(processed > 0, true);
        const summarized = harness.service.getEpisode(captured.episode.id);
        assert.ok(summarized);
        assert.equal(summarized.summaryStatus, 'ready');
        assert.ok(typeof summarized.summary === 'string' && summarized.summary.length > 0);
        assert.ok(typeof summarized.title === 'string' && summarized.title.length > 0);
        // Stage 3/4：摘要就绪会继续排 consolidation，之后还可能排 pattern analysis / review，
        // 反复抽干队列直到没有待处理任务（有上限，避免任务互相排队时死循环）。
        for (let round = 0; round < 12 && harness.service.status(scope).jobs.pending > 0; round += 1) {
            await harness.service.drainJobs();
        }
        const status = harness.service.status(scope);
        assert.equal(status.jobs.failed, 0);
        assert.equal(status.jobs.pending, 0);
    }
    finally {
        harness.cleanup();
    }
});
test('会话结束时立刻关闭该会话的 Episode', () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const scope = { rootPath: 'C:/work/session-end' };
        const captured = harness.service.capture({ content: '收尾前最后一段讨论', sessionId: 's-end' }, scope);
        harness.clock.advance(MINUTE);
        const closedCount = harness.service.closeSession('s-end', harness.service.resolveScopeForSessionId('s-end'));
        assert.equal(closedCount >= 1, true);
        const episode = harness.service.getEpisode(captured.episode.id);
        assert.ok(episode);
        assert.equal(episode.status, 'closed');
        assert.equal(episode.closedReason, 'session_end');
        assert.equal(harness.service.closeSession('s-end'), 0);
    }
    finally {
        harness.cleanup();
    }
});
test('memory_inspect 在无向量时给出稳定的空 embedding 元数据', () => {
    const harness = createTestService({ config: JOBS_OFF });
    try {
        const captured = harness.service.capture({ content: '核对证据链的一条经历', sessionId: 's-inspect' });
        const experienceInspection = harness.service.inspect(captured.experience.id);
        assert.ok(experienceInspection);
        assert.equal(experienceInspection.type, 'experience');
        assert.ok(Array.isArray(experienceInspection.embeddings));
        assert.equal(experienceInspection.embeddings.length, 0);
        assert.equal(experienceInspection.episode?.id, captured.episode.id);
        const episodeInspection = harness.service.inspect(captured.episode.id);
        assert.ok(episodeInspection);
        assert.equal(episodeInspection.type, 'episode');
        assert.equal(episodeInspection.experiences.length, 1);
        assert.deepEqual(episodeInspection.orphanExperienceIds, []);
    }
    finally {
        harness.cleanup();
    }
});
test('重启恢复：进程退出前已入队的摘要任务，重启后仍能完成', async () => {
    const harness = createTestService({ config: JOBS_OFF });
    const scope = { rootPath: 'C:/work/restart' };
    try {
        const captured = harness.service.capture({ content: '重启恢复要验证的一条经历', sessionId: 's-restart' }, scope);
        harness.clock.advance(30 * MINUTE);
        harness.service.runMaintenance();
        const before = harness.service.getEpisode(captured.episode.id);
        assert.ok(before);
        assert.equal(before.summaryStatus, 'pending');
        // 模拟宿主退出：不跑队列直接关库。
        harness.service.closeSync();
        const reopened = createTestService({ clock: harness.clock, config: JOBS_OFF, dbPath: harness.dbPath });
        try {
            const middle = reopened.service.getEpisode(captured.episode.id);
            assert.ok(middle);
            assert.equal(middle.summaryStatus, 'pending');
            const processed = await reopened.service.drainJobs();
            assert.equal(processed > 0, true);
            const after = reopened.service.getEpisode(captured.episode.id);
            assert.ok(after);
            assert.equal(after.summaryStatus, 'ready');
            assert.ok(typeof after.summary === 'string' && after.summary.length > 0);
        }
        finally {
            reopened.cleanup();
        }
    }
    finally {
        // harness 的库已被 closeSync 关掉；目录仍要清掉。
        try {
            harness.cleanup();
        }
        catch {
            /* 已关闭的库重复清理忽略 */
        }
    }
});
test('Windows 路径归一化：大小写、分隔符、末尾斜杠不影响 scope id', () => {
    const sep = String.fromCharCode(92);
    const windows = 'C:' + sep + 'Work' + sep + 'MemorySea' + sep;
    const posix = 'c:/work/memorysea';
    // 显式指定 win32，让这个测试在 Windows 和 POSIX CI 上都验证同一套 Windows 规则。
    assert.equal(normalizeProjectPath(windows, 'win32'), normalizeProjectPath(posix, 'win32'));
    assert.equal(deriveProjectScopeId(windows, 'win32'), deriveProjectScopeId(posix, 'win32'));
    assert.equal(deriveProjectScopeId(posix, 'win32'), deriveProjectScopeId('c:/work/memorysea/', 'win32'));
    assert.equal(isProjectScopeId(deriveProjectScopeId('C:/x', 'win32')), true);
    assert.equal(isLegacyScopeId('project_legacy'), true);
});
