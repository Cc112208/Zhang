/**
 * operator-auth.ts —— Stage 5 Phase 2B：本地操作者认证（不是宿主认证的替代品）。
 *
 * 设计取舍（spec §四）：
 *   - 宿主没有向插件暴露「已登录用户」这类可信身份，所以不能凭空信任请求体里的
 *     reviewerId，也不能把静态字符串伪装成认证。
 *   - 采用单机信任模型下真实存在的凭证：一个 0600 权限的随机令牌文件，由操作者
 *     本人在本机读取后放在 Authorization: Bearer 里。伪造它需要读写该用户的
 *     home 目录，这比「请求体里写我是谁」强得多，但它仍然不是多用户认证。
 *   - 失败关闭：没有令牌文件 / 令牌不匹配 / 非本机来源 / 功能关闭 → 一律拒绝写入。
 *   - 令牌只存哈希用于比较，日志里只出现路径与操作者 id（不含令牌本身）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export function defaultOperatorTokenPath() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
        ? process.env.DSH_HOME.trim()
        : join(homedir(), '.dsh');
    return join(home, '3d-memory-sea', 'operator-token');
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
export class OperatorAuth {
    configEnabled;
    tokenPath;
    logger;
    requireLoopback;
    tokenHash = null;
    operatorId = null;
    ready = false;
    constructor(options = {}) {
        this.tokenPath = options.tokenPath ?? defaultOperatorTokenPath();
        this.configEnabled = options.enabled !== false;
        this.logger = options.logger;
        this.requireLoopback = options.requireLoopback !== false;
    }
    /**
     * 首次启动时生成令牌文件（0600）。已存在则读取，不覆盖 —— 覆盖会让旧令牌
     * 立刻失效，破坏「操作者刚记下来」的可用性。
     */
    ensure() {
        if (this.ready || !this.configEnabled)
            return;
        try {
            mkdirSync(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
            if (!existsSync(this.tokenPath)) {
                const token = randomBytes(32).toString('hex');
                writeFileSync(this.tokenPath, `${token}\n`, { mode: 0o600 });
                try {
                    chmodSync(this.tokenPath, 0o600);
                }
                catch {
                    // Windows 上 chmod 语义有限，忽略失败。
                }
                this.logger?.info?.(`[memory-sea] 已生成操作者令牌：${this.tokenPath}（仅本机可读，请勿提交到仓库）`);
            }
            const raw = readFileSync(this.tokenPath, 'utf8').trim();
            if (raw.length < 16) {
                this.logger?.warn?.(`[memory-sea] 操作者令牌文件内容过短，已拒绝启用写接口：${this.tokenPath}`);
                return;
            }
            const hashHex = createHash('sha256').update(raw).digest('hex');
            this.tokenHash = createHash('sha256').update(raw).digest();
            this.operatorId = `op_${hashHex.slice(0, 8)}`;
            this.ready = true;
        }
        catch (error) {
            this.logger?.warn?.(`[memory-sea] 读取操作者令牌失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    get enabled() {
        return this.ready;
    }
    get tokenFile() {
        return this.tokenPath;
    }
    /** 校验一个 HTTP 请求；失败时返回明确错误（fail closed）。 */
    authenticate(request) {
        this.ensure();
        if (!this.ready || !this.tokenHash || !this.operatorId) {
            return {
                ok: false,
                status: 503,
                code: 'operator_disabled',
                message: '操作者审核入口未启用（缺少 operator-token），写接口保持关闭',
            };
        }
        if (this.requireLoopback && !isLoopbackRequest(request)) {
            return { ok: false, status: 403, code: 'operator_not_local', message: '审核入口只接受本机回环请求' };
        }
        const presented = bearerToken(request);
        if (!presented) {
            return { ok: false, status: 401, code: 'operator_unauthorized', message: '缺少 Authorization: Bearer <operator token>' };
        }
        const presentedHash = createHash('sha256').update(presented).digest();
        if (presentedHash.length !== this.tokenHash.length || !timingSafeEqual(presentedHash, this.tokenHash)) {
            return { ok: false, status: 401, code: 'operator_unauthorized', message: '操作者令牌无效' };
        }
        return { ok: true, operatorId: this.operatorId, authMethod: 'local_token' };
    }
    /** 审核人标识：带认证方式前缀，写进 append-only 的 ReviewRecord。 */
    reviewerLabel(identity) {
        return `local_token:${identity.operatorId}`;
    }
}
function bearerToken(request) {
    const headers = request?.headers;
    if (!headers)
        return null;
    const raw = headers.authorization ?? headers.Authorization;
    if (typeof raw !== 'string')
        return null;
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    return match && match[1] ? match[1].trim() : null;
}
function isLoopbackRequest(request) {
    const socket = request?.socket;
    const address = socket?.remoteAddress;
    // 没有 socket 信息 = 进程内调用（测试 / 宿主内部），按本机处理。
    if (!address)
        return true;
    const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
    return LOOPBACK.has(normalized) || normalized.startsWith('127.');
}
