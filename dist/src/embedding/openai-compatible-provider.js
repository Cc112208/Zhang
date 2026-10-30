/**
 * openai-compatible-provider.ts —— OpenAI 兼容的 embedding provider（spec §24）。
 *
 * 为什么只写「OpenAI 兼容」而不是某一家 SDK：
 *   - 运行时零依赖：只用全局 fetch + node: 内置；
 *   - OpenAI / 多数本地推理服务（Ollama、LM Studio、vLLM、硅基流动等）都实现了
 *     `POST {baseUrl}/embeddings`，一份实现覆盖绝大部分自托管场景。
 *
 * 安全约定：
 *   - apiKey 只存在 # 私有字段里，不进日志、不做可枚举属性、不随返回值序列化；
 *   - 不构造时就发网络请求（isAvailable() 只表示「已配置」，真正探测发生在第一次 embed）。
 *
 * 维度约定（重要）：
 *   - 构造时不知道真实维度时 dimensions=0（「未知」）；
 *   - 第一次成功响应把实际长度固化成 dimensions；
 *   - 之后任何一次响应长度与已确定/配置的维度不一致都抛错 —— 混用不同维度的向量
 *     会让 cosine 静默失效，宁可让 job 失败重试。
 */
import { errorMessage } from '../errors.js';
import { redactSensitiveText } from '../util/redaction.js';
/** 默认超时：embedding 是后台可重试任务，15s 足够覆盖冷启动。 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;
/** 允许的最短/最长超时，避免配置写错把后台任务拖死或瞬间超时。 */
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 120_000;
/**
 * OpenAI 兼容 embedding provider。
 *
 * 只实现 EmbeddingProvider 契约要求的 embed / embedBatch / isAvailable；
 * 向量数学（cosine）不在这里，集中在 embedding-provider.ts，避免 provider 各自实现一份。
 */
