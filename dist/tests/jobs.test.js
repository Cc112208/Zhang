/**
 * tests/jobs.test.ts —— 持久化后台任务层（spec §15 / §16 / §17）。
 *
 * 重点不是「方法能跑」，而是后台系统的两件难事：
 *   1. 幂等：重复 enqueue 不能产生第二行；
 *   2. 崩溃恢复：running 卡死的任务能被 reclaim 回队列，尝试次数耗尽时必须落成 failed。
 *
 * 全部用真实 SQLite（:memory:）+ 注入时钟，不 mock 数据库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../src/storage/database.js';
import { JobRepository } from '../src/jobs/job-repository.js';
import { JobRunner } from '../src/jobs/job-runner.js';
const START = Date.UTC(2026, 0, 1, 9, 0, 0);
function createHarness() {
    const db = MemoryDatabase.open(':memory:');
    let current = START;
    const repo = new JobRepository({ db, now: () => current });
    return {
        db,
        repo,
        get now() {
            return current;
        },
        advance(ms) {
            current += ms;
        },
        enqueue(overrides = {}) {
            return repo.enqueue({
                type: 'episode_summary',
                ownerType: 'episode',
                ownerId: 'ep_default',
                scopeId: 'project_test',
                ...overrides,
            });
        },
        cleanup() {
            db.close();
        },
    };
}
/** 默认三个 handler 都是空操作，测试只关心「有没有被调用 / 有没有抛错」。 */
function createHandlers(overrides = {}) {
    return {
        episode_summary: async () => { },
        experience_embedding: async () => { },
        episode_embedding: async () => { },
        memory_embedding: async () => { },
        episode_consolidation: async () => { },
        memory_pattern_analysis: async () => { },
        pattern_embedding: async () => { },
        memory_review: async () => { },
        episode_continuity: async () => { },
        skill_candidate_discovery: async () => { },
        skill_candidate_reevaluate: async () => { },
        skill_attempt_evaluate: async () => { },
        ...overrides,
    };
}
test('enqueue 幂等：同一 (type, owner) 第二次返回 null 且只有一行', () => {
    const h = createHarness();
    try {
        const first = h.enqueue();
        assert.ok(first);
        assert.match(first.id, /^job_/);
        assert.equal(first.status, 'pending');
        assert.equal(first.attempts, 0);
        assert.equal(first.maxAttempts, 3);
        assert.equal(first.availableAt, START);
        assert.equal(first.createdAt, START);
        assert.equal(first.updatedAt, START);
        assert.equal(first.startedAt, undefined);
        assert.equal(first.completedAt, undefined);
        const second = h.enqueue();
        assert.equal(second, null);
        assert.equal(h.repo.stats().pending, 1);
        // 不同 owner 是不同任务，不应被唯一键吞掉。
        assert.ok(h.enqueue({ ownerId: 'ep_other' }));
        assert.equal(h.repo.stats().pending, 2);
    }
    finally {
        h.cleanup();
    }
});
test('claim 一次只领一次，且按 scopeId 隔离', () => {
    const h = createHarness();
    try {
        h.enqueue({ ownerId: 'ep_a' });
        h.enqueue({ ownerId: 'ep_other_scope', scopeId: 'project_other' });
        const first = h.repo.claim(h.now, { scopeId: 'project_test' });
        assert.equal(first.length, 1);
        assert.equal(first[0].ownerId, 'ep_a');
        assert.equal(first[0].status, 'running');
        assert.equal(first[0].attempts, 1);
        assert.equal(first[0].startedAt, START);
        assert.equal(first[0].updatedAt, START);
        // 已变成 running，同一 scope 再领应为空。
        assert.deepEqual(h.repo.claim(h.now, { scopeId: 'project_test' }), []);
        // 不加 scope 过滤时，另一个 scope 的任务才被领到（证明隔离生效）。
        const other = h.repo.claim(h.now);
        assert.equal(other.length, 1);
        assert.equal(other[0].scopeId, 'project_other');
    }
    finally {
        h.cleanup();
    }
});
test('claim 尊重 availableAt：未来才可执行的任务不会被提前领取', () => {
    const h = createHarness();
    try {
        h.enqueue({ availableAt: START + 1_000 });
        assert.deepEqual(h.repo.claim(h.now), []);
        h.advance(999);
        assert.deepEqual(h.repo.claim(h.now), []);
        h.advance(1);
        const claimed = h.repo.claim(h.now);
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].attempts, 1);
    }
    finally {
        h.cleanup();
    }
});
test('complete 后状态落定、stats.completed 增加且不受 scope 误统计', () => {
    const h = createHarness();
    try {
        const job = h.enqueue();
        assert.ok(job);
        h.advance(10);
        assert.equal(h.repo.claim(h.now).length, 1);
        h.advance(5);
        h.repo.complete(job.id, h.now);
        const done = h.repo.get(job.id);
        assert.ok(done);
        assert.equal(done.status, 'completed');
        assert.equal(done.completedAt, START + 15);
        assert.equal(done.updatedAt, START + 15);
        assert.equal(done.error, undefined);
        assert.equal(done.attempts, 1);
        assert.deepEqual(h.repo.stats(), { pending: 0, running: 0, failed: 0, completed: 1 });
        assert.deepEqual(h.repo.stats('project_test'), { pending: 0, running: 0, failed: 0, completed: 1 });
        assert.deepEqual(h.repo.stats('project_other'), { pending: 0, running: 0, failed: 0, completed: 0 });
    }
    finally {
        h.cleanup();
    }
});
test('fail 按指数退避重试，尝试次数耗尽后变 failed', () => {
    const h = createHarness();
    try {
        const job = h.enqueue({ maxAttempts: 2 });
        assert.ok(job);
        // 第 1 次尝试失败：回 pending，退避 5000 * 2^0。
        h.repo.claim(h.now);
        h.repo.fail(job.id, 'first boom', h.now);
        let row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1);
        assert.equal(row.error, 'first boom');
        assert.equal(row.startedAt, undefined);
        assert.equal(row.availableAt, START + 5_000);
        // 退避未到，领不到。
        assert.deepEqual(h.repo.claim(h.now), []);
        // 退避到点后第 2 次尝试失败：attempts(2) >= maxAttempts(2) → failed。
        h.advance(5_000);
        const second = h.repo.claim(h.now);
        assert.equal(second.length, 1);
        assert.equal(second[0].attempts, 2);
        h.repo.fail(job.id, 'second boom', h.now);
        row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'failed');
        assert.equal(row.completedAt, START + 5_000);
        assert.equal(row.error, 'second boom');
        assert.deepEqual(h.repo.stats(), { pending: 0, running: 0, failed: 1, completed: 0 });
    }
    finally {
        h.cleanup();
    }
});
test('reclaimStale 把卡死的 running 任务收回 pending 且不重复消耗 attempts', () => {
    const h = createHarness();
    try {
        const job = h.enqueue({ maxAttempts: 3 });
        assert.ok(job);
        h.repo.claim(h.now);
        assert.equal(h.repo.get(job.id)?.status, 'running');
        h.advance(6_000);
        assert.equal(h.repo.reclaimStale(h.now, 5_000), 1);
        const row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'pending');
        assert.equal(row.attempts, 1); // 领取时已计过一次，回收不再加
        assert.equal(row.availableAt, START + 6_000); // 立即可再领
        assert.equal(row.startedAt, undefined);
        // 未超时的 running 不会被误回收。
        h.repo.claim(h.now);
        assert.equal(h.repo.reclaimStale(h.now, 5_000), 0);
    }
    finally {
        h.cleanup();
    }
});
test('reclaimStale：attempts 已耗尽时直接落成 failed，避免无限回收', () => {
    const h = createHarness();
    try {
        const job = h.enqueue({ maxAttempts: 1 });
        assert.ok(job);
        h.repo.claim(h.now); // attempts = 1
        h.advance(6_000);
        assert.equal(h.repo.reclaimStale(h.now, 5_000), 1);
        const row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'failed');
        assert.equal(row.completedAt, START + 6_000);
        assert.ok(typeof row.error === 'string' && row.error.length > 0);
        assert.deepEqual(h.repo.stats(), { pending: 0, running: 0, failed: 1, completed: 0 });
    }
    finally {
        h.cleanup();
    }
});
test('stats 同时统计四种状态，listByOwner 按 owner 精确查询', () => {
    const h = createHarness();
    try {
        h.enqueue({ ownerId: 'ep_pending', availableAt: START + 60_000 }); // 未到期
        h.enqueue({ ownerId: 'ep_running' });
        const done = h.enqueue({ ownerId: 'ep_done' });
        const dead = h.enqueue({ ownerId: 'ep_dead', maxAttempts: 1 });
        assert.ok(done);
        assert.ok(dead);
        const claimed = h.repo.claim(h.now);
        assert.equal(claimed.length, 3);
        h.repo.complete(done.id, h.now);
        h.repo.fail(dead.id, 'boom', h.now); // maxAttempts=1 → 直接 failed
        assert.deepEqual(h.repo.stats(), { pending: 1, running: 1, failed: 1, completed: 1 });
        assert.deepEqual(h.repo.listByOwner('episode', 'ep_done').map((job) => job.id), [done.id]);
        assert.deepEqual(h.repo.listByOwner('experience', 'ep_done'), []);
    }
    finally {
        h.cleanup();
    }
});
test('JobRunner.tick 真实执行 handler 并写回 completed', async () => {
    const h = createHarness();
    try {
        const seen = [];
        const runner = new JobRunner({
            jobs: h.repo,
            handlers: createHandlers({
                episode_summary: async (job) => {
                    seen.push(`${job.type}:${job.ownerId}`);
                },
            }),
            now: () => h.now,
        });
        const job = h.enqueue({ ownerId: 'ep_runner' });
        assert.ok(job);
        assert.equal(await runner.tick(), 1);
        assert.deepEqual(seen, ['episode_summary:ep_runner']);
        assert.equal(h.repo.get(job.id)?.status, 'completed');
        // 队列已空，第二轮无事可做。
        assert.equal(await runner.tick(), 0);
    }
    finally {
        h.cleanup();
    }
});
test('JobRunner.tick：handler 抛错不冒泡，任务被记 fail', async () => {
    const h = createHarness();
    try {
        const errors = [];
        const runner = new JobRunner({
            jobs: h.repo,
            handlers: createHandlers({
                episode_summary: async () => {
                    throw new Error('summary provider 炸了');
                },
            }),
            now: () => h.now,
            logger: { error: (message) => { errors.push(message); } },
        });
        const job = h.enqueue({ maxAttempts: 1 });
        assert.ok(job);
        // 不 reject：后台循环不能被单个 handler 打死。
        assert.equal(await runner.tick(), 1);
        const row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'failed');
        assert.equal(row.error, 'summary provider 炸了');
        assert.equal(errors.length, 1);
    }
    finally {
        h.cleanup();
    }
});
test('JobRunner.tick：handler 缺失按失败处理而不是崩溃', async () => {
    const h = createHarness();
    try {
        // 故意只装配一个 handler，模拟插件装配错误。
        const handlers = {
            episode_summary: async () => { },
        };
        const runner = new JobRunner({ jobs: h.repo, handlers, now: () => h.now });
        const job = h.enqueue({ type: 'episode_embedding', ownerId: 'ep_missing_handler', maxAttempts: 1 });
        assert.ok(job);
        assert.equal(await runner.tick(), 1);
        const row = h.repo.get(job.id);
        assert.ok(row);
        assert.equal(row.status, 'failed');
        assert.ok(row.error?.includes('未注册'));
    }
    finally {
        h.cleanup();
    }
});
test('JobRunner.start / stop：幂等且定时器不拖住宿主退出', async () => {
    const h = createHarness();
    try {
        const runner = new JobRunner({ jobs: h.repo, handlers: createHandlers(), now: () => h.now });
        assert.equal(runner.running, false);
        runner.start();
        runner.start(); // 幂等
        assert.equal(runner.running, true);
        // start 立即跑过一轮；等它结束再 stop，模拟宿主优雅关闭。
        await runner.whenIdle();
        runner.stop();
        runner.stop(); // 幂等
        assert.equal(runner.running, false);
        // stop 之后 tick 仍可手动触发（测试/收尾用），但没有定时器了。
        assert.equal(await runner.tick(), 0);
    }
    finally {
        h.cleanup();
    }
});
test('已完成/永久失败的任务可以重新入队（派生数据可重算）', () => {
    const harness = createHarness();
    const first = harness.enqueue({ ownerId: 'ep_re' });
    assert.ok(first);
    const claimed = harness.repo.claim(harness.now);
    assert.equal(claimed.length, 1);
    harness.repo.complete(claimed[0].id, harness.now);
    harness.advance(1000);
    const again = harness.enqueue({ ownerId: 'ep_re' });
    assert.ok(again, '已完成的任务重新入队应返回任务而不是 null');
    assert.equal(again.status, 'pending');
    assert.equal(again.attempts, 0);
    assert.equal(again.id, first.id, '同一 owner 保持同一行（唯一键），不产生重复任务');
    // pending 仍幂等：重复入队不会重置状态
    const pendingAgain = harness.enqueue({ ownerId: 'ep_re' });
    assert.equal(pendingAgain, null, 'pending 任务不应被重复入队');
    harness.cleanup();
});
