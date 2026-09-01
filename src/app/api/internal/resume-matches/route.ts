import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import {
  parseResumeMatchInvocation,
  startResumeMatch,
} from "@/server/resume-match";

export const dynamic = "force-dynamic";

/** POST /api/internal/resume-matches — 用稳定的岗位/简历契约发起评分运行。 */
export async function POST(request: Request) {
  return handle(async () => {
    const parsed = parseResumeMatchInvocation(await request.json());
    if (!parsed.ok) return jsonError(400, parsed.error);
    const started = await startResumeMatch(parsed.data);
    if (!started.ok) {
      if (started.status === 422) {
        return NextResponse.json(
          { error: started.error, issues: started.issues },
          { status: 422 },
        );
      }
      return jsonError(started.status, started.error);
    }
    return NextResponse.json(
      {
        runId: started.runId,
        status: "running",
        statusUrl: `/api/internal/resume-matches/${started.runId}`,
        historyUrl: `/runs/${started.runId}`,
      },
      { status: 202 },
    );
  });
}
