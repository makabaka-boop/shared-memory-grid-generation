/**
 * main.ts — 浏览器入口：Canvas 渲染 + UI + rAF 驱动的 tick。
 * 主线程只调度与绘制，从不计算格子；从不 Atomics.wait。
 */
import { Coordinator } from './coordinator.js';
import { randomGrid } from './life-core.js';
import { MIN_DIM, MAX_DIM, clampDim, clampWorkers } from './protocol.js';
// ------------------------------------------------------------ 能力检测：不偷偷回退单线程
function fatal(message) {
    const el = document.getElementById('fatal');
    el.textContent = message;
    el.style.display = 'flex';
    throw new Error(message);
}
if (typeof SharedArrayBuffer === 'undefined') {
    fatal('当前环境不支持 SharedArrayBuffer，无法运行多线程版本（本应用不会回退到单线程）。\n' +
        '原因通常是页面缺少跨源隔离响应头。请通过提供了以下响应头的服务访问：\n' +
        '  Cross-Origin-Opener-Policy: same-origin\n' +
        '  Cross-Origin-Embedder-Policy: require-corp\n' +
        '（例如项目自带的 server.mjs，且需通过 localhost 或 HTTPS 访问。）');
}
try {
    new SharedArrayBuffer(8);
}
catch {
    fatal('SharedArrayBuffer 构造被阻止：页面未处于跨源隔离状态（crossOriginIsolated=false）。\n' +
        '请确认服务器返回 COOP: same-origin 与 COEP: require-corp 响应头，并使用 localhost 或 HTTPS。\n' +
        '本应用不会回退到单线程模式。');
}
if (typeof Worker === 'undefined') {
    fatal('当前浏览器不支持 Web Worker，无法运行。');
}
// ------------------------------------------------------------ UI 元素
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx2d = canvas.getContext('2d');
const btnToggle = $('toggle');
const btnStep = $('step');
const btnReset = $('reset');
const btnExport = $('export');
const inRows = $('rows');
const inCols = $('cols');
const inWorkers = $('workers');
const inSpeed = $('speed');
const speedLabel = $('speed-label');
const statusEl = $('status');
const workersEl = $('workers-status');
// ------------------------------------------------------------ 模拟器装配
let coord;
function makeSpawn() {
    return (id, sink, sab) => {
        const w = new Worker('./worker.js', { type: 'module' });
        w.onmessage = (e) => sink.onMessage(id, e.data);
        w.onerror = (e) => sink.onError(id, e.message ?? '未知错误');
        w.postMessage({ type: 'init', sab, workerId: id });
        return { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
    };
}
function readConfig() {
    return {
        rows: clampDim(Number(inRows.value)),
        cols: clampDim(Number(inCols.value)),
        numWorkers: clampWorkers(Number(inWorkers.value)),
        genIntervalMs: 1000 / Number(inSpeed.value),
    };
}
function newCoordinator() {
    coord?.dispose();
    const cfg = readConfig();
    coord = new Coordinator({
        rows: cfg.rows,
        cols: cfg.cols,
        numWorkers: cfg.numWorkers,
        initial: randomGrid(cfg.rows, cfg.cols, 0.28, (Math.random() * 2 ** 31) | 0),
        spawn: makeSpawn(),
        genIntervalMs: cfg.genIntervalMs,
        workerTimeoutMs: 5000,
    });
    offscreen = null; // 尺寸可能变了，重建离屏画布
    lastDrawnGen = -1;
}
// ------------------------------------------------------------ 渲染
let offscreen = null;
let lastDrawnGen = -1;
function draw() {
    const { rows, cols } = coord.size;
    if (!offscreen || offscreen.img.width !== cols || offscreen.img.height !== rows) {
        const c = document.createElement('canvas');
        c.width = cols;
        c.height = rows;
        const cx = c.getContext('2d');
        offscreen = { canvas: c, ctx: cx, img: cx.createImageData(cols, rows) };
    }
    const grid = coord.committedGrid(); // 只读已提交代
    const data = offscreen.img.data;
    for (let i = 0; i < rows * cols; i++) {
        const on = grid[i] === 1;
        const o = i * 4;
        data[o] = on ? 0x3c : 0x10;
        data[o + 1] = on ? 0xff : 0x14;
        data[o + 2] = on ? 0x9e : 0x1e;
        data[o + 3] = 255;
    }
    offscreen.ctx.putImageData(offscreen.img, 0, 0);
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(offscreen.canvas, 0, 0, canvas.width, canvas.height);
}
const STATE_TEXT = {
    running: '运行中', paused: '已暂停', resetting: '重置中…', error: '错误', disposed: '已销毁',
};
function updateStatus() {
    const st = coord.state;
    statusEl.textContent =
        `状态：${STATE_TEXT[st]}　代数：${coord.generation}　纪元：${coord.currentEpoch}` +
            (coord.error ? `　⚠ ${coord.error}` : '');
    const ws = coord.workerStatus();
    workersEl.textContent = ws
        .map((w, i) => `W${i}: ${w.dead ? '崩溃' : w.ready ? '就绪' : '启动中'} / 完成任务 ${w.lastDone}`)
        .join('　');
    btnToggle.textContent = st === 'running' ? '暂停' : '开始';
    btnStep.disabled = st === 'running' || st === 'error' || st === 'resetting';
    btnToggle.disabled = st === 'error' || st === 'resetting';
}
function frame() {
    coord.tick(); // 非阻塞：观察屏障、提交、按需派发
    if (coord.generation !== lastDrawnGen) {
        draw();
        lastDrawnGen = coord.generation;
    }
    updateStatus();
    requestAnimationFrame(frame);
}
// ------------------------------------------------------------ 交互
btnToggle.onclick = () => {
    if (coord.state === 'running')
        coord.pause();
    else
        coord.start();
};
btnStep.onclick = () => coord.step();
btnReset.onclick = () => {
    const cfg = readConfig();
    const cur = coord.size;
    const workersNow = coord.workerStatus().length;
    if (cfg.rows !== cur.rows || cfg.cols !== cur.cols || cfg.numWorkers !== workersNow) {
        newCoordinator(); // 尺寸或线程数变化：整体重建
    }
    else {
        coord.requestReset(randomGrid(cfg.rows, cfg.cols, 0.28, (Math.random() * 2 ** 31) | 0), cfg.rows, cfg.cols);
    }
};
inSpeed.oninput = () => {
    speedLabel.textContent = `${inSpeed.value} 代/秒`;
    coord.setGenInterval(1000 / Number(inSpeed.value));
};
btnExport.onclick = () => {
    const view = coord.exportView(); // 一定是一份完整已提交代
    const scale = Math.max(1, Math.floor(1024 / Math.max(view.rows, view.cols)));
    const c = document.createElement('canvas');
    c.width = view.cols * scale;
    c.height = view.rows * scale;
    const cx = c.getContext('2d');
    const img = cx.createImageData(view.cols, view.rows);
    for (let i = 0; i < view.cells.length; i++) {
        const on = view.cells[i] === 1;
        img.data[i * 4] = on ? 0x3c : 0x10;
        img.data[i * 4 + 1] = on ? 0xff : 0x14;
        img.data[i * 4 + 2] = on ? 0x9e : 0x1e;
        img.data[i * 4 + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = view.cols;
    tmp.height = view.rows;
    tmp.getContext('2d').putImageData(img, 0, 0);
    cx.imageSmoothingEnabled = false;
    cx.drawImage(tmp, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
        if (!blob)
            return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `life-gen-${view.generation}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
};
// ------------------------------------------------------------ 启动
inRows.min = inCols.min = String(MIN_DIM);
inRows.max = inCols.max = String(MAX_DIM);
speedLabel.textContent = `${inSpeed.value} 代/秒`;
newCoordinator();
requestAnimationFrame(frame);
