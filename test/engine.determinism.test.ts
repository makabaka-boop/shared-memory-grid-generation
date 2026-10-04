import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import {
  GATE,
  OFF,
  PHASE,
  STATE,
  SEEN,
  STATUS,
  stateSlot,
  stepReference,
} from '../src/protocol';
import { makeFakeFactory } from './test-harness';

function makeGrid(rows: number, cols: number, fill?: (r: number, c: number) => number): Uint8Array {
  const d = new Uint8Array(rows * cols);
  if (fill) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) d[r * cols + c] = fill(r, c);
  return d;
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
  return makeGrid(rows, cols, () => (rnd() < density ? 1 : 0));
}

function makeEngine(
  initial: Uint8Array,
  rows: number,
  cols: number,
  workerCount: number,
  gateMode: number = GATE.NONE,
) {
  const h = makeFakeFactory();
  const engine = new Engine({
    rows,
    cols,
    workerCount,
    initial,
    gateMode,
    factory: h.factory,
    sleep: () => h.scheduler.sleep(),
    onNotify: h.engineNotify,
  });
  return { engine, h };
}

/** 参考实现推进 gens 代，返回每代结果。 */
function refGenerations(initial: Uint8Array, rows: number, cols: number, gens: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let src = Uint8Array.from(initial);
  let dst = new Uint8Array(initial.length);
  for (let g = 0; g < gens; g++) {
    stepReference(src, dst, rows, cols);
    out.push(Uint8Array.from(dst));
    [src, dst] = [dst, src];
  }
  return out;
}

async function committed(engine: Engine): Promise<Uint8Array> {
  const c = engine.committedView();
  expect(c, '只有完整已提交代可取').not.toBeNull();
  return Uint8Array.from(c!.view);
}

async function runGatedStep(
  engine: Engine,
  h: ReturnType<typeof makeFakeFactory>,
  n: number,
  releaseCommit = false,
): Promise<void> {
  await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
  for (let k = 1; k <= n; k++) {
    await engine.releaseBarrier(k);
    await h.scheduler.drain();
  }
  if (releaseCommit) {
    await engine.releaseCommit(n);
    await h.scheduler.drain();
  }
}

describe('单线程参考一致性（假 Worker 同进程协程）', () => {
  it('2/3/4 个 worker 多代演化均与参考实现逐格相同', async () => {
    const rows = 37;
    const cols = 53;
    for (const n of [2, 3, 4]) {
      const initial = randomPattern(rows, cols, 7 + n);
      const { engine, h } = makeEngine(initial, rows, cols, n);
      const refs = refGenerations(initial, rows, cols, 12);
      for (let g = 0; g < 12; g++) {
        const p = engine.step();
        await h.scheduler.waitUntil(() => engine.isIdle());
        const out = await p;
        expect(out.status).toBe('committed');
        expect(await committed(engine)).toEqual(refs[g]);
      }
      engine.dispose();
    }
  });

  it('16 和 128 边长、行列不等也正确（环面回绕）', async () => {
    for (const [rows, cols] of [
      [16, 16],
      [128, 128],
      [16, 128],
      [128, 17],
    ]) {
      const initial = randomPattern(rows, cols, 1234);
      const { engine, h } = makeEngine(initial, rows, cols, 4);
      const refs = refGenerations(initial, rows, cols, 5);
      for (let g = 0; g < 5; g++) {
        const p = engine.step();
        await h.scheduler.waitUntil(() => engine.isIdle());
        await p;
        expect(await committed(engine)).toEqual(refs[g]);
      }
      engine.dispose();
    }
  });
});