export class OpenAiCompatibleEmbeddingProvider {
    name = 'openai-compatible';
    model;
    #baseUrl;
    #apiKey;
    #fetchImpl;
    #timeoutMs;
    #configuredDimensions;
    /** 实际维度：配置了就是配置值；否则第一次成功调用后固化。0 表示未知。 */
    #dimensions;
    constructor(options) {
        const baseUrl = normalizeBaseUrl(options.baseUrl);
        if (baseUrl.length === 0)
            throw new Error('embedding baseUrl 不能为空');
        const apiKey = options.apiKey.trim();
        if (apiKey.length === 0)
            throw new Error('embedding apiKey 不能为空');
        const model = options.model.trim();
        if (model.length === 0)
            throw new Error('embedding model 不能为空');
        this.model = model;
        this.#baseUrl = baseUrl;
        this.#apiKey = apiKey;
        // 显式绑定 globalThis：Electron/浏览器里把 window.fetch 存成变量再调用会丢 this，
        // 直接报 "Illegal invocation"；测试注入的假 fetch 绑定 this 无副作用。
        this.#fetchImpl = (options.fetchImpl ?? globalThis.fetch).bind(globalThis);
        this.#timeoutMs = clampTimeout(options.timeoutMs);
        this.#configuredDimensions = positiveInt(options.dimensions);
        this.#dimensions = this.#configuredDimensions ?? 0;
    }
    /** 0 = 维度未知（尚未成功调用）；不是「无向量」，Noop 才是无向量。 */
    get dimensions() {
        return this.#dimensions;
    }
    /** 已配置（baseUrl/apiKey/model 齐全）即视为可用；真正的网络错误留给 embed 抛给调用方。 */
    async isAvailable() {
        return true;
    }
    async embed(text) {
        const vectors = await this.embedBatch([text]);
        const first = vectors[0];
        if (!first)
            throw new Error('embedding 服务未返回向量');
        return first;
    }
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        // Keep the local evidence intact, but never send obvious credentials to a remote provider.
        const safeTexts = texts.map((text) => redactSensitiveText(text));
        const payload = await this.#request(safeTexts);
        return this.#parse(payload, texts.length);
    }
    // ---------------------------------------------------------------- 内部
    /**
     * 请求 `${baseUrl}/embeddings`。
     * 请求体严格是 `{ model, input }`：OpenAI 兼容服务的公共子集，
     * 不发送 settings.dimensions —— 它只用于校验，避免为某家厂商的扩展参数破坏兼容性。
     */
    async #request(texts) {
        const url = `${this.#baseUrl}/embeddings`;
        let response;
        try {
            response = await this.#fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.#apiKey}`,
                },
                body: JSON.stringify({ model: this.model, input: texts }),
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        }
        catch (error) {
            // 网络错误 / 超时没有 HTTP 状态码，但必须带上原因，绝不吞成空结果。
            throw new Error(`embedding 请求失败（网络错误或超时，无 HTTP 状态码）：${errorMessage(error)}`, {
                cause: error,
            });
        }
        if (!response.ok) {
            const detail = await readErrorBody(response);
            throw new Error(`embedding 请求失败：HTTP ${response.status}${detail.length > 0 ? ` ${detail}` : ''}`);
        }
        try {
            return (await response.json());
        }
        catch (error) {
            throw new Error(`embedding 响应不是合法 JSON：${errorMessage(error)}`, { cause: error });
        }
    }
    /** 解析并校验 `data[i].embedding`；任何一条不合法都整批失败（部分成功会让维度/条数错位）。 */
    #parse(payload, expectedCount) {
        if (!isRecord(payload) || !Array.isArray(payload.data)) {
            throw new Error('embedding 响应缺少 data 数组');
        }
        const data = payload.data;
        if (data.length !== expectedCount) {
            throw new Error(`embedding 响应条数不匹配：期望 ${expectedCount}，实际 ${data.length}`);
        }
        const vectors = data.map((item, index) => {
            if (!isRecord(item) || !Array.isArray(item.embedding)) {
                throw new Error(`embedding 响应第 ${index} 条缺少 embedding 数组`);
            }
            const values = item.embedding;
            const numbers = [];
            for (const value of values) {
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    throw new Error(`embedding 响应第 ${index} 条包含非数字分量`);
                }
                numbers.push(value);
            }
            if (numbers.length === 0)
                throw new Error(`embedding 响应第 ${index} 条是空向量`);
            return Float32Array.from(numbers);
        });
        this.#applyDimensions(vectors);
        return vectors;
    }
    /** 固化/校验维度：配置值与实际值不一致、同一批里维度不一致都直接抛错。 */
    #applyDimensions(vectors) {
        const first = vectors[0];
        if (!first)
            throw new Error('embedding 服务未返回向量');
        const actual = first.length;
        for (const vector of vectors) {
            if (vector.length !== actual)
                throw new Error('同一批 embedding 的维度不一致，拒绝写入');
        }
        const configured = this.#configuredDimensions;
        if (configured !== undefined && configured !== actual) {
            throw new Error(`embedding 维度与配置不一致：配置 ${configured}，实际 ${actual}`);
        }
        if (this.#dimensions !== 0 && this.#dimensions !== actual) {
            throw new Error(`embedding 维度与已确定维度不一致：已确定 ${this.#dimensions}，实际 ${actual}`);
        }
        this.#dimensions = actual;
    }
}
// ------------------------------------------------------------------ 纯工具
/** 去掉空白与结尾斜杠；不猜任何默认 vendor 地址（显式配置才发请求）。 */
function normalizeBaseUrl(value) {
    return value.trim().replace(/\/+$/u, '');
}
function clampTimeout(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_EMBEDDING_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}
function positiveInt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    const int = Math.floor(value);
    return int > 0 ? int : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 只取错误响应体前 200 字，避免把整页 HTML 塞进日志，也避免回显超长内容。 */
async function readErrorBody(response) {
    try {
        const text = await response.text();
        const single = text.replace(/\s+/gu, ' ').trim();
        return single.length > 200 ? `${single.slice(0, 200)}…` : single;
    }
    catch {
        return '';
    }
}
