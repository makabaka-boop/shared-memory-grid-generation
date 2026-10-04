import { WorkerFactory } from './engine';

/**
 * 浏览器真实 Worker 工厂：每个 Worker 独立线程，共享同三块 SharedArrayBuffer。
 * SAB 走结构化克隆时是“共享”而非拷贝——消息里从不携带网格数据。
 */
export const webWorkerFactory: WorkerFactory = (boot, onFatal) => {
  const worker = new Worker(new URL('./web-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (ev: MessageEvent) => {
    const msg = ev.data;
    if (msg?.type === 'fatal') onFatal(msg.id as number, String(msg.error ?? 'unknown'));
  };
  worker.postMessage(boot);
  return {
    id: boot.id,
    terminate: () => worker.terminate(),
  };
};
