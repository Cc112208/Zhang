/**
 * tests/pattern-analyzer.test.ts —— Stage 4 Pattern 分析器验收。
 *
 * 本模块是纯函数 + 一个可选 fetch：不连数据库、不建临时库，
 * 直接用字面量造 SemanticMemory / PatternMemory，把「结构相似而不是文本相似」这条核心断言钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleBasedPatternAnalyzer } from '../src/pattern-analysis/rule-based-pattern-analyzer.js';
import { LlmPatternAnalyzer } from '../src/pattern-analysis/llm-pattern-analyzer.js';
import { createPatternAnalyzer } from '../src/pattern-analysis/pattern-analyzer.js';
import { conceptById } from '../src/pattern/pattern-lifecycle.js';
const SCOPE = 'scope-pattern-test';
const NOW = Date.UTC(2026, 0, 1, 9, 0, 0);
let memorySeq = 0;
let patternSeq = 0;
function makeMemory({ content, ...partial }) {
    memorySeq += 1;
    return {
        id: `mem-${memorySeq}`,
        scopeId: SCOPE,
        kind: 'decision',
        confidence: 0.85,
        importance: 0.6,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        reinforcementCount: 1,
        accessCount: 0,
        embeddingStatus: 'ready',
        ...partial,
        content,
    };
}
function makePattern({ content, ...partial }) {
    patternSeq += 1;
    return {
        id: `pat-${patternSeq}`,
        scopeId: SCOPE,
        kind: 'recurring_decision',
        confidence: 0.8,
        importance: 0.6,
        supportCount: 3,
        contradictionCount: 0,
        status: 'active',
        firstObservedAt: NOW,
        lastObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        accessCount: 0,
        embeddingStatus: 'ready',
        ...partial,
        content,
    };
}
function contextOf(relatedMemories, triggerMemory, existingPatterns = []) {
    return { scopeId: SCOPE, triggerMemory, relatedMemories, existingPatterns };
}
/** 断言恰好一个指定类型的操作，并把它窄化成对应类型。 */
function singleOperation(operations, type) {
    assert.equal(operations.length, 1, `期望 1 个操作，实际 ${operations.length} 个`);
    const operation = operations[0];
    if (!operation || operation.type !== type) {
        assert.fail(`期望 ${type} 操作，实际 ${operation?.type ?? '(空)'}`);
    }
    return operation;
}
/** 三条文本完全不同、但共享 avoid_infra_complexity 结构的知识 + 一条 trigger。 */
function infraContext() {
    const related = [
        makeMemory({ id: 'm1', content: '先用 SQLite，避免额外部署' }),
        makeMemory({ id: 'm2', content: '暂不引入 Redis，当前规模没必要' }),
        makeMemory({ id: 'm3', content: '保持单进程，不做分布式' }),
    ];
    const trigger = makeMemory({ id: 'm4', content: '基础设施越简单越好，部署能省则省' });
    return contextOf(related, trigger);
}
test('规则式：3 条不同文本共享 avoid_infra_complexity → create 一个 recurring_decision', async () => {
    const analyzer = new RuleBasedPatternAnalyzer();
    const result = await analyzer.analyze(infraContext());
    const operation = singleOperation(result.operations, 'create');
    assert.equal(operation.kind, 'recurring_decision');
    assert.ok(operation.content.length > 0);
    assert.ok(operation.supportingMemoryIds.length >= 3, '至少 3 条 Memory 支持');
    assert.equal(new Set(operation.supportingMemoryIds).size, operation.supportingMemoryIds.length, '证据 id 不应重复');
    assert.ok(operation.confidence > 0 && operation.confidence <= 1);
    assert.ok(operation.importance > 0);
});
test('规则式：只有 2 条证据且 minSupport=3 → noop，绝不 create', async () => {
    const analyzer = new RuleBasedPatternAnalyzer({ minSupport: 3 });
    const context = contextOf([makeMemory({ id: 'm1', content: '先用 SQLite，避免额外部署' })], makeMemory({ id: 'm2', content: '保持单进程，当前规模够用' }));
    const result = await analyzer.analyze(context);
    const nonNoop = result.operations.filter((operation) => operation.type !== 'noop');
    assert.equal(result.operations.length >= 1, true);
    assert.equal(nonNoop.length, 0, '证据不足时只能是 noop，不得 create');
});
test('规则式：已有同一概念家族的 active Pattern → reinforce，且不产生 create', async () => {
    const concept = conceptById('avoid_infra_complexity');
    assert.ok(concept);
    const existing = makePattern({ id: 'pat-infra', content: concept.statement, kind: 'recurring_decision' });
    const analyzer = new RuleBasedPatternAnalyzer();
    const result = await analyzer.analyze(contextOf(infraContext().relatedMemories, infraContext().triggerMemory, [existing]));
    const operation = singleOperation(result.operations, 'reinforce');
    assert.equal(operation.patternId, 'pat-infra');
    assert.ok(operation.supportingMemoryIds.length >= 3);
    assert.equal(result.operations.some((op) => op.type === 'create'), false, '不得 create 重复模式');
});
test('规则式：local_first 旧模式 + 转向托管云的新 Memory → weaken', async () => {
    const concept = conceptById('local_first');
    assert.ok(concept);
    const existing = makePattern({ id: 'pat-local', content: concept.statement, kind: 'preference' });
    const related = [
        makeMemory({ id: 'm1', content: '数据尽量留在本地' }),
        makeMemory({ id: 'm2', content: '本地文件存储' }),
        makeMemory({ id: 'm3', content: '优先离线运行' }),
        makeMemory({ id: 'm4', content: '离线优先，不依赖网络' }),
    ];
    const trigger = makeMemory({ id: 'm-cloud', content: '后续决策转向托管云服务，使用云数据库' });
    const analyzer = new RuleBasedPatternAnalyzer();
    const result = await analyzer.analyze(contextOf(related, trigger, [existing]));
    const operation = singleOperation(result.operations, 'weaken');
    assert.equal(operation.patternId, 'pat-local');
    assert.deepEqual(operation.contradictingMemoryIds, ['m-cloud']);
    assert.equal(operation.confidenceDelta, 0.1);
});
test('LLM 分析器：fetch 抛错时自动回退规则式，且不抛错', async () => {
    const context = infraContext();
    const ruleBased = new RuleBasedPatternAnalyzer();
    const expected = await ruleBased.analyze(context);
    const analyzer = new LlmPatternAnalyzer({
        endpoint: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        timeoutMs: 500,
        fetchImpl: async () => {
            throw new Error('network down');
        },
        fallback: ruleBased,
    });
    const result = await analyzer.analyze(context);
    assert.deepEqual(result, expected, '回退结果必须与规则式完全一致');
});
test('LLM 分析器：解析合法 JSON（含 create 与 reinforce），非法 id 被丢弃、数值被 clamp', async () => {
    const existing = makePattern({ id: 'pat-1', content: '该项目反复选择简单存储方案。', kind: 'recurring_decision' });
    const context = contextOf(infraContext().relatedMemories, infraContext().triggerMemory, [existing]);
    const modelOutput = [
        '```json',
        JSON.stringify({
            operations: [
                {
                    type: 'create',
                    kind: 'recurring_decision',
                    content: '项目在架构决策上反复选择低复杂度、本地够用的方案。',
                    confidence: 1.7,
                    importance: 0.6,
                    supportingMemoryIds: ['m1', 'm2', 'mem-not-in-input'],
                },
                { type: 'reinforce', patternId: 'pat-1', supportingMemoryIds: ['m3', 'pat-not-in-input'] },
            ],
        }),
        '```',
    ].join(String.fromCharCode(10));
    const analyzer = new LlmPatternAnalyzer({
        endpoint: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        fetchImpl: async () => jsonResponse(modelOutput),
        fallback: new RuleBasedPatternAnalyzer(),
    });
    const result = await analyzer.analyze(context);
    assert.equal(result.operations.length, 2);
    const created = singleOperation(result.operations.slice(0, 1), 'create');
    assert.deepEqual(created.supportingMemoryIds, ['m1', 'm2'], '不存在的 memory id 必须被丢弃');
    assert.equal(created.confidence, 1, 'confidence 必须 clamp 到 0..1');
    const reinforced = singleOperation(result.operations.slice(1), 'reinforce');
    assert.equal(reinforced.patternId, 'pat-1');
    assert.deepEqual(reinforced.supportingMemoryIds, ['m3']);
});
test('LLM 分析器：非法 JSON 回退规则式，不抛错', async () => {
    const context = infraContext();
    const ruleBased = new RuleBasedPatternAnalyzer();
    const expected = await ruleBased.analyze(context);
    const analyzer = new LlmPatternAnalyzer({
        endpoint: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        fetchImpl: async () => jsonResponse('这不是 JSON，模型跑偏了'),
        fallback: ruleBased,
    });
    const result = await analyzer.analyze(context);
    assert.deepEqual(result, expected);
});
test('选择器：禁用 → 规则式 configured:false；llm 缺配置降级；配置齐全 → llm，且 label 不含 apiKey', () => {
    const disabled = createPatternAnalyzer({ enabled: false, provider: 'rule', minSupport: 3, activationThreshold: 0.7 });
    assert.equal(disabled.kind, 'rule');
    assert.equal(disabled.configured, false);
    assert.equal(disabled.label, 'rule (pattern disabled)');
    const llmMissing = createPatternAnalyzer({ enabled: true, provider: 'llm', minSupport: 3, activationThreshold: 0.7 }, {});
    assert.equal(llmMissing.kind, 'rule');
    assert.equal(llmMissing.configured, false);
    assert.equal(llmMissing.label, 'rule (llm not configured)');
    const llm = createPatternAnalyzer({
        enabled: true,
        provider: 'llm',
        minSupport: 3,
        activationThreshold: 0.7,
        endpoint: 'https://api.example.com/v1',
        apiKey: 'super-secret-key',
        model: 'test-model',
    }, {});
    assert.equal(llm.kind, 'llm');
    assert.equal(llm.configured, true);
    assert.equal(llm.label, 'llm:test-model');
    assert.equal(llm.label.includes('super-secret-key'), false, 'apiKey 绝不能进 label');
    assert.equal(llm.analyzer.name, 'llm');
    const fromEnv = createPatternAnalyzer({ enabled: true, provider: 'llm', minSupport: 3, activationThreshold: 0.7 }, {
        DSH_MEMORY_SEA_PATTERN_ENDPOINT: 'https://env.example.com/v1',
        DSH_MEMORY_SEA_PATTERN_MODEL: 'env-model',
    });
    assert.equal(fromEnv.kind, 'llm');
    assert.equal(fromEnv.label, 'llm:env-model');
});
/** 最小 Response 替身：只实现分析器实际用到的 ok / status / json。 */
function jsonResponse(content) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
    };
}
