# 简化：删掉只有单测在用的 totalUsage 与 base64ByteLength

状态: done

## 问题

knip 找不到这一类——它把 `*.test.ts` 当 entry，测试里的 import 会被算作「用到了」。用自写扫描（全仓导出
× 引用点）筛出「生产引用 0、测试引用 > 0、且本文件内也不用」的导出，只有两个。

**① `totalUsage`（`src/app/runs/lib.ts:312`）**

```
$ rg -n "\btotalUsage\b" src e2e scripts
src/app/runs/lib.test.ts:2   import { sumTokens, totalUsage } from "./lib";
src/app/runs/lib.test.ts:16  expect(totalUsage([usage, usage])).toEqual({ tokens: 74, cost: 0.24 });
src/app/runs/lib.ts:312      export function totalUsage(nodes: Array<Partial<NodeUsage>>)
```

生产消费者：**无**。同文件的 `sumTokens`（`:301`）有三个真消费者（`visuals-at.ts:214/242`、
`agent-trajectory.tsx:74`），`totalUsage` 一个也没有——运行页的合计走 `visuals-at.ts:242` 自己的
`reduce`，运行列表的合计走 `/api/runs` 的 `sql` 汇总。测试消费者：`src/app/runs/lib.test.ts:16` 一行断言。

**② `base64ByteLength`（`src/app/skills/skill-files.ts:84`）**

```
$ rg -n "\bbase64ByteLength\b" src e2e scripts
src/app/skills/skill-files.ts:84         定义
src/app/skills/skill-files.test.ts:3,101,102,103,104   ← 4 条断言
```

生产消费者：**无**。它的文档注释写着「修订面板估算大小用」，但修订面板**把同一个算法原地又写了一遍**：

```ts
// src/components/library/RevisionPanel.tsx:145-147
const encoded = typeof rec.contentBase64 === "string" ? rec.contentBase64 : "";
const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
const size = encoded === "" ? 0 : Math.floor((encoded.length * 3) / 4) - padding;
```

与 `skill-files.ts:84-88` 逐字同算法。技能编辑器用的是 `file.size`（`skill-editor.tsx:178`），不是它。
测试消费者：`src/app/skills/skill-files.test.ts:101-104`。

**打败了哪条已记录的理由：** `AGENTS.md`「Unit tests cover pure logic, non-obvious invariants, and the
conventions above」保护的是**有被测对象**的测试。这两个函数在生产里没有任何调用点，测试保护的是一个没人
调用的 API。`base64ByteLength` 同时是「两处表示同一事实」与「注释还在描述一个不存在的用法」。

## 提议

- 删 `src/app/runs/lib.ts:312-322` 的 `totalUsage`，`src/app/runs/lib.test.ts` 只留 `sumTokens` 那条断言
  （该文件缩到约 12 行）。
- `base64ByteLength` 二选一，**推荐 A**：
  - **A（净删除）**：删 `skill-files.ts:83-88` 与 `skill-files.test.ts` 的 4 条断言，`RevisionPanel.tsx`
    的内联写法保持不动（它服务的是「所有实体的修订 diff」，不该反向依赖 `src/app/skills/`）。
  - **B（收敛）**：`RevisionPanel.tsx:145-147` 改为
    `import { base64ByteLength } from "@/app/skills/skill-files"`。**但这会新造一条 `src/components/` →
    `src/app/` 的反向依赖**——`AGENTS.md` 里唯一被接受的那条反向依赖刚在第 4 批被删掉
    （[拆散监控台](../done/2026-09-03-dismantle-monitor-console.md) 的「与提议的差异」第 2 条），不宜重开。
- 连带：无 `AGENTS.md` / DESIGN / REVIEW / `src/rules.test.ts` / CI 改动。

## 放弃了什么

`totalUsage` 是「按节点数组合计 tokens 与 cost」的现成写法，将来运行页要再加一处合计时得重写十行。
`base64ByteLength` 删掉后，若第三处也要算 base64 字节数，仍会各写各的。

## 验收

`npx vitest run src/app/runs/lib.test.ts src/app/skills/skill-files.test.ts`；`npm run check`；
`npm run build`（碰 `src/app/`）。用户可见面无变化，不需要跑 e2e spec；保险起见跑
`npx playwright test e2e/skills.spec.ts`（它验资源文件上传与投影）。不碰四处高代价接缝。

## 风险

低。两处都无生产调用点，删除后 `typecheck` 会立刻抓到任何遗漏。

预估净删 30 行；风险等级：低。

## 落地

PR：https://github.com/TonQiaN/onto-flow/pull/44（分支 `cleanup/5-drop-test-only-exports`，[DESIGN-V3 第 5 批](../../DESIGN-V3.md)）。

与提议的差异：

- `base64ByteLength` 按用户拍板走**路 A（净删除）**：`skill-files.ts` 里的函数与
  `skill-files.test.ts` 的那条用例（4 条断言）一起删，`RevisionPanel.tsx:145-147` 的内联算法
  一字未动——路 B 会新造一条 `src/components/` → `src/app/` 的反向依赖，而唯一被接受的那条
  刚在第 4 批被删掉。
- 提议只说删 `totalUsage` 的断言，实际连夹具里的 `cost: 0.12` 一起删：合计没了以后没有任何
  断言再读这个字段，留着就是一条没人看的夹具数据。`reasoningTokens: 7` 必须留——它正是
  「output 已含 reasoning，不重复加」那条用例要证明的东西。
- 复核了记录里「无连带改动」的判断：`rg -n "\btotalUsage\b|\bbase64ByteLength\b"` 在 `src` /
  `e2e` / `scripts` / `docs`（除本记录）/ `README.md` / `AGENTS.md` / `CONTEXT.md` / `.github`
  上现已清零，`src/rules.test.ts` 也没有钉过这两个名字。

验收实际跑了：`npx vitest run src/app/runs/lib.test.ts src/app/skills/skill-files.test.ts`
（2 文件 9 条全绿）、`npm run check`（typecheck + lint + fmt:check + vitest，46 文件
386 passed / 1 skipped）、`npm run build`（碰了 `src/app/`，路由表照旧）、
`npx playwright test e2e/skills.spec.ts`（本目录自己的干净库 + 3595 端口，3 条全绿——
记录里「保险起见」点名的那个 spec）。不碰四处高代价接缝，未跑付费冒烟。
