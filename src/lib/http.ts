import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { getServerConfig, trustedOrigins } from "@/lib/env";

export function json(
  body: unknown,
  init: ResponseInit = {},
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function clientIp(request: NextRequest): string {
  if (!getServerConfig().TRUST_PROXY_HEADERS) {
    return "direct-client";
  }

  // The trusted reverse proxy must overwrite X-Real-IP. X-Forwarded-For is
  // deliberately ignored because its left-most value is controlled by clients.
  const realIp = request.headers.get("x-real-ip")?.trim() ?? "";
  return isIP(realIp) ? realIp : "unknown-proxy-client";
}

export function hasTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }

  try {
    return trustedOrigins().has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function rejectUntrustedOrigin(request: NextRequest): NextResponse | null {
  return hasTrustedOrigin(request)
    ? null
    : json({ error: "请求来源无效，请刷新页面后重试。" }, { status: 403 });
}
