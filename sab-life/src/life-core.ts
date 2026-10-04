/**
 * life-core.ts — 生命游戏规则与工具，纯函数，无任何线程/环境依赖。
 *
 * 规则（题目规定）：每格读取旧代八邻域，
 *   邻居恰 3 → 存活（出生或保持）；
 *   邻居恰 2 → 保留原值；
 *   其余     → 清零。
 * 边界环绕（环面）。
 */

/** 计算第 r 行：从 src 读旧代，向 dst 写新代。 */
export function computeRow(
  src: Uint8Array,
  dst: Uint8Array,
  rows: number,
  cols: number,
  r: number,
): void {
  const up = ((r - 1 + rows) % rows) * cols;
  const cur = r * cols;
  const dn = ((r + 1) % rows) * cols;
  for (let c = 0; c < cols; c++) {
    const cl = (c - 1 + cols) % cols;
    const cr = (c + 1) % cols;
    const n =
      src[up + cl] + src[up + c] + src[up + cr] +
      src[cur + cl] + src[cur + cr] +
      src[dn + cl] + src[dn + c] + src[dn + cr];
    const alive = src[cur + c];
    dst[cur + c] = n === 3 || (n === 2 && alive === 1) ? 1 : 0;
  }
}

/** 计算行区间 [r0, r1) —— 每个 Worker 负责的一段。 */
export function computeSlice(
  src: Uint8Array,
  dst: Uint8Array,
  rows: number,
  cols: number,
  r0: number,
  r1: number,
): void {
  for (let r = r0; r < r1; r++) computeRow(src, dst, rows, cols, r);
}

/** 单线程参考实现：整网推进一步，返回新数组。测试用它做基准对比。 */
export function referenceStep(grid: Uint8Array, rows: number, cols: number): Uint8Array {
  const next = new Uint8Array(rows * cols);
  computeSlice(grid, next, rows, cols, 0, rows);
  return next;
}

/** mulberry32 —— 确定性伪随机，便于测试复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成随机初始网格（0/1）。 */
export function randomGrid(
  rows: number,
  cols: number,
  density: number,
  seed: number,
): Uint8Array {
  const rng = mulberry32(seed);
  const g = new Uint8Array(rows * cols);
  for (let i = 0; i < g.length; i++) g[i] = rng() < density ? 1 : 0;
  return g;
}

export function gridsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
