/**
 * 浏览器主线程：
 *  - 不参与任何网格更新；只负责发布回合（经 Engine）、绘制与导出。
 *  - 绘制/导出永远来自 snapshot：IDLE 且代号变化时复制一份完整已提交代；
 *    计算途中继续展示这份快照（绝无半代），导出也是它。
 *  - 所有等待都经 Engine 内部的 setTimeout 微轮询，没有 Atomics.wait，界面不冻结。
 */
import { Engine } from './engine';
import { MAX_SIDE, MIN_SIDE, MAX_WORKERS, MIN_WORKERS } from './protocol';
import { webWorkerFactory } from './web-factory';

function unsupported(reason: string): void {
  document.getElementById('app')!.classList.add('hidden');
  const banner = document.getElementById('fatal-banner')!;
  banner.classList.remove('hidden');
  document.getElementById('fatal-reason')!.textContent = `检测结果：${reason}`;
}

function checkSupport(): string | null {
  if (typeof SharedArrayBuffer === 'undefined') return '当前浏览器没有 SharedArrayBuffer';
  if (!self.crossOriginIsolated) {
    return 'window.crossOriginIsolated 为 false（缺少 COOP/COEP 隔离头）';
  }
  if (typeof Atomics === 'undefined') return 'Atomics 不可用';
  try {
    new Int32Array(new SharedArrayBuffer(4))[0] = 0;
  } catch {
    return '无法分配 SharedArrayBuffer';
  }
  return null;
}

const supportReason = checkSupport();
if (supportReason) {
  unsupported(supportReason);
  throw new Error(supportReason);
}

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = (id: string) => document.getElementById(id)!;

const rowsInput = $('rows') as HTMLInputElement;
const colsInput = $('cols') as HTMLInputElement;
const workersInput = $('workers') as HTMLInputElement;
const intervalInput = $('interval') as HTMLInputElement;
const genEl = $('gen');
const phaseEl = $('phase');
const faultLine = $('fault-line');
const faultText = $('fault-text');
const btnRun = $('btn-run') as HTMLButtonElement;
const btnPause = $('btn-pause') as HTMLButtonElement;
const btnStep = $('btn-step') as HTMLButtonElement;
const btnReset = $('btn-reset') as HTMLButtonElement;
const btnRandom = $('btn-random') as HTMLButtonElement;
const btnExport = $('btn-export') as HTMLButtonElement;
const btnFault = $('btn-fault') as HTMLButtonElement;

let engine: Engine | null = null;

function randomGrid(rows: number, cols: number, density = 0.28): Uint8Array {
  const data = new Uint8Array(rows * cols);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() < density ? 1 : 0;
  return data;
}

function clampSide(v: number): number {
  if (!Number.isFinite(v)) return 64;
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(v)));
}

function workerCount(): number {
  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Number(workersInput.value) || 4));
}

// ---------- 已提交代快照：画面与导出的唯一数据来源 ----------
let snapshot: Uint8Array | null = null;
let snapshotGen = -1;
let snapshotRows = 0;
let snapshotCols = 0;

function refreshSnapshot(): void {
  if (!engine) return;
  const c = engine.committedView();
  if (!c) return; // 非 IDLE：保留旧快照，屏幕绝不碰半成品
  if (
    c.generation !== snapshotGen ||
    snapshotRows !== engine.rows ||
    snapshotCols !== engine.cols
  ) {
    snapshot = Uint8Array.from(c.view);
    snapshotGen = c.generation;
    snapshotRows = engine.rows;
    snapshotCols = engine.cols;
  }
}

