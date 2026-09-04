# 简化：撤掉零消费者的「客户端可从 @/server/monitor/types 导类型」豁免

状态: done

## 问题

（领域 ③ 页面与组件、领域 ⑤ 文档与规则各报了一次，合并为这一份。）

这条例外在三处并存：

- `AGENTS.md:145`：「Client code imports no runtime value from `@/server` or `@/db`. **`import type`
  from `@/server/monitor/types` is the sanctioned exception.**」，`AGENTS.md:116` 的 rules.test.ts 覆盖
  清单再提一次
- `.github/REVIEW.md:48`：「`import type` 只从 `@/server/monitor/types`」
- `src/rules.test.ts:108` `const SANCTIONED_TYPE_SOURCE = "@/server/monitor/types";` 与 `:149-150` 那条
  专门为它开的分支

**生产消费者：零。**

```
$ rg -n 'from "@/server/monitor/types"' src
（无结果）
$ rg -n 'from "@/(server|db)' src/app src/components --glob '!src/app/api/**'
src/app/tools/tool-form.test.ts:6   } from "@/server/harness/tool-contract";   ← 测试文件，扫描集已排除（rules.test.ts:112 isTest）
src/app/tools/tool-form.ts:158      import type { ToolContext } from "@/server/harness/tool-contract";  ← 在 TOOL_EXECUTE_TEMPLATE 模板字符串里，rules.test.ts:122-133 已把扫描截断在它之前
```

客户端**一条** `import type { … } from "@/server/monitor/types"` 都没有。而本该用它的地方在手抄：
`src/app/monitor/lib.ts:110-111` 的 `CLEANUP_TARGETS` / `CleanupTarget` 与
`src/server/monitor/types.ts:90-91` 逐字相同，且客户端那个 `CLEANUP_TARGETS` 只在下一行用来推导类型
（`rg -n "CLEANUP_TARGETS" src` 客户端侧仅 `:110` 与 `:111` 两处）——**只需要类型**，正是这条豁免为之
而设的场景。更进一步，`src/server/monitor/types.ts:1-2` 的抬头写着「系统健康与手动清理的载荷类型（服务端
与前端共用）」——这句今天为假。

**测试 / 文档消费者：** `src/rules.test.ts:106,108,140,149-150`；`.github/REVIEW.md:48`；
`AGENTS.md:116,145`。豁免本身零生产消费者；`CleanupTarget`（客户端那份）被
`src/app/monitor/cleanup-panel.tsx:18,25,370`、`src/app/monitor/lib.ts:114,246` 用。

**打败了哪条已记录的理由：** `AGENTS.md:116` 自己写的——「Its whitelists assert that today's exemptions
are still exemptions, **so fixing one means shrinking the list**」。`handle()` 白名单有
`rules.test.ts:83`「两个例外 route 仍然存在、仍然不用 handle()」这条反向断言，raw-SQL 白名单有
`rules.test.ts:348`「白名单点名的文件今天仍在用原生 SQL」这条——**唯独这条豁免没有任何「仍需豁免」断言**，
因此它永远不会变红，正是那句话承诺不会发生的事。豁免的前提是「有客户端要 import 服务端的监控类型」，
第 4 批把总览 / 实时会话 / 日志检索连同它们的载荷类型删掉之后（[拆散监控台](../done/2026-09-03-dismantle-monitor-console.md)）
这个前提没了，但豁免留了下来。

## 提议

**两条互斥的收口，二选一，推荐 (a)。三处必须同一个 commit 改（`AGENTS.md`「change the three together」）。**

**(a) 收紧（推荐）**：`src/rules.test.ts` 删掉 `SANCTIONED_TYPE_SOURCE`（`:108`）与 `:149-150` 的分支，
改为「客户端从 `@/server` / `@/db` 的任何导入（含 `import type`）都违规」，测试名（`:140`）同改；
`AGENTS.md:145` 删掉后半句、`:116` 同步；`.github/REVIEW.md:48` 删掉「`import type` 只从
`@/server/monitor/types`」；`src/server/monitor/types.ts:1-2` 的抬头改成「服务端载荷类型；前端在
`src/app/monitor/lib.ts` 另有一份宽松解析的视图模型」。`src/app/monitor/lib.ts` 与 `cleanup-panel.tsx`
一行不动。

**(b) 用起来**：`src/app/monitor/lib.ts` 删掉 `:110-111`，改
`import type { CleanupTarget } from "@/server/monitor/types"`；豁免恢复一个使用者，三处规则不动。净删 4 行。

