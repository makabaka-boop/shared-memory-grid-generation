/**
 * 真实线程冒烟测试：用 Node worker_threads 拉起 2～4 个真线程，
 * 它们加载与浏览器 Worker 相同的 worker-core（经 esbuild 打包 src/node-worker.ts）。
 * 这是对“真的跨线程、真的 Atomics.wait/notify、真的 SharedArrayBuffer”的端到端验证；
 * 交错细节由确定性测试覆盖，这里只比较与单线程参考一致的演化结果，以及故障恢复。
 */
import { Worker as NodeWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine, WorkerFactory, WorkerHandle } from '../src/engine';
import { BootMessage } from '../src/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(os.tmpdir(), `sbl-node-worker-${process.pid}.mjs`);

beforeAll(async () => {
  await build({
    entryPoints: [path.resolve(here, '../src/node-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: outFile,
  });
});

afterAll(() => {
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* ignore */
  }
});

function nodeWorkerFactory(): WorkerFactory {
  return (boot: BootMessage, onFatal): WorkerHandle => {
    const w: Worker = new NodeWorker(outFile);
    w.on('message', (msg: unknown) => {
      const m = msg as { type?: string; id?: number; error?: string };
      if (m?.type === 'fatal') onFatal(m.id ?? boot.id, m.error ?? 'unknown');
    });
    w.on('error', (err: Error) => {
      if (w.threadId !== -1) onFatal(boot.id, err.message);
    });
    w.postMessage(boot);
    return {
      id: boot.id,
      terminate: () => void w.terminate(),
    };
  };
}

function pseudoRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function randomPattern(rows: number, cols: number, seed: number, density = 0.3): Uint8Array {
  const rnd = pseudoRandom(seed);
  const d = new Uint8Array(rows * cols);
  for (let i = 0; i < d.length; i++) d[i] = rnd() < density ? 1 : 0;
  return d;
}

function refGenerations(initial: Uint8Array, rows: number, cols: number, gens: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let src = Uint8Array.from(initial);
  let dst = new Uint8Array(initial.length);
  for (let g = 0; g < gens; g++) {
    for (let r = 0; r < rows; r++) {
      const up = (r - 1 + rows) % rows;
      const down = (r + 1) % rows;
      for (let c = 0; c < cols; c++) {
        const left = (c - 1 + cols) % cols;
        const right = (c + 1) % cols;
        const n =
          src[up * cols + left] + src[up * cols + c] + src[up * cols + right] +
          src[r * cols + left] + src[r * cols + right] +
          src[down * cols + left] + src[down * cols + c] + src[down * cols + right];
        dst[r * cols + c] = n === 3 ? 1 : n === 2 ? src[r * cols + c] : 0;
      }
    }
    out.push(Uint8Array.from(dst));
    [src, dst] = [dst, src];
  }
  return out;
}

describe('真实 worker_threads 冒烟', () => {
  it.each([2, 3, 4])('%d 个真线程多代演化与单线程参考逐格相同', async (n: number) => {
    const rows = 33;
    const cols = 47;
    const initial = randomPattern(rows, cols, 500 + n);
    const engine = new Engine({
      rows,
      cols,
      workerCount: n,
      initial,
      factory: nodeWorkerFactory(),
    });
    const refs = refGenerations(initial, rows, cols, 8);
    for (let g = 0; g < 8; g++) {
      const out = await engine.step();
      expect(out.status).toBe('committed');
      const view = engine.committedView();
      expect(view).not.toBeNull();
      expect(Uint8Array.from(view!.view)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('真线程计算途中异常：本代作废、代号不增，补员后演化仍与参考一致', async () => {
    const rows = 28;
    const cols = 36;
    const n = 3;
    const initial = randomPattern(rows, cols, 808);
    const engine = new Engine({
      rows,
      cols,
      workerCount: n,
      initial,
      factory: nodeWorkerFactory(),
    });

    const out = await engine.step(1);
    expect(out.status).toBe('aborted');
    if (out.status !== 'aborted') throw new Error('unreachable');
    expect(out.reason).toBe('fault');
    expect(engine.generation).toBe(0);
    expect(Uint8Array.from(engine.committedView()!.view)).toEqual(initial);

    const refs = refGenerations(initial, rows, cols, 6);
    for (let g = 0; g < 6; g++) {
      const o = await engine.step();
      expect(o.status).toBe('committed');
      expect(Uint8Array.from(engine.committedView()!.view)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('真线程回合进行中重置：等待静止后换尺寸重建，新网格演化正确', async () => {
    const rows = 24;
    const cols = 24;
    const n = 4;
    const initial = randomPattern(rows, cols, 11);
    const engine = new Engine({
      rows,
      cols,
      workerCount: n,
      initial,
      factory: nodeWorkerFactory(),
    });

    // 发布一步但立即重置（不 await step），覆盖“计算途中重置”。
    const stepP = engine.step();
    await engine.reset(rows, cols, randomPattern(rows, cols, 12));
    const so = await stepP;
    expect(so.status).toBe('aborted');

    const fresh = randomPattern(16, 50, 13);
    await engine.reset(16, 50, fresh);
    expect(engine.rows).toBe(16);
    expect(engine.cols).toBe(50);
    expect(Uint8Array.from(engine.committedView()!.view)).toEqual(fresh);
    const [ref] = refGenerations(fresh, 16, 50, 1);
    await engine.step();
    expect(Uint8Array.from(engine.committedView()!.view)).toEqual(ref);
    engine.dispose();
  });
});
