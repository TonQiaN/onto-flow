import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { parseResumeMatchInvocation, startResumeMatch } from "@/server/resume-match";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

/** POST /api/internal/resume-matches — 用稳定的岗位/简历契约发起评分运行。 */
export async function POST(request: Request) {
  return handle(async () => {
    const parsed = parseResumeMatchInvocation(await request.json());
    if (!parsed.ok) return respond(parsed);
    const started = await startResumeMatch(parsed.data);
    if (!started.ok) return respond(started);
    return NextResponse.json(
      {
        runId: started.data.runId,
        status: "running",
        statusUrl: `/api/internal/resume-matches/${started.data.runId}`,
        historyUrl: `/runs/${started.data.runId}`,
      },
      { status: 202 },
    );
  });
}
