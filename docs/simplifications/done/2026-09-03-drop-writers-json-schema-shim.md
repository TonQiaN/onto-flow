# 简化：删掉 writers/json-schema.ts 这层纯转出垫片

状态: done

## 问题

`src/server/writers/json-schema.ts` 全文 5 行：

```
/**
 * Tool 契约的 schema 校验住在 harness/tool-schema.ts：它用上游注册时同一套子集断言，
 * 而 @deepseek-ai 闭包只允许在 harness/ 导入。这里只做转出，writer 与既有调用方不变。
 */
export { objectSchemaProblem } from "@/server/harness/tool-schema";
```

**生产消费者：一个**——`src/server/writers/tool.ts:9`
`import { objectSchemaProblem } from "./json-schema"`（用于 `:59` 与 `:65`）。

**测试 / 文档消费者：** `AGENTS.md:169` 明写「A type array … is rejected by `objectSchemaProblem` in
**`src/server/writers/json-schema.ts`**」——**这句今天是错的**：实现在
`src/server/harness/tool-schema.ts:35`，被点名的那个文件里只有一行转出。`rg -n "json-schema"
src/rules.test.ts` 无结果（没有机械断言）。

**打败了哪条已记录的理由：** 注释自己写着「这里只做转出，writer 与既有调用方不变」——按
`AGENTS.md`「Stance: no compatibility layers」的原话「Remove obsolete paths instead of adding
compatibility layers」，为「调用方不变」而留的转出层正是这一条禁止的东西。而且它让 `AGENTS.md` 指错了
地方，多一处要维护的「同一事实的第二个名字」。

（本条在领域 ① harness 与领域 ② 写入器的交界上，两个领域各报了一次，合并为这一份。）

## 提议

- 删 `src/server/writers/json-schema.ts`；`writers/tool.ts:9` 改成
  `import { objectSchemaProblem } from "@/server/harness/tool-schema"`。
- `AGENTS.md:169` 的「in `src/server/writers/json-schema.ts`」改成 `src/server/harness/tool-schema.ts`，
  保留它旁边那句「(mirrored client-side in `src/app/tools/tool-form.ts`)」。
- `rg -n "json-schema" .github/REVIEW.md` 若有命中同改。
- **与 [把纯常量与纯校验搬进 src/lib/](2026-09-03-share-pure-validators-in-lib.md) 的关系**：那份提议把
  `objectSchemaProblem` 的**形状半边**搬进 `src/lib/json-schema-shape.ts`，由 `harness/tool-schema.ts`
  调它再加上游 `assertObjectJsonSchema`。两份都落地时，本条的 import 终点是
  `@/server/harness/tool-schema`（writer 侧仍要上游断言那半边），`AGENTS.md:169` 的点名一次改到位；
  先落哪一份都不冲突。

## 放弃了什么

「writer 层不直接 import `@/server/harness/`」这个隐含的分层意图。反驳：`writers/` 早就直接引 harness
——`src/server/engine/capabilities.ts:16-20` 引 `harness/tool-plugin`，`src/app/tools/tool-form.ts:158`
甚至 `import type { ToolContext } from "@/server/harness/tool-contract"`（`src/rules.test.ts:120` 为它
专门写了豁免注释）。分层已不成立，垫片保护的是一条不存在的边界。

## 验收

`npm run check`；`npx vitest run src/server/writers/tool.test.ts`；`rg -n "writers/json-schema" src` 无结果。
不碰四处高代价接缝。

## 风险

极低。唯一的公开面变化是 writer 侧多一次跨目录 import，`npm run check` 是完整的门。

预估净删 5 行（整文件）+ 1 行 import 改写 + 1 处 AGENTS.md 事实订正；风险等级：低。

## 落地

PR 待开。

与提议的差异：无。三条全做：删 `src/server/writers/json-schema.ts` 整文件（5 行）、
`src/server/writers/tool.ts` 的 import 改成 `from "@/server/harness/tool-schema"`（唯一一个生产消费者，
`rg -n 'writers/json-schema|from "\./json-schema"' src scripts e2e` 改前只有它一行）、`AGENTS.md` 那句
点名的文件从 `src/server/writers/json-schema.ts` 订正为 `src/server/harness/tool-schema.ts`，旁边
「(mirrored client-side in `src/app/tools/tool-form.ts`)」原样保留。

`rg -n "json-schema" .github/REVIEW.md` 无命中，无需同改：REVIEW.md 第 6 节那条只点 `objectSchemaProblem`
这个名字与客户端 `tool-form.ts`，不点服务端文件路径，订正后依然说得对。`rg -n "json-schema|tool-schema|
objectSchemaProblem" src/rules.test.ts` 也无命中——这条约定没有机械断言，本来就只靠 AGENTS.md 那句话，
而那句话在订正前是错的。

与 [把纯常量与纯校验搬进 src/lib/](2026-09-03-share-pure-validators-in-lib.md) 的先后：落地时那份还在
`proposed/`（`src/lib/json-schema-shape.ts` 尚不存在），所以本条的 import 终点就是提议里写的
`@/server/harness/tool-schema`；那份将来落地时只改 `tool-schema.ts` 内部，本条的终点不用再动。

验收实际跑了什么：见 PR 描述。
