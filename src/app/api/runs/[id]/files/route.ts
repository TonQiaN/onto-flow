import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { resolveWithinData } from "@/server/fs-safety";

export const dynamic = "force-dynamic";

/** 预览返回的内容上限；超出的截断并标记 truncated，全文去磁盘看。 */
const PREVIEW_MAX_BYTES = 262_144;

/**
 * GET /api/runs/[id]/files?path=<data/ 相对路径> — 只读预览该运行目录内的文本文件。
 *
 * ADR-0012 之后运行输入与产物一律是文件，运行详情要能点开看内容才不算可见性
 * 回退；这条路由就是那个唯一的读取通道。路径先经 resolveWithinData 收敛在
 * data/ 内，再要求落在该运行自己的 run_dir 之下——不能拿 A 运行的 id 读 B 的文件。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const { id } = await params;
    const run = db
      .select({ runDir: runs.runDir })
      .from(runs)
      .where(eq(runs.id, id))
      .get();
    if (!run) return jsonError(404, "运行不存在");
    if (!run.runDir) return jsonError(404, "该运行没有工作区目录");

    const rel = new URL(request.url).searchParams.get("path") ?? "";
    if (!rel) return jsonError(400, "缺少 path（data/ 相对路径）");
    let abs: string;
    try {
      abs = resolveWithinData(rel);
    } catch {
      return jsonError(400, "路径越界 data/ 目录");
    }
    // runDir 是运行时数据库事实，不是构建输入；禁止 Turbopack 因这个动态值
    // 把整个仓库误追踪进服务端产物（与 monitor/cleanup.ts 同一处理）。
    const runRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), run.runDir);

    // 词法收敛只挡 ../，挡不住软链：工作区里有指向全局技能库的 by-design 软链，
    // 被注入的模型还能在工作区植入指向 data/ 外（.env.local、私钥）的软链。必须
    // 解析真实路径后再判收敛，否则这个无鉴权端点就是任意文件读（对齐 trajectory.ts）。
    let real: string;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(runRoot);
      real = fs.realpathSync.native(abs);
    } catch {
      return jsonError(404, "文件不存在（工作区可能已被清理）");
    }
    const within = path.relative(realRoot, real);
    if (
      within === "" ||
      within === ".." ||
      within.startsWith(`..${path.sep}`) ||
      path.isAbsolute(within)
    ) {
      return jsonError(400, "路径不在该运行的目录内");
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return jsonError(404, "文件不存在（工作区可能已被清理）");
    }
    if (!stat.isFile()) return jsonError(400, "路径不是文件");

    const length = Math.min(stat.size, PREVIEW_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    let bytesRead: number;
    try {
      const fd = fs.openSync(real, "r");
      try {
        // readSync 返回实读字节；短读时只取有效前缀，尾部零字节不当二进制误判。
        bytesRead = fs.readSync(fd, buffer, 0, length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // statSync 与 openSync 之间文件被清理/删除：语义上是 404，且不让底层 fs
      // 错误经 handle() 以 500 把服务器绝对路径泄漏给调用方。
      return jsonError(404, "文件不存在（工作区可能已被清理）");
    }
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return jsonError(415, "二进制文件不支持预览");

    return NextResponse.json({
      name: path.basename(real),
      size: stat.size,
      truncated: stat.size > PREVIEW_MAX_BYTES,
      content: content.toString("utf8"),
    });
  });
}
