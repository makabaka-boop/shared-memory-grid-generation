/**
 * coordinator.ts — 主线程侧的调度器（环境无关，浏览器与 Node 测试共用）。
 *
 * 职责：
 *  - 按节拍派发任务（TASK_GEN + SEQ 唤醒），主线程自身从不计算任何格子；
 *  - 通过 DONE_COUNT 观察完成屏障，全部到达后才翻转 READ_INDEX、递增 GENERATION；
 *  - 暂停 / 单步 / 重置（epoch + ack 协议，确保旧线程不会写进重置后的网格）；
 *  - Worker 异常（主动上报或硬崩溃）与超时 → 进入 error 态，绝不提交残缺代；
 *  - 忽略一切迟到的旧代消息（以共享内存计数器为唯一权威）。
 *
 * 主线程从不调用 Atomics.wait —— 一切等待都通过 tick() 轮询完成，
 * 浏览器里由 requestAnimationFrame 驱动，界面不会冻结。
 */

import {
  CTRL,
  TOTAL_BYTES,
  controlView,
  gridView,
  WorkerOutbound,
} from './protocol.js';

export interface WorkerHandle {
  post(msg: unknown): void;
  terminate(): void;
}

/** 由环境（浏览器/Node 测试）注入的事件汇，Worker 消息与硬错误都从这里进。 */
export interface CoordinatorSink {
  onMessage(workerId: number, msg: WorkerOutbound): void;
  onError(workerId: number, message: string): void;
}

export interface CoordinatorOptions {
  rows: number;
  cols: number;
  numWorkers: number;
  /** 初始图案，长度 rows*cols，取值 0/1 */
  initial: Uint8Array;
  /** 创建 Worker 的工厂；sab 一并给出，便于用 workerData 或 init 消息传递 */
  spawn(workerId: number, sink: CoordinatorSink, sab: SharedArrayBuffer): WorkerHandle;
  now?: () => number;
  /** 连续运行时的节拍（毫秒/代） */
  genIntervalMs?: number;
  /** 等待 Worker 完成/确认的超时 */
  workerTimeoutMs?: number;
}

export type CoordinatorState = 'running' | 'paused' | 'resetting' | 'error' | 'disposed';

export class Coordinator {
  readonly sab: SharedArrayBuffer;
  private readonly ctrl: Int32Array;
  private readonly spawnFn: CoordinatorOptions['spawn'];
  private readonly now: () => number;
  private genIntervalMs: number;
  private readonly workerTimeoutMs: number;

  private workers: (WorkerHandle | null)[];
  private workerDead: boolean[];
  private workerReadyFlag: boolean[];
  /** 仅供 UI 展示：各 Worker 最近完成的有效任务号 */
  private workerLastDone: number[];

  private numWorkers: number;
  private rows: number;
  private cols: number;

  private epoch = 1;
  private taskGen = 0; // 单调递增，跨重置不复位
  private inflight = false;
  private inflightSince = -1;
  private lastDispatchAt = -1;

  private wantRun = false;
  private wantRunAfterReset = false;
  private pendingSteps = 0;

  private resetting = false;
  private resetSince = -1;
  private pendingPattern: Uint8Array | null = null;
  private pendingRows = 0;
  private pendingCols = 0;

  private errorMsg: string | null = null;
  private disposed = false;

  constructor(opts: CoordinatorOptions) {
    this.numWorkers = opts.numWorkers;
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.spawnFn = opts.spawn;
    this.now = opts.now ?? (() => Date.now());
    this.genIntervalMs = opts.genIntervalMs ?? 100;
    this.workerTimeoutMs = opts.workerTimeoutMs ?? 5000;

    this.sab = new SharedArrayBuffer(TOTAL_BYTES);
    this.ctrl = controlView(this.sab);
    Atomics.store(this.ctrl, CTRL.SEQ, 0);
    Atomics.store(this.ctrl, CTRL.EPOCH, this.epoch);
    Atomics.store(this.ctrl, CTRL.TASK_GEN, 0);
    Atomics.store(this.ctrl, CTRL.DONE_COUNT, 0);
    Atomics.store(this.ctrl, CTRL.READ_INDEX, 0);
    Atomics.store(this.ctrl, CTRL.GENERATION, 0);
    Atomics.store(this.ctrl, CTRL.ROWS, this.rows);
    Atomics.store(this.ctrl, CTRL.COLS, this.cols);
    Atomics.store(this.ctrl, CTRL.NUM_WORKERS, this.numWorkers);
    Atomics.store(this.ctrl, CTRL.ERROR, 0);
    Atomics.store(this.ctrl, CTRL.EPOCH_TASK_BASE, 0);

    const g0 = gridView(this.sab, 0);
    g0.fill(0);
    g0.set(opts.initial);
    gridView(this.sab, 1).fill(0);

    this.workers = new Array(this.numWorkers).fill(null);
    this.workerDead = new Array(this.numWorkers).fill(false);
    this.workerReadyFlag = new Array(this.numWorkers).fill(false);
    this.workerLastDone = new Array(this.numWorkers).fill(0);
    for (let i = 0; i < this.numWorkers; i++) this.spawnWorker(i);
  }

