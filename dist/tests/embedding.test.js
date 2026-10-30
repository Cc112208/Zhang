/**
 * tests/embedding.test.ts —— embedding / 语义召回层（spec §24 / §25）。
 *
 * 全部离线：OpenAI 兼容 provider 通过注入的假 fetch 校验「请求长什么样、响应怎么解析」，
 * 不碰真实网络；向量存储与召回都用 :memory: SQLite。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDatabase } from '../src/storage/database.js';
import { NoopEmbeddingProvider } from '../src/embedding/noop-provider.js';
import { OpenAiCompatibleEmbeddingProvider } from '../src/embedding/openai-compatible-provider.js';
import { contentHashOf, EmbeddingRepository } from '../src/embedding/embedding-repository.js';
import { cosineSimilarity, createEmbeddingProvider } from '../src/embedding/embedding-provider.js';
import { NullSemanticRecall, SqliteSemanticRecall } from '../src/recall/semantic-recall.js';
// ------------------------------------------------------------------ 工具
function f32(values) {
    return Float32Array.from(values);
}
function assertVectorClose(actual, expected, label = 'vector') {
    assert.equal(actual.length, expected.length, `${label} 维度不一致`);
    for (let i = 0; i < expected.length; i += 1) {
        assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}[${i}] = ${actual[i]}，期望 ${expected[i]}`);
    }
}
/** 构造一个假 fetch：记录调用参数，并由回调决定响应。 */
function makeFetch(handler) {
    const calls = [];
    const fetchImpl = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, init: init ?? {} });
        return handler(url, init ?? {});
    });
    return { fetchImpl, calls };
}
function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
/** 假 embedder：把固定向量当作任意 query 的 embedding，便于验证排序/隔离。 */
class StubEmbedder {
    name = 'stub';
    model = 'stub-model';
    dimensions;
    vector;
    calls = 0;
    constructor(vector) {
        this.vector = f32(vector);
        this.dimensions = this.vector.length;
    }
    async isAvailable() {
        return true;
    }
    async embed(_text) {
        this.calls += 1;
        return this.vector;
    }
}
function openRepo(provider = 'openai-compatible', model = 'text-embedding-3-small') {
    const db = MemoryDatabase.open(':memory:');
    const repo = new EmbeddingRepository({ db, provider, model });
    return { db, repo, cleanup: () => db.close() };
}
// ------------------------------------------------------------------ Noop
test('NoopEmbeddingProvider：不可用、零维度、空向量、带 reason', async () => {
    const disabled = new NoopEmbeddingProvider('disabled');
    assert.equal(disabled.name, 'noop');
    assert.equal(disabled.model, 'noop');
    assert.equal(disabled.dimensions, 0);
    assert.equal(disabled.reason, 'disabled');
    assert.equal(await disabled.isAvailable(), false);
    assert.equal((await disabled.embed('任意文本')).length, 0);
    assert.deepEqual(await disabled.embedBatch(['a', 'b']), []);
    const notConfigured = new NoopEmbeddingProvider('not-configured');
    assert.equal(notConfigured.reason, 'not-configured');
    assert.equal(await notConfigured.isAvailable(), false);
});
test('createEmbeddingProvider：关闭时返回 noop，且 selection 不泄漏 apiKey', () => {
    const selection = createEmbeddingProvider({ enabled: false, provider: 'openai-compatible', apiKey: 'sk-secret' }, {});
    assert.equal(selection.configured, false);
    assert.equal(selection.provider.name, 'noop');
    assert.equal(selection.label, 'noop');
    assert.equal(selection.dimensions, 0);
    assert.equal(JSON.stringify(selection).includes('sk-secret'), false);
});
// ------------------------------------------------------------------ cosine
test('cosineSimilarity：空数组 / 维度不一致返回 0，不抛错', () => {
    assert.equal(cosineSimilarity(f32([]), f32([])), 0);
    assert.equal(cosineSimilarity(f32([1, 0]), f32([])), 0);
    assert.equal(cosineSimilarity(f32([1, 0]), f32([1, 0, 0])), 0);
});
test('cosineSimilarity：相同=1、正交=0、相反=-1', () => {
    assert.ok(Math.abs(cosineSimilarity(f32([1, 2, 3]), f32([1, 2, 3])) - 1) < 1e-6);
    assert.equal(cosineSimilarity(f32([1, 0]), f32([0, 1])), 0);
    assert.ok(Math.abs(cosineSimilarity(f32([1, 0]), f32([-1, 0])) + 1) < 1e-6);
});
// ------------------------------------------------------------------ OpenAI 兼容
test('OpenAiCompatibleEmbeddingProvider：URL / 请求体 / Authorization / 维度确定', async () => {
    const { fetchImpl, calls } = makeFetch(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: 'https://example.test/v1/',
        apiKey: 'sk-test',
        model: 'embed-small',
        fetchImpl,
    });
    assert.equal(provider.name, 'openai-compatible');
    assert.equal(provider.dimensions, 0, '未配置 dimensions 时，首次成功调用前应未知');
    assert.equal(await provider.isAvailable(), true);
    const vector = await provider.embed('你好');
    assertVectorClose(vector, [0.1, 0.2, 0.3]);
    assert.equal(provider.dimensions, 3, '首次成功响应应固化维度');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/v1/embeddings', 'baseUrl 结尾斜杠应被规范化');
    const init = calls[0].init;
    assert.equal(init.method, 'POST');
    const headers = init.headers;
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.deepEqual(JSON.parse(String(init.body)), { model: 'embed-small', input: ['你好'] });
    assert.ok(init.signal instanceof AbortSignal);
});
test('OpenAiCompatibleEmbeddingProvider：embedBatch 批量解析且维度与配置一致', async () => {
    const { fetchImpl, calls } = makeFetch(async () => jsonResponse({
        data: [
            { embedding: [1, 0] },
            { embedding: [0, 1] },
        ],
    }));
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
        dimensions: 2,
        fetchImpl,
    });
    const vectors = await provider.embedBatch(['a', 'b']);
    assert.equal(vectors.length, 2);
    assertVectorClose(vectors[0], [1, 0]);
    assertVectorClose(vectors[1], [0, 1]);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { model: 'm', input: ['a', 'b'] });
    assert.equal((await provider.embedBatch([])).length, 0, '空输入不应发请求');
    assert.equal(calls.length, 1);
});
test('OpenAiCompatibleEmbeddingProvider：配置维度与实际不符时抛错', async () => {
    const { fetchImpl } = makeFetch(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
        dimensions: 2,
        fetchImpl,
    });
    await assert.rejects(() => provider.embed('x'), /维度与配置不一致/);
    assert.equal(provider.dimensions, 2, '失败不应改写已配置维度');
});
test('OpenAiCompatibleEmbeddingProvider：非 2xx 抛错并带状态码，不吞成空结果', async () => {
    const { fetchImpl } = makeFetch(async () => jsonResponse({ error: 'bad key' }, 401));
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
        fetchImpl,
    });
    await assert.rejects(() => provider.embed('x'), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        return true;
    });
});
test('OpenAiCompatibleEmbeddingProvider：网络错误抛错（不产生空向量）', async () => {
    const { fetchImpl } = makeFetch(async () => {
        throw new TypeError('fetch failed');
    });
    const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
        fetchImpl,
    });
    await assert.rejects(() => provider.embed('x'), /网络错误|无 HTTP 状态码/);
});
// ------------------------------------------------------------------ Repository
test('EmbeddingRepository：向量往返、元数据、计数', () => {
    const { repo, cleanup } = openRepo();
    try {
        const hash = contentHashOf('第一段记忆');
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'experience',
            ownerId: 'xp_1',
            vector: f32([0.1, 0.2, 0.3]),
            contentHash: hash,
        });
        const stored = repo.get('experience', 'xp_1');
        assert.ok(stored);
        assertVectorClose(stored.vector, [0.1, 0.2, 0.3]);
        assert.equal(stored.contentHash, hash, 'BLOB 往返后 contentHash 应保持不变');
        const meta = repo.metadata('experience', 'xp_1');
        assert.deepEqual(meta, {
            provider: 'openai-compatible',
            model: 'text-embedding-3-small',
            dimensions: 3,
            contentHash: hash,
            createdAt: meta?.createdAt,
        });
        assert.equal(typeof meta?.createdAt, 'number');
        assert.equal(repo.countByScope('project-a'), 1);
        assert.equal(repo.countByScope('project-b'), 0);
        assert.equal(repo.get('episode', 'xp_1'), null, 'ownerType 不同应查不到');
    }
    finally {
        cleanup();
    }
});
test('EmbeddingRepository：同主键覆盖写 vector/hash/维度，不新增行', () => {
    const { repo, cleanup } = openRepo();
    try {
        repo.upsert({
            scopeId: 's',
            ownerType: 'experience',
            ownerId: 'xp_1',
            vector: f32([1, 0, 0]),
            contentHash: contentHashOf('旧文本'),
        });
        repo.upsert({
            scopeId: 's',
            ownerType: 'experience',
            ownerId: 'xp_1',
            vector: f32([0, 1]),
            contentHash: contentHashOf('新文本'),
        });
        const stored = repo.get('experience', 'xp_1');
        assert.ok(stored);
        assertVectorClose(stored.vector, [0, 1]);
        assert.equal(stored.contentHash, contentHashOf('新文本'));
        assert.equal(repo.countByScope('s'), 1, 'UNIQUE 冲突应走 UPDATE 而不是插入新行');
        assert.equal(repo.metadata('experience', 'xp_1')?.dimensions, 2);
    }
    finally {
        cleanup();
    }
});
test('EmbeddingRepository：contentHash 随文本变化，且拒绝空向量', () => {
    assert.notEqual(contentHashOf('同一句话'), contentHashOf('同一句话。'));
    assert.equal(contentHashOf('abc'), contentHashOf('abc'));
    assert.match(contentHashOf('abc'), /^[0-9a-f]{64}$/);
    const { repo, cleanup } = openRepo();
    try {
        assert.throws(() => repo.upsert({
            scopeId: 's',
            ownerType: 'episode',
            ownerId: 'ep_1',
            vector: f32([]),
            contentHash: contentHashOf('x'),
        }), /向量为空/);
        assert.equal(repo.countByScope('s'), 0);
    }
    finally {
        cleanup();
    }
});
test('EmbeddingRepository：按 scope 隔离（loadVectors 不跨项目）', () => {
    const { repo, cleanup } = openRepo();
    try {
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'experience',
            ownerId: 'xp_a',
            vector: f32([1, 0]),
            contentHash: contentHashOf('a'),
        });
        repo.upsert({
            scopeId: 'project-b',
            ownerType: 'experience',
            ownerId: 'xp_b',
            vector: f32([0, 1]),
            contentHash: contentHashOf('b'),
        });
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'episode',
            ownerId: 'ep_a',
            vector: f32([0.5, 0.5]),
            contentHash: contentHashOf('c'),
        });
        const a = repo.loadVectors('project-a', ['experience', 'episode']);
        assert.deepEqual(a.map((row) => row.ownerId).sort(), ['ep_a', 'xp_a']);
        assert.deepEqual(a.map((row) => row.ownerType).sort(), ['episode', 'experience']);
        const onlyExperiences = repo.listByOwnerType('project-a', 'experience');
        assert.deepEqual(onlyExperiences.map((row) => row.ownerId), ['xp_a']);
        assert.deepEqual(repo.loadVectors('project-a', ['experience'], 1).length, 1, 'limit 应生效');
        assert.deepEqual(repo.loadVectors('missing-scope', ['experience']), []);
        assert.deepEqual(repo.loadVectors('project-a', []), [], '空 ownerTypes 不应查全表');
    }
    finally {
        cleanup();
    }
});
// ------------------------------------------------------------------ 语义召回
test('SqliteSemanticRecall：按 cosine 降序、只保留正分、尊重 limit', async () => {
    const { repo, cleanup } = openRepo();
    try {
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'experience',
            ownerId: 'xp_same',
            vector: f32([1, 0]),
            contentHash: contentHashOf('同向'),
        });
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'experience',
            ownerId: 'xp_mid',
            vector: f32([0.6, 0.8]),
            contentHash: contentHashOf('中间'),
        });
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'episode',
            ownerId: 'ep_orthogonal',
            vector: f32([0, 1]),
            contentHash: contentHashOf('正交'),
        });
        const embedder = new StubEmbedder([1, 0]);
        const recall = new SqliteSemanticRecall({ embeddings: repo, embedder });
        assert.equal(recall.available, true);
        const hits = await recall.search('project-a', 'query', 10);
        assert.deepEqual(hits.map((hit) => hit.id), ['xp_same', 'xp_mid'], '正交候选（score=0）不应进入结果');
        assert.ok(Math.abs(hits[0].score - 1) < 1e-6);
        assert.ok(hits[1].score > 0 && hits[1].score < hits[0].score);
        assert.equal(hits[1].type, 'experience');
        assert.equal((await recall.search('project-a', 'query', 1)).length, 1, 'limit 应截断');
        assert.equal(embedder.calls, 2, '每次 search 只应 embed 一次 query');
    }
    finally {
        cleanup();
    }
});
test('SqliteSemanticRecall：scope 隔离，且不返回其它项目的向量', async () => {
    const { repo, cleanup } = openRepo();
    try {
        repo.upsert({
            scopeId: 'project-a',
            ownerType: 'experience',
            ownerId: 'xp_a',
            vector: f32([1, 0]),
            contentHash: contentHashOf('a'),
        });
        repo.upsert({
            scopeId: 'project-b',
            ownerType: 'experience',
            ownerId: 'xp_b',
            vector: f32([1, 0]),
            contentHash: contentHashOf('b'),
        });
        const recall = new SqliteSemanticRecall({ embeddings: repo, embedder: new StubEmbedder([1, 0]) });
        const hits = await recall.search('project-b', 'query', 10);
        assert.deepEqual(hits.map((hit) => hit.id), ['xp_b']);
    }
    finally {
        cleanup();
    }
});
test('SqliteSemanticRecall：维度不一致跳过并 warn，不整批失败', async () => {
    const { repo, cleanup } = openRepo();
    try {
        repo.upsert({
            scopeId: 's',
            ownerType: 'experience',
            ownerId: 'xp_ok',
            vector: f32([1, 0]),
            contentHash: contentHashOf('ok'),
        });
        // 老模型的 3 维向量（换模型后没重算）：应被跳过而不是让整个语义通道抛错。
        repo.upsert({
            scopeId: 's',
            ownerType: 'experience',
            ownerId: 'xp_stale',
            vector: f32([1, 0, 0]),
            contentHash: contentHashOf('stale'),
        });
        const warnings = [];
        const recall = new SqliteSemanticRecall({
            embeddings: repo,
            embedder: new StubEmbedder([1, 0]),
            logger: { warn: (message) => warnings.push(message) },
        });
        const hits = await recall.search('s', 'q', 10);
        assert.deepEqual(hits.map((hit) => hit.id), ['xp_ok']);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /维度/);
    }
    finally {
        cleanup();
    }
});
test('SqliteSemanticRecall：无 embedder / 维度未知时不可用且返回空', async () => {
    const nullRecall = new NullSemanticRecall();
    assert.equal(nullRecall.available, false);
    assert.deepEqual(await nullRecall.search('s', 'q', 5), []);
    const { repo, cleanup } = openRepo();
    try {
        const withoutEmbedder = new SqliteSemanticRecall({ embeddings: repo, embedder: null });
        assert.equal(withoutEmbedder.available, false);
        assert.deepEqual(await withoutEmbedder.search('s', 'q', 5), []);
        const zeroDimensional = new SqliteSemanticRecall({
            embeddings: repo,
            embedder: new NoopEmbeddingProvider('not-configured'),
        });
        assert.equal(zeroDimensional.available, false);
        assert.deepEqual(await zeroDimensional.search('s', 'q', 5), []);
    }
    finally {
        cleanup();
    }
});
