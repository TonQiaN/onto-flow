import { getDb } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number };
  return json({
    ok: row.ok === 1,
    service: "codex-sdk-experiment",
    database: "ready",
  });
}
