/**
 * job-repository.ts —— memory_jobs 的唯一 SQL 出口（spec §15 / §16 / §17）。
 *
 * 为什么所有 SQL 都集中在这一层：
 *   - 任务状态迁移（pending → running → completed / failed）是后台系统的正确性核心，
 *     集中一处才能保证每个迁移都成组、可审计；
 *   - JobRunner 只负责「调度 + 执行 handler」，不写 SQL，测试时可以直接换掉实现。
 *
 * 时间约定：除了 enqueue 使用注入的 now()，其余迁移方法的时间都由调用方传入 `now`。
 * 这样 runner 的一轮 tick 可以用同一个时间戳串起 reclaim / claim / complete / fail，
 * 边界行为可复现，也不会出现「同一轮里三个 Date.now() 各不相同」的隐蔽问题。
 */
import { randomUUID } from 'node:crypto';
import { JOB_STATUSES, MEMORY_JOB_TYPES } from '../types.js';
import { StorageError, wrapError } from '../errors.js';
/** memory_jobs 在迁移 005_jobs.sql 里定义；schema.ts 不归本任务维护，故此处常量直引。 */
const TABLE = 'memory_jobs';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CLAIM_LIMIT = 8;
/** 失败重试的基准退避（spec §17）：base * 2^(attempts-1)，封顶 5 分钟。 */
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** error 列只用于诊断，超长堆栈字符串截断，避免单行把数据库撑大。 */
const MAX_ERROR_LENGTH = 2_000;
/** 任务层可归属的 owner 类型；新增 owner（memory / pattern）必须同步这里，否则读取行会抛错。 */
const JOB_OWNER_TYPES = [
    'episode',
    'experience',
    'memory',
    'pattern',
    'skill_candidate',
    'skill_attempt',
];
/** 把配置/调用方给的数值收敛成正整数；非法值回退默认值而不是让 SQL 拿到 NaN。 */
function positiveInt(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.floor(value);
}
function toNumber(value) {
    return typeof value === 'number' ? value : Number(value ?? 0);
}
function asJobType(value) {
    if (MEMORY_JOB_TYPES.includes(value))
        return value;
    throw new StorageError(`memory_jobs.type 出现未知值: ${value}`);
}
function asJobStatus(value) {
    if (JOB_STATUSES.includes(value))
        return value;
    throw new StorageError(`memory_jobs.status 出现未知值: ${value}`);
}
function asOwnerType(value) {
    if (JOB_OWNER_TYPES.includes(value))
        return value;
    throw new StorageError(`memory_jobs.owner_type 出现未知值: ${value}`);
}
export class JobRepository {
    db;
    now;
    constructor(deps) {
        this.db = deps.db;
        this.now = deps.now ?? Date.now;
    }
    /**
     * 入队一个后台任务。
     *
     * 幂等语义：UNIQUE(type, owner_type, owner_id) 命中时返回 null 而不是抛错——
     * "同一个 Episode 被重复关闭 / 同一条 Experience 被重复要求 embedding" 是正常流程，
     * 不是错误，调用方只需要知道「没有新建任务」。
     */
    enqueue(input) {
        return this.guard('入队后台任务失败', () => {
            const now = this.now();
            const id = `job_${randomUUID()}`;
            const maxAttempts = positiveInt(input.maxAttempts, DEFAULT_MAX_ATTEMPTS);
            const availableAt = input.availableAt ?? now;
            // 单条 INSERT 本身是原子的；用 OR IGNORE 把幂等交给数据库唯一键，避免先查后写的竞态。
            const result = this.db.run(`INSERT OR IGNORE INTO ${TABLE}
           (id, scope_id, type, owner_type, owner_id, status, attempts, max_attempts,
            available_at, started_at, completed_at, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, ?, ?)`, id, input.scopeId, input.type, input.ownerType, input.ownerId, maxAttempts, availableAt, now, now);
            if (result.changes === 0) {
                // 唯一键冲突：同一条 owner 已经有任务。已完成/永久失败的任务允许重新打开——
                // 摘要是派生数据，换了 summarizer 或补上 embedding provider 之后必须能重跑；
                // pending/running 的任务保持原样（幂等，不会重复排队）。
                const reopened = this.db.run(`UPDATE ${TABLE}
              SET status = 'pending', attempts = 0, available_at = ?, started_at = NULL,
                  completed_at = NULL, error = NULL, max_attempts = ?, updated_at = ?
            WHERE type = ? AND owner_type = ? AND owner_id = ?
              AND status IN ('completed', 'failed')`, availableAt, maxAttempts, now, input.type, input.ownerType, input.ownerId);
                if (reopened.changes === 0)
                    return null;
                const row = this.db.get(`SELECT * FROM ${TABLE} WHERE type = ? AND owner_type = ? AND owner_id = ?`, input.type, input.ownerType, input.ownerId);
                return row ? this.mapJobRow(row) : null;
            }
            return this.get(id);
        });
    }
    get(id) {
        return this.guard('读取后台任务失败', () => {
            const row = this.db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, id);
            return row ? this.mapJobRow(row) : null;
        });
    }
    /**
     * 领取一批到期任务并原子地转成 running。
     *
     * 为什么必须在事务里：SELECT 出来的候选和逐条 UPDATE 之间不能被别的进程插进来，
     * 否则同一个任务会被两个 worker 各执行一次。attempts 在领取时 +1（而不是执行后），
     * 这样进程在 handler 中途崩溃，崩溃本身也会消耗一次尝试次数，不会无限重试。
     */
    claim(now, options = {}) {
        return this.guard('领取后台任务失败', () => this.db.transaction(() => {
            const limit = positiveInt(options.limit, DEFAULT_CLAIM_LIMIT);
            let where = "status = 'pending' AND available_at <= ?";
            const params = [now];
            if (options.scopeId !== undefined) {
                where += ' AND scope_id = ?';
                params.push(options.scopeId);
            }
            params.push(limit);
            const rows = this.db.all(`SELECT * FROM ${TABLE} WHERE ${where} ORDER BY available_at ASC, created_at ASC, id ASC LIMIT ?`, ...params);
            const claimed = [];
            for (const row of rows) {
                this.db.run(`UPDATE ${TABLE}
                SET status = 'running', started_at = ?, attempts = attempts + 1, updated_at = ?
              WHERE id = ? AND status = 'pending'`, now, now, row.id);
                // 重新读而不是在内存里改 row：attempts 的 +1 发生在数据库里，读回来才是最新值。
                const fresh = this.get(row.id);
                if (fresh)
                    claimed.push(fresh);
            }
            return claimed;
        }));
    }
    complete(id, now) {
        this.guard('标记任务完成失败', () => {
            // 单条 UPDATE 已原子，仍显式开事务，保证「状态迁移一律在事务内」这条规则没有例外。
            this.db.transaction(() => {
                this.db.run(`UPDATE ${TABLE}
              SET status = 'completed', completed_at = ?, error = NULL, updated_at = ?
            WHERE id = ?`, now, now, id);
            });
        });
    }
    /**
     * 记录一次失败：尝试次数未耗尽则回到 pending 并按指数退避延后，否则落成 failed。
     *
     * backoff = retryDelayMs * 2^(attempts-1)，attempts 用「本次已领取的次数」。
     * 退避封顶 5 分钟，避免 max_attempts 较大时把任务推到几小时后。
     */
    fail(id, error, now, options = {}) {
        this.guard('标记任务失败失败', () => {
            const job = this.get(id);
            // 任务被外部清理掉时静默返回：fail 是善后动作，不该让 runner 再炸一次。
            if (!job)
                return;
            const message = error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) : error;
            const base = positiveInt(options.retryDelayMs, DEFAULT_RETRY_BASE_MS);
            this.db.transaction(() => {
                if (job.attempts >= job.maxAttempts) {
                    this.db.run(`UPDATE ${TABLE}
                SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
              WHERE id = ?`, message, now, now, id);
                    return;
                }
                const exponent = Math.max(0, job.attempts - 1);
                const delay = Math.min(MAX_RETRY_DELAY_MS, base * 2 ** exponent);
                this.db.run(`UPDATE ${TABLE}
              SET status = 'pending', error = ?, started_at = NULL, available_at = ?, updated_at = ?
            WHERE id = ?`, message, now + delay, now, id);
            });
        });
    }
    /**
     * 回收僵死任务：进程崩溃 / handler 卡死会让任务永远停在 running。
     *
     * 这类任务 attempts 已经计过一次（领取时 +1），所以这里不再加 attempts：
     *   - 还有剩余次数 → 回 pending 立即可领（下一轮 tick 会重新跑）；
     *   - 次数已耗尽 → 直接 failed，否则会无限回收。
     * 返回本次被打回的任务数（pending 与 failed 都算「回收」，调用方只关心有没有发生）。
     */
    reclaimStale(now, staleMs) {
        return this.guard('回收僵死任务失败', () => this.db.transaction(() => {
            const cutoff = now - Math.max(0, staleMs);
            const rows = this.db.all(`SELECT * FROM ${TABLE} WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`, cutoff);
            let reclaimed = 0;
            for (const row of rows) {
                const job = this.mapJobRow(row);
                if (job.attempts >= job.maxAttempts) {
                    this.db.run(`UPDATE ${TABLE}
                  SET status = 'failed', error = COALESCE(error, ?), completed_at = ?, updated_at = ?
                WHERE id = ?`, 'stale: 任务执行超时且尝试次数已耗尽', now, now, job.id);
                }
                else {
                    // 超时不是 handler 报错，不覆盖 error 字段，避免掩盖上一次真正的失败原因。
                    this.db.run(`UPDATE ${TABLE}
                  SET status = 'pending', started_at = NULL, available_at = ?, updated_at = ?
                WHERE id = ?`, now, now, job.id);
                }
                reclaimed += 1;
            }
            return reclaimed;
        }));
    }
    /** 队列健康度。scopeId 给定时只统计该作用域（多项目隔离下不能把别的项目算进来）。 */
    stats(scopeId) {
        return this.guard('统计后台任务失败', () => {
            const rows = scopeId === undefined
                ? this.db.all(`SELECT status, COUNT(*) AS count FROM ${TABLE} GROUP BY status`)
                : this.db.all(`SELECT status, COUNT(*) AS count FROM ${TABLE} WHERE scope_id = ? GROUP BY status`, scopeId);
            const stats = { pending: 0, running: 0, failed: 0, completed: 0 };
            for (const row of rows) {
                const count = toNumber(row.count);
                switch (row.status) {
                    case 'pending':
                        stats.pending = count;
                        break;
                    case 'running':
                        stats.running = count;
                        break;
                    case 'failed':
                        stats.failed = count;
                        break;
                    case 'completed':
                        stats.completed = count;
                        break;
                    default:
                        break;
                }
            }
            return stats;
        });
    }
    /** 按 owner 查任务（inspect / 调试用）。owner 上同类任务最多一条（UNIQUE 约束）。 */
    listByOwner(ownerType, ownerId) {
        return this.guard('按 owner 查询任务失败', () => this.db
            .all(`SELECT * FROM ${TABLE} WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC, id ASC`, ownerType, ownerId)
            .map((row) => this.mapJobRow(row)));
    }
    // ---------------------------------------------------------------- 内部
    /** 行 → 领域对象是唯一的映射入口，避免各处手写列名导致漏映射。 */
    mapJobRow(row) {
        return {
            id: String(row.id),
            scopeId: String(row.scope_id),
            type: asJobType(row.type),
            ownerType: asOwnerType(row.owner_type),
            ownerId: String(row.owner_id),
            status: asJobStatus(row.status),
            attempts: toNumber(row.attempts),
            maxAttempts: toNumber(row.max_attempts),
            availableAt: toNumber(row.available_at),
            // 可选时间列：NULL 收敛成 undefined，避免把 null 当作 0 暴露给上层。
            startedAt: row.started_at === null ? undefined : toNumber(row.started_at),
            completedAt: row.completed_at === null ? undefined : toNumber(row.completed_at),
            error: row.error === null ? undefined : String(row.error),
            createdAt: toNumber(row.created_at),
            updatedAt: toNumber(row.updated_at),
        };
    }
    /** 统一错误边界：底层 SQLite 异常包成 StorageError，带上下文，保留原始 cause。 */
    guard(context, fn) {
        try {
            return fn();
        }
        catch (error) {
            throw wrapError(StorageError, error, context);
        }
    }
}
