# 简化：清掉第 3、4 批之后留下的死导出、悬空注释与过时注释

状态: proposed

## 问题

一组**没有任何消费者**（不只是「没有跨文件消费者」）的导出与残留。逐条附证据。

**E1 `portSignature`（`src/app/workflows/[id]/types.ts:222`）**——零消费者。

```
$ rg -n "\bportSignature\b" src e2e scripts docs
src/app/workflows/[id]/types.ts:222      export function portSignature(action: ActionDto): string
src/app/actions/action-editor.tsx:91     function portSignature(ports: NextPort[]): string   ← 同名但不同签名的私有函数
src/app/actions/action-editor.tsx:387    portSignature(nextPorts) !== portSignature(baseline)
```

`git log -S "portSignature(" -- src/app/workflows/[id]/node-panel.tsx` 显示它的调用点在
`365515f v2 phase 2: canvas overhaul…` 里被删掉，函数本身留了下来。

**E2 `STATUS_DOT`（`src/app/runs/status-badge.tsx:53`）**——零消费者，且与同文件 `STYLES` 的 `dot` 字段
（`:2-34`）是同一事实的两份表示。`git show 17f7ee4 -- src/app/runs` 显示第 3 批删 `node-card.tsx` 时带走
了唯一调用点。它的注释「时间线节点圆点配色」指向 `run-timeline.tsx`，而 `run-timeline.tsx` 里
`rg -n STATUS_DOT` **无命中**——注释描述的是一个从未建立的关系。（`src/components/canvas/flow-node.tsx:57`
另有一个同名私有常量，内容不同，不受影响。）

**E3 `RunDetailResponse`（`src/app/runs/lib.ts:162`）**——零消费者，且是生下来就死：
`git log -S RunDetailResponse -- src/app` 只有一条提交（`17f7ee4`，第 3 批）。实际取数走
`src/app/runs/[id]/use-run-stream.ts:46-51` 自己声明的 `interface Payload`。

**E4 `ENTITY_KIND_LABEL` / `ENTITY_KIND_PATH`（`src/components/library/types.ts:8` / `:17`）**——零消费者：

```
$ rg -n "\bENTITY_KIND_LABEL\b" src e2e scripts docs .github README.md AGENTS.md
src/components/library/index.ts:14     ← 只有桶的转发
src/components/library/types.ts:8      ← 定义
```

`ENTITY_KIND_PATH` 的注释写「用于引用面板兜底跳转」，但 `ReferencesPanel` 用的是服务端
`GET /api/references` 载荷里的 `href`（由 `src/server/references.ts:116 entityHref()` 生成）。兜底路径
从未接上。`ENTITY_KIND_LABEL` 与 `src/server/references.ts:74 ENTITY_LABELS`、
`src/app/monitor/lib.ts:283 KIND_LABELS` 是同一映射的第三份，且是唯一没人用的那份。

**E5 桶的 14 个空转发（`src/components/library/index.ts`）**——桶导出 31 个名字，实际经桶被 import 的
只有 17 个；`DEFAULT_SORT` / `DND_FOLDER_MIME` / `ENTITY_KIND_API` / `ENTITY_KIND_LABEL` /
`ENTITY_KIND_PATH` / `EntityKind` / `EntityLeaf` / `EntityReference` / `LibraryQuery` / `RevisionDetail` /
`RevisionSummary` / `SORT_OPTIONS` / `SortKey` / `isSortKey` 这 14 个只有库内部经相对路径 `./types` /
`./use-library-query` 使用（`FolderTree.tsx:6-13`、`LibraryToolbar.tsx:4`、`RevisionPanel.tsx:5-11`、
`FolderPicker.tsx:5-10`、`ReferencesPanel.tsx:5`、`use-library-query.ts:5`）。

**E6 悬空注释（`src/app/workflows/[id]/types.ts:130`）**——`/** 五个可按工作流切换的插件开关的界面文案；
键顺序与 COMPOSITION_TOGGLE_KEYS 一致 */` 后面直接是空行与另一条注释，它描述的常量已经是
`src/lib/workflow-settings.ts:119 COMPOSITION_TOGGLE_LABELS`。同类问题此前修过一次（`bd22508`）。

