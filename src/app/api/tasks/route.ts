import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth";
import { publicJob } from "@/lib/api-types";
import {
  ActiveJobExistsError,
  createJob,
  listJobs,
  WorkerUnavailableError,
  workerSummary,
} from "@/lib/jobs";
import { json, rejectUntrustedOrigin } from "@/lib/http";
import { createMessageSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAdminSession();
  if (!session) return json({ error: "未登录。" }, { status: 401 });

  return json({
    jobs: listJobs().map(publicJob),
    worker: workerSummary(),
  });
}

export async function POST(request: NextRequest) {
  const originError = rejectUntrustedOrigin(request);
  if (originError) return originError;

  const session = await getAdminSession();
  if (!session) return json({ error: "未登录。" }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4096) {
    return json({ error: "请求内容过大。" }, { status: 413 });
  }

  const parsed = createMessageSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return json(
      { error: "请选择发送对象，并填写不超过 2000 字的消息。" },
      { status: 400 },
    );
  }

  try {
    const job = createJob({
      ...parsed.data,
      userId: session.userId,
    });
    return json({ job: publicJob(job) }, { status: 201 });
  } catch (error) {
    if (error instanceof ActiveJobExistsError) {
      return json(
        { error: "当前已有发送任务在执行，请等待它完成。" },
        { status: 409 },
      );
    }
    if (error instanceof WorkerUnavailableError) {
      return json(
        { error: "本机执行器当前离线或心跳已过期，请先启动执行器。" },
        { status: 503 },
      );
    }
    throw error;
  }
}
