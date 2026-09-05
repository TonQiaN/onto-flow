import { handle } from "@/lib/http";
import { validateJsonArtifact } from "@/server/harness/artifact-schema";
import { parseObjectTypePayload } from "@/server/writers/object-type";

export const dynamic = "force-dynamic";

/** 只校验表单中的样例，不保存实体、不启动模型。 */
export async function POST(request: Request) {
  return handle(async () => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
    const input = body as Record<string, unknown>;
    if (typeof input.content !== "string")
      return Response.json({ error: "content 必须是 JSON 样例文本" }, { status: 400 });
    const parsed = parseObjectTypePayload({
      name: "校验样例",
      kind: "json",
      jsonSchema: input.jsonSchema,
    });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const issues = validateJsonArtifact(input.content, parsed.data.jsonSchema);
    return Response.json({ valid: issues.length === 0, issues });
  });
}
