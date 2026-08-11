import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  actionPorts,
  actions,
  db,
  objectTypes,
  workflowNodes,
  workflows,
} from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

interface ObjectTypePayload {
  name: string;
  kind: "text" | "file" | "json";
  description: string;
  jsonSchema: string | null;
}

function parseObjectTypePayload(
  raw: unknown,
): { data: ObjectTypePayload } | { error: NextResponse } {
  const fail = (msg: string) => ({ error: jsonError(400, msg) });
  if (typeof raw !== "object" || raw === null)
    return fail("请求体必须是 JSON 对象");
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("名称不能为空");

  const kind = body.kind;
  if (kind !== "text" && kind !== "file" && kind !== "json")
    return fail("kind 必须是 text/file/json 之一");

  const description =
    typeof body.description === "string" ? body.description : "";

  let jsonSchema: string | null = null;
  if (typeof body.jsonSchema === "string" && body.jsonSchema.trim() !== "") {
    try {
      JSON.parse(body.jsonSchema);
    } catch {
      return fail("jsonSchema 必须是可解析的 JSON 字符串");
    }
    jsonSchema = body.jsonSchema;
  }

  return { data: { name, kind, description, jsonSchema } };
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
    if (!row) return jsonError(404, "对象类型不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
    if (!row) return jsonError(404, "对象类型不存在");
    if (row.builtin) return jsonError(403, "内置类型不可修改");
    const parsed = parseObjectTypePayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const updated = db
      .update(objectTypes)
      .set(parsed.data)
      .where(eq(objectTypes.id, id))
      .returning()
      .get();
    return NextResponse.json(updated);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
    if (!row) return jsonError(404, "对象类型不存在");
    if (row.builtin) return jsonError(403, "内置类型不可删除");

    const actionRefs = db
      .select({ name: actions.name })
      .from(actionPorts)
      .innerJoin(actions, eq(actionPorts.actionId, actions.id))
      .where(eq(actionPorts.objectTypeId, id))
      .all();
    const workflowRefs = db
      .select({ name: workflows.name })
      .from(workflowNodes)
      .innerJoin(workflows, eq(workflowNodes.workflowId, workflows.id))
      .where(eq(workflowNodes.objectTypeId, id))
      .all();
    const usedBy = [
      ...new Set([...actionRefs, ...workflowRefs].map((r) => r.name)),
    ];
    if (usedBy.length > 0)
      return jsonError(409, "该对象类型正被引用，无法删除", { usedBy });

    db.delete(objectTypes).where(eq(objectTypes.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
