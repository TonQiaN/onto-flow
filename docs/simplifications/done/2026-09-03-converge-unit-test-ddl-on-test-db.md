# 简化：八份手写 DDL 收敛到 test-db.ts 的 schema 生成

状态: done

## 问题

`src/server/writers/test-db.ts` 已经从 `src/db/schema.ts` **生成**建表语句
（`generateSQLiteDrizzleJson` + `generateSQLiteMigration`），它自己的头注释就是这条规则：

```
 * 手写 CREATE TABLE 会在 schema 变化时悄悄失真——关系表、级联与唯一约束都该按真表验。
```
（`src/server/writers/test-db.ts:1-5`）

**用它的 7 个文件：** `src/server/writers/action.test.ts:4`、`skill.test.ts:3`、`tool.test.ts:3`、
`workflow.test.ts:6`、`src/server/references.test.ts:3`、`src/server/resume-match.test.ts:34`、
`src/server/skill-library-rebuild.test.ts:6`。

**另写一份手写 DDL 的 8 个文件**（共约 223 行 `CREATE TABLE` + 约 54 行 `DELETE FROM` 重置 + 约 19 行
drizzle 样板）：

```
$ rg -ln "CREATE TABLE" src
src/server/engine/runner.test.ts      31 行 DDL
src/server/engine/action.test.ts      49 行 DDL
src/server/resolve.test.ts            57 行 DDL
src/app/api/runs/route.test.ts        25 行 DDL
src/server/monitor/cleanup.test.ts    22 行 DDL
src/server/folders.test.ts            17 行 DDL
src/server/engine/events.test.ts      15 行 DDL
src/server/settings.test.ts            7 行 DDL
```

**这不是理论上的失真，已经真的失真了，三处铁证：**

1. **`action_skills` 是一张不存在的表。** `src/server/engine/action.test.ts:37` `CREATE TABLE
   action_skills (...)`、`:231` `DELETE FROM action_skills;`。`src/db/schema.ts` 的 24 张表里没有它——
   现行名字是 `action_preloads`（`schema.ts:236`）。`rg -n "action_skills|actionSkills" src scripts e2e`
   只命中这个测试文件的两行。
2. **仓库唯一破坏性路径的级联根本没被验到。** `cleanup.ts` 靠 `delete from runs`
   （`src/server/monitor/cleanup.ts:279`、`:319`）级联删子表；真表上 `run_nodes` / `run_node_rounds` /
   `run_events` / `node_usage` 四张都是 `.references(() => runs.id, { onDelete: "cascade" })`
   （`schema.ts:414/461/489/517`）。但 `cleanup.test.ts:33-44` 的手写 DDL **只给 `run_results` 与
   `run_node_rounds` 写了 FK**，另外三张是裸表——所以 `cleanup.test.ts:250-256` 只断言了两张被级联删掉，
   另外三张的级联在测试里根本不会发生，也就无从断言。
3. **`AGENTS.md` 点名的两条不变量在手写副本里被删掉了。** `node_usage` 的唯一键「必须带 runId」
   （`schema.ts:538-540` 的长注释记着实测「同一工作流第三次运行 node_usage 一行都没落」）——
   `src/app/api/runs/route.test.ts:23-30` 的 `node_usage` **没有任何唯一约束**；
   `src/server/engine/events.test.ts:14-22` 保留了唯一键，但把 `variant` 写成 `TEXT NOT NULL`（真表可空，
   `schema.ts:523`）、`provider_id` / `model_id` 写成无默认值的 `NOT NULL`（真表 `.default("")`）。

顺带一处残留：`resetTestDb`（`test-db.ts:27-37`）清 23 张表，漏了 ADR-0018 才加的 `run_node_rounds`——
目前没有用 `createTestDb` 的测试往轮次表写行，所以还没爆。

**生产消费者：** `test-db.ts` 本身无（它是测试基建）；手写 DDL 全部在 `*.test.ts` 里。
**测试 / 文档消费者：** 见上两份清单。`AGENTS.md`「Checks」只要求「a unit test swaps an in-memory
database onto `globalThis.ontoflowDb` and creates every directory it needs itself」——**没有**任何一条
规则说 DDL 要手写；`test-db.ts` 的头注释本身就是反对手写的那条规则，八个文件在违反它。

## 提议

八个文件改用 `createTestDb()` / `resetTestDb()`：

- 打开真 FK 之后**每个转换的文件都要先种父行**，不是只有两个（Codex 对 #28 的复审逐个点名）：
  `engine/events.test.ts` 给 `run-1` 写 `run_events` / `node_usage` 却没有 `runs` 行；`engine/action.test.ts`
  给同一个不存在的 run 插 `run_nodes`；`api/runs/route.test.ts` 插 `runs` 却没有它引用的 `workflows` 行；
  `engine/runner.test.ts`、`monitor/cleanup.test.ts` 只建 `runs` 不建 `workflows`。五个文件各补一段
  `workflows` →（`runs`）→ 子表的父行夹具（约每文件 +5 到 +10 行）；`resolve.test.ts` 本来就建全套父行、
  `settings.test.ts` / `folders.test.ts` 不碰带外键的表，这三个直接替换。
