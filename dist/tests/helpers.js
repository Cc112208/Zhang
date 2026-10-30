/**
 * tests/helpers.ts —— 测试用的临时数据库与可控时钟。
 *
 * 不 mock 数据库：所有测试都跑真实的 SQLite + FTS5（:memory: 无法跨进程复用，这里用临时目录）。
 * 时间也不 mock Date.now 全局，而是把 `now` 注入 Service —— 生产代码因此必须全部走注入时钟。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySeaService } from '../src/service.js';
export function createClock(start = Date.UTC(2026, 0, 1, 9, 0, 0)) {
    let current = start;
    return {
        get now() {
            return current;
        },
        advance(ms) {
            current += ms;
        },
        set(ms) {
            current = ms;
        },
    };
}
export const silentLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
};
export function createTemporaryDirectory(prefix = 'memory-sea-test-') {
    return mkdtempSync(join(tmpdir(), prefix));
}
export function buildService(dbPath, clock, config, logger) {
    return new MemorySeaService({
        config: { enabled: true, databasePath: dbPath, ...(config ?? {}) },
        now: () => clock.now,
        logger: logger ?? silentLogger,
    });
}
export function createTestService(options = {}) {
    const clock = options.clock ?? createClock();
    const directory = createTemporaryDirectory();
    const dbPath = options.dbPath ?? join(directory, 'memory-sea.db');
    const service = buildService(dbPath, clock, options.config, options.logger);
    return {
        service,
        clock,
        dbPath,
        directory,
        cleanup() {
            service.closeSync();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
/** 打开同一个数据库文件的第二个 Service（用于验证重启后的启动清理）。 */
export function reopenService(dbPath, clock, config) {
    return buildService(dbPath, clock, config);
}
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
