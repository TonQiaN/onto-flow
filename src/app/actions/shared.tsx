/** actions 管理页内部共享的类型（仅本目录使用） */
import type { PortKind, ReasoningEffort } from "@/components/canvas/node-model";

export interface ActionPortDto {
  id: string;
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: PortKind;
  position: number;
  /** 输出端口写到工作区哪个文件（ADR-0008）；输入端口为 null */
  artifactPath: string | null;
  /** 输出端口所属的具名出口（ADR-0009）；无分支时为 null */
  exitName: string | null;
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
  updatedAt?: string;
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
}

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: PortKind;
  description: string;
  builtin: boolean;
}

/** 预载候选：列表 GET 的行自带正文，预载的 token 估算据此算 */
export interface SkillRow {
  id: string;
  name: string;
  description: string;
  /** SKILL.md 正文；预载时整段进入会话首条消息 */
  content: string;
}

/** 可见 Tool 候选：展示名与模型看见的公名 */
export interface ToolRow {
  id: string;
  name: string;
  publicName: string;
  description: string;
}
