/**
 * 受理时冻结进 `runs.graph` 的那张图（ADR-0018）。
 *
 * 运行会活过图的下一次编辑，所以运行页只读这份冻结件，从不回查
 * `workflow_nodes` / `workflow_edges`。早于 ADR-0018 的运行拿到 `EMPTY_RUN_GRAPH`，
 * 走同一条渲染路径——没有「旧运行」分支。
 *
 * 纯模块：只从 `./graph` 与 `@/server/resolve` 取类型（运行时被擦除），
 * 客户端可以直接 import 这里的类型与 `parseRunGraph`。
 */
import type { GraphEdge, ResolvedPort } from "./graph";
import type { ResolvedWorkflow } from "@/server/resolve";

/** 冻结的节点：执行所需的端口，加画布重绘所需的 kind / 标签 / 坐标与实体引用。 */
export interface RunGraphNode {
  id: string;
  kind: "action" | "input" | "output";
  label: string;
  x: number;
  y: number;
  /** kind=action 时受理那一刻引用的 Action；实体后来被删也不影响这张图 */
  actionId: string | null;
  /** kind=input|output 时节点承载的 Object Type */
  objectTypeId: string | null;
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
}

export interface RunGraph {
  version: 1;
  nodes: RunGraphNode[];
  edges: GraphEdge[];
}

/** `runs.graph` 的列默认值，也是早于 ADR-0018 的运行在页面上得到的那张空画布。 */
export const EMPTY_RUN_GRAPH: RunGraph = { version: 1, nodes: [], edges: [] };

/**
 * 从受理快照构造冻结图：端口取 `resolved.nodes`（执行用的解析结果），
 * kind / 标签 / 坐标 / 实体引用取 `resolved.nodeRows`（画布上的原始行）。
 * 缺行的节点只是没有坐标可画，不影响这次运行受理。
 */
export function buildRunGraph(resolved: ResolvedWorkflow): RunGraph {
  return {
    version: 1,
    nodes: resolved.nodes.map((node) => {
      const row = resolved.nodeRows.get(node.id);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        x: row?.x ?? 0,
        y: row?.y ?? 0,
        actionId: row?.actionId ?? null,
        objectTypeId: row?.objectTypeId ?? null,
        inputs: node.inputs.map(normalizePort),
        outputs: node.outputs.map(normalizePort),
      };
    }),
    edges: resolved.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
    })),
  };
}

/**
 * 校验并归一化库里读到的图。坏数据抛错而不是静默降级：`runs.graph` 是本站自己
 * 在受理事务里写下的，读不出形状说明写入端坏了，掩盖它只会让画布画出半张图。
 */
export function parseRunGraph(value: unknown): RunGraph {
  const graph = asRecord(value, "运行图");
  if (graph.version !== 1) {
    throw new Error(`运行图版本不是 1：${JSON.stringify(graph.version)}`);
  }
  return {
    version: 1,
    nodes: asArray(graph.nodes, "运行图 nodes").map(parseNode),
    edges: asArray(graph.edges, "运行图 edges").map(parseEdge),
  };
}

const NODE_KINDS = new Set(["action", "input", "output"]);
const PORT_KINDS = new Set(["text", "file", "json"]);

function normalizePort(port: ResolvedPort): ResolvedPort {
  return {
    name: port.name,
    objectTypeId: port.objectTypeId,
    objectTypeName: port.objectTypeName,
    kind: port.kind,
    exitName: port.exitName ?? null,
    artifactPath: port.artifactPath ?? null,
  };
}

function parseNode(value: unknown, index: number): RunGraphNode {
  const node = asRecord(value, `运行图 nodes[${index}]`);
  const where = `运行图 nodes[${index}]`;
  const kind = node.kind;
  if (typeof kind !== "string" || !NODE_KINDS.has(kind)) {
    throw new Error(`${where} 的 kind 非法：${JSON.stringify(kind)}`);
  }
  return {
    id: asString(node.id, `${where}.id`),
    kind: kind as RunGraphNode["kind"],
    label: asString(node.label, `${where}.label`),
    x: asNumber(node.x, `${where}.x`),
    y: asNumber(node.y, `${where}.y`),
    actionId: asNullableString(node.actionId, `${where}.actionId`),
    objectTypeId: asNullableString(node.objectTypeId, `${where}.objectTypeId`),
    inputs: asArray(node.inputs, `${where}.inputs`).map((port, i) =>
      parsePort(port, `${where}.inputs[${i}]`),
    ),
    outputs: asArray(node.outputs, `${where}.outputs`).map((port, i) =>
      parsePort(port, `${where}.outputs[${i}]`),
    ),
  };
}

function parsePort(value: unknown, where: string): ResolvedPort {
  const port = asRecord(value, where);
  const kind = port.kind;
  if (typeof kind !== "string" || !PORT_KINDS.has(kind)) {
    throw new Error(`${where} 的 kind 非法：${JSON.stringify(kind)}`);
  }
  return {
    name: asString(port.name, `${where}.name`),
    objectTypeId: asString(port.objectTypeId, `${where}.objectTypeId`),
    objectTypeName: asString(port.objectTypeName, `${where}.objectTypeName`),
    kind: kind as ResolvedPort["kind"],
    exitName: asNullableString(port.exitName, `${where}.exitName`),
    artifactPath: asNullableString(port.artifactPath, `${where}.artifactPath`),
  };
}

function parseEdge(value: unknown, index: number): GraphEdge {
  const edge = asRecord(value, `运行图 edges[${index}]`);
  const where = `运行图 edges[${index}]`;
  return {
    id: asString(edge.id, `${where}.id`),
    sourceNodeId: asString(edge.sourceNodeId, `${where}.sourceNodeId`),
    sourcePort: asString(edge.sourcePort, `${where}.sourcePort`),
    targetNodeId: asString(edge.targetNodeId, `${where}.targetNodeId`),
    targetPort: asString(edge.targetPort, `${where}.targetPort`),
  };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} 不是数组`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} 不是字符串`);
  return value;
}

function asNullableString(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${where} 不是字符串或 null`);
  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where} 不是有限数字`);
  }
  return value;
}
