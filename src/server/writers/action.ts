import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actionPreloads,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  skills,
  tools,
} from "@/db";
import { MAX_REENTRIES } from "@/lib/graph";
import { recordRevision } from "@/server/revisions";
import { asObject, parseIdArray, type WriteResult, writeFail, writeOk } from "./types";

type Effort = "off" | "low" | "high" | "max";
const EFFORTS: readonly string[] = ["off", "low", "high", "max"];

export interface PortPayload {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
  position: number;
  /** 输出端口写到工作区哪个文件（ADR-0008）；输入端口恒为 null */
  artifactPath: string | null;
  /** 输出端口所属的具名出口（ADR-0009）；没有分支时为 null */
  exitName: string | null;
}

export interface ActionPayload {
  name: string;
  description: string;
  prompt: string;
  rule: string;
  modelId: string;
  reasoningEffort: Effort;
  maxReentries: number;
  onExhausted: "fail" | "accept";
  ports: PortPayload[];
  /** 会话开始时以 /slug 手势注入的技能，必须是所在工作流技能集的子集（ADR-0016） */
  preloadSkillIds: string[];
  /** 该 Action 会话里可见的 Tool，必须是所在工作流 Tool 集的子集 */
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
  maxReentries: number;
  onExhausted: "fail" | "accept";
  ports: Array<{
    id: string;
    direction: "input" | "output";
    name: string;
    objectTypeId: string;
    objectTypeName: string;
    kind: "text" | "file" | "json";
    position: number;
    artifactPath: string | null;
    exitName: string | null;
  }>;
  preloadSkillIds: string[];
  toolIds: string[];
}

export function parseActionPayload(raw: unknown): WriteResult<ActionPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const description = typeof body.description === "string" ? body.description : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const rule = typeof body.rule === "string" ? body.rule : "";

  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  if (!modelId) return writeFail(400, "必须指定模型");
  if (!db.select().from(models).where(eq(models.id, modelId)).get())
    return writeFail(400, "指定的模型不存在");

  const effortRaw = body.reasoningEffort === undefined ? "high" : body.reasoningEffort;
  if (typeof effortRaw !== "string" || !EFFORTS.includes(effortRaw))
    return writeFail(400, "思考强度必须是 off/low/high/max 之一");
  const reasoningEffort = effortRaw as Effort;

  if (!Array.isArray(body.ports)) return writeFail(400, "ports 必须是数组");
  const ports: PortPayload[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (body.ports as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) return writeFail(400, "端口格式不正确");
    const port = item as Record<string, unknown>;
    const direction = port.direction;
    if (direction !== "input" && direction !== "output")
      return writeFail(400, "端口方向必须是 input 或 output");
    const portName = typeof port.name === "string" ? port.name.trim() : "";
    if (!portName) return writeFail(400, "端口名不能为空");
    const key = `${direction} ${portName}`;
    if (seen.has(key)) return writeFail(400, `同方向端口名重复：「${portName}」`);
    seen.add(key);
    const objectTypeId = typeof port.objectTypeId === "string" ? port.objectTypeId : "";
    if (!objectTypeId) return writeFail(400, `端口「${portName}」缺少对象类型`);
    const position = typeof port.position === "number" ? port.position : index;
    // 产物路径与出口只对输出端口有意义；输入端口传了也一律丢弃，
    // 免得库里出现「输入口带产物路径」这种解释不了的行。
    let artifactPath: string | null = null;
    let exitName: string | null = null;
    if (direction === "output") {
      const rawPath = typeof port.artifactPath === "string" ? port.artifactPath.trim() : "";
      if (rawPath) {
        if (rawPath.startsWith("/") || rawPath.split("/").includes("..")) {
          return writeFail(400, `端口「${portName}」的产物路径必须是工作区内的相对路径`);
        }
        artifactPath = rawPath;
      }
      const rawExit = typeof port.exitName === "string" ? port.exitName.trim() : "";
      if (rawExit) exitName = rawExit;
    }
    ports.push({ direction, name: portName, objectTypeId, position, artifactPath, exitName });
  }

  // 具名出口要么全有要么全无，和图校验同一条规则——在写入口就挡住，
  // 免得存进去一个跑起来才报错的 Action。
  const outPorts = ports.filter((p) => p.direction === "output");
  const namedExits = outPorts.filter((p) => p.exitName !== null).length;
  if (namedExits !== 0 && namedExits !== outPorts.length) {
    return writeFail(400, "输出端口要么都归属具名出口，要么都不归属");
  }
  if (outPorts.some((p) => p.artifactPath === null)) {
    return writeFail(400, "每个输出端口都必须声明它写到工作区的哪个文件");
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
    if (typeIds.some((t) => !found.has(t))) return writeFail(400, "端口引用的对象类型不存在");
  }

  // 「⊆ 所在工作流技能集」不在这里校验：Action 今天仍是共享库实体，同一个 Action
  // 可能被多个工作流引用，子集关系在工作流保存与运行受理时按各自的集合检查。
  const preloadSkillIds = parseIdArray(body.preloadSkillIds);
  if (!preloadSkillIds) return writeFail(400, "preloadSkillIds 必须是字符串数组");
  if (preloadSkillIds.length > 0) {
    const found = new Set(
      db
        .select({ id: skills.id })
        .from(skills)
        .where(inArray(skills.id, preloadSkillIds))
        .all()
        .map((r) => r.id),
    );
    if (preloadSkillIds.some((s) => !found.has(s))) return writeFail(400, "预载的技能不存在");
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
    if (toolIds.some((t) => !found.has(t))) return writeFail(400, "可见的 Tool 不存在");
  }

  const rawReentries = body.maxReentries;
  const maxReentries =
    rawReentries === undefined || rawReentries === null ? 0 : Number(rawReentries);
  // 上限封在 MAX_REENTRIES：一轮一个会话目录，轨迹接口读满 128 个就抛（见常量注释）
  if (!Number.isSafeInteger(maxReentries) || maxReentries < 0 || maxReentries > MAX_REENTRIES) {
    return writeFail(400, `重入上限必须是 0 到 ${MAX_REENTRIES} 之间的整数`);
  }
  const rawExhausted = body.onExhausted === undefined ? "fail" : body.onExhausted;
  if (rawExhausted !== "fail" && rawExhausted !== "accept") {
    return writeFail(400, "重入耗尽的收束方式必须是 fail 或 accept");
  }

  return writeOk({
    name,
    description,
    maxReentries,
    onExhausted: rawExhausted,
    prompt,
    rule,
    modelId,
    reasoningEffort,
    ports,
    preloadSkillIds,
    toolIds,
  });
}

