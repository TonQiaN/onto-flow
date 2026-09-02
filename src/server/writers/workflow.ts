import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPreloads,
  actionTools,
  actions,
  db,
  objectTypes,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflowSkills,
  workflowTools,
  workflows,
} from "@/db";
import {
  COMPOSITION_TOGGLE_KEYS,
  EMPTY_WORKFLOW_SETTINGS,
  type CompositionToggles,
  type WorkflowSettings,
  WORKFLOW_INSTRUCTIONS_MAX_BYTES,
} from "@/lib/workflow-settings";
import { MCP_SERVER_NAME_PATTERN } from "@/server/harness/entries";
import { assertSafeId } from "@/server/harness/ids";
import { recordRevision } from "@/server/revisions";
import { asObject, parseIdArray, type WriteResult, writeFail, writeOk } from "./types";

export interface NodePayload {
  id: string;
  kind: "action" | "input" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  x: number;
  y: number;
}

export interface EdgePayload {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export type WorkflowRow = typeof workflows.$inferSelect;

/** 工作流的三层设置字段（ADR-0016）：指令、开关覆盖与 MCP 子集、技能集、Tool 集。 */
export interface WorkflowSettingsPayload {
  instructions: string;
  settings: WorkflowSettings;
  skillIds: string[];
  toolIds: string[];
}

/** 修订 payload 与 GET 都用这一份完整定义。 */
export interface WorkflowDefinition extends WorkflowSettingsPayload {
  name: string;
  description: string;
  nodes: NodePayload[];
  edges: EdgePayload[];
}

function parseWorkflowSettings(raw: unknown): WriteResult<WorkflowSettings> {
  if (raw === undefined) return writeOk(EMPTY_WORKFLOW_SETTINGS);
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "settings 必须是 JSON 对象");
  const body = parsed.body;
  for (const key of Object.keys(body)) {
    if (key !== "toggles" && key !== "mcpServers")
      return writeFail(400, `settings 不认识的字段：「${key}」`);
  }

  const toggles: Partial<CompositionToggles> = {};
  if (body.toggles !== undefined) {
    const rawToggles = asObject(body.toggles);
    if (!rawToggles.ok) return writeFail(400, "settings.toggles 必须是 JSON 对象");
    for (const [key, value] of Object.entries(rawToggles.body)) {
      if (!(COMPOSITION_TOGGLE_KEYS as readonly string[]).includes(key))
        return writeFail(400, `settings.toggles 不认识的开关：「${key}」`);
      if (typeof value !== "boolean")
        return writeFail(400, `settings.toggles.${key} 必须是布尔值`);
      toggles[key as keyof CompositionToggles] = value;
    }
  }

  const mcpServers: string[] = [];
  if (body.mcpServers !== undefined) {
    if (!Array.isArray(body.mcpServers))
      return writeFail(400, "settings.mcpServers 必须是字符串数组");
    for (const item of body.mcpServers as unknown[]) {
      if (typeof item !== "string")
        return writeFail(400, "settings.mcpServers 必须是字符串数组");
      // 只校验形状不校验登记：全局登记表可以在工作流之后变化，受理时按当时的登记表取交集。
      if (!MCP_SERVER_NAME_PATTERN.test(item))
        return writeFail(400, `MCP 服务器名「${item}」非法：只允许字母数字与 -_，最长 32 位`);
      if (!mcpServers.includes(item)) mcpServers.push(item);
    }
  }

  return writeOk({ toggles, mcpServers });
}

/**
 * 三层设置字段：缺省的键沿用 current（画布保存只发图，不该把技能集清空），
 * 每一项一旦出现就整体替换。
 */
