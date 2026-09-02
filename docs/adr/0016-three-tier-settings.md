# 三层设置：全局基线、工作流声明、Action 收窄

设置分三层，上层声明、下层收窄，Action 层永远不开关插件：

| 层 | 拥有 | 明确不拥有 |
|---|---|---|
| 全局设置 | 组合基线与可切换行的默认值、MCP 服务器登记、凭据引用、默认停用工具、默认 AGENTS.md | 任何工作流内容 |
| 工作流设置 | 可切换插件的开关（只限目录里标为 `workflowToggle` 的行）、启用的 MCP 子集、技能集（全员可见可加载）、Tool 集（物化进运行）、工作流 AGENTS.md | Action 的 prompt |
| Action | prompt、rule、模型、思考强度、端口与出口、预载技能 ⊆ 技能集、可见 Tool ⊆ Tool 集 | 插件开关、MCP 开关 |

Skill 随之改为**目录**（`SKILL.md` + 资源文件），归工作流所有、经工作区 `.agents/skills/` 对全部
Action 可见；**预载**是 Action 把某个技能在会话开始时以显式调用注入，走上游 `renderSkillContent()`
与 `skill-invocation` 来源——等同于人在 CLI 里敲 `/skill-name`，不是往 prompt 里拼几句话。这修正
ADR-0006 里"技能不再是被引用即强制注入的 prompt 片段"一句：可以强制，但只经上游显式调用路径。
引用关系随之重画：工作流直接引用技能与 Tool，Action 只做子集选择。运行快照冻结三层；专用调用入口的
digest pin 纳入工作流设置。

理由：这套模型与 dsh 的世界观一一对应——全局是 profile / bundle，工作流是项目根（`.agents/skills`、
`AGENTS.md`），Action 是会话里的 agent——工作流作者的心智模型就是"在某个目录里起 dsh 一段段聊"。
技能与 Tool 的不对称是有意的：技能是指令，看见无害；Tool 是能力，评委不该看见归档工具。
代价：三个设置界面、`references.ts` 与删除保护重写、种子与 e2e 跟着改、技能编辑器要管资源文件；
预载有真实成本（正文进每个会话首条消息），编辑器必须把 token 量摆在开关旁边。本决定在第一批只落
文档与目录字段，实现在第二批。