**E7 过时注释（`src/app/runs/lib.ts:64`）**——`RunSummary` 的注释写「token 与费用**只来自 node_usage**」，
与实现相反：`src/app/api/runs/route.ts:143-146` 从 `run_nodes` 求和，`:151-163` 只有 `byModel` 来自
`node_usage`，`:61-63` 的路由注释与 `AGENTS.md:150` 都是这么说的。

**E8 过时文档（`docs/DESIGN.md:247`）**——仍写「运行详情、历史 API、**画布运行条**与轨迹」，而同一文档
`:59` 说「画布上没有运行条」，`run-bar.tsx` 已在第 3 批删除（`find src -name "run-bar*"` → 0）。

**生产消费者：** 以上八项全部为零。
**测试 / 文档消费者：** `rg -l` 在 `e2e/`、`src/**/*.test.ts`、`scripts/`、`docs/`、`README.md`、
`AGENTS.md`、`.github/` 上全部无命中（E8 本身除外）。

**打败了哪条已记录的理由：** `AGENTS.md`「Comments and documentation」要求注释「state behavior, failure,
timing, and ownership」——E2 / E6 / E7 / E8 是注释与文档在描述**不存在的关系**，属于「删注释不是简化」
的反面：它们描述的东西已经没了，留着是误导而不是规则。E1 / E3 / E4 / E5 是「Stance: no compatibility
layers」直接覆盖的死路径。

## 提议

一条 PR 全清：

- 删 `src/app/workflows/[id]/types.ts:221-226`（`portSignature` 及其注释）与 `:130` 的悬空注释。
- 删 `src/app/runs/status-badge.tsx:52-60`（`STATUS_DOT` 及其注释）。
- 删 `src/app/runs/lib.ts:161-166`（`RunDetailResponse`）；修 `:64` 的注释为「tokens / cost 从
  `run_nodes` 求和，只有 `byModel` 来自 `node_usage`」。
- 删 `src/components/library/types.ts:7-23`（`ENTITY_KIND_LABEL` + `ENTITY_KIND_PATH` 及注释）。
- `src/components/library/index.ts` 只保留被经桶消费的 17 个名字。
- 改 `docs/DESIGN.md:247` 的「画布运行条」为「运行页」。
- `src/rules.test.ts`、`.github/REVIEW.md`、`AGENTS.md` 均不需要改（这些符号在三处都没有出现）。
- e2e 一行不改。
- 本条是 [knip 归零](2026-09-04-knip-to-zero-then-gate.md) 的客户端那一份；两条一起落地时桶收窄只做一次。

## 放弃了什么

E4 / E5 放弃「桶把库的全部公共面都摆出来」这个便利：将来某个页面想要 `SortKey` 或 `EntityLeaf` 时要重新
加一行导出。E1 放弃一个现成的「端口签名」展示函数（若节点面板将来要显示「输入们 → 输出们」，得重写六行）。
E2 放弃一份现成的圆点配色表（但 `STYLES.dot` 就在同文件里）。

## 验收

`npm run check`、`npm run build`；`npx vitest run src/rules.test.ts`；
`npx playwright test e2e/runs.spec.ts e2e/library-v2.spec.ts`（覆盖 E2 / E3 / E5 涉及的文件）。
复核命令（应无命中）：`rg -n "\bportSignature\b" "src/app/workflows"`、`rg -n "STATUS_DOT" src/app/runs`、
`rg -n "RunDetailResponse|ENTITY_KIND_LABEL|ENTITY_KIND_PATH" src e2e scripts docs`、
`rg -n "画布运行条" docs`。不碰四处高代价接缝。

## 风险

低。全部是零消费者的删除加注释订正；`typecheck` 与 `build` 是完整的门。唯一需要留神的是 E5：桶收窄后若
有未扫到的动态引用会编译失败——该桶只被 13 个文件 import，`npm run build` 会立刻抓到遗漏。

预估净删约 50 行；风险等级：低。
