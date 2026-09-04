# 简化：删掉无人引用的 undici 依赖与文档里点名的 opencode 时代幽灵

状态: done

## 问题

（`undici` 在领域 ① harness、② 写入器、④ 脚本与测试各报了一次；`longHaulFetch` 幽灵在 ①④⑤ 各报了一次。
合并为这一份。）

**① `undici` 依赖零消费者。** `package.json:101` 有 `"undici": "^6.28.0"`（`dependencies`，不是 dev）。

```
$ rg -n "setGlobalDispatcher|ProxyAgent|undici|Dispatcher" src scripts e2e drizzle.config.ts
（无输出）
$ node -e '…遍历 package-lock.json 的每个包声明…'
 -> ^6.28.0          # 只有根 package.json 自己声明；没有任何包依赖它
```

`next.config.ts` 的 `serverExternalPackages` 里也没有它。`npm run knip` 报的**唯一一条「Unused
dependencies」就是它**，是真阳性。`git log -S'"undici"' -- package.json` 只有一条命中
（`6278261 Rename FlowForge to OntoFlow…`），它是 opencode 时代 HTTP 客户端 `longHaulFetch` 留下的。

**② `longHaulFetch` 与「每工作区事件泵」两个样板已不存在。**

```
$ rg -an "longHaulFetch" -g '!.git' .
.github/REVIEW.md:105    - [ ] 没有删掉记录「为什么要这么绕」的注释（`longHaulFetch`、每工作区事件泵、…）
AGENTS.md:205            A comment that records why a workaround exists is the rule itself — `longHaulFetch`, the per-workspace event pump, …
$ git grep -n "longHaulFetch" a329219^ -- src
src/server/opencode/server.ts:53 等五处   ← 2026-08-26 随「Replace the opencode engine with an embedded DeepSeek Harness」整个 src/server/opencode/ 一起删
$ rg -an "每工作区|per-workspace" -g '!.git' .
AGENTS.md:205
$ git grep -n "事件泵" a329219^ -- src
src/app/monitor/health/page.tsx:263  「每个执行中的节点独占一个会话与一个按工作区订阅的事件泵」
```

五个样板里剩下三个是真的：`SUM` 汇总在 `src/server/engine/action.ts:624-635`，`LIKE` 转义在
`src/server/writers/list.ts:125-129`，静默 tick 收流在 `src/app/api/runs/[id]/events/route.ts:9-15`。

**③ 同代残留的生产注释与用户可见文案。** `src/server/monitor/health.ts:122`「进程内已无**事件泵路由**」、
`:124`「注意**串行引擎**在两个节点之间有短暂无路由窗口，瞬时出现 1 条属正常」、`:151`
`reason: "进程内已无事件泵路由，疑似进程重启遗留"`（这条是页面上给运维看的文字）；
`src/server/monitor/types.ts:61` 与 `src/app/monitor/lib.ts:15,72` 沿用同一说法。今天
`listOrphanRuns`（`health.ts:126-127`）比的是 `runs.status='running'` 与
`globalThis.ontoflowRunProcesses`（`health.ts:73-78`），**一次运行一个子进程、句柄整轮存活**
（`src/server/engine/runner.ts:468,472` 才 delete），根本不存在「两个节点之间的无路由窗口」（真实存在的窗口在受理与 `launchRun` 之间，见提议）；「串行引擎」
还直接顶撞 `AGENTS.md:179`「Runs execute in parallel」与 `docs/DESIGN.md:57`「就绪节点并行、并发上限 10」。

**生产消费者：** `undici` 零；`longHaulFetch` / 每工作区事件泵所指的代码不存在；`health.ts` 的三处注释与
`reason` 字符串有生产消费者（系统健康页显示 `reason`），但它们描述的机制已不成立。
**测试 / 文档消费者：** `AGENTS.md:205`、`.github/REVIEW.md:105`；`rg -n "事件泵|无路由" e2e` 今天无结果。

**打败了哪条已记录的理由：** `find-simplifications` SKILL 第 21 行「记录了『为什么要这么绕』的注释是规则
本身，删注释不是简化」——本条删的**不是**那种注释，而是「指向已不存在的注释的引用」，以及一条记录了
**已不成立的机制**的注释；`AGENTS.md`「Editing these instructions」：delete a rule the moment the code
stops obeying it。`AGENTS.md`「Stance: no compatibility layers」覆盖 `undici`。

## 提议

- `package.json` 删 `undici` 一行，`npm install` 更新 lockfile。
- `AGENTS.md:205` 与 `.github/REVIEW.md:105` 的五例清单里删掉 `longHaulFetch` 与「每工作区事件泵」，剩三
  例（`SUM` 汇总、`LIKE` 转义、静默 tick 收流），两处**同一提交**改。
