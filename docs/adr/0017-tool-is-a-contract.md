# Tool 是 OntoFlow 契约，cordis 包装归平台

推翻 AGENTS.md 当时的「A Tool is a cordis plugin with Action scope」。Tool 的作者只写
`{ name, description, parameters, output?, timeoutMs?, execute(args, ctx) }`；`ctx` 是一个很小的
稳定面（工作区路径、运行目录、临时目录、白名单环境变量、一个 `run(cmd)`），不暴露 cordis
Context。物化时由平台套上自己维护的 cordis 包装，Tool 是包装的数据。不保留裸插件通道；三个种子
Tool 改写为契约形态，专用调用入口的 digest pin 随之更新。外部能力仍走 MCP。

理由：一个 Tool 就是一整个 cordis 插件源码时，作者得懂 `name/inject/apply`、`ctx.tools.register`
的形状、JSON Schema 子集、`output.render` 的参数顺序（AGENTS.md 现行仍为这个坑留着一句：包装里写
`render: (_args, value) => JSON.stringify(value)`），种子里的
真实例子有 213 行；而上游每升一版这些 API 一动，库里每个 Tool 都可能在插件加载那一刻坏掉、整个运行
起不来。契约保住了 cordis 工具的全部运行时价值——类型化调用、`tools/result` 事件（简历 API 那道
"校验 Tool 回执带 SHA-256"的门禁靠它）、会话级收窄、`timeoutMs` 让 timeout-policy 生效——同时把
上游漂移收敛到包装一处。退化成技能脚本（模型用 bash 跑）则没有 schema 也没有事件，门禁做不了。
代价：Tool 不能再注入任意上游服务，需要的能力只能经 `ctx` 的稳定面拿；灵活性换稳定性。

第一批只落文档；PR #16（合并提交 0b63a94，2026-09-02）落地实现：`src/server/harness/tool-contract.ts`
（作者看见的 `ctx` 面）与 `tool-plugin.ts`（物化时生成的 cordis 包装），写入口拒绝引用 `@deepseek-ai/*`
的 `code`，三个种子 Tool 改为契约形态。
