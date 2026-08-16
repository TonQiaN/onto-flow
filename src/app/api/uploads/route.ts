import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { handle, jsonError } from "@/lib/http";
import type { PortValue } from "@/lib/values";
import { DATA_DIR, safeBasename } from "@/server/fs-safety";

export const dynamic = "force-dynamic";

/** multipart 单文件上传 → data/uploads/<uuid>/<原名>，返回 PortValue(file) */
export async function POST(request: Request) {
  // 落盘会因文件系统错误（EISDIR/ENOSPC/EACCES 等）抛异常，包 handle() 统一转成
  // { error } 的 4xx/5xx，不再把未捕获异常直接抛给 Next
  return handle(async () => {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return jsonError(400, "缺少 file 字段");

    const id = crypto.randomUUID();
    // 文件名来自不可信的 multipart 头：统一走 fs-safety 的 safeBasename，
    // 它会把 "." / ".." 归一为 "file"（path.basename 对这两个名字原样返回，
    // 写文件时会抛 EISDIR/ENOTDIR）。写入根目录同样用 fs-safety 的 DATA_DIR，
    // 不再在路由里各拼一份 process.cwd()，保证与其他落盘路径同一事实源。
    const safeName = safeBasename(file.name || "upload.txt");
    const dir = path.join(DATA_DIR, "uploads", id);
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
  });
}
