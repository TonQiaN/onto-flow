import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, skills } from "@/db";
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

export async function GET() {
  return handle(() =>
    NextResponse.json(db.select().from(skills).orderBy(asc(skills.name)).all()),
  );
}

export async function POST(request: Request) {
  return handle(async () => {
    const parsed = parseSkillPayload(await request.json());
    if ("error" in parsed) return parsed.error;
    const row = db.insert(skills).values(parsed.data).returning().get();
    return NextResponse.json(row);
  });
}
