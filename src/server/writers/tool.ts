import { eq } from "drizzle-orm";
import { db, tools } from "@/db";
import { publicNameProblem, toolCodeProblem } from "@/lib/tool-names";
import { recordRevision } from "@/server/revisions";
import { objectSchemaProblem } from "./json-schema";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

/**
 * Tool 是 OntoFlow 契约（ADR-0017）：作者只写模型可见的名字、描述、参数 schema、
 * 可选的输出 schema 与超时，以及一个 execute 模块；cordis 包装归平台。
 */
export interface ToolPayload {
  name: string;
  publicName: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown> | null;
  timeoutMs: number | null;
  code: string;
}

export type ToolRow = typeof tools.$inferSelect;

export function parseToolPayload(raw: unknown): WriteResult<ToolPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const publicName = typeof body.publicName === "string" ? body.publicName.trim() : "";
  const namingProblem = publicNameProblem(publicName);
  if (namingProblem) return writeFail(400, namingProblem);

  const parametersProblem = objectSchemaProblem(body.parameters, "parameters");
  if (parametersProblem) return writeFail(400, parametersProblem);
  const parameters = body.parameters as Record<string, unknown>;

  let output: Record<string, unknown> | null = null;
  if (body.output !== undefined && body.output !== null) {
    const outputProblem = objectSchemaProblem(body.output, "output");
    if (outputProblem) return writeFail(400, outputProblem);
    output = body.output as Record<string, unknown>;
  }

  let timeoutMs: number | null = null;
  if (body.timeoutMs !== undefined && body.timeoutMs !== null) {
    if (!Number.isSafeInteger(body.timeoutMs) || (body.timeoutMs as number) <= 0)
      return writeFail(400, "timeoutMs 必须是正整数（毫秒）");
    timeoutMs = body.timeoutMs as number;
  }

  const code = typeof body.code === "string" ? body.code : "";
  const codeProblem = toolCodeProblem(code);
  if (codeProblem) return writeFail(400, codeProblem);

  return writeOk({
    name,
    publicName,
    description: typeof body.description === "string" ? body.description : "",
    parameters,
    output,
    timeoutMs,
    code,
  });
}

/** 修订 payload：完整契约，回滚原样写回。 */
function revisionPayload(p: ToolPayload): Record<string, unknown> {
  return {
    name: p.name,
    publicName: p.publicName,
    description: p.description,
    parameters: p.parameters,
    output: p.output,
    timeoutMs: p.timeoutMs,
    code: p.code,
  };
}

/** name 与 publicName 的唯一性都交给数据库：UNIQUE 冲突由 handle() 映射成 409。 */
export function createTool(raw: unknown): WriteResult<ToolRow> {
  const parsed = parseToolPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const inserted = tx.insert(tools).values(p).returning().get();
    recordRevision("tool", inserted.id, revisionPayload(p), "", tx);
    return inserted;
  });
  return writeOk(row);
}

/** PUT 与回滚共用的写入路径 */
export function writeTool(id: string, raw: unknown): WriteResult<ToolRow> {
  const existing = db.select().from(tools).where(eq(tools.id, id)).get();
  if (!existing) return writeFail(404, "Tool 不存在");

  const parsed = parseToolPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx.update(tools).set(p).where(eq(tools.id, id)).returning().get();
    recordRevision("tool", id, revisionPayload(p), "", tx);
    return updated;
  });
  return writeOk(row);
}