  // ---------------------------------------------------------------- 状态查询

  get state(): CoordinatorState {
    if (this.disposed) return 'disposed';
    if (this.errorMsg !== null) return 'error';
    if (this.resetting) return 'resetting';
    return this.wantRun ? 'running' : 'paused';
  }
  get generation(): number {
    return Atomics.load(this.ctrl, CTRL.GENERATION);
  }
  get currentEpoch(): number {
    return this.epoch;
  }
  get error(): string | null {
    return this.errorMsg;
  }
  get size(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }
  workerStatus(): { ready: boolean; dead: boolean; lastDone: number }[] {
    return this.workers.map((_, i) => ({
      ready: this.workerReadyFlag[i],
      dead: this.workerDead[i],
      lastDone: this.workerLastDone[i],
    }));
  }

  /** 已提交代的只读视图（调用方不得修改）。 */
  committedGrid(): Uint8Array {
    return gridView(this.sab, Atomics.load(this.ctrl, CTRL.READ_INDEX));
  }

  /** 导出：一份完整已提交代的拷贝。 */
  exportView(): { generation: number; rows: number; cols: number; cells: Uint8Array } {
    const generation = this.generation;
    const cells = this.committedGrid().slice(0, this.rows * this.cols);
    return { generation, rows: this.rows, cols: this.cols, cells };
  }

  // ---------------------------------------------------------------- 主循环

  /** 由 rAF / 定时器 / 测试手动驱动。绝不阻塞。 */
  tick(): void {
    if (this.disposed) return;
    const now = this.now();

    // Worker 通过共享内存上报的异常（消息可能迟到，槽位不会）
    const errSlot = Atomics.load(this.ctrl, CTRL.ERROR);
    if (this.errorMsg === null && errSlot !== 0) {
      this.enterError(`worker ${errSlot - 1} 报告异常`);
      return;
    }
    if (this.errorMsg !== null) return;

    if (this.resetting) {
      this.maybeFinishReset(now);
      return; // 重置期间不提交、不派发
    }

    if (this.inflight) {
      if (Atomics.load(this.ctrl, CTRL.DONE_COUNT) >= this.numWorkers) {
        this.commit();
      } else if (now - this.inflightSince > this.workerTimeoutMs) {
        this.enterError(`等待 worker 完成超时（代 ${this.generation + 1}）`);
        return;
      }
    }

    if (!this.inflight) {
      if (this.pendingSteps > 0) {
        this.pendingSteps--;
        this.dispatch(now);
      } else if (
        this.wantRun &&
        (this.lastDispatchAt < 0 || now - this.lastDispatchAt >= this.genIntervalMs)
      ) {
        this.dispatch(now);
      }
    }
  }

  /** 完成屏障已满足：交换缓冲并递增代号。 */
  private commit(): void {
    const ri = Atomics.load(this.ctrl, CTRL.READ_INDEX);
    Atomics.store(this.ctrl, CTRL.READ_INDEX, ri ^ 1);
    Atomics.add(this.ctrl, CTRL.GENERATION, 1);
    Atomics.store(this.ctrl, CTRL.DONE_COUNT, 0);
    this.inflight = false;
  }

  private dispatch(now: number): void {
    this.taskGen++;
    Atomics.store(this.ctrl, CTRL.DONE_COUNT, 0);
    Atomics.store(this.ctrl, CTRL.TASK_GEN, this.taskGen);
    this.inflight = true;
    this.inflightSince = now;
    this.lastDispatchAt = now;
    // 释放语义：上面的写在 SEQ 增加之前，Worker 看到新 SEQ 即可读到一致状态
    Atomics.add(this.ctrl, CTRL.SEQ, 1);
    Atomics.notify(this.ctrl, CTRL.SEQ);
  }

  // ---------------------------------------------------------------- 控制

  start(): void {
    if (this.errorMsg !== null || this.disposed) return;
    this.wantRun = true;
  }
  pause(): void {
    this.wantRun = false;
  }
  setGenInterval(ms: number): void {
    this.genIntervalMs = Math.max(1, ms);
  }
  step(): void {
    if (this.errorMsg !== null || this.disposed || this.resetting) return;
    this.pendingSteps++;
  }

