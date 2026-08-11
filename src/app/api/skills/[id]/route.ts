import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { actionSkills, actions, db, skills } from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

interface SkillPayload {
  name: string;
  description: string;
  content: string;
}

function parseSkillPayload(
  raw: unknown,
): { data: SkillPayload } | { error: NextResponse } {
  const fail = (msg: string) => ({ error: jsonError(400, msg) });
  if (typeof raw !== "object" || raw === null)
    return fail("请求体必须是 JSON 对象");
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("名称不能为空");

  return {
    data: {
      name,
      description:
        typeof body.description === "string" ? body.description : "",
      content: typeof body.content === "string" ? body.content : "",
    },
  };
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) return jsonError(404, "技能不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) return jsonError(404, "技能不存在");
    const parsed = parseSkillPayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const updated = db
      .update(skills)
      .set(parsed.data)
      .where(eq(skills.id, id))
      .returning()
      .get();
    return NextResponse.json(updated);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) return jsonError(404, "技能不存在");

    const refs = db
      .select({ name: actions.name })
      .from(actionSkills)
      .innerJoin(actions, eq(actionSkills.actionId, actions.id))
      .where(eq(actionSkills.skillId, id))
      .all();
    const usedBy = [...new Set(refs.map((r) => r.name))];
    if (usedBy.length > 0)
      return jsonError(409, "该技能正被 Action 引用，无法删除", { usedBy });

    db.delete(skills).where(eq(skills.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
