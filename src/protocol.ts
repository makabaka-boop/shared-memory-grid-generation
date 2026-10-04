/**
 * 主线程与所有 Worker 共享的协议层。
 *
 * 内存布局：
 *  - 一块 Int32 SharedArrayBuffer（控制块）：代号、阶段、屏障计数、每个 Worker 一个状态槽。
 *  - 两块 Uint8 SharedArrayBuffer（gridA / gridB）：交替作为旧代/新代。
 *
 * 设计约束：
 *  - 每代发布时 era 与 round 同时 +1；Worker 只在 era/round 与自己上次离开的回合不同且
 *    phase ∈ {RUNNING, RESETTING} 时“加入”该回合，加入后用本地快照识别过期唤醒。
 *  - 所有加入者恰有一个终态 ack（PARKED 或 DEAD），主线程据此判定“旧线程全部停止”。
 *  - 只有等全部加入者停手（静止）后才允许复用/清零缓冲或重建网格，杜绝旧线程写进新网格。
 */

export const MIN_WORKERS = 2;
export const MAX_WORKERS = 4;
export const MIN_SIDE = 16;
export const MAX_SIDE = 128;

/** 主线程发布的回合阶段（存放在 OFF.PHASE）。 */
export const PHASE = {
  /** 无活动回合：当前 cur 缓冲为完整已提交代，可绘制/导出/改格。 */
  IDLE: 0,
  /** 一代演化进行中：Worker 从 cur 读、写 other。 */
  RUNNING: 1,
  /** 本回合作废（异常或重置）：所有加入者立即停手并把槽位置 PARKED。 */
  ABORTING: 2,
  /** 作废回合已静止，正在把新尺寸/初值写进两块缓冲并换入新 Worker 池。 */
  RESETTING: 3,
} as const;

/** 每个 Worker 状态槽中存的状态（槽偏移 = stateBase + id*STRIDE + STATUS）。 */
export const STATE = {
  /** 已离开上一回合，Atomics.wait 在 phase 上等待新回合。 */
  PARKED: 0,
  /** 正在执行本回合（算格 / 被闸门挡住）。 */
  COMPUTING: 1,
  /** 已死亡（异常），槽位作废；该槽以后不会再动。 */
  DEAD: 2,
} as const;

/** 测试用可控交错闸门模式（仅 gated 测试回合使用）。 */
export const GATE = {
  /** 无闸门，正常运行。 */
  NONE: 0,
  /** 每个 Worker 开算前必须领取到达票；主线程逐个放行，制造任意交错。 */
  BARRIER: 1,
  /** 同上，且算完自己行区后还要再过一道“提交闸门”。 */
  BARRIER_AND_COMMIT: 2,
} as const;

/** 控制块内的字段偏移（Int32 单位）。 */
export const OFF = {
  ERA: 0,
  ROUND: 1,
  PHASE: 2,
  NWORKERS: 3,
  ROWS: 4,
  COLS: 5,
  GEN: 6,
  CUR: 7, // 0=gridA 为当前已提交代，1=gridB
  FAULT_WID: 8, // 触发异常的 Worker 编号，-1 表示本回合无异常
  GATE_MODE: 9,
  GATE_ARRIVED: 10, // 开算前到达计数
  GATE_PASS: 11, // 已被放行的最大票数
  GATE_RELEASED: 12, // 第二道闸放行阈值（已被放行的最大票数）
  FAULT_AT: 13, // >=0 时，拥有该行区起点的 Worker 开算后抛异常
  ACCEPT: 14, // 本回合加入者计数
  DONE: 15, // 已正常走到“行区完成”的加入者计数
  ACK: 16, // 已落终态（PARKED 或 DEAD）的加入者计数
  STATE_BASE: 17,
} as const;

/** 每个 Worker 状态槽占 2 个 Int32：[状态, 该槽最后见到的回合号]。 */
export const STRIDE = 2;
export const STATUS = 0;
export const SEEN = 1;