推荐 (a)：它把规则表面缩小，而 (b) 只是给一条只服务四行代码的白名单续命；且
`src/app/monitor/lib.ts:1-17` 的抬头已经论证过它为什么要在客户端自己声明一套（形状刻意不同：
`bytes→sizeBytes`、`runs[]→runEntries`、`affected.count→items`、`detail→note`），(a) 与那段论证一致。

## 放弃了什么

将来客户端想直接复用某个服务端类型时，得先把它挪到 `src/lib/`（就是
[轨迹展示类型移进 src/lib/](2026-09-03-trajectory-view-types-to-lib.md) 走的路），不能就地开一个
`import type`。这多一步；好处是「客户端与 `@/server` 之间只有 `src/lib/` 一条通路」变成无例外的真命题。

## 验收

`npx vitest run src/rules.test.ts`（改的正是它；改完必须绿，且断言里 `clientFiles.length > 0` 仍成立）；
`npm run check`、`npm run build`；`rg -n 'import type .* from "@/(server|db)' src/app src/components` 无结果。
走 (a) 时无用户可见变化，**不跑 e2e**；走 (b) 跑 `npx playwright test e2e/monitor.spec.ts`。

**清理面板接缝的证据：** 本条完全不碰 `src/server/monitor/cleanup.ts` 与
`src/app/monitor/cleanup-panel.tsx` 的逻辑。走 (a) 时清理面板一个字节都不改；走 (b) 时改的只是
`CleanupTarget` 这个联合类型的来源（两份定义逐字相同），`asCleanupResult`（`lib.ts:244-260`）与面板的
「预览影响（dryRun:true）→ 二次确认 → 执行（dryRun:false）」两次请求路径完全不变，dryRun 预览的影响面
与真删仍出自 `cleanup.ts` 同一组查询。若评审要求现场证据，在系统健康页对三项各点一次「预览影响」并记录
条数即可。

## 风险

低。(a) 只删测试分支与两句散文；(b) 只换一个类型的来源。风险在于**语义漂移**：走 (a) 之后，如果哪天服务
端改了 `CleanupResult` 的形状，客户端那份手抄不会红——但这个风险今天就已经存在（客户端本来就没有 import
它），(a) 不新增风险，只是把「我们接受这个风险」写清楚。

预估净删 (a) 约 12 行 / (b) 约 4 行；风险等级：低。

## 落地

PR 待开。

**与提议的差异：** 无。用户拍板选路 (a)（收紧）。`src/app/monitor/lib.ts` 与
`src/app/monitor/cleanup-panel.tsx` 一个字节都没改。

**三处同改：** `src/rules.test.ts` 删掉 `SANCTIONED_TYPE_SOURCE` 与那条分支，断言改成「客户端从
`@/server` / `@/db` 的任何导入（含 `import type`）都违规」，测试名同改；`AGENTS.md` 的
Conventions 行改成「imports nothing … `import type` included; a type the client needs moves to
`src/lib/` first」、Checks 段的覆盖清单加上「with no exempt specifier」；`.github/REVIEW.md`
第 48 条删掉「`import type` 只从 `@/server/monitor/types`」。另外把
`src/server/monitor/types.ts` 那句为假的抬头（「服务端与前端共用」）改成「服务端载荷类型；前端在
`src/app/monitor/lib.ts` 另有一份宽松解析的视图模型」。

**验收实际跑了什么：**

- `npx vitest run src/rules.test.ts` → 18 passed。另做了一次反向验证：临时给
  `src/app/monitor/lib.ts` 加一行 `import type { CleanupResult } from "@/server/monitor/types";`，
  断言如期变红（`src/app/monitor/lib.ts: import type 来自 @/server/monitor/types`），随即还原。
  `clientFiles.length > 0` 的前置断言仍在，仍成立。
- `npm run check`（typecheck + lint + fmt:check + vitest）→ 通过。
- `npm run build` → 通过。
- `rg -n 'import type .* from "@/(server|db)"' src/app src/components` 只剩两处已知的非违规：
  `src/app/api/settings/composition/route.ts`（服务端 route，扫描集本就排除 `src/app/api/`）与
  `src/app/tools/tool-form.ts` 的 `TOOL_EXECUTE_TEMPLATE` 模板字符串（扫描在模板声明处截断）。
  记录里那条「无结果」的验收命令写宽了：它没有带上规则自身的这两个排除项。
- e2e：不适用（走路 (a) 无用户可见变化）。付费冒烟：没跑（不触及 harness 接缝）。
