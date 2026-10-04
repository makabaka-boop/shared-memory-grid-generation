/**
 * coordinator.test.mjs — 可控交错测试。
 *
 * 用 createWorkerCtx/workerStep（与真实 Worker 完全相同的协议代码）
 * 在单线程里手动驱动"假 Worker"，从而精确重演各种时序：
 * 最后一个线程尚未完成、计算途中重置、异常中止、旧代消息迟到等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../public/coordinator.js';
import { createWorkerCtx, workerStep } from '../public/worker-core.js';
import { randomGrid, referenceStep } from '../public/life-core.js';
import { CTRL, GRID_BYTES, HEADER_BYTES } from '../public/protocol.js';

/** 假 Worker：协议逻辑与真实 Worker 一致，但消息进入出站队列，由测试决定何时投递 */
class FakeWorker {
  constructor(id, sink, sab) {
    this.id = id;
    this.sink = sink;
    this.terminated = false;
    this.outbox = [];
    this.ctx = createWorkerCtx(sab, id, (m) => this.outbox.push(m));
  }
  /** 推进一步协议（可限制行数预算，模拟"算到一半"） */
  step(budget) {
    return workerStep(this.ctx, budget);
  }
  /** 对应真实 Worker 的内层循环：持续推进直到没有工作 */
  run() {
    let r;
    do { r = this.step(); } while (r !== 'idle');
    return r;
  }
  /** 把出站消息投递给协调器（模拟消息到达） */
  flush() {
    for (const m of this.outbox) this.sink.onMessage(this.id, m);
    this.outbox = [];
  }
}

function makeWorld({ rows = 32, cols = 32, workers = 3, seed = 42, interval = 100, timeout = 1000 } = {}) {
  const initial = randomGrid(rows, cols, 0.3, seed);
  let now = 0;
  const fakes = [];
  const spawn = (id, sink, sab) => {
    const f = new FakeWorker(id, sink, sab);
    fakes[id] = f;
    return { post: () => {}, terminate: () => { f.terminated = true; } };
  };
  const coord = new Coordinator({
    rows, cols, numWorkers: workers, initial, spawn,
    now: () => now, genIntervalMs: interval, workerTimeoutMs: timeout,
  });
  return {
    coord, fakes, initial, rows, cols,
    tick: () => coord.tick(),
    setNow: (v) => { now = v; },
    ctrl: () => new Int32Array(coord.sab, 0, CTRL.SIZE),
    grid: (i) => new Uint8Array(coord.sab, HEADER_BYTES + i * GRID_BYTES, GRID_BYTES),
    allStep: () => fakes.forEach((f) => f.step()),
    allRun: () => fakes.forEach((f) => f.run()),
  };
}

function viewOf(w) {
  return [...w.coord.exportView().cells];
}

test('最后一个线程未完成时不提交；全部到达屏障后才交换缓冲并递增代号', () => {
  const w = makeWorld();
  w.coord.step();
  w.tick(); // 派发任务 1
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 1);
  assert.equal(w.coord.generation, 0);

  // 两个 Worker 完成，最后一个尚未完成
  w.fakes[0].run(); w.fakes[1].run();
  w.fakes[0].flush(); w.fakes[1].flush();
  w.tick();
  assert.equal(w.coord.generation, 0, '最后一个线程未完成，不得提交');
  assert.equal(Atomics.load(w.ctrl(), CTRL.READ_INDEX), 0, '不得交换缓冲');

  // 最后一个完成 → 提交
  w.fakes[2].run(); w.fakes[2].flush();
  w.tick();
  assert.equal(w.coord.generation, 1);
  assert.equal(Atomics.load(w.ctrl(), CTRL.READ_INDEX), 1);
  assert.deepEqual(viewOf(w), [...referenceStep(w.initial, w.rows, w.cols)]);
});

test('迟到的旧代消息被忽略，不会造成重复提交或干扰在飞代', () => {
  const w = makeWorld();
  // 完成第 1 代
  w.coord.step(); w.tick();
  w.allRun();
  w.tick();
  assert.equal(w.coord.generation, 1);

  // 旧任务号的 done 迟到送达（此刻没有在飞任务）
  w.coord.onWorkerMessage(0, { type: 'done', workerId: 0, epoch: 1, gen: 1 });
  w.tick();
  assert.equal(w.coord.generation, 1, '旧消息不得触发提交');

  // 第 2 代在飞期间混入旧消息
  w.coord.step(); w.tick();
  w.coord.onWorkerMessage(1, { type: 'done', workerId: 1, epoch: 1, gen: 1 });
  w.coord.onWorkerMessage(2, { type: 'done', workerId: 2, epoch: 0, gen: 1 });
  w.allRun();
  w.tick();
  assert.equal(w.coord.generation, 2, '在飞代应正常提交，不受旧消息干扰');

  // done 消息在提交之后才送达（消息晚于 DONE_COUNT 生效）
  w.coord.step(); w.tick();
  w.allRun(); // 完成，但先不投递消息
  w.tick();
  assert.equal(w.coord.generation, 3, '提交由共享计数器驱动，不依赖消息');
  w.fakes.forEach((f) => f.flush()); // 迟到的 done 消息现在才到
  w.tick();
  assert.equal(w.coord.generation, 3, '迟到消息不得造成重复提交');
});

