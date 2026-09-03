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

- 删第三个 `it()`（拓扑正则，`:41-56`）与第二个 `it()` 里那三条 Tool 源码正则（`:26-30`）。
- 保留文件并补一句头注释，说明它只钉「sha256 re-pin 之后仍必须成立的语义短语」，拓扑归
  `resume-match.test.ts`、Tool 实现归 `RESUME_MATCH_VALIDATOR_TOOL_SHA256`。
- 文件名与 `seed-resume.ts` 的关系不变，仍留在 `scripts/`（`vitest.config.ts` 的 `include` 已含
  `scripts/**/*.test.ts`）。
- 连带：无 `AGENTS.md` / REVIEW / DESIGN / CI 改动。

## 放弃了什么

一层「改错了种子的接线会在单测里立刻红」的早期反馈——现在最早的反馈点后移到 `resume-match.test.ts`
（同样免费、同样在 `npm test` 里），只是不再在 `seed-resume.ts` 的源码层面拦。

## 验收

`npx vitest run scripts/resume-decision-policy.test.ts src/server/resume-match.test.ts`；`npm run check`。
**不需要**跑 `seed-resume.ts`（它写 `data/`，且本候选不改种子一行），也不需要付费冒烟——三类 digest 的
pin 值一字未动，`resume-match-validator-integrity.ts` 的受理校验路径不变。

## 风险

如果哪天有人真的把某条评委→汇总的边接错，`resume-match.test.ts` 是靠**构造错误图**验拒绝，而不是验种子
造出的图是对的——理论上存在「种子错了、拒绝逻辑对了、两个测试都绿、付费入口在受理时才 422」的窗口。这个
窗口的代价是一次 422，不是一次错误的付费运行，可接受。

预估净删 25 行；风险等级：低。
