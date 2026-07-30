import type { NextRequest } from "next/server";
import { publicJob } from "@/lib/api-types";
import { failJob } from "@/lib/jobs";
import { json } from "@/lib/http";
import { workerFailureSchema } from "@/lib/validation";
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
  const parsed = workerFailureSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return json({ error: "Invalid failure payload." }, { status: 400 });
  }
  const { id } = await context.params;
  const job = failJob({
    jobId: id,
    workerId: parsed.data.workerId,
    leaseToken: parsed.data.leaseToken,
    certainty: parsed.data.certainty,
    error: parsed.data.error,
    codexThreadId: parsed.data.codexThreadId,
  });
  if (!job) {
    return json({ error: "Job is no longer active." }, { status: 409 });
  }
  return json({ job: publicJob(job) });
}
