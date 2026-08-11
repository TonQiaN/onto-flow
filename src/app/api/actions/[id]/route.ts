import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actionSkills,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  skills,
  tools,
  workflowNodes,
  workflows,
} from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Effort = "low" | "medium" | "high" | "max";
const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];

interface PortPayload {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  position: number;
}

interface ActionPayload {
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: Effort;
  ports: PortPayload[];
  skillIds: string[];
  toolIds: string[];
}

function parseIdArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return [...new Set(out)];
}

function parseActionPayload(
  raw: unknown,
): { data: ActionPayload } | { error: NextResponse } {
  const fail = (msg: string) => ({ error: jsonError(400, msg) });
  if (typeof raw !== "object" || raw === null)
    return fail("请求体必须是 JSON 对象");
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("名称不能为空");

  const description =
    typeof body.description === "string" ? body.description : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const rule = typeof body.rule === "string" ? body.rule : "";

  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  if (!modelId) return fail("必须指定模型");
  if (!db.select().from(models).where(eq(models.id, modelId)).get())
    return fail("指定的模型不存在");

  const effortRaw =
    body.reasoningEffort === undefined ? "max" : body.reasoningEffort;
  if (typeof effortRaw !== "string" || !EFFORTS.includes(effortRaw))
    return fail("思考强度必须是 low/medium/high/max 之一");
  const reasoningEffort = effortRaw as Effort;

  if (!Array.isArray(body.ports)) return fail("ports 必须是数组");
  const ports: PortPayload[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (body.ports as unknown[]).entries()) {
    if (typeof item !== "object" || item === null)
      return fail("端口格式不正确");
    const port = item as Record<string, unknown>;
    const direction = port.direction;
    if (direction !== "input" && direction !== "output")
      return fail("端口方向必须是 input 或 output");
    const portName = typeof port.name === "string" ? port.name.trim() : "";
    if (!portName) return fail("端口名不能为空");
    const key = `${direction} ${portName}`;
    if (seen.has(key)) return fail(`同方向端口名重复：「${portName}」`);
    seen.add(key);
    const objectTypeId =
      typeof port.objectTypeId === "string" ? port.objectTypeId : "";
    if (!objectTypeId) return fail(`端口「${portName}」缺少对象类型`);
    const position = typeof port.position === "number" ? port.position : index;
    ports.push({ direction, name: portName, objectTypeId, position });
  }

  const typeIds = [...new Set(ports.map((p) => p.objectTypeId))];
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
      return fail("端口引用的对象类型不存在");
  }

  const skillIds = parseIdArray(body.skillIds);
  if (!skillIds) return fail("skillIds 必须是字符串数组");
  if (skillIds.length > 0) {
    const found = new Set(
      db
        .select({ id: skills.id })
        .from(skills)
        .where(inArray(skills.id, skillIds))
        .all()
        .map((r) => r.id),
    );
    if (skillIds.some((s) => !found.has(s)))
      return fail("引用的技能不存在");
  }

  const toolIds = parseIdArray(body.toolIds);
  if (!toolIds) return fail("toolIds 必须是字符串数组");
  if (toolIds.length > 0) {
    const found = new Set(
      db
        .select({ id: tools.id })
        .from(tools)
        .where(inArray(tools.id, toolIds))
        .all()
        .map((r) => r.id),
    );
    if (toolIds.some((t) => !found.has(t)))
      return fail("引用的工具不存在");
  }

  return {
    data: {
      name,
      description,
      prompt,
      rule,
      modelId,
      reasoningEffort,
      ports,
      skillIds,
      toolIds,
    },
  };
}

/** 组装 ActionDto（join 端口的 objectTypeName/kind，附 skillIds/toolIds） */
function loadActionDto(id: string) {
  const action = db.select().from(actions).where(eq(actions.id, id)).get();
  if (!action) return null;
  const portRows = db
    .select({
      id: actionPorts.id,
      direction: actionPorts.direction,
      name: actionPorts.name,
      objectTypeId: actionPorts.objectTypeId,
      objectTypeName: objectTypes.name,
      kind: objectTypes.kind,
      position: actionPorts.position,
    })
    .from(actionPorts)
    .innerJoin(objectTypes, eq(actionPorts.objectTypeId, objectTypes.id))
    .where(eq(actionPorts.actionId, id))
    .orderBy(asc(actionPorts.position))
    .all();
  const skillRows = db
    .select()
    .from(actionSkills)
    .where(eq(actionSkills.actionId, id))
    .orderBy(asc(actionSkills.position))
    .all();
  const toolRows = db
    .select()
    .from(actionTools)
    .where(eq(actionTools.actionId, id))
    .all();

  return {
    id: action.id,
    name: action.name,
    description: action.description,
    prompt: action.prompt,
    rule: action.rule,
    modelId: action.modelId,
    reasoningEffort: action.reasoningEffort,
    ports: portRows,
    skillIds: skillRows.map((s) => s.skillId),
    toolIds: toolRows.map((t) => t.toolId),
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function insertRelations(tx: Tx, actionId: string, p: ActionPayload) {
  if (p.ports.length > 0)
    tx.insert(actionPorts)
      .values(p.ports.map((port) => ({ actionId, ...port })))
      .run();
  if (p.skillIds.length > 0)
    tx.insert(actionSkills)
      .values(
        p.skillIds.map((skillId, position) => ({
          actionId,
          skillId,
          position,
        })),
      )
      .run();
  if (p.toolIds.length > 0)
    tx.insert(actionTools)
      .values(p.toolIds.map((toolId) => ({ actionId, toolId })))
      .run();
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const dto = loadActionDto(id);
    if (!dto) return jsonError(404, "Action 不存在");
    return NextResponse.json(dto);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const existing = db.select().from(actions).where(eq(actions.id, id)).get();
    if (!existing) return jsonError(404, "Action 不存在");
    const parsed = parseActionPayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const p = parsed.data;

    db.transaction((tx) => {
      tx.update(actions)
        .set({
          name: p.name,
          description: p.description,
          prompt: p.prompt,
          rule: p.rule,
          modelId: p.modelId,
          reasoningEffort: p.reasoningEffort,
        })
        .where(eq(actions.id, id))
        .run();
      tx.delete(actionPorts).where(eq(actionPorts.actionId, id)).run();
      tx.delete(actionSkills).where(eq(actionSkills.actionId, id)).run();
      tx.delete(actionTools).where(eq(actionTools.actionId, id)).run();
      insertRelations(tx, id, p);
    });

    return NextResponse.json(loadActionDto(id));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const existing = db.select().from(actions).where(eq(actions.id, id)).get();
    if (!existing) return jsonError(404, "Action 不存在");

    const refs = db
      .select({ name: workflows.name })
      .from(workflowNodes)
      .innerJoin(workflows, eq(workflowNodes.workflowId, workflows.id))
      .where(eq(workflowNodes.actionId, id))
      .all();
    const usedBy = [...new Set(refs.map((r) => r.name))];
    if (usedBy.length > 0)
      return jsonError(409, "该 Action 正被工作流引用，无法删除", { usedBy });

    db.delete(actions).where(eq(actions.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