function draw(): void {
  if (!snapshot) return;
  const rows = snapshotRows;
  const cols = snapshotCols;
  const cw = canvas.width / cols;
  const ch = canvas.height / rows;
  ctx.fillStyle = '#06080c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#5ee2a0';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (snapshot[r * cols + c]) ctx.fillRect(c * cw, r * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
}

// ---------- 自动演化（不阻塞；暂停/重置可随时打断） ----------
let auto = false;
let busy = false;
let loopToken = 0;
let pendingFault = -1;

async function runLoop(): Promise<void> {
  const myToken = ++loopToken;
  while (auto && myToken === loopToken && engine) {
    const fault = pendingFault;
    pendingFault = -1;
    const outcome = await engine.step(fault);
    if (outcome.status === 'aborted') {
      if (outcome.reason === 'reset') return;
      flashFault(engine.lastFault ?? 'worker 异常');
    }
    const wait = Math.max(0, Number(intervalInput.value) || 0);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function flashFault(text: string): void {
  faultLine.hidden = false;
  faultText.textContent = text;
  setTimeout(() => (faultLine.hidden = true), 4000);
}

function syncButtons(): void {
  btnRun.disabled = busy;
  btnPause.disabled = !busy || !auto;
  btnStep.disabled = busy;
  rowsInput.disabled = busy;
  colsInput.disabled = busy;
  workersInput.disabled = busy;
  if (busy) {
    phaseEl.textContent = auto
      ? `演化中 · 画面为第 ${Math.max(0, snapshotGen)} 代快照`
      : '单步/恢复中…';
  } else {
    phaseEl.textContent = '已暂停 · 展示完整已提交代';
  }
}

function setBusy(v: boolean): void {
  busy = v;
  syncButtons();
}

btnRun.addEventListener('click', () => {
  if (auto || !engine) return;
  auto = true;
  setBusy(true);
  void runLoop().finally(() => {
    auto = false;
    setBusy(false);
  });
});

btnPause.addEventListener('click', () => {
  // 当前代仍会完整提交：暂停只是不再排下一代，绝不在半途停写。
  auto = false;
  loopToken++;
});

btnStep.addEventListener('click', () => {
  if (busy || !engine) return;
  setBusy(true);
  void engine
    .step()
    .then((outcome) => {
      if (outcome.status === 'aborted' && outcome.reason === 'fault') {
        flashFault(engine!.lastFault ?? 'worker 异常');
      }
    })
    .finally(() => setBusy(false));
});

/**
 * 重置：先让旧引擎把进行中的回合作废并等到全员静止，再重写/重建。
 * 换尺寸或换 worker 数都重建引擎；保留按钮传入的初值（随机）。
 */
async function doReset(initial?: Uint8Array): Promise<void> {
  const rows = clampSide(Number(rowsInput.value));
  const cols = clampSide(Number(colsInput.value));
  const n = workerCount();
  rowsInput.value = String(rows);
  colsInput.value = String(cols);
  workersInput.value = String(n);

  auto = false;
  loopToken++;
  setBusy(true);
  try {
    if (engine && engine.rows === rows && engine.cols === cols && engine.workerCount === n) {
      await engine.reset(rows, cols, initial);
    } else {
      const old = engine;
      engine = new Engine({
        rows,
        cols,
        workerCount: n,
        initial,
        factory: webWorkerFactory,
      });
      // 旧引擎：作废可能存在的回合 → 静止 → 终止；绝不让旧线程碰到新缓冲。
      await old?.reset(rows, cols, undefined).catch(() => undefined);
      old?.dispose();
    }
    snapshot = null;
    snapshotGen = -1;
    refreshSnapshot();
    draw();
  } finally {
    setBusy(false);
  }
}

btnReset.addEventListener('click', () => void doReset(undefined));
btnRandom.addEventListener('click', () =>
  doReset(randomGrid(clampSide(Number(rowsInput.value)), clampSide(Number(colsInput.value)))),
);

// ---------- 导出：永远导出当前这份完整已提交代快照 ----------
btnExport.addEventListener('click', () => {
  refreshSnapshot();
  if (!snapshot) {
    phaseEl.textContent = '重置中，尚无完整代可导出，请稍后再试';
    return;
  }
  const lines: string[] = [
    `!Name: shared-buffer-life generation ${snapshotGen} (${snapshotRows}x${snapshotCols})`,
    `!Generation: ${snapshotGen}`,
  ];
  for (let r = 0; r < snapshotRows; r++) {
    let line = '';
    for (let c = 0; c < snapshotCols; c++) line += snapshot[r * snapshotCols + c] ? 'O' : '.';
    lines.push(`${line}$`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `life-gen${snapshotGen}-${snapshotRows}x${snapshotCols}.cells`;
  a.click();
  URL.revokeObjectURL(url);
});

btnFault.addEventListener('click', () => {
  // 注入“某个 worker 计算途中异常”：运行中作用于下一代；暂停则单独跑一次故障代。
  if (!engine) return;
  const wid = Math.floor(Math.random() * engine.workerCount);
  if (auto) {
    pendingFault = wid;
  } else if (!busy) {
    setBusy(true);
    void engine
      .step(wid)
      .then((outcome) => {
        if (outcome.status === 'aborted') flashFault(engine!.lastFault ?? 'worker 异常');
      })
      .finally(() => setBusy(false));
  }
});

// ---------- 暂停时画布编辑 ----------
let painting: 0 | 1 | null = null;

function cellFromEvent(ev: MouseEvent): [number, number] | null {
  if (!snapshot) return null;
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * snapshotCols;
  const y = ((ev.clientY - rect.top) / rect.height) * snapshotRows;
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (r < 0 || r >= snapshotRows || c < 0 || c >= snapshotCols) return null;
  return [r, c];
}

canvas.addEventListener('mousedown', (ev) => {
  if (busy || !snapshot) return;
  const rc = cellFromEvent(ev);
  if (!rc) return;
  const [r, c] = rc;
  painting = snapshot[r * snapshotCols + c] ? 0 : 1;
  engine!.setCell(r, c, painting);
  snapshotGen = -1; // 强制下一帧从已提交缓冲重建快照
});
canvas.addEventListener('mousemove', (ev) => {
  if (painting === null || !snapshot) return;
  const rc = cellFromEvent(ev);
  if (!rc) return;
  engine!.setCell(rc[0], rc[1], painting);
  snapshotGen = -1;
});
window.addEventListener('mouseup', () => (painting = null));

// ---------- 渲染循环：只读快照 ----------
function frame(): void {
  refreshSnapshot();
  draw();
  genEl.textContent = String(Math.max(0, snapshotGen));
  if (!busy) phaseEl.textContent = '已暂停 · 展示完整已提交代';
  requestAnimationFrame(frame);
}

void (async () => {
  const rows = clampSide(Number(rowsInput.value));
  const cols = clampSide(Number(colsInput.value));
  await doReset(randomGrid(rows, cols));
  requestAnimationFrame(frame);
})();
