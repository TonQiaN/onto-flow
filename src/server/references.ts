/**
 * 引用（反向索引）服务：谁在引用这个实体。
 *
 * 引用关系的唯一事实源（DESIGN-V2 第三节）：
 * - Action      ← workflow_nodes.action_id
 * - Skill       ← action_skills
 * - Tool        ← action_tools
 * - Object Type ← action_ports.object_type_id 与 workflow_nodes.object_type_id
 * - Workflow    ← 无（顶层实体，refCount 恒为 0）
 *
 * 对外接口（其它模块可直接 import，签名保持稳定）：
 *   isEntityKind / listEntities / entityExists / entityHref
 *   referencesOf / refCounts / orphans / impactOfActionPorts
 */
import { asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  ENTITY_KINDS,
  actionPorts,
  actionSkills,
  actionTools,
  actions,
  db,
  objectTypes,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
  type EntityKind,
} from "@/db";

/** 引用方（谁在用）。kind 只会是 workflow 或 action——只有它们会引用别人 */
export interface EntityRef {
  kind: "workflow" | "action";
  id: string;
  name: string;
  /** 引用位置的人话描述，如「节点：集采计划审核」「输入端口：集采计划」 */
  detail: string;
  href: string;
}

export interface NextPort {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
}

export interface BrokenEdge {
  workflowId: string;
  workflowName: string;
  nodeLabel: string;
  portName: string;
  reason: string;
}

export interface OrphanEntity {
  kind: EntityKind;
  id: string;
  name: string;
  href: string;
}

const ENTITY_TABLES = {
  workflow: workflows,
  action: actions,
  skill: skills,
  tool: tools,
  object_type: objectTypes,
} as const;

const ENTITY_LABELS: Record<EntityKind, string> = {
  workflow: "工作流",
  action: "Action",
  skill: "技能",
  tool: "工具",
  object_type: "对象类型",
};

export function isEntityKind(value: unknown): value is EntityKind {
  return (
    typeof value === "string" &&
    (ENTITY_KINDS as readonly string[]).includes(value)
  );
}

export function entityLabel(kind: EntityKind): string {
  return ENTITY_LABELS[kind];
}

/** 该 kind 的全部实体（只取 id + name），按名字升序 */
export function listEntities(
  kind: EntityKind,
): Array<{ id: string; name: string }> {
  const table = ENTITY_TABLES[kind];
  return db
    .select({ id: table.id, name: table.name })
    .from(table)
    .orderBy(asc(table.name))
    .all();
}

export function entityExists(kind: EntityKind, id: string): boolean {
  const table = ENTITY_TABLES[kind];
  return (
    db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !==
    undefined
  );
}

export function entityName(kind: EntityKind, id: string): string | null {
  const table = ENTITY_TABLES[kind];
  const row = db
    .select({ name: table.name })
    .from(table)
    .where(eq(table.id, id))
    .get();
  return row?.name ?? null;
}

/**
 * 实体在前端的可跳转路径。
 * workflow 有独立详情页；其余四个库是列表页 + highlight 查询参数。
 */
export function entityHref(kind: EntityKind, id: string): string {
  switch (kind) {
    case "workflow":
      return `/workflows/${id}`;
    case "action":
      return `/actions?highlight=${id}`;
    case "skill":
      return `/skills?highlight=${id}`;
    case "tool":
      return `/tools?highlight=${id}`;
    case "object_type":
      return `/object-types?highlight=${id}`;
  }
}

