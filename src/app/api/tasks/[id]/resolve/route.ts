import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { publicJob } from "@/lib/api-types";
import { getJob, resolveManualReview } from "@/lib/jobs";
import { json, rejectUntrustedOrigin } from "@/lib/http";
import { manualReviewResolutionSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const originError = rejectUntrustedOrigin(request);
  if (originError) return originError;

  const session = await getAdminSession();
  if (!session) return json({ error: "未登录。" }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1024) {
    return json({ error: "请求内容过大。" }, { status: 413 });
  }

  const parsed = manualReviewResolutionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return json({ error: "人工核对结论无效。" }, { status: 400 });
  }

  const { id } = await context.params;
  const existing = getJob(id);
  if (!existing) return json({ error: "任务不存在。" }, { status: 404 });
  if (existing.status !== "manual_review") {
    return json({ error: "该任务已终结或无需人工核对。" }, { status: 409 });
  }

  const job = resolveManualReview({
    jobId: id,
    userId: session.userId,
    resolution: parsed.data.resolution,
  });
  if (!job) {
    return json({ error: "该任务已由其他操作终结。" }, { status: 409 });
  }

  return json({ job: publicJob(job) });
}
