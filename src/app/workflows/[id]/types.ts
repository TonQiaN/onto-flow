/**
 * Workflow 编辑器模块内共享类型与纯函数工具。
 * 与 docs/DESIGN.md 的 API 契约（ActionDto / NodeDto / EdgeDto）严格一致。
 */
import type { Edge, Node } from "@xyflow/react";
import type { ValidationIssue } from "@/lib/graph";

export type PortKind = "text" | "file" | "json";
export type RunNodeStatus = "pending" | "running" | "success" | "failed" | "skipped";

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
  reasoningEffort: "low" | "medium" | "high" | "max";
  ports: ActionPortDto[];
  skillIds: string[];
  toolIds: string[];
}

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: PortKind;
  description: string;
  jsonSchema: string | null;
  builtin: boolean;
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

/**
 * node.data 只放展示与引用数据（Dify 模式）：
 * 持久化字段走 toNodeDto 白名单；`_` 前缀为瞬态运行状态，保存时天然剥离。
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
  const ins = action.ports
    .filter((p) => p.direction === "input")
    .map((p) => p.name);
  const outs = action.ports
    .filter((p) => p.direction === "output")
    .map((p) => p.name);
  return `${ins.join("、") || "无输入"} → ${outs.join("、") || "无输出"}`;
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
    action.ports
      .filter((p) => p.direction === direction)
      .map((p) => ({
        name: p.name,
        objectTypeId: p.objectTypeId,
        objectTypeName: p.objectTypeName,
        kind: p.kind,
      }));
  return { inputs: pick("input"), outputs: pick("output") };
}

/** 加载：NodeDto[] + Action/ObjectType 快照 → React Flow 节点 */
export function buildFlowNodes(
  dtos: NodeDto[],
  actionById: Map<string, ActionDto>,
  typeById: Map<string, ObjectTypeRow>,
): FlowNode[] {
  return dtos.map((dto) => {
    let inputs: PortSnapshot[] = [];
    let outputs: PortSnapshot[] = [];
    let label = dto.label;

    if (dto.kind === "action") {
      const action = dto.actionId ? actionById.get(dto.actionId) : undefined;
      if (action) {
        label = action.name;
        const ports = actionPortSnapshots(action);
        inputs = ports.inputs;
        outputs = ports.outputs;
      } else {
        label = dto.label || "（Action 已删除）";
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
      },
    };
  });
}

export function buildFlowEdges(dtos: EdgeDto[], nodes: FlowNode[]): Edge[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // 丢弃引用了已不存在端口的失效边（Action 端口改名/删除后遗留）。
  // 否则这些边在画布上不渲染也无法删除，却让服务端校验永久报错、阻塞运行。
  return dtos
    .filter((e) => {
      const source = nodeById.get(e.sourceNodeId);
      const target = nodeById.get(e.targetNodeId);
      if (!source || !target) return false;
      return (
        source.data.outputs.some((p) => p.name === e.sourcePort) &&
        target.data.inputs.some((p) => p.name === e.targetPort)
      );
    })
    .map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      sourceHandle: e.sourcePort,
      target: e.targetNodeId,
      targetHandle: e.targetPort,
    }));
}
