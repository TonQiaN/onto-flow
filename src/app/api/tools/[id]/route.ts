import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { actionTools, actions, db, tools } from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

interface ToolPayload {
  name: string;
  description: string;
  code: string;
}

function parseToolPayload(
  raw: unknown,
): { data: ToolPayload } | { error: NextResponse } {
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
      code: typeof body.code === "string" ? body.code : "",
    },
  };
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) return jsonError(404, "工具不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) return jsonError(404, "工具不存在");
    const parsed = parseToolPayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const updated = db
      .update(tools)
      .set(parsed.data)
      .where(eq(tools.id, id))
      .returning()
      .get();
    return NextResponse.json(updated);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) return jsonError(404, "工具不存在");

    const refs = db
      .select({ name: actions.name })
      .from(actionTools)
      .innerJoin(actions, eq(actionTools.actionId, actions.id))
      .where(eq(actionTools.toolId, id))
      .all();
    const usedBy = [...new Set(refs.map((r) => r.name))];
    if (usedBy.length > 0)
      return jsonError(409, "该工具正被 Action 引用，无法删除", { usedBy });

    db.delete(tools).where(eq(tools.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
