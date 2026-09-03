# 简化：八份手写 DDL 收敛到 test-db.ts 的 schema 生成

状态: proposed

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

- `settings.test.ts`、`engine/events.test.ts`、`folders.test.ts`、`resolve.test.ts`、
  `api/runs/route.test.ts`：直接替换，无父行依赖问题（`resolve.test.ts` 本来就建全套父行）。
- `engine/action.test.ts`：替换，顺手删掉 `action_skills` 的建表与清表两行。
- `engine/runner.test.ts`、`monitor/cleanup.test.ts`：这两个今天只建 `runs` 不建 `workflows`，打开真 FK
  后要补一行 `workflows` 夹具（约每文件 +5 行）；`cleanup.test.ts` 补齐后**新增一条断言「删 run 级联清空
  run_nodes / run_events / node_usage」**。
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

预估净删约 250 行（−296 删除，+45 父行夹具与断言）；风险等级：中。
