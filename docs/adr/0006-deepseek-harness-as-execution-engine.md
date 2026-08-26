# 用 DeepSeek Harness 取代 opencode 作为执行引擎

推翻 [ADR-0001](0001-opencode-as-execution-engine.md)。Action 的执行不再交给一个常驻的共享
opencode server，而是把 DeepSeek Harness（`dsh`）作为唯一执行引擎吸收进本仓库：以 npm 锁定
`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 整族依赖闭包，由本项目自己 `boot()` 起 cordis
组合树，不依赖任何事先启动的外部进程。模型走 `llm-deepseek` 的 `deepseek-official` 路由，
默认模型 `deepseek-v4-flash-vision-exp`；凭据以引用名（`DEEPSEEK_API_KEY`）进入，值不落配置、
不落日志、不落运行目录。Skill 随之改用 dsh 的技能子系统：技能是模型看描述按需加载的能力，
不再是被引用即强制注入的 prompt 片段。

理由：opencode 的共享 server 是进程外的单点——端口被别的工作目录的实例占住时新配置静默失效、
一个 Tool 会写进另一个数据库，这类故障已经反复出现，而 `getOpencodeUrl` 复用既有端口的行为
让它无法从本仓库内根治。dsh 的"一切皆插件"结构让会话、工具、技能、MCP、日志、用量都成为可
从配置替换的行，正是这个工作台需要的编排底座；同族的 `@earendil-works/pi-ai` 适配器还让
OpenAI 兼容网关成为配置而非代码改动。代价是本仓库从此绑定一个处于 developer preview、明确
声明会有破坏性变更的上游，升级要当作代码变更来评审。
