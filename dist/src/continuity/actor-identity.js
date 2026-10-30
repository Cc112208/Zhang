/**
 * actor-identity.ts —— 参与者身份的规范化（Stage 4.6）。
 *
 * 为什么放在 continuity 而不是 Memory Sea 内核：
 *   - Memory Sea 只认通用概念：`actorId`（跨 Session 稳定）、`threadKey`、`sessionId`、`scopeId`。
 *   - 平台相关字段（platform / platformUserId / viewerId）只作为**规范化输入**，不是记忆语义的一部分。
 *   - 昵称永远不参与身份判定：它可以改、可以重名，只用来看。
 *
 * 置信度分级（决定能不能建立连续性关系）：
 *   high    —— 有显式 actorId，或平台内的稳定用户 ID（platform + platformUserId）。
 *   medium  —— 只有历史 viewerId（stage 4 之前 Live Agent 写入的不透明稳定 ID）。
 *   none    —— 只有昵称或什么都没有：不生成身份，不允许连接 Episode。
 */
import { createHash } from 'node:crypto';
function textField(metadata, key) {
    const value = metadata[key];
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/** 平台内稳定 ID → 不透明 actorId；不含昵称、不含频道（频道属于 scope，不属于身份）。 */
export function actorIdFromPlatformUser(platform, platformUserId) {
    const digest = createHash('sha256').update(`${platform}:${platformUserId}`, 'utf8').digest('hex');
    return `act_${digest.slice(0, 16)}`;
}
/**
 * 从 Experience/Episode 的 metadata 里解出参与者身份。
 *
 * 顺序即优先级：显式 actorId > 平台稳定 ID > 历史 viewerId。
 * 昵称、发言内容、兴趣都不参与——避免「同名即同人」和「相似即同人」的猜测合并。
 */
export function normalizeActorIdentity(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return null;
    const explicit = textField(metadata, 'actorId');
    if (explicit !== undefined) {
        return { actorId: explicit, source: 'actorId', confidence: 'high' };
    }
    const platformUserId = textField(metadata, 'platformUserId');
    const platform = textField(metadata, 'platform') ?? textField(metadata, 'platformId') ?? 'unknown';
    if (platformUserId !== undefined) {
        return {
            actorId: actorIdFromPlatformUser(platform, platformUserId),
            source: 'platformUserId',
            confidence: 'high',
        };
    }
    // 兼容 Stage 4 之前只写 viewerId 的历史数据：它是 platform + uid 的哈希，仍然稳定，
    // 但无法证明它一定等于某个 actorId 命名空间，因此只给 medium（可用于 same_thread，
    // 不足以单独支撑 continues）。
    const viewerId = textField(metadata, 'viewerId');
    if (viewerId !== undefined) {
        return { actorId: viewerId, source: 'viewerId', confidence: 'medium' };
    }
    return null;
}
/** 取 metadata 里所有可用的强身份 actorId（high）。连续性判定用这个，不用昵称。 */
export function strongActorIds(metadata) {
    const identity = normalizeActorIdentity(metadata);
    return identity && identity.confidence === 'high' ? [identity.actorId] : [];
}
/** 取任意可用身份（high/medium），用于「同一线程」级别的弱关联。 */
export function knownActorIds(metadata) {
    const identity = normalizeActorIdentity(metadata);
    return identity ? [identity.actorId] : [];
}
/**
 * 计算幂等的 metadata 补丁：只在能**证明**身份时补 `actorId`，
 * 绝不从昵称推断，也绝不覆盖已有 actorId。
 */
export function actorMetadataPatch(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return null;
    if (textField(metadata, 'actorId') !== undefined)
        return null;
    const identity = normalizeActorIdentity(metadata);
    if (!identity)
        return null;
    return { actorId: identity.actorId, actorSource: identity.source };
}
/** 对一批 metadata 做身份审计（回填 dry-run 与状态报告共用）。 */
export function auditActorMetadata(entries) {
    const counts = {
        total: entries.length,
        normalizedActorId: 0,
        stablePlatformId: 0,
        legacyViewerId: 0,
        nicknameOnly: 0,
        missing: 0,
    };
    for (const metadata of entries) {
        const bucket = classifyActorMetadata(metadata);
        counts[bucket] += 1;
    }
    return counts;
}
export function classifyActorMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object')
        return 'missing';
    if (textField(metadata, 'actorId') !== undefined)
        return 'normalizedActorId';
    if (textField(metadata, 'platformUserId') !== undefined)
        return 'stablePlatformId';
    if (textField(metadata, 'viewerId') !== undefined)
        return 'legacyViewerId';
    if (textField(metadata, 'nicknameAtTime') !== undefined || textField(metadata, 'nickname') !== undefined) {
        return 'nicknameOnly';
    }
    return 'missing';
}
