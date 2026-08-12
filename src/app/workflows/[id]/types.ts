/**
 * Workflow 编辑器模块内共享类型与纯函数工具。
 * 与 docs/DESIGN.md 的 API 契约（ActionDto / NodeDto / EdgeDto）严格一致。
 */
import type { Edge, Node } from "@xyflow/react";
import type { FolderRef } from "@/components/library";
import type { ValidationIssue } from "@/lib/graph";

export type PortKind = "text" | "file" | "json";
export type ReasoningEffort = "low" | "medium" | "high" | "max";
export type RunNodeStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  max: "最大",
};

export const KIND_LABEL: Record<PortKind, string> = {
  text: "文本",
  file: "文件",
  json: "JSON",
};

export interface PortSnapshot {
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: PortKind;
}

export interface ActionPortDto extends PortSnapshot {
  id: string;
  direction: "input" | "output";
  position: number;
}

export interface ActionDto {
  id: string;
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  ports: ActionPortDto[];
  skillIds: string[];
  toolIds: string[];
}

/** 列表接口（DESIGN-V2 第一节信封）在 ActionDto 上追加的公共字段 */
export interface ActionItem extends ActionDto {
  folder: FolderRef | null;
  refCount: number;
}

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: PortKind;
  description: string;
  jsonSchema: string | null;
  builtin: boolean;
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
}

export interface ToolRow {
  id: string;
  name: string;
  description: string;
}

export interface NodeDto {
  id: string;
  kind: "action" | "input" | "output";
  actionId?: string | null;
  objectTypeId?: string | null;
  label: string;
  x: number;
  y: number;
}

export interface EdgeDto {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export interface WorkflowDetail {
  workflow: { id: string; name: string; description: string };
  nodes: NodeDto[];
  edges: EdgeDto[];
  issues: ValidationIssue[];
}

/** 节点卡片上的只读展示信息，不参与持久化（`_` 前缀，toNodeDto 天然剥离） */
export interface NodeMeta {
  description: string;
  modelName: string;
  effort: ReasoningEffort;
  refCount: number;
  /** Action 已被删除 / 引用失效 */
  missing?: boolean;
}

/**
 * node.data 只放展示与引用数据（Dify 模式）：
 * 持久化字段走 toNodeDto 白名单；`_` 前缀为瞬态字段，保存时天然剥离。
 */
export type FlowNodeData = {
  kind: "action" | "input" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  inputs: PortSnapshot[];
  outputs: PortSnapshot[];
  /** 瞬态：本次运行中该节点的状态（SSE snapshot 写入，保存时剥离） */
  _status?: RunNodeStatus;
  /** 瞬态：卡片副信息（模型、思考强度、引用数…） */
  _meta?: NodeMeta;
};

export type FlowNode = Node<FlowNodeData, "flowNode">;

const PALETTE = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#e11d48",
  "#0ea5e9",
  "#a855f7",
];

