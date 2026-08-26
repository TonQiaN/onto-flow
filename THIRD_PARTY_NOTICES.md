# 第三方声明

## DeepSeek Harness（`@deepseek-ai/dsh-*`、`@deepseek-ai/cordis`）

许可：MIT，版权归 DeepSeek AI。上游仓库 https://github.com/deepseek-ai/deepseek-harness。

本项目以 npm 依赖闭包的形式吸收这套 harness（版本锁定见 `package.json` 的
`dependencies` 与 `overrides`，理由见 [ADR-0006](docs/adr/0006-deepseek-harness-as-execution-engine.md)），
并另有三个文件是**改造自上游源码**而非经依赖引入：

| 本仓库文件 | 上游原型 | 改造原因与差异 |
|---|---|---|
| `src/server/harness/rpc/index.ts` | `packages/sdk/server/src/index.ts` | 补齐 session/cancel、session/close、session/output 三方法 |
| `src/server/harness/rpc/server.ts` | `packages/sdk/server/src/server.ts` | 增加按会话的 nodeOptions 组合（结构化输出、工具子集、作用域技能、思考强度），不转发 subagent 通知 |
| `src/server/harness/rpc/structured.ts` | `packages/subagent/subagent-in-process-driver/src/structured.ts` | 未走 npm 依赖：该包的运行时入口经 peer 链拖入 subagent / sandbox / jobs 等本项目未用的能力，为约 130 行自包含代码扩大依赖闭包不成比例 |

`src/server/harness/` 下其余模块与 `src/server/engine/` 的编排层为本项目自有实现，
其中运行工作区、子进程运行时与组合生成的形态参考了同作者的 agent-workflow-studio。

上游依赖各自的完整许可文本随包分发在 `node_modules/@deepseek-ai/*/LICENSE`。
