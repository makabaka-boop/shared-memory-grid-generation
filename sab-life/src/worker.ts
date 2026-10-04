/**
 * worker.ts — 真实 Worker 入口。同一份代码跑在浏览器（module worker）
 * 和 Node（worker_threads，供冒烟测试）里。
 *
 * 结构：环境适配层拿到 { sab, workerId } 后，进入
 *   Atomics.wait(SEQ) → workerStep() 的循环。
 * 网格数据从不经过消息；消息只发 ready/done/error 通知。
 */

import { CTRL, InitMsg, WorkerOutbound } from './protocol.js';
import { createWorkerCtx, workerStep } from './worker-core.js';

function run(sab: SharedArrayBuffer, workerId: number, post: (m: WorkerOutbound) => void): void {
  const ctx = createWorkerCtx(sab, workerId, post);
  post({ type: 'ready', workerId, epoch: Atomics.load(ctx.ctrl, CTRL.EPOCH) });
  // -1 保证第一轮 wait 立即返回，从而处理"启动前就已派发"的状态
  let seenSeq = -1;
  for (;;) {
    Atomics.wait(ctx.ctrl, CTRL.SEQ, seenSeq);
    seenSeq = Atomics.load(ctx.ctrl, CTRL.SEQ);
    // 一次唤醒可能有多件事要做（例如先 ack 新 epoch、再算新任务），
    // 循环到没有工作为止，再回去等待
    while (workerStep(ctx) !== 'idle') {
      /* 持续推进 */
    }
  }
}

async function entry(): Promise<void> {
  const g = globalThis as Record<string, any>;
  const isNode =
    typeof g.process === 'object' && g.process !== null &&
    typeof g.process.versions?.node === 'string';

  if (isNode) {
    // Node worker_threads：初始化数据走 workerData
    const spec = 'node:worker_threads';
    const wt = await import(spec);
    if (!wt.parentPort) return;
    const init = wt.workerData as InitMsg;
    run(init.sab, init.workerId, (m) => wt.parentPort.postMessage(m));
  } else {
    // 浏览器：初始化数据走第一条消息
    const init = await new Promise<InitMsg>((resolve) => {
      g.onmessage = (ev: MessageEvent) => resolve(ev.data as InitMsg);
    });
    run(init.sab, init.workerId, (m) => g.postMessage(m));
  }
}

void entry();
