/**
 * tools/skill-status.ts —— Stage 5 的**只读** Skill 工具。
 *
 * 两个工具都只读，没有任何写操作：
 *   - memory_skill_status：当前 scope 的技能候选列表 + 成熟度概览；
 *   - memory_skill_inspect：一个候选（或其某个版本/尝试）的完整证据链。
 *
 * 为什么不做 write 工具：Phase 1 明确「不把审核暴露成 Agent 可自行调用的普通写工具」。
 * 候选生成由后台 job 完成；Attempt 记录与审核必须来自受控的 Service 入口。
 */
import { asRecord, flattenPreview, formatTime, requireString, textOutput, } from './tool-definition.js';
const PREVIEW = 160;
const LINE = String.fromCharCode(10);
export function createSkillStatusTool(service) {
    return {
        name: 'memory_skill_status',
        description: '查看当前项目的技能候选（Skill Candidate）与成熟度：只有描述性候选，没有任何可执行能力。返回候选 id、标题、状态、成熟度等级与缺失项。纯只读。',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: '最多返回多少条候选（1–50，默认 10）。' },
                status: {
                    type: 'string',
                    description: '按状态过滤：drafting / ready_for_review / in_review / changes_requested / approved / rejected / superseded。',
                },
            },
            required: [],
            additionalProperties: false,
        },
        timeoutMs: 5_000,
        isConcurrencySafe: () => true,
        execute: (rawArgs) => {
            const args = asRecord(rawArgs);
            const limit = clampLimit(args.limit, 10);
            const status = typeof args.status === 'string' && args.status.trim().length > 0 ? args.status.trim() : undefined;
            const scopeId = service.defaultScope.id;
            if (!service.getConfig().skill.enabled)
                return 'Skill 功能未启用（config.skill.enabled = false）。';
            const candidates = service.listSkillCandidates(scopeId, { ...(status ? { status } : {}), limit });
            if (candidates.length === 0) {
                const stats = service.status({ scopeId }).skills;
                return [
                    '没有技能候选。',
                    `当前统计：候选 ${stats.candidates} / 尝试 ${stats.attempts}（已完成 ${stats.attemptsCompleted}）。`,
                    '候选由后台从 active Pattern 生成，需要至少 3 条支持知识与 2 个独立 Episode。',
                ].join(LINE);
            }
            const lines = [`技能候选 ${candidates.length} 条（只读，不代表可执行流程）：`];
            for (const candidate of candidates) {
                const maturity = service.getSkillMaturity(scopeId, candidate.id);
                lines.push('');
                lines.push(`- ${candidate.id}｜${candidate.title}`);
                lines.push(`  状态：${candidate.status}｜类型：${candidate.kind}｜版本：v${candidate.latestVersionNo}`);
                lines.push(`  成熟度：${describeMaturity(maturity)}`);
                if (maturity.missing.length > 0)
                    lines.push(`  缺失：${maturity.missing.join('、')}`);
                if (candidate.provenanceChanged)
                    lines.push('  来源已变化：需要重新核对后再提交审核');
            }
            return lines.join(LINE);
        },
        output: textOutput(),
    };
}
export function createSkillInspectTool(service) {
    return {
        name: 'memory_skill_inspect',
        description: '查看一个技能候选的完整证据链：版本（步骤 + 证据引用）、尝试记录（结果 / 归因 / 成功标准快照）、审核记录与成熟度评估。纯只读。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '候选 id（skc_…）；也接受版本 id（skv_…）或尝试 id（ska_…）。' },
            },
            required: ['id'],
            additionalProperties: false,
        },
        timeoutMs: 5_000,
        isConcurrencySafe: () => true,
        execute: (rawArgs) => {
            const args = asRecord(rawArgs);
            const id = requireString(args, 'id', 200);
            const scopeId = service.defaultScope.id;
            // 允许传版本 / 尝试 id：先解析到候选，再展示完整链路。
            let candidate = service.getSkillCandidate(scopeId, id);
            if (!candidate) {
                const version = service.getSkillVersion(scopeId, id);
                if (version)
                    candidate = service.getSkillCandidate(scopeId, version.candidateId);
            }
            if (!candidate) {
                const attempt = service.listSkillAttempts(scopeId, { limit: 200 }).find((item) => item.id === id);
                if (attempt)
                    candidate = service.getSkillCandidate(scopeId, attempt.candidateId);
            }
            if (!candidate)
                return `没有找到技能候选：${id}`;
            const maturity = service.getSkillMaturity(scopeId, candidate.id);
            const versions = service.listSkillVersions(scopeId, candidate.id);
            const attempts = service.listSkillAttempts(scopeId, { candidateId: candidate.id, limit: 50 });
            const reviews = service.listSkillReviews(scopeId, candidate.id);
            const lines = [
                `技能候选 ${candidate.id}`,
                `标题：${candidate.title}`,
                `状态：${candidate.status}｜类型：${candidate.kind}｜当前版本：v${candidate.latestVersionNo}`,
            ];
            if (candidate.sourcePatternId)
                lines.push(`来源 Pattern：${candidate.sourcePatternId}`);
            lines.push(`成熟度：${describeMaturity(maturity)}`);
            if (maturity.missing.length > 0)
                lines.push(`缺失项：${maturity.missing.join('、')}`);
            if (maturity.contradictions.length > 0)
                lines.push(`反例：${maturity.contradictions.join('、')}`);
            const effectiveness = maturity.effectiveness;
            if (effectiveness?.reportable && effectiveness.successRate !== undefined) {
                lines.push(`已观察效果：样本 ${effectiveness.sampleSize}，成功率 ${(effectiveness.successRate * 100).toFixed(0)}%`);
            }
            else if (effectiveness?.note) {
                lines.push(`效果：${effectiveness.note}`);
            }
            lines.push('');
            lines.push(`版本 ${versions.length} 个：`);
            for (const version of versions) {
                lines.push(`- v${version.versionNo} ${version.id}｜${version.status}｜${version.changeReason}`);
                if (version.procedure.steps.length > 0) {
                    for (const step of version.procedure.steps.slice(0, 8)) {
                        const refs = step.evidenceRefs.map((ref) => ref.id).join('、');
                        lines.push(`  ${step.stepNo}. ${preview(step.action)}${refs ? `（证据：${refs}）` : ''}`);
                    }
                }
                else {
                    lines.push('  没有步骤（证据不足，不能作为可执行流程）');
                }
                if (version.procedure.successCriteria.length === 0)
                    lines.push('  成功标准：未定义（不能据此判定成功）');
            }
            lines.push('');
            lines.push(`尝试 ${attempts.length} 个：`);
            if (attempts.length === 0)
                lines.push('- 无。没有实际尝试，因此不可能达到 validated。');
            for (const attempt of attempts)
                lines.push(`- ${describeAttempt(attempt)}`);
            lines.push('');
            lines.push(`审核记录 ${reviews.length} 条：`);
            if (reviews.length === 0)
                lines.push('- 无。');
            for (const review of reviews) {
                lines.push(`- ${formatTime(review.createdAt)}｜${review.decision}｜审核人 ${review.reviewer}｜${review.fromStatus} → ${review.toStatus}｜${preview(review.reason)}`);
            }
            lines.push('');
            lines.push('说明：批准只表示「接受描述」，不会触发任何执行；validated 必须来自真实 Attempt + 预先定义的成功标准。');
            return lines.join(LINE);
        },
        output: textOutput(),
    };
}
function describeMaturity(maturity) {
    const labels = {
        insufficient: '证据不足（不能提交审核）',
        structural_only: '仅有结构（缺少真实尝试）',
        observed: '有观察（尝试样本还不足）',
        validated: '已验证（有真实尝试 + 成功标准 + 独立证据）',
    };
    return `${maturity.level}：${labels[maturity.level] ?? maturity.level}｜独立 Episode ${maturity.evidence.independentEpisodes}｜已验证尝试 ${maturity.attempts.verified}`;
}
function describeAttempt(attempt) {
    const ended = attempt.endedAt ? formatTime(attempt.endedAt) : '进行中';
    return `${attempt.id}｜${attempt.status}/${attempt.result}｜归因 ${attempt.attribution}｜开始 ${formatTime(attempt.startedAt)}｜结束 ${ended}｜${preview(attempt.note ?? '')}`;
}
function preview(text) {
    return flattenPreview(String(text ?? ''), PREVIEW);
}
function clampLimit(value, fallback) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num <= 0)
        return fallback;
    return Math.min(50, Math.max(1, Math.trunc(num)));
}
