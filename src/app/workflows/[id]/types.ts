/**
 * Workflow 编辑器的图形状（NodeDto / EdgeDto / WorkflowDetail / ActionItem）与画布用的纯函数工具。
 * 与 docs/DESIGN.md 的 API 契约（ActionDto / NodeDto / EdgeDto）严格一致。
 * 被四个库页与画布检查器共用的那批实体行（ActionDto / ObjectTypeRow / SkillRow / ToolRow /
 * ModelRow）不在这里：它们归 @/components/library 的 entity-dto.ts，本目录与库页从同一处取。
 */
import type { Edge } from "@xyflow/react";
import type { FlowNode, NodeMeta, PortSnapshot } from "@/components/canvas/node-model";
import type {
  ActionDto,
  ActionPortDto,
  FolderRef,
  ModelRow,
  ObjectTypeRow,
  SkillRow,
  ToolRow,
} from "@/components/library";
import type { ValidationIssue } from "@/lib/graph";
import {
  COMPOSITION_TOGGLE_KEYS,
  estimateTokens,
  type CompositionToggles,
  type WorkflowSettings,
} from "@/lib/workflow-settings";

/** 列表接口（DESIGN-V2 第一节信封）在 ActionDto 上追加的公共字段 */
export interface ActionItem extends ActionDto {
  folder: FolderRef | null;
  refCount: number;
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

/** GET/PUT /api/workflows/[id] 里的 workflow 全量定义（ADR-0016：指令、设置与两个集合） */
export interface WorkflowDetailRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  settings: WorkflowSettings;
  skillIds: string[];
  toolIds: string[];
}

export interface WorkflowDetail {
  workflow: WorkflowDetailRow;
  nodes: NodeDto[];
  edges: EdgeDto[];
  issues: ValidationIssue[];
}

/** 工作流的技能集与 Tool 集 id（按 position）；画布检查器据此收窄候选 */
export interface WorkflowSets {
  skillIds: string[];
  toolIds: string[];
}

/** 五个可按工作流切换的插件开关的界面文案；键顺序与 COMPOSITION_TOGGLE_KEYS 一致 */

/** 三态开关的选项值：继承全局 / 强制开 / 强制关 */
export type ToggleChoice = "inherit" | "on" | "off";

export function toggleChoice(value: boolean | undefined): ToggleChoice {
  if (value === undefined) return "inherit";
  return value ? "on" : "off";
}

export function fromToggleChoice(choice: ToggleChoice): boolean | undefined {
  if (choice === "inherit") return undefined;
  return choice === "on";
}

/** 只保留写了覆盖的键：PUT 载荷里不能出现 undefined 值的键，服务端按键存在即覆盖 */
export function pruneToggles(toggles: Partial<CompositionToggles>): Partial<CompositionToggles> {
  const result: Partial<CompositionToggles> = {};
  for (const key of COMPOSITION_TOGGLE_KEYS) {
    const value = toggles[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/** 按集合顺序取出库里在集合中的行；集合里已不存在于库的 id 静默跳过 */
export function pickBySet<T extends { id: string }>(
  rows: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** 已选中但不在集合里的 id（保序）：Action 从库里选的预载/可见 Tool 越出了工作流集合 */
export function outsideSet(selected: readonly string[], set: readonly string[]): string[] {
  const inSet = new Set(set);
  return selected.filter((id) => !inSet.has(id));
}

/** 切换一个 id 在数组里的存在；保序，不重复 */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** 预载时整段进入会话首条消息的 token 估算 */
export function skillTokenEstimate(skill: Pick<SkillRow, "content">): number {
  return estimateTokens(skill.content);
}

/** 进入每个可见会话工具清单的 token 估算：公名、描述与参数 schema 三者 */
export function toolTokenEstimate(
  tool: Pick<ToolRow, "publicName" | "description" | "parameters">,
): number {
  return estimateTokens(
    JSON.stringify({
      name: tool.publicName,
      description: tool.description,
      parameters: tool.parameters,
    }),
  );
}

/**
 * 画布上每个技能 / Tool 被哪些 Action 节点预载 / 看见：设置页据此提示「取消勾选会让保存失败」，
 * 因为服务端在保存时校验预载 ⊆ 技能集、可见 Tool ⊆ Tool 集。同一 Action 放了多个节点只算一次。
 */
export function actionNamesByEntity(
  nodes: readonly NodeDto[],
  actionById: ReadonlyMap<string, ActionDto>,
  field: "preloadSkillIds" | "toolIds",
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "action" || !node.actionId || seen.has(node.actionId)) continue;
    seen.add(node.actionId);
    const action = actionById.get(node.actionId);
    if (!action) continue;
    for (const id of action[field]) {
      const names = result.get(id) ?? [];
      if (!names.includes(action.name)) names.push(action.name);
      result.set(id, names);
    }
  }
  return result;
}

/** Action 端口签名：「输入们 → 输出们」 */
export function portSignature(action: ActionDto): string {
  const ins = actionPorts(action, "input").map((p) => p.name);
  const outs = actionPorts(action, "output").map((p) => p.name);
  return `${ins.join("、") || "无输入"} → ${outs.join("、") || "无输出"}`;
}

/** 按 position 排序后的某方向端口 */
export function actionPorts(action: ActionDto, direction: "input" | "output"): ActionPortDto[] {
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
      exitName: p.exitName,
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
    const out = source.data.outputs.find((p) => p.name === (e.sourceHandle ?? "value"));
    const inp = target.data.inputs.find((p) => p.name === (e.targetHandle ?? "value"));
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
        exitName: null,
      };
      if (dto.kind === "input") outputs = [port];
      else inputs = [port];
      label =
        dto.label ||
        (dto.kind === "input" ? `输入·${port.objectTypeName}` : `输出·${port.objectTypeName}`);
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
