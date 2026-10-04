/**
 * smoke.test.mjs — 真实 Worker 冒烟测试。
 *
 * 用 Node worker_threads 跑编译后的 worker.js（真线程、真 SharedArrayBuffer、
 * 真 Atomics.wait），驱动协调器推进若干代，与单线程参考实现逐格对比。
 * 另覆盖：真实线程下的"计算途中重置"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Coordinator } from '../public/coordinator.js';
import { randomGrid, referenceStep } from '../public/life-core.js';

const WORKER_URL = new URL('../public/worker.js', import.meta.url);

function makeRealWorld({ rows, cols, workers, seed }) {
  const initial = randomGrid(rows, cols, 0.3, seed);
  const realWorkers = [];
  const spawn = (id, sink, sab) => {
    const w = new Worker(WORKER_URL, { workerData: { type: 'init', sab, workerId: id } });
    w.on('message', (m) => sink.onMessage(id, m));
    w.on('error', (e) => sink.onError(id, String(e)));
    realWorkers.push(w);
    return { post: () => {}, terminate: () => { void w.terminate(); } };
  };
  const coord = new Coordinator({
    rows, cols, numWorkers: workers, initial, spawn,
    genIntervalMs: 1, workerTimeoutMs: 10000,
  });
  const timer = setInterval(() => coord.tick(), 2);
  return { coord, initial, rows, cols, cleanup: () => { clearInterval(timer); coord.dispose(); } };
}

async function waitFor(cond, timeoutMs, what) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function stepN(world, n) {
  for (let i = 0; i < n; i++) {
    const g0 = world.coord.generation;
    world.coord.step();
    await waitFor(() => world.coord.generation > g0, 8000, `第 ${i + 1} 代提交`);
  }
}

test('真实 Worker（3 线程）推进 25 代与单线程参考一致', { timeout: 30000 }, async () => {
  const world = makeRealWorld({ rows: 48, cols: 64, workers: 3, seed: 1234 });
  try {
    const STEPS = 25;
    await stepN(world, STEPS);
    let ref = world.initial;
    for (let i = 0; i < STEPS; i++) ref = referenceStep(ref, world.rows, world.cols);
    const view = world.coord.exportView();
    assert.equal(view.generation, STEPS);
    assert.deepEqual([...view.cells], [...ref]);
  } finally {
    world.cleanup();
  }
});

test('真实 Worker（2 与 4 线程）与参考一致', { timeout: 30000 }, async () => {
  for (const workers of [2, 4]) {
    const world = makeRealWorld({ rows: 33, cols: 47, workers, seed: 77 });
    try {
      const STEPS = 12;
      await stepN(world, STEPS);
      let ref = world.initial;
      for (let i = 0; i < STEPS; i++) ref = referenceStep(ref, world.rows, world.cols);
      assert.deepEqual([...world.coord.exportView().cells], [...ref], `${workers} 线程结果不一致`);
    } finally {
      world.cleanup();
    }
  }
});

test('真实 Worker 计算途中重置：之后演化与参考一致', { timeout: 30000 }, async () => {
  const world = makeRealWorld({ rows: 64, cols: 64, workers: 4, seed: 2024 });
  try {
    // 连续运行中（极可能正有代在计算途中）发起重置
    world.coord.start();
    await waitFor(() => world.coord.generation >= 3, 8000, '先跑出几代');
    const p2 = randomGrid(64, 64, 0.3, 555);
    world.coord.requestReset(p2, 64, 64);
    await waitFor(() => world.coord.state !== 'resetting', 8000, '重置完成');
    world.coord.pause();
    assert.equal(world.coord.generation, 0);
    assert.deepEqual([...world.coord.exportView().cells], [...p2], '重置后网格必须等于新图案');

    // 重置后再推进 10 代，与参考一致
    await stepN(world, 10);
    let ref = p2;
    for (let i = 0; i < 10; i++) ref = referenceStep(ref, 64, 64);
    assert.deepEqual([...world.coord.exportView().cells], [...ref]);
  } finally {
    world.cleanup();
  }
});
