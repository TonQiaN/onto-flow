import type { NextRequest } from "next/server";
import { publicJob } from "@/lib/api-types";
import { completeJob, hasActiveJobLease } from "@/lib/jobs";
import { json } from "@/lib/http";
import {
  persistScreenshot,
  removeScreenshot,
} from "@/lib/screenshots";
import { workerLeaseSchema } from "@/lib/validation";
import { isAuthorizedWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!isAuthorizedWorker(request)) {
    return json({ error: "Worker authentication failed." }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 9 * 1024 * 1024) {
    return json({ error: "Result payload is too large." }, { status: 413 });
  }

  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid multipart payload." }, { status: 400 });

  const identity = workerLeaseSchema.safeParse({
    workerId: form.get("workerId"),
    version: form.get("version") || undefined,
    leaseToken: form.get("leaseToken"),
  });
  const screenshot = form.get("screenshot");
  if (!identity.success || !(screenshot instanceof File)) {
    return json({ error: "Result payload is incomplete." }, { status: 400 });
  }

  if (
    !hasActiveJobLease(
      id,
      identity.data.workerId,
      identity.data.leaseToken,
      "sending",
    )
  ) {
    return json({ error: "Job is no longer active." }, { status: 409 });
  }

  let stored: Awaited<ReturnType<typeof persistScreenshot>>;
  try {
    stored = await persistScreenshot(
      id,
      Buffer.from(await screenshot.arrayBuffer()),
    );
  } catch {
    return json({ error: "Screenshot is invalid." }, { status: 400 });
  }

  const job = completeJob({
    jobId: id,
    workerId: identity.data.workerId,
    leaseToken: identity.data.leaseToken,
    filename: stored.filename,
    mime: stored.mime,
    digest: stored.digest,
    codexThreadId: String(form.get("codexThreadId") ?? "").slice(0, 200) || undefined,
    summary: String(form.get("summary") ?? "").slice(0, 2000) || undefined,
  });
  if (!job) {
    await removeScreenshot(stored.filename);
    return json({ error: "Job is no longer active." }, { status: 409 });
  }
  return json({ job: publicJob(job) });
}
