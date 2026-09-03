# 简化：把 resume-decision-policy 测试收窄到只钉语义短语

状态: proposed

## 问题

`scripts/resume-decision-policy.test.ts`（57 行）没有同名实现文件，它
`fs.readFileSync(new URL("./seed-resume.ts"))` 后对 868 行种子脚本的**源码文本**做正则断言。四个 `it()`
里两个是同一事实的第三、四次书写：

- `it("把岗位、简历和六份评委结论全部接入最终汇总")`（`:41-56`）用四条正则匹配 `seed-resume.ts` 的
  `upsertAction({...})` 与 `edge({...})` 字面量。同一批事实在生产里由 `validateWorkflowContract`
  （`src/server/resume-match.ts:191-452`）在受理前校验，并由 `src/server/resume-match.test.ts` 逐条覆盖：
  `:753`「缺少任一评审到汇总的结论边时在运行受理前失败」、`:785`「重复一位评审冒充缺失评审时在运行受理前
  失败」、`:800`「任一评审缺少岗位或简历来源边时在运行受理前失败」。**而且是最脆的一种写法**——
  `seed-resume.ts` 里换个变量名或换行就红，行为没变。
  但要分清两件事：`resume-match.test.ts` 那三条是拿**自造的**错图验拒绝逻辑，从不评估种子造出的那张图；
  三类 digest 也不含图的连通性。所以「种子实际接线是对的」今天只有这条正则在钉——收窄时只能换写法，
  不能删（Codex 对 #28 的复审指出了这一点）。
- `it("要求评委处理证据缺口…")`（`:20-33`）里有三条断言钉的是 Tool 源码的实现细节：
  `toContain("const __name = <T>(target: T, _value: string): T => target")`、
  `toContain("const expected = path.resolve(root, ${JSON.stringify(RESUME_MATCH_RESULT_ARTIFACT)});")`、
  `toContain("if (candidate !== expected)")`。这三条已被 `RESUME_MATCH_VALIDATOR_TOOL_SHA256`
  （`src/lib/resume-match.ts`，由 `seed-resume.ts:410-416` 在 seed 时抛错、由
  `src/server/resume-match-validator-integrity.ts` 在受理时校验）覆盖——**契约摘要盖住整段 `code`，逐字
  都在里面**。

**真正只有它在钉的**：第一个 `it()`（`:8-18`）与第四个 `it()`（`:50-56`）的语义短语——「不得生成面试
问题、人工复核、后续核实或交给他人判断等行动项」「本维度判断必须在当前材料内完成」「未证实不等于不具备」
「材料未说明原因绝不影响分数」，以及禁止出现「## 面试提问」「## 待确认」。这些是 sha256 pin **管不到**的：
re-pin 是一次显式审阅步骤（`AGENTS.md`「re-pinning is an explicit review step whose PR description lists
both values」），审阅者更新 pin 时短语被删掉也不会红。

**生产消费者：** `seed-resume.ts` 是生产语料，所以被测对象没死——本条不是「保护没人调用的 API」，而是
「两处（三处）表示同一事实」。
**测试 / 文档消费者：** 无（`AGENTS.md`、`.github/REVIEW.md`、`docs/DESIGN.md` 都没点名这个文件）。

**打败了哪条已记录的理由：** `AGENTS.md`「A specialized paid invocation pins behavior, not names」记录的
钉法是**三类 digest**，本文件是一份没被记录的第四种钉法，且它重复的部分与 `validateWorkflowContract` 及
`resume-match.test.ts` 是同一事实的第三、四次书写。

## 提议

- 第二个 `it()` 里那三条 Tool 源码正则（`:26-30`）删掉——它们逐字都在 `RESUME_MATCH_VALIDATOR_TOOL_SHA256`
  盖住的 `code` 里。
- 第三个 `it()`（拓扑，`:31-49`）**换写法、不删**：把 `scripts/seed-resume.ts` 里模块级的 `CRITICS`
  （`:513`）、`desiredNodes`（`:738`）、`desiredEdges`（`:764`）连同 `nodeId` / `edgeId` / `edge` 这些纯
  函数拆到无副作用的 `scripts/seed-resume-graph.ts`（不 import `@/db`，不读写 `data/`），`seed-resume.ts`
  从它 import；测试改 import 同一个模块，对**数据**而不是源码文本断言：`CRITICS` 六个 key 各对应一个
  Action 节点；每个评委节点都有来自解析节点两个端口（`RESUME_MATCH_PARSED_JOB_PORT` /
  `RESUME_MATCH_PARSED_RESUME_PORT`）的入边；汇总节点在 `RESUME_MATCH_REPORT_CRITICS_PORT` 上恰有六条入边、
  来源两两不同且覆盖全部评委；再跑一遍 `validateGraph`（`src/lib/graph.ts`）要求零问题。换变量名、换行、
  改布局坐标都不会红，接错一条边会。
- 保留文件并补一句头注释：它钉两类 sha256 re-pin 管不到的东西——裁决语义短语，与种子实际接线；Tool 实现归
  `RESUME_MATCH_VALIDATOR_TOOL_SHA256`。文件仍在 `scripts/`（`vitest.config.ts` 的 `include` 已含
  `scripts/**/*.test.ts`）。
- 连带：无 `AGENTS.md` / REVIEW / DESIGN / CI 改动；`seed-resume.ts` 的行为与三类 digest 的 pin 值一字不动
  （拆模块只搬定义，不改任何节点、边、Action 字段）。

## 放弃了什么

「钉 Tool 实现细节」这一层——某人改了 `run_python` 校验器里 `if (candidate !== expected)` 的写法，单测不再
第一时间红，要等 seed 时 `RESUME_MATCH_VALIDATOR_TOOL_SHA256` 不匹配抛错。那本来就是记录在案的钉法。
另外多一个文件：读种子要同时看 `seed-resume-graph.ts`。

## 验收

`npx vitest run scripts/resume-decision-policy.test.ts src/server/resume-match.test.ts`；`npm run check`。
**不需要**跑 `seed-resume.ts`（它写 `data/`），也不需要付费冒烟——三类 digest 的 pin 值一字未动，
`resume-match-validator-integrity.ts` 的受理校验路径不变；拆模块后 `npx tsx scripts/seed-resume.ts` 在本地
跑一次确认仍 idempotent（不花钱，只写库与 `data/samples/`）。故意在 `seed-resume-graph.ts` 里删掉一条
评委→汇总的边，新断言必须红。

## 风险

低。`seed-resume-graph.ts` 必须保持无副作用（不 import `@/db`、不碰文件系统），否则测试一 import 就会去种
真库——用「文件顶部不出现 `@/db` / `node:fs`」这一条肉眼核对即可，不值一条 rules 断言。

预估净删约 10 行（删 Tool 源码正则与拓扑正则约 −25，语义断言与模块拆分的 import 约 +15）；风险等级：低。
