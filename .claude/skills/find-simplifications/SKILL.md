---
name: find-simplifications
description: 在 OntoFlow 仓库里找有证据的简化候选——无生产消费者的路由 / 导出 / 表列、两处表示同一事实、无主人的投机通用性、只为未用 API 存在的防御、手写了依赖已有的东西、加了又拆的残留、新功能上线后遗留的旧数据——写成 docs/simplifications/proposed/ 记录并顺带审计 rejected/。用户说「找找能简化什么」「清点冗余」「跑一轮简化」时用。
---

# 找 OntoFlow 的简化候选

把「找找有什么能简化」变成一批**有证据的提案**：每个候选一份 `docs/simplifications/proposed/`
记录，由用户逐条拍板，再逐个开实施 PR。这是全仓库的清点，与内置 `/simplify`（只看当前 diff、
直接改代码）分工不同；本 skill 不改生产代码。

## 起手：先读已定之事

1. 根 `AGENTS.md`（尤其「Stance: no compatibility layers」与「The harness seam」）。
2. `docs/simplifications/README.md` 与三个状态目录：`done/` 是已经删掉的，`rejected/` 是**别再提**的，
   `proposed/` 是已在队列里的——重复的候选并进已有记录，不新开。
3. 相关 ADR（`docs/adr/`）与 `docs/harness/`（每个插件行的挂载理由）。

**已记录的理由优先。** 候选必须**打败** AGENTS.md / ADR / `docs/harness/` 里记录的那个理由——
说明它依赖的前提已不成立、或代价已超过收益——引用「简化政策」本身不算证据。记录了「为什么要
这么绕」的注释是规则本身（AGENTS.md「Comments and documentation」），删注释不是简化。

## 四处高代价接缝

碰到这四处，候选的「验收」必须写明对应的证据，否则不成立：

- harness 接缝：`src/server/harness/runtime.ts`、`src/server/harness/rpc/server.ts`、
  `src/server/engine/action.ts` 三个头注释覆盖的行为——验收含 `smoke-harness` 或 `smoke-engine`。
- `src/server/monitor/cleanup.ts`，仓库唯一的破坏性路径——验收含 `dryRun` 影响面与真删一致的证据。
- 受理与冻结：`resolveWorkflow` → `startResolvedRun`，以及后来所有只读冻结对象的消费者——验收含
  `smoke-engine`。
- 技能投影：`src/server/skill-library.ts` 的链接 + 版本目录原子换法与持有 / 延迟删除——验收含
  并发写与运行持有的单测。

## 什么算强候选

- 一条路由、一个导出、一个配置项、一列、一个事件类型没有**生产消费者**（只有测试、文档、注释在用）。
- 两处表示同一事实（两个类型、两张表、两条推导），尤其跨 `run_events` 与轨迹 JSONL。
- 为将来某个没有主人的场景预留的通用性：可插拔、多后端、注册表、参数化的分支。
- 只为保护一个没人调用的 API 而存在的防御、回滚、特例测试。
- 手写了 Node 内置或仓库已有依赖能做的事（解析、匹配、重试、diff）；换成依赖要算净删除：
  实现 + 专属测试 + 文档 − 留下的胶水。
- 加了又拆的残留：字段还在 schema 里、常量还在导出、文档还在描述。
- 新功能上线后遗留的旧数据：新代码只能降级显示或读不出的历史行、目录、文件（如 ADR-0018 之前没有冻结图的
  运行，只能空画布回放）。不为它们写兼容分支；写成候选，给出数量与新代码对它们的表现，由用户拍板是否直接
  删除。先例：2026-09-04 用户拍板删除了 48 条无冻结图的历史运行，记录见
  `docs/simplifications/done/2026-09-04-delete-runs-without-frozen-graph.md`。
- 简化后行为允许略有不同，但新行为要更好解释。

弱候选不写记录：一处拼写、跑一次 knip 的原始输出、「这段看起来复杂」而没有调用点证据、
被 ADR 明确保护而没有新证据的东西。小而确定的清理直接开 PR，不写记录。

## 语料与证据

- 生产语料：`src/` 的非测试文件、`scripts/seed*.ts`、`scripts/smoke-*.ts`、`scripts/run-*.ts`
  （付费门与产品路径）。非生产语料：`*.test.ts`、`e2e/`、`docs/`、README、注释。`_reference/` 永不计。
- 每个符号都 `rg` 到调用点再下结论：精确符号名、路由字符串、事件类型串、`globalThis` 键、组合里的
  插件 id、schema 列名。动态装载的路径（组合按绝对路径装载 rpc 插件、生成的 Tool 包装、子进程入口
  `runner.ts`）在 knip 眼里是「未用文件」，不是候选。
- `npm run knip` 的输出只是线索，每条仍要读到调用点；`npm run lint`、`npm run typecheck` 通过是
  候选实施后的门，不是候选成立的证据。

## 清点方式

用并行子 agent 分领域，每个 agent 要求证据而非猜测；没有子 agent 就自己按同样的领域顺序走：

1. harness 接缝与引擎：会话、事件、用量、取消、组合、受理与冻结。
2. API 路由与写入器：42 条路由的消费者、`WriteResult` 与两份私有 `Result<T>`、引用表。
3. 页面与组件：库页面共享组件、画布、运行页、系统健康。
4. 脚本与测试：种子、冒烟、验收脚本、单测里只为保护未用 API 的用例。
5. 文档与规则：AGENTS.md / REVIEW.md / rules.test.ts 三处是否仍对应存在的代码。
6. 数据与目录：`data/` 里新功能之前留下的行与目录——旧形状的运行、库里没有对应行的孤儿目录——拿数量与
   新代码对它们的表现说话，交用户拍板删不删。

从最大的生产代码增量入手，不要在第一个好候选处停下。

## 写记录

一个候选一份 `docs/simplifications/proposed/yyyy-mm-dd-slug.md`，骨架见
`docs/simplifications/README.md`（`# 简化：` 标题、`状态: proposed`、问题 / 提议 / 放弃了什么 /
验收 / 风险；问题里生产消费者与测试 / 文档消费者分开列）。与已有记录重叠的并进去。三条全中
（难逆、脱离上下文令人费解、真有取舍）才另写 ADR 并互相链接。

## 顺带审计 rejected/

每轮结束前过一遍 `docs/simplifications/rejected/`：被否决的对象已不存在、或理由已被后来的 ADR /
决定覆盖，就删掉那份文件，并在 PR 描述里列出删了哪些与为什么。不改 `done/`。

## 收尾

跑 `npx vitest run src/rules.test.ts`（记录树骨架门禁）；开一个**只含文档**的 PR，正文列出：
候选数与领域、并入已有记录的、明确排除的、审计删除的 rejected；用户逐条拍板后，每个采纳的候选
一个实施 PR，合并时把记录移到 `done/` 并补 `## 落地`。
