# 简化：runs.imports 只留 invocation / completion，删掉从没人读的技能目录摘要

状态: proposed

## 问题

对象：`src/server/harness/workspace.ts` 的 `digestDirectory()`（L96-124）、`ImportRecord`（L52-60）、
`RunWorkspace.imports`（L92）、`createRunWorkspace()` 里「摘要 → 建链 → 核对 realpath → 不一致就拆链
重来」的 for 循环（L196-210）与 `imports: { instructionsDigest, items }` 返回块（L221-224），以及
`src/server/engine/runner.ts:573-580` 把它写进 `runs.imports` 的那次 update。

**生产消费者：无。**

```
$ rg -n "imports\.items|imports\?\.items|instructionsDigest" src/app src/server --glob '!*.test.ts' | grep -v workspace.ts
src/app/api/settings/composition/route.ts:77:    imports: { instructionsDigest: "", items: [] }   ← previewWorkspace() 的假 RunWorkspace，是写不是读
```

`runs.imports` 的真实读者只有三处，都只读 `invocation` / `completion`：`src/app/api/runs/route.ts:24`
（`json_extract(runs.imports, '$.invocation.source')`）、`src/server/resume-match.ts:651` / `:752`、
`src/app/runs/[id]/page.tsx:49`（`run.imports?.invocation?.source`）。

**测试 / 文档消费者：** 八处夹具行 `imports: { instructionsDigest: "", items: [] }`
（`engine/capabilities.test.ts:46`、`engine/action.test.ts:214`、`engine/runner.test.ts:855` / `:1253`、
`harness/tool-plugin.test.ts:54`、`harness/catalog.test.ts:37`、`harness/composition-boot.test.ts:132`、
`harness/launch.test.ts:35`）；`AGENTS.md:170`「`createRunWorkspace` digests a skill through its real path
so a rewrite during admission cannot mix two versions」；`workspace.ts` 头注释 L7-8；
[ADR-0007](../../adr/0007-one-harness-subprocess-per-run.md) 的摘要句。

**打败了哪条已记录的理由：** 记录的理由是「摘要能证明跟那次是不是同一份」。ADR-0018 落地后，同一事实
有一份**严格更强**的表示：`run_node_rounds.snapshot.skills[].content` 存的是会话启动前经 symlink 实读到
的 `SKILL.md` 全文（`action.ts:319-337` `readProjectedSkills` 的 `fs.readFileSync`），不是摘要。而「摘要
不能混到两个版本」保护的场景，今天由两条更早的机制兜住：① `retainSkillProjections(runId, …)` 在
`startResolvedRun`（`runner.ts:402`）就 `statSync` + `accessSync` 过每个 `<slug>/SKILL.md` 并持有版本
目录，**早于** `createRunWorkspace`（`runner.ts:567`）；② 真出现断链时 `readProjectedSkills` 在任何模型
调用之前抛「Skill 投影不可读」。

## 提议

- 删 `digestDirectory`、`ImportRecord`、`RunWorkspace.imports`；`createRunWorkspace` 里的 for 循环缩成
  一句 `await symlink(item.sourceDir, target, "dir")`；`node:crypto` 的 `createHash` 与 `node:fs/promises`
  的 `readFile` / `readdir` / `realpath` 四个 import 随之删（`rg -n "realpath|readFile|createHash|readdir"
  src/server/harness/workspace.ts` 证明它们只服务这条链）。
- `runner.ts:573-580` 的 update 缩成 `.set({ runDir })`——**顺带消掉一条易碎的不变量**：那句注释「工作区
  导入摘要稍后补齐，但不能覆盖受理时已经持久化的入口来源证明」（`imports: { ...workspace.imports,
  invocation }`）从此不必存在，`runs.imports` 一生只在受理事务里写一次（`runner.ts:426`）。
- 八处测试夹具删 `imports` 键；`AGENTS.md:170` 那半句改写为「admission 的 `retainSkillProjections` 同步
  核对并持有投影」；`workspace.ts` 头注释同改；[ADR-0007](../../adr/0007-one-harness-subprocess-per-run.md) 的 `:7` / `:13` 两句加一句「摘要在 2026-09 第 5 批删除，证据改由轮次
  快照全文承担」并链回本记录（`AGENTS.md` 要求超期决定留在原处并互链）。

## 放弃了什么

事件清理（`cleanup.ts` 的 events 目标）把 `run_node_rounds.snapshot` 置空之后，「这次运行看见的技能是哪
一版」就再也无法查证——今天摘要会留下来（`runs.imports` 不在清理范围内）。这是唯一真实的损失；反方最强
的说法是「摘要几十字节，留着不花钱」，反驳是没有任何代码或界面能把它取出来，留着的是无法阅读的字节。

## 验收

- `npm run check` + `npm run build`；`npx vitest run src/server/harness src/server/engine`。
- **技能投影接缝**：`npx vitest run src/server/skill-library.test.ts src/server/skill-library-rebuild.test.ts`
  ——并发重写 + 运行持有的现有用例必须仍绿。
- **付费冒烟（踩受理与冻结、技能投影两处接缝）**：`npx tsx scripts/smoke-capabilities.ts`（技能被发现、
  被预载）与 `npx tsx scripts/smoke-engine.ts`（`runs.imports` 只剩 `{ invocation }`、
  `run_node_rounds.snapshot.skills[].content` 非空）。退出码与结论写进 PR 描述。
- 观察终态：`rg -n "instructionsDigest|ImportRecord|digestDirectory" src scripts e2e` 无结果。

## 风险

行为变化：`createRunWorkspace` 不再因源目录不可读而在建链处失败——退化成建出一条悬空链，由
`readProjectedSkills` 在首个 Action 开会话前抛。两者都在付费调用之前，错误文案更具体（点名 Skill 名），
可接受；PR 里要写明这条时序。公开面变化：`RunWorkspace` 少一个字段，八处测试夹具同改。

预估净删约 70 行生产 + 8 行测试夹具；风险等级：中。
