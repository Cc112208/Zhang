/**
 * statistics.ts —— Stage 5 Phase 2A：统计约束（纯函数）。
 *
 * 为什么用 Wilson 区间：
 *   - 成功/失败是二项分布；小样本下正态近似（Wald）在 p 接近 0 或 1 时会给出
 *     越界区间（甚至负下界），而 Wilson 区间由 score 反解得到，天然落在 [0,1]，
 *     小样本覆盖率也更好，不需要额外连续性校正。计算只依赖 successes / trials，
 *     没有外部依赖，便于单测。
 *
 * 独立性口径（spec §三）：
 *   - 同一 Attempt 的多条证据只算 1 次执行；
 *   - 同一 Episode 的多条 Experience 折叠成 1 个样本；
 *   - 同一用户重复报告同一次结果不增加独立样本（同一 Episode/单位被复用 → 不独立）；
 *   - inferred 不进分子分母；unknown / inconclusive / aborted 不进分母。
 */
/** Wilson score 区间（95% 默认）。trials <= 0 返回 null。 */
export function wilsonInterval(successes, trials, z = 1.96) {
    if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0)
        return null;
    const n = Math.max(1, Math.floor(trials));
    const s = Math.min(n, Math.max(0, Math.floor(successes)));
    const p = s / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
    const low = Math.max(0, center - margin);
    const high = Math.min(1, center + margin);
    return { low: round4(low), high: round4(high), center: round4(center), z };
}
/** 结果是否可用于成功率（unknown / inconclusive 不进分母）。 */
const SCORED_RESULTS = new Set(['success', 'partial_success', 'failure']);
/**
 * 计算独立尝试数。
 *
 * @param episodeIdsByAttempt 由调用方解析好的「尝试 → 证据单位 id」映射
 *   （Episode id 优先；无法解析到 Episode 的 Experience/Memory 用自身 id）。
 */
export function countIndependentAttempts(attempts, outcomes, episodeIdsByAttempt) {
    const sorted = [...attempts].sort((left, right) => {
        const l = left.endedAt ?? left.startedAt ?? left.createdAt;
        const r = right.endedAt ?? right.startedAt ?? right.createdAt;
        if (l !== r)
            return l - r;
        return left.id < right.id ? -1 : 1;
    });
    const covered = new Set();
    let verified = 0;
    let direct = 0;
    let reported = 0;
    let independent = 0;
    for (const attempt of sorted) {
        if (attempt.status !== 'completed')
            continue;
        const rows = outcomes.get(attempt.id) ?? [];
        const inferredOnly = attempt.attribution === 'inferred' ||
            (attempt.attribution === 'none' && rows.length > 0 && rows.every((row) => row.attribution === 'inferred'));
        if (inferredOnly)
            continue;
        if (attempt.attribution !== 'direct' && attempt.attribution !== 'user_reported')
            continue;
        if (!attempt.result || !SCORED_RESULTS.has(attempt.result))
            continue;
        verified += 1;
        if (attempt.attribution === 'direct')
            direct += 1;
        else
            reported += 1;
        const units = unitsOfAttempt(attempt, rows, episodeIdsByAttempt);
        let introduced = 0;
        for (const unit of units) {
            if (covered.has(unit))
                continue;
            covered.add(unit);
            introduced += 1;
        }
        // 没有任何可归属证据时，只有「直接观察」才算一次独立执行；
        // 用户报告的裸结果不能自我证明独立。
        if (introduced > 0 || (units.length === 0 && attempt.attribution === 'direct')) {
            independent += 1;
        }
    }
    return {
        verifiedAttempts: verified,
        directVerified: direct,
        userReportedVerified: reported,
        independentVerified: independent,
        episodesCovered: covered.size,
    };
}
function unitsOfAttempt(attempt, rows, episodeIdsByAttempt) {
    const resolved = episodeIdsByAttempt?.get(attempt.id);
    if (resolved && resolved.length > 0)
        return [...new Set(resolved)];
    const units = new Set();
    for (const row of rows) {
        if (row.evidenceType === 'episode')
            units.add(`episode:${row.evidenceId}`);
        else if (row.evidenceType === 'experience')
            units.add(`experience:${row.evidenceId}`);
        else if (row.evidenceType === 'memory')
            units.add(`memory:${row.evidenceId}`);
    }
    return [...units];
}
/**
 * Unknown is not failure：只有预定义标准 + 非零可信分母才输出成功率；
 * 样本不足时仍然给出区间，但必须标记 smallSample，不允许当作结论。
 */
export function summarizeEffectiveness(input) {
    const { successes, sampleSize, independentSampleSize, successCriteriaDefined, minReportableSamples, wilsonZ } = input;
    const smallSample = sampleSize < Math.max(1, minReportableSamples);
    if (!successCriteriaDefined) {
        return {
            reportable: false,
            sampleSize: 0,
            successes: 0,
            smallSample: true,
            independentSampleSize: 0,
            note: '没有预先定义的成功标准，不输出成功率',
        };
    }
    if (sampleSize <= 0) {
        return {
            reportable: false,
            sampleSize: 0,
            successes: 0,
            smallSample: true,
            independentSampleSize,
            note: '没有可判定的已验证尝试，分母为 0',
        };
    }
    const interval = wilsonInterval(successes, sampleSize, wilsonZ);
    return {
        reportable: true,
        sampleSize,
        successes,
        successRate: round4(successes / Math.max(1, sampleSize)),
        ...(interval ? { ci95: { low: interval.low, high: interval.high } } : {}),
        smallSample,
        independentSampleSize,
        note: smallSample
            ? `样本不足（${sampleSize} < ${minReportableSamples}），成功率与区间只能作为参考`
            : '分母只含已验证尝试；unknown/inconclusive/aborted/inferred 均不计入',
    };
}
/** 供成熟度判定复用的统计汇总。 */
export function applyAttemptStats(stats, counts) {
    return {
        ...stats,
        directVerified: counts.directVerified,
        userReportedVerified: counts.userReportedVerified,
        independentVerified: counts.independentVerified,
        episodesCovered: counts.episodesCovered,
    };
}
function round4(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.round(value * 10_000) / 10_000;
}
