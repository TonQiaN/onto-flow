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
} from "@/db";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

type Effort = "low" | "medium" | "high" | "max";
const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];

export interface PortPayload {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  position: number;
}

export interface ActionPayload {
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

export interface ActionDto {
  id: string;
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: Effort;
  ports: Array<{
    id: string;
    direction: "input" | "output";
    name: string;
    objectTypeId: string;
    objectTypeName: string;
    kind: "text" | "file" | "json";
    position: number;
  }>;
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

export function parseActionPayload(raw: unknown): WriteResult<ActionPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const description =
    typeof body.description === "string" ? body.description : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const rule = typeof body.rule === "string" ? body.rule : "";

  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  if (!modelId) return writeFail(400, "必须指定模型");
  if (!db.select().from(models).where(eq(models.id, modelId)).get())
    return writeFail(400, "指定的模型不存在");

  const effortRaw =
    body.reasoningEffort === undefined ? "max" : body.reasoningEffort;
  if (typeof effortRaw !== "string" || !EFFORTS.includes(effortRaw))
    return writeFail(400, "思考强度必须是 low/medium/high/max 之一");
  const reasoningEffort = effortRaw as Effort;

  if (!Array.isArray(body.ports)) return writeFail(400, "ports 必须是数组");
  const ports: PortPayload[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (body.ports as unknown[]).entries()) {
    if (typeof item !== "object" || item === null)
      return writeFail(400, "端口格式不正确");
    const port = item as Record<string, unknown>;
    const direction = port.direction;
    if (direction !== "input" && direction !== "output")
      return writeFail(400, "端口方向必须是 input 或 output");
    const portName = typeof port.name === "string" ? port.name.trim() : "";
    if (!portName) return writeFail(400, "端口名不能为空");
    const key = `${direction} ${portName}`;
    if (seen.has(key)) return writeFail(400, `同方向端口名重复：「${portName}」`);
    seen.add(key);
    const objectTypeId =
      typeof port.objectTypeId === "string" ? port.objectTypeId : "";
    if (!objectTypeId) return writeFail(400, `端口「${portName}」缺少对象类型`);
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
      return writeFail(400, "端口引用的对象类型不存在");
  }

  const skillIds = parseIdArray(body.skillIds);
  if (!skillIds) return writeFail(400, "skillIds 必须是字符串数组");
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
      return writeFail(400, "引用的技能不存在");
  }

  const toolIds = parseIdArray(body.toolIds);
  if (!toolIds) return writeFail(400, "toolIds 必须是字符串数组");
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
      return writeFail(400, "引用的工具不存在");
  }

  return writeOk({
    name,
    description,
    prompt,
    rule,
    modelId,
    reasoningEffort,
    ports,
    skillIds,
    toolIds,
  });
}

/** 修订 payload：Action 的完整定义（含 ports/skillIds/toolIds） */
function revisionPayload(p: ActionPayload): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    prompt: p.prompt,
    rule: p.rule,
    modelId: p.modelId,
    reasoningEffort: p.reasoningEffort,
    ports: p.ports.map((port) => ({
      direction: port.direction,
      name: port.name,
      objectTypeId: port.objectTypeId,
      position: port.position,
    })),
    skillIds: p.skillIds,
    toolIds: p.toolIds,
  };
}

/** 组装 ActionDto（join 端口的 objectTypeName/kind，附 skillIds/toolIds），按传入 id 顺序 */
export function loadActionDtos(ids: string[]): ActionDto[] {
  if (ids.length === 0) return [];
  const actionRows = db
    .select()
    .from(actions)
    .where(inArray(actions.id, ids))
    .all();
  if (actionRows.length === 0) return [];

  const presentIds = actionRows.map((a) => a.id);
  const portRows = db
    .select({
      id: actionPorts.id,
      actionId: actionPorts.actionId,
      direction: actionPorts.direction,
      name: actionPorts.name,
      objectTypeId: actionPorts.objectTypeId,
      objectTypeName: objectTypes.name,
      kind: objectTypes.kind,
      position: actionPorts.position,
    })
    .from(actionPorts)
    .innerJoin(objectTypes, eq(actionPorts.objectTypeId, objectTypes.id))
    .where(inArray(actionPorts.actionId, presentIds))
    .orderBy(asc(actionPorts.position))
    .all();
  const skillRows = db
    .select()
    .from(actionSkills)
    .where(inArray(actionSkills.actionId, presentIds))
    .orderBy(asc(actionSkills.position))
    .all();
  const toolRows = db
    .select()
    .from(actionTools)
    .where(inArray(actionTools.actionId, presentIds))
    .all();

  const byId = new Map(
    actionRows.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        rule: a.rule,
        modelId: a.modelId,
        reasoningEffort: a.reasoningEffort,
        ports: portRows
          .filter((p) => p.actionId === a.id)
          .map(({ actionId: _actionId, ...port }) => port),
        skillIds: skillRows
          .filter((s) => s.actionId === a.id)
          .map((s) => s.skillId),
        toolIds: toolRows
          .filter((t) => t.actionId === a.id)
          .map((t) => t.toolId),
      } satisfies ActionDto,
    ]),
  );

  return ids.flatMap((id) => {
    const dto = byId.get(id);
    return dto ? [dto] : [];
  });
}

export function loadActionDto(id: string): ActionDto | null {
  return loadActionDtos([id])[0] ?? null;
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
        p.skillIds.map((skillId, position) => ({ actionId, skillId, position })),
      )
      .run();
  if (p.toolIds.length > 0)
    tx.insert(actionTools)
      .values(p.toolIds.map((toolId) => ({ actionId, toolId })))
      .run();
}

export function createAction(raw: unknown): WriteResult<ActionDto> {
  const parsed = parseActionPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const actionId = db.transaction((tx) => {
    const row = tx
      .insert(actions)
      .values({
        name: p.name,
        description: p.description,
        prompt: p.prompt,
        rule: p.rule,
        modelId: p.modelId,
        reasoningEffort: p.reasoningEffort,
      })
      .returning({ id: actions.id })
      .get();
    insertRelations(tx, row.id, p);
    recordRevision("action", row.id, revisionPayload(p), "", tx);
    return row.id;
  });

  const dto = loadActionDto(actionId);
  return dto ? writeOk(dto) : writeFail(500, "Action 创建后读取失败");
}

/** PUT 与回滚共用的写入路径：ports/skillIds/toolIds 整体替换 */
export function writeAction(id: string, raw: unknown): WriteResult<ActionDto> {
  const existing = db.select().from(actions).where(eq(actions.id, id)).get();
  if (!existing) return writeFail(404, "Action 不存在");

  const parsed = parseActionPayload(raw);
  if (!parsed.ok) return parsed;
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
    recordRevision("action", id, revisionPayload(p), "", tx);
  });

  const dto = loadActionDto(id);
  return dto ? writeOk(dto) : writeFail(404, "Action 不存在");
}
