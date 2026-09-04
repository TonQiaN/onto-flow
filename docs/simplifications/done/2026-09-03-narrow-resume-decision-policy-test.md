# 简化：把 resume-decision-policy 测试收窄到只钉语义短语

状态: done

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
  从它 import；测试改 import 同一个模块，对**数据**做**精确集合**比较，而不是子集检查：
  `validateWorkflowContract`（`src/server/resume-match.ts:400-438`）内部就有 `expectedEdges` /
  `expectedEdgeKeys`，受理时要求边集合与各 Action 端口集合**完全一致**——多一条类型匹配的合法边、多接一个
  汇总端口都会 422，而「六评委各有入边、汇总恰六条评委入边」这种子集断言与 `validateGraph` 都拦不住
  （Codex 对 #28 的复审指出）。所以把期望的边四元组集合与各 Action 的端口集合从 `resume-match.ts` 抽到
  纯模块 `src/lib/resume-match.ts`（三类 pin 与 `RESUME_MATCH_*` 端口常量已经住在那里），
  `validateWorkflowContract` 改从它 import，测试也 import 它：种子图的边键排序后 `toEqual` 期望集合，每个
  Action 节点的端口集合 `toEqual` 期望端口集合，节点集合按 key 精确相等。同一份期望喂两处，种子与契约
  不可能漂移；换变量名、换行、改布局坐标都不会红，多一条边或少一条边都会。
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
评委→汇总的边、再多接一条类型匹配的合法边，新断言两次都必须红。

## 风险

低。`seed-resume-graph.ts` 必须保持无副作用（不 import `@/db`、不碰文件系统），否则测试一 import 就会去种
真库——用「文件顶部不出现 `@/db` / `node:fs`」这一条肉眼核对即可，不值一条 rules 断言。

预估净删约 5 行（删 Tool 源码正则与拓扑正则约 −25，精确集合断言、期望集合抽出与 import 约 +20）；风险等级：低。

## 落地

PR：[#43](https://github.com/TonQiaN/onto-flow/pull/43)

**与提议的差异：**

- **多搬了一样东西：八个 Action 的端口定义。** 提议只点名 `CRITICS` / `desiredNodes` /
  `desiredEdges` / `nodeId` / `edgeId` / `edge`，但「每个 Action 节点的端口集合 `toEqual` 期望端口
  集合」这条断言要求测试能把种子的端口当**数据**读到，而它们原本是写在会写库的 `upsertAction({…})`
  调用里的字面量。所以端口定义一并搬进 `scripts/seed-resume-graph.ts` 的 `resumeMatchSeedPorts()`，
  端口值一个字没改（`action_ports` 仍是 26 行）。
- **`nodeId` / `edgeId` 本来就不是纯函数**——它们要读库里现有的行来复用 id（幂等靠这个）。
  拆出来的 `resumeMatchSeedGraph()` 因此把 `currentNodes` / `currentEdges` 作参数收进来，
  由 `seed-resume.ts` 喂 drizzle 查到的行；模块运行时只剩 `crypto.randomUUID()` 这一个依赖，
  不 import `@/db`、不碰文件系统（`NodePayload` / `EdgePayload` 走 `import type`，会被 TS 擦除）。
- **顺手收敛了一处同形状的重复表示**：`src/server/resume-match.ts` 里私有的 `PortContract` 类型与
  `portContract()` 构造函数，跟新导出的 `ResumeMatchPortContract` 完全同形，直接改用导出的那个、
  删掉私有副本，否则等于又把同一件事写两遍。
- **测试保留了三个语义用例而不是两个**：提议说「删第二个 `it()` 里那三条 Tool 源码正则」，
  没说删掉那个 `it()`，所以它连同 `## 证据缺口及计分处理` / `RESUME_MATCH_RESULT_SCHEMA_TEXT` /
  `没有拿到 valid=true 不得提交结构化输出` 等断言留着，只去掉了那三条被
  `RESUME_MATCH_VALIDATOR_TOOL_SHA256` 逐字盖住的实现细节。短语断言改成对
  `seed-resume.ts` + `seed-resume-graph.ts` 拼起来的文本查——评委口径搬了文件，不该因此变红。
- **多加了一条断言**：图定义模块里不出现 `@/db` / `node:fs` 的 import。记录说这条「不值一条 rules
  断言」，这里没有加进 `src/rules.test.ts`，而是放在这个测试文件自己里（两行正则）——它是这个
  模块存在的全部理由，破了就会在 import 的一瞬间去种真库。
- 三类 digest 的 pin 值一字未动，`AGENTS.md` / `.github/REVIEW.md` / `docs/DESIGN.md` / CI 经 `rg`
  现场复核都不需要改。

**验收实际跑了什么：**

- `npx vitest run scripts/resume-decision-policy.test.ts src/server/resume-match.test.ts` → 2 文件 39 通过。
- `npm run check` 全绿（typecheck、oxlint、oxfmt、vitest 46 文件 390 通过 1 跳过；改前是 387）。
- 工作树自建库跑种子确认幂等且 pin 不报错（不花钱）：`npm run db:push && npm run db:seed`，
  再 `npx tsx scripts/seed-resume.ts` 连跑三次 —— 三次都 `节点 11 个，评委 6 位`，
  `revisions` 恒 17、`workflow_nodes` 恒 11、`workflow_edges` 恒 23、`actions` 恒 8、`action_ports` 恒 26，
  节点 id 逐个不变；三类摘要 pin 一次都没抛。
- **故意打破两次，新断言两次都红**（验完已还原，`diff` 与备份逐字节一致）：
  1. 把 `criticNodes.map(...)` 改成 `criticNodes.slice(1).map(...)`（少一条评委→汇总的结论边）→
     `边集合与受理时要求的固定编排完全一致` 红：`expected [ …(22) ] to deeply equal [ …(23) ]`，
     其余 6 条仍绿。
  2. 多接一条类型匹配的合法边（解析`岗位要求` → 汇总`岗位要求`）→ 同一条红：
     `expected [ …(24) ] to deeply equal [ …(23) ]`。
     （附带发现：这张图里**每一对**类型匹配的端口都已经接上了，23 条边就是全集，所以「多一条合法边」
     只能是在已有的某一对上再接一条——旧的子集正则对这种情况不会红，新的精确集合会。）
- **不需要付费冒烟**：三类 digest 的 pin 值未动，`resume-match-validator-integrity.ts` 的受理校验路径不变。
- e2e：不适用（纯脚本 / 服务端纯函数改动，没有用户可见变化）。
