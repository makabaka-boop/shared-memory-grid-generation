/**
 * core.test.mjs — 规则与切片正确性：与单线程参考实现对比。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSlice,
  referenceStep,
  randomGrid,
  gridsEqual,
} from '../public/life-core.js';

function gridOf(rows, cols, live) {
  const g = new Uint8Array(rows * cols);
  for (const [r, c] of live) g[((r % rows) + rows) % rows * cols + ((c % cols) + cols) % cols] = 1;
  return g;
}

test('静物方块保持不变', () => {
  const g = gridOf(16, 16, [[2, 2], [2, 3], [3, 2], [3, 3]]);
  assert.ok(gridsEqual(referenceStep(g, 16, 16), g));
});

test('闪烁器周期为 2', () => {
  const g = gridOf(16, 16, [[4, 3], [4, 4], [4, 5]]);
  const t1 = referenceStep(g, 16, 16);
  // 一代后变为横向
  assert.equal(t1[3 * 16 + 4], 1);
  assert.equal(t1[4 * 16 + 4], 1);
  assert.equal(t1[5 * 16 + 4], 1);
  assert.equal(t1[4 * 16 + 3], 0);
  assert.ok(gridsEqual(referenceStep(t1, 16, 16), g));
});

test('孤立细胞死亡，恰三邻居出生（含环绕）', () => {
  // 跨越边界的三个邻居使角上死细胞出生
  const g = gridOf(16, 16, [[0, 1], [1, 0], [15, 0]]);
  const next = referenceStep(g, 16, 16);
  assert.equal(next[0], 1, '角上细胞应因环绕邻居恰三而出生');
  const single = gridOf(16, 16, [[8, 8]]);
  assert.ok(gridsEqual(referenceStep(single, 16, 16), new Uint8Array(256)), '孤立细胞应死亡');
});

test('滑翔者在 16x16 环面上 64 代后回到原位', () => {
  const g = gridOf(16, 16, [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
  let cur = g;
  for (let i = 0; i < 64; i++) cur = referenceStep(cur, 16, 16);
  assert.ok(gridsEqual(cur, g));
});

test('任意切片划分的结果与单线程参考一致（2/3/4 段，多尺寸）', () => {
  for (const [rows, cols] of [[16, 16], [17, 33], [64, 64], [128, 128], [16, 128]]) {
    for (const parts of [2, 3, 4]) {
      const g = randomGrid(rows, cols, 0.35, rows * 1000 + cols * 10 + parts);
      const sliced = new Uint8Array(rows * cols);
      for (let i = 0; i < parts; i++) {
        const r0 = Math.floor((i * rows) / parts);
        const r1 = Math.floor(((i + 1) * rows) / parts);
        computeSlice(g, sliced, rows, cols, r0, r1);
      }
      const ref = referenceStep(g, rows, cols);
      assert.ok(gridsEqual(sliced, ref), `${rows}x${cols} 分 ${parts} 段不一致`);
    }
  }
});

test('连续多代与参考一致', () => {
  const rows = 48, cols = 80;
  let ref = randomGrid(rows, cols, 0.3, 7);
  let cur = ref;
  for (let i = 0; i < 30; i++) {
    const sliced = new Uint8Array(rows * cols);
    for (let w = 0; w < 3; w++) {
      computeSlice(cur, sliced, rows, cols,
        Math.floor(w * rows / 3), Math.floor((w + 1) * rows / 3));
    }
    ref = referenceStep(ref, rows, cols);
    assert.ok(gridsEqual(sliced, ref), `第 ${i + 1} 代不一致`);
    cur = sliced;
  }
});
