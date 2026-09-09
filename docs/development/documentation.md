# 文档与指令维护

修改指令、文档、术语或技能前读取。根 [AGENTS.md](../../AGENTS.md) 只承担常驻入口，专题文件承接详细工程约束；不要把每次实现过程再次加回根文件。

## 权威位置

| 内容 | 维护位置 |
| --- | --- |
| 领域词汇与语义，不放实现 | [CONTEXT.md](../../CONTEXT.md)；ADR-0010 未实施须保留头注 |
| v1 契约与当前引擎 spec | [DESIGN.md](../DESIGN.md) |
| 列表、文件夹、引用、修订、共享 UI 契约 | [DESIGN-V2.md](../DESIGN-V2.md) |
| 清理、运行页与工具链契约及进度 | [DESIGN-V3.md](../DESIGN-V3.md) |
| 产品介绍与唯一的 demo walkthrough | [README.md](../../README.md) |
| 命令与验证要求 | [验证指南](checks.md)；实际命令/CI 以 package.json 与工作流为准 |
| 写入/API、设置、运行、Harness 的工程细节 | [应用约束](application.md)、[能力约束](capabilities.md)、[运行约束](runs.md)、[Harness 接缝](harness.md) |
| 组合逐行理由与上游升级 | [docs/harness](../harness/README.md) 与其 [AGENTS.md](../harness/AGENTS.md) |
| monitor 接口当前行为 | [src/server/monitor](../../src/server/monitor)；没有独立的完整接口契约文档 |
| 人工检查的非机械不变量 | [.github/REVIEW.md](../../.github/REVIEW.md)，按专题链接回规则理由 |
| 可机械核对的工程约定 | [src/rules.test.ts](../../src/rules.test.ts) |

变更改变某份 DESIGN 的契约或确定术语时，在同一 PR 更新其权威位置；README 保留的操作示例也应准确，但不再要求没有关联的文档为一处文字修改而陪改。当前行为不能只更新在 ADR、Issue 或 PR 讨论里。

## 注释与决定

- 注释说行为、失败、时序、归属，不复述控制流；解释 `SUM`、`LIKE` 转义、SSE 静默 tick 等绕行原因的注释是约束的一部分，不能随意删除。用户可见文字、错误、代码注释、测试名用中文；新写文档正文用中文，搬移的既有契约原文可保留以便核对。
- 一个决定同时满足“难以逆转、脱离上下文令人费解、真有取舍”才写 ADR。先读 [domain-modeling skill](../../.codex/skills/domain-modeling/SKILL.md) 与 [ADR-FORMAT](../../.codex/skills/domain-modeling/ADR-FORMAT.md)，中文标题、决定、以代价结尾的 `理由：` 段落，编号规则以格式文件为准。
- 被取代的 ADR 留在原处，新旧互链，参照 ADR-0003 与 ADR-0005。代码只在被约束的那一行以裸 id 引用，例如 `（ADR-0005）`。
- 已决定但未实施的模型必须明确标记并链接 ADR，不能把进度写成当前事实。历史阶段、PR 数量、测试数量、文件行数不写入常驻指令。
- `.claude/skills/` 与 `.codex/skills/` 的技能树保持字节一致，修改两边；不在文档写死技能总数。术语或 ADR 工作使用 domain-modeling；不为每个 Issue 额外建立一套重复的决定记录。
- 简化记录继续放 [docs/simplifications](../simplifications/README.md)，沿用 proposed / done / rejected 骨架；实施 PR 链接记录，合并时进 done 并补落地。否决理由留在 rejected，不回流根指令。

## 指令的加载与预算

- `AGENTS.md` 是根入口；任务专题是显式按需读取的普通 Markdown，不声称工具会递归自动加载所有子目录。目录级 AGENTS 仅承接确实只适用于该目录的规则；从根启动后修改深层文件，仍需主动检查沿途指令。
- 根文件保留启动、边界、任务导航、完成定义与 `Code Review Rules`。细节下沉，避免把设计说明、排错过程、文件数量和版本清单重新拼回根文件。
- 根文件（含 Next.js 自动区块）上限 **8 KiB**；仓库内沿路径合并的 AGENTS 链上限 **24 KiB**，给默认 32 KiB 预算留出空间。两者是本项目的工程预算，不是官方强制值，也不能保证任意全局用户指令都放得下。扩大预算必须在 Issue/PR 说明必要性，并同步修改 `src/rules.test.ts`。
- 根 `CLAUDE.md` 与 `docs/harness/CLAUDE.md` 保持相对 symlink 到同目录的 `AGENTS.md`，不复制第二份正文。规则测试检查预算、本地 Markdown 链接、别名及 Next.js 区块存在性。
- 修改规则时，同一提交更新根/专题、机械测试与对应人工条目；机械检查交给 CI，人工评审盯测试看不见的时序、所有权和失败语义。规则不再被代码遵守就删掉，不能改软后继续留着。
- `nextjs-agent-rules` 由 `next dev` 重写并补回；保留且随工作提交。机制见安装版本的 `node_modules/next/dist/server/lib/generate-agent-files.js`；写 Next 代码前读同版本的 `node_modules/next/dist/docs/`。

## 依据与本次核对

2026-09-09 查阅官方 [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：Codex 按根到当前目录构建指令链，默认合并预算为 32 KiB；评审规则应简短具体，可机械验证项交给 CI。官方 [Best practices](https://learn.chatgpt.com/guides/best-practices#make-guidance-reusable-with-agentsmd) 建议保持根指令准确简短，变长后链接专题 Markdown，依据反复出现的问题维护规则。

本项目据此采用“精简根入口 + 显式专题链接”，而非提高所有开发者的 Codex 配置上限。变更证据与约束搬移范围见 [Issue #62](https://github.com/TonQiaN/onto-flow/issues/62)；以源码和 CI 为当前事实，官方资料不替代本仓库约束。