test('计算途中重置：旧线程的迟到写入与迟到 DONE 不污染新网格', () => {
  const w = makeWorld({ seed: 1 });
  w.coord.step(); w.tick(); // 任务 1 在飞
  const oldEpoch = w.coord.currentEpoch;

  // Worker 0 算到一半（先同步纪元，再只写 1 行）；Worker 1 已算完
  assert.equal(w.fakes[0].step(), 'epoch');
  assert.equal(w.fakes[0].step(1), 'progress');
  w.fakes[1].run();

  // 计算途中发起重置
  const p2 = randomGrid(32, 32, 0.3, 999);
  w.coord.requestReset(p2, 32, 32);
  assert.equal(w.coord.state, 'resetting');

  // Worker 0 继续推进 → 发现 epoch 已变，放弃旧进度并确认新纪元
  assert.equal(w.fakes[0].step(1), 'epoch');

  // 模拟旧线程在确认前的迟到写入：往目标缓冲写了 5 行垃圾
  const readIdx = Atomics.load(w.ctrl(), CTRL.READ_INDEX);
  w.grid(readIdx ^ 1).fill(1, 0, 32 * 5);
  // 模拟旧线程在确认前的迟到 DONE+1
  Atomics.add(w.ctrl(), CTRL.DONE_COUNT, 1);

  // 其余 Worker 确认新纪元
  w.fakes[1].step(); w.fakes[2].step();
  w.tick(); // 全部 ack → 完成重置
  assert.equal(w.coord.state, 'paused');
  assert.equal(w.coord.generation, 0);
  assert.deepEqual(viewOf(w), [...p2], '垃圾行必须被重置覆盖');
  assert.equal(Atomics.load(w.ctrl(), CTRL.DONE_COUNT), 0, '迟到 DONE 必须被清零');

  // 重置后、新派发之前：Worker 不得执行旧 epoch 遗留的任务
  const doneBefore = Atomics.load(w.ctrl(), CTRL.DONE_COUNT);
  w.allStep();
  assert.equal(Atomics.load(w.ctrl(), CTRL.DONE_COUNT), doneBefore, '旧任务不得被再执行');

  // 旧 epoch 的迟到 done 消息此刻送达 → 忽略
  w.coord.onWorkerMessage(1, { type: 'done', workerId: 1, epoch: oldEpoch, gen: 1 });
  w.tick();
  assert.equal(w.coord.generation, 0);
  assert.equal(w.coord.state, 'paused');

  // 新纪元继续演化，与参考一致
  w.coord.step(); w.tick();
  w.allStep();
  w.tick();
  assert.equal(w.coord.generation, 1);
  assert.deepEqual(viewOf(w), [...referenceStep(p2, 32, 32)]);
});

test('Worker 计算途中异常中止：不提交残缺代，重置后恢复', () => {
  const w = makeWorld();
  w.coord.step(); w.tick(); // 任务 1 在飞
  w.fakes[0].run(); // 一个 Worker 正常完成

  // Worker 1 异常：共享槽位 + 消息双通道上报
  Atomics.store(w.ctrl(), CTRL.ERROR, 2);
  w.coord.onWorkerMessage(1, {
    type: 'error', workerId: 1, epoch: w.coord.currentEpoch, gen: 1, message: 'boom',
  });
  assert.equal(w.coord.state, 'error');
  w.tick();
  assert.equal(w.coord.generation, 0, '残缺代不得提交');
  assert.equal(Atomics.load(w.ctrl(), CTRL.READ_INDEX), 0);

  // 错误状态下不接受 start/step
  w.coord.step(); w.coord.start(); w.tick();
  assert.equal(w.coord.generation, 0);
  assert.equal(w.coord.state, 'error');

  // 重置恢复（ERROR 槽被清除，Worker 重新 ack）
  const p = randomGrid(32, 32, 0.3, 5);
  w.coord.requestReset(p, 32, 32);
  w.allStep(); // ack 新纪元
  w.tick();
  assert.equal(w.coord.state, 'paused');
  assert.deepEqual(viewOf(w), [...p]);

  // 恢复后正常演化
  w.coord.step(); w.tick();
  w.allStep(); w.tick();
  assert.equal(w.coord.generation, 1);
  assert.deepEqual(viewOf(w), [...referenceStep(p, 32, 32)]);
});

