/**
 * tests/summary.test.ts —— Episode 摘要层（spec §13 / §14）。
 *
 * 重点验证两类不变量：
 *   1. 抽取式：确定性（同输入同输出）、标题不被 JSON 回执/宿主运行时行污染、
 *      摘要去重且 ≤400 字、参与者/地点/主题非空、空 experiences 不抛错。
 *   2. LLM：模型输出合法时采用；输出非法/HTTP 500 时**回退到抽取式**且结果与直接调用一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractiveSummarizer } from '../src/summary/extractive-summarizer.js';
import { LlmEpisodeSummarizer } from '../src/summary/llm-summarizer.js';
import { createEpisodeSummarizer } from '../src/summary/episode-summarizer.js';
const BASE_TIME = Date.UTC(2026, 0, 1, 9, 0, 0);
function makeExperience(overrides) {
    const base = {
        id: 'xp_base',
        sourceType: 'chat',
        content: overrides.content,
        createdAt: BASE_TIME,
        observedAt: BASE_TIME,
        importance: 0.5,
        metadata: {},
        embeddingStatus: 'pending',
    };
    return { ...base, ...overrides };
}
function makeEpisode(overrides = {}) {
    const base = {
        id: 'ep_test',
        startedAt: BASE_TIME,
        endedAt: BASE_TIME + 60_000,
        experienceIds: [],
        participants: [],
        locations: [],
        topics: [],
        importance: 0.5,
        salience: 0.5,
        confidence: 0.5,
        status: 'closed',
        consolidationStatus: 'pending',
        continuityStatus: 'pending',
        lastExperienceAt: BASE_TIME + 60_000,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        embeddingStatus: 'pending',
        summaryStatus: 'pending',
    };
    return { ...base, ...overrides };
}
function chat(content, id = 'xp_chat') {
    return makeExperience({ id, sourceType: 'chat', content });
}
/** 用假的 fetch 替换网络层；测试不启动任何服务。 */
function fakeFetch(handler) {
    return ((input, init) => Promise.resolve(handler(String(input), init)));
}
/** 构造一个 OpenAI 兼容的 /chat/completions 成功响应。 */
function openAiResponse(content, status = 200) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
// ------------------------------------------------------------------ 抽取式
test('extractive：标题不被 JSON 回执与宿主运行时注入行污染', async () => {
    const summarizer = new ExtractiveSummarizer();
    const experiences = [
        // 工具回执：可以记录成 Experience，但绝不能当标题。
        makeExperience({ id: 'xp_tool', sourceType: 'tool', content: '{"stage":"enable","ok":true}' }),
        // 宿主注入的运行上下文行 + 后面才是用户真实内容。
        chat('Time sampled while preparing turn 1, step 1: 2026-10-29\n今天和王哥讨论 Episode 摘要层的设计，地点在会议室。'),
    ];
    const result = await summarizer.summarize(makeEpisode(), experiences);
    assert.ok(result.title);
    assert.ok(result.title.startsWith('今天和王哥讨论'), `实际标题：${result.title}`);
    assert.ok(!result.title.includes('stage'), '标题里不该出现 JSON 回执内容');
    assert.ok(!result.title.toLowerCase().includes('time sampled'), '标题里不该出现宿主运行时行');
    assert.ok(!result.title.startsWith('{'), '标题不能以 JSON 开头');
});
test('extractive：没有可用自然语言时回退到 Episode 标题，再回退到固定文案', async () => {
    const summarizer = new ExtractiveSummarizer();
    const onlyStructured = [
        makeExperience({ id: 'xp_tool', sourceType: 'tool', content: '{"stage":"enable","ok":true}' }),
    ];
    const withTitle = await summarizer.summarize(makeEpisode({ title: '工具会话' }), onlyStructured);
    assert.equal(withTitle.title, '工具会话');
    const withoutTitle = await summarizer.summarize(makeEpisode({ title: '' }), onlyStructured);
    assert.equal(withoutTitle.title, '一段经历');
});
test('extractive：摘要去重、≤400 字，且参与者/地点/主题非空', async () => {
    const summarizer = new ExtractiveSummarizer();
    const repeated = '整理 Memory Sea 摘要层。';
    const longBody = Array.from({ length: 12 }, (_, index) => `第${index + 1}项：确定摘要层只做抽取式，保持确定性并且不联网。`).join('');
    const experiences = [
        chat(repeated, 'xp_a'),
        // 同一句话被 manual 再记一次：相邻重复句必须去重。
        makeExperience({ id: 'xp_b', sourceType: 'manual', content: repeated }),
        chat(longBody, 'xp_c'),
        chat('今天和王哥讨论 Episode 摘要层的设计，地点在会议室。', 'xp_d'),
    ];
    const result = await summarizer.summarize(makeEpisode(), experiences);
    assert.ok(result.summary.length > 0);
    assert.ok(result.summary.length <= 400, `摘要长度 ${result.summary.length} 超过 400`);
    assert.equal(result.summary.split(repeated).length - 1, 1, `重复句应只保留一次，实际摘要：${result.summary}`);
    assert.deepEqual(result.participants, ['王哥']);
    assert.deepEqual(result.locations, ['会议室']);
    const topics = result.topics ?? [];
    assert.ok(topics.length > 0, 'topics 不应为空');
    assert.ok(topics.length <= 8);
    assert.ok((result.participants ?? []).length <= 6);
    assert.ok((result.locations ?? []).length <= 6);
    assert.ok(result.confidence !== undefined);
    assert.ok(result.confidence >= 0.3 && result.confidence <= 0.8, `confidence=${result.confidence}`);
    // 保留 2 位小数断言：0.7 而不是 0.700000000001。
    assert.equal(result.confidence, Math.round(result.confidence * 100) / 100);
});
test('extractive：单个超长句被截断到 400 字以内并补省略号', async () => {
    const summarizer = new ExtractiveSummarizer();
    const huge = '很长的经历描述'.repeat(120); // >400 字、无句末标点
    const result = await summarizer.summarize(makeEpisode(), [chat(huge)]);
    assert.ok(result.summary.length <= 400);
    assert.ok(result.summary.endsWith('…'));
});
test('extractive：同一输入两次结果完全一致（确定性）', async () => {
    const summarizer = new ExtractiveSummarizer();
    const experiences = [
        chat('第一件事是把摘要层做成纯函数。', 'xp_1'),
        chat('第二件事是保证 LLM 失败时回退到抽取式。', 'xp_2'),
        makeExperience({ id: 'xp_3', sourceType: 'diary', content: '晚上复盘：召回质量取决于 Episode 摘要。' }),
    ];
    const episode = makeEpisode();
    const first = await summarizer.summarize(episode, experiences);
    const second = await summarizer.summarize(episode, experiences);
    assert.deepEqual(first, second);
});
test('extractive：空 experiences 不抛错，返回合法结果', async () => {
    const summarizer = new ExtractiveSummarizer();
    const result = await summarizer.summarize(makeEpisode({ title: '空纪录' }), []);
    assert.equal(result.title, '空纪录');
    assert.equal(result.summary, '');
    assert.deepEqual(result.participants, []);
    assert.deepEqual(result.locations, []);
    assert.deepEqual(result.topics, []);
    assert.equal(result.confidence, 0.3);
});
// ------------------------------------------------------------------ LLM
test('llm：模型返回合法 JSON（含代码块包裹）时采用模型结果', async () => {
    const captured = [];
    const payload = {
        title: '模型生成的标题',
        summary: '模型生成的摘要：摘要层已完成。',
        participants: ['甲', '乙'],
        locations: ['公司'],
        topics: ['摘要'],
        confidence: 1.7, // 非法上限，应被 clamp 到 1
    };
    const fetchImpl = fakeFetch((url, init) => {
        captured.push({ url, init });
        return openAiResponse('```json\n' + JSON.stringify(payload) + '\n```');
    });
    const summarizer = new LlmEpisodeSummarizer({
        endpoint: 'http://127.0.0.1:1234/v1/',
        apiKey: '',
        model: 'local-model',
        fetchImpl,
        fallback: new ExtractiveSummarizer(),
    });
    const result = await summarizer.summarize(makeEpisode(), [chat('今天和王哥讨论摘要层。')]);
    assert.equal(result.title, '模型生成的标题');
    assert.equal(result.summary, '模型生成的摘要：摘要层已完成。');
    assert.deepEqual(result.participants, ['甲', '乙']);
    assert.deepEqual(result.locations, ['公司']);
    assert.deepEqual(result.topics, ['摘要']);
    assert.equal(result.confidence, 1);
    // 端点尾部斜杠被规范化，且没有 apiKey 时不发 Authorization 头。
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, 'http://127.0.0.1:1234/v1/chat/completions');
    const headers = (captured[0]?.init?.headers ?? {});
    assert.equal(headers.authorization, undefined);
});
const FALLBACK_EXPERIENCES = [
    chat('今天和王哥讨论 Episode 摘要层的设计，地点在会议室。', 'xp_f1'),
    makeExperience({ id: 'xp_f2', sourceType: 'tool', content: '{"stage":"enable","ok":true}' }),
];
async function extractiveResult() {
    return new ExtractiveSummarizer().summarize(makeEpisode({ title: '回退标题' }), FALLBACK_EXPERIENCES);
}
test('llm：非法 JSON 时回退到抽取式，结果与直接调用一致', async () => {
    const fetchImpl = fakeFetch(() => openAiResponse('抱歉，我无法输出 JSON。'));
    const summarizer = new LlmEpisodeSummarizer({
        endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test',
        model: 'local-model',
        fetchImpl,
        fallback: new ExtractiveSummarizer(),
    });
    const result = await summarizer.summarize(makeEpisode({ title: '回退标题' }), FALLBACK_EXPERIENCES);
    assert.deepEqual(result, await extractiveResult());
});
test('llm：HTTP 500 时回退到抽取式，结果与直接调用一致', async () => {
    const fetchImpl = fakeFetch(() => new Response('boom', { status: 500 }));
    const summarizer = new LlmEpisodeSummarizer({
        endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test',
        model: 'local-model',
        fetchImpl,
        fallback: new ExtractiveSummarizer(),
    });
    const result = await summarizer.summarize(makeEpisode({ title: '回退标题' }), FALLBACK_EXPERIENCES);
    assert.deepEqual(result, await extractiveResult());
});
test('llm：fetch 直接抛错时也回退，绝不把异常抛给调用方', async () => {
    const fetchImpl = fakeFetch(() => {
        throw new Error('ECONNREFUSED');
    });
    const summarizer = new LlmEpisodeSummarizer({
        endpoint: 'http://127.0.0.1:1234/v1',
        apiKey: '',
        model: 'local-model',
        fetchImpl,
        fallback: new ExtractiveSummarizer(),
    });
    const result = await summarizer.summarize(makeEpisode({ title: '回退标题' }), FALLBACK_EXPERIENCES);
    assert.deepEqual(result, await extractiveResult());
});
// ------------------------------------------------------------------ 选择器
test('createEpisodeSummarizer：默认（enabled=true）返回抽取式', () => {
    const selection = createEpisodeSummarizer({ enabled: true });
    assert.equal(selection.kind, 'extractive');
    assert.equal(selection.summarizer.name, 'extractive');
    assert.equal(selection.label, 'extractive');
    assert.equal(selection.configured, true);
});
test('createEpisodeSummarizer：enabled=false 时 configured=false（抽取式仍可调用）', () => {
    const selection = createEpisodeSummarizer({ enabled: false });
    assert.equal(selection.kind, 'extractive');
    assert.equal(selection.summarizer.name, 'extractive');
    assert.equal(selection.configured, false);
});
test('createEpisodeSummarizer：provider=llm 且环境变量齐全时选 LLM，且 label 不含 apiKey', () => {
    const env = {
        DSH_MEMORY_SEA_SUMMARY_ENDPOINT: 'http://127.0.0.1:1234/v1',
        DSH_MEMORY_SEA_SUMMARY_API_KEY: 'sk-secret-should-not-leak',
        DSH_MEMORY_SEA_SUMMARY_MODEL: 'local-model',
    };
    const selection = createEpisodeSummarizer({ enabled: true, provider: 'llm' }, env);
    assert.equal(selection.kind, 'llm');
    assert.equal(selection.summarizer.name, 'llm');
    assert.equal(selection.configured, true);
    assert.equal(selection.label, 'llm:local-model');
    assert.ok(!selection.label.includes('sk-secret-should-not-leak'), 'label 绝不能包含 apiKey');
});
test('createEpisodeSummarizer：provider=llm 但缺 endpoint/model 时降级为抽取式', () => {
    const selection = createEpisodeSummarizer({ enabled: true, provider: 'llm' }, {});
    assert.equal(selection.kind, 'extractive');
    assert.equal(selection.configured, false);
});
test('抽取式摘要：工具输出不进摘要与参与者', async () => {
    const summarizer = new ExtractiveSummarizer();
    const episode = makeEpisode();
    const windowsPath = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92) + 'app' + String.fromCharCode(92) + 'src' + String.fromCharCode(92) + 'errors.ts';
    const toolOutput = makeExperience({
        id: 'xp_tool_1',
        sourceType: 'tool',
        content: '53|export type SqlValue = string | number | bigint | null | Uint8Array。' + windowsPath,
    });
    const compileError = makeExperience({
        id: 'xp_tool_2',
        sourceType: 'tool',
        content: 'src/capture/episode-builder.ts(132,11): error TS2739: Type is missing properties',
    });
    const experiences = [
        chat('今天和老王讨论 Memory Sea 的技术选型，决定先用 SQLite。', 'xp_chat_1'),
        toolOutput,
        compileError,
    ];
    const result = await summarizer.summarize(episode, experiences);
    assert.ok(result.summary.includes('SQLite'), '摘要应包含人写的结论');
    assert.ok(!result.summary.includes('export type'), '摘要不应包含代码片段');
    assert.ok(!result.summary.includes('error TS'), '摘要不应包含编译错误');
    for (const participant of result.participants ?? []) {
        assert.ok(!participant.includes('Users'), '参与者不应来自工具输出的路径片段');
    }
});
