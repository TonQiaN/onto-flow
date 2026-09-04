/**
 * 四个可被引用的库（Action / Object Type / Skill / Tool）与模型表在客户端的行形状，
 * 逐字段对着各 API 实际返回的那一份写：
 *   ActionDto / ActionPortDto  ← loadActionDtos（GET /api/actions 的列表项与 /api/actions/[id]）
 *   ObjectTypeRow / SkillRow / ToolRow ← 对应库的整行（列表、详情、POST / PUT 回包同形）
 *   ModelRow ← GET /api/models 全表
 * 放在这里而不是某个页面目录：Action 库页与画布检查器传的是同一批对象——
 * `workflows/[id]/action-inspector.tsx` 把工作流侧的行直接喂给 `actions/action-editor.tsx`，
 * 此前两组各声明一份、只靠结构兼容才编得过，往其中一份加必填字段红的会是调用点而不是加字段那行。
 * 服务端 `src/server/writers/action.ts` 里的同名 `ActionDto` 是另一份：客户端不从 @/server
 * 导入任何东西，那道边界比这里的去重优先。
 */
import type { PortKind, PortSnapshot, ReasoningEffort } from "@/components/canvas/node-model";

export interface ActionPortDto extends PortSnapshot {
  id: string;
  direction: "input" | "output";
  position: number;
  /** 输出端口写到工作区哪个文件（ADR-0008）；输入端口为 null */
  artifactPath: string | null;
}

export interface ActionDto {
  id: string;
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  maxReentries: number;
  onExhausted: "fail" | "accept";
  ports: ActionPortDto[];
  /** 会话开始时以 /技能 注入的技能（ADR-0016）；必须 ⊆ 所在工作流的技能集 */
  preloadSkillIds: string[];
  /** 本 Action 会话看得见的 Tool；必须 ⊆ 所在工作流的 Tool 集 */
  toolIds: string[];
  /** 可选：loadActionDtos 今天不带时间戳，其余四个库的行都带 */
  updatedAt?: string;
}

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: PortKind;
  description: string;
  /** kind=json 时可选的 JSON Schema（序列化字符串） */
  jsonSchema: string | null;
  /** 内置类型（text / file / json）不可改不可删 */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  /** SKILL.md 正文（不含 frontmatter）；预载时整段进入会话首条消息，估算成本用它 */
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRow {
  id: string;
  /** 库里的展示名（中文） */
  name: string;
  /** 模型可见的工具名，全库唯一 */
  publicName: string;
  description: string;
  /** 参数的对象根 JSON Schema；连同公名与描述一起进入会话的工具清单 */
  parameters: Record<string, unknown>;
  /** 返回值的对象根 JSON Schema；省略即不校验返回值 */
  output: Record<string, unknown> | null;
  /** 单次调用预算（毫秒） */
  timeoutMs: number | null;
  /** execute 模块源码（ADR-0017） */
  code: string;
  createdAt: string;
  updatedAt: string;
}
