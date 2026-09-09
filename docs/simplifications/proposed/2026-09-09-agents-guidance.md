# 简化：把根指令缩成任务入口

状态: proposed

## 问题

根 [AGENTS.md](../../../AGENTS.md) 在 main `94aaa80` 是 245 行、69,365 字节，超过 Codex 默认 32 KiB 合并指令预算。常驻内容混合命令、全目录树、约束和排错过程，后半段可能被截断。

生产消费者：应用运行不读取仓库根 AGENTS；运行指令由全局与工作流设置写到各自运行目录（`src/server/harness/workspace.ts`）。开发/评审消费者：Codex / Claude、根 CLAUDE symlink、[REVIEW](../../../.github/REVIEW.md)、[规则测试](../../../src/rules.test.ts)。这是开发上下文整理，不改变应用行为。

用户明确要求先建 Issue，关联 [#62](https://github.com/TonQiaN/onto-flow/issues/62)。官方建议及查询日期记录在 [文档维护](../../development/documentation.md)。

## 提议

根保留边界、导航、常用命令、完成定义与评审规则；既有技术细节按原规则搬到六份专题。搬移关系：目录树、一般 Conventions → [应用](../../development/application.md)；三层设置、Tool、Skill → [能力](../../development/capabilities.md)；图、轮次、快照、清理、终态 → [运行](../../development/runs.md)；会话、组合、用量、沙箱 → [Harness](../../development/harness.md)；Commands / Checks / fixtures → [验证](../../development/checks.md)；Comments / Decisions / Editing → [文档维护](../../development/documentation.md)。

删去常驻的路由/spec/技能数量、文件行数与旧引擎回顾；纠正终态路径“四条却称五条”的文字和 PR 模板漏列 knip。README 加完整验证入口，REVIEW 每组指向实际规则所有者，规则测试改来源并增加体积/本地链接/别名检查。保留全部产品约束与 Next.js 自动区块，不修改依赖、业务源码和数据。

## 放弃了什么

不再一次把全部工程细节塞进根提示。代价是跨模块任务要按导航主动读取多份专题；根文件明确要求读取相关项，REVIEW 同步给入口，避免误以为深层文件会自动递归加载。

## 验收

- 根文件（含 Next.js 区块）≤ 8 KiB，仓库内沿路径合并的 AGENTS 链 ≤ 24 KiB；这两个预算是本项目选择，不是官方上限。
- 根可到达所有专题；本地链接、CLAUDE 相对 symlink 完整；原有约束和例外仍有归属。
- `npx vitest run src/rules.test.ts`、`npm run check` 通过。
- PR 当前提交的 check / e2e 门禁通过后合并并回读 PR、Issue 与 main。

## 风险

跨专题规则漏读是主要风险，通过根导航、专题交叉引用与 REVIEW 来源链接处理；术语与 ADR 决策不变。文档调整是可逆维护，不满足新增 ADR 的三项门槛。独立 worktree 不改主工作区现有业务修改，不读取 `.data/` 或操作真实运行数据。