- `engine/action.test.ts`：替换时顺手删掉 `action_skills` 的建表与清表两行。
- `monitor/cleanup.test.ts` 补齐父行后**新增一条断言「删 run 级联清空 run_nodes / run_events /
  node_usage」**——这正是手写 DDL 漏掉外键后从没验到过的。
- `test-db.ts` 的 `resetTestDb` 补 `DELETE FROM run_node_rounds;`。

连带要改：`.github/REVIEW.md` §8 第 4 条今天写「服务层测试先把内存库挂到 `globalThis.ontoflowDb` 再
`await import()`」，加半句「内存库一律经 `createTestDb()` 从 `schema.ts` 生成，不手写 `CREATE TABLE`」；
`AGENTS.md`「Checks」里对应那句同改；`src/rules.test.ts` 加一条机械断言：`src/**/*.test.ts` 里不得出现
`CREATE TABLE`，白名单为空（`AGENTS.md`「A convention that can be checked mechanically is a test」，三处
同一提交改）。`AGENTS.md` / `docs/DESIGN.md` 的契约行不受影响。

## 放弃了什么

手写子集 DDL 的两个好处：① 每个文件的 `sqlite.exec` 一眼能看出这个测试碰哪几张表；② 不引
`drizzle-kit/api`，单文件启动快约 450 ms（实测：`references.test.ts` 用 `createTestDb` 705 ms vs
`folders.test.ts` 手写 237 ms）。八个文件 × 450 ms ≈ +3.6 s，vitest 并行分片后墙钟增量更小。另外，打开
真 FK 后，靠「插孤儿行」偷懒的夹具写法不再可用——这正是收益，但也是改造工作量的来源。

## 验收

`npx vitest run src/server/engine src/server/monitor/cleanup.test.ts src/server/folders.test.ts src/server/resolve.test.ts src/server/settings.test.ts src/app/api/runs/route.test.ts`
全绿；`npm run check` 全绿。

**唯一破坏性路径的 dryRun 证据（`monitor/cleanup.ts` 接缝）：** `cleanup.test.ts` 现有的
`expect(deleted.detail).toBe(preview.detail)`（`:248`，dryRun 与真删一致）必须原样保留并重跑，并新增上面
那条级联断言；`cleanup.ts` **一行生产代码不改**，PR 描述里写明这一点。

## 风险

`runner.test.ts`（2405 行）是全仓最大的单测，改它的建库块要逐个 `describe` 复核父行；FK 打开后若某条用例
本就依赖孤儿行，会由「静默通过」变成「插入失败」——那是真 bug 被揭出来，不是回归，但要在同一 PR 里判定
并修。

预估净删约 220 行（−296 删除，+75 父行夹具与断言）；风险等级：中。

## 落地

PR [#42](https://github.com/TonQiaN/onto-flow/pull/42)，已合并进 main。

与提议的差异：无（用户已逐条拍板采纳）。两处提议里没写到、实施时才发现必须做的补齐：

- `runner.test.ts` 的夹具用了六个工作流 id（`workflow-1` / `workflow-materialization` /
  `workflow-loop` / `workflow-passthrough` / `workflow-nested-loop` / `workflow-fanout-loop`），
  不是记录里说的一个——真外键打开后六个父行都要种，否则 `startResolvedRun` 的 `insert into runs`
  撞外键、被那句「工作流不存在（可能刚被删除）」的兜底吃掉，14 条用例一起红。
- `cleanup.test.ts` 的裸表夹具漏的不止外键：`run_events.type`、`run_nodes.node_id` / `label` /
  `status`、`run_node_rounds.status`、`node_usage` 的 `id` / `node_id` / `session_id` / `message_id` /
  `ts` 在真表上都是 NOT NULL，`node_usage` 还带 `(run_id, session_id, message_id)` 唯一键——原来那句
  `INSERT INTO node_usage (run_id) VALUES ('run-b'), ('run-b'), ('run-b')` 在真表上是三行撞同一个键。
  这正是记录里说的「手写子集 DDL 已经失真」的第四份证据，同一 PR 补齐。
- `folders.test.ts` 的自引用外键：`resetTestDb` 按依赖顺序删表，但 `folders.parent_id` 指向自己，
  父子行的删除顺序保证不了，所以保留原来那条注释、把 `PRAGMA foreign_keys = OFF/ON` 挪到
  `resetTestDb` 两侧（`resetTestDb` 本身不动，别的用它的测试不受影响）。

验收实际跑了：

- `npx vitest run src/server/resolve.test.ts src/server/folders.test.ts src/server/settings.test.ts`、
  `src/server/engine/events.test.ts`、`src/app/api/runs/route.test.ts`、`src/server/engine/action.test.ts`、
  `src/server/engine/runner.test.ts`（31 条）、`src/server/monitor/cleanup.test.ts`（8 条）逐个绿。
- `npm run check` 全绿（46 个测试文件、388 通过 1 跳过）；`npm run build` 通过（改到了
  `src/app/api/runs/route.test.ts`）。
- `cleanup.ts` 一行生产代码没改；`expect(deleted.detail).toBe(preview.detail)` 原样保留并重跑，
  新增的级联断言（删 run 后 `run_nodes` / `run_events` / `node_usage` 都只剩活动运行）同批通过。
- 新的机械断言先造了一份带 `CREATE TABLE` 的临时测试文件验证它真的会红，再删掉。
- 无付费冒烟：本条只动测试基建与文档，不碰运行时。
