import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { isRunExecutionActive } from "@/server/engine/runner";
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
    // Action 执行时可以改名并替换工作区里的任一祖先目录；Node 没有 openat 这类
    // 能把整条路径锁定到已验证目录描述符的接口，因此活动运行必须停止预览。
    // activeRuns 覆盖 subprocess 完整生命周期，终态写入前工作区已不再被模型修改。
    if (isRunExecutionActive(id)) {
      return jsonError(409, "运行执行期间暂不支持文件预览，请等待运行结束");
    }

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

    let expected: fs.Stats;
    try {
      expected = fs.lstatSync(real);
    } catch {
      return jsonError(404, "文件不存在（工作区可能已被清理）");
    }
    if (!expected.isFile()) return jsonError(400, "路径不是文件");

    let size: number;
    let content: Buffer;
    let inspected: Buffer;
    try {
      // O_NOFOLLOW 拒绝最终分量在校验后被换成软链；O_NONBLOCK 保证被换成
      // FIFO 时不会把同步 Next 进程挂死。真正决定可读性的必须是已打开的 fd，
      // 不能继续相信 open 前的 pathname 检查结果。
      const fd = fs.openSync(
        real,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) return jsonError(400, "路径不是文件");
        // realpath/lstat 与 open 之间若发生替换，fd 的设备号或 inode 会变化；
        // 拒绝这次读取，而不是把新目标当成刚才验证过的文件。
        if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
          return jsonError(404, "文件在读取前发生变化，请重试");
        }
        size = opened.size;
        // UTF-8 最长四字节。多读三字节才能判定恰好从预览边界前开始的序列
        // 是合法跨界字符，还是在边界后的第一个字节就出现非法 continuation。
        const length = Math.min(size, PREVIEW_MAX_BYTES + 3);
        const buffer = Buffer.alloc(length);
        // 常规文件也允许短读；循环填满所需前缀，尾部未写区域不参与二进制判断。
        let bytesRead = 0;
        while (bytesRead < length) {
          const count = fs.readSync(
            fd,
            buffer,
            bytesRead,
            length - bytesRead,
            bytesRead,
          );
          if (count === 0) break;
          bytesRead += count;
        }
        inspected = buffer.subarray(0, bytesRead);
        content = inspected.subarray(0, Math.min(bytesRead, PREVIEW_MAX_BYTES));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 校验与 openSync 之间文件被清理/替换：语义上是 404，且不让底层 fs
      // 错误经 handle() 以 500 把服务器绝对路径泄漏给调用方。
      return jsonError(404, "文件不存在（工作区可能已被清理）");
    }
    if (inspected.includes(0)) return jsonError(415, "二进制文件不支持预览");
    // 先用最多三字节 lookahead 验证跨预览边界的序列；文件在 lookahead 后仍有
    // 内容时允许最后一个不相关序列暂存。再单独解码固定上限内的完整字符前缀，
    // 被合法多字节字符切断时不产生 U+FFFD。
    let preview: string;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(inspected, {
        stream: size > inspected.byteLength,
      });
      preview = new TextDecoder("utf-8", { fatal: true }).decode(content, {
        stream: size > content.byteLength,
      });
    } catch {
      return jsonError(415, "二进制文件不支持预览");
    }

    return NextResponse.json({
      name: path.basename(real),
      size,
      truncated: size > PREVIEW_MAX_BYTES,
      content: preview,
    });
  });
}
