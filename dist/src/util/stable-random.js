/**
 * 稳定伪随机 —— 只依赖字符串与哈希，保证「同一 ID 每次刷新得到同一坐标」。
 * 不引入 UMAP / 随机数种子表；V0.2 的布局必须是确定性的。
 */
/** FNV-1a 32bit：与 legacy mind-sea.js 的 fnv1a 同一算法，便于对齐旧 ID。 */
export function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
/** 把任意 seed 字符串映射到 [0,1) 的稳定伪随机数。salt 用于同一对象的不同用途（位置/大小/相位）。 */
export function unitRand(seed, salt = '') {
    // 两次独立哈希拼成 53bit，避免单一 32bit 在空间上出现明显规律。
    const a = fnv1a(`${salt}\u0000${seed}`);
    const b = fnv1a(`${seed}\u0000${salt}`);
    const v = ((a >>> 0) * 0x100000000 + (b >>> 0)) / 0x10000000000000000;
    return v;
}
/** 生成短、稳定、可读的十六进制缩略 id（用于 projectId 之类）。 */
export function shortHash(text) {
    return fnv1a(text).toString(36);
}