/** 谁在引用这个实体 */
export function referencesOf(kind: EntityKind, id: string): EntityRef[] {
  switch (kind) {
    case "workflow":
      return [];

    case "action": {
      const rows = db
        .select({
          workflowId: workflows.id,
          workflowName: workflows.name,
          label: workflowNodes.label,
          actionName: actions.name,
        })
        .from(workflowNodes)
        .innerJoin(workflows, eq(workflowNodes.workflowId, workflows.id))
        .leftJoin(actions, eq(workflowNodes.actionId, actions.id))
        .where(eq(workflowNodes.actionId, id))
        .all();
      return rows.map((r) => ({
        kind: "workflow" as const,
        id: r.workflowId,
        name: r.workflowName,
        detail: `节点：${r.label || r.actionName || "未命名节点"}`,
        href: entityHref("workflow", r.workflowId),
      }));
    }

    case "skill": {
      const rows = db
        .select({ actionId: actions.id, actionName: actions.name })
        .from(actionSkills)
        .innerJoin(actions, eq(actionSkills.actionId, actions.id))
        .where(eq(actionSkills.skillId, id))
        .all();
      return rows.map((r) => ({
        kind: "action" as const,
        id: r.actionId,
        name: r.actionName,
        detail: "引用技能",
        href: entityHref("action", r.actionId),
      }));
    }

    case "tool": {
      const rows = db
        .select({ actionId: actions.id, actionName: actions.name })
        .from(actionTools)
        .innerJoin(actions, eq(actionTools.actionId, actions.id))
        .where(eq(actionTools.toolId, id))
        .all();
      return rows.map((r) => ({
        kind: "action" as const,
        id: r.actionId,
        name: r.actionName,
        detail: "引用工具",
        href: entityHref("action", r.actionId),
      }));
    }

    case "object_type": {
      const portRows = db
        .select({
          actionId: actions.id,
          actionName: actions.name,
          direction: actionPorts.direction,
          portName: actionPorts.name,
        })
        .from(actionPorts)
        .innerJoin(actions, eq(actionPorts.actionId, actions.id))
        .where(eq(actionPorts.objectTypeId, id))
        .orderBy(asc(actionPorts.position))
        .all();
      const nodeRows = db
        .select({
          workflowId: workflows.id,
          workflowName: workflows.name,
          nodeKind: workflowNodes.kind,
          label: workflowNodes.label,
        })
        .from(workflowNodes)
        .innerJoin(workflows, eq(workflowNodes.workflowId, workflows.id))
        .where(eq(workflowNodes.objectTypeId, id))
        .all();
      return [
        ...portRows.map((r) => ({
          kind: "action" as const,
          id: r.actionId,
          name: r.actionName,
          detail: `${r.direction === "input" ? "输入端口" : "输出端口"}：${r.portName}`,
          href: entityHref("action", r.actionId),
        })),
        ...nodeRows.map((r) => ({
          kind: "workflow" as const,
          id: r.workflowId,
          name: r.workflowName,
          detail: `${r.nodeKind === "input" ? "输入节点" : "输出节点"}：${r.label || "未命名"}`,
          href: entityHref("workflow", r.workflowId),
        })),
      ];
    }
  }
}

/**
 * 该 kind 下每个实体被引用的次数（= referencesOf 的条数）。
 * 只包含被引用过的实体，调用方按 `counts[id] ?? 0` 取值。
 */
export function refCounts(kind: EntityKind): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (id: string | null) => {
    if (!id) return;
    counts[id] = (counts[id] ?? 0) + 1;
  };

  switch (kind) {
    case "workflow":
      break;
    case "action": {
      const rows = db
        .select({ actionId: workflowNodes.actionId })
        .from(workflowNodes)
        .where(isNotNull(workflowNodes.actionId))
        .all();
      for (const r of rows) bump(r.actionId);
      break;
    }
    case "skill": {
      const rows = db
        .select({ skillId: actionSkills.skillId })
        .from(actionSkills)
        .all();
      for (const r of rows) bump(r.skillId);
      break;
    }
    case "tool": {
      const rows = db
        .select({ toolId: actionTools.toolId })
        .from(actionTools)
        .all();
      for (const r of rows) bump(r.toolId);
      break;
    }
    case "object_type": {
      const portRows = db
        .select({ objectTypeId: actionPorts.objectTypeId })
        .from(actionPorts)
        .all();
      for (const r of portRows) bump(r.objectTypeId);
      const nodeRows = db
        .select({ objectTypeId: workflowNodes.objectTypeId })
        .from(workflowNodes)
        .where(isNotNull(workflowNodes.objectTypeId))
        .all();
      for (const r of nodeRows) bump(r.objectTypeId);
      break;
    }
  }
  return counts;
}

