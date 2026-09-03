import { eq } from "drizzle-orm";
import { db, objectTypes } from "@/db";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

export interface ObjectTypePayload {
  name: string;
  kind: "text" | "file" | "json";
  description: string;
  jsonSchema: string | null;
}

export type ObjectTypeRow = typeof objectTypes.$inferSelect;

export function parseObjectTypePayload(raw: unknown): WriteResult<ObjectTypePayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  const kind = body.kind;
  if (kind !== "text" && kind !== "file" && kind !== "json")
    return writeFail(400, "kind 必须是 text/file/json 之一");

  const description = typeof body.description === "string" ? body.description : "";

  let jsonSchema: string | null = null;
  if (typeof body.jsonSchema === "string" && body.jsonSchema.trim() !== "") {
    try {
      JSON.parse(body.jsonSchema);
    } catch {
      return writeFail(400, "jsonSchema 必须是可解析的 JSON 字符串");
    }
    jsonSchema = body.jsonSchema;
  }

  return writeOk({ name, kind, description, jsonSchema });
}

function revisionPayload(p: ObjectTypePayload): Record<string, unknown> {
  return {
    name: p.name,
    kind: p.kind,
    description: p.description,
    jsonSchema: p.jsonSchema,
  };
}

export function createObjectType(raw: unknown): WriteResult<ObjectTypeRow> {
  const parsed = parseObjectTypePayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const inserted = tx.insert(objectTypes).values(p).returning().get();
    recordRevision("object_type", inserted.id, revisionPayload(p), "", tx);
    return inserted;
  });
  return writeOk(row);
}

/** PUT 与回滚共用的写入路径 */
export function writeObjectType(id: string, raw: unknown): WriteResult<ObjectTypeRow> {
  const existing = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
  if (!existing) return writeFail(404, "对象类型不存在");
  if (existing.builtin) return writeFail(403, "内置类型不可修改");

  const parsed = parseObjectTypePayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx.update(objectTypes).set(p).where(eq(objectTypes.id, id)).returning().get();
    recordRevision("object_type", id, revisionPayload(p), "", tx);
    return updated;
  });
  return writeOk(row);
}
