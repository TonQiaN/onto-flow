import { eq } from "drizzle-orm";
import { db, skills } from "@/db";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

export interface SkillPayload {
  name: string;
  description: string;
  content: string;
}

export type SkillRow = typeof skills.$inferSelect;

export function parseSkillPayload(raw: unknown): WriteResult<SkillPayload> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");

  return writeOk({
    name,
    description: typeof body.description === "string" ? body.description : "",
    content: typeof body.content === "string" ? body.content : "",
  });
}

function revisionPayload(p: SkillPayload): Record<string, unknown> {
  return { name: p.name, description: p.description, content: p.content };
}

export function createSkill(raw: unknown): WriteResult<SkillRow> {
  const parsed = parseSkillPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const inserted = tx.insert(skills).values(p).returning().get();
    recordRevision("skill", inserted.id, revisionPayload(p), "", tx);
    return inserted;
  });
  return writeOk(row);
}

/** PUT 与回滚共用的写入路径 */
export function writeSkill(id: string, raw: unknown): WriteResult<SkillRow> {
  const existing = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!existing) return writeFail(404, "技能不存在");

  const parsed = parseSkillPayload(raw);
  if (!parsed.ok) return parsed;
  const p = parsed.data;

  const row = db.transaction((tx) => {
    const updated = tx
      .update(skills)
      .set(p)
      .where(eq(skills.id, id))
      .returning()
      .get();
    recordRevision("skill", id, revisionPayload(p), "", tx);
    return updated;
  });
  return writeOk(row);
}
