import type { NextRequest } from "next/server";
import { publicJob } from "@/lib/api-types";
import { claimNextJob } from "@/lib/jobs";
import { json } from "@/lib/http";
import { workerIdentitySchema } from "@/lib/validation";
import { isAuthorizedWorker } from "@/lib/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isAuthorizedWorker(request)) {
    return json({ error: "Worker authentication failed." }, { status: 401 });
  }

  const parsed = workerIdentitySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return json({ error: "Invalid worker identity." }, { status: 400 });
  }

  const claim = claimNextJob(parsed.data.workerId, parsed.data.version);
  return json(
    claim
      ? { job: publicJob(claim.job), leaseToken: claim.leaseToken }
      : { job: null, leaseToken: null },
  );
}