test('Worker 硬崩溃：进入错误态；重置时重生该 Worker', () => {
  const w = makeWorld();
  w.coord.step(); w.tick();
  const oldFake = w.fakes[1];
  w.coord.onWorkerError(1, 'uncaught exception');
  assert.equal(w.coord.state, 'error');
  assert.equal(oldFake.terminated, true);
  assert.equal(w.coord.generation, 0);

  const p = randomGrid(32, 32, 0.3, 6);
  w.coord.requestReset(p, 32, 32);
  assert.notEqual(w.fakes[1], oldFake, '崩溃的 Worker 应被重生');
  assert.equal(w.fakes[1].terminated, false);
  w.allStep(); // 全部 ack（含重生者）
  w.tick();
  assert.equal(w.coord.state, 'paused');
  assert.deepEqual(viewOf(w), [...p]);

  // 重生后正常参与计算
  w.coord.step(); w.tick();
  w.allStep(); w.tick();
  assert.equal(w.coord.generation, 1);
  assert.deepEqual(viewOf(w), [...referenceStep(p, 32, 32)]);
});

test('等待完成超时 → 错误态，不提交', () => {
  const w = makeWorld({ timeout: 500 });
  w.coord.step();
  w.setNow(0); w.tick(); // t=0 派发
  w.fakes[0].run(); // 只有一个完成
  w.setNow(600); w.tick();
  assert.equal(w.coord.state, 'error');
  assert.equal(w.coord.generation, 0);
});

test('重置确认超时 → 错误态', () => {
  const w = makeWorld({ timeout: 500 });
  w.setNow(0);
  w.coord.requestReset(randomGrid(32, 32, 0.3, 8), 32, 32);
  w.fakes[0].step(); w.fakes[2].step(); // Worker 1 迟迟不 ack
  w.setNow(100); w.tick();
  assert.equal(w.coord.state, 'resetting');
  w.setNow(600); w.tick();
  assert.equal(w.coord.state, 'error');
});

test('暂停 / 单步 / 运行节拍', () => {
  const w = makeWorld({ interval: 100 });
  w.coord.start();
  w.setNow(0); w.tick();
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 1, '运行中应立即派发');

  w.allRun();
  w.setNow(50); w.tick(); // 提交，但节拍未到
  assert.equal(w.coord.generation, 1);
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 1, '节拍未到不得派发');

  w.setNow(120); w.tick(); // 节拍到 → 派发任务 2
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 2);

  w.coord.pause();
  w.allRun();
  w.setNow(200); w.tick(); // 在飞代照常提交，之后不再派发
  assert.equal(w.coord.generation, 2);
  w.setNow(1000); w.tick();
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 2, '暂停后不得派发');

  // 单步两次（排队），每步恰好推进一代
  w.coord.step(); w.coord.step();
  w.tick();
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 3);
  w.allRun(); w.tick(); // 提交 3 并立即派发 4
  assert.equal(w.coord.generation, 3);
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 4);
  w.allRun(); w.tick();
  assert.equal(w.coord.generation, 4);
  w.tick();
  assert.equal(Atomics.load(w.ctrl(), CTRL.TASK_GEN), 4, '单步用尽后不得派发');
});

test('重置可改变网格尺寸，后续演化与参考一致', () => {
  const w = makeWorld();
  const p = randomGrid(48, 16, 0.3, 11);
  w.coord.requestReset(p, 48, 16);
  w.allStep(); w.tick();
  assert.deepEqual(w.coord.size, { rows: 48, cols: 16 });
  assert.deepEqual(viewOf(w), [...p]);

  w.coord.step(); w.tick();
  w.allStep(); w.tick();
  assert.deepEqual(viewOf(w), [...referenceStep(p, 48, 16)]);
});

test('重置进行中再次重置：以最新图案与纪元为准', () => {
  const w = makeWorld();
  const p1 = randomGrid(32, 32, 0.3, 21);
  const p2 = randomGrid(32, 32, 0.3, 22);
  w.coord.requestReset(p1, 32, 32);
  w.coord.requestReset(p2, 32, 32); // 再次重置，epoch 再 +1
  w.allStep(); // Worker 直接 ack 到最新 epoch
  w.tick();
  assert.equal(w.coord.state, 'paused');
  assert.deepEqual(viewOf(w), [...p2]);
});

test('导出视图是拷贝，外部修改不影响共享网格', () => {
  const w = makeWorld();
  const v1 = w.coord.exportView();
  v1.cells.fill(1);
  const v2 = w.coord.exportView();
  assert.notDeepEqual([...v2.cells], [...v1.cells]);
  assert.equal(v2.generation, 0);
});