/** 修订 payload：Action 的完整定义（含 ports/preloadSkillIds/toolIds） */
function revisionPayload(p: ActionPayload): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    prompt: p.prompt,
    rule: p.rule,
    modelId: p.modelId,
    reasoningEffort: p.reasoningEffort,
    maxReentries: p.maxReentries,
    onExhausted: p.onExhausted,
    ports: p.ports.map((port) => ({
      direction: port.direction,
      name: port.name,
      objectTypeId: port.objectTypeId,
      position: port.position,
      artifactPath: port.artifactPath,
      exitName: port.exitName,
    })),
    preloadSkillIds: p.preloadSkillIds,
    toolIds: p.toolIds,
  };
}

/** 组装 ActionDto（join 端口的 objectTypeName/kind，附 preloadSkillIds/toolIds），按传入 id 顺序 */
export function loadActionDtos(ids: string[]): ActionDto[] {
  if (ids.length === 0) return [];
  const actionRows = db.select().from(actions).where(inArray(actions.id, ids)).all();
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
      artifactPath: actionPorts.artifactPath,
      exitName: actionPorts.exitName,
    })
    .from(actionPorts)
    .innerJoin(objectTypes, eq(actionPorts.objectTypeId, objectTypes.id))
    .where(inArray(actionPorts.actionId, presentIds))
    .orderBy(asc(actionPorts.position))
    .all();
  const preloadRows = db
    .select()
    .from(actionPreloads)
    .where(inArray(actionPreloads.actionId, presentIds))
    .orderBy(asc(actionPreloads.position))
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
        maxReentries: a.maxReentries,
        onExhausted: a.onExhausted,
        ports: portRows
          .filter((p) => p.actionId === a.id)
          .map(({ actionId: _actionId, ...port }) => port),
        preloadSkillIds: preloadRows.filter((s) => s.actionId === a.id).map((s) => s.skillId),
        toolIds: toolRows.filter((t) => t.actionId === a.id).map((t) => t.toolId),
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
  if (p.preloadSkillIds.length > 0)
    tx.insert(actionPreloads)
      .values(p.preloadSkillIds.map((skillId, position) => ({ actionId, skillId, position })))
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
        maxReentries: p.maxReentries,
        onExhausted: p.onExhausted,
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

/** PUT 与回滚共用的写入路径：ports/preloadSkillIds/toolIds 整体替换 */
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
        maxReentries: p.maxReentries,
        onExhausted: p.onExhausted,
      })
      .where(eq(actions.id, id))
      .run();
    tx.delete(actionPorts).where(eq(actionPorts.actionId, id)).run();
    tx.delete(actionPreloads).where(eq(actionPreloads.actionId, id)).run();
    tx.delete(actionTools).where(eq(actionTools.actionId, id)).run();
    insertRelations(tx, id, p);
    recordRevision("action", id, revisionPayload(p), "", tx);
  });

  const dto = loadActionDto(id);
  return dto ? writeOk(dto) : writeFail(404, "Action 不存在");
}
