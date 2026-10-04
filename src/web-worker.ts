/// <reference lib="webworker" />
/**
 * 浏览器真实 Worker 入口。
 * 收到唯一一条 boot 消息（含三块 SharedArrayBuffer 元数据）后进入 workerLoop，
 * 使用 Atomics.wait 睡眠；这会冻结的是 Worker 自己的线程，主线程永不阻塞。
 */
import { BootMessage, WorkerMessage } from './protocol';
import { WorkerRuntimeEnv, atomicWaitPrimitives, workerLoop } from './worker-core';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<BootMessage>) => {
  const boot = ev.data;
  if (!boot || boot.type !== 'boot') return;

  const control = new Int32Array(boot.control);
  const env: WorkerRuntimeEnv = {
    alive: true,
    post: (m: WorkerMessage) => ctx.postMessage(m),
    crash() {
      env.alive = false;
      ctx.close();
    },
    ...atomicWaitPrimitives(control),
  };
  workerLoop(boot, env).catch((err: unknown) => {
    ctx.postMessage({
      type: 'fatal',
      id: boot.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerMessage);
    ctx.close();
  });
};