  /**
   * 重置（可在计算途中调用）：
   * bump epoch → 所有存活 Worker 发现后放弃旧工作并 ack →
   * 全部 ack 后主线程才写入新图案。旧线程的任何迟到写入都发生在
   * 其 ack 之前，因而必然被重置覆盖，不可能污染新网格。
   */
  requestReset(pattern: Uint8Array, rows: number, cols: number): void {
    if (this.disposed) return;
    this.wantRunAfterReset = this.wantRun;
    this.wantRun = false;
    this.pendingSteps = 0;
    this.inflight = false;
    this.errorMsg = null;
    this.pendingPattern = pattern;
    this.pendingRows = rows;
    this.pendingCols = cols;

    this.epoch++;
    Atomics.store(this.ctrl, CTRL.ERROR, 0);
    // 先记下旧 epoch 的最后一个任务号，再 bump EPOCH：
    // Worker 看到新 EPOCH 时必然能看到这个下界，从而不会执行旧任务
    Atomics.store(this.ctrl, CTRL.EPOCH_TASK_BASE, this.taskGen);
    Atomics.store(this.ctrl, CTRL.EPOCH, this.epoch);

    // 死掉的 Worker 无法 ack，直接重生（新实例启动即确认当前 epoch）
    for (let i = 0; i < this.numWorkers; i++) {
      if (this.workerDead[i] || this.workers[i] === null) this.spawnWorker(i);
    }

    this.resetting = true;
    this.resetSince = this.now();
    Atomics.add(this.ctrl, CTRL.SEQ, 1);
    Atomics.notify(this.ctrl, CTRL.SEQ);
  }

  private maybeFinishReset(now: number): void {
    for (let i = 0; i < this.numWorkers; i++) {
      if (Atomics.load(this.ctrl, CTRL.ACK_BASE + i) !== this.epoch) {
        if (now - this.resetSince > this.workerTimeoutMs) {
          this.enterError(`重置超时：worker ${i} 未确认新纪元`);
        }
        return;
      }
    }
    // 全部 ack：此刻不存在任何会写旧数据的线程，可以安全初始化网格
    Atomics.store(this.ctrl, CTRL.DONE_COUNT, 0);
    Atomics.store(this.ctrl, CTRL.GENERATION, 0);
    Atomics.store(this.ctrl, CTRL.READ_INDEX, 0);
    this.rows = this.pendingRows;
    this.cols = this.pendingCols;
    Atomics.store(this.ctrl, CTRL.ROWS, this.rows);
    Atomics.store(this.ctrl, CTRL.COLS, this.cols);
    const g0 = gridView(this.sab, 0);
    g0.fill(0);
    g0.set(this.pendingPattern!);
    gridView(this.sab, 1).fill(0);
    this.pendingPattern = null;

    this.resetting = false;
    this.inflight = false;
    this.lastDispatchAt = -1;
    this.wantRun = this.wantRunAfterReset;
  }

  private enterError(message: string): void {
    this.errorMsg = message;
    this.wantRun = false;
    this.inflight = false;
    this.pendingSteps = 0;
  }

  // ---------------------------------------------------------------- Worker 事件

  private readonly sink: CoordinatorSink = {
    onMessage: (workerId, msg) => this.onWorkerMessage(workerId, msg),
    onError: (workerId, message) => this.onWorkerError(workerId, message),
  };

  private spawnWorker(id: number): void {
    this.workers[id]?.terminate();
    this.workerDead[id] = false;
    this.workerReadyFlag[id] = false;
    this.workerLastDone[id] = 0;
    this.workers[id] = this.spawnFn(id, this.sink, this.sab);
  }

  onWorkerMessage(workerId: number, msg: WorkerOutbound): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        this.workerReadyFlag[workerId] = true;
        break;
      case 'done':
        // 只接受当前 epoch、当前在飞任务的完成通知；迟到的旧代消息直接忽略。
        // （即使忽略也无妨——DONE_COUNT 才是权威，这里仅用于 UI 展示。）
        if (msg.epoch === this.epoch && this.inflight && msg.gen === this.taskGen) {
          this.workerLastDone[workerId] = msg.gen;
        }
        break;
      case 'error':
        // 旧 epoch 的错误属于已被丢弃的计算，忽略
        if (msg.epoch === this.epoch && this.errorMsg === null) {
          this.enterError(`worker ${workerId}: ${msg.message}`);
        }
        break;
    }
  }

  /** Worker 硬崩溃（uncaught / 退出）。 */
  onWorkerError(workerId: number, message: string): void {
    if (this.disposed) return;
    this.workerDead[workerId] = true;
    this.workerReadyFlag[workerId] = false;
    try {
      this.workers[workerId]?.terminate();
    } catch {
      /* 忽略 */
    }
    if (this.resetting) {
      // 重置途中崩了一个：立刻补一个，让它 ack 当前 epoch
      this.spawnWorker(workerId);
    } else if (this.errorMsg === null) {
      this.enterError(`worker ${workerId} 崩溃: ${message}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.workers) {
      try {
        w?.terminate();
      } catch {
        /* 忽略 */
      }
    }
    this.workers.fill(null);
  }
}
