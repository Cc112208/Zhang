/**
 * scene-web.test.ts —— Stage 6 3D 页面的只读接口与数据映射测试。
 *
 * 覆盖：Scene 映射/完整性、Scope 隔离与未知 scope 404、Experience/Episode 详情、
 * 空数据、确定性、页面自包含且只读。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.js';
import { toScenePayload, validateScene, edgeStyle, nodeTypeLabel } from '../src/web/scene-page-data.js';
function createHarness(databasePath, homePath) {
    const routes = [];
    const provided = {};
    const savedHome = process.env.DSH_HOME;
    process.env.DSH_HOME = homePath;
    const ctx = {
        tools: { register: () => () => { } },
        on: () => () => { },
        provide: (name, service) => {
            provided[name] = service;
        },
        effect: () => () => { },
        get: (name) => provided[name],
        webServer: {
            register: (route) => {
                routes.push(route);
                return () => { };
            },
        },
        logger: { info: () => { }, warn: () => { }, error: () => { } },
    };
    const dispose = apply(ctx, {
        enabled: true,
        databasePath,
        embedding: { enabled: false },
        jobs: { enabled: false },
        background: { enabled: false },
        capture: { enabled: false },
        review: { enabled: false },
        episodeContinuity: { enabled: false },
        contextualRecall: { enabled: false },
        skill: { enabled: false },
        consolidation: { enabled: false },
        pattern: { enabled: false },
    });
    const service = provided.memorySea;
    assert.ok(service, '插件应提供 ctx.memorySea');
    return {
        service,
        routes,
        dispose: () => {
            if (typeof dispose === 'function')
                dispose();
            if (savedHome === undefined)
                delete process.env.DSH_HOME;
            else
                process.env.DSH_HOME = savedHome;
        },
        close: () => {
            ;
            service.closeSync?.();
        },
    };
}
function callRoute(harness, path, url) {
    const route = harness.routes.find((item) => item.path === path);
    assert.ok(route, `应注册路由 ${path}，实际：${harness.routes.map((item) => item.path).join(', ')}`);
    const response = { status: 0, headers: {}, body: '' };
    const res = {
        setHeader(name, value) {
            response.headers[name.toLowerCase()] = value;
        },
        writeHead(status, headers) {
            response.status = status;
            for (const [key, value] of Object.entries(headers ?? {}))
                response.headers[key.toLowerCase()] = value;
        },
        end(body) {
            response.body = body ?? '';
        },
    };
    route.handler({ url }, res);
    return response;
}
function jsonOf(response) {
    return JSON.parse(response.body);
}
const BASE = Date.UTC(2026, 9, 30, 9, 0, 0);
function withHarness(run) {
    const directory = mkdtempSync(join(tmpdir(), 'memory-sea-scene-'));
    const harness = createHarness(join(directory, 'scene.db'), directory);
    try {
        run(harness, {
            a: join(directory, 'project-a'),
            b: join(directory, 'project-b'),
            empty: join(directory, 'project-empty'),
        });
    }
    finally {
        harness.close();
        harness.dispose();
        try {
            rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
        catch {
            /* Windows 上数据库句柄释放有延迟，清理失败不影响断言结果 */
        }
    }
}
function seedScope(harness, rootPath, contents, sessionId) {
    const ids = [];
    contents.forEach((content, index) => {
        const result = harness.service.capture({
            content,
            sourceType: 'chat',
            role: 'user',
            sessionId,
            observedAt: BASE + index * 1000,
        }, { rootPath });
        ids.push(result.experience.id);
    });
    return ids;
}
test('Scene 映射：payload 保留 scope/points/edges/stats', () => {
    const scene = {
        scopeId: 'project_x',
        points: [{ id: 'ep_1' }],
        edges: [{ a: 'ep_1', b: 'ep_1', kind: 'contains' }],
        stats: { experiences: 1, episodes: 0, memories: 0, patterns: 0, edges: 1 },
    };
    const payload = toScenePayload(scene);
    assert.equal(payload.scopeId, 'project_x');
    assert.equal(payload.points.length, 1);
    assert.equal(payload.edges.length, 1);
});
test('Scene 校验：悬空边、缺 reason、非有限坐标都会报问题', () => {
    const bad = validateScene({
        points: [
            { id: 'a', type: 'experience', label: 'x', x: 0, y: 0, z: 0, size: 1, importance: 1, activation: 1, createdAt: 1 },
            { id: 'b', type: 'episode', label: 'y', x: Number.NaN, y: 0, z: 0, size: 1, importance: 1, activation: 1, createdAt: 1 },
        ],
        edges: [
            { a: 'a', b: 'missing', kind: 'contains', score: 1, reason: '' },
            { a: 'a', b: 'b', kind: 'contains', score: 1, reason: 'ok' },
        ],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((item) => item.includes('不存在的节点')));
    assert.ok(bad.problems.some((item) => item.includes('reason')));
    assert.ok(bad.problems.some((item) => item.includes('非有限数')));
});
test('空 Scene 校验通过；类型与边样式有稳定文案', () => {
    const empty = validateScene({ points: [], edges: [] });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.counts, { experience: 0, episode: 0, memory: 0, pattern: 0 });
    assert.equal(nodeTypeLabel('memory'), '长期记忆');
    assert.equal(edgeStyle('continues').label, '延续');
    assert.equal(edgeStyle('contains').dashed, false);
});
test('真实 service：Scene 内部一致、确定性、边都有 reason', () => {
    withHarness((harness, root) => {
        seedScope(harness, root.a, ['决定先用 SQLite 存记忆。', 'Neo4j 暂时不上。'], 's-a');
        const first = harness.service.getScene({ rootPath: root.a });
        const second = harness.service.getScene({ rootPath: root.a });
        assert.equal(JSON.stringify(first), JSON.stringify(second), '同一数据两次生成 Scene 必须完全一致');
        const validation = validateScene(first);
        assert.equal(validation.ok, true, validation.problems.join(' / '));
        const scene = first;
        assert.equal(typeof scene.scopeId, 'string');
        assert.ok(scene.points.every((point) => ['experience', 'episode', 'memory', 'pattern'].includes(point.type)));
        assert.ok(scene.edges.every((edge) => typeof edge.reason === 'string' && edge.reason.trim().length > 0));
    });
});
test('GET /scene?scope= 只返回该 scope；未知 scope 404', () => {
    withHarness((harness, root) => {
        seedScope(harness, root.a, ['A 项目的决定：使用 SQLite。'], 's-a');
        seedScope(harness, root.b, ['B 项目的决定：使用 PostgreSQL。'], 's-b');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const scopeB = harness.service.getScene({ rootPath: root.b }).scopeId;
        assert.notEqual(scopeA, scopeB);
        const responseA = callRoute(harness, '/api/memory-sea/scene', `/api/memory-sea/scene?scope=${scopeA}`);
        assert.equal(responseA.status, 200);
        const bodyA = jsonOf(responseA);
        assert.equal(bodyA.scopeId, scopeA);
        const idsA = new Set(harness.service.getScene({ scopeId: scopeA }).points.map((point) => point.id));
        assert.ok(bodyA.points.length > 0);
        assert.ok(bodyA.points.every((point) => idsA.has(point.id)));
        assert.equal(bodyA.points.length, idsA.size, 'scene 不应混入其它 scope 的节点');
        const unknown = callRoute(harness, '/api/memory-sea/scene', '/api/memory-sea/scene?scope=project_does_not_exist');
        assert.equal(unknown.status, 404);
        assert.equal(jsonOf(unknown).error, 'unknown scope');
    });
});
test('GET /status?scope= 按 scope 统计（不与默认 scope 混淆）', () => {
    withHarness((harness, root) => {
        seedScope(harness, root.a, ['一条经历。', '两条经历。'], 's-a');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const response = callRoute(harness, '/api/memory-sea/status', `/api/memory-sea/status?scope=${scopeA}`);
        assert.equal(response.status, 200);
        const body = jsonOf(response);
        assert.equal(body.scope.id, scopeA);
        assert.equal(body.experiences, 2);
    });
});
test('Experience 详情：正文/时间/所属 Episode；跨 scope 404', () => {
    withHarness((harness, root) => {
        const [experienceId] = seedScope(harness, root.a, ['决定先用 SQLite 存记忆。'], 's-a');
        seedScope(harness, root.b, ['另一个项目的经历。'], 's-b');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const scopeB = harness.service.getScene({ rootPath: root.b }).scopeId;
        const response = callRoute(harness, '/api/memory-sea/experiences', `/api/memory-sea/experiences/${experienceId}?scope=${scopeA}`);
        assert.equal(response.status, 200);
        const body = jsonOf(response);
        assert.equal(body.experience.id, experienceId);
        assert.equal(body.experience.content, '决定先用 SQLite 存记忆。');
        assert.ok(body.episode && typeof body.episode.id === 'string');
        const crossScope = callRoute(harness, '/api/memory-sea/experiences', `/api/memory-sea/experiences/${experienceId}?scope=${scopeB}`);
        assert.equal(crossScope.status, 404);
        const missing = callRoute(harness, '/api/memory-sea/experiences', '/api/memory-sea/experiences/xp_missing');
        assert.equal(missing.status, 404);
    });
});
test('Episode 详情：成员经历预览 + 证据记忆 + 连续性字段', () => {
    withHarness((harness, root) => {
        seedScope(harness, root.a, ['决定先用 SQLite 存记忆。', 'Neo4j 暂时不上。'], 's-a');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const scene = harness.service.getScene({ scopeId: scopeA });
        const episodePoint = scene.points.find((point) => point.type === 'episode');
        assert.ok(episodePoint, '应有 Episode 节点');
        const response = callRoute(harness, '/api/memory-sea/episodes', `/api/memory-sea/episodes/${episodePoint.id}?scope=${scopeA}`);
        assert.equal(response.status, 200);
        const body = jsonOf(response);
        assert.equal(body.episode.id, episodePoint.id);
        assert.equal(body.experiences.length, 2);
        assert.equal(body.stats.experienceCount, 2);
        assert.ok(body.experiences.every((item) => item.contentPreview.length > 0));
        assert.ok(Array.isArray(body.continuity.previous) && Array.isArray(body.continuity.next));
        assert.ok(Array.isArray(body.memories));
        const continuityOnly = callRoute(harness, '/api/memory-sea/episodes', `/api/memory-sea/episodes/${episodePoint.id}/continuity?scope=${scopeA}`);
        assert.equal(continuityOnly.status, 200);
        assert.ok(jsonOf(continuityOnly).continuity);
        const missing = callRoute(harness, '/api/memory-sea/episodes', '/api/memory-sea/episodes/ep_missing');
        assert.equal(missing.status, 404);
    });
});
test('Memory / Pattern 详情带 scope 时拒绝跨项目读取', () => {
    withHarness((harness, root) => {
        seedScope(harness, root.a, ['A 项目的经历。'], 's-a');
        seedScope(harness, root.b, ['B 项目的经历。'], 's-b');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const scopeB = harness.service.getScene({ rootPath: root.b }).scopeId;
        const internals = harness.service;
        const memory = internals.memories.create({
            id: 'mem_scope_guard_test', scopeId: scopeA, kind: 'decision', content: '仅属于 A 的知识', confidence: 0.9, importance: 0.8,
        });
        const pattern = internals.patterns.create({
            id: 'pat_scope_guard_test', scopeId: scopeA, kind: 'principle', content: '仅属于 A 的模式', confidence: 0.8, importance: 0.7,
        });
        const memoryOk = callRoute(harness, '/api/memory-sea/memories', `/api/memory-sea/memories/${memory.id}?scope=${scopeA}`);
        const memoryCross = callRoute(harness, '/api/memory-sea/memories', `/api/memory-sea/memories/${memory.id}?scope=${scopeB}`);
        assert.equal(memoryOk.status, 200);
        assert.equal(memoryCross.status, 404);
        const patternOk = callRoute(harness, '/api/memory-sea/patterns', `/api/memory-sea/patterns/${pattern.id}?scope=${scopeA}`);
        const patternCross = callRoute(harness, '/api/memory-sea/patterns', `/api/memory-sea/patterns/${pattern.id}?scope=${scopeB}`);
        assert.equal(patternOk.status, 200);
        assert.equal(patternCross.status, 404);
    });
});
test('空 scope：Scene 0 点 0 边，页面仍然可用', () => {
    withHarness((harness) => {
        // 不写任何数据：默认 scope 就是空的，Scene 必须如实返回 0 点 0 边。
        const emptyScene = harness.service.getScene();
        assert.ok(emptyScene.scopeId, 'Scene 必须带上 scopeId');
        assert.equal(emptyScene.points.length, 0);
        const scopeEmpty = emptyScene.scopeId;
        const response = callRoute(harness, '/api/memory-sea/scene', `/api/memory-sea/scene?scope=${scopeEmpty}`);
        assert.equal(response.status, 200);
        const body = jsonOf(response);
        assert.equal(body.points.length, 0);
        assert.equal(body.edges.length, 0);
        assert.equal(body.stats.memories, 0, 'Memory=0 必须如实返回，不能伪造');
    });
});
test('页面路由：自包含 HTML、无外链、无写操作', () => {
    withHarness((harness) => {
        const response = callRoute(harness, '/memory-sea/scene', '/memory-sea/scene');
        assert.equal(response.status, 200);
        assert.match(response.headers['content-type'], /text\/html/);
        const html = response.body;
        assert.ok(html.includes('<canvas id="sea"'), '页面必须有 3D 画布');
        assert.ok(html.includes('<script>') && html.includes('</script>'));
        assert.ok(html.includes('/api/memory-sea'), '页面应使用同源相对 API');
        assert.ok(!/https?:\/\//.test(html), '页面不允许引用外部 CDN/资源');
        assert.ok(!/method:\s*['"](POST|PUT|DELETE)['"]/i.test(html), '页面不允许发送写请求');
        assert.ok(html.includes('长期记忆') && html.includes('连续经历'), '页面应有三类节点的图例/文案');
        assert.ok(html.includes('pendingSelect') && html.includes('replaceState'), '页面应支持深链接（scope / select / q）');
        assert.ok(html.includes('rgba(44,74,116,0.10)') && html.includes('银河尘埃带'), '页面应包含低饱和深空尘埃云，而非霓虹色带');
        assert.ok(html.includes("core: '#8ff2c4'") && html.includes("core: '#ffd08a'"), '记忆/模式节点应有可辨识的强调色');
        assert.ok(html.includes('id="settings-panel"') && html.includes('id="settings-toggle"'), '设置应折叠在可展开面板里');
        assert.ok(html.includes('id="settings-panel" aria-label="星海设置" hidden'), '设置面板默认收起');
        assert.ok(html.indexOf('id="search"') > html.indexOf('id="settings-panel"'), '搜索框不应常驻顶部条');
        assert.ok(html.includes('wrapAngle('), '纵向旋转必须回绕而不是夹在上下限');
        assert.ok(html.includes('RESUME_AUTO_ROTATE_MS'), '松手后应能恢复自动旋转');
        assert.ok(!/Math\.max\(-1\.35, Math\.min\(1\.35/.test(html), '不应再有 ±1.35 的俯仰角夹取');
        assert.ok(html.includes('blur(6px)') && html.includes("'lighter'"), '亮节点应通过轻量泛光表达光源感，且不改变数据');
        assert.ok(html.includes('backgroundStars') && html.includes('920'), '背景星群应由确定性 Canvas 绘制');
        assert.ok(html.includes('id="edge-tooltip"') && html.includes('function pickEdge'), '真实关系边应支持悬停查看 reason');
        assert.ok(html.includes('id="detail-close"') && html.includes('scope-note'), '详情应按需展开/关闭，并解释 Memory=0 的真实空态');
        const fallback = callRoute(harness, '/api/memory-sea/ui', '/api/memory-sea/ui');
        assert.equal(fallback.status, 200, '回退入口也应可用');
        const paths = harness.routes.map((route) => route.path);
        assert.ok(!paths.some((path) => /execute|run_skill|policy/i.test(path)), '不得出现执行入口');
    });
});
test('Episode 详情预览是硬上限（<=240 字，含省略号）', () => {
    withHarness((harness, root) => {
        const longContent = '决定：'.concat('这是一段很长的经历，'.repeat(60));
        seedScope(harness, root.a, [longContent], 's-long');
        const scopeA = harness.service.getScene({ rootPath: root.a }).scopeId;
        const scene = harness.service.getScene({ scopeId: scopeA });
        const episodePoint = scene.points.find((point) => point.type === 'episode');
        assert.ok(episodePoint);
        const response = callRoute(harness, '/api/memory-sea/episodes', `/api/memory-sea/episodes/${episodePoint.id}?scope=${scopeA}`);
        assert.equal(response.status, 200);
        const body = jsonOf(response);
        assert.equal(body.experiences.length, 1);
        assert.ok(body.experiences[0].contentPreview.length <= 240, `预览长度 ${body.experiences[0].contentPreview.length} 超过 240`);
        assert.ok(body.experiences[0].contentPreview.endsWith('…'), '长文本预览应带省略号');
        assert.equal(body.stats.truncated, true, '被截断时 stats.truncated 应为 true');
    });
});
