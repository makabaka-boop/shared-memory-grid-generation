/**
 * 主线程引擎：
 *  - 发布回合（RUNNING / ABORTING），从不阻塞 UI：等待一律走注入的 sleep（setTimeout 微轮询）。
 *  - 成功提交必须满足：DONE == ACCEPT == nWorkers 且 phase 仍为 RUNNING，随后先清零回合计数、
 *    再交换 cur、增代号、置 IDLE，最后 notify 所有等待者。
 *  - 异常回合：置 ABORTING 唤醒所有人（含挡在闸门后的）→ 等 ACK == nWorkers（全员静止）→
 *    复用同尺寸缓冲补员；cur 始终指向完整已提交代，代号不变。
 *  - 重置：若回合进行中先作废并等静止；同尺寸复用缓冲，换尺寸则先终止旧池再整体重建。
 *  - 任何重置/换池只能在“所有槽位已落终态”之后，杜绝旧线程写进重置后的网格。
 *  - 绘制/导出只读 IDLE 时的 cur，进行中一律返回 null，由界面保留上一帧快照。
 */
import {
  BootMessage,
  GATE,
  MAX_WORKERS,
  MIN_WORKERS,
  OFF,
  PHASE,
  STATE,
  SEEN,
  STATUS,
  createControl,
  createGrid,
  gridView,
  rowRange,
  stateSlot,
} from './protocol';

export interface WorkerHandle {
  readonly id: number;
  terminate(): void;
}

export type WorkerFactory = (
  boot: BootMessage,
  onFatal: (id: number, error: string) => void,
) => WorkerHandle;

export interface EngineOptions {
  rows: number;
  cols: number;
  workerCount: number;
  initial?: Uint8Array;
  gateMode?: number;
  factory?: WorkerFactory;
  /** 非阻塞等待：默认 setTimeout 让出事件循环，绝不冻结界面。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 每次 Atomics.notify 后的回调：真实线程由内核唤醒；确定性测试用它把假 worker 的
   * 唤醒回调排进 FIFO 队列（引擎本身从不依赖它保证正确性）。
   */
  onNotify?: (offset: number) => void;
}

