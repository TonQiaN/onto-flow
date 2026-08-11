# CONTEXT

本项目的领域术语表（ubiquitous language）。只记语义，不记实现。

## 术语

### Action（动作）
工作台的原子单位，**一等公民的可复用库实体**，有独立的管理页面（增删改查）。
一个 Action 完整自带：
- **Prompt**：描述这个 Action 要做什么
- **Rule**：执行该 Action 时必须遵守的规则
- 引用的 **Skill** 列表（强制注入，保证 100% 生效）
- 引用的 **Tool** 列表（执行时可调用）
- **模型**与**思考强度**

同一个 Action 可被多个 Workflow 复用；修改 Action 会影响所有引用它的 Workflow。

### Workflow（工作流）
由节点和连线构成的 DAG，把多个 Action 的 input/output 连接起来编排执行。

### 节点（Node）
Workflow 画布上对某个 Action 的**纯引用**。节点不允许实例级覆盖 Action 的任何属性
（想改就改 Action 本身，或复制出新 Action）。

### Skill（技能）
独立管理的命名 prompt 片段。被 Action 引用后在执行时**强制注入**会话——
不依赖模型自主触发（区别于 opencode 原生的按需 skill 机制）。

### Tool（工具）
独立管理的 TypeScript 脚本，内容即一个完整的 opencode custom tool 定义
（description + 参数 schema + execute）。被 Action 引用后，仅在该 Action
执行时物化给会话，模型可带参数调用并获得返回结果。未被引用的 Tool 对会话不可见。

### Object Type（对象类型）
第四个可管理实体：端口类型注册表。每个 Object Type 有名字（如 `需求文件`、
`集采计划`、`评价`）和基础形态（`text` / `file` / `json` 之一），json 形态可
附带 JSON Schema。内置 `text` / `file` / `json` 三个通用类型兜底。

### 端口（Port）
Action 声明的命名输入/输出，每个端口绑定一个 Object Type。

### 输入节点（Input Node）
Workflow 的入口内置节点，绑定一个 Object Type；运行时由用户在此提供值
（填文本或上传文件）。

### 输出节点（Output Node）
标记 Workflow 级最终产出的内置节点，运行后在此展示结果。

### 运行（Run）
一次 Workflow 执行的完整记录：按拓扑序逐节点执行，记录每个节点的输入、输出、
状态、会话标识与事件日志。节点失败则下游跳过、整次运行失败；无断点续跑。

### 思考强度（Reasoning Effort）
Action 的推理深度档位：`low / medium / high / max` 四档，默认 `max`。

### 连线（Edge）
Workflow 中上游节点输出端口到下游节点输入端口的连接。**严格同类型才能连**
（nominal typing，ComfyUI 式）。一个输入端口最多接一条线；一个输出端口可扇出。
