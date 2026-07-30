import { redirect } from "next/navigation";
import { Dashboard } from "@/app/console/dashboard";
import { getAdminSession } from "@/lib/auth";
import { publicJob } from "@/lib/api-types";
import { normalizedBasePath } from "@/lib/env";
import { listJobs, workerSummary } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export default async function ConsolePage() {
  const session = await getAdminSession();
  const basePath = normalizedBasePath();
  if (!session) redirect(`${basePath}/login`);

  return (
    <Dashboard
      basePath={basePath}
      username={session.username}
      initialJobs={listJobs().map(publicJob)}
      initialWorker={workerSummary()}
    />
  );
}
