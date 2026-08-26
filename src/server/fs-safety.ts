/**
 * 服务端路径安全工具。运行输入里的 file PortValue 来自不可信的请求体
 * （/api/workflows/[id]/run 直接接收前端 JSON），必须约束在 data/ 目录内，
 * 防止 `../` 目录穿越读取任意文件或写入运行工作区之外的路径。
 */
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");

/** 把不可信的相对路径解析为 DATA_DIR 内的绝对路径；越界（含 `..`、绝对路径）则抛错 */
export function resolveWithinData(relPath: string): string {
  const abs = path.resolve(DATA_DIR, relPath);
  const rel = path.relative(DATA_DIR, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`非法文件路径（越界 data/ 目录）：${relPath}`);
  }
  return abs;
}

/** 判定不可信相对路径是否安全落在 DATA_DIR 内（校验期用，不抛错） */
export function isWithinData(relPath: string): boolean {
  try {
    resolveWithinData(relPath);
    return true;
  } catch {
    return false;
  }
}

/** 只取文件名的 basename，剥离任何目录成分与穿越段 */
export function safeBasename(name: string): string {
  const base = path.basename(name);
  if (!base || base === "." || base === "..") return "file";
  return base;
}
