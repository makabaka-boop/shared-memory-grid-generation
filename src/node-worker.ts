/**
 * Node worker_threads 入口（真实线程冒烟测试用）。
 * 与浏览器 Worker 共用 worker-core，仅替换传输与自毁原语。
 */
import { parentPort, isMainThread } from 'node:worker_threads';
import { BootMessage } from './protocol';
import { WorkerRuntimeEnv, atomicWaitPrimitives, workerLoop } from './worker-core';

if (isMainThread || !parentPort) {
  throw new Error('node-worker.ts 只能在 worker_threads 中运行');
}

const port = parentPort;

port.once('message', (boot: BootMessage) => {
  if (!boot || boot.type !== 'boot') return;
  const control = new Int32Array(boot.control);

  const env: WorkerRuntimeEnv = {
    alive: true,
    post: (m) => port.postMessage(m),
    crash() {
      env.alive = false;
      process.exit(0);
    },
    ...atomicWaitPrimitives(control),
  };

  workerLoop(boot, env).catch((err: unknown) => {
    port.postMessage({
      type: 'fatal',
      id: boot.id,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
});