describe('可控交错', () => {
  it('BARRIER：最后一个 worker 尚未完成时绝不提交；放行后结果与参考一致', async () => {
    const rows = 40;
    const cols = 40;
    const n = 4;
    const initial = randomPattern(rows, cols, 99);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);
    const refs = refGenerations(initial, rows, cols, 3);

    const p = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);

    // 只放行 3 个：它们算完 PARKED，最后一个没动——必须不提交。
    await engine.releaseBarrier(3);
    await h.scheduler.drain();
    expect(engine.ctl[OFF.DONE]).toBe(3);
    expect(engine.ctl[OFF.ACK]).toBe(3);
    expect(engine.isIdle()).toBe(false);
    expect(engine.committedView()).toBeNull(); // 进行中取不到“代”
    expect(engine.generation).toBe(0);

    // 放行最后一个 → 提交。
    await engine.releaseBarrier(4);
    const out = await p;
    expect(out.status).toBe('committed');
    if (out.status !== 'committed') throw new Error('unreachable');
    expect(out.generation).toBe(1);
    expect(await committed(engine)).toEqual(refs[0]);

    // 后续代逐张放行，结果仍正确。
    for (let g = 1; g < 3; g++) {
      const p2 = engine.step();
      await runGatedStep(engine, h, n);
      const o2 = await p2;
      expect(o2.status).toBe('committed');
      expect(await committed(engine)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('BARRIER_AND_COMMIT：全部行区算完但未释放提交闸门前不交换、代号不增', async () => {
    const rows = 28;
    const cols = 31;
    const n = 3;
    const initial = randomPattern(rows, cols, 42);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER_AND_COMMIT);

    const p = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(n);
    await h.scheduler.drain();

    // 行区都算完了（DONE=n），但全挡在提交闸门前：尚未提交。
    expect(engine.ctl[OFF.DONE]).toBe(n);
    expect(engine.isIdle()).toBe(false);
    expect(engine.committedView()).toBeNull();
    expect(engine.generation).toBe(0);

    await engine.releaseCommit(n);
    const out = await p;
    expect(out.status).toBe('committed');
    const [ref] = refGenerations(initial, rows, cols, 1);
    expect(await committed(engine)).toEqual(ref);
    engine.dispose();
  });

  it('乱序/迟到的放行票不改变结果', async () => {
    const rows = 32;
    const cols = 32;
    const n = 4;
    const initial = randomPattern(rows, cols, 5);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const p = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(1);
    await h.scheduler.drain();
    await engine.releaseBarrier(3); // 票 2、3 一起过
    await h.scheduler.drain();
    await engine.releaseBarrier(2); // 迟到的“倒退票”：谓词不允许它决定任何事
    await h.scheduler.drain();
    expect(engine.ctl[OFF.DONE]).toBe(3);
    expect(engine.isIdle()).toBe(false);
    await engine.releaseBarrier(4);
    const out = await p;
    expect(out.status).toBe('committed');
    const [ref] = refGenerations(initial, rows, cols, 1);
    expect(await committed(engine)).toEqual(ref);
    engine.dispose();
  });
});

describe('Worker 异常中止', () => {
  it('某个 worker 写了半区后异常：回合作废，已提交代保持不变，代号不增', async () => {
    const rows = 32;
    const cols = 32;
    const n = 4;
    const initial = randomPattern(rows, cols, 77);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const p = engine.step(1); // worker 1 将在开算后、写完半区时崩
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(2); // 票 1、2 过：worker1 崩，worker0 完整算完
    const out = await p;
    expect(out.status).toBe('aborted');
    if (out.status !== 'aborted') throw new Error('unreachable');
    expect(out.reason).toBe('fault');
    expect(engine.isIdle()).toBe(true);
    expect(engine.generation).toBe(0);
    expect(await committed(engine)).toEqual(initial); // cur 未交换，半区残留在 other 不可见

    for (let id = 0; id < n; id++) {
      expect(engine.ctl[stateSlot(id) + STATUS]).toBe(STATE.PARKED);
    }
    engine.dispose();
  });

  it('异常恢复后继续演化，与无故障参考逐代一致；半区残留不影响结果', async () => {
    const rows = 35;
    const cols = 29;
    const n = 3;
    const initial = randomPattern(rows, cols, 88);
    const { engine, h } = makeEngine(initial, rows, cols, n);

    const out = await engine.step(2);
    expect(out.status).toBe('aborted');
    await h.scheduler.drain();

    const refs = refGenerations(initial, rows, cols, 10);
    for (let g = 0; g < 10; g++) {
      const p = engine.step();
      await h.scheduler.waitUntil(() => engine.isIdle());
      const o = await p;
      expect(o.status).toBe('committed');
      expect(await committed(engine)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('最后一个线程尚未完成时另一个线程异常：闸前线程不写一格，作废后静止才恢复', async () => {
    const rows = 48;
    const cols = 24;
    const n = 4;
    const initial = randomPattern(rows, cols, 31);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const p = engine.step(0);
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(1); // 仅 worker0 开算，它写完半区即崩
    const out = await p; // 作废广播唤醒闸前所有人，它们见 ABORTING 直接 PARKED
    expect(out.status).toBe('aborted');
    if (out.status !== 'aborted') throw new Error('unreachable');
    expect(out.reason).toBe('fault');
    expect(engine.generation).toBe(0);
    expect(await committed(engine)).toEqual(initial);

    const refs = refGenerations(initial, rows, cols, 3);
    for (let g = 0; g < 3; g++) {
      const p2 = engine.step();
      await runGatedStep(engine, h, n); // 引擎仍为 BARRIER 模式，需逐张放行
      const o2 = await p2;
      expect(o2.status).toBe('committed');
      expect(await committed(engine)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('故障后换尺寸重建：故障旧线程与旧池全部终止，新网格正确', async () => {
    const rows = 24;
    const cols = 24;
    const n = 2;
    const initial = randomPattern(rows, cols, 3);
    const { engine, h } = makeEngine(initial, rows, cols, n);

    const out = await engine.step(0);
    expect(out.status).toBe('aborted');
    await h.scheduler.drain();
    // 记录补员前的全部句柄：故障者已自毁，其余在换尺寸重建时被 terminate。
    const beforeHandles = h.workers().map((w) => ({ w, alive: w.alive }));

    await engine.reset(30, 30, undefined); // 换尺寸 → killAll + 重建
    for (const { w } of beforeHandles) expect(w.alive).toBe(false);
    expect(engine.rows).toBe(30);
    expect(engine.cols).toBe(30);
    expect(engine.generation).toBe(0);
    const c = engine.committedView();
    expect(c).not.toBeNull();
    expect(c!.view.every((v) => v === 0)).toBe(true);
    engine.dispose();
  });
});

describe('旧代消息迟到', () => {
  it('作废后才送达的旧闸门通知：worker 不会误写，缓冲保持重置后的初值', async () => {
    const rows = 32;
    const cols = 32;
    const n = 4;
    const initial = randomPattern(rows, cols, 65);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const stepP = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(2); // 两个开算，两个闸前
    await h.scheduler.drain();

    // 计算途中同尺寸重置（清零）。
    await engine.reset(rows, cols, undefined);
    const stepOut = await stepP;
    expect(stepOut.status).toBe('aborted');
    if (stepOut.status !== 'aborted') throw new Error('unreachable');
    expect(stepOut.reason).toBe('reset');
    expect(engine.isIdle()).toBe(true);

    // 迟到的旧通知现在才“送达”：ABORTING 已过、ROUND 已变，谓词必须全部拒绝。
    h.lateTick(OFF.GATE_PASS);
    h.lateTick(OFF.GATE_RELEASED);
    h.lateTick(OFF.PHASE);
    await h.scheduler.drain();

    const cur = await committed(engine);
    expect(cur.every((v) => v === 0)).toBe(true);
    expect(engine.generation).toBe(0);

    // 旧 worker 在新回合继续工作，演化结果正确（引擎仍处 BARRIER 模式，逐张放行）。
    const p2 = engine.step();
    await runGatedStep(engine, h, n);
    await p2;
    const [ref] = refGenerations(new Uint8Array(rows * cols), rows, cols, 1);
    expect(await committed(engine)).toEqual(ref);
    engine.dispose();
  });

  it('补员 worker 带“旧 round”启动，不会误加入已结束回合；后续演化仍与参考一致', async () => {
    const rows = 24;
    const cols = 24;
    const n = 2;
    const initial = randomPattern(rows, cols, 9);
    const { engine, h } = makeEngine(initial, rows, cols, n);

    const refs = refGenerations(initial, rows, cols, 6);
    for (let g = 0; g < 3; g++) {
      const p = engine.step();
      await h.scheduler.waitUntil(() => engine.isIdle());
      await p;
      expect(await committed(engine)).toEqual(refs[g]);
    }

    const fo = await engine.step(0); // 故障作废并补员
    expect(fo.status).toBe('aborted');
    await h.scheduler.drain();

    // 新补员 worker 的 SEEN 等于作废回合号。
    for (let id = 0; id < n; id++) {
      expect(engine.ctl[stateSlot(id) + SEEN]).toBe(4);
    }

    for (let g = 3; g < 6; g++) {
      const p = engine.step();
      await h.scheduler.waitUntil(() => engine.isIdle());
      await p;
      expect(await committed(engine)).toEqual(refs[g]);
    }
    engine.dispose();
  });
});

describe('重置语义', () => {
  it('计算途中同尺寸重置：静止后才重写；之后从新初值演化', async () => {
    const rows = 40;
    const cols = 40;
    const n = 4;
    const initial = randomPattern(rows, cols, 21);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const stepP = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(2); // 一半线程已在写 other
    await h.scheduler.drain();
    expect(engine.ctl[OFF.PHASE]).toBe(PHASE.RUNNING);

    const fresh = randomPattern(rows, cols, 1217);
    await engine.reset(rows, cols, fresh);
    const stepOut = await stepP;
    expect(stepOut.status).toBe('aborted');
    if (stepOut.status !== 'aborted') throw new Error('unreachable');
    expect(stepOut.reason).toBe('reset');

    expect(await committed(engine)).toEqual(fresh);
    const refs = refGenerations(fresh, rows, cols, 4);
    for (let g = 0; g < 4; g++) {
      const p = engine.step();
      await runGatedStep(engine, h, n);
      await p;
      expect(await committed(engine)).toEqual(refs[g]);
    }
    engine.dispose();
  });

  it('计算途中换尺寸：旧池先全部终止，新网格尺寸正确且从初值演化', async () => {
    const rows = 32;
    const cols = 32;
    const n = 4;
    const initial = randomPattern(rows, cols, 4);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER);

    const stepP = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(3);
    await h.scheduler.drain();

    // UI 的换尺寸路径：先 reset 作废静止 → dispose 终止旧池 → 建新引擎。
    const oldWorkers = h.workers();
    await engine.reset(rows, cols, undefined);
    await stepP;
    engine.dispose();
    expect(oldWorkers.every((w) => !w.alive)).toBe(true);

    const newRows = 16;
    const newCols = 48;
    const fresh = randomPattern(newRows, newCols, 71);
    const h2 = makeFakeFactory();
    const engine2 = new Engine({
      rows: newRows,
      cols: newCols,
      workerCount: 2,
      initial: fresh,
      factory: h2.factory,
      sleep: () => h2.scheduler.sleep(),
      onNotify: h2.engineNotify,
    });
    expect(await committed(engine2)).toEqual(fresh);
    const [ref] = refGenerations(fresh, newRows, newCols, 1);
    const p = engine2.step();
    await h2.scheduler.waitUntil(() => engine2.isIdle());
    await p;
    expect(await committed(engine2)).toEqual(ref);
    engine2.dispose();
  });

  it('进行中导出必须为 null；提交后导出的是完整代且内容与参考一致', async () => {
    const rows = 24;
    const cols = 24;
    const n = 3;
    const initial = randomPattern(rows, cols, 56);
    const { engine, h } = makeEngine(initial, rows, cols, n, GATE.BARRIER_AND_COMMIT);

    const p = engine.step();
    await h.scheduler.waitUntil(() => engine.ctl[OFF.GATE_ARRIVED] === n);
    await engine.releaseBarrier(n);
    await h.scheduler.drain();
    // 全部行区已写完但挡在提交闸门前：未提交代，视图/导出必须拒绝。
    expect(engine.ctl[OFF.DONE]).toBe(n);
    expect(engine.committedView()).toBeNull();
    expect(engine.exportGeneration()).toBeNull();

    await engine.releaseCommit(n);
    await p;
    const ex = engine.exportGeneration();
    expect(ex).not.toBeNull();
    expect(ex!.generation).toBe(1);
    expect(ex!.rows).toBe(rows);
    expect(ex!.cols).toBe(cols);
    const [ref] = refGenerations(initial, rows, cols, 1);
    expect(ex!.data).toEqual(ref);
    engine.dispose();
  });

  it('静止状态下 setCell 只改当前提交缓冲；下一代从编辑后的状态演化', async () => {
    const rows = 20;
    const cols = 20;
    const n = 2;
    const { engine, h } = makeEngine(new Uint8Array(rows * cols), rows, cols, n);
    engine.setCell(5, 5, 1);
    engine.setCell(5, 6, 1);
    engine.setCell(5, 7, 1); // 一闪：横三连（振荡器 blinker）
    const edited = (await committed(engine)).slice();
    const p = engine.step();
    await h.scheduler.waitUntil(() => engine.isIdle());
    await p;
    const [ref] = refGenerations(edited, rows, cols, 1);
    expect(await committed(engine)).toEqual(ref);
    engine.dispose();
  });
});