/** 单个 Worker 状态槽占 2 个 Int32。 */
export function controlWords(maxWorkers: number): number {
  return OFF.STATE_BASE + maxWorkers * STRIDE;
}

export function createControl(maxWorkers: number): {
  buf: SharedArrayBuffer;
  view: Int32Array;
} {
  const buf = new SharedArrayBuffer(controlWords(maxWorkers) * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buf);
  view[OFF.ROUND] = 0;
  view[OFF.PHASE] = PHASE.IDLE;
  view[OFF.CUR] = 0;
  view[OFF.GEN] = 0;
  view[OFF.FAULT_WID] = -1;
  for (let id = 0; id < maxWorkers; id++) {
    const base = OFF.STATE_BASE + id * STRIDE;
    view[base + STATUS] = STATE.PARKED;
    view[base + SEEN] = 0;
  }
  return { buf, view };
}

export function createGrid(rows: number, cols: number): SharedArrayBuffer {
  if (rows < MIN_SIDE || rows > MAX_SIDE || cols < MIN_SIDE || cols > MAX_SIDE) {
    throw new Error(`栅格边长必须在 ${MIN_SIDE}～${MAX_SIDE} 之间`);
  }
  return new SharedArrayBuffer(rows * cols);
}

export function gridView(buf: SharedArrayBuffer, rows: number, cols: number): Uint8Array {
  const v = new Uint8Array(buf);
  if (v.length !== rows * cols) throw new Error('网格尺寸与缓冲不匹配');
  return v;
}

export function stateSlot(id: number): number {
  return OFF.STATE_BASE + id * STRIDE;
}

/** 主线程 → Worker 的初始化消息（仅启动时传递元数据与缓冲，从不传整份网格副本）。 */
export interface BootMessage {
  type: 'boot';
  id: number;
  control: SharedArrayBuffer;
  gridA: SharedArrayBuffer;
  gridB: SharedArrayBuffer;
  maxWorkers: number;
  /** 该 Worker 的“上次已见回合”：补员/重建时保证不会误加入已结束的旧回合。 */
  round: number;
}

/** Worker → 主线程消息。 */
export type WorkerMessage =
  | { type: 'ready'; id: number }
  | { type: 'fatal'; id: number; error: string };

/** 把 Worker id 的行区 [rowStart, rowEnd) 按行平均切成连续区间。 */
export function rowRange(id: number, nWorkers: number, rows: number): [number, number] {
  const base = Math.floor((rows * id) / nWorkers);
  const end = Math.floor((rows * (id + 1)) / nWorkers);
  return [base, end];
}

/**
 * 在旧代上更新一片行区到新代（环面边界）。
 * 纯函数式写法：只从 src 读、只写 dst 的 [rowStart,rowEnd)，供 Worker 与单线程参考共用。
 */
export function stepRegion(
  src: Uint8Array,
  dst: Uint8Array,
  rows: number,
  cols: number,
  rowStart: number,
  rowEnd: number,
): void {
  for (let r = rowStart; r < rowEnd; r++) {
    const up = (r - 1 + rows) % rows;
    const down = (r + 1) % rows;
    const rOff = r * cols;
    const uOff = up * cols;
    const dOff = down * cols;
    for (let c = 0; c < cols; c++) {
      const left = (c - 1 + cols) % cols;
      const right = (c + 1) % cols;
      const n =
        src[uOff + left] + src[uOff + c] + src[uOff + right] +
        src[rOff + left] + src[rOff + right] +
        src[dOff + left] + src[dOff + c] + src[dOff + right];
      // 邻居恰三：存活/新生；恰二：保留原值；其余清零。
      dst[rOff + c] = n === 3 ? 1 : n === 2 ? src[rOff + c] : 0;
    }
  }
}

/** 单线程参考实现：整块代换，返回 dst。 */
export function stepReference(
  src: Uint8Array,
  dst: Uint8Array,
  rows: number,
  cols: number,
): Uint8Array {
  stepRegion(src, dst, rows, cols, 0, rows);
  return dst;
}