/** objectTypeId 稳定哈希取色：同类型同色（ComfyUI 风端口配色） */
export function typeColor(objectTypeId: string): string {
  let h = 0;
  for (let i = 0; i < objectTypeId.length; i++) {
    h = (h * 31 + objectTypeId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** Action 端口签名：「输入们 → 输出们」 */
export function portSignature(action: ActionDto): string {
  const ins = actionPorts(action, "input").map((p) => p.name);
  const outs = actionPorts(action, "output").map((p) => p.name);
  return `${ins.join("、") || "无输入"} → ${outs.join("、") || "无输出"}`;
}

/** 按 position 排序后的某方向端口 */
export function actionPorts(
  action: ActionDto,
  direction: "input" | "output",
): ActionPortDto[] {
  return action.ports
    .filter((p) => p.direction === direction)
    .sort((a, b) => a.position - b.position);
}

/** 保存序列化：只取白名单字段，`_` 前缀瞬态字段与 selected 等自动剥离 */
export function toNodeDto(node: FlowNode): NodeDto {
  return {
    id: node.id,
    kind: node.data.kind,
    actionId: node.data.actionId ?? null,
    objectTypeId: node.data.objectTypeId ?? null,
    label: node.data.label,
    x: node.position.x,
    y: node.position.y,
  };
}

export function toEdgeDto(edge: Edge): EdgeDto {
  return {
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePort: edge.sourceHandle ?? "value",
    targetNodeId: edge.target,
    targetPort: edge.targetHandle ?? "value",
  };
}

/** 从 Action 构造画布节点的端口快照 */
export function actionPortSnapshots(action: ActionDto): {
  inputs: PortSnapshot[];
  outputs: PortSnapshot[];
} {
  const pick = (direction: "input" | "output"): PortSnapshot[] =>
    actionPorts(action, direction).map((p) => ({
      name: p.name,
      objectTypeId: p.objectTypeId,
      objectTypeName: p.objectTypeName,
      kind: p.kind,
    }));
  return { inputs: pick("input"), outputs: pick("output") };
}

/** Action → 节点卡片副信息 */
export function actionMeta(
  action: ActionItem | ActionDto,
  modelById: Map<string, ModelRow>,
): NodeMeta {
  const meta = action as Partial<ActionItem>;
  return {
    description: action.description,
    modelName: modelById.get(action.modelId)?.displayName ?? "未知模型",
    effort: action.reasoningEffort,
    refCount: meta.refCount ?? 0,
  };
}

/** Action 被删除时的兜底节点副信息 */
export function missingMeta(): NodeMeta {
  return {
    description: "",
    modelName: "—",
    effort: "max",
    refCount: 0,
    missing: true,
  };
}

/** 用最新的 Action 定义刷新单个节点的 data（端口、标题、副信息一起更新） */
export function applyActionToNode(
  node: FlowNode,
  action: ActionDto,
  modelById: Map<string, ModelRow>,
): FlowNode {
  const ports = actionPortSnapshots(action);
  return {
    ...node,
    data: {
      ...node.data,
      actionId: action.id,
      label: action.name,
      inputs: ports.inputs,
      outputs: ports.outputs,
      _meta: actionMeta(action, modelById),
    },
  };
}

/** 丢弃已失效的连线：端口被删/改名，或两端 Object Type 不再相同 */
export function pruneEdges(nodes: FlowNode[], edges: Edge[]): Edge[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return edges.filter((e) => {
    const source = nodeById.get(e.source);
    const target = nodeById.get(e.target);
    if (!source || !target) return false;
    const out = source.data.outputs.find(
      (p) => p.name === (e.sourceHandle ?? "value"),
    );
    const inp = target.data.inputs.find(
      (p) => p.name === (e.targetHandle ?? "value"),
    );
    if (!out || !inp) return false;
    // 端口名没变但绑定的 Object Type 改了，连线同样失效（ADR-0002 严格 nominal 类型，
    // 与 lib/graph.ts validateGraph 的判定一致）。只比端口名会在画布上留下类型不匹配的
    // 连线，用户看不出问题、保存时才被服务端打回。
    return out.objectTypeId === inp.objectTypeId;
  });
}

/** 加载：NodeDto[] + Action/ObjectType 快照 → React Flow 节点 */
export function buildFlowNodes(
  dtos: NodeDto[],
  actionById: Map<string, ActionItem>,
  typeById: Map<string, ObjectTypeRow>,
  modelById: Map<string, ModelRow>,
): FlowNode[] {
  return dtos.map((dto) => {
    let inputs: PortSnapshot[] = [];
    let outputs: PortSnapshot[] = [];
    let label = dto.label;
    let meta: NodeMeta | undefined;

    if (dto.kind === "action") {
      const action = dto.actionId ? actionById.get(dto.actionId) : undefined;
      if (action) {
        label = action.name;
        const ports = actionPortSnapshots(action);
        inputs = ports.inputs;
        outputs = ports.outputs;
        meta = actionMeta(action, modelById);
      } else {
        label = dto.label || "（Action 已删除）";
        meta = missingMeta();
      }
    } else {
      const type = dto.objectTypeId ? typeById.get(dto.objectTypeId) : undefined;
      const port: PortSnapshot = {
        name: "value",
        objectTypeId: dto.objectTypeId ?? "",
        objectTypeName: type?.name ?? "未知类型",
        kind: type?.kind ?? "text",
      };
      if (dto.kind === "input") outputs = [port];
      else inputs = [port];
      label =
        dto.label ||
        (dto.kind === "input"
          ? `输入·${port.objectTypeName}`
          : `输出·${port.objectTypeName}`);
    }

    return {
      id: dto.id,
      type: "flowNode" as const,
      position: { x: dto.x, y: dto.y },
      data: {
        kind: dto.kind,
        actionId: dto.actionId ?? null,
        objectTypeId: dto.objectTypeId ?? null,
        label,
        inputs,
        outputs,
        _meta: meta,
      },
    };
  });
}

export function buildFlowEdges(dtos: EdgeDto[], nodes: FlowNode[]): Edge[] {
  // 失效边不渲染也无法删除，却让服务端校验永久报错、阻塞运行，所以直接丢弃。
  return pruneEdges(
    nodes,
    dtos.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      sourceHandle: e.sourcePort,
      target: e.targetNodeId,
      targetHandle: e.targetPort,
    })),
  );
}
