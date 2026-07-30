import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { publicJob } from "@/lib/api-types";
import { getServerConfig } from "@/lib/env";
import { getJob, resolveManualReview } from "@/lib/jobs";
import { json, rejectUntrustedOrigin } from "@/lib/http";
import {
  decodeScreenshotDataUrl,
  persistScreenshot,
  removeScreenshot,
} from "@/lib/screenshots";
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

  const maximumRequestBytes =
    Math.ceil((getServerConfig().SCREENSHOT_MAX_BYTES * 4) / 3) + 2048;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maximumRequestBytes) {
    return json({ error: "请求内容过大。" }, { status: 413 });
  }

  const body = await request.text().catch(() => "");
  if (Buffer.byteLength(body, "utf8") > maximumRequestBytes) {
    return json({ error: "请求内容过大。" }, { status: 413 });
  }
  let requestBody: unknown = null;
  try {
    requestBody = JSON.parse(body);
  } catch {
    // The schema below returns the same bounded validation error.
  }
  const parsed = manualReviewResolutionSchema.safeParse(
    requestBody,
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

  let screenshot:
    | {
        filename: string;
        mime: "image/png" | "image/jpeg";
        digest: string;
      }
    | undefined;
  try {
    if (
      parsed.data.resolution === "sent" &&
      parsed.data.screenshotDataUrl
    ) {
      screenshot = await persistScreenshot(
        id,
        decodeScreenshotDataUrl(parsed.data.screenshotDataUrl),
      );
    }
  } catch {
    return json({ error: "人工截图证据无效。" }, { status: 400 });
  }
  if (parsed.data.resolution === "sent" && !screenshot) {
    return json({ error: "核对为已发送时必须提供截图证据。" }, { status: 400 });
  }

  let job: ReturnType<typeof resolveManualReview>;
  try {
    if (parsed.data.resolution === "sent") {
      if (!screenshot) {
        return json(
          { error: "核对为已发送时必须提供截图证据。" },
          { status: 400 },
        );
      }
      job = resolveManualReview({
        jobId: id,
        userId: session.userId,
        resolution: "sent",
        screenshot,
      });
    } else {
      job = resolveManualReview({
        jobId: id,
        userId: session.userId,
        resolution: "not_sent",
      });
    }
  } catch {
    if (screenshot) await removeScreenshot(screenshot.filename);
    return json({ error: "人工核对结论保存失败。" }, { status: 500 });
  }
  if (!job) {
    if (screenshot) await removeScreenshot(screenshot.filename);
    return json({ error: "该任务已由其他操作终结。" }, { status: 409 });
  }

  return json({ job: publicJob(job) });
}