function parseSettingsPayload(
  body: Record<string, unknown>,
  current: WorkflowSettingsPayload,
): WriteResult<WorkflowSettingsPayload> {
  let instructions = current.instructions;
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string")
      return writeFail(400, "instructions 必须是字符串");
    if (Buffer.byteLength(body.instructions, "utf8") > WORKFLOW_INSTRUCTIONS_MAX_BYTES)
      return writeFail(400, "工作流指令不能超过 64 KiB");
    instructions = body.instructions;
  }

  let settings = current.settings;
  if (body.settings !== undefined) {
    const parsed = parseWorkflowSettings(body.settings);
    if (!parsed.ok) return parsed;
    settings = parsed.data;
  }

  let skillIds = current.skillIds;
  if (body.skillIds !== undefined) {
    const ids = parseIdArray(body.skillIds);
    if (!ids) return writeFail(400, "skillIds 必须是字符串数组");
    if (ids.length > 0) {
      const found = new Set(
        db.select({ id: skills.id }).from(skills).where(inArray(skills.id, ids)).all().map((r) => r.id),
      );
      const missing = ids.find((s) => !found.has(s));
      if (missing !== undefined) return writeFail(400, `技能集里的技能不存在：${missing}`);
    }
    skillIds = ids;
  }

  let toolIds = current.toolIds;
  if (body.toolIds !== undefined) {
    const ids = parseIdArray(body.toolIds);
    if (!ids) return writeFail(400, "toolIds 必须是字符串数组");
    if (ids.length > 0) {
      const found = new Set(
        db.select({ id: tools.id }).from(tools).where(inArray(tools.id, ids)).all().map((r) => r.id),
      );
      const missing = ids.find((t) => !found.has(t));
      if (missing !== undefined) return writeFail(400, `Tool 集里的 Tool 不存在：${missing}`);
    }
    toolIds = ids;
  }

  return writeOk({ instructions, settings, skillIds, toolIds });
}

/** 图载荷：节点、连线，以及每个 Action 节点的预载 ⊆ 技能集、可见 Tool ⊆ Tool 集。 */
function parseGraphPayload(
  body: Record<string, unknown>,
  sets: { skillIds: readonly string[]; toolIds: readonly string[] },
): WriteResult<{ nodes: NodePayload[]; edges: EdgePayload[] }> {
  if (!Array.isArray(body.nodes)) return writeFail(400, "nodes 必须是数组");
  if (!Array.isArray(body.edges)) return writeFail(400, "edges 必须是数组");

  const nodes: NodePayload[] = [];
  const nodeIds = new Set<string>();
  for (const item of body.nodes as unknown[]) {
    if (typeof item !== "object" || item === null)
      return writeFail(400, "节点格式不正确");
    const n = item as Record<string, unknown>;
    const nodeId = typeof n.id === "string" ? n.id : "";
    if (!nodeId) return writeFail(400, "节点缺少 id");
    try {
      assertSafeId("节点 id", nodeId);
    } catch {
      return writeFail(
        400,
        "节点 id 只能由字母数字开头，并只含字母数字、点、下划线或连字符，且不能超过 120 个 ASCII 字符",
      );
    }
    if (nodeIds.has(nodeId)) return writeFail(400, `节点 id 重复：${nodeId}`);
    nodeIds.add(nodeId);
    const kind = n.kind;
    if (kind !== "action" && kind !== "input" && kind !== "output")
      return writeFail(400, "节点 kind 必须是 action/input/output 之一");
    const label = typeof n.label === "string" ? n.label : "";
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    if (kind === "action") {
      const actionId = typeof n.actionId === "string" ? n.actionId : "";
      if (!actionId)
        return writeFail(400, `Action 节点「${label || nodeId}」缺少 actionId`);
      nodes.push({
        id: nodeId,
        kind,
        actionId,
        objectTypeId: null,
        label,
        x,
        y,
      });
    } else {
      const objectTypeId =
        typeof n.objectTypeId === "string" ? n.objectTypeId : "";
      if (!objectTypeId)
        return writeFail(
          400,
          `输入/输出节点「${label || nodeId}」缺少 objectTypeId`,
        );
      nodes.push({
        id: nodeId,
        kind,
        actionId: null,
        objectTypeId,
        label,
        x,
        y,
      });
    }
  }

  const actionIds = [
    ...new Set(nodes.flatMap((n) => (n.actionId !== null ? [n.actionId] : []))),
  ];
  if (actionIds.length > 0) {
    const actionNames = new Map(
      db
        .select({ id: actions.id, name: actions.name })
        .from(actions)
        .where(inArray(actions.id, actionIds))
        .all()
        .map((r) => [r.id, r.name]),
    );
    if (actionIds.some((a) => !actionNames.has(a)))
      return writeFail(400, "节点引用的 Action 不存在");

    // Action 是共享库实体，它的预载与可见 Tool 是在库里选的；只有放进这个工作流时
    // 才知道集合是什么，所以子集关系在这里挡（运行受理再挡一次，答 422）。
    const skillSet = new Set(sets.skillIds);
    const preloads = db
      .select({ actionId: actionPreloads.actionId, skillId: actionPreloads.skillId, skillName: skills.name })
      .from(actionPreloads)
      .innerJoin(skills, eq(actionPreloads.skillId, skills.id))
      .where(inArray(actionPreloads.actionId, actionIds))
      .orderBy(asc(actionPreloads.position))
      .all();
    for (const row of preloads) {
      if (!skillSet.has(row.skillId))
        return writeFail(
          400,
          `Action「${actionNames.get(row.actionId)}」预载的技能「${row.skillName}」不在工作流技能集里，请先在工作流设置里加入`,
        );
    }
    const toolSet = new Set(sets.toolIds);
    const visibleTools = db
      .select({ actionId: actionTools.actionId, toolId: actionTools.toolId, toolName: tools.name })
      .from(actionTools)
      .innerJoin(tools, eq(actionTools.toolId, tools.id))
      .where(inArray(actionTools.actionId, actionIds))
      .all();
    for (const row of visibleTools) {
      if (!toolSet.has(row.toolId))
        return writeFail(
          400,
          `Action「${actionNames.get(row.actionId)}」可见的 Tool「${row.toolName}」不在工作流 Tool 集里，请先在工作流设置里加入`,
        );
    }
  }
  const typeIds = [
    ...new Set(
      nodes.flatMap((n) => (n.objectTypeId !== null ? [n.objectTypeId] : [])),
    ),
  ];
  if (typeIds.length > 0) {
    const found = new Set(
      db
        .select({ id: objectTypes.id })
        .from(objectTypes)
        .where(inArray(objectTypes.id, typeIds))
        .all()
        .map((r) => r.id),
    );
    if (typeIds.some((t) => !found.has(t)))
      return writeFail(400, "节点引用的对象类型不存在");
  }

  const edges: EdgePayload[] = [];
  const edgeIds = new Set<string>();
  for (const item of body.edges as unknown[]) {
    if (typeof item !== "object" || item === null)
      return writeFail(400, "连线格式不正确");
    const e = item as Record<string, unknown>;
    const edgeId =
      typeof e.id === "string" && e.id !== "" ? e.id : crypto.randomUUID();
    if (edgeIds.has(edgeId)) return writeFail(400, `连线 id 重复：${edgeId}`);
    edgeIds.add(edgeId);
    const sourceNodeId =
      typeof e.sourceNodeId === "string" ? e.sourceNodeId : "";
    const targetNodeId =
      typeof e.targetNodeId === "string" ? e.targetNodeId : "";
    if (!nodeIds.has(sourceNodeId))
      return writeFail(400, "连线的 sourceNodeId 不在本次提交的节点中");
    if (!nodeIds.has(targetNodeId))
      return writeFail(400, "连线的 targetNodeId 不在本次提交的节点中");
    const sourcePort = typeof e.sourcePort === "string" ? e.sourcePort : "";
    const targetPort = typeof e.targetPort === "string" ? e.targetPort : "";
    if (!sourcePort || !targetPort) return writeFail(400, "连线缺少端口名");
    edges.push({
      id: edgeId,
      sourceNodeId,
      sourcePort,
      targetNodeId,
      targetPort,
    });
  }

  return writeOk({ nodes, edges });
}

