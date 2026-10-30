/**
 * scope-resolver.ts —— 唯一把「Harness 上下文」翻译成 MemoryScope 的地方（spec §3 / §7）。
 *
 * 优先级（从高到低）：
 *   1. session.header.cwd              ← 会话真实工作目录（Stage 2 的主路径）
 *   2. session / project metadata 里的 cwd / rootPath / projectRoot
 *   3. 显式配置的 scope（config.scope.rootPath）
 *   4. host 进程 cwd 兜底
 *
 * Repository 不读 Harness session，只接受 scopeId；解析只发生在这一层与 service。
 */
import { resolve } from 'node:path';
import { GLOBAL_SCOPE_ID, deriveProjectScopeId, normalizeProjectPath } from './path-normalizer.js';
const DEFAULT_MAX_CACHED_SESSIONS = 256;
export class ScopeResolver {
    configuredRootPath;
    hostCwd;
    platform;
    maxCachedSessions;
    sessionScopes = new Map();
    defaultScopeValue;
    constructor(options = {}) {
        this.configuredRootPath = options.configuredRootPath;
        this.hostCwd = options.hostCwd ?? process.cwd();
        this.platform = options.platform ?? process.platform;
        this.maxCachedSessions = options.maxCachedSessions ?? DEFAULT_MAX_CACHED_SESSIONS;
        const fallbackRoot = this.configuredRootPath ?? this.hostCwd;
        this.defaultScopeValue = this.resolveForRoot(fallbackRoot, this.configuredRootPath ? 'config' : 'host-cwd');
    }
    /** 兜底 scope：没有 session 上下文时使用（工具、HTTP、测试）。 */
    get defaultScope() {
        return this.defaultScopeValue;
    }
    /** 从任意根路径解析 scope（规范化 + 派生稳定 id）。 */
    resolveForRoot(rootPath, _reason = 'explicit') {
        const absolute = resolve(rootPath);
        const normalized = normalizeProjectPath(absolute, this.platform);
        return {
            type: 'project',
            id: deriveProjectScopeId(absolute, this.platform),
            rootPath: normalized,
        };
    }
    /** global scope（预留；Stage 2 不做跨项目检索）。 */
    static globalScope() {
        return { type: 'global', id: GLOBAL_SCOPE_ID };
    }
    /**
     * 从 Host session 推导 scope。这是 Stage 2 修复「用宿主进程 cwd」问题的核心。
     * 同一个 session 反复调用走缓存，避免每事件都做一次 resolve/hash。
     */
    resolveForSession(session) {
        const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : undefined;
        if (sessionId) {
            const cached = this.sessionScopes.get(sessionId);
            if (cached)
                return cached;
        }
        const scope = this.resolveFromHints({
            sessionId,
            cwd: this.cwdOf(session),
            metadata: session?.metadata ?? undefined,
        });
        if (sessionId)
            this.rememberSessionScope(sessionId, scope);
        return scope;
    }
    /** 兼容工具调用只有 sessionId 的场景：命中缓存就返回对应 scope，否则兜底。 */
    resolveForSessionId(sessionId) {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
            const cached = this.sessionScopes.get(sessionId);
            if (cached)
                return cached;
        }
        return this.defaultScopeValue;
    }
    /** 手动登记 session → scope（session/event 与 session/created 都可调用）。 */
    rememberSessionScope(sessionId, scope) {
        if (sessionId.length === 0)
            return;
        if (this.sessionScopes.size >= this.maxCachedSessions && !this.sessionScopes.has(sessionId)) {
            const oldest = this.sessionScopes.keys().next().value;
            if (typeof oldest === 'string')
                this.sessionScopes.delete(oldest);
        }
        this.sessionScopes.set(sessionId, scope);
    }
    /** 已知 scope 列表（调试/后台扫描用）。 */
    knownScopes() {
        const seen = new Map();
        seen.set(this.defaultScopeValue.id, this.defaultScopeValue);
        for (const scope of this.sessionScopes.values())
            seen.set(scope.id, scope);
        return [...seen.values()];
    }
    /** 解析任意「scope 提示」——显式 scope 对象优先，其次 rootPath，最后兜底。 */
    resolveScopeInput(input) {
        if (!input)
            return this.defaultScopeValue;
        if (input.type === 'global')
            return ScopeResolver.globalScope();
        if (typeof input.id === 'string' && input.id.length > 0) {
            const scope = input;
            return {
                type: scope.type === 'global' ? 'global' : 'project',
                id: scope.id,
                ...(scope.rootPath ? { rootPath: normalizeProjectPath(scope.rootPath, this.platform) } : {}),
            };
        }
        const rootPath = input.rootPath;
        if (typeof rootPath === 'string' && rootPath.trim().length > 0)
            return this.resolveForRoot(rootPath);
        return this.defaultScopeValue;
    }
    // ---------------------------------------------------------------- 内部
    resolveFromHints(hints) {
        const fromCwd = this.nonEmpty(hints.cwd);
        if (fromCwd)
            return this.resolveForRoot(fromCwd);
        const fromMetadata = this.metadataRootPath(hints.metadata);
        if (fromMetadata)
            return this.resolveForRoot(fromMetadata);
        if (this.configuredRootPath)
            return this.resolveForRoot(this.configuredRootPath);
        return this.defaultScopeValue;
    }
    cwdOf(session) {
        if (!session)
            return undefined;
        const headerCwd = session.header?.cwd;
        if (typeof headerCwd === 'string' && headerCwd.trim().length > 0)
            return headerCwd;
        if (typeof session.cwd === 'string' && session.cwd.trim().length > 0)
            return session.cwd;
        const metadataCwd = session.metadata?.cwd;
        return typeof metadataCwd === 'string' && metadataCwd.trim().length > 0 ? metadataCwd : undefined;
    }
    metadataRootPath(metadata) {
        if (!metadata)
            return undefined;
        for (const key of ['projectRoot', 'rootPath', 'workspace', 'workspaceRoot', 'projectPath']) {
            const value = metadata[key];
            if (typeof value === 'string' && value.trim().length > 0)
                return value;
        }
        return undefined;
    }
    nonEmpty(value) {
        if (typeof value !== 'string')
            return undefined;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
}
