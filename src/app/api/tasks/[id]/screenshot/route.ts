import { readFile } from "node:fs/promises";
import { getAdminSession } from "@/lib/auth";
import { getJob } from "@/lib/jobs";
import { resolveScreenshot } from "@/lib/screenshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getAdminSession();
  if (!session) return new Response(null, { status: 401 });

  const { id } = await context.params;
  const job = getJob(id);
  if (!job?.screenshotFilename || !job.screenshotMime) {
    return new Response(null, { status: 404 });
  }

  try {
    const body = await readFile(resolveScreenshot(job.screenshotFilename));
    return new Response(body, {
      headers: {
        "Content-Type": job.screenshotMime,
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${job.id}.png"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
