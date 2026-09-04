# 简化：轨迹接口的展示类型移进 src/lib/，客户端不再手抄一份

状态: done

## 问题

`src/app/runs/lib.ts:183-248`（66 行）是 `src/server/harness/trajectory.ts:24-84`（61 行）的**手抄副本**：

```
$ diff <(sed -n '183,248p' src/app/runs/lib.ts) <(sed -n '24,84p' src/server/harness/trajectory.ts)
1d0    < /** GET /api/runs/[id]/nodes/[nodeId]/trajectory 的详情片段。 */
17d15  < /** 一条会话轨迹记录；startedAt / finishedAt 同时供三泳道时间条投影。 */
35a34  > export type TrajectorySessionStatus = "running" | "completed" | …（服务端多一个具名别名）
39,47c47  （客户端把同一个 union 内联在 TrajectorySession.status 上）
```

除两条中文注释与那个具名别名外，`TrajectoryDetail` / `TrajectoryUsage` / `TrajectoryRecord` /
`TrajectorySession` / `AgentTrajectoryResponse` **五个声明逐字相同**。

**生产消费者：** 客户端那份——`src/app/runs/[id]/agent-trajectory.tsx:9,11,12,13`，以及该文件
`:16,25,34,43,54,66,73,82,148,158,171,241,337,366,446` 处的使用；服务端那份——
`src/server/harness/trajectory.ts` 自身与 `src/app/api/runs/[id]/nodes/[nodeId]/trajectory/route.ts`。

**测试 / 文档消费者：** `docs/DESIGN.md:44` 只描述端点语义，不落 TS 形状；
`rg -l "TrajectoryRecord" docs README.md AGENTS.md .github` → 无命中。`scripts/run-resume.ts:91-105`
另有一份**刻意收窄**的子集（只留 `kind` / `state` / `toolName` / `details`），那不是重复，是「只取我要的」。

**打败了哪条已记录的理由：** `AGENTS.md:145` 允许「`import type` from `@/server/monitor/types`」这一处
例外，其余一律禁止，`src/rules.test.ts:108,140-160` 机械执行。所以客户端**确实不能**直接 `import type`
服务端的轨迹类型——手抄是这条规则逼出来的。但规则的前提是「除服务端就没有第三个家」，而这个前提今天已
不成立：`src/lib/` 正是纯、无 DB、两侧都能 import 的那一层，`src/lib/run-graph.ts` 就是现成先例——
`src/server/engine/runner.ts:27` 与 `src/app/runs/lib.ts:5` / `use-run-stream.ts:17` / `visuals-at.ts:27` /
`run-canvas.tsx:27` 同时 import 它，`AGENTS.md:33-35` 把它记为「the shape frozen into runs.graph」。轨迹
响应是同一类东西：一份两侧共知的 DTO。

## 提议

新增 `src/lib/trajectory-view.ts`，把上述五个声明搬进去（保留服务端的 `TrajectorySessionStatus` 具名
别名，客户端一并受益）。`src/server/harness/trajectory.ts` 改为
`export type { … } from "@/lib/trajectory-view"`（或直接 import 后使用），`src/app/runs/lib.ts:183-248`
整段删除、改 re-export，`agent-trajectory.tsx` 的 import 可保持不变（仍从 `../lib` 取）。

连带要改：`AGENTS.md:33-35` 的 `src/lib/` 行加一句「`trajectory-view.ts`（轨迹接口的展示 DTO，服务端投影
与运行页抽屉共用）」；`docs/DESIGN.md:44` 那行加半句指向新模块（可选）；`src/rules.test.ts` **不需要改**
（新路径是 `@/lib/`，本来就不在 `SERVER_SPECIFIER` 的禁令里）；`.github/REVIEW.md` 无需改；
`scripts/run-resume.ts:91-105` 可选地改成 import 真类型（会让那份付费验收脚本对形状漂移更敏感），不改也
不阻塞。

## 放弃了什么

服务端独立演进轨迹投影内部形状的自由：今天它可以改 `TrajectoryRecord` 而只在自己文件里改；搬到
`src/lib/` 后，改它就是改一份两侧共有的契约（这正是想要的，但也意味着服务端多一层顾虑）。以及「轨迹类型
跟着读日志的实现走」这条局部性。

## 验收

`npm run check`、`npm run build`；`npx vitest run src/rules.test.ts`（确认客户端 / 服务端边界断言仍绿）；
`npx playwright test e2e/runs.spec.ts`——它自建带真实会话 JSONL 的运行夹具并断言抽屉里轨迹面板可检索，是
这条接口唯一的端到端落点。

**harness 接缝的证据：** 本条**不碰** harness 接缝的行为。`src/server/harness/trajectory.ts` 里被搬走的
只有第 24-84 行五条纯类型声明，`readAgentTrajectory` 与 `ReadAgentTrajectoryOptions`（含 `runsRoot` /
`skillNames`）以及全部读 JSONL 的实现一行不动；`runtime.ts` / `rpc/server.ts` / `engine/action.ts` 三个头
注释覆盖的会话、事件、用量、取消行为完全未触及。类型搬家在运行时被完全擦除，子进程与 RPC 协议无变化，
因此**不需要付费冒烟**；PR 描述里按 `AGENTS.md`「The harness seam」写明这一点。若评审仍要求，
`npx tsx scripts/smoke-harness.ts` 即可覆盖。

## 风险

低。纯类型搬家，零运行时字节变化。唯一风险是 `src/lib/` 不得引入服务端依赖——被搬的五个声明不 import
任何东西（`TrajectoryRecord` 只依赖同文件的 `TrajectoryDetail` / `TrajectoryUsage`），
`src/server/harness/trajectory.ts:11-23` 的 `@deepseek-ai/*` 与 `@/server/fs-safety` 全部服务于实现部分，
不在被搬的区间里。

预估净删约 65 行；风险等级：低。

## 落地

PR: https://github.com/TonQiaN/onto-flow/pull/32

**与提议的差异：** 无。五个声明（含服务端的 `TrajectorySessionStatus` 具名别名）搬进
`src/lib/trajectory-view.ts`，`src/server/harness/trajectory.ts` 与 `src/app/runs/lib.ts` 各改成从它
`export type { … } from`；`agent-trajectory.tsx` 的 import 未动（仍从 `../lib` 取）。记录里标「可选」的两处：
`docs/DESIGN.md:44` 那行**做了**（加半句指向新模块），`scripts/run-resume.ts:91-105` 那份刻意收窄的子集
**未动**（记录已判定它不是重复）。`src/rules.test.ts` 与 `.github/REVIEW.md` 现场 `rg` 复核后确认无需改：
新路径是 `@/lib/`，不在 `SERVER_SPECIFIER` 的禁令里，REVIEW.md 也没有一行陈述这些类型的落脚点。

**验收实际跑了什么：**

- `npm run check`（typecheck + lint + fmt:check + vitest）：绿，46 个测试文件 / 387 通过 1 跳过。
- `npm run build`：绿（触及 `src/app/`）。
- `npx vitest run src/rules.test.ts`：绿（客户端 / 服务端边界断言与记录树骨架）。
- `npx playwright test e2e/runs.spec.ts`（工作树自建 `data/ontoflow.db`，独立端口）：9 passed，含
  「点节点开抽屉：每个 Action 按需展示独立、可检索的会话轨迹」与「抽屉读光标所在那一轮」。
- 付费冒烟：未跑。按记录「harness 接缝的证据」段——搬走的只有五条纯类型声明，`readAgentTrajectory`
  与全部读 JSONL 的实现一行未动，类型在运行时被完全擦除，子进程与 RPC 协议无变化。
