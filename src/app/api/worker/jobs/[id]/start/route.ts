import type { NextRequest } from "next/server";
import { publicJob } from "@/lib/api-types";
import { json } from "@/lib/http";
import { startSending } from "@/lib/jobs";
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
  const parsed = workerLeaseSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return json({ error: "Invalid worker identity." }, { status: 400 });
  }
  const { id } = await context.params;
  const job = startSending(id, parsed.data.workerId, parsed.data.leaseToken);
  if (!job) {
    return json({ error: "Job is not claimable by this worker." }, { status: 409 });
  }
  return json({ job: publicJob(job) });
}
