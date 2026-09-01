import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { readResumeMatchRun } from "@/server/resume-match";

export const dynamic = "force-dynamic";

/** GET /api/internal/resume-matches/[id] — 查询终态并在成功时返回严格 JSON 结果。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id } = await params;
    const result = readResumeMatchRun(id);
    if (!result.ok) {
      const issues = "issues" in result ? result.issues : undefined;
      return jsonError(result.status, result.error, issues ? { issues } : undefined);
    }
    return NextResponse.json(result.data);
  });
}
