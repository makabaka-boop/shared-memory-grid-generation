/**
 * 可控交错测试台：
 *  - 每个“假 Worker”是同进程内的异步协程，跑的是与真实 Worker 完全相同的 workerLoop，
 *    共用同三块 SharedArrayBuffer；只是等待原语由真实 Atomics.wait 换成 FIFO 唤醒队列。
 *  - 所有唤醒回调进同一个微任务 FIFO；引擎的 sleep 也排队尾，保证交错严格确定、可复现。
 *  - drain() 排空队列到稳定点；waitUntil() 反复 drain 直到条件成立或超时。
 */
import { BootMessage, OFF, WorkerMessage } from '../src/protocol';
import { WorkerRuntimeEnv, workerLoop } from '../src/worker-core';
import { WorkerFactory, WorkerHandle } from '../src/engine';

type Task = () => void;

export class FakeScheduler {
  private queue: Task[] = [];
  /** 字段级等待者表：公开给同目录测试台工厂注册/注销等待回调。 */
  readonly waiting = new Map<number, Set<Task>>();

  /** 注册一个等待者（thenable 被 await 时调用）。 */
  waitOn(idx: number, cb: Task): void {
    let set = this.waiting.get(idx);
    if (!set) {
      set = new Set();
      this.waiting.set(idx, set);
    }
    set.add(cb);
  }

  /** 广播唤醒：等待者醒来后自行重检谓词（模拟 Atomics.notify 语义，迟到通知也安全）。 */
  wake(idx: number): void {
    const waiters = this.waiting.get(idx);
    if (!waiters) return;
    for (const w of [...waiters]) this.queue.push(w);
  }

  enqueue(t: Task): void {
    this.queue.push(t);
  }

  /**
   * 引擎让出事件循环：一个真实宏任务节拍后顺手泵一次 FIFO。
   * 真实环境里 worker 的唤醒回调本就由事件循环在主线程 setTimeout 等待期间执行；
   * 假调度器同进程模拟，需要由引擎的等待节拍显式泵队列，否则没人 drain 时回调永远滞留。
   * 用 setTimeout 而非直接排队，避免引擎轮询在单个 drain 内自我续队造成假忙等。
   */
  sleep(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        void this.drain().then(() => resolve(undefined));
      }, 0);
    });
  }

  /** 排空当前所有排队任务（任务可能继续入队，直到队列空）。 */
  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue;
      this.queue = [];
      for (const t of batch) {
        t();
        await Promise.resolve();
      }
    }
  }

  async waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.drain();
      if (cond()) return;
      if (Date.now() > deadline) throw new Error('waitUntil 超时');
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

export interface FakeWorker extends WorkerHandle {
  alive: boolean;
  died: { error: string } | null;
}

export interface FakeHarness {
  scheduler: FakeScheduler;
  factory: WorkerFactory;
  /** 引擎 onNotify 钩子：引擎每次 notify 后广播对应字段上的假等待者。 */
  engineNotify: (offset: number) => void;
  workers: () => FakeWorker[];
  /** 模拟迟到的旧通知：在作废/重置之后“送达”，等待者醒来必须靠谓词拒绝它。 */
  lateTick: (idx: number) => void;
}

export function makeFakeFactory(): FakeHarness {
  const scheduler = new FakeScheduler();
  const workers: FakeWorker[] = [];

  const factory: WorkerFactory = (boot: BootMessage, onFatal) => {
    const w: FakeWorker = {
      id: boot.id,
      alive: true,
      died: null,
      terminate() {
        w.alive = false;
      },
    };
    workers[boot.id] = w;

    // 每次 await tick 生成一个一次性 thenable：被唤醒即注销并放行，循环里会重新注册。
    const waitOn = (idx: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const task = () => {
          scheduler.waiting.get(idx)?.delete(task);
          resolve();
        };
        scheduler.waitOn(idx, task);
      });

    const env: WorkerRuntimeEnv = {
      get alive() {
        return w.alive;
      },
      set alive(v: boolean) {
        w.alive = v;
      },
      post: (m: WorkerMessage) => {
        if (m.type === 'fatal') {
          w.died = { error: m.error };
          // fatal 处理也排队，模拟真实消息事件的异步到达。
          scheduler.enqueue(() => onFatal(m.id, m.error));
        }
      },
      crash: () => {
        w.alive = false;
      },
      phaseWait: () => waitOn(OFF.PHASE),
      tick: (idx: number) => waitOn(idx),
    };

    void workerLoop(boot, env).catch(() => undefined);

    return w;
  };

  return {
    scheduler,
    factory,
    engineNotify: (offset: number) => scheduler.wake(offset),
    workers: () => workers.filter(Boolean),
    lateTick: (idx: number) => scheduler.wake(idx),
  };
}
