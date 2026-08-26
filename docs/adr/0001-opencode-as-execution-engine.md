# 用 opencode 作为唯一的 Action 执行引擎

> 2026-08-26：已被 [ADR-0006](0006-deepseek-harness-as-execution-engine.md) 推翻——共享 opencode server 是进程外单点，端口复用导致的静默失效无法从本仓库内根治。

Action 需要模型推理、工具调用、结构化输出与会话隔离。我们不直连模型 API（如
@ai-sdk / OpenAI SDK），而是把 opencode 作为唯一执行引擎：工作台后端常驻一个
共享 opencode server（`@opencode-ai/sdk`），每次 Action 运行新建一个全新
session，在独立工作区目录里物化该 Action 引用的 custom tools，rule 与 skills
以上下文消息强制注入，多输出经 JSON Schema 结构化返回。

理由：opencode 已解决工具执行循环、模型接入（本机已配好 deepseek-v4-flash 与
gpt-5.6-luna）、推理强度档位与事件流；直连 API 则要求我们自己重写工具调用循环
与 provider 适配。代价是对 opencode 的 server 生命周期与版本行为产生强依赖——
这是有意为之的取舍。
