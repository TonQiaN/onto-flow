# 模型不得自起 agent

上游的委派与自编排整族——`subagent` 及其全部 provider 与工具、`workflow` / `tool-workflow` /
`tool-ralph`、`goal` 三件套、`jobs` / `tool-jobs`、`schedule`、实验性 Agent Teams——一律不挂；
`tool-bash` 因此关掉 `run_in_background`。编排只有一种来源：人画的工作流图，扇出、汇总、回边都是
图的形状（ADR-0009）。

理由：四条都是查实的。一、子 agent 获得全新的扁平注册作用域，上游明言"父级所有权不会导入父 agent
的工具限制"——评委 Action 起一个子 agent，子 agent 就看得见归档 Tool 与全局停用的工具，会话级收窄
当场失效。二、`node_usage` 按会话 id 归节点，子会话是新 id，费用不归任何节点。三、轨迹面板按
`nodeId` / `nodeId#N` 枚举会话，子会话不可见；步数守卫注册在父会话 scope 上，子会话没有。
四、上游的 `workflow` 是模型写的编排脚本、`goal` 是模型自己的循环，与人画的图并存会让"运行为什么
这样跑"没有单一答案。代价：一个 Action 内部没有并行——"并行读三十页"这类需求只能表达为图上的扇出，
后台作业也没有，长命令靠 bash 的超时与拆节点解决。
