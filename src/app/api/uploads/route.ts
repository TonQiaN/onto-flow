import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { jsonError } from "@/lib/http";
import type { PortValue } from "@/lib/values";

export const dynamic = "force-dynamic";

/** multipart 单文件上传 → data/uploads/<uuid>/<原名>，返回 PortValue(file) */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "缺少 file 字段");

  const id = crypto.randomUUID();
  const safeName = path.basename(file.name || "upload.txt");
  const dir = path.join(process.cwd(), "data", "uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(dir, safeName), buffer);

  const value: PortValue = {
    kind: "file",
    file: {
      path: path.join("uploads", id, safeName),
      name: safeName,
      mime: file.type || "text/plain",
    },
  };
  return NextResponse.json(value);
}
