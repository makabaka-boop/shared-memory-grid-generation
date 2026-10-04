/**
 * Worker 侧回合逻辑，浏览器 Worker 与 Node worker_threads 共用。
 *
 * 关键不变量：
 *  - 只有看到一个“自己没参与过的新回合”（round > lastSeen）且 phase ∈ {RUNNING, ABORTING}
 *    才会加入；迟到唤醒（旧闸门通知、异常 notify）一律先比对快照，不匹配立刻 PARKED。
 *  - 加入后：COMPUTING →（可选闸门）→ 读 cur 写 other → DONE →（可选提交闸门）→ PARKED/ACK。
 *  - 任何闸门醒来都重新校验 phase/round，ABORTING 或 round 已变则一字节都不再写。
 *  - 故障注入：先写完自己行区的前半段（模拟“计算途中”），再置 DEAD/ACK、上报 fatal 并自毁。
 */
import {
  BootMessage,
  GATE,
  OFF,
  PHASE,
  STATE,
  SEEN,
  STATUS,
  WorkerMessage,
  rowRange,
  stateSlot,
  stepRegion,
} from './protocol';

export class WorkerFault extends Error {
  constructor(id: number) {
    super(`worker ${id} 在计算途中注入异常`);
    this.name = 'WorkerFault';
  }
}

/** 等待原语：真实线程用 Atomics.wait，测试用可控 Promise。 */
export interface WaitPrimitives {
  /** 等待 PHASE 发生变化（值已变或伪唤醒都靠循环重检）。 */
  phaseWait(): void | Promise<void>;
  /** 在编号为 idx 的闸门字段上等待被通知。 */
  tick(idx: number): void | Promise<void>;
}

export interface WorkerRuntimeEnv extends WaitPrimitives {
  alive: boolean;
  post(msg: WorkerMessage): void;
  /** 致命错误后的自毁（浏览器 self.close / Node process.exit / 测试标记）。 */
  crash(err: unknown): void;
}

function ctlAt(view: Int32Array) {
  return {
    load: (off: number) => Atomics.load(view, off),
    store: (off: number, v: number) => Atomics.store(view, off, v),
    add: (off: number, v: number) => Atomics.add(view, off, v),
    notify: (off: number, n = Infinity) => Atomics.notify(view, off, n as number),
  };
}

/**
 * Worker 主循环。boot 里的 round 是“当前已结束回合”，新启动/补员的 Worker 以它为 lastSeen，
 * 因此绝不会误加入一个已经结束的旧回合（覆盖“旧代消息迟到”场景）。
 */
export async function workerLoop(
  boot: BootMessage,
  env: WorkerRuntimeEnv,
): Promise<void> {
  const ctl = new Int32Array(boot.control);
  const rows = () => Atomics.load(ctl, OFF.ROWS);
  const cols = () => Atomics.load(ctl, OFF.COLS);
  const nWorkers = () => Atomics.load(ctl, OFF.NWORKERS);
  const a = new Uint8Array(boot.gridA);
  const b = new Uint8Array(boot.gridB);
  const slot = stateSlot(boot.id);
  const atom = ctlAt(ctl);

  env.post({ type: 'ready', id: boot.id });

  let lastSeen = boot.round;

  while (env.alive) {
    // 1) 等待新回合发布。IDLE / RESETTING / 已参与过的回合都继续睡。
    let round = atom.load(OFF.ROUND);
    let phase = atom.load(OFF.PHASE);
    while (
      env.alive &&
      (round === lastSeen || phase === PHASE.IDLE || phase === PHASE.RESETTING)
    ) {
      await env.phaseWait();
      round = atom.load(OFF.ROUND);
      phase = atom.load(OFF.PHASE);
    }
    if (!env.alive) return;

    // 2) 加入回合（此时 phase 为 RUNNING 或 ABORTING）。
    const myRound = round;
    atom.store(slot + STATUS, STATE.COMPUTING);
    atom.add(OFF.ACCEPT, 1);

    const park = () => {
      atom.store(slot + SEEN, myRound);
      atom.store(slot + STATUS, STATE.PARKED);
      atom.add(OFF.ACK, 1);
    };

    try {
      phase = atom.load(OFF.PHASE);
      if (phase === PHASE.ABORTING) {
        park();
        lastSeen = myRound;
        continue;
      }

      const mode = atom.load(OFF.GATE_MODE);
      const R = rows();
      const C = cols();
      const N = nWorkers();
      const [rowStart, rowEnd] = rowRange(boot.id, N, R);
      const cur = atom.load(OFF.CUR) === 0 ? a : b;
      const other = cur === a ? b : a;
      let ticket = 0;

      const stale = () =>
        atom.load(OFF.PHASE) === PHASE.ABORTING ||
        atom.load(OFF.ROUND) !== myRound;

      const gateWhile = async (idx: number, ready: () => boolean) => {
        while (!ready()) {
          if (stale()) return false;
          await env.tick(idx);
        }
        return !stale();
      };

      // 开算闸门：测试逐张放行，制造任意交错。
      if (mode === GATE.BARRIER || mode === GATE.BARRIER_AND_COMMIT) {
        ticket = atom.add(OFF.GATE_ARRIVED, 1) + 1;
        const ok = await gateWhile(OFF.GATE_PASS, () => atom.load(OFF.GATE_PASS) >= ticket);
        if (!ok) {
          park();
          lastSeen = myRound;
          continue;
        }
      }

      // 故障注入：行区起点命中 FAULT_AT 时，先写前半行区再崩（中途异常 + 残留写）。
      const faultAt = atom.load(OFF.FAULT_AT);
      const mid = rowStart + Math.max(1, Math.floor((rowEnd - rowStart) / 2));
      if (faultAt >= 0 && faultAt === rowStart) {
        stepRegion(cur, other, R, C, rowStart, mid);
        throw new WorkerFault(boot.id);
      }

      stepRegion(cur, other, R, C, rowStart, rowEnd);
      atom.add(OFF.DONE, 1);

      // 提交闸门：所有行区算完但主线程尚未交换时，可以把线程挡在这里。
      if (mode === GATE.BARRIER_AND_COMMIT) {
        await gateWhile(OFF.GATE_RELEASED, () => atom.load(OFF.GATE_RELEASED) >= ticket);
        // 此时行区已写入 other；即使回合作废也无所谓——主线程静止后才会复用缓冲。
      }

      park();
      lastSeen = myRound;
    } catch (err) {
      // 终态 ACK：保证主线程能等到“所有加入者停手”，然后才恢复/重置。
      atom.store(slot + SEEN, myRound);
      atom.store(slot + STATUS, STATE.DEAD);
      atom.add(OFF.ACK, 1);
      env.post({
        type: 'fatal',
        id: boot.id,
        error: err instanceof Error ? err.message : String(err),
      });
      env.crash(err);
      return;
    }
  }
}

/** 真实线程（浏览器 Worker / Node worker_threads）的 Atomics.wait 等待原语。 */
export function atomicWaitPrimitives(control: Int32Array): WaitPrimitives {
  return {
    phaseWait() {
      // 以当前值为期望值；主线程改 PHASE 后 notify 唤醒，超时只是伪唤醒兜底。
      Atomics.wait(control, OFF.PHASE, Atomics.load(control, OFF.PHASE), 250);
    },
    tick(idx: number) {
      Atomics.wait(control, idx, Atomics.load(control, idx), 250);
    },
  };
}
