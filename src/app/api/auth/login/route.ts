import type { NextRequest } from "next/server";
import { authenticateAdmin, createAdminSession } from "@/lib/auth";
import { clientIp, json, rejectUntrustedOrigin } from "@/lib/http";
import { loginSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const originError = rejectUntrustedOrigin(request);
  if (originError) return originError;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 4096) {
    return json({ error: "请求内容过大。" }, { status: 413 });
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "请输入管理员账号和密码。" }, { status: 400 });
  }

  const result = await authenticateAdmin(
    parsed.data.username,
    parsed.data.password,
    clientIp(request),
  );
  if (!result.ok) {
    if (result.blockedUntil && result.blockedUntil > Date.now()) {
      return json(
        {
          error: "登录尝试过多，请稍后再试。",
          retryAt: result.blockedUntil,
        },
        { status: 429 },
      );
    }
    return json({ error: "账号或密码不正确。" }, { status: 401 });
  }

  await createAdminSession(result.user);
  return json({ ok: true });
}
