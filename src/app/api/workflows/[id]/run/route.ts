import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { startRun } from "@/server/engine/runner";

export const dynamic = "force-dynamic";

/** POST /api/workflows/[id]/run — body { inputs: { [inputNodeId]: PortValue } } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id } = await params;
    const body = (await request.json()) as { inputs?: unknown };
    const inputs = body?.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      return jsonError(400, "缺少 inputs（{ [输入节点id]: PortValue }）");
    }
    const result = await startRun(id, inputs as Record<string, unknown>);
    if (!result.ok) {
      if (result.status === 422) {
        return NextResponse.json(
          { error: result.error, issues: result.issues },
          { status: 422 },
        );
      }
      return jsonError(result.status, result.error);
    }
    return NextResponse.json({ runId: result.runId });
  });
}