/** 修订 payload：Workflow 的完整定义（含设置、两个集合与 nodes/edges） */
function revisionPayload(definition: WorkflowDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    settings: definition.settings,
    skillIds: definition.skillIds,
    toolIds: definition.toolIds,
    nodes: definition.nodes,
    edges: definition.edges,
  };
}

/** 工作流当前的技能集与 Tool 集 id，按 position 排序；GET 与部分更新都从这里取。 */
/** 库里当前的图，按 PUT 载荷的形状返回：图缺省的 PUT 用它做 ⊆ 校验与修订载荷。 */
function loadCurrentGraph(workflowId: string): { nodes: unknown[]; edges: unknown[] } {
  const nodes = db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, workflowId))
    .all()
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      actionId: n.actionId,
      objectTypeId: n.objectTypeId,
      label: n.label,
      x: n.x,
      y: n.y,
    }));
  const edges = db
    .select()
    .from(workflowEdges)
    .where(eq(workflowEdges.workflowId, workflowId))
    .all()
    .map((e) => ({
      id: e.id,
      sourceNodeId: e.sourceNodeId,
      sourcePort: e.sourcePort,
      targetNodeId: e.targetNodeId,
      targetPort: e.targetPort,
    }));
  return { nodes, edges };
}

export function loadWorkflowSets(workflowId: string): { skillIds: string[]; toolIds: string[] } {
  return {
    skillIds: db
      .select({ skillId: workflowSkills.skillId })
      .from(workflowSkills)
      .where(eq(workflowSkills.workflowId, workflowId))
      .orderBy(asc(workflowSkills.position))
      .all()
      .map((r) => r.skillId),
    toolIds: db
      .select({ toolId: workflowTools.toolId })
      .from(workflowTools)
      .where(eq(workflowTools.workflowId, workflowId))
      .orderBy(asc(workflowTools.position))
      .all()
      .map((r) => r.toolId),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function replaceSets(tx: Tx, workflowId: string, sets: { skillIds: string[]; toolIds: string[] }) {
  tx.delete(workflowSkills).where(eq(workflowSkills.workflowId, workflowId)).run();
  tx.delete(workflowTools).where(eq(workflowTools.workflowId, workflowId)).run();
  if (sets.skillIds.length > 0)
    tx.insert(workflowSkills)
      .values(sets.skillIds.map((skillId, position) => ({ workflowId, skillId, position })))
      .run();
  if (sets.toolIds.length > 0)
    tx.insert(workflowTools)
      .values(sets.toolIds.map((toolId, position) => ({ workflowId, toolId, position })))
      .run();
}

/** POST：名字、描述与三层设置字段；图从空开始。 */
export function createWorkflow(raw: unknown): WriteResult<WorkflowRow> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");
  const description =
    typeof body.description === "string" ? body.description : "";

  const settingsPayload = parseSettingsPayload(body, {
    instructions: "",
    settings: EMPTY_WORKFLOW_SETTINGS,
    skillIds: [],
    toolIds: [],
  });
  if (!settingsPayload.ok) return settingsPayload;
  const { instructions, settings, skillIds, toolIds } = settingsPayload.data;

  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(workflows)
      .values({ name, description, instructions, settings })
      .returning()
      .get();
    replaceSets(tx, inserted.id, { skillIds, toolIds });
    recordRevision(
      "workflow",
      inserted.id,
      revisionPayload({ name, description, instructions, settings, skillIds, toolIds, nodes: [], edges: [] }),
      "",
      tx,
    );
    return inserted;
  });
  return writeOk(row);
}

