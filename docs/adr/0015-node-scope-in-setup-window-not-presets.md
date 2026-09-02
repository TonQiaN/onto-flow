# Action 级组合在会话创建窗口收窄，不用 agent preset

一个 Action 会话与其它会话的差别——结构化输出 schema、步数上限、思考强度、工具收窄、技能预载——
全部由 `ontoflow-rpc` 在会话创建窗口（上游的 setup window）里注册到该会话自己的 scope 上，经 RPC 的
`nodeOptions` 传入；不用上游 `dsh-agent-presets`（一份 `agent.cordis.yml` 挂成常驻组合、会话认父
过去）。Action 只做收窄、从不扩张：它不能开关插件，能开关的只有工作流设置（ADR-0016）。

理由：Action 的定义住在数据库里并在运行受理时冻结，不是磁盘上的一组 yml 目录；每次运行一个进程，
没有"常驻挂载、多个会话共用"的对象；而 Action 之间真正的差别只有收窄这一种，restrict + guard +
几个 waterfall 监听器就够了。preset 解决的是长驻宿主里按会话换整套能力的问题，那不是本项目的问题。
代价：上游的插件清单与 Web 面板看不见按 Action 的组合；将来上游若出现只能经 preset 生效的按 agent
插件，本项目得自己写注册代码。
