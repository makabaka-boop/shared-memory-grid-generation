/**
 * worker-core.ts — Worker 单步协议逻辑。
 *
 * 真实 Worker（worker.ts）在 Atomics.wait 唤醒后调用一次 workerStep；
 * 单元测试则用"可控交错"方式手动多次调用 workerStep（可用 rowBudget
 * 限制每次处理的行数），从而精确重演"算到一半被重置""最后一个线程
 * 尚未完成"等时序。两侧跑的是同一份代码。
 *
 * 关键不变量：
 *  - 只读 grids[READ_INDEX]，只写另一个缓冲中自己的行区间；
 *  - 每写一行前检查 EPOCH，发现变化立即放弃（aborted），不记完成；
 *  - 只有完整算完自己全部行，才 DONE_COUNT +1 并发 done 通知；
 *  - EPOCH 变化后先 ack（写 ACK 槽），ack 之后绝不再写旧任务的数据。
 */

import { CTRL, controlView, gridView, WorkerOutbound } from './protocol.js';
import { computeRow } from './life-core.js';

export interface WorkerCtx {
  ctrl: Int32Array;
  grids: [Uint8Array, Uint8Array];
  workerId: number;
  /** 本 Worker 已确认的 epoch；-1 表示尚未确认任何 epoch */
  myEpoch: number;
  /** 本 Worker 已完成的任务号 */
  myLastTask: number;
  /** 进行中的切片进度；epoch 变化或任务被放弃时清空 */
  progress: {
    task: number;
    nextRow: number;
    endRow: number;
    rows: number;
    cols: number;
    srcIndex: number;
  } | null;
  post(msg: WorkerOutbound): void;
}

export type WorkerStepResult =
  | 'epoch'    // 确认了新 epoch
  | 'idle'     // 没有新任务
  | 'progress' // 算了一部分行（仅 rowBudget 受限时出现）
  | 'aborted'  // 计算途中检测到 epoch 变化，已放弃
  | 'error'    // 计算抛异常，已上报
  | 'done';    // 完整算完一个任务

export function createWorkerCtx(
  sab: SharedArrayBuffer,
  workerId: number,
  post: (msg: WorkerOutbound) => void,
): WorkerCtx {
  return {
    ctrl: controlView(sab),
    grids: [gridView(sab, 0), gridView(sab, 1)],
    workerId,
    myEpoch: -1,
    myLastTask: 0,
    progress: null,
    post,
  };
}

export function workerStep(ctx: WorkerCtx, rowBudget = Infinity): WorkerStepResult {
  const { ctrl } = ctx;
  const epoch = Atomics.load(ctrl, CTRL.EPOCH);

  // 1) epoch 变化：放弃一切手头工作，确认新 epoch。
  //    ack 之后本 Worker 不会再写任何旧 epoch 的数据（程序顺序保证）。
  if (epoch !== ctx.myEpoch) {
    ctx.myEpoch = epoch;
    ctx.myLastTask = 0;
    ctx.progress = null;
    Atomics.store(ctrl, CTRL.ACK_BASE + ctx.workerId, epoch);
    return 'epoch';
  }

  const task = Atomics.load(ctrl, CTRL.TASK_GEN);

  // 防御：任务号在进度中途变了（正常不会发生，因为任务号单调），丢弃残段。
  if (ctx.progress && ctx.progress.task !== task) ctx.progress = null;

  // 旧 epoch 遗留下来的任务不得执行——否则其迟到的 DONE+1 会与
  // 重置后的下一次派发竞态（EPOCH_TASK_BASE 在 bump EPOCH 前已由主线程写好）。
  const taskBase = Atomics.load(ctrl, CTRL.EPOCH_TASK_BASE);
  if (task === 0 || task === ctx.myLastTask || task <= taskBase) return 'idle';

  // 2) 开始或继续自己的行区间。
  if (!ctx.progress) {
    const rows = Atomics.load(ctrl, CTRL.ROWS);
    const cols = Atomics.load(ctrl, CTRL.COLS);
    const nWorkers = Atomics.load(ctrl, CTRL.NUM_WORKERS);
    const r0 = Math.floor((ctx.workerId * rows) / nWorkers);
    const r1 = Math.floor(((ctx.workerId + 1) * rows) / nWorkers);
    ctx.progress = {
      task,
      nextRow: r0,
      endRow: r1,
      rows,
      cols,
      srcIndex: Atomics.load(ctrl, CTRL.READ_INDEX) & 1,
    };
  }
  const p = ctx.progress;
  const src = ctx.grids[p.srcIndex];
  const dst = ctx.grids[p.srcIndex ^ 1];

  let used = 0;
  try {
    while (p.nextRow < p.endRow && used < rowBudget) {
      // 每行写之前检查 epoch：重置可能发生在计算途中。
      if (Atomics.load(ctrl, CTRL.EPOCH) !== epoch) {
        ctx.progress = null;
        return 'aborted';
      }
      computeRow(src, dst, p.rows, p.cols, p.nextRow);
      p.nextRow++;
      used++;
    }
  } catch (err) {
    // 异常中止：上报，不记完成；本任务就此跳过，避免死循环重抛。
    ctx.progress = null;
    ctx.myLastTask = task;
    Atomics.store(ctrl, CTRL.ERROR, ctx.workerId + 1);
    ctx.post({ type: 'error', workerId: ctx.workerId, epoch, gen: task, message: String(err) });
    return 'error';
  }

  if (p.nextRow < p.endRow) return 'progress';

  // 3) 完整算完：到达屏障。
  ctx.progress = null;
  ctx.myLastTask = task;
  Atomics.add(ctrl, CTRL.DONE_COUNT, 1);
  ctx.post({ type: 'done', workerId: ctx.workerId, epoch, gen: task });
  return 'done';
}
