# 共享内存生命游戏（SharedArrayBuffer × 真实 Worker）

在浏览器本地运行的二值栅格生命游戏：

- 栅格边长 16～128，行列可不等；**边界环绕（环面）**。
- 规则：每格只读**旧代**八邻域——邻居恰 3 个时新生/存活，恰 2 个时保留原值，其余清零。
- 2～4 个**真实 Worker** 分担连续行区，经 **SharedArrayBuffer** 共享同一份旧代、各写各的新代；
  消息只传缓冲句柄，**绝不传整份网格副本**，主线程**不做任何网格计算**。
- 全员完成屏障后主线程才交换缓冲并递增代号；主线程等待用非阻塞微轮询（setTimeout 节拍），
  **不使用 Atomics.wait，不会冻结界面**。
- 暂停 / 单步 / 重置 / 导出 / Worker 异常都可发生在计算途中：画面与导出永远只取一份
  **完整已提交代**；旧线程在静止屏障完成前不可能写进重置后的网格。
- 验收只看**演化结果一致性**（与单线程参考逐格相同），不以吞吐量/帧率为指标。

## 快速开始

```bash
npm install
npm run dev      # 开发服务器（已自动配置 COOP/COEP 隔离头）
# 或
npm run build && npm run preview
```

打开页面后若环境不支持共享内存，会显示**明确的错误横幅**（缺少 `crossOriginIsolated` 等），
不会偷偷退化成单线程实现。

### 必需的隔离头

SharedArrayBuffer 要求跨源隔离，响应必须带：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- `npm run dev` / `npm run preview` 已在 `vite.config.ts` 配置好，文档与 Worker 资源都会带上。
- 用其它静态服务器（nginx / Caddy / CDN）部署时，请自行为**所有响应**（含 Worker 脚本）
  加上这两个头。示例：

  ```nginx
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "require-corp" always;
  ```

  ```caddy
  header Cross-Origin-Opener-Policy same-origin
  header Cross-Origin-Embedder-Policy require-corp
  ```

## 操作

- **▶ 运行 / ⏸ 暂停**：暂停只影响“是否排下一代”，已经在算的那一代一定会完整提交。
- **⏭ 单步**：精确推进一步。
- **⟲ 重置 / 🎲 随机初值并重置**：可改行列与 Worker 数；计算途中也可安全重置。
- **⬇ 导出当前代**：导出 `.cells` 文本（O/. 行 + `$`），始终是完整已提交代；
  若此刻没有完整代（计算/重置中），不会导出半成品。
- **💥 注入 Worker 异常**：让某个 Worker 写完半区行后抛出异常并自毁，演示
  “回合作废 → 全员静止 → 补员 → 代号不变继续演化”。
- 暂停时可在画布上点击/拖动编辑活格。

## 并发协议（为什么是一致的）

单块 `Int32Array` 控制块 + 两块 `Uint8Array` 网格缓冲（A/B 双缓冲）。

- **发布**：主线程先在 `PHASE=IDLE` 下清零回合计数、写好参数，最后才置 `RUNNING` 并 notify，
  Worker 不可能读到半初始化回合。
- **计算**：每个 Worker 加入时置 `COMPUTING` 并 `ACCEPT++`，只从 `cur` 读、只写 `other`
  的自己行区；写完 `DONE++`，落终态 `PARKED` 并 `ACK++`。
- **提交屏障**：仅当 `DONE == ACCEPT == nWorkers` 且仍是 `RUNNING`，主线程才清零计数、
  交换 `cur`、`GEN++`、置 `IDLE`。之后 Worker 才可能把新代当旧代读。
- **异常**：Worker 先置 `DEAD`/`ACK`（共享内存里的事实）再上报并自毁；主线程置 `ABORTING`
  广播唤醒所有挡在闸门后的线程，等 `ACK == nWorkers`（全员静止）后才用**同尺寸缓冲补员**。
  `cur` 未交换，半区残留在 `other` 里不可见，代号不变。
- **重置**：进行中先作废并等静止；静止前绝不重写或释放缓冲。同尺寸复用缓冲（所有旧 Worker
  的回合号都已更新，醒来只睡等下一回合），换尺寸则先 `terminate()` 全部旧线程再重建。
- **迟到消息**：Worker 只加入“自己没参与过的新回合”（`round > lastSeen`）；每次闸门醒来都
  重检 `PHASE/ROUND`，迟到的旧闸门通知、迟到的 fatal 都无法让它写任何字节。补员 Worker
  以作废回合号作为 `lastSeen` 启动，不会重跑已结束回合。
- **绘制/导出**：只在 `PHASE=IDLE` 时取 `cur`；进行中界面保留上一份已提交代快照。

## 测试

```bash
npm test
```

两层测试，均与 `stepReference` 单线程参考实现逐格比较：

1. **可控交错（确定性）** `test/engine.determinism.test.ts`
   假 Worker 是同进程协程，跑与真实 Worker 完全相同的 `workerLoop`，等待原语替换为
   FIFO 微任务队列，闸门（`GATE.BARRIER` / `BARRIER_AND_COMMIT`）可逐张放行，交错严格可复现。
   覆盖：2/3/4 Worker 多代一致、最后一个线程未完成绝不提交、全部行区算完未放行不交换、
   乱序/倒序放行票、Worker 写半区后异常、异常恢复后逐代一致、闸前线程遇异常不写一格、
   作废后旧闸门通知迟到、补员 Worker 带旧 round 启动、计算途中同尺寸/换尺寸重置、
   进行中导出为 null、编辑后演化。
2. **真实 Worker 冒烟** `test/real-workers.smoke.test.ts`
   用 esbuild 打包 `src/node-worker.ts`，由 Node `worker_threads` 拉起 2/3/4 个真线程，
   经真实的 SAB + Atomics.wait/notify 端到端运行，比较多代结果、故障恢复与途中重置。

## 目录

```
src/protocol.ts    控制块布局、常量、行区划分、邻域更新（Worker 与参考实现共用）
src/worker-core.ts Worker 回合状态机（浏览器 Worker 与 node worker_threads 共用）
src/web-worker.ts  浏览器 Worker 入口（Atomics.wait）
src/node-worker.ts Node worker_threads 入口（冒烟测试用）
src/engine.ts      主线程引擎：发布/提交屏障/作废静止/补员/重置，全部非阻塞等待
src/web-factory.ts 浏览器 Worker 工厂
src/main.ts        Canvas、控件、快照绘制与导出
test/              确定性交错测试 + 真实线程冒烟
```
