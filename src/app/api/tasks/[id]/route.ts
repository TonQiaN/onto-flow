import { getAdminSession } from "@/lib/auth";
import { publicJob } from "@/lib/api-types";
import { getJob } from "@/lib/jobs";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) return json({ error: "未登录。" }, { status: 401 });

  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return json({ error: "任务不存在。" }, { status: 404 });
  return json({ job: publicJob(job) });
}