/**
 * PUT 与回滚共用的写入路径：整图（nodes+edges）整体替换，节点 id 由调用方给定以
 * 保持连线引用；instructions / settings / skillIds / toolIds 缺省沿用现值，出现即整体替换。
 * 子集校验用的是本次提交生效后的集合，所以先算设置再校验图。
 */
export function writeWorkflow(
  id: string,
  raw: unknown,
): WriteResult<WorkflowRow> {
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) return writeFail(404, "工作流不存在");

  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  let name: string | undefined;
  if (body.name !== undefined) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return writeFail(400, "名称不能为空");
  }
  let description: string | undefined;
  if (body.description !== undefined) {
    if (typeof body.description !== "string")
      return writeFail(400, "description 必须是字符串");
    description = body.description;
  }

  const currentSets = loadWorkflowSets(id);
  const settingsPayload = parseSettingsPayload(body, {
    instructions: existing.instructions,
    settings: existing.settings as WorkflowSettings,
    ...currentSets,
  });
  if (!settingsPayload.ok) return settingsPayload;
  const { instructions, settings, skillIds, toolIds } = settingsPayload.data;

  // 图可以整体缺省：设置页只提交设置与集合，不读改写整图，画布并发保存的图不会被旧图覆盖。
  // 缺省时 ⊆ 校验仍对库里当前的图做，修订载荷也带当前图。
  if ((body.nodes === undefined) !== (body.edges === undefined))
    return writeFail(400, "nodes 与 edges 必须同时提供或同时省略");
  const graphProvided = body.nodes !== undefined;
  const graph = parseGraphPayload(
    graphProvided ? body : { ...body, ...loadCurrentGraph(id) },
    { skillIds, toolIds },
  );
  if (!graph.ok) return graph;
  const { nodes, edges } = graph.data;

  const row = db.transaction((tx) => {
    const updated = tx
      .update(workflows)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        instructions,
        settings,
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning()
      .get();
    replaceSets(tx, id, { skillIds, toolIds });
    if (graphProvided) {
      tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, id)).run();
      tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, id)).run();
      if (nodes.length > 0)
        tx.insert(workflowNodes)
          .values(nodes.map((n) => ({ ...n, workflowId: id })))
          .run();
      if (edges.length > 0)
        tx.insert(workflowEdges)
          .values(edges.map((e) => ({ ...e, workflowId: id })))
          .run();
    }
    recordRevision(
      "workflow",
      id,
      revisionPayload({
        name: updated.name,
        description: updated.description,
        instructions,
        settings,
        skillIds,
        toolIds,
        nodes,
        edges,
      }),
      "",
      tx,
    );
    return updated;
  });

  return writeOk(row);
}