/**
 * 未被任何人引用的实体。
 * workflow 是顶层实体（refCount 恒为 0），孤儿概念不适用，恒返回空数组。
 */
export function orphans(kind: EntityKind): OrphanEntity[] {
  if (kind === "workflow") return [];
  const counts = refCounts(kind);
  return listEntities(kind)
    .filter((e) => (counts[e.id] ?? 0) === 0)
    .map((e) => ({ kind, id: e.id, name: e.name, href: entityHref(kind, e.id) }));
}

/**
 * 改端口前的影响预览：若按 nextPorts 保存该 Action，哪些工作流连线会失效。
 * 失效判定：连线用到的端口在 nextPorts 中按 (direction, name) 找不到（删除或改名），
 * 或找到了但 objectTypeId 变了（nominal 类型变更即失效）。
 */
export function impactOfActionPorts(
  actionId: string,
  nextPorts: NextPort[],
): BrokenEdge[] {
  const nodes = db
    .select({
      nodeId: workflowNodes.id,
      label: workflowNodes.label,
      workflowId: workflows.id,
      workflowName: workflows.name,
    })
    .from(workflowNodes)
    .innerJoin(workflows, eq(workflowNodes.workflowId, workflows.id))
    .where(eq(workflowNodes.actionId, actionId))
    .all();
  if (nodes.length === 0) return [];

  const action = db
    .select({ name: actions.name })
    .from(actions)
    .where(eq(actions.id, actionId))
    .get();
  const currentPorts = db
    .select()
    .from(actionPorts)
    .where(eq(actionPorts.actionId, actionId))
    .all();
  const typeNames = new Map(
    db
      .select({ id: objectTypes.id, name: objectTypes.name })
      .from(objectTypes)
      .all()
      .map((t) => [t.id, t.name] as const),
  );

  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const nodeIds = nodes.map((n) => n.nodeId);
  const edges = db
    .select()
    .from(workflowEdges)
    .where(
      or(
        inArray(workflowEdges.sourceNodeId, nodeIds),
        inArray(workflowEdges.targetNodeId, nodeIds),
      ),
    )
    .all();

  const typeName = (id: string) => typeNames.get(id) ?? "未知类型";
  const broken: BrokenEdge[] = [];

  const check = (
    node: (typeof nodes)[number],
    direction: "input" | "output",
    portName: string,
  ) => {
    const next = nextPorts.find(
      (p) => p.direction === direction && p.name === portName,
    );
    const label = direction === "input" ? "输入端口" : "输出端口";
    if (!next) {
      broken.push({
        workflowId: node.workflowId,
        workflowName: node.workflowName,
        nodeLabel: node.label || action?.name || "未命名节点",
        portName,
        reason: `${label}「${portName}」已删除或改名`,
      });
      return;
    }
    const current = currentPorts.find(
      (p) => p.direction === direction && p.name === portName,
    );
    if (current && current.objectTypeId !== next.objectTypeId) {
      broken.push({
        workflowId: node.workflowId,
        workflowName: node.workflowName,
        nodeLabel: node.label || action?.name || "未命名节点",
        portName,
        reason: `${label}「${portName}」类型由「${typeName(current.objectTypeId)}」改为「${typeName(next.objectTypeId)}」`,
      });
    }
  };

  for (const edge of edges) {
    const source = nodeById.get(edge.sourceNodeId);
    if (source) check(source, "output", edge.sourcePort);
    const target = nodeById.get(edge.targetNodeId);
    if (target) check(target, "input", edge.targetPort);
  }
  return broken;
}
