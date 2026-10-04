# 共享内存多线程生命游戏（sab-life）

在浏览器本地运行的 Conway 生命游戏：16～128 行列二值栅格、边界环绕，
规则为「邻居恰三存活、恰二保留原值、其余清零」。
计算由 **2～4 个真实 Web Worker** 通过 **SharedArrayBuffer** 分担行区完成，
主线程只调度与绘制，**从不计算格子、从不阻塞等待**。

## 运行

```bash
npm install        # 仅需 typescript（开发依赖）
npm run build      # 编译 TS → public/*.js
npm start          # http://localhost:8080 （自带 COOP/COEP 隔离头）
npm test           # 编译并运行全部测试（node:test，含真实 Worker 冒烟）
```

## 部署：跨源隔离头是硬要求

`SharedArrayBuffer` 只在跨源隔离上下文中可用，响应必须带：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`server.mjs` 已附带这两个头（另加 `Cross-Origin-Resource-Policy: same-origin`）。
换用其它静态服务器/托管平台时自行配置等价响应头，例如 nginx：

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

页面打开时会检测能力：`SharedArrayBuffer` 不存在或构造被阻止时，
显示明确说明（缺隔离头、需 localhost/HTTPS），**不会偷偷回退单线程**。

## 架构

```
src/
  protocol.ts     共享内存布局与控制协议（控制块槽位、消息类型）
  life-core.ts    规则内核：computeRow/computeSlice/referenceStep，纯函数
  worker-core.ts  Worker 单步协议逻辑（真实 Worker 与可控交错测试共用）
  worker.ts       真实 Worker 入口（浏览器 module worker / Node worker_threads）
  coordinator.ts  主线程调度器（环境无关，浏览器与 Node 测试共用）
  main.ts         浏览器 UI：Canvas 渲染、rAF 驱动 tick、能力检测
server.mjs        零依赖静态服务器（附隔离头）
test/             node:test 测试
```

### 共享内存布局（单个 SharedArrayBuffer）

| 区域 | 内容 |
|---|---|
| 控制块（128B，Int32 视图） | `SEQ` 唤醒序号、`EPOCH` 纪元号、`TASK_GEN` 单调任务号、`DONE_COUNT` 屏障计数、`READ_INDEX` 双缓冲下标、`GENERATION` 已提交代数、`ROWS/COLS/NUM_WORKERS`、`ERROR`、`EPOCH_TASK_BASE`、每 Worker 一个 `ACK` 槽 |
| 网格缓冲 0 / 1（各 16KB） | 双缓冲的 0/1 栅格，按 `rows*cols` 使用 |

### 代际推进与完成屏障

1. 主线程按节拍（或单步请求）写 `TASK_GEN++` 并 `Atomics.add(SEQ)+notify` 派发任务；
2. 每个 Worker 唤醒后只读 `grids[READ_INDEX]`（旧代），只写另一缓冲中自己的
   连续行区 `[⌊i·rows/W⌋, ⌊(i+1)·rows/W⌋)`，算完 `DONE_COUNT+1`；
3. 主线程在 `tick()`（由 rAF 驱动，**非阻塞**）中观察到
   `DONE_COUNT === NUM_WORKERS`（完成屏障）后，才翻转 `READ_INDEX`、
   `GENERATION++` —— 画面与导出永远只读 `READ_INDEX` 指向的**完整已提交代**；
4. 网格数据从不走 postMessage；消息只有 `ready/done/error` 小通知，
   且一律以共享计数器为准——**迟到的旧代消息直接忽略**。

### 计算途中的暂停 / 单步 / 重置 / 异常

- **暂停/单步**：只是停止/放行派发；在飞的一代照常完成并提交（它是完整的）。
- **重置（可在计算途中）**：主线程 `EPOCH+1`（并先把旧纪元最后一个任务号写入
  `EPOCH_TASK_BASE`），Worker 每行计算前检查 `EPOCH`，发现变化立即放弃旧工作、
  写自己的 `ACK` 槽；**全部 ACK 之后**主线程才写入新图案。
  旧线程的任何迟到写入都发生在其 ACK 之前，必然被重置覆盖；
  已 ACK 的 Worker 不会执行 `TASK_GEN ≤ EPOCH_TASK_BASE` 的旧任务，
  其迟到的 `DONE+1` 也必然先于 ACK 被观察到、随重置清零——旧线程写不进重置后的网格。
- **Worker 异常**：Worker 内 try/catch 上报（`ERROR` 槽 + error 消息）或硬崩溃
  （`onerror`）都会使系统进入错误态：停止派发、**不提交残缺代**、画面停留在
  最后一份已提交代；重置可恢复（硬崩溃的 Worker 会被替换重生）。
- **超时**：派发或重置确认超过 `workerTimeoutMs` 未完成 → 错误态。

## 测试

```
npm test
```

- `test/core.test.mjs` — 规则正确性：静物/振荡器/滑翔者环面回归、
  环绕边界出生，以及 **2/3/4 段切片结果与单线程参考逐格一致**（含非整除行数）。
- `test/coordinator.test.mjs` — **可控交错**：用与真实 Worker 完全相同的
  `workerStep` 协议代码手动驱动假 Worker，精确重演：
  最后一个线程尚未完成（不提交、不换缓冲）、计算途中重置（旧线程迟到写入/
  迟到 DONE 不污染新网格）、异常中止（不提交残缺代、重置恢复）、
  Worker 硬崩溃重生、完成/确认超时、暂停/单步/节拍、旧代消息迟到被忽略。
- `test/smoke.test.mjs` — **真实 Worker 冒烟**：Node `worker_threads`
  跑编译后的 `worker.js`（真线程、真 SAB、真 `Atomics.wait`），
  2/3/4 线程推进多代与单线程参考逐格一致；连续运行中重置后继续演化仍一致。

测试只断言**一致性与正确性**，不以吞吐量或帧率为验收指标。
