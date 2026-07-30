import type { NextRequest } from "next/server";
import { safeEqualHex, sha256 } from "@/lib/crypto";
import { getServerConfig } from "@/lib/env";

export function isAuthorizedWorker(request: NextRequest): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token || token.length > 512) return false;
  return safeEqualHex(sha256(token), getServerConfig().WORKER_TOKEN_SHA256);
}
