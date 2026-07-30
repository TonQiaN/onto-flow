import type { NextRequest } from "next/server";
import { destroyAdminSession } from "@/lib/auth";
import { json, rejectUntrustedOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const originError = rejectUntrustedOrigin(request);
  if (originError) return originError;
  await destroyAdminSession();
  return json({ ok: true });
}
