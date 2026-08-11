import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, objectTypes } from "@/db";
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

export async function GET() {
  return handle(() =>
    NextResponse.json(
      db.select().from(objectTypes).orderBy(asc(objectTypes.name)).all(),
    ),
  );
}

export async function POST(request: Request) {
  return handle(async () => {
    const parsed = parseObjectTypePayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const row = db.insert(objectTypes).values(parsed.data).returning().get();
    return NextResponse.json(row);
  });
}