export type StepOutcome =
  | { status: 'committed'; generation: number }
  | { status: 'aborted'; reason: 'fault' | 'reset' };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Engine {
  readonly maxWorkers: number;
  control!: SharedArrayBuffer;
  ctl!: Int32Array;
  gridA!: SharedArrayBuffer;
  gridB!: SharedArrayBuffer;
  viewA!: Uint8Array;
  viewB!: Uint8Array;
  rows = 0;
  cols = 0;
  workerCount = 0;
  generation = 0;

  private workers = new Map<number, WorkerHandle>();
  private factory: WorkerFactory | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onNotify: (offset: number) => void;
  private gateMode: number = GATE.NONE;
  /** reset 已接管当前作废回合时为 true：step() 醒来后不得恢复/发布，只能让出路权。 */
  private abortOwnedByReset = false;
  lastFault: string | null = null;

  constructor(opts: EngineOptions) {
    if (opts.workerCount < MIN_WORKERS || opts.workerCount > MAX_WORKERS) {
      throw new Error(`Worker 数量必须在 ${MIN_WORKERS}～${MAX_WORKERS} 个之间`);
    }
    this.maxWorkers = MAX_WORKERS;
    this.factory = opts.factory;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onNotify = opts.onNotify ?? (() => undefined);
    this.gateMode = opts.gateMode ?? GATE.NONE;
    this.allocate(opts.rows, opts.cols, opts.initial, opts.workerCount, 0);
  }

  /** 通知真实线程，并把“唤醒事件”暴露给测试调度器。 */
  private notify(offset: number): void {
    Atomics.notify(this.ctl, offset);
    this.onNotify(offset);
  }

  // ---------- 初始化 / 补员 ----------

  /**
   * 分配控制块与两块网格，填充初值并拉起 worker。
   * atRound 作为这些 worker 的“上次已见回合”：新补员的 worker 绝不会误加入已结束的旧回合。
   */
  private allocate(
    rows: number,
    cols: number,
    initial: Uint8Array | undefined,
    n: number,
    atRound: number,
  ): void {
    const { buf, view } = createControl(this.maxWorkers);
    this.control = buf;
    this.ctl = view;
    this.gridA = createGrid(rows, cols);
    this.gridB = createGrid(rows, cols);
    this.viewA = gridView(this.gridA, rows, cols);
    this.viewB = gridView(this.gridB, rows, cols);
    this.rows = rows;
    this.cols = cols;
    this.workerCount = n;
    this.generation = 0;

    Atomics.store(this.ctl, OFF.NWORKERS, n);
    Atomics.store(this.ctl, OFF.ROWS, rows);
    Atomics.store(this.ctl, OFF.COLS, cols);
    Atomics.store(this.ctl, OFF.GEN, 0);
    Atomics.store(this.ctl, OFF.CUR, 0);
    Atomics.store(this.ctl, OFF.GATE_MODE, this.gateMode);
    Atomics.store(this.ctl, OFF.FAULT_WID, -1);

    if (initial) {
      if (initial.length !== rows * cols) throw new Error('初值尺寸不符');
      this.viewA.set(initial);
    }

    for (let id = 0; id < n; id++) {
      const slot = stateSlot(id);
      Atomics.store(this.ctl, slot + STATUS, STATE.PARKED);
      Atomics.store(this.ctl, slot + SEEN, atRound);
    }
    for (let id = 0; id < n; id++) this.spawn(id, atRound);
  }

  private spawn(id: number, atRound: number): void {
    if (!this.factory) throw new Error('未提供 Worker 工厂');
    this.workers.get(id)?.terminate();
    const boot: BootMessage = {
      type: 'boot',
      id,
      control: this.control,
      gridA: this.gridA,
      gridB: this.gridB,
      maxWorkers: this.maxWorkers,
      round: atRound,
    };
    const handle = this.factory(boot, (fid, error) => {
      // Worker 自己已置 DEAD/ACK；主线程记录故障并作废回合（若尚未作废）。
      if (Atomics.load(this.ctl, OFF.PHASE) === PHASE.RUNNING) {
        Atomics.store(this.ctl, OFF.FAULT_WID, fid);
        this.lastFault = error;
        this.voidRound();
      }
    });
    this.workers.set(id, handle);
  }

  private killAll(): void {
    for (const w of this.workers.values()) w.terminate();
    this.workers.clear();
  }

  // ---------- 回合发布 ----------

  /**
   * 发布新回合。顺序很关键：先写参数与清零计数（PHASE 仍为 IDLE，parked 的 worker 不会动），
   * 最后才置 RUNNING 并 notify，任何 worker 都不可能读到半初始化回合。
   */
  private publishRunning(nextRound: number, faultAt: number): void {
    const v = this.ctl;
    Atomics.store(v, OFF.GATE_ARRIVED, 0);
    Atomics.store(v, OFF.GATE_PASS, 0);
    Atomics.store(v, OFF.GATE_RELEASED, 0);
    Atomics.store(v, OFF.ACCEPT, 0);
    Atomics.store(v, OFF.DONE, 0);
    Atomics.store(v, OFF.ACK, 0);
    Atomics.store(v, OFF.FAULT_WID, -1);
    Atomics.store(v, OFF.FAULT_AT, faultAt);
    Atomics.store(v, OFF.ROUND, nextRound);
    Atomics.store(v, OFF.PHASE, PHASE.RUNNING);
    this.notify(OFF.PHASE);
    this.notify(OFF.GATE_PASS);
    this.notify(OFF.GATE_RELEASED);
  }

  private voidRound(): void {
    const v = this.ctl;
    Atomics.store(v, OFF.PHASE, PHASE.ABORTING);
    this.notify(OFF.PHASE);
    this.notify(OFF.GATE_PASS);
    this.notify(OFF.GATE_RELEASED);
  }

  /**
   * 等全员落终态（静止屏障），非阻塞。
   * 作废可能发生在部分 worker 尚未加入时，但被唤醒/迟到者看到 ABORTING 都会立即 PARKED+ACK，
   * 因此终值恰为 workerCount：不到 n 绝不动缓冲。
   */
  private async waitQuiescent(): Promise<void> {
    const n = this.workerCount;
    while (Atomics.load(this.ctl, OFF.ACK) < n) {
      await this.sleep(1);
    }
  }

  // ---------- 对外操作 ----------

  /**
   * 推进一步。仅在 IDLE 时可调用；返回前要么缓冲已交换提交，要么回合作废。
   * 轮询期间每 1ms 把控制权交回事件循环，界面不会冻结。
   * faultWid >= 0 时该 worker 在写了半区后异常（测试用故障注入）。
   */
  async step(faultWid: number = -1): Promise<StepOutcome> {
    if (Atomics.load(this.ctl, OFF.PHASE) !== PHASE.IDLE) {
      throw new Error('上一代尚未结束');
    }
    this.lastFault = null;
    this.abortOwnedByReset = false;
    const n = this.workerCount;
    const nextRound = Atomics.load(this.ctl, OFF.ROUND) + 1;

    let faultAt = -1;
    if (faultWid >= 0) {
      const id = ((faultWid % n) + n) % n;
      [faultAt] = rowRange(id, n, this.rows);
    }
    this.publishRunning(nextRound, faultAt);

    while (true) {
      const accept = Atomics.load(this.ctl, OFF.ACCEPT);
      const done = Atomics.load(this.ctl, OFF.DONE);
      const phase = Atomics.load(this.ctl, OFF.PHASE);

      // 兜底：Worker 置 DEAD 与 ACK 是共享内存里的事实，即使 fatal 消息迟到/丢失，
      // 主线程也能凭槽位状态作废回合（浏览器自毁线程与 Node process.exit 都覆盖）。
      if (phase === PHASE.RUNNING) {
        for (let id = 0; id < n; id++) {
          if (Atomics.load(this.ctl, stateSlot(id) + STATUS) === STATE.DEAD) {
            this.voidRound();
            break;
          }
        }
      }

      if (Atomics.load(this.ctl, OFF.PHASE) === PHASE.RUNNING && done === n && accept === n) {
        // 所有行区都已完整落进 other：提交。先清零回合计数，再交换并发布。
        Atomics.store(this.ctl, OFF.ACCEPT, 0);
        Atomics.store(this.ctl, OFF.DONE, 0);
        Atomics.store(this.ctl, OFF.ACK, 0);
        Atomics.store(this.ctl, OFF.CUR, Atomics.load(this.ctl, OFF.CUR) === 0 ? 1 : 0);
        const gen = Atomics.add(this.ctl, OFF.GEN, 1) + 1;
        this.generation = gen;
        Atomics.store(this.ctl, OFF.ROUND, nextRound);
        Atomics.store(this.ctl, OFF.PHASE, PHASE.IDLE);
        this.notify(OFF.PHASE);
        this.notify(OFF.GATE_RELEASED);
        return { status: 'committed', generation: gen };
      }

      if (phase === PHASE.ABORTING) {
        if (this.abortOwnedByReset) {
          // reset() 已接管：绝不动缓冲，非阻塞等它发布新 IDLE（ROUND 变化）后再返回。
          while (Atomics.load(this.ctl, OFF.ROUND) === nextRound) {
            // 期间 reset 已完成会直接把 PHASE 置为 IDLE、ROUND+1；换尺寸重建同理。
            await this.sleep(1);
          }
          return { status: 'aborted', reason: 'reset' };
        }
        await this.waitQuiescent();
        await this.recoverAfterAbort(nextRound);
        return { status: 'aborted', reason: 'fault' };
      }

      await this.sleep(1);
    }
  }

  /**
   * 异常后恢复：全员静止后，用同尺寸缓冲补员，cur 保留的仍是上一完整已提交代。
   * 新 worker 的 lastSeen = 作废回合号，IDLE 不增 round，不会重跑作废回合。
   */
  private async recoverAfterAbort(abortedRound: number): Promise<void> {
    for (let id = 0; id < this.workerCount; id++) {
      const slot = stateSlot(id);
      if (Atomics.load(this.ctl, slot + STATUS) === STATE.DEAD) {
        Atomics.store(this.ctl, slot + STATUS, STATE.PARKED);
        Atomics.store(this.ctl, slot + SEEN, abortedRound);
        this.spawn(id, abortedRound);
      }
    }
    Atomics.store(this.ctl, OFF.ACCEPT, 0);
    Atomics.store(this.ctl, OFF.DONE, 0);
    Atomics.store(this.ctl, OFF.ACK, 0);
    Atomics.store(this.ctl, OFF.FAULT_WID, -1);
    Atomics.store(this.ctl, OFF.FAULT_AT, -1);
    Atomics.store(this.ctl, OFF.PHASE, PHASE.IDLE);
    this.notify(OFF.PHASE);
  }

  /**
   * 重置网格。回合进行中则先作废并等全员停手——静止之前绝不重写或释放任何缓冲，
   * 因而旧线程不可能写进重置后的网格。同尺寸复用缓冲与池；换尺寸则终止旧池后整体重建。
   */
  async reset(rows: number, cols: number, initial?: Uint8Array): Promise<void> {
    const phase = Atomics.load(this.ctl, OFF.PHASE);
    if (phase === PHASE.RUNNING) {
      this.abortOwnedByReset = true;
      this.voidRound();
      await this.waitQuiescent();
    } else if (phase === PHASE.ABORTING) {
      // 故障作废正在途中：接管它（step() 醒来只等新 round 发布），同样先等全员静止。
      this.abortOwnedByReset = true;
      await this.waitQuiescent();
    }

    const round = Atomics.load(this.ctl, OFF.ROUND) + 1;
    const sameSize = rows === this.rows && cols === this.cols && this.countDead() === 0;

    if (sameSize) {
      // 所有线程都已 PARKED 且 lastSeen 为旧回合：重写期间它们只会睡在 phaseWait 上。
      this.viewA.fill(0);
      this.viewB.fill(0);
      if (initial) {
        if (initial.length !== rows * cols) throw new Error('初值尺寸不符');
        this.viewA.set(initial);
      }
      for (let id = 0; id < this.workerCount; id++) {
        const slot = stateSlot(id);
        Atomics.store(this.ctl, slot + STATUS, STATE.PARKED);
        Atomics.store(this.ctl, slot + SEEN, round);
      }
      Atomics.store(this.ctl, OFF.ACCEPT, 0);
      Atomics.store(this.ctl, OFF.DONE, 0);
      Atomics.store(this.ctl, OFF.ACK, 0);
      Atomics.store(this.ctl, OFF.FAULT_WID, -1);
      Atomics.store(this.ctl, OFF.FAULT_AT, -1);
      Atomics.store(this.ctl, OFF.GEN, 0);
      Atomics.store(this.ctl, OFF.CUR, 0);
      this.generation = 0;
      Atomics.store(this.ctl, OFF.ROUND, round);
      Atomics.store(this.ctl, OFF.PHASE, PHASE.IDLE);
      this.notify(OFF.PHASE);
    } else {
      // 换尺寸 / 池中有 DEAD：先终止全部旧线程（它们已静止），再释放旧缓冲、重建。
      this.killAll();
      this.allocate(rows, cols, initial, this.workerCount, round);
      Atomics.store(this.ctl, OFF.ROUND, round);
      Atomics.store(this.ctl, OFF.PHASE, PHASE.IDLE);
    }
    this.abortOwnedByReset = false;
  }

  private countDead(): number {
    let d = 0;
    for (let id = 0; id < this.workerCount; id++) {
      if (Atomics.load(this.ctl, stateSlot(id) + STATUS) === STATE.DEAD) d++;
    }
    return d;
  }

  // ---------- 测试用闸门控制 ----------

  /** 放行前 n 张“开算票”。 */
  async releaseBarrier(n: number): Promise<void> {
    Atomics.store(this.ctl, OFF.GATE_PASS, n);
    this.notify(OFF.GATE_PASS);
  }

  /** 放行前 n 张“提交票”。 */
  async releaseCommit(n: number): Promise<void> {
    Atomics.store(this.ctl, OFF.GATE_RELEASED, n);
    this.notify(OFF.GATE_RELEASED);
  }

  gateArrived(): number {
    return Atomics.load(this.ctl, OFF.GATE_ARRIVED);
  }

  isIdle(): boolean {
    return Atomics.load(this.ctl, OFF.PHASE) === PHASE.IDLE;
  }

  /**
   * 当前完整已提交代。仅 IDLE 返回；进行中/作废/重置中返回 null，
   * 调用方保留上一份快照——画面与导出永远不接触半成品缓冲。
   */
  committedView(): { view: Uint8Array; generation: number } | null {
    if (Atomics.load(this.ctl, OFF.PHASE) !== PHASE.IDLE) return null;
    const cur = Atomics.load(this.ctl, OFF.CUR);
    return {
      view: cur === 0 ? this.viewA : this.viewB,
      generation: Atomics.load(this.ctl, OFF.GEN),
    };
  }

  /** 导出当前完整已提交代（复制副本）。非 IDLE 返回 null，调用方稍后重试。 */
  exportGeneration(): { data: Uint8Array; rows: number; cols: number; generation: number } | null {
    const c = this.committedView();
    if (!c) return null;
    return {
      data: Uint8Array.from(c.view),
      rows: this.rows,
      cols: this.cols,
      generation: c.generation,
    };
  }

  /** 鼠标编辑活格：仅 IDLE 允许，直接改当前提交缓冲。 */
  setCell(r: number, c: number, value: 0 | 1): void {
    if (Atomics.load(this.ctl, OFF.PHASE) !== PHASE.IDLE) return;
    if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) return;
    const view = Atomics.load(this.ctl, OFF.CUR) === 0 ? this.viewA : this.viewB;
    view[r * this.cols + c] = value;
  }

  dispose(): void {
    this.killAll();
  }
}
