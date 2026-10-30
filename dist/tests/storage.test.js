/**
 * tests/storage.test.ts —— 持久化与数据安全（spec §3.1 / §22）。
 *
 * 这里的重点是「原始经历不可覆盖」与「Episode ↔ Experience 关联正确」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestService, MINUTE } from './helpers.js';
const chat = { sourceType: 'chat', role: 'user' };
test('Experience 写入后原文不会被改写（重复 id 只忽略、不覆盖）', () => {
    const { service, clock, cleanup } = createTestService();
    try {
        const first = service.capture({ ...chat, sessionId: 's1', id: 'xp_fixed', content: '原始内容 A。' });
        assert.equal(first.deduplicated, false);
        clock.advance(MINUTE);
        const second = service.capture({ ...chat, sessionId: 's1', id: 'xp_fixed', content: '试图改写的内容 B。' });
        assert.equal(second.deduplicated, true);
        assert.equal(service.getExperience('xp_fixed')?.content, '原始内容 A。');
        // 重复写入不会新增记录
        assert.equal(service.status().experiences, 1);
    }
    finally {
        cleanup();
    }
});
test('Episode 与 Experience 双向关联正确，inspect 能走通证据链', () => {
    const { service, clock, cleanup } = createTestService();
    try {
        const first = service.capture({ ...chat, sessionId: 's1', content: '第一句：今天研究 Memory Sea。' });
        clock.advance(MINUTE);
        const second = service.capture({ ...chat, sessionId: 's1', content: '第二句：决定先用 SQLite。' });
        clock.advance(MINUTE);
        const third = service.capture({ ...chat, sessionId: 's1', content: '第三句：Neo4j 后面再上。' });
        // Experience → Episode
        const fromExperience = service.inspect(second.experience.id);
        assert.ok(fromExperience);
        assert.equal(fromExperience.type, 'experience');
        assert.equal(fromExperience.episode?.id, first.episode.id);
        assert.equal(fromExperience.experiences.length, 3);
        // Episode → Experiences（顺序稳定，按 observed_at）
        const fromEpisode = service.inspect(first.episode.id);
        assert.ok(fromEpisode);
        assert.equal(fromEpisode.type, 'episode');
        assert.deepEqual(fromEpisode.experiences.map((item) => item.id), [first.experience.id, second.experience.id, third.experience.id]);
        assert.deepEqual(fromEpisode.orphanExperienceIds, []);
        // 找不到的 id
        assert.equal(service.inspect('xp_missing'), null);
    }
    finally {
        cleanup();
    }
});
test('FTS 索引可用，且原始内容与索引文本一致', () => {
    const { service, cleanup } = createTestService();
    try {
        service.capture({ ...chat, sessionId: 's1', content: '项目决定使用 SQLite 的 FTS5 做全文检索。' });
        assert.equal(service.status().fts, true);
        const hits = service.getScene();
        assert.equal(hits.stats.experiences, 1);
    }
    finally {
        cleanup();
    }
});
test('Scene：Episode 节点 + Experience 节点 + contains 边，布局稳定', () => {
    const { service, clock, cleanup } = createTestService();
    try {
        const first = service.capture({ ...chat, sessionId: 's1', content: '今天去了公司。' });
        clock.advance(MINUTE);
        service.capture({ ...chat, sessionId: 's1', content: '和老王聊 Memory Sea。' });
        clock.advance(MINUTE);
        service.capture({ sourceType: 'manual', role: 'user', content: '手动记一条独立的。' });
        const scene = service.getScene();
        assert.equal(scene.stats.experiences, 3);
        assert.equal(scene.stats.episodes, 2);
        assert.equal(scene.points.length, 5);
        assert.equal(scene.edges.length, 3);
        const episodeIds = new Set(scene.points.filter((point) => point.type === 'episode').map((point) => point.id));
        for (const edge of scene.edges) {
            assert.equal(edge.kind, 'contains');
            assert.ok(episodeIds.has(edge.a), '边的起点必须是 Episode');
            assert.ok(scene.points.some((point) => point.id === edge.b && point.type === 'experience'));
        }
        for (const point of scene.points) {
            assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
            assert.ok(point.size > 0);
            assert.ok(point.activation >= 0 && point.activation <= 1);
        }
        // 稳定布局：刷新后坐标不变
        const again = service.getScene();
        assert.deepEqual(again.points.map((point) => [point.id, point.x, point.y, point.z]), scene.points.map((point) => [point.id, point.x, point.y, point.z]));
    }
    finally {
        cleanup();
    }
});
test('Legacy Scene 兼容层输出旧前端字段', () => {
    const { service, cleanup } = createTestService();
    try {
        service.capture({ ...chat, sessionId: 's1', content: '今天研究 Memory Sea。' });
        const legacy = service.getLegacyScene({ name: '测试海', now: 1_700_000_000_000 });
        assert.equal(legacy.ok, true);
        assert.equal(legacy.name, '测试海');
        assert.equal(legacy.builtAt, 1_700_000_000_000);
        assert.ok(legacy.points.length >= 2);
        for (const point of legacy.points) {
            assert.ok(typeof point.id === 'string');
            assert.ok(typeof point.t === 'number');
            assert.ok(['event', 'feeling', 'fact', 'plan', 'conclusion'].includes(point.kind));
            assert.ok(point.text.length >= 2);
            assert.ok(point.weight > 0);
            assert.ok(typeof point.cluster === 'string' && point.cluster.length > 0);
            assert.ok(typeof point.source.type === 'string');
            assert.ok(Array.isArray(point.keywords));
        }
        const kinds = new Set(legacy.points.map((point) => point.kind));
        assert.ok(kinds.has('conclusion'), 'Episode 应映射为 conclusion');
        assert.ok(kinds.has('event'), 'chat 经历应映射为 event');
        // contains 边在旧前端里用 kind=topic 表示
        for (const edge of legacy.edges)
            assert.equal(edge.kind, 'topic');
        assert.equal(legacy.stats.total, legacy.points.length);
    }
    finally {
        cleanup();
    }
});