- `src/server/monitor/health.ts:122-124` 注释改写为今天的判据与**真实的**瞬时窗口：判据是
  `runs.status='running'` ∖ `ontoflowRunProcesses`；窗口不在「两个节点之间」，而在**受理与启动之间**——
  `startResolvedRun` 在受理事务里就提交了 `running` 行（`runner.ts:423`），而 `ontoflowRunProcesses` 要到
  `launchRun` 结束才登记句柄（`runner.ts:640,646`），中间建工作区、起子进程的几秒里这次运行会被判成孤儿
  （Codex 对 #28 的复审指出，首版误写成「不存在正常的瞬时孤儿」）。所以注释保留「瞬时出现属正常，持续存在
  才是真孤儿」这半句，只把机制改对；`:151` 的 `reason` 改成「进程内没有它的子进程句柄：可能刚受理尚未启动，
  或进程重启遗留」；`src/server/monitor/types.ts:61` 与 `src/app/monitor/lib.ts:15,72` 同步。备选：让判据
  同时排除 `ontoflowActiveRuns` 里的运行，窗口就真的消失——但那是改健康页的判据而非注释，留给实施 PR 决定。
- `src/rules.test.ts` 无对应断言，不需要改；CI workflow 不需要改。

## 放弃了什么

`undici` 的 `ProxyAgent` / `setGlobalDispatcher` 在将来要给出站 HTTP 加代理时用得上——真需要时
`npm i undici` 一条命令即可，Node 的全局 `fetch` 本来就是 undici。文档里失去两个历史举例的叙事色彩；将来
再出现一个「必须记注释」的绕法，要自己往列表里加。

## 验收

`npm ci && npm run check && npm run build` 全绿；`npm run knip` 的「Unused dependencies」归零；
`rg -n "longHaulFetch|每工作区|per-workspace|事件泵|串行引擎" src docs .github AGENTS.md README.md` 无结果。
`npm ci` 后跑一次 `composition-boot.test.ts`（`npm test` 已含）即为「没有 `@deepseek-ai` 传递依赖靠根
`undici` 提升解析」的证据——已核对 lockfile，没有任何包声明 `undici` 依赖。不碰四处高代价接缝
（`health.ts` 是只读聚合，不是 `cleanup.ts`）。

## 风险

低。改 `health.ts` 的 `reason` 字符串前确认没有 e2e 断言它（`rg -n "事件泵|无路由" e2e` 今天无结果）。

预估净删约 7 行 + 一条依赖（lockfile 另计）；风险等级：低。

## 落地

PR 待开。

**与提议的差异（两处）**

1. 提议只点了 `health.ts` / `types.ts` / `app/monitor/lib.ts` 三个文件里的「事件泵」，但验收那条
   `rg` 是全 `src` 的。现场还有两处：`src/app/api/runs/[id]/events/route.ts:11` 与 `:93`——它们说的是
   终态后引擎仍在写事件的收尾期，机制今天仍然成立（`engine/events.ts` 逐条写 `run_events`），
   只是名字还是 opencode 时代的。**注释本身一句没删**（它正是 `AGENTS.md` 那三例里的「静默 tick 收流」），
   只把「事件泵」换成「引擎的事件写入」/「事件写入」。`app/monitor/lib.ts:15` 那句举例里的
   「事件泵路由表恒为 0」同理改成「子进程句柄数恒为 0」——那正是监控页那张卡今天的名字。
2. 提议里的备选（「让判据同时排除 `ontoflowActiveRuns`，窗口就真的消失」）**没有采纳**。本记录改的是
   注释与文案，不是健康页的判据；`activeRuns` 覆盖的是「executeRun 启动前到异常兜底后」，把它并进
   判据会让「受理后子进程起不来」这类真卡死也从孤儿列表里消失，那是另一条要单独立记录的取舍。

**验收实际跑了什么**

- `rg -n "longHaulFetch|每工作区|per-workspace|事件泵|串行引擎" src docs .github AGENTS.md README.md`：
  除本记录自身外无结果。
- `npm ci && npm run check && npm run build`：全绿（vitest 46 文件 387 通过 1 跳过）。
- `npm run knip`：「Unused dependencies」整段消失（改前唯一一条就是 `undici`）。
- `npx vitest run src/server/harness/composition-boot.test.ts`：5 通过。`npm ci` 之后真起子进程仍能 boot，
  即「没有 `@deepseek-ai` 传递依赖靠根 `undici` 提升解析」的证据；lockfile diff 也只删了 `undici` 自己
  那一个 `node_modules` 条目。
- e2e：`npx playwright test e2e/monitor.spec.ts`（工作树自建 data/ + 3593 端口的干净配置）4 通过。
  孤儿 `reason` 字符串没有任何 e2e 断言，改文案不影响它们。
