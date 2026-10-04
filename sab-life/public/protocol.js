/**
 * protocol.ts — 主线程与 Worker 之间的共享内存协议定义。
 *
 * 布局（单个 SharedArrayBuffer）：
 *   [0, HEADER_BYTES)            控制块，Int32 视图，槽位见 CTRL
 *   [HEADER_BYTES, +GRID_BYTES)  网格缓冲 0
 *   [..., +GRID_BYTES)           网格缓冲 1
 *
 * 两个网格缓冲双缓冲使用：READ_INDEX 指向"已提交"的旧代，
 * 所有 Worker 只读旧代、只写另一个缓冲中属于自己的行区间。
 * 主线程观察到 DONE_COUNT === NUM_WORKERS（完成屏障）后，
 * 才翻转 READ_INDEX 并递增 GENERATION —— 画面/导出只能读到完整已提交代。
 *
 * 网格数据从不通过 postMessage 传输；消息只承载极小的控制/通知信息，
 * 且一律以共享内存中的计数器为准（迟到的旧代消息直接忽略）。
 */
export const MIN_DIM = 16;
export const MAX_DIM = 128;
export const MIN_WORKERS = 2;
export const MAX_WORKERS = 4;
/** 控制块槽位（Int32 下标） */
export const CTRL = {
    /** 单调递增的唤醒序号：主线程 bump + notify 唤醒所有 Worker */
    SEQ: 0,
    /** 纪元号：每次重置 +1。Worker 发现 EPOCH 变化必须放弃手头工作并确认（ack） */
    EPOCH: 1,
    /** 当前在计算的任务（代）号，单调递增，跨 epoch 不复位，避免旧 Worker 的 myLastTask 碰撞 */
    TASK_GEN: 2,
    /** 已完成当前 TASK_GEN 的 Worker 数（完成屏障计数器） */
    DONE_COUNT: 3,
    /** 哪个网格缓冲保存着"已提交"的当前代（0/1） */
    READ_INDEX: 4,
    /** 已提交代数（展示用，重置时归零；与 TASK_GEN 无关） */
    GENERATION: 5,
    ROWS: 6,
    COLS: 7,
    NUM_WORKERS: 8,
    /** 非 0 表示某个 Worker 报告了异常（值为 workerId + 1） */
    ERROR: 9,
    /** 当前 epoch 起始时的任务号：TASK_GEN ≤ 此值的任务属于旧 epoch，Worker 不得执行 */
    EPOCH_TASK_BASE: 10,
    /** 每个 Worker 一个槽：它已确认的 epoch 号。ACK_BASE + workerId */
    ACK_BASE: 16,
    /** 控制块总槽数 */
    SIZE: 32,
};
export const HEADER_BYTES = CTRL.SIZE * 4;
export const GRID_BYTES = MAX_DIM * MAX_DIM;
export const TOTAL_BYTES = HEADER_BYTES + 2 * GRID_BYTES;
export function controlView(sab) {
    return new Int32Array(sab, 0, CTRL.SIZE);
}
/** 返回第 index 个网格缓冲的视图。网格按 rows*cols 使用，其余字节闲置。 */
export function gridView(sab, index) {
    return new Uint8Array(sab, HEADER_BYTES + (index & 1) * GRID_BYTES, GRID_BYTES);
}
export function clampDim(n) {
    return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.floor(n) || MIN_DIM));
}
export function clampWorkers(n) {
    return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.floor(n) || MIN_WORKERS));
}
