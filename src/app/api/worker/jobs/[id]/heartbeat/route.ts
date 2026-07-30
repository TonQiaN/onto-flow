import type { NextRequest } from "next/server";
import { heartbeatJob } from "@/lib/jobs";
import { json } from "@/lib/http";
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
  if (!heartbeatJob(id, parsed.data.workerId, parsed.data.leaseToken)) {
    return json({ error: "Job lease is no longer active." }, { status: 409 });
  }
  return json({ ok: true });
}
