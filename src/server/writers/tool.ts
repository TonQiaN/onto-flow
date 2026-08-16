import { eq } from "drizzle-orm";
import { db, tools } from "@/db";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

export interface ToolPayload {
  name: string;
  description: string;
  code: string;
}

export type ToolRow = typeof tools.$inferSelect;

export function parseToolPayload(raw: unknown): WriteResult<ToolPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  return writeOk({
    name,
    description: typeof body.description === "string" ? body.description : "",
    code: typeof body.code === "string" ? body.code : "",
  });
}

function revisionPayload(p: ToolPayload): Record<string, unknown> {
  return { name: p.name, description: p.description, code: p.code };
}

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
  if (!existing) return writeFail(404, "工具不存在");

  const parsed = parseToolPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx
      .update(tools)
      .set(p)
      .where(eq(tools.id, id))
      .returning()
      .get();
    recordRevision("tool", id, revisionPayload(p), "", tx);
    return updated;
  });
  return writeOk(row);
}
